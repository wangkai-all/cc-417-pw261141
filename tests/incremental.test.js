import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDb, cut, REF } from './helpers.js';
import { planCutview, openRun, executePlan, loadCutview } from '../src/lib/cutview.js';
import { newId } from '../src/lib/util.js';

/**
 * Incremental mode threads from a published baseline cut instead of replaying from
 * the anchor. It is the "maintained state" option; the point of these tests is that
 * it must equal replay while it is safe, and refuse to be incremental the moment a
 * late arrival or a new count would make a pure delta wrong.
 */
const DATASET = [
  { id: 's', stream: 'snapshot', received_at: '2026-01-01T01:00:00Z', rows: [{ snapshot_id: 'C-1', effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }] },
  {
    id: 'l1', stream: 'ledger', received_at: '2026-01-10T00:00:00Z',
    rows: [
      { event_id: 'E-1', kind: 'receipt', qty: 30, unit: 'EA', effective_at: '2026-01-05T00:00:00Z' },
      { event_id: 'E-2', kind: 'issue', qty: 5, unit: 'EA', effective_at: '2026-01-06T00:00:00Z' },
    ],
  },
];

const K = '2026-03-01T00:00:00Z';

function incremental(db, base, at) {
  const plan = planCutview(db, { sku: 'SKU-A', location: 'WH-1', at, knowledge_at: K, mode: 'incremental', baseline_cutview_id: base.cutview_id });
  plan.run_id = newId('run');
  openRun(db, plan, { runId: plan.run_id });
  return loadCutview(db, executePlan(db, plan).cutview_id);
}

test('incremental threading matches replay when nothing invalidated the baseline', () => {
  const { db } = buildDb({ batches: DATASET });
  const base = cut(db, { at: '2026-01-07T00:00:00Z', knowledge_at: K });
  const replay = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: K });
  const inc = incremental(db, base, '2026-01-20T00:00:00Z');
  assert.equal(inc.qty_base, replay.qty_base);
  assert.equal(inc.qty_base, 125);
  assert.equal(inc.anchor.threading, 'incremental_from_baseline');
  assert.equal(inc.warnings.filter((w) => w.code === 'INCREMENTAL_INVALIDATED').length, 0);
  // Rows at/before the baseline are inherited rather than re-examined.
  assert.ok(inc.excluded.some((e) => e.event_id === 'E-1' && e.code === 'inherited_from_baseline'));
});

test('a count learned after the baseline forces replay and says why', () => {
  const { db } = buildDb({ batches: DATASET });
  const base = cut(db, { at: '2026-01-07T00:00:00Z', knowledge_at: '2026-01-10T00:00:00Z' });
  db.prepare(`INSERT INTO batches(batch_id,stream,source_file,source_sha256,received_at,accepted_at,ingested_at,row_count,accepted_count,rejected_count,duplicate_count,status,payload_sha256,payload)
    VALUES('snap2','snapshot','inline','sha','2026-01-25T00:00:00Z','2026-01-25T00:00:00Z','2026-01-25T00:00:00Z',1,1,0,0,'accepted','sha','inline')`).run();
  db.prepare(`INSERT INTO snapshots(stream,snapshot_id,revision,batch_id,sku,location,counted_at,effective_at,qty_base,unit_base,qty_counted,unit_counted,unit_version,factor_to_base,dimension,reason,operator,source_line,row_sha256)
    VALUES('snapshot','C-2',1,'snap2','SKU-A','WH-1','2026-01-20T00:00:00Z','2026-01-20T00:00:00Z',150,'EA',150,'EA',1,1,'count',null,null,1,'sha')`).run();
  const inc = incremental(db, base, '2026-02-10T00:00:00Z');
  const replay = cut(db, { at: '2026-02-10T00:00:00Z', knowledge_at: K });
  assert.equal(inc.anchor.threading, 'replay_forced');
  assert.ok(inc.warnings.some((w) => w.code === 'INCREMENTAL_INVALIDATED'));
  assert.equal(inc.qty_base, replay.qty_base, 'forced replay must agree with a full replay');
});

test('a late movement before the baseline forces replay rather than a wrong delta', () => {
  const { db } = buildDb({ batches: DATASET });
  // The baseline is taken with a cutoff that predates the late batch's arrival.
  const base = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-01-21T00:00:00Z' });
  db.prepare(`INSERT INTO batches(batch_id,stream,source_file,source_sha256,received_at,accepted_at,ingested_at,row_count,accepted_count,rejected_count,duplicate_count,status,payload_sha256,payload)
    VALUES('late','ledger','inline','sha','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z',1,1,0,0,'accepted','sha','inline')`).run();
  db.prepare(`INSERT INTO ledger_entries(stream,event_id,batch_id,sku,location,delta_base,unit_base,qty_input,unit_input,unit_version,factor_to_base,dimension,kind,effective_at,recorded_at,reversed_event_id,correction_of,reason,operator,source_line,row_sha256)
    VALUES('ledger','E-9','late','SKU-A','WH-1',-12,'EA',12,'EA',1,1,'count','issue','2026-01-12T00:00:00Z','2026-02-01T00:00:00Z',null,null,null,null,1,'sha-E-9')`).run();
  const inc = incremental(db, base, '2026-02-10T00:00:00Z');
  const replay = cut(db, { at: '2026-02-10T00:00:00Z', knowledge_at: K });
  assert.equal(inc.anchor.threading, 'replay_forced');
  assert.equal(inc.qty_base, replay.qty_base);
  assert.equal(inc.qty_base, 113, '100 + 30 - 5 - 12: the late row is replayed from the anchor');
  assert.equal(replay.rebuilt_from, null);
});

test('incremental refuses a baseline that is after the cut or uses a later cutoff', () => {
  const { db } = buildDb({ batches: DATASET });
  const base = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.throws(
    () => planCutview(db, { sku: 'SKU-A', location: 'WH-1', at: '2026-01-10T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z', mode: 'incremental', baseline_cutview_id: base.cutview_id }),
    (err) => /after the requested cut/.test(err.message) || /baseline cutview is after/.test(err.message),
  );
  assert.throws(
    () => planCutview(db, { sku: 'SKU-A', location: 'WH-1', at: '2026-02-01T00:00:00Z', knowledge_at: '2026-01-15T00:00:00Z', mode: 'incremental', baseline_cutview_id: base.cutview_id }),
    /baseline cutview used a later knowledge cutoff/,
  );
  assert.throws(
    () => planCutview(db, { sku: 'SKU-A', location: 'WH-1', at: '2026-02-01T00:00:00Z', knowledge_at: K, mode: 'incremental' }),
    /incremental mode requires baseline_cutview_id/,
  );
  void REF;
});
