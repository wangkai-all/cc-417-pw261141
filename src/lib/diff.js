/**
 * Cutview diff. Two cuts of the same key explain their difference exactly:
 *   quantity difference = movement effects + anchor revisions + re-anchoring.
 * Nothing here re-sums a period blindly; each contribution names its source.
 */
import { digestOf, fmtQty, nowIso, round6, secondsBetween, sum } from './util.js';
import { bucketByPeriod } from './periods.js';

function indexById(list) {
  return new Map(list.map((e) => [e.event_id, e]));
}

function movementContribution(a, b) {
  const left = indexById(a.deltas);
  const right = indexById(b.deltas);
  // Rows a cut deliberately excluded still explain a difference: if B applies a
  // movement A had to leave out because its batch arrived after A's knowledge
  // cutoff, the change is a change in *what was knowable*, not a new movement.
  const leftExcluded = indexById(a.excluded ?? []);
  const rightExcluded = indexById(b.excluded ?? []);
  const out = [];
  for (const [id, e] of right) {
    const prior = left.get(id);
    if (!prior) {
      const withheld = leftExcluded.get(id);
      if (withheld?.code === 'received_after_knowledge') {
        out.push({ event_id: id, kind: 'newly_knowable', delta_base: e.delta_base, effective_at: e.effective_at, detail: `excluded from A because its batch was not accepted until after A's knowledge cutoff (${withheld.message}); it is counted in B` });
      } else {
        out.push({ event_id: id, kind: 'applied_in_b', delta_base: e.delta_base, effective_at: e.effective_at, detail: 'applied in B but not in A' });
      }
    } else if (prior.delta_base !== e.delta_base) {
      out.push({ event_id: id, kind: 'revalued', delta_base: round6(e.delta_base - prior.delta_base), effective_at: e.effective_at, before: prior.delta_base, after: e.delta_base, detail: 'same movement converted differently (unit rule or correction), so only the revaluation is attributed here' });
    }
  }
  for (const [id, e] of left) {
    if (!right.has(id)) {
      const withheld = rightExcluded.get(id);
      if (withheld?.code === 'received_after_knowledge') {
        out.push({ event_id: id, kind: 'no_longer_knowable', delta_base: -e.delta_base, effective_at: e.effective_at, detail: `counted in A but excluded from B: its batch was accepted after B's (earlier) knowledge cutoff (${withheld.message})` });
      } else {
        out.push({ event_id: id, kind: 'removed_in_b', delta_base: -e.delta_base, effective_at: e.effective_at, detail: 'applied in A but not in B' });
      }
    }
  }
  for (const e of out) {
    if (e.kind !== 'revalued') continue;
    const prior = left.get(e.event_id);
    const now = right.get(e.event_id);
    if (prior.unit_version !== now.unit_version) e.detail = `unit rule changed v${prior.unit_version} → v${now.unit_version}; revaluation attributed in full`;
  }
  return out;
}

function anchorContribution(a, b) {
  if (!a.anchor?.snapshot_id && !b.anchor?.snapshot_id) return { kind: 'none', delta_base: 0, detail: 'neither cut is anchored' };
  const key = (c) => (c.anchor?.snapshot_id ? `${c.anchor.snapshot_id}@r${c.anchor.revision}` : null);
  if (key(a) === key(b)) {
    const priorRev = a.anchor.revision;
    const nowRev = b.anchor.revision;
    if (priorRev !== nowRev) {
      return { kind: 'anchor_revised', from: key(a), to: key(b), delta_base: round6((b.anchor.qty_base ?? 0) - (a.anchor.qty_base ?? 0)), detail: `same count, revision ${priorRev} → ${nowRev}` };
    }
    return { kind: 'same', from: key(a), delta_base: 0, detail: 'same anchor and revision' };
  }
  return {
    kind: 'reanchored', from: key(a), to: key(b),
    delta_base: round6((b.anchor?.qty_base ?? 0) - (a.anchor?.qty_base ?? 0)),
    detail: 'a later (or earlier) physical count becomes the baseline; its whole quantity replaces the prior anchor rather than being added',
  };
}

export function diffCutviews(a, b, { periods = [] } = {}) {
  if (!a || !b) throw new Error('two cutviews are required');
  if (a.sku !== b.sku || a.location !== b.location) throw new Error('cutviews are for different sku/location');
  if (a.qty_base == null || b.qty_base == null) {
    throw Object.assign(new Error('one of these cuts has no physical anchor, so it has no on-hand quantity to compare; rebuild both from a count first'), { code: 'UNANCHORED_CUTVIEW' });
  }
  if (a.unit_base !== b.unit_base) {
    throw Object.assign(new Error(`cuts are expressed in different base units (${a.unit_base} vs ${b.unit_base}); rebuild them under one unit rule set`), { code: 'UNIT_MISMATCH' });
  }
  const [first, second] = a.at_iso <= b.at_iso ? [a, b] : [b, a];
  const orientation = first === a ? 'a_to_b' : 'b_to_a';
  const qtyDelta = round6(second.qty_base - first.qty_base);
  const anchor = anchorContribution(first, second);
  const movements = movementContribution(first, second);
  const movementTotal = sum(movements.map((e) => e.delta_base));
  const anchorDelta = anchor.delta_base;
  const unattributed = round6(qtyDelta - movementTotal - anchorDelta);
  const gapA = first.unverified ?? [];
  const gapB = second.unverified ?? [];
  const gapSignature = (g) => `${g.start_at}/${g.end_at}/${g.reason}`;
  const newGaps = gapB.filter((g) => !gapA.some((h) => gapSignature(h) === gapSignature(g)));
  const resolvedGaps = gapA.filter((g) => !gapB.some((h) => gapSignature(h) === gapSignature(g)));
  const periodRows = periods.length ? bucketByPeriod(movements.map((m) => ({ effective_at: m.effective_at, delta_base: m.delta_base })), periods) : [];
  const transitA = new Map((first.transit?.open ?? []).map((t) => [t.notice_id, t]));
  const transitB = new Map((second.transit?.open ?? []).map((t) => [t.notice_id, t]));
  const transitChanges = [];
  for (const [id, t] of transitB) {
    const prior = transitA.get(id);
    if (!prior) transitChanges.push({ notice_id: id, change: 'opened', qty_base: t.qty_base, status: t.status });
    else if (prior.revision !== t.revision || prior.status !== t.status || prior.eta_at !== t.eta_at) {
      transitChanges.push({ notice_id: id, change: 'revised', from: { revision: prior.revision, status: prior.status, eta_at: prior.eta_at }, to: { revision: t.revision, status: t.status, eta_at: t.eta_at }, qty_base: t.qty_base });
    }
  }
  for (const [id, t] of transitA) if (!transitB.has(id)) transitChanges.push({ notice_id: id, change: 'closed', qty_base: t.qty_base, status: t.status });
  const qtyTolerance = 1e-9;
  const reconciles = Math.abs(unattributed) <= qtyTolerance && secondsBetween(first.at_iso, second.at_iso) >= 0;
  const report = {
    orientation,
    key: { sku: a.sku, location: a.location },
    a: { cutview_id: a.cutview_id, at_iso: a.at_iso, knowledge_at: a.knowledge_at, qty_base: a.qty_base, status: a.status, anchor: a.anchor?.snapshot_id ? `${a.anchor.snapshot_id}@r${a.anchor.revision}` : null, digest: a.digest },
    b: { cutview_id: b.cutview_id, at_iso: b.at_iso, knowledge_at: b.knowledge_at, qty_base: b.qty_base, status: b.status, anchor: b.anchor?.snapshot_id ? `${b.anchor.snapshot_id}@r${b.anchor.revision}` : null, digest: b.digest },
    qty_delta_base: qtyDelta,
    unit_base: a.unit_base,
    explanation: {
      anchor_change: anchor,
      movement_effects: movements,
      movement_total_base: movementTotal,
      anchor_delta_base: anchorDelta,
      unattributed_base: unattributed,
      reconciles,
      // Spelled as an addition so the reader can check it, with each term carrying
      // its own sign ("+ −125", never "− −125").
      identity: `${fmtQty(first.qty_base)} ${movementTotal < 0 ? '−' : '+'} ${fmtQty(Math.abs(movementTotal))} (movements) ${anchorDelta < 0 ? '−' : '+'} ${fmtQty(Math.abs(anchorDelta))} (anchor) = ${fmtQty(second.qty_base)}`,
    },
    periods: periodRows,
    coverage: { newly_unverified: newGaps, no_longer_unverified: resolvedGaps, a_gaps: gapA.length, b_gaps: gapB.length },
    transit: { changes: transitChanges, counted_in_onhand: false, note: 'in-transit notices never enter either on-hand quantity; this section explains only their status movement' },
    policy: { a: a.policy_version ?? null, b: b.policy_version ?? null, same: (a.policy_version ?? null) === (b.policy_version ?? null) },
    context: {
      note: first.knowledge_at !== second.knowledge_at
        ? 'the two cuts used different knowledge cutoffs; differences may reflect what was knowable, not what happened'
        : 'both cuts used the same knowledge cutoff',
      a_confidence: a.confidence,
      b_confidence: b.confidence,
    },
  };
  report.digest = digestOf(report);
  report.diff_id = `df-${digestOf({ a: a.cutview_id, b: b.cutview_id, digest: report.digest }).slice(0, 20)}`;
  return report;
}

export function persistDiff(db, report) {
  db.prepare('INSERT OR REPLACE INTO diffs(diff_id,a_cutview_id,b_cutview_id,created_at,report,digest) VALUES(?,?,?,?,?,?)').run(
    report.diff_id, report.a.cutview_id, report.b.cutview_id, nowIso(), JSON.stringify(report), report.digest,
  );
  return report;
}
