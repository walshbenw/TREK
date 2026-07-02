import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { Client } from 'pg';
import { db } from '../db/database';
import { logInfo, logError } from './auditLog';
import { decrypt_api_key, maybe_encrypt_api_key } from './apiKeyCrypto';

// ---------------------------------------------------------------------------
// SQLite → Postgres mirror.
//
// A one-way, scheduled replica for robustness: SQLite (data/travel.db) stays the
// sole source of truth; this copies its contents into an external Postgres server
// on a cron. Nothing in the request/response path depends on it, and a failed run
// never touches the live DB (we only ever READ, from an isolated snapshot copy).
//
// Strategy (per the approved plan): upsert on primary key + an explicit
// delete-reconciliation pass so rows deleted in SQLite are removed from Postgres.
// ---------------------------------------------------------------------------

const dataDir = path.join(__dirname, '../../data');
const settingsFile = path.join(dataDir, 'replication-settings.json');
const statusFile = path.join(dataDir, 'replication-status.json');

// Ephemeral / re-derivable tables that carry no robustness value — excluded so
// the mirror doesn't churn on short-lived or rebuildable rows. Everything else
// (including users, webauthn_credentials, app_settings) is mirrored verbatim.
const DENY_TABLES = new Set<string>([
  'webauthn_challenges',
  'password_reset_tokens',
  'notifications',
  'migrations',
  'idempotency_keys',
  'google_place_photo_meta',
  'place_details_cache',
  'trek_photo_cache_meta',
]);

// ---------------------------------------------------------------------------
// Settings (non-secret) — JSON file, mirroring scheduler.ts backup settings.
// ---------------------------------------------------------------------------

export interface ReplicationSettings {
  enabled: boolean;
  interval: string; // reuses scheduler VALID_INTERVALS: hourly|daily|weekly|monthly
  hour: number;
  day_of_week: number;
  day_of_month: number;
}

function getDefaults(): ReplicationSettings {
  return { enabled: false, interval: 'daily', hour: 3, day_of_week: 0, day_of_month: 1 };
}

export function loadSettings(): ReplicationSettings {
  let settings = getDefaults();
  try {
    if (fs.existsSync(settingsFile)) {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      settings = { ...settings, ...saved };
    }
  } catch {
    /* fall back to defaults */
  }
  return settings;
}

export function saveSettings(settings: ReplicationSettings): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Secret (Postgres connection string) — encrypted in app_settings, env override.
// Mirrors the SMTP secret pattern (authService.ts / notifications.ts).
// ---------------------------------------------------------------------------

const PG_URL_KEY = 'replica_pg_url';
export const SECRET_MASK = '••••••••';

function getAppSetting(key: string): string | null {
  return (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value || null;
}

/** The effective connection string: env var wins, else the decrypted stored value. */
export function getPgUrl(): string {
  return process.env.REPLICA_PG_URL || decrypt_api_key(getAppSetting(PG_URL_KEY)) || '';
}

/** True if a connection string is configured (via env or stored setting). */
export function isPgUrlSet(): boolean {
  return !!getPgUrl();
}

/** Store the connection string encrypted. The mask sentinel means "keep existing". */
export function setPgUrl(url: string): void {
  if (url === SECRET_MASK) return;
  const val = maybe_encrypt_api_key(url);
  if (val === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(PG_URL_KEY);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(PG_URL_KEY, val);
}

// ---------------------------------------------------------------------------
// Last-run status — JSON file.
// ---------------------------------------------------------------------------

export interface TableResult {
  name: string;
  rows: number;
  action: 'upsert' | 'reload';
}

export interface ReplicationStatus {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  tables: TableResult[];
}

export function getStatus(): ReplicationStatus | null {
  try {
    if (fs.existsSync(statusFile)) return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    /* ignore */
  }
  return null;
}

function writeStatus(status: ReplicationStatus): void {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  } catch (err) {
    logError(`Replication: failed to write status file: ${err instanceof Error ? err.message : err}`);
  }
}

/** Combined view for the admin API (never exposes the raw connection string). */
export function getSettingsView(): {
  settings: ReplicationSettings;
  status: ReplicationStatus | null;
  timezone: string;
  pgUrlSet: boolean;
} {
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return { settings: loadSettings(), status: getStatus(), timezone: tz, pgUrlSet: isPgUrlSet() };
}

// ---------------------------------------------------------------------------
// SQLite introspection + type mapping
// ---------------------------------------------------------------------------

interface ColumnInfo {
  name: string;
  type: string; // declared SQLite type (may be empty)
  pk: number; // 0 = not part of PK, else 1-based ordinal
}

/** Double-quote a Postgres identifier (defence in depth; names are our own schema). */
function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Map a declared SQLite column type to a Postgres type. v1 maps DATETIME/DATE to
 * TEXT (faithful, zero parse risk); switching to TIMESTAMPTZ is a later enhancement.
 */
export function pgType(sqliteType: string): string {
  const t = (sqliteType || '').toUpperCase();
  if (/(DATE|TIME)/.test(t)) return 'TEXT'; // DATETIME/TIMESTAMP/DATE → TEXT (v1)
  if (t.includes('INT')) return 'BIGINT';
  if (/(CHAR|CLOB|TEXT)/.test(t)) return 'TEXT';
  if (/(REAL|FLOA|DOUB)/.test(t)) return 'DOUBLE PRECISION';
  if (t.includes('BLOB') || t === '') return 'BYTEA';
  return 'TEXT'; // NUMERIC and anything unusual → TEXT, lossless
}

function listTables(snap: Database.Database): string[] {
  const rows = snap
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map(r => r.name).filter(name => !DENY_TABLES.has(name));
}

function tableColumns(snap: Database.Database, table: string): ColumnInfo[] {
  const rows = snap.prepare(`PRAGMA table_info(${q(table)})`).all() as {
    name: string;
    type: string;
    pk: number;
  }[];
  return rows.map(r => ({ name: r.name, type: r.type, pk: r.pk }));
}

// ---------------------------------------------------------------------------
// Postgres schema mirroring (drift-tolerant)
// ---------------------------------------------------------------------------

async function ensureTable(client: Client, table: string, cols: ColumnInfo[]): Promise<void> {
  const pkCols = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const colDefs = cols.map(c => `${q(c.name)} ${pgType(c.type)}`).join(', ');
  const pkClause = pkCols.length ? `, PRIMARY KEY (${pkCols.map(q).join(', ')})` : '';
  // No NOT NULL / defaults / foreign keys on the mirror — keeps inserts robust.
  await client.query(`CREATE TABLE IF NOT EXISTS ${q(table)} (${colDefs}${pkClause})`);

  // Absorb schema drift: add any columns the target table is missing.
  const existing = await client.query(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
    [table],
  );
  const have = new Set(existing.rows.map((r: { column_name: string }) => r.column_name));
  for (const c of cols) {
    if (!have.has(c.name)) {
      await client.query(`ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(c.name)} ${pgType(c.type)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Row sync: upsert on PK + delete-reconcile (one transaction per table)
// ---------------------------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function syncTable(client: Client, snap: Database.Database, table: string): Promise<TableResult> {
  const cols = tableColumns(snap, table);
  const colNames = cols.map(c => c.name);
  const pkCols = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const rows = snap.prepare(`SELECT * FROM ${q(table)}`).all() as Record<string, unknown>[];

  // Batch size bounded by Postgres' 65535 parameter cap.
  const perRowParams = Math.max(1, colNames.length);
  const batchSize = Math.max(1, Math.min(1000, Math.floor(60000 / perRowParams)));

  await client.query('BEGIN');
  try {
    await ensureTable(client, table, cols);

    // No usable PK → truncate + reload (these are small junction-style tables).
    if (pkCols.length === 0) {
      await client.query(`TRUNCATE ${q(table)}`);
      await insertRows(client, table, colNames, rows, batchSize);
      await client.query('COMMIT');
      return { name: table, rows: rows.length, action: 'reload' };
    }

    // Upsert every live row.
    await upsertRows(client, table, colNames, pkCols, rows, batchSize);

    // Delete-reconcile: drop Postgres rows whose PK is no longer present in SQLite.
    await reconcileDeletes(client, table, cols, pkCols, rows);

    await client.query('COMMIT');
    return { name: table, rows: rows.length, action: 'upsert' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function insertRows(
  client: Client,
  table: string,
  colNames: string[],
  rows: Record<string, unknown>[],
  batchSize: number,
): Promise<void> {
  const colList = colNames.map(q).join(', ');
  for (const batch of chunk(rows, batchSize)) {
    const params: unknown[] = [];
    const valueGroups = batch.map(row => {
      const placeholders = colNames.map(c => {
        params.push(normalize(row[c]));
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`INSERT INTO ${q(table)} (${colList}) VALUES ${valueGroups.join(', ')}`, params);
  }
}

async function upsertRows(
  client: Client,
  table: string,
  colNames: string[],
  pkCols: string[],
  rows: Record<string, unknown>[],
  batchSize: number,
): Promise<void> {
  const colList = colNames.map(q).join(', ');
  const conflictTarget = pkCols.map(q).join(', ');
  const updateCols = colNames.filter(c => !pkCols.includes(c));
  const updateClause = updateCols.length
    ? `DO UPDATE SET ${updateCols.map(c => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}`
    : 'DO NOTHING';

  for (const batch of chunk(rows, batchSize)) {
    const params: unknown[] = [];
    const valueGroups = batch.map(row => {
      const placeholders = colNames.map(c => {
        params.push(normalize(row[c]));
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${q(table)} (${colList}) VALUES ${valueGroups.join(', ')} ` +
        `ON CONFLICT (${conflictTarget}) ${updateClause}`,
      params,
    );
  }
}

async function reconcileDeletes(
  client: Client,
  table: string,
  cols: ColumnInfo[],
  pkCols: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  const pkColInfo = pkCols.map(name => cols.find(c => c.name === name)!);
  const tempDefs = pkColInfo.map(c => `${q(c.name)} ${pgType(c.type)}`).join(', ');
  await client.query(`CREATE TEMP TABLE _repl_live (${tempDefs}) ON COMMIT DROP`);

  // Stream all live PK tuples into the temp table.
  const pkBatch = Math.max(1, Math.min(2000, Math.floor(60000 / Math.max(1, pkCols.length))));
  for (const batch of chunk(rows, pkBatch)) {
    const params: unknown[] = [];
    const valueGroups = batch.map(row => {
      const placeholders = pkCols.map(c => {
        params.push(normalize(row[c]));
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO _repl_live (${pkCols.map(q).join(', ')}) VALUES ${valueGroups.join(', ')}`,
      params,
    );
  }

  const joinCond = pkCols.map(c => `l.${q(c)} = x.${q(c)}`).join(' AND ');
  await client.query(
    `DELETE FROM ${q(table)} x WHERE NOT EXISTS (SELECT 1 FROM _repl_live l WHERE ${joinCond})`,
  );
}

/** better-sqlite3 returns Buffer for BLOB (→ bytea), numbers/strings/null as-is. */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// ---------------------------------------------------------------------------
// Postgres client
// ---------------------------------------------------------------------------

function makeClient(url: string): Client {
  // Enable TLS when the URL asks for it. rejectUnauthorized:false accommodates the
  // self-signed certs common on internal Postgres hosts; documented as such.
  const needsSsl = /[?&]sslmode=(require|prefer|verify-ca|verify-full)/i.test(url);
  return new Client({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
}

// ---------------------------------------------------------------------------
// Public: test connection
// ---------------------------------------------------------------------------

export async function testConnection(
  url?: string,
): Promise<{ connected: boolean; error?: string; serverVersion?: string }> {
  const target = url && url !== SECRET_MASK ? url : getPgUrl();
  if (!target) return { connected: false, error: 'No Postgres connection string configured.' };
  const client = makeClient(target);
  try {
    await client.connect();
    const res = await client.query('SELECT version() AS version');
    return { connected: true, serverVersion: res.rows[0]?.version };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public: run replication
// ---------------------------------------------------------------------------

let isRunning = false;

export async function runReplication(): Promise<ReplicationStatus> {
  const startedAt = new Date();
  if (isRunning) {
    logInfo('Replication: previous run still in progress, skipping this tick');
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      ok: false,
      error: 'A replication run is already in progress.',
      durationMs: 0,
      tables: [],
    };
  }

  const url = getPgUrl();
  if (!url) {
    const status: ReplicationStatus = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      error: 'No Postgres connection string configured.',
      durationMs: 0,
      tables: [],
    };
    writeStatus(status);
    return status;
  }

  isRunning = true;
  const snapPath = path.join(dataDir, `replica-snapshot-${Date.now()}.db`);
  let snap: Database.Database | null = null;
  const client = makeClient(url);
  const tables: TableResult[] = [];

  try {
    // Consistent point-in-time copy — the live app keeps writing uninterrupted.
    await (db as unknown as { backup: (p: string) => Promise<unknown> }).backup(snapPath);
    snap = new Database(snapPath, { readonly: true });

    await client.connect();

    for (const table of listTables(snap)) {
      const result = await syncTable(client, snap, table);
      tables.push(result);
    }

    const finishedAt = new Date();
    const status: ReplicationStatus = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ok: true,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      tables,
    };
    writeStatus(status);
    logInfo(`Replication complete: ${tables.length} tables, ${tables.reduce((n, t) => n + t.rows, 0)} rows in ${status.durationMs}ms`);
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    const status: ReplicationStatus = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ok: false,
      error: message,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      tables,
    };
    writeStatus(status);
    logError(`Replication failed: ${message}`);
    // Best-effort admin alert; never let notification failure mask the original error.
    try {
      const { send } = require('./notificationService');
      await send({
        event: 'replication_failed',
        actorId: null,
        scope: 'admin',
        targetId: 0,
        params: { error: message },
      }).catch(() => {});
    } catch {
      /* notification wiring optional */
    }
    return status;
  } finally {
    await client.end().catch(() => {});
    try { snap?.close(); } catch { /* ignore */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(snapPath + ext); } catch { /* ignore */ }
    }
    isRunning = false;
  }
}
