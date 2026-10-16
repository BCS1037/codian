import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { type PiRpcRecord, PiRpcResponseError, type PiRpcTransport } from './PiRpcTransport';

export const PI_TREE_COMMAND = 'codian-tree';
const STATUS_PREFIX = 'codian-tree:';

/** Embedded extension that routes branch control through Pi's native session tree. */
export const PI_TREE_EXTENSION_SOURCE = String.raw`
export default function (pi) {
  let busy = false;
  pi.registerCommand('codian-tree', {
    description: 'Internal Codian conversation navigation',
    handler: async (args, ctx) => {
      let request;
      let responseContext = ctx;
      let reloadRequired = false;
      let acquired = false;
      try {
        request = JSON.parse(args);
        if (typeof request.id !== 'string') return;
        if (busy || (request.operation !== 'inspect' && !ctx.isIdle())) throw new Error('Pi is busy');
        busy = acquired = true;
        const manager = ctx.sessionManager;
        if (manager.getSessionId() !== request.sessionId || manager.getSessionFile() !== request.sessionFile) {
          throw new Error('Pi session changed before tree navigation');
        }
        if (request.operation !== 'inspect') {
          const entry = manager.getEntry(request.targetId);
          if (!entry) throw new Error('Pi branch entry is missing');
          const before = entry.type === 'custom_message' || (entry.type === 'message' && entry.message.role === 'user');
          const expected = before ? entry.parentId : entry.id;
          if (request.operation === 'restore' && manager.getLeafId() === request.leafId) {
            // Keep an incomplete turn selectable without adding model context.
            if (before && entry.id === request.leafId) pi.appendEntry('codian-tree-anchor');
          } else {
            if (request.operation === 'restore' && expected !== request.leafId) {
              if (!before || request.leafId !== entry.id) throw new Error('Invalid Pi branch position');
              const { SessionManager } = await import('@mariozechner/pi-coding-agent');
              const disk = SessionManager.open(request.sessionFile);
              if (disk.getSessionId() !== request.sessionId || !disk.getEntry(entry.id)) {
                throw new Error('Pi session changed before branch restoration');
              }
              disk.branch(entry.id);
              const anchorId = disk.appendCustomEntry('codian-tree-anchor');
              reloadRequired = true;
              const result = await ctx.switchSession(request.sessionFile, {
                withSession: async fresh => {
                  responseContext = fresh;
                  if (fresh.sessionManager.getLeafId() !== anchorId) {
                    const navigation = await fresh.navigateTree(anchorId, { summarize: false });
                    if (navigation.cancelled || fresh.sessionManager.getLeafId() !== anchorId) {
                      throw new Error('Pi branch restoration was interrupted');
                    }
                  }
                  fresh.ui.setStatus('codian-tree:' + request.id, JSON.stringify({
                    cancelled: false, leafId: anchorId,
                    sessionId: fresh.sessionManager.getSessionId(), sessionFile: fresh.sessionManager.getSessionFile()
                  }));
                }
              });
              if (result.cancelled) ctx.ui.setStatus('codian-tree:' + request.id, JSON.stringify({ cancelled: true, reloadRequired: true }));
              return;
            }
            // Pi treats navigating to its current leaf as a no-op.
            if (before && manager.getLeafId() === entry.id) pi.appendEntry('codian-tree-anchor');
            const result = await ctx.navigateTree(request.targetId, { summarize: false });
            if (result.cancelled) {
              ctx.ui.setStatus('codian-tree:' + request.id, JSON.stringify({ cancelled: true }));
              return;
            }
            if (manager.getLeafId() !== expected) throw new Error('Pi branch position changed during navigation');
          }
        }
        ctx.ui.setStatus('codian-tree:' + request.id, JSON.stringify({
          cancelled: false, leafId: manager.getLeafId(),
          sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()
        }));
      } catch (error) {
        if (request && typeof request.id === 'string') {
          responseContext.ui.setStatus('codian-tree:' + request.id, JSON.stringify({ error: String(error.message || error), uncertain: reloadRequired }));
        }
      } finally {
        if (acquired) busy = false;
      }
    }
  });
}
`;

export interface PiTreeExtensionHandle {
  directory: string;
  path: string;
}

export async function createPiTreeExtension(): Promise<PiTreeExtensionHandle> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-pi-tree-'));
  const extensionPath = path.join(directory, 'extension.ts');
  try {
    await fs.writeFile(extensionPath, PI_TREE_EXTENSION_SOURCE, 'utf8');
    return { directory, path: extensionPath };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removePiTreeExtension(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

export function isPiTreeResponse(event: PiRpcRecord): boolean {
  return event.type === 'extension_ui_request'
    && event.method === 'setStatus'
    && typeof event.statusKey === 'string'
    && event.statusKey.startsWith(STATUS_PREFIX);
}

/** Wait for native tree confirmation; prompt acceptance alone is not completion. */
export async function requestPiTree(
  transport: PiRpcTransport,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const catalog = await transport.request<{ commands?: Array<{ name: string }> }>(
    'get_commands', {}, 10_000, signal,
  );
  if (!catalog.commands?.some(command => command.name === PI_TREE_COMMAND)) {
    throw new PiRpcResponseError('codian_tree', 'Pi conversation branching extension is unavailable.');
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    let removeEvent = () => {};
    let removeClose = () => {};
    const cleanup = () => {
      window.clearTimeout(timer);
      removeEvent();
      removeClose();
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const abort = () => fail(new Error('Pi tree navigation cancelled'));
    const timer = window.setTimeout(() => fail(new Error('Pi tree navigation timed out')), 10_000);
    removeClose = transport.onClose(error => fail(error ?? new Error('Pi process closed')));
    removeEvent = transport.onEvent(event => {
      if (!isPiTreeResponse(event) || event.statusKey !== STATUS_PREFIX + id) return;
      try {
        const result: unknown = JSON.parse(String(event.statusText));
        if (!result || typeof result !== 'object') throw new Error('Invalid Pi tree response');
        if ('error' in result && result.error) {
          if ('uncertain' in result && result.uncertain) throw new Error(String(result.error));
          throw new PiRpcResponseError('codian_tree', String(result.error));
        }
        cleanup();
        resolve(result);
      } catch (error) {
        fail(error);
      }
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    void transport.request('prompt', {
      message: '/' + PI_TREE_COMMAND + ' ' + JSON.stringify({ ...payload, id }),
    }, 10_000, signal).catch(fail);
  });
}
