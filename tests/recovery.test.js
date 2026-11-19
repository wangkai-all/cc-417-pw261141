import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDb, cut, tempDir } from './helpers.js';
import { executePlan, loadCutview, openRun, planCutview } from '../src/lib/cutview.js';
import { addCount, correctLedgerMovement } from '../src/lib/manual.js';
import { newId } from '../src/lib/util.js';

const BATCHES = [
  { id: 's', stream: 'snapshot', received_at: '2026-01-01T01:00:00Z', rows: [{ snapshot_id: 'C-1', effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }] },
  {
    id: 'l', stream: 'ledger', received_at: '2026-01-10T00:00:00Z',
    rows: [
      { event_id: 'E-1', kind: 'receipt', qty: 30, unit: 'EA', effective_at: '2026-01-05T00:00:00Z' },
      { event_id: 'E-2', kind: 'issue', qty: 5, unit: 'EA', effective_at: '2026-01-06T00:00:00Z' },
    ],
  },
];

const freshDir = () => tempDir('cutview-file');
const fileDb = (dir) => buildDb({ batches: BATCHES, dbPath: path.join(dir, 'cutview.db') });

test('a simulated exit publishes nothing and leaves a resumable run', () => {
  const { db } = fileDb(freshDir());
  const plan = planCutview(db, { sku: 'SKU-A', location: 'WH-1', at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  plan.run_id = newId('run');
  openRun(db, plan, { runId: plan.run_id });
  assert.throws(() => executePlan(db, plan, { crashAfter: 3 }), (err) => err.code === 'SIMULATED_CRASH');
  const run = db.prepare('SELECT status, steps_done, steps_total FROM rebuild_runs WHERE run_id = ?').get(plan.run_id);
  assert.deepEqual({ ...run }, { status: 'aborted', steps_done: 3, steps_total: 9 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cutviews WHERE run_id = ?').get(plan.run_id).n, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM rebuild_checkpoints WHERE run_id = ?').get(plan.run_id).n >= 3);
});

test('resume from the last checkpoint produces a byte-identical cutview digest', () => {
  const { db } = fileDb(freshDir());
  const request = { sku: 'SKU-A', location: 'WH-1', at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' };
  const aborted = planCutview(db, request);
  aborted.run_id = newId('run');
  openRun(db, aborted, { runId: aborted.run_id });
  assert.throws(() => executePlan(db, aborted, { crashAfter: 4 }), (err) => err.code === 'SIMULATED_CRASH');

  const last = db.prepare('SELECT * FROM rebuild_checkpoints WHERE run_id = ? ORDER BY step DESC LIMIT 1').get(aborted.run_id);
  const resumed = planCutview(db, request);
  resumed.run_id = newId('run');
  resumed.resume_from_step = last.step + 1;
  resumed.resume_state = JSON.parse(last.payload);
  resumed.resumed_from_run = aborted.run_id;
  openRun(db, resumed, { runId: resumed.run_id, resumedFrom: aborted.run_id, resumeFromStep: last.step + 1 });
  const result = executePlan(db, resumed);

  const clean = cut(db, request);
  assert.equal(result.cutview_id, clean.cutview_id);
  assert.equal(loadCutview(db, result.cutview_id).digest, clean.digest);
  assert.equal(db.prepare('SELECT status FROM rebuild_runs WHERE run_id = ?').get(aborted.run_id).status, 'resumed');
  assert.equal(db.prepare('SELECT status FROM rebuild_runs WHERE run_id = ?').get(resumed.run_id).status, 'completed');
});

test('a crash at every step still resumes to the same digest', () => {
  const { db } = fileDb(freshDir());
  const request = { sku: 'SKU-A', location: 'WH-1', at: '2026-01-20T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' };
  const clean = cut(db, request);
  for (let crashAfter = 1; crashAfter < 9; crashAfter++) {
    const first = planCutview(db, request);
    first.run_id = newId('run');
    openRun(db, first, { runId: first.run_id });
    assert.throws(() => executePlan(db, first, { crashAfter }), (err) => err.code === 'SIMULATED_CRASH');
    const last = db.prepare('SELECT * FROM rebuild_checkpoints WHERE run_id = ? ORDER BY step DESC LIMIT 1').get(first.run_id);
    const next = planCutview(db, request);
    next.run_id = newId('run');
    next.resume_from_step = last.step + 1;
    next.resume_state = JSON.parse(last.payload);
    next.resumed_from_run = first.run_id;
    openRun(db, next, { runId: next.run_id, resumedFrom: first.run_id, resumeFromStep: next.resume_from_step });
    const out = executePlan(db, next);
    assert.equal(out.cutview_id, clean.cutview_id, `crash after step ${crashAfter} diverged on resume`);
    assert.equal(loadCutview(db, out.cutview_id).digest, clean.digest);
  }
});

test('a manual count appends a revision and never touches the ledger', () => {
  const { db, dir } = fileDb(freshDir());
  const dbPath = path.join(dir, 'cutview.db');
  const ledgerBefore = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n;

  const first = addCount(db, dbPath, { sku: 'SKU-A', location: 'WH-1', counted_at: '2026-02-01T00:00:00Z', effective_at: '2026-02-01T00:00:00Z', qty: 128, unit: 'EA', reason: 'cycle count' });
  assert.equal(first.snapshot.revision, 1);
  assert.equal(first.ledger_untouched, true);
  const second = addCount(db, dbPath, { sku: 'SKU-A', location: 'WH-1', counted_at: '2026-02-02T00:00:00Z', effective_at: '2026-02-01T00:00:00Z', qty: 125, unit: 'EA', snapshot_id: first.snapshot.snapshot_id, reason: 'recount' });
  assert.equal(second.snapshot.revision, 2);
  assert.match(second.revision_note, /revision 1 is retained/);

  const revisions = db.prepare('SELECT revision, qty_base, superseded_by_revision FROM snapshots WHERE snapshot_id = ? ORDER BY revision').all(first.snapshot.snapshot_id).map((r) => ({ ...r }));
  assert.deepEqual(revisions, [
    { revision: 1, qty_base: 128, superseded_by_revision: 2 },
    { revision: 2, qty_base: 125, superseded_by_revision: null },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n, ledgerBefore);

  // A cut after the count uses the latest revision as its anchor.
  // Manual batches are received now, so the knowledge cutoff must be now too;
  // otherwise the new count is correctly excluded as not-yet-knowable.
  const cv = cut(db, { at: '2026-02-05T00:00:00Z', knowledge_at: new Date().toISOString() });
  assert.equal(cv.anchor.snapshot_id, first.snapshot.snapshot_id);
  assert.equal(cv.anchor.revision, 2);
  assert.equal(cv.qty_base, 125);
});

test('a ledger correction appends a reversal and a replacement, never overwriting', () => {
  const { db, dir } = fileDb(freshDir());
  const dbPath = path.join(dir, 'cutview.db');
  const before = db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n;
  const out = correctLedgerMovement(db, dbPath, { event_id: 'E-1', qty: 25, unit: 'EA', effective: 'restate', reason: 'keyed 30 instead of 25' });
  assert.equal(out.overwritten_rows, 0);
  assert.deepEqual(out.appended.map((r) => r.kind), ['reversal', 'receipt']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n, before + 2);
  assert.equal(db.prepare("SELECT delta_base FROM ledger_entries WHERE event_id='E-1'").get().delta_base, 30);
  // Repair of the original +30 receipt with a +25 one: reversal -30, replacement +25.
  assert.deepEqual(
    db.prepare("SELECT kind, delta_base FROM ledger_entries WHERE event_id LIKE 'E-1-%' ORDER BY effective_at, id").all().map((r) => ({ ...r })),
    [{ kind: 'reversal', delta_base: -30 }, { kind: 'receipt', delta_base: 25 }],
  );
  assert.throws(() => correctLedgerMovement(db, dbPath, { event_id: 'E-1', qty: 1, effective: 'restate', reason: 'again' }), /already reversed/);
});

test('a restated correction changes history; a forwarded one only changes the present', () => {
  // Both cuts use one knowledge cutoff taken *after* the correction batch arrived:
  // otherwise the correction is simply not yet knowable and the comparison is moot.
  const restated = fileDb(freshDir());
  const restatedPath = path.join(restated.dir, 'cutview.db');
  const control = fileDb(freshDir());
  correctLedgerMovement(restated.db, restatedPath, { event_id: 'E-1', qty: 25, unit: 'EA', effective: 'restate', reason: 'keyed 30 instead of 25' });
  const now = new Date().toISOString();
  const historyBefore = cut(control.db, { at: '2026-01-07T00:00:00Z', knowledge_at: now });
  const historyAfter = cut(restated.db, { at: '2026-01-07T00:00:00Z', knowledge_at: now });
  assert.equal(historyBefore.qty_base, 125); // 100 + 30 - 5
  // Restated at the original instant, the original +30 is cancelled and the +25
  // replacement replays: 100 + 25 - 5. The January cut now says something different.
  assert.equal(historyAfter.qty_base, 120, 'restate changes what the past cut says');

  const forwarded = fileDb(freshDir());
  const forwardedPath = path.join(forwarded.dir, 'cutview.db');
  correctLedgerMovement(forwarded.db, forwardedPath, { event_id: 'E-1', qty: 25, unit: 'EA', effective: 'forward', effective_at: '2026-02-10T00:00:00Z', reason: 'keyed 30 instead of 25' });
  const forwardNow = new Date().toISOString();
  const pastAfter = cut(forwarded.db, { at: '2026-01-07T00:00:00Z', knowledge_at: forwardNow });
  assert.equal(pastAfter.qty_base, historyBefore.qty_base, 'forwarding must not rewrite the past');
  // The Jan cut is unaffected; the Feb cut sees reversal -30 and replacement +25.
  const current = cut(forwarded.db, { at: '2026-02-15T00:00:00Z', knowledge_at: forwardNow });
  assert.equal(current.qty_base, 120, 'the correction lands in the current period');
});
