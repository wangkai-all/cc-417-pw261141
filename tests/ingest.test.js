import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDb, writeDataset, ledgerCsv, REF } from './helpers.js';
import { ingestManifest } from '../src/lib/ingest.js';

const base = (extra = {}) => ({
  batches: [
    {
      id: 'snap-1', stream: 'snapshot', received_at: '2026-01-02T00:00:00Z', ...(extra.snapshot ?? {}),
      rows: [{ snapshot_id: 'C-1', revision: 1, effective_at: '2026-01-01T00:00:00Z', counted_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }],
    },
    {
      id: 'led-1', stream: 'ledger', received_at: '2026-01-10T00:00:00Z', ...(extra.ledger ?? {}),
      rows: [{ event_id: 'E-1', kind: 'receipt', qty: 10, unit: 'EA', effective_at: '2026-01-05T00:00:00Z' }],
    },
    ...(extra.extraBatches ?? []),
  ],
});

test('identical batch redelivery is a no-op, not a second application', () => {
  const { db, manifestPath } = buildDb(base());
  const before = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n;
  const again = ingestManifest(manifestPath, { db });
  const statuses = again.batches.map((b) => b.status);
  assert.deepEqual(statuses, ['duplicate', 'duplicate']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n, before);
  assert.equal(db.prepare("SELECT duplicate_count FROM batches WHERE batch_id='led-1'").get().duplicate_count, 0);
});

test('same batch_id with different contents is refused outright', () => {
  const { db, manifestPath, dir } = buildDb(base());
  const first = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Rewrite the ledger file under the same batch id: idempotency must be keyed by
  // payload, not just by name.
  const ledgerFile = path.join(dir, first.batches.find((b) => b.batch_id === 'led-1').file);
  fs.writeFileSync(ledgerFile, ledgerCsv([{ event_id: 'E-1', kind: 'receipt', qty: 11, unit: 'EA', effective_at: '2026-01-05T00:00:00Z' }]));
  assert.throws(() => ingestManifest(manifestPath, { db }), /already accepted with different contents/);
  assert.equal(db.prepare("SELECT delta_base FROM ledger_entries WHERE event_id='E-1'").get().delta_base, 10);
});

test('a batch with one bad row applies nothing and records every diagnostic', () => {
  const { db } = buildDb(base({
    extraBatches: [{
      id: 'led-bad', stream: 'ledger', received_at: '2026-01-11T00:00:00Z',
      rows: [
        { event_id: 'E-2', kind: 'receipt', qty: 5, unit: 'EA', effective_at: '2026-01-06T00:00:00Z' },
        { event_id: 'E-3', kind: 'issue', qty: 1, unit: 'FURLONG', effective_at: '2026-01-06T00:00:00Z' },
      ],
    }],
  }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE event_id IN ('E-2','E-3')").get().n, 0);
  const batch = db.prepare("SELECT status, accepted_count, rejected_count FROM batches WHERE batch_id='led-bad'").get();
  assert.deepEqual({ ...batch }, { status: 'rejected', accepted_count: 0, rejected_count: 1 });
  const diag = db.prepare("SELECT stream_key, code FROM rejected_rows WHERE batch_id='led-bad'").all().map((r) => ({ ...r }));
  assert.deepEqual(diag, [{ stream_key: 'E-3', code: 'UNIT_RULE_MISSING' }]);
});

test('snapshot revisions are append-only and the prior revision is marked superseded', () => {
  const { db } = buildDb({
    batches: [{
      id: 'snap-rev', stream: 'snapshot', received_at: '2026-01-03T00:00:00Z',
      rows: [
        { snapshot_id: 'C-9', revision: 1, effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' },
        { snapshot_id: 'C-9', revision: 2, effective_at: '2026-01-01T00:00:00Z', qty: 97, unit: 'EA' },
      ],
    }],
  });
  const rows = db.prepare("SELECT revision, qty_base, superseded_by_revision FROM snapshots WHERE snapshot_id='C-9' ORDER BY revision").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { revision: 1, qty_base: 100, superseded_by_revision: 2 },
    { revision: 2, qty_base: 97, superseded_by_revision: null },
  ]);
});

test('a revision number that goes backwards is rejected, never applied over a newer one', () => {
  const { db } = buildDb({
    batches: [{
      id: 'snap-rev', stream: 'snapshot', received_at: '2026-01-05T00:00:00Z',
      rows: [{ snapshot_id: 'C-9', revision: 2, effective_at: '2026-01-01T00:00:00Z', qty: 97, unit: 'EA' }],
    }],
  });
  const late = buildDb({
    batches: [{
      id: 'snap-old', stream: 'snapshot', received_at: '2026-01-06T00:00:00Z',
      rows: [{ snapshot_id: 'C-9', revision: 1, effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }],
    }],
  });
  // Same reference data, so replaying the old batch into the first database is the
  // real scenario: the insert refuses to go backwards.
  const file = path.join(late.dir, 'snapshot', 'snap-old.jsonl');
  const manifest = {
    dataset: 'late', ...REF,
    batches: [{ batch_id: 'snap-old', stream: 'snapshot', file: 'snapshot/snap-old.jsonl', format: 'jsonl', received_at: '2026-01-06T00:00:00Z' }],
  };
  const { manifestPath } = writeDataset(manifest, { 'snapshot/snap-old.jsonl': fs.readFileSync(file, 'utf8') });
  const result = ingestManifest(manifestPath, { db });
  assert.equal(result.batches[0].status, 'rejected');
  assert.match(result.batches[0].errors[0].message, /older than stored revision 2/);
});

test('declared coverage holes are recorded once even when a batch is redelivered', () => {
  const coverage = [{ sku: 'SKU-A', location: 'WH-1', start_at: '2026-01-07T00:00:00Z', end_at: '2026-01-09T00:00:00Z', reason: 'connector_outage' }];
  const { db, manifestPath } = buildDb(base({ ledger: { declared_coverage: coverage } }));
  ingestManifest(manifestPath, { db });
  const rows = db.prepare('SELECT count(*) AS n FROM coverage').get().n;
  assert.equal(rows, 1);
});

test('reference data cannot be silently redefined after the first ingest', () => {
  const { db, manifestPath, dir } = buildDb(base());
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.unit_rules = manifest.unit_rules.map((r) => (r.unit === 'EA' ? { ...r, factor_to_base: 2 } : r));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => ingestManifest(manifestPath, { db }), /unit rules changed after first ingest/);
  void dir;
});
