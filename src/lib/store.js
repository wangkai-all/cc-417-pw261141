import path from 'node:path';
import fs from 'node:fs';
import { openDb } from './db.js';

export function defaultDbPath() {
  return process.env.LEDGER_CUTVIEW_DB ?? path.resolve('artifacts/cutview.db');
}

export function openStore(dbPath = defaultDbPath()) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  return openDb(dbPath);
}

export function keysOf(db) {
  return db
    .prepare(
      `SELECT sku, location FROM (
         SELECT sku, location FROM ledger_entries UNION SELECT sku, location FROM snapshots
       ) ORDER BY sku, location`,
    )
    .all();
}

export function counts(db) {
  const one = (sql) => Number(db.prepare(sql).get().n);
  return {
    ledger_entries: one('SELECT COUNT(*) AS n FROM ledger_entries'),
    snapshots: one('SELECT COUNT(*) AS n FROM snapshots'),
    transit_notices: one('SELECT COUNT(*) AS n FROM transit_notices'),
    batches: one('SELECT COUNT(*) AS n FROM batches'),
    rejected_rows: one('SELECT COUNT(*) AS n FROM rejected_rows'),
    rejected_batches: one("SELECT COUNT(*) AS n FROM batches WHERE status = 'rejected'"),
    duplicate_batches: one("SELECT COUNT(*) AS n FROM batches WHERE status = 'duplicate'"),
    cutviews: one('SELECT COUNT(*) AS n FROM cutviews'),
    rebuild_runs: one('SELECT COUNT(*) AS n FROM rebuild_runs'),
    aborted_runs: one("SELECT COUNT(*) AS n FROM rebuild_runs WHERE status = 'aborted'"),
    diffs: one('SELECT COUNT(*) AS n FROM diffs'),
  };
}
