import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDb, cut } from './helpers.js';
import { diffCutviews, persistDiff } from '../src/lib/diff.js';

const dataset = () => buildDb({
  batches: [
    { id: 's', stream: 'snapshot', received_at: '2026-01-01T01:00:00Z', rows: [{ snapshot_id: 'C-1', effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }] },
    {
      id: 'l1', stream: 'ledger', received_at: '2026-01-10T00:00:00Z',
      rows: [{ event_id: 'E-1', kind: 'receipt', qty: 30, unit: 'EA', effective_at: '2026-01-05T00:00:00Z' }],
    },
  ],
});

const addRow = (db, batchId, row) => {
  db.prepare(`INSERT INTO batches(batch_id,stream,source_file,source_sha256,received_at,accepted_at,ingested_at,row_count,accepted_count,rejected_count,duplicate_count,status,payload_sha256,payload)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    batchId, 'ledger', 'inline', 'sha', row.effective_at, row.recorded_at ?? row.effective_at, row.recorded_at ?? row.effective_at, 1, 1, 0, 0, 'accepted', 'sha', 'inline',
  );
  db.prepare(`INSERT INTO ledger_entries(stream,event_id,batch_id,sku,location,delta_base,unit_base,qty_input,unit_input,unit_version,factor_to_base,dimension,kind,effective_at,recorded_at,reversed_event_id,correction_of,reason,operator,source_line,row_sha256)
    VALUES('ledger',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.event_id, batchId, 'SKU-A', 'WH-1', row.delta_base, 'EA', row.qty, 'EA', 1, 1, 'count', row.kind ?? 'receipt',
    row.effective_at, row.recorded_at ?? row.effective_at, null, null, row.reason ?? null, null, 1, `sha-${row.event_id}`,
  );
};

test('diff attribution closes: quantity delta = movement effects + anchor delta', () => {
  const { db } = dataset();
  const a = cut(db, { at: '2026-01-04T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  const b = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  const report = diffCutviews(a, b, {});
  assert.equal(report.explanation.reconciles, true);
  assert.equal(report.explanation.unattributed_base, 0);
  assert.equal(report.qty_delta_base, 30);
  assert.deepEqual(report.explanation.movement_effects.map((m) => [m.event_id, m.kind, m.delta_base]), [['E-1', 'applied_in_b', 30]]);
  assert.equal(report.explanation.anchor_delta_base, 0);
});

test('a newer physical count is attributed as re-anchoring, never as a movement', () => {
  const { db } = dataset();
  const a = cut(db, { at: '2026-01-04T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  db.prepare(`INSERT INTO batches(batch_id,stream,source_file,source_sha256,received_at,accepted_at,ingested_at,row_count,accepted_count,rejected_count,duplicate_count,status,payload_sha256,payload)
    VALUES('snap2','snapshot','inline','sha','2026-01-15T00:00:00Z','2026-01-15T00:00:00Z','2026-01-15T00:00:00Z',1,1,0,0,'accepted','sha','inline')`).run();
  db.prepare(`INSERT INTO snapshots(stream,snapshot_id,revision,batch_id,sku,location,counted_at,effective_at,qty_base,unit_base,qty_counted,unit_counted,unit_version,factor_to_base,dimension,reason,operator,source_line,row_sha256)
    VALUES('snapshot','C-2',1,'snap2','SKU-A','WH-1','2026-01-12T00:00:00Z','2026-01-12T00:00:00Z',133,'EA',133,'EA',1,1,'count',null,null,1,'sha')`).run();
  const b = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  const report = diffCutviews(a, b, {});
  assert.equal(report.explanation.anchor_change.kind, 'reanchored');
  assert.equal(report.explanation.reconciles, true);
  assert.equal(report.explanation.unattributed_base, 0);
});

test('a correction restated before the cut shows up as a revaluation, and the identity still closes', () => {
  const { db } = dataset();
  const a = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-01-20T00:00:00Z' });
  // A restatement: reverse E-1 and re-add it larger, both effective at the original instant.
  addRow(db, 'fix-a', { event_id: 'E-1-R', delta_base: -30, qty: 30, kind: 'reversal', effective_at: '2026-01-05T00:00:00Z', recorded_at: '2026-01-15T00:00:00Z' });
  addRow(db, 'fix-b', { event_id: 'E-1-C', delta_base: 45, qty: 45, kind: 'receipt', effective_at: '2026-01-05T00:00:00Z', recorded_at: '2026-01-15T00:00:00Z' });
  db.prepare("UPDATE ledger_entries SET reversed_event_id='E-1' WHERE event_id='E-1-R'").run();
  const b = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  const report = diffCutviews(a, b, {});
  assert.equal(report.explanation.reconciles, true);
  assert.equal(report.qty_delta_base, 15);
  assert.equal(report.explanation.unattributed_base, 0);
});

test('a movement absent from A only because of A’s knowledge cutoff is attributed as newly knowable, not as a new movement', () => {
  const { db } = dataset();
  // Accepted after the first cut's knowledge cutoff, effective inside both windows.
  db.prepare(`INSERT INTO batches(batch_id,stream,source_file,source_sha256,received_at,accepted_at,ingested_at,row_count,accepted_count,rejected_count,duplicate_count,status,payload_sha256,payload)
    VALUES('late','ledger','inline','sha','2026-01-12T00:00:00Z','2026-01-12T00:00:00Z','2026-01-12T00:00:00Z',1,1,0,0,'accepted','sha','inline')`).run();
  db.prepare(`INSERT INTO ledger_entries(stream,event_id,batch_id,sku,location,delta_base,unit_base,qty_input,unit_input,unit_version,factor_to_base,dimension,kind,effective_at,recorded_at,reversed_event_id,correction_of,reason,operator,source_line,row_sha256)
    VALUES('ledger','E-2','late','SKU-A','WH-1',7,'EA',7,'EA',1,1,'count','receipt','2026-01-08T00:00:00Z','2026-01-08T00:00:00Z',null,null,null,null,1,'sha-E-2')`).run();
  const a = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-01-10T00:00:00Z' });
  const b = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.equal(a.status, 'knowledge_limited');
  assert.ok(a.excluded.some((e) => e.event_id === 'E-2' && e.code === 'received_after_knowledge'));
  const report = diffCutviews(a, b, {});
  const effect = report.explanation.movement_effects.find((m) => m.event_id === 'E-2');
  assert.equal(effect.kind, 'newly_knowable');
  assert.equal(effect.delta_base, 7);
  assert.match(report.context.note, /different knowledge cutoffs/);
  assert.equal(report.explanation.reconciles, true);
});

test('diff refuses unanchored cuts and mixed base units instead of returning a misleading number', () => {
  const { db } = dataset();
  const a = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  const none = cut(db, { at: '2025-12-01T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.throws(() => diffCutviews(none, a, {}), (err) => err.code === 'UNANCHORED_CUTVIEW');
  const mixed = { ...a, unit_base: 'KG' };
  assert.throws(() => diffCutviews(a, mixed, {}), (err) => err.code === 'UNIT_MISMATCH');
});

test('a persisted diff is retrievable and carries its digest', () => {
  const { db } = dataset();
  const a = cut(db, { at: '2026-01-04T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  const b = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  const saved = persistDiff(db, diffCutviews(a, b, {}));
  const row = db.prepare('SELECT report, digest FROM diffs WHERE diff_id = ?').get(saved.diff_id);
  assert.ok(row);
  assert.equal(JSON.parse(row.report).explanation.reconciles, true);
  assert.equal(row.digest, saved.digest);
  void fs; void path;
});
