# Design: Scheduled SQLite → Postgres Mirror

**Status:** Draft for review
**Author:** (planning doc)
**Date:** 2026-07-02

## 1. Goal & non-goals

**Goal.** Add robustness by continuously mirroring TREK's embedded SQLite database
(`data/travel.db`) into an external Postgres server on the network, on a cron
schedule, so a durable, queryable copy of all trip data lives outside the single
container/volume.

**Non-goals.**

- This does **not** make Postgres the application's primary datastore. All writes
  continue to go to SQLite via the existing ~1124 `db.prepare(...)` call sites.
  Nothing in the request/response path changes.
- This is **not** high-availability failover. Postgres is a downstream, eventually
  consistent copy that lags by one cron interval.
- This is **not** a replacement for the existing ZIP backup feature
  (`backupService.ts`). The two are complementary: ZIP backups are point-in-time
  archives (DB file + uploads + encryption key); the Postgres mirror is a live,
  queryable relational copy suitable for external reporting/BI, monitoring, and
  off-box durability.

If Postgres ever needs to *serve* the app, that is the full native migration
(swap the datastore behind all call sites), which is explicitly out of scope here.

## 2. Overview

The mirror reuses infrastructure that already exists:

- **`node-cron` scheduler** — `server/src/scheduler.ts` already hosts ~8 scheduled
  tasks with a consistent `loadSettings → buildCronExpression → cron.schedule`
  pattern. The mirror is one more task.
- **Consistent snapshotting** — `backupService.ts` / `scheduler.ts` already
  checkpoint the WAL (`PRAGMA wal_checkpoint(TRUNCATE)`) before reading the DB
  file. The mirror does the same, then reads from an isolated snapshot copy.
- **Encrypted secrets** — SMTP/OIDC secrets are stored in the `app_settings`
  table encrypted with `apiKeyCrypto` (`encrypt_api_key` / `decrypt_api_key`) and
  overridable by env var. The Postgres connection string uses the same pattern.
- **Notifications** — `notificationService.ts` (email/webhook/ntfy/in-app) is used
  to alert on replication failure.

Only one new runtime dependency is required: `pg` (node-postgres).

## 3. Data flow (per scheduled run)

```
1. Acquire snapshot
   - PRAGMA wal_checkpoint(TRUNCATE) on the live DB
   - VACUUM INTO '<tmp>/replica-snapshot.db'   (consistent point-in-time copy)
   - Open the snapshot read-only with better-sqlite3
     → the live app keeps serving writes uninterrupted during replication

2. Connect to Postgres (pg Pool) using the configured connection string

3. For each in-scope table:
   a. Introspect columns:   PRAGMA table_info(<t>)
   b. Ensure target schema: CREATE TABLE IF NOT EXISTS + ADD COLUMN for drift
   c. Sync rows (see §4)

4. Disconnect. Delete snapshot temp file.

5. Report result:
   - success → structured log line + last-run status persisted
   - failure → log + notification via notificationService (mirror is best-effort;
     SQLite is untouched, so a failed run never affects the app)
```

## 4. Row sync strategy — upsert on primary key (+ delete reconciliation)

Chosen strategy: **upsert on primary key**, not truncate-and-reload. This avoids an
empty-table window on the Postgres side and preserves target-side indexes, and it
writes with `INSERT ... ON CONFLICT`.

### 4.1 The deletion problem (must-handle)

Plain upsert only ever inserts/updates. Rows **deleted** in SQLite would linger in
Postgres forever, so the mirror would silently diverge. Because we already read a
**full consistent snapshot** each run, we can reconcile deletes cheaply without
tombstones or triggers:

For each table, per run:

```sql
-- 1. Upsert every live row (batched)
INSERT INTO <t> (<cols>) VALUES (...)
ON CONFLICT (<pk>) DO UPDATE SET <col> = EXCLUDED.<col>, ...;

-- 2. Reconcile deletes: remove PG rows whose PK is no longer present in SQLite.
--    Live PKs are streamed into a TEMP table, then anti-joined.
CREATE TEMP TABLE _live_ids (id ...) ON COMMIT DROP;
COPY _live_ids FROM STDIN;         -- all live PKs from the snapshot
DELETE FROM <t> t WHERE NOT EXISTS (SELECT 1 FROM _live_ids l WHERE l.id = t.id);
```

The whole table's upsert + reconcile runs in **one transaction** so external
readers of Postgres see a consistent table.

### 4.2 Primary-key detection & fallbacks

`PRAGMA table_info(<t>)` reports a `pk` ordinal per column. Three cases:

| Case | Detection | Handling |
|------|-----------|----------|
| Single-column PK (most tables: `id INTEGER PRIMARY KEY`) | exactly one col with `pk=1` | `ON CONFLICT (id)` + id-based delete reconcile |
| Composite PK (junction tables, e.g. `place_tags`, `day_assignments`, `notification_channel_preferences`) | multiple cols with `pk>0` | `ON CONFLICT (a, b)`; delete-reconcile anti-joins on the tuple |
| No usable PK | no `pk>0` columns | **Fallback: truncate + reload** this table (these are small); documented per-table |

The sync engine picks the mode per table from introspection — no hard-coded table
list beyond the include/exclude policy in §7.

### 4.3 Optional write-reduction (later)

Upsert still writes every row each run. Where a table has an `updated_at` column we
can later skip unchanged rows by tracking a high-water mark. Deferred — correctness
first; the delete-reconcile pass still requires a full PK scan regardless.

## 5. Schema mirroring & type mapping

No ORM exists and the schema evolves through an imperative 3096-line
`migrations.ts`. Rather than hand-maintain a parallel Postgres schema (which would
rot), the mirror **introspects SQLite at runtime** and creates/extends Postgres
tables to match. Type mapping (SQLite declared type → Postgres):

| SQLite | Postgres | Notes |
|--------|----------|-------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT PRIMARY KEY` | Copy the real id values; do **not** use PG identity/serial |
| `INTEGER` (incl. 0/1 booleans) | `BIGINT` | Keep integers as-is; no bool coercion to avoid ambiguity |
| `TEXT` | `TEXT` | |
| `REAL` | `DOUBLE PRECISION` | |
| `BLOB` | `BYTEA` | Real blobs exist, e.g. `webauthn_credentials.public_key` |
| `DATETIME` / `TIMESTAMP` | `TIMESTAMPTZ` | SQLite stores these as strings; parse on load. If parsing proves fragile, fall back to `TEXT` |

**Foreign keys are intentionally NOT created** on the mirror. It is a read copy;
enforcing FKs would only add load-ordering constraints and failure modes. Indexes
on primary keys are created; secondary indexes are optional/deferred.

**Drift handling.** Each run, after introspection, the engine issues
`CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` so new
columns from future SQLite migrations appear automatically. Column type changes and
drops are rare in this codebase and are treated as a manual/rare operational event
(logged, not auto-destructive).

## 6. Configuration & secrets

### 6.1 Non-secret settings — JSON file (mirrors backup settings)

New `data/replication-settings.json`, handled by a `loadSettings`/`saveSettings`
pair copied from `scheduler.ts`:

```jsonc
{
  "enabled": false,
  "interval": "daily",     // reuses VALID_INTERVALS: hourly|daily|weekly|monthly
  "hour": 3,
  "day_of_week": 0,
  "day_of_month": 1
}
```

`buildCronExpression()` in `scheduler.ts` is already generic and is reused as-is.

### 6.2 Secret — Postgres connection string

The connection string is a credential and is **not** written to the JSON file.
It follows the existing SMTP/OIDC secret pattern:

- Stored in `app_settings` under key `replica_pg_url`, encrypted via
  `encrypt_api_key`, decrypted on use via `decrypt_api_key`.
- Overridable by `REPLICA_PG_URL` env var (env wins), exactly like
  `process.env.SMTP_HOST || getAppSetting('smtp_host')`.
- TLS: support `?sslmode=require` in the URL; document recommending TLS for
  off-box Postgres.

## 7. Table include/exclude policy

For robustness the mirror aims for **full fidelity** — secret-bearing columns are
mirrored verbatim (decided; see §9). The only tables excluded are **ephemeral /
re-derivable** ones that carry no robustness value and only add churn:

**Excluded by default (ephemeral/re-derivable only):** `webauthn_challenges`
(short-TTL challenge nonces), `password_reset_tokens` (short-TTL, single-use),
`notifications` (high churn, re-derivable), `migrations`, the idempotency table,
and any photo/media cache tables.

**Included by default:** `users` (mirrored verbatim, including `password_hash`,
MFA secrets, and encrypted API-key columns — see §9), `webauthn_credentials`
(durable passkey material — needed so a rebuild-from-mirror retains passkeys),
`trips`, `days`, `places`, `place_tags`,
`tags`, `categories`, `day_assignments`, `packing_items`, `reservations`,
`trip_members`, `day_notes`, `budget_items`, `accommodations`, collab tables,
vacay tables, `audit_log`, `app_settings` (minus secrets).

The include/exclude sets live in one config module so the policy is auditable and
adjustable without touching the engine.

## 8. Scheduler & lifecycle wiring

- Add a `replicationTask: ScheduledTask | null` and a `startReplication()` block in
  `scheduler.ts`, copied from the auto-backup registration
  (`scheduler.ts` ~L121–137). Called from the same place the other tasks start on
  boot, and re-called when settings are saved from the admin UI.
- Guard against overlap: if a run is still in progress when the next tick fires,
  skip (log "previous run still running").
- Respect `TZ` like the other tasks.

## 9. Security considerations

- **Credential at rest:** PG URL encrypted with the same key/mechanism as other
  secrets; env override supported for deployments that inject secrets externally.
- **Secret propagation (DECIDED — mirror verbatim):** `users`, `app_settings`, and
  `webauthn_credentials` contain password hashes, MFA secrets, OIDC secrets,
  encrypted API keys, and passkey material. These are **mirrored as-is** — full
  fidelity is the point (a mirror missing secrets couldn't stand in for the
  primary). Consequence: **the Postgres mirror is exactly as sensitive as the
  primary database and must be secured accordingly** — TLS in transit, encryption
  at rest on the PG host, least-privilege DB user, restricted network exposure.
  This must be called out prominently in the ops/wiki documentation. Note that the
  app-level encrypted columns stay encrypted with TREK's `.encryption_key`, so the
  mirror is only usable with that key — do not assume the PG copy is "safer"
  because some columns are ciphertext; hashes and other secrets are still present.
- **Transport:** recommend/require TLS (`sslmode=require`) to the Postgres host.
- **Least privilege:** document that the PG user should own only the mirror
  database/schema.

## 10. Failure handling & observability

- A failed run is best-effort and **never** affects the app — SQLite is the source
  of truth and is only read (from an isolated snapshot copy).
- On failure: `logError(...)` (existing audit log) + a notification through
  `notificationService` (admin-scoped event), consistent with how auto-backup and
  version-check tasks report.
- Persist last-run status (timestamp, duration, rows synced per table, ok/error)
  for display in the admin UI.
- Always clean up the snapshot temp file in a `finally`.

## 11. File-by-file change list

**New**

- `server/src/services/replicationService.ts` — snapshot, introspect, type-map,
  per-table upsert + delete-reconcile, status reporting.
- `server/src/services/replicationConfig.ts` — include/exclude policy + settings
  load/save (or fold settings into the service, matching backup style).
- `client/src/components/Settings/ReplicationTab.tsx` (+ test) — admin UI:
  enabled toggle, interval/time, PG URL field, "Test connection", last-run status.
  Clone the auto-backup settings tab.

**Modified**

- `server/package.json` — add `pg`, `@types/pg`.
- `server/src/scheduler.ts` — register `replicationTask`.
- `server/src/nest/...` — a small admin controller/route to read/update settings +
  trigger a manual run + "test connection" (mirror the backup controller).
- `server/src/db/schema.ts` — none required (mirror introspects), unless we choose
  to store last-run status in a table instead of a JSON/status file.

## 12. Decisions & remaining open questions

**Decided:**

1. **Secret columns (§9):** mirror `users` / `app_settings` / `webauthn_credentials`
   **verbatim** — full fidelity. The mirror is therefore as sensitive as the
   primary and its security requirements must be documented prominently.
2. **Admin UI (§11):** v1 **includes a manual "Replicate now" trigger and a "Test
   connection" button**, in addition to the schedule/settings.

**Still open:**

3. **Last-run status storage:** JSON status file (like backup-settings) vs a small
   DB table. (Recommend JSON file for symmetry with existing backup settings.)
4. **Multi-instance safety:** current deployment is single-container/single-writer,
   so no coordination needed. If that ever changes, the overlap guard (§8) is not a
   cross-process lock — note as a future concern.

## 13. Effort & phasing

- **Phase 1 (PoC, ~1 day):** `replicationService` core against a throwaway
  Postgres — snapshot → introspect → create tables → upsert + delete-reconcile for
  a handful of tables. Validate type mapping and the composite-PK fallback.
- **Phase 2 (~1 day):** full table policy, settings load/save, scheduler wiring,
  overlap guard, failure notifications, status persistence.
- **Phase 3 (~1–1.5 days):** admin UI tab (settings, test-connection, manual run,
  last-run status) + tests + docs (`wiki/` page).

Total ≈ **2–4 days**, additive and low-risk (read-only against SQLite).

---

## Appendix: "Access as an app" (PWA) — already shipped

Investigated as part of this work. **TREK already ships a complete PWA** — no build
work required to "use it as an app":

- `vite-plugin-pwa` (v1.3.0) is configured in `client/vite.config.js` with
  `registerType: 'autoUpdate'`, a Workbox service worker, and a web app manifest.
- Installable to home screen / desktop; launches standalone (no browser chrome).
- Offline support via Workbox caches (map tiles, CDN libs, API data, uploads, app
  shell) **plus** a Dexie/IndexedDB store of full trip bundles, with an offline
  write-queue that syncs on reconnect.
- A **Settings → Offline** tab already exists to show cache stats, re-sync, and
  clear the cache.
- Documented in `wiki/Offline-Mode-and-PWA.md`.

**Implication:** the desktop/app UX goal is largely met today. Remaining options are
enhancements, not net-new capability:

- Ensure the deployment is served over **HTTPS** (the install prompt requires it) —
  this is the single most common reason the "Install app" affordance doesn't show.
- Only pursue a native shell (Electron/Tauri) if you specifically need OS-level
  integration the PWA can't provide (system tray, auto-launch, deep OS
  notification/protocol handlers). Otherwise the PWA is the lower-maintenance path
  (no code signing, notarization, or auto-update pipeline).
