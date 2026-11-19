import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDb, cut } from './helpers.js';

const dataset = () => buildDb({
  batches: [
    {
      id: 'snap-open', stream: 'snapshot', received_at: '2026-01-01T01:00:00Z',
      rows: [{ snapshot_id: 'C-OPEN', revision: 1, effective_at: '2026-01-01T00:00:00Z', counted_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }],
    },
    {
      id: 'led-jan', stream: 'ledger', received_at: '2026-01-05T00:00:00Z',
      rows: [
        { event_id: 'E-1', kind: 'receipt', qty: 10, unit: 'EA', effective_at: '2026-01-01T00:00:00Z' }, // exactly at anchor
        { event_id: 'E-2', kind: 'issue', qty: 4, unit: 'EA', effective_at: '2026-01-02T00:00:00Z' },
        { event_id: 'E-3', kind: 'receipt', qty: 2, unit: 'EA', effective_at: '2026-01-03T00:00:00Z' },
      ],
    },
    {
      id: 'snap-mid', stream: 'snapshot', received_at: '2026-02-01T01:00:00Z',
      rows: [{ snapshot_id: 'C-MID', revision: 1, effective_at: '2026-02-01T00:00:00Z', counted_at: '2026-02-01T00:00:00Z', qty: 98, unit: 'EA' }],
    },
    {
      id: 'led-feb', stream: 'ledger', received_at: '2026-02-10T00:00:00Z',
      rows: [{ event_id: 'E-4', kind: 'issue', qty: 3, unit: 'EA', effective_at: '2026-02-05T00:00:00Z' }],
    },
  ],
});

test('a movement effective exactly at the count instant is inside the count, not replayed', () => {
  const { db } = dataset();
  const cv = cut(db, { at: '2026-01-01T00:00:00Z', knowledge_at: '2026-03-01T00:00:00Z' });
  assert.equal(cv.anchor.snapshot_id, 'C-OPEN');
  assert.equal(cv.qty_base, 100);
  assert.equal(cv.deltas.length, 0);
  assert.ok(cv.excluded.some((e) => e.event_id === 'E-1' && e.code === 'inherited_from_baseline'));
});

test('replay is exclusive of the anchor instant and inclusive of the cut', () => {
  const { db } = dataset();
  const cv = cut(db, { at: '2026-01-03T00:00:00Z', knowledge_at: '2026-03-01T00:00:00Z' });
  assert.equal(cv.qty_base, 98); // 100 + (-4) + 2
  assert.deepEqual(cv.deltas.map((d) => d.event_id), ['E-2', 'E-3']);
  const later = cut(db, { at: '2026-02-05T00:00:00Z', knowledge_at: '2026-03-01T00:00:00Z' });
  assert.equal(later.qty_base, 95);
  assert.equal(later.anchor.snapshot_id, 'C-MID');
});

test('the nearest eligible count at or before the cut anchors it', () => {
  const { db } = dataset();
  const cv = cut(db, { at: '2026-01-20T00:00:00Z', knowledge_at: '2026-03-01T00:00:00Z' });
  assert.equal(cv.anchor.snapshot_id, 'C-OPEN');
  assert.equal(cv.anchor.candidates.find((c) => c.snapshot_id === 'C-MID')?.eligible, false);
  assert.equal(cv.anchor.candidates.find((c) => c.snapshot_id === 'C-MID')?.checks[0].code, 'after_cut');
});

test('a count that became known after the knowledge cutoff cannot be used', () => {
  const { db } = dataset();
  const cv = cut(db, { at: '2026-02-10T00:00:00Z', knowledge_at: '2026-01-20T00:00:00Z' });
  assert.equal(cv.anchor.snapshot_id, 'C-OPEN');
  assert.ok(cv.anchor.candidates.some((c) => c.snapshot_id === 'C-MID' && c.checks.some((k) => k.code === 'received_after_knowledge')));
});

test('a ledger row that arrived after the cutoff is excluded, not silently applied', () => {
  const { db } = dataset();
  // E-4's batch was accepted 2026-02-10, so a cut knowing only up to 2026-02-01
  // cannot have it even though it is effective 2026-02-05 (before the cut).
  const cv = cut(db, { at: '2026-02-05T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.equal(cv.status, 'knowledge_limited');
  assert.equal(cv.qty_base, 98);
  assert.ok(cv.excluded.some((e) => e.event_id === 'E-4' && e.code === 'received_after_knowledge'));
});

test('without an eligible count the cut has no quantity and says so', () => {
  const { db } = dataset();
  const cv = cut(db, { at: '2025-12-31T00:00:00Z', knowledge_at: '2026-03-01T00:00:00Z' });
  assert.equal(cv.status, 'no_anchor');
  assert.equal(cv.qty_base, null);
  assert.equal(cv.confidence, 0);
});

test('a late movement is applied but disclosed with its lag', () => {
  const { db } = buildDb({
    batches: [
      { id: 's', stream: 'snapshot', received_at: '2026-01-01T01:00:00Z', rows: [{ snapshot_id: 'C-1', effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }] },
      {
        id: 'l', stream: 'ledger', received_at: '2026-01-10T00:00:00Z',
        rows: [{ event_id: 'LATE', kind: 'issue', qty: 10, unit: 'EA', effective_at: '2026-01-02T00:00:00Z', recorded_at: '2026-01-09T00:00:00Z' }],
      },
    ],
  });
  const cv = cut(db, { at: '2026-01-11T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.equal(cv.qty_base, 90);
  assert.equal(cv.deltas[0].late, true);
  assert.equal(cv.deltas[0].late_seconds, 7 * 86400);
  assert.ok(cv.confidence_breakdown.some((b) => /late-arriving/.test(b.label)));
  assert.ok(cv.confidence < 1);
});

test('a reversal after the cut leaves the original applied; a reversal before it nets the pair to zero', () => {
  const rows = (revAt) => [
    { id: 's', stream: 'snapshot', received_at: '2026-01-01T01:00:00Z', rows: [{ snapshot_id: 'C-1', effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }] },
    {
      id: 'l', stream: 'ledger', received_at: '2026-01-20T00:00:00Z',
      rows: [
        { event_id: 'ISSUE', kind: 'issue', qty: 20, unit: 'EA', effective_at: '2026-01-05T00:00:00Z', recorded_at: '2026-01-05T00:00:00Z' },
        { event_id: 'REV', kind: 'reversal', qty: 20, unit: 'EA', effective_at: revAt, recorded_at: revAt, reverses_event_id: 'ISSUE' },
      ],
    },
  ];
  const before = cut(buildDb({ batches: rows('2026-01-10T00:00:00Z') }).db, { at: '2026-01-07T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.equal(before.qty_base, 80);
  assert.deepEqual(before.deltas.map((d) => d.event_id), ['ISSUE']);

  const after = cut(buildDb({ batches: rows('2026-01-10T00:00:00Z') }).db, { at: '2026-01-12T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.equal(after.qty_base, 100);
  assert.equal(after.deltas.length, 0);
  assert.deepEqual(after.excluded.map((e) => e.code).sort(), ['cancelled_by_reversal', 'cancels_movement_before_cut']);
});

test('a declared coverage hole degrades the cut and is listed as unverified', () => {
  const { db } = buildDb({
    batches: [
      { id: 's', stream: 'snapshot', received_at: '2026-01-01T01:00:00Z', rows: [{ snapshot_id: 'C-1', effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }] },
      {
        id: 'l', stream: 'ledger', received_at: '2026-01-20T00:00:00Z',
        declared_coverage: [{ sku: 'SKU-A', location: 'WH-1', start_at: '2026-01-03T00:00:00Z', end_at: '2026-01-06T00:00:00Z', reason: 'connector_outage' }],
        rows: [{ event_id: 'E-1', kind: 'issue', qty: 5, unit: 'EA', effective_at: '2026-01-04T00:00:00Z' }],
      },
    ],
  });
  const cv = cut(db, { at: '2026-01-10T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.equal(cv.qty_base, 95);
  assert.equal(cv.status, 'degraded');
  assert.equal(cv.unverified.length, 1);
  assert.equal(cv.unverified[0].reason, 'connector_outage');
  assert.ok(cv.confidence_breakdown.some((b) => /unverified interval/.test(b.label)));
  assert.ok(cv.warnings.some((w) => w.code === 'MOVEMENTS_INSIDE_DECLARED_GAP'));
});

test('an undeclared absence of coverage is itself disclosed', () => {
  const { db } = dataset();
  const cv = cut(db, { at: '2026-01-03T00:00:00Z', knowledge_at: '2026-03-01T00:00:00Z' });
  assert.ok(cv.warnings.some((w) => w.code === 'NO_COVERAGE_DECLARATION'));
});

test('in-transit notices never contribute to on-hand, and a received one reconciles to its receipt', () => {
  const { db } = buildDb({
    batches: [
      { id: 's', stream: 'snapshot', received_at: '2026-01-01T01:00:00Z', rows: [{ snapshot_id: 'C-1', effective_at: '2026-01-01T00:00:00Z', qty: 100, unit: 'EA' }] },
      { id: 'l', stream: 'ledger', received_at: '2026-01-12T00:00:00Z', rows: [{ event_id: 'RECV', kind: 'receipt', qty: 40, unit: 'EA', effective_at: '2026-01-11T00:00:00Z' }] },
      {
        id: 't1', stream: 'transit', received_at: '2026-01-02T00:00:00Z',
        rows: [{ notice_id: 'T-1', revision: 1, qty: 40, unit: 'EA', status: 'in_transit', eta_at: '2026-01-11T00:00:00Z' }],
      },
      {
        id: 't2', stream: 'transit', received_at: '2026-01-12T01:00:00Z',
        rows: [{ notice_id: 'T-1', revision: 2, qty: 40, unit: 'EA', status: 'received', received_event_id: 'RECV', recorded_at: '2026-01-12T00:00:00Z' }],
      },
    ],
  });
  // Knowing only what had arrived by 2026-01-05, the notice is still open.
  const early = cut(db, { at: '2026-01-05T00:00:00Z', knowledge_at: '2026-01-05T00:00:00Z' });
  assert.equal(early.qty_base, 100);
  assert.equal(early.transit.open.length, 1);
  assert.equal(early.transit.open[0].notice_id, 'T-1');

  const late = cut(db, { at: '2026-01-15T00:00:00Z', knowledge_at: '2026-02-01T00:00:00Z' });
  assert.equal(late.qty_base, 140); // 100 + receipt 40, NOT +40 again for the notice
  assert.equal(late.transit.open.length, 0);
  assert.ok(late.transit.closed.some((t) => t.notice_id === 'T-1' && t.received_event_id === 'RECV'));
});

test('replaying the same instant twice produces the same cutview id', () => {
  const { db } = dataset();
  const a = cut(db, { at: '2026-02-05T00:00:00Z', knowledge_at: '2026-03-01T00:00:00Z' });
  const b = cut(db, { at: '2026-02-05T00:00:00Z', knowledge_at: '2026-03-01T00:00:00Z' });
  assert.equal(a.cutview_id, b.cutview_id);
  assert.equal(a.digest, b.digest);
});
