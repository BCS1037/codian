import * as fs from 'node:fs/promises';

import { requestPiTree } from '@/providers/pi/runtime/PiTreeBridge';
import { createPiTreeExtension, removePiTreeExtension } from '@/providers/pi/runtime/PiTreeBridge';

type EventHandler = (event: Record<string, unknown>) => void;

class FakePiTransport {
  readonly handlers = new Set<EventHandler>();
  readonly closeHandlers = new Set<(error?: Error) => void>();
  readonly request = jest.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type === 'get_commands') return { commands: [{ name: 'codian-tree' }] };
    if (type === 'prompt') {
      const message = String(payload.message ?? '');
      const request = JSON.parse(message.slice('/codian-tree '.length)) as { id: string };
      queueMicrotask(() => {
        for (const handler of this.handlers) {
          handler({
            method: 'setStatus',
            statusKey: `codian-tree:${request.id}`,
            statusText: JSON.stringify({
              cancelled: false,
              leafId: 'branch-leaf',
              sessionFile: '/tmp/pi-session.jsonl',
              sessionId: 'pi-session',
            }),
            type: 'extension_ui_request',
          });
        }
      });
      return { accepted: true };
    }
    return {};
  });

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
}

describe('requestPiTree', () => {
  it('waits for native tree confirmation after Pi accepts the control prompt', async () => {
    const transport = new FakePiTransport();

    await expect(requestPiTree(transport as any, {
      operation: 'restore',
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session',
      targetId: 'branch-leaf',
      leafId: 'branch-leaf',
    })).resolves.toEqual({
      cancelled: false,
      leafId: 'branch-leaf',
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session',
    });

    expect(transport.request).toHaveBeenCalledWith('prompt', {
      message: expect.stringMatching(/^\/codian-tree \{"operation":"restore"/),
    }, 10_000, undefined);
  });

  it('fails closed when the Pi extension command is unavailable', async () => {
    const transport = new FakePiTransport();
    transport.request.mockResolvedValueOnce({ commands: [] });

    await expect(requestPiTree(transport as any, { operation: 'inspect' }))
      .rejects.toThrow('Pi conversation branching extension is unavailable.');
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
});

describe('Pi tree extension lifecycle', () => {
  it('writes isolated extension source and removes only its owned temp directory', async () => {
    const extension = await createPiTreeExtension();
    try {
      await expect(fs.readFile(extension.path, 'utf8')).resolves.toContain("pi.registerCommand('codian-tree'");
      await expect(fs.stat(extension.directory)).resolves.toBeDefined();
    } finally {
      await removePiTreeExtension(extension.directory);
    }

    await expect(fs.stat(extension.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
