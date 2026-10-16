import { spawn as defaultSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { findNodeExecutable } from '../../../utils/env';

export type StoredRow = Record<string, unknown>;

export interface StoredSessionRows {
  messageRows: StoredRow[];
  partRows: StoredRow[];
}

interface SqliteModule {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => {
    close(): void;
    prepare(sql: string): {
      all(...params: unknown[]): StoredRow[];
    };
  };
}

export interface OpencodeSqliteReaderDependencies {
  environment?: NodeJS.ProcessEnv;
  findNodeExecutables?: () => string[];
  findNodeExecutable?: () => string | null;
  requireSqliteModule?: () => SqliteModule | null;
  spawn?: typeof defaultSpawn;
}

export const OPENCODE_SQLITE_QUERY_MAX_BUFFER = 100 * 1024 * 1024;
export const OPENCODE_MESSAGE_ROW_SQL = buildOpencodeMessageRowsSql('?');

const OPENCODE_PART_ROW_SQL = buildOpencodePartRowsSql('?');
const OPENCODE_SQLITE_CHILD_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const [databasePath, sessionId, messageSql, partSql] = process.argv.slice(1);
let db;
try {
  db = new DatabaseSync(databasePath, { readOnly: true });
  const messageRows = db.prepare(messageSql).all(sessionId);
  const partRows = db.prepare(partSql).all(sessionId);
  process.stdout.write(JSON.stringify({ messageRows, partRows }));
} finally {
  if (db) db.close();
}
`.trim();

interface ResolvedDependencies {
  environment: NodeJS.ProcessEnv;
  findNodeExecutables: () => string[];
  requireSqliteModule: () => SqliteModule | null;
  spawn: typeof defaultSpawn;
}

export async function loadOpencodeSessionRows(
  databasePath: string,
  sessionId: string,
  dependencies: OpencodeSqliteReaderDependencies = {},
): Promise<StoredSessionRows> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const errors: string[] = [];

  try {
    return loadSessionRowsWithCurrentProcessSqlite(
      databasePath,
      sessionId,
      resolvedDependencies.requireSqliteModule,
    );
  } catch (error) {
    errors.push(`Obsidian SQLite: ${formatError(error)}`);
  }

  const nodeExecutables = resolvedDependencies.findNodeExecutables();
  if (nodeExecutables.length === 0) {
    errors.push('Node.js: no executable found.');
  }
  for (const nodePath of nodeExecutables) {
    try {
      return await loadSessionRowsWithNodeProcess(
        databasePath,
        sessionId,
        nodePath,
        resolvedDependencies.spawn,
        resolvedDependencies.environment,
      );
    } catch (error) {
      errors.push(`Node.js (${nodePath}): ${formatError(error)}`);
    }
  }

  try {
    return await loadSessionRowsWithSqliteCli(
      databasePath,
      sessionId,
      resolvedDependencies.spawn,
      resolvedDependencies.environment,
    );
  } catch (error) {
    errors.push(`sqlite3: ${formatError(error)}`);
  }

  throw new Error([
    'Could not read OpenCode session rows from SQLite.',
    ...errors,
    'History requires working SQLite support in Obsidian, Node.js 22.13+ (or a newer supported release), or sqlite3.',
  ].join('\n'));
}

function resolveDependencies(
  dependencies: OpencodeSqliteReaderDependencies,
): ResolvedDependencies {
  const environment = dependencies.environment ?? process.env;
  return {
    environment,
    findNodeExecutables: dependencies.findNodeExecutables
      ?? (dependencies.findNodeExecutable
        ? () => {
            const executable = dependencies.findNodeExecutable?.();
            return executable ? [executable] : [];
          }
        : () => findNodeExecutables(environment)),
    requireSqliteModule: dependencies.requireSqliteModule ?? requireSqliteModule,
    spawn: dependencies.spawn ?? defaultSpawn,
  };
}

function findNodeExecutables(environment: NodeJS.ProcessEnv): string[] {
  const candidates = new Set<string>();
  const firstAvailable = findNodeExecutable(environment.PATH);
  if (firstAvailable) candidates.add(firstAvailable);

  const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
  const searchPath = environment.PATH ?? environment.Path ?? '';
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executableName);
    try {
      if (fs.statSync(candidate).isFile()) {
        candidates.add(candidate);
      }
    } catch {
      // Missing or inaccessible PATH entries are not executable candidates.
    }
  }

  return [...candidates];
}

function requireSqliteModule(): SqliteModule | null {
  try {
    if (typeof require !== 'function') {
      return null;
    }

    // Obsidian injects require on plugin modules; module.require is not reliably present.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional SQLite lazily through Obsidian's injected require.
    const sqlite = require('node:sqlite') as unknown;
    return isSqliteModule(sqlite) ? sqlite : null;
  } catch {
    return null;
  }
}

function isSqliteModule(value: unknown): value is SqliteModule {
  return (
    isPlainObject(value)
    && typeof value.DatabaseSync === 'function'
  );
}

function loadSessionRowsWithCurrentProcessSqlite(
  databasePath: string,
  sessionId: string,
  requireSqlite: () => SqliteModule | null,
): StoredSessionRows {
  const sqlite = requireSqlite();
  if (!sqlite) throw new Error('node:sqlite is unavailable.');

  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null;
  try {
    db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    const messageRows = db.prepare(OPENCODE_MESSAGE_ROW_SQL).all(sessionId);
    const partRows = db.prepare(OPENCODE_PART_ROW_SQL).all(sessionId);
    return { messageRows, partRows };
  } finally {
    db?.close();
  }
}

async function loadSessionRowsWithNodeProcess(
  databasePath: string,
  sessionId: string,
  nodePath: string,
  spawn: typeof defaultSpawn,
  environment: NodeJS.ProcessEnv,
): Promise<StoredSessionRows> {
  const stdout = await runBufferedChild(
    nodePath,
    [
      '-e',
      OPENCODE_SQLITE_CHILD_SCRIPT,
      databasePath,
      sessionId,
      OPENCODE_MESSAGE_ROW_SQL,
      OPENCODE_PART_ROW_SQL,
    ],
    spawn,
    environment,
  );
  const rows = parseStoredSessionRows(stdout);
  if (!rows) throw new Error('Invalid SQLite query output.');
  return rows;
}

async function loadSessionRowsWithSqliteCli(
  databasePath: string,
  sessionId: string,
  spawn: typeof defaultSpawn,
  environment: NodeJS.ProcessEnv,
): Promise<StoredSessionRows> {
  const escapedSessionId = escapeSqlLiteral(sessionId);
  const messageRows = await runSqlite3JsonQuery(
    databasePath,
    buildOpencodeMessageRowsSql(`'${escapedSessionId}'`),
    spawn,
    environment,
  );
  const partRows = await runSqlite3JsonQuery(
    databasePath,
    buildOpencodePartRowsSql(`'${escapedSessionId}'`),
    spawn,
    environment,
  );
  return { messageRows, partRows };
}

async function runSqlite3JsonQuery(
  databasePath: string,
  sql: string,
  spawn: typeof defaultSpawn,
  environment: NodeJS.ProcessEnv,
): Promise<StoredRow[]> {
  const stdout = await runBufferedChild(
    'sqlite3',
    ['-readonly', '-json', databasePath, sql],
    spawn,
    environment,
  );
  const rows = parseStoredRows(stdout);
  if (!rows) throw new Error('Invalid SQLite query output.');
  return rows;
}

function runBufferedChild(
  command: string,
  args: string[],
  spawn: typeof defaultSpawn,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    let timer: number | null = null;
    const chunks: Buffer[] = [];
    let stderr = '';
    let child: ReturnType<typeof defaultSpawn>;
    try {
      child = spawn(command, args, {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > OPENCODE_SQLITE_QUERY_MAX_BUFFER) {
        child.kill('SIGKILL');
        finish(new Error('SQLite query output exceeded the size limit.'));
        return;
      }
      chunks.push(buffer);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(0, 2_000);
    });
    child.once('error', finish);
    child.once('close', (code) => {
      finish(code === 0
        ? undefined
        : buildProcessError(stderr, code));
    });
    timer = window.setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('SQLite query timed out after 10 seconds.'));
    }, 10_000);
  });
}

function buildProcessError(stderr: string, code: number | null): Error {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const detail = lines.find(line => line.startsWith('Error:')) ?? lines[0];
  return new Error((detail ?? `Process exited with code ${code}.`).slice(0, 500));
}

function parseStoredSessionRows(value: string): StoredSessionRows | null {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }

    const messageRows = parseStoredRowsValue(parsed.messageRows);
    const partRows = parseStoredRowsValue(parsed.partRows);
    return messageRows && partRows ? { messageRows, partRows } : null;
  } catch {
    return null;
  }
}

function parseStoredRows(value: string): StoredRow[] | null {
  try {
    return parseStoredRowsValue(JSON.parse(value || '[]') as unknown);
  } catch {
    return null;
  }
}

function formatError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function parseStoredRowsValue(value: unknown): StoredRow[] | null {
  return Array.isArray(value)
    ? value.filter((row): row is StoredRow => isPlainObject(row))
    : null;
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll('\'', '\'\'');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildOpencodeMessageRowsSql(sessionIdExpression: string): string {
  return `
with message_json as (
  select
    id,
    time_created,
    data,
    json_valid(data) as data_valid
  from message
  where session_id = ${sessionIdExpression}
)
select
  id,
  time_created,
  data_valid,
  case when data_valid then json_extract(data, '$.role') end as role,
  case when data_valid then json_extract(data, '$.time.created') end as data_time_created,
  case when data_valid then json_extract(data, '$.time.completed') end as data_time_completed
from message_json
order by time_created asc, id asc;`.trim();
}

function buildOpencodePartRowsSql(sessionIdExpression: string): string {
  return `
select id, message_id, data
from part
where session_id = ${sessionIdExpression}
order by message_id asc, id asc;`.trim();
}
