/**
 * Test fixture: a fresh in-memory store with the fictional dataset ingested.
 * Each test gets its own database, so nothing here touches artifacts/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/lib/db.js';
import { ingestManifest } from '../src/lib/ingest.js';
import { executePlan, loadCutview, openRun, planCutview } from '../src/lib/cutview.js';
import { newId } from '../src/lib/util.js';

let counter = 0;

// Fixtures live in temp dirs; remove them when the test process exits so a long
// session does not accumulate hundreds of one-row datasets under /tmp.
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: a locked dir must not mask a test failure */
    }
  }
});

/** A temp dir that is removed when the test process exits. */
export function tempDir(prefix = 'cutview-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-${counter++}-`));
  tempDirs.push(dir);
  return dir;
}

/** Write a manifest plus its batch files into a fresh temp dir. */
export function writeDataset(manifest, files = {}) {
  return writeInto(tempDir(), manifest, files);
}

/** Same, into a caller-supplied temp dir (so file-backed DBs share one root). */
export function writeDatasetInto(dir, manifest, files = {}) {
  tempDirs.push(dir);
  return writeInto(dir, manifest, files);
}

function writeInto(dir, manifest, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { dir, manifestPath };
}

export function memoryDb() {
  return openDb(':memory:');
}

export const T = (s) => new Date(s).toISOString();

/** Minimal but complete reference data: EA/BOX (v1 12, v2 10), KG/G. */
export const REF = {
  unit_rules: [
    { unit: 'EA', dimension: 'count', version: 1, factor_to_base: 1, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null },
    { unit: 'BOX', dimension: 'count', version: 1, factor_to_base: 12, effective_from: T('2025-01-01T00:00:00Z'), effective_to: T('2026-03-01T00:00:00Z') },
    { unit: 'BOX', dimension: 'count', version: 2, factor_to_base: 10, effective_from: T('2026-03-01T00:00:00Z'), effective_to: null },
    { unit: 'KG', dimension: 'mass', version: 1, factor_to_base: 1, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null },
    { unit: 'G', dimension: 'mass', version: 1, factor_to_base: 0.001, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null },
  ],
  periods: [
    { label: '2026-01', start_at: T('2026-01-01T00:00:00Z'), end_at: T('2026-02-01T00:00:00Z') },
    { label: '2026-02', start_at: T('2026-02-01T00:00:00Z'), end_at: T('2026-03-01T00:00:00Z') },
    { label: '2026-03', start_at: T('2026-03-01T00:00:00Z'), end_at: T('2026-04-01T00:00:00Z') },
    { label: '2026-04', start_at: T('2026-04-01T00:00:00Z'), end_at: T('2026-05-01T00:00:00Z') },
  ],
  skus: { 'SKU-A': 'test widget' },
  locations: { 'WH-1': 'test warehouse' },
};

export function ledgerCsv(rows) {
  const header = 'event_id,sku,location,kind,qty,unit,effective_at,recorded_at,reverses_event_id,correction_of,reason';
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows.map((r) => [r.event_id, r.sku ?? 'SKU-A', r.location ?? 'WH-1', r.kind ?? 'receipt', r.qty, r.unit ?? 'EA', T(r.effective_at), T(r.recorded_at ?? r.effective_at), r.reverses_event_id, r.correction_of, r.reason].map(esc).join(','))].join('\n') + '\n';
}

export function snapshotJsonl(rows) {
  return rows.map((r) => JSON.stringify({
    snapshot_id: r.snapshot_id, revision: r.revision ?? 1, sku: r.sku ?? 'SKU-A', location: r.location ?? 'WH-1',
    counted_at: T(r.counted_at ?? r.effective_at), effective_at: T(r.effective_at), qty: r.qty, unit: r.unit ?? 'EA',
    reason: r.reason ?? null,
  })).join('\n') + '\n';
}

export function transitJson(rows) {
  return JSON.stringify(rows.map((r) => ({
    notice_id: r.notice_id, revision: r.revision ?? 1, sku: r.sku ?? 'SKU-A', location: r.location ?? 'WH-1',
    qty: r.qty, unit: r.unit ?? 'EA', status: r.status ?? 'in_transit',
    dispatched_at: r.dispatched_at ? T(r.dispatched_at) : null, eta_at: r.eta_at ? T(r.eta_at) : null,
    received_event_id: r.received_event_id ?? null, recorded_at: r.recorded_at ? T(r.recorded_at) : null, note: r.note ?? null,
  })), null, 2) + '\n';
}

/**
 * Build and ingest a dataset. `batches` entries: {id, stream, rows, received_at,
 * declared_coverage}. Rows are rendered by the stream's formatter.
 */
export function buildDb({ batches, ref = {}, dataset = 'test', dbPath = null }) {
  const files = {};
  const manifestBatches = [];
  for (const b of batches) {
    const file = `${b.stream}/${b.id}.${b.stream === 'ledger' ? 'csv' : b.stream === 'snapshot' ? 'jsonl' : 'json'}`;
    files[file] = b.stream === 'ledger'
      ? ledgerCsv(b.rows)
      : b.stream === 'snapshot'
        ? snapshotJsonl(b.rows)
        : transitJson(b.rows);
    manifestBatches.push({
      batch_id: b.id, stream: b.stream, file,
      received_at: T(b.received_at), declared_coverage: b.declared_coverage ?? [],
    });
  }
  const manifest = {
    dataset,
    connectors: Object.fromEntries(['ledger', 'snapshot', 'transit'].map((s) => [s, { name: `${s}-test` }])),
    ...REF, ...ref,
    batches: manifestBatches,
  };
  const { dir, manifestPath } = writeDataset(manifest, files);
  const db = dbPath ? openDb(dbPath) : memoryDb();
  const result = ingestManifest(manifestPath, { db });
  return { db, dir, manifestPath, result };
}

/** Build one cutview and return the hydrated view the API/CLI would serve. */
export function cut(db, { at, knowledge_at, sku = 'SKU-A', location = 'WH-1', mode = 'replay', baseline_cutview_id = null, crashAfter = null }) {
  const plan = planCutview(db, { sku, location, at, knowledge_at, mode, baseline_cutview_id });
  plan.run_id = newId('run');
  openRun(db, plan, { runId: plan.run_id });
  const res = executePlan(db, plan, { crashAfter });
  return loadCutview(db, res.cutview_id ?? db.prepare('SELECT cutview_id FROM cutviews WHERE run_id = ?').get(plan.run_id)?.cutview_id);
}
