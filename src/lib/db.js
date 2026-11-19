import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per accepted connector batch. Re-ingesting an identical batch is a no-op;
-- a differing payload under the same batch_id is rejected.
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  source_file TEXT,
  source_sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL,
  rejected_count INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'accepted',
  payload_sha256 TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  stream TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  last_batch_id TEXT,
  last_received_at TEXT,
  updated_at TEXT NOT NULL
);

-- Stream 1: immutable stock ledger (after unit conversion + effective-dating).
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL DEFAULT 'ledger',
  event_id TEXT NOT NULL UNIQUE,
  batch_id TEXT NOT NULL REFERENCES batches(batch_id),
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  delta_base REAL NOT NULL,
  unit_base TEXT NOT NULL,
  qty_input REAL NOT NULL,
  unit_input TEXT NOT NULL,
  unit_version INTEGER NOT NULL,
  factor_to_base REAL NOT NULL,
  dimension TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'movement',
  effective_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reversed_event_id TEXT,
  correction_of TEXT,
  reason TEXT,
  operator TEXT,
  source_line INTEGER,
  row_sha256 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_pos ON ledger_entries(sku, location, effective_at);
CREATE INDEX IF NOT EXISTS idx_ledger_effective ON ledger_entries(effective_at);

-- Stream 2: physical count snapshots. A snapshot is a claim about on-hand at an
-- instant, NOT a ledger delta. It anchors replay; it is never summed with movements.
CREATE TABLE IF NOT EXISTS snapshots (
  stream TEXT NOT NULL DEFAULT 'snapshot',
  snapshot_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(batch_id),
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  counted_at TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  qty_base REAL NOT NULL,
  unit_base TEXT NOT NULL,
  qty_counted REAL NOT NULL,
  unit_counted TEXT NOT NULL,
  unit_version INTEGER NOT NULL,
  factor_to_base REAL NOT NULL,
  dimension TEXT NOT NULL,
  reason TEXT,
  operator TEXT,
  superseded_by_revision INTEGER,
  source_line INTEGER,
  row_sha256 TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pos ON snapshots(sku, location, effective_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_counted ON snapshots(counted_at);

-- Stream 3: in-transit notices. Deliberately kept out of on-hand; arrival converts a
-- notice into a ledger receipt (linked), so the two streams never double count.
CREATE TABLE IF NOT EXISTS transit_notices (
  stream TEXT NOT NULL DEFAULT 'transit',
  notice_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(batch_id),
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  qty_base REAL NOT NULL,
  unit_base TEXT NOT NULL,
  qty_noticed REAL NOT NULL,
  unit_noticed TEXT NOT NULL,
  unit_version INTEGER NOT NULL,
  factor_to_base REAL NOT NULL,
  dimension TEXT NOT NULL,
  status TEXT NOT NULL,
  dispatched_at TEXT,
  eta_at TEXT,
  received_event_id TEXT,
  recorded_at TEXT NOT NULL,
  note TEXT,
  superseded_by_revision INTEGER,
  source_line INTEGER,
  row_sha256 TEXT NOT NULL,
  PRIMARY KEY (notice_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_transit_pos ON transit_notices(sku, location, eta_at);

-- Declared/derived data coverage per stream key. Gaps are first-class rows, not silence.
CREATE TABLE IF NOT EXISTS coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL,
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  ack_id TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  batch_id TEXT,
  UNIQUE (stream, sku, location, start_at, end_at, reason, ack_id)
);
CREATE INDEX IF NOT EXISTS idx_coverage_pos ON coverage(sku, location);

-- Pinned, immutable unit rule table (history must stay re-derivable).
CREATE TABLE IF NOT EXISTS unit_rules (
  unit TEXT NOT NULL,
  version INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  factor_to_base REAL NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  label TEXT,
  note TEXT,
  PRIMARY KEY (unit, version)
);

CREATE TABLE IF NOT EXISTS periods (
  label TEXT PRIMARY KEY,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skus (
  sku TEXT PRIMARY KEY,
  description TEXT,
  category TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  location TEXT PRIMARY KEY,
  description TEXT
);

CREATE TABLE IF NOT EXISTS rejected_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  stream_key TEXT,
  source_line INTEGER,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  raw TEXT,
  rejected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rejected_batch ON rejected_rows(batch_id);

-- Rebuild runs: a run either completes and records its cutview, or is aborted
-- (crash / kill) leaving checkpoints that a later run can resume from.
CREATE TABLE IF NOT EXISTS rebuild_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  at_iso TEXT,
  knowledge_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  resumed_from TEXT,
  steps_total INTEGER,
  steps_done INTEGER NOT NULL DEFAULT 0,
  plan_digest TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS rebuild_checkpoints (
  run_id TEXT NOT NULL REFERENCES rebuild_runs(run_id),
  step INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step)
);

-- Anchor chooser: one row with the structural reason a snapshot was trusted.
CREATE TABLE IF NOT EXISTS anchors (
  anchor_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  effective_at TEXT NOT NULL,
  qty_base REAL NOT NULL,
  unit_base TEXT NOT NULL,
  superseded_revisions TEXT NOT NULL,
  transit_logged INTEGER NOT NULL,
  gaps_before TEXT NOT NULL,
  coverage_end_at TEXT,
  confidence REAL NOT NULL,
  reasons TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cutviews (
  cutview_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  at_iso TEXT NOT NULL,
  knowledge_at TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  qty_base REAL,
  unit_base TEXT NOT NULL,
  confidence REAL NOT NULL,
  confidence_breakdown TEXT NOT NULL DEFAULT '[]',
  anchor TEXT NOT NULL,
  unverified TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  transit TEXT NOT NULL,
  deltas TEXT NOT NULL,
  excluded TEXT NOT NULL DEFAULT '[]',
  lineage TEXT NOT NULL,
  units TEXT NOT NULL,
  periods TEXT NOT NULL,
  digest TEXT NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'cutview/1',
  run_id TEXT,
  rebuilt_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_cutviews_key ON cutviews(sku, location, at_iso);

-- A diff is a persisted report so a comparison can be cited after the fact.
CREATE TABLE IF NOT EXISTS diffs (
  diff_id TEXT PRIMARY KEY,
  a_cutview_id TEXT NOT NULL,
  b_cutview_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  report TEXT NOT NULL,
  digest TEXT NOT NULL
);
`;

/** Add a column to an existing table when a database predates it. */
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // Databases created before the policy was recorded per cutview get the column
  // backfilled with the running policy version; existing digests are untouched.
  ensureColumn(db, 'cutviews', 'policy_version', "TEXT NOT NULL DEFAULT 'cutview/1'");
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback of an already-failed tx */
    }
    throw err;
  }
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}

export function txRunId(db, preferred) {
  if (preferred) {
    const row = db.prepare('SELECT run_id FROM rebuild_runs WHERE run_id = ?').get(preferred);
    if (!row) throw new Error(`no such run: ${preferred}`);
    return preferred;
  }
  const row = db
    .prepare("SELECT run_id FROM rebuild_runs WHERE status = 'aborted' ORDER BY started_at DESC LIMIT 1")
    .get();
  return row?.run_id ?? null;
}
