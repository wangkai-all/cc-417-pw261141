/**
 * Cutview reconstruction. Three streams stay independent:
 *
 *   snapshot  → anchor: a physical claim at one instant. Never summed with movements.
 *   ledger    → replay: movements strictly after the anchor, up to the cut.
 *   transit   → overlay: never part of on-hand, disclosed separately with its own
 *               status, and reconciled against the receipts that close it.
 *
 * Everything the engine read, applied, skipped, or could not verify is recorded.
 * A cutview is therefore reproducible and explainable, not just a number.
 */
import {
  digestOf, iso, nowIso, round6, secondsBetween, sum, uniq,
} from './util.js';
import { POLICY, policyDigestSource } from './policy.js';
import { bucketByPeriod, periodFor } from './periods.js';

/**
 * Intersect declared gaps with [start, end], merging overlaps so one hole is
 * reported once. An empty list means "no hole was declared", which is a claim by
 * the connector, not proof of completeness.
 */
export function declaredGapsWithin(start, end, gaps) {
  const clipped = gaps
    .filter((g) => g.start_at < end && g.end_at > start)
    .map((g) => ({ ...g, start_at: g.start_at > start ? g.start_at : start, end_at: g.end_at < end ? g.end_at : end }))
    .sort((a, b) => (a.start_at === b.start_at ? a.end_at.localeCompare(b.end_at) : a.start_at.localeCompare(b.start_at)));
  const merged = [];
  for (const g of clipped) {
    const last = merged[merged.length - 1];
    if (last && g.start_at <= last.end_at) {
      if (g.end_at > last.end_at) last.end_at = g.end_at;
      if (!last.reasons.includes(g.reason)) last.reasons.push(g.reason);
      if (!last.sources.some((x) => x.batch_id === g.batch_id && x.start_at === g.start_at)) {
        last.sources.push({ batch_id: g.batch_id, start_at: g.start_at, end_at: g.end_at, reason: g.reason });
      }
    } else {
      merged.push({
        start_at: g.start_at, end_at: g.end_at, reason: g.reason,
        reasons: [g.reason], detail: g.detail ?? null, sources: [{ batch_id: g.batch_id, start_at: g.start_at, end_at: g.end_at, reason: g.reason }],
      });
    }
  }
  return merged;
}

export const CUT_STATUS = Object.freeze({
  VERIFIED: 'verified',
  DEGRADED: 'degraded',
  UNVERIFIED: 'unverified',
  NO_ANCHOR: 'no_anchor',
  KNOWLEDGE_LIMITED: 'knowledge_limited',
});

export class CutviewError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CutviewError';
    this.code = 'CUTVIEW_ERROR';
    this.detail = detail;
  }
}

/**
 * Candidate snapshots for a key, with the exact reason each one was or was not
 * eligible. This is what makes the anchor choice defensible instead of implicit.
 */
export function anchorCandidates(db, { sku, location, at, knowledge_at }) {
  const rows = db
    .prepare(
      `SELECT s.*, b.accepted_at AS batch_accepted_at
         FROM snapshots s JOIN batches b ON b.batch_id = s.batch_id
        WHERE s.sku = ? AND s.location = ?
        ORDER BY s.effective_at DESC, s.snapshot_id, s.revision DESC`,
    )
    .all(sku, location);

  // Current revision of each snapshot is the highest revision known at knowledge time.
  // A revision that arrived later must not rewrite what was believed earlier.
  const knownAt = new Map();
  for (const r of rows) {
    if (r.batch_accepted_at > knowledge_at) continue;
    const prev = knownAt.get(r.snapshot_id);
    if (!prev || r.revision > prev.revision) knownAt.set(r.snapshot_id, r);
  }

  const candidates = rows.map((r) => {
    const checks = [];
    if (r.effective_at > at) checks.push({ ok: false, code: 'after_cut', message: `count effective ${r.effective_at} is after the cut ${at}` });
    if (r.counted_at > knowledge_at) checks.push({ ok: false, code: 'counted_after_knowledge', message: `counted ${r.counted_at}, after the knowledge cutoff ${knowledge_at}` });
    if (r.batch_accepted_at > knowledge_at) checks.push({ ok: false, code: 'received_after_knowledge', message: `batch accepted ${r.batch_accepted_at}, after the knowledge cutoff` });
    const current = knownAt.get(r.snapshot_id);
    if (!current) {
      checks.push({ ok: false, code: 'revision_not_known', message: 'this revision was not known at the knowledge cutoff' });
    } else if (current.revision > r.revision) {
      checks.push({ ok: false, code: 'superseded_revision', message: `revision ${current.revision} was current at the knowledge cutoff` });
    }
    return {
      snapshot_id: r.snapshot_id,
      revision: r.revision,
      effective_at: r.effective_at,
      counted_at: r.counted_at,
      qty_base: r.qty_base,
      unit_base: r.unit_base,
      unit_version: r.unit_version,
      batch_id: r.batch_id,
      batch_accepted_at: r.batch_accepted_at,
      eligible: checks.every((c) => c.ok),
      checks,
    };
  });

  const eligible = candidates
    .filter((c) => c.eligible)
    .sort((a, b) => {
      if (a.effective_at !== b.effective_at) return a.effective_at < b.effective_at ? 1 : -1;
      if (a.counted_at !== b.counted_at) return a.counted_at < b.counted_at ? 1 : -1;
      return b.revision - a.revision;
    });
  return { anchor: eligible[0] ?? null, eligible, candidates };
}

function allRevisions(db, sku, location) {
  return db
    .prepare('SELECT snapshot_id, revision, effective_at, qty_base, unit_base, superseded_by_revision FROM snapshots WHERE sku = ? AND location = ? ORDER BY effective_at, snapshot_id, revision')
    .all(sku, location);
}

function ledgerFor(db, sku, location) {
  return db
    .prepare(
      `SELECT l.*, b.accepted_at AS batch_accepted_at
         FROM ledger_entries l JOIN batches b ON b.batch_id = l.batch_id
        WHERE l.sku = ? AND l.location = ?
        ORDER BY l.effective_at, l.id`,
    )
    .all(sku, location);
}

function coverageFor(db, sku, location) {
  return db
    .prepare('SELECT stream, ack_id, start_at, end_at, reason, detail, batch_id FROM coverage WHERE sku = ? AND location = ? ORDER BY start_at, end_at')
    .all(sku, location);
}

function transitFor(db, sku, location, knowledge_at) {
  const rows = db
    .prepare(
      `SELECT t.*, b.accepted_at AS batch_accepted_at
         FROM transit_notices t JOIN batches b ON b.batch_id = t.batch_id
        WHERE t.sku = ? AND t.location = ?
        ORDER BY t.notice_id, t.revision`,
    )
    .all(sku, location);
  // Current notice revision as known at the cutoff.
  const current = new Map();
  for (const r of rows) {
    if (r.batch_accepted_at > knowledge_at) continue;
    const prev = current.get(r.notice_id);
    if (!prev || r.revision > prev.revision) current.set(r.notice_id, r);
  }
  return {
    open: [...current.values()]
      .filter((r) => r.status === 'in_transit' || r.status === 'delayed')
      .map((r) => ({
        notice_id: r.notice_id,
        revision: r.revision,
        status: r.status,
        qty_base: r.qty_base,
        unit_base: r.unit_base,
        qty_noticed: r.qty_noticed,
        unit_noticed: r.unit_noticed,
        unit_version: r.unit_version,
        dispatched_at: r.dispatched_at,
        eta_at: r.eta_at,
        note: r.note,
        batch_id: r.batch_id,
      })),
    all: [...current.values()].map((r) => ({
      notice_id: r.notice_id,
      revision: r.revision,
      status: r.status,
      received_event_id: r.received_event_id,
      qty_base: r.qty_base,
      unit_base: r.unit_base,
      eta_at: r.eta_at,
      batch_id: r.batch_id,
    })),
    rows,
  };
}

/**
 * Plan the deterministic step list. Steps are tiny so a crash leaves a meaningful
 * checkpoint and a resume does not redo completed work.
 */
export function planCutview(db, { sku, location, at, knowledge_at, mode = 'replay', baseline_cutview_id = null }) {
  at = iso(at, 'at');
  knowledge_at = iso(knowledge_at, 'knowledge_at');
  if (knowledge_at > nowIso()) throw new CutviewError('knowledge_at cannot be in the future', { knowledge_at });
  const skuRow = db.prepare('SELECT sku FROM skus WHERE sku = ?').get(sku);
  if (!skuRow) throw new CutviewError(`unknown sku ${sku}`, { sku });
  const locRow = db.prepare('SELECT location FROM locations WHERE location = ?').get(location);
  if (!locRow) throw new CutviewError(`unknown location ${location}`, { location });
  const units = db.prepare('SELECT * FROM unit_rules ORDER BY unit, version').all();
  if (units.length === 0) throw new CutviewError('reference data is not pinned; ingest a manifest first');
  const periods = db.prepare('SELECT * FROM periods ORDER BY start_at').all();
  const manifest = db.prepare("SELECT value FROM meta WHERE key = 'manifest'").get();

  const steps = [{ kind: 'context', payload: { sku, location, at, knowledge_at, mode } }];
  if (mode === 'incremental') {
    if (!baseline_cutview_id) throw new CutviewError('incremental mode requires baseline_cutview_id');
    const base = db.prepare('SELECT * FROM cutviews WHERE cutview_id = ?').get(baseline_cutview_id);
    if (!base) throw new CutviewError(`unknown baseline cutview ${baseline_cutview_id}`, { baseline_cutview_id });
    if (base.sku !== sku || base.location !== location) throw new CutviewError('baseline cutview is for a different key');
    // Fail at plan time, not halfway through a run: a baseline after the requested
    // cut, or one computed under a later knowledge cutoff, cannot be extended.
    if (base.at_iso > at) throw new CutviewError('baseline cutview is after the requested cut', { baseline_cutview_id, baseline_at: base.at_iso, at });
    if (base.knowledge_at > knowledge_at) throw new CutviewError('baseline cutview used a later knowledge cutoff', { baseline_cutview_id, baseline_knowledge_at: base.knowledge_at, knowledge_at });
    steps.push({ kind: 'baseline', payload: { baseline_cutview_id, at: base.at_iso, knowledge_at: base.knowledge_at } });
  } else {
    steps.push({ kind: 'select_anchor', payload: { sku, location, at, knowledge_at } });
  }
  steps.push({ kind: 'load_coverage', payload: { sku, location } });
  steps.push({ kind: 'collect_ledger', payload: { sku, location } });
  steps.push({ kind: 'collect_transit', payload: { sku, location, knowledge_at } });
  steps.push({ kind: 'replay', payload: { policy: POLICY.version } });
  steps.push({ kind: 'compute_unverified', payload: { policy: POLICY.version } });
  steps.push({ kind: 'assemble', payload: { policy: POLICY.version } });
  steps.push({ kind: 'finalize', payload: { policy: POLICY.version } });
  return {
    sku,
    location,
    at,
    knowledge_at,
    mode,
    baseline_cutview_id,
    policy: POLICY,
    units,
    periods,
    manifest: manifest ? JSON.parse(manifest.value) : null,
    steps,
  };
}

/**
 * A reversal that is itself after the cut cancels nothing yet: the original still
 * happened from the cut's point of view. Symmetrically, a movement whose reversal
 * lands at or before the cut contributes net zero even if the original is inside
 * the replay window. Non-cancelled movements are replayed normally.
 */
function replayOnce(ctx, anchor) {
  const { rows, at, knowledge_at } = ctx;
  const applied = [];
  const excluded = [];
  const byId = new Map(rows.map((r) => [r.event_id, r]));
  const reversalsByTarget = new Map();
  for (const r of rows) {
    if (!r.reversed_event_id) continue;
    if (r.batch_accepted_at > knowledge_at) continue;
    const list = reversalsByTarget.get(r.reversed_event_id) ?? [];
    list.push(r);
    reversalsByTarget.set(r.reversed_event_id, list);
  }
  // Net-zero pairs: original and a reversal both effective before/at the cut.
  const netZero = new Map();
  for (const [targetId, revs] of reversalsByTarget) {
    const original = byId.get(targetId);
    if (!original) continue;
    const effectiveRevs = revs.filter((r) => r.effective_at <= at).sort((a, b) => a.effective_at.localeCompare(b.effective_at));
    if (!effectiveRevs.length) continue;
    const firstRev = effectiveRevs[0];
    if (original.effective_at <= at && firstRev.effective_at > original.effective_at) {
      netZero.set(targetId, { reversal: firstRev, both_before_cut: true });
    }
  }
  for (const r of rows) {
    const base = {
      event_id: r.event_id,
      effective_at: r.effective_at,
      recorded_at: r.recorded_at,
      batch_id: r.batch_id,
      kind: r.kind,
    };
    if (r.batch_accepted_at > knowledge_at) {
      excluded.push({ ...base, code: 'received_after_knowledge', delta_base: r.delta_base, message: `batch accepted ${r.batch_accepted_at}, after the knowledge cutoff` });
      continue;
    }
    if (r.effective_at > at) {
      excluded.push({ ...base, code: 'after_cut', delta_base: r.delta_base, message: `effective ${r.effective_at} is after the cut` });
      continue;
    }
    // The *original* nets to zero when its own id is in the net-zero map, and the
    // reversal nets to zero when the movement it reverses is. Looking these up by
    // the wrong key is what silently double counts a reversed receipt.
    const pair = netZero.get(r.event_id) ?? null;
    if (pair) {
      excluded.push({
        ...base,
        code: 'cancelled_by_reversal',
        delta_base: r.delta_base,
        message: `movement was reversed by ${pair.reversal.event_id}; net effect is zero up to the cut, so neither row is replayed`,
      });
      continue;
    }
    if (r.kind === 'reversal' && netZero.has(r.reversed_event_id)) {
      excluded.push({
        ...base,
        code: 'cancels_movement_before_cut',
        delta_base: r.delta_base,
        message: `cancels ${r.reversed_event_id}; the pair nets to zero up to the cut`,
      });
      continue;
    }
    if (r.effective_at <= anchor.effective_at) {
      const code = r.kind === 'reversal' ? 'reversal_before_anchor' : 'at_or_before_anchor';
      excluded.push({
        ...base,
        code,
        delta_base: r.delta_base,
        message: r.kind === 'reversal'
          ? 'reversal predates the count; the physical count already reflects it, so adding it would double count'
          : 'movement at or before the count instant is already reflected in the physical count',
      });
      continue;
    }
    const lateSeconds = Math.max(0, secondsBetween(r.effective_at, r.recorded_at));
    applied.push({
      ...base,
      delta_base: r.delta_base,
      unit_base: r.unit_base,
      qty_input: r.qty_input,
      unit_input: r.unit_input,
      unit_version: r.unit_version,
      factor_to_base: r.factor_to_base,
      reason: r.reason,
      operator: r.operator,
      reversals: r.reversed_event_id ?? null,
      correction_of: r.correction_of ?? null,
      late_seconds: lateSeconds,
      late: lateSeconds > POLICY.lateAfterSeconds,
      declared_gap: false,
    });
  }
  return { applied, excluded };
}

function attachGaps(applied, gaps) {
  return applied.map((e) => {
    const hit = gaps.find((g) => g.start_at <= e.effective_at && e.effective_at < g.end_at);
    return hit ? { ...e, declared_gap: true, gap: { start_at: hit.start_at, end_at: hit.end_at, reason: hit.reason } } : e;
  });
}

/**
 * Execute a plan step by step, persisting a checkpoint after each. `crashAfter`
 * simulates the process dying: an exception is raised after the checkpoint writes,
 * so the run is left 'aborted' with resumable state. Persisting the cutview happens
 * only in `finalize` inside one transaction with the completion marker.
 */
export function executePlan(db, plan, { crashAfter = null, onStep = null } = {}) {
  const runId = plan.run_id; // always the *current* run, including a resume
  let state = {
    context: plan.steps[0].payload,
    anchor: null,
    anchorCandidates: null,
    revisions: null,
    coverage: null,
    ledger: null,
    transit: null,
    applied: null,
    excluded: null,
    unverified: [],
    warnings: [],
    status: null,
    qty_base: null,
    unit_base: null,
    confidence: 0,
    confidence_breakdown: [],
    baseline: null,
    units: plan.units,
    periods: plan.periods,
    manifest: plan.manifest,
    policy: plan.policy,
  };

  const runStep = (step, index) => {
    switch (step.kind) {
      case 'context':
        break;
      case 'baseline': {
        const base = db.prepare('SELECT * FROM cutviews WHERE cutview_id = ?').get(step.payload.baseline_cutview_id);
        if (base.at_iso > plan.at) throw new CutviewError('baseline cutview is after the requested cut');
        if (base.knowledge_at > plan.knowledge_at) throw new CutviewError('baseline cutview used a later knowledge cutoff');
        const late = db
          .prepare(
            `SELECT l.event_id FROM ledger_entries l JOIN batches b ON b.batch_id = l.batch_id
              WHERE l.sku = ? AND l.location = ? AND b.accepted_at > ? AND l.effective_at <= ? LIMIT 1`,
          )
          .get(plan.sku, plan.location, base.knowledge_at, base.at_iso);
        const newerCount = db
          .prepare(
            `SELECT s.snapshot_id, s.revision, b.accepted_at FROM snapshots s JOIN batches b ON b.batch_id = s.batch_id
              WHERE s.sku = ? AND s.location = ? AND b.accepted_at > ? AND s.effective_at > ? AND s.effective_at <= ?
              ORDER BY s.effective_at LIMIT 1`,
          )
          .get(plan.sku, plan.location, base.knowledge_at, base.at_iso, plan.at);
        if (late || newerCount) {
          state.baseline = {
            baseline_cutview_id: base.cutview_id,
            usable: false,
            reason: late ? 'late_arrival_before_baseline_cut' : 'new_anchor_after_baseline_cut',
            detail: late
              ? `movement ${late.event_id} effective before the baseline cut arrived after its knowledge cutoff; a pure delta would be wrong`
              : `count ${newerCount.snapshot_id}@r${newerCount.revision} became known after the baseline cutoff and re-anchors the cut; a pure delta would be wrong`,
          };
          state.warnings.push({ code: 'INCREMENTAL_INVALIDATED', message: state.baseline.detail });
          // Forced replay means *full* replay: re-select the anchor from the counts
          // that were eligible at this cut's knowledge cutoff. Keeping the baseline's
          // anchor would miss exactly the new count that invalidated it.
          const sel = anchorCandidates(db, plan);
          state.anchor = sel.anchor
            ? {
                ...sel.anchor,
                threading: 'replay_forced',
                revisions: allRevisions(db, plan.sku, plan.location)
                  .filter((r) => r.snapshot_id === sel.anchor.snapshot_id)
                  .map((r) => ({ revision: r.revision, qty_base: r.qty_base, unit_base: r.unit_base, superseded_by_revision: r.superseded_by_revision })),
              }
            : null;
          state.replay_mode = 'replay_from_anchor';
          state.anchor_candidates = state.anchor.candidates ?? null;
          state.revisions = allRevisions(db, plan.sku, plan.location);
          state.coverage = coverageFor(db, plan.sku, plan.location);
          state.ledger = ledgerFor(db, plan.sku, plan.location);
          state.transit = transitFor(db, plan.sku, plan.location, plan.knowledge_at);
          break;
        }
        state.baseline = { baseline_cutview_id: base.cutview_id, usable: true, reason: 'no late arrivals before the baseline cut' };
        state.anchor = JSON.parse(base.anchor);
        state.anchor.threading = 'incremental_from_baseline';
        state.anchor_candidates = state.anchor.candidates ?? null;
        state.revisions = allRevisions(db, plan.sku, plan.location);
        state.coverage = coverageFor(db, plan.sku, plan.location);
        state.ledger = ledgerFor(db, plan.sku, plan.location);
        state.transit = transitFor(db, plan.sku, plan.location, plan.knowledge_at);
        state.incremental_base_qty = base.qty_base;
        state.incremental_base_at = base.at_iso;
        state.incremental_delta = 0;
        break;
      }
      case 'select_anchor': {
        const sel = anchorCandidates(db, plan);
        state.anchor = sel.anchor
          ? {
              ...sel.anchor,
              threading: 'replay_from_anchor',
              revisions: allRevisions(db, plan.sku, plan.location)
                .filter((r) => r.snapshot_id === sel.anchor.snapshot_id)
                .map((r) => ({ revision: r.revision, qty_base: r.qty_base, unit_base: r.unit_base, superseded_by_revision: r.superseded_by_revision })),
            }
          : null;
        state.anchor_candidates = sel.candidates;
        state.revisions = allRevisions(db, plan.sku, plan.location);
        break;
      }
      case 'load_coverage':
        state.coverage = coverageFor(db, plan.sku, plan.location);
        break;
      case 'collect_ledger':
        state.ledger = ledgerFor(db, plan.sku, plan.location);
        break;
      case 'collect_transit':
        state.transit = transitFor(db, plan.sku, plan.location, plan.knowledge_at);
        break;
      case 'replay': {
        if (!state.anchor) {
          state.applied = [];
          state.excluded = (state.ledger ?? []).map((r) => ({
            event_id: r.event_id, effective_at: r.effective_at, delta_base: r.delta_base,
            code: 'no_anchor', message: 'no eligible physical count to anchor this cut',
          }));
          state.replay_from = null;
          break;
        }
        const from = state.baseline?.usable ? state.incremental_base_at : state.anchor.effective_at;
        const windowRows = (state.ledger ?? []).filter((r) => r.effective_at > from);
        const res = replayOnce({ rows: windowRows, at: plan.at, knowledge_at: plan.knowledge_at }, { effective_at: from });
        // Rows at/before the baseline are not re-examined; disclose them as inherited.
        const inherited = (state.ledger ?? []).filter((r) => r.effective_at <= from);
        state.applied = res.applied;
        state.excluded = [
          ...res.excluded,
          ...inherited.map((r) => ({
            event_id: r.event_id, effective_at: r.effective_at, delta_base: r.delta_base,
            code: 'inherited_from_baseline',
            message: state.baseline?.usable
              ? `already inside baseline cutview ${state.baseline.baseline_cutview_id}`
              : 'movement at or before the count instant is already reflected in the physical count',
          })),
        ];
        state.replay_from = from;
        state.inherited_count = inherited.length;
        break;
      }
      case 'compute_unverified': {
        const windowStart = state.replay_from ?? (state.anchor ? state.anchor.effective_at : null);
        // A gap is only a gap where the connector *declared* missing coverage. The
        // absence of a declaration is not evidence of completeness either; that is
        // reported separately as a coverage attestation, not as a fabricated hole.
        const gaps = (state.coverage ?? [])
          .filter((c) => c.stream === 'ledger')
          .map((c) => ({ start_at: c.start_at, end_at: c.end_at, reason: c.reason, detail: c.detail ? JSON.parse(c.detail) : null, stream: c.stream, batch_id: c.batch_id }));
        // Coverage rows are *declared holes*, not positive coverage windows.
        const windowGaps = windowStart ? declaredGapsWithin(windowStart, plan.at, gaps) : [];
        // Preserve provenance even when a declared window is clipped by the cut.
        state.unverified = windowGaps.map((g) => ({
          start_at: g.start_at,
          end_at: g.end_at,
          reason: g.reasons.length === 1 ? g.reason : g.reasons.join(' + '),
          detail: g.detail,
          stream: 'ledger',
          declared_by: g.sources,
        }));
        if (windowStart && gaps.length === 0) {
          state.warnings.push({
            code: 'NO_COVERAGE_DECLARATION',
            message: 'no ledger coverage declaration exists for this key; completeness of the replay window is asserted by the connector, not proven',
          });
        }
        if (windowStart) {
          state.applied = attachGaps(state.applied ?? [], gaps);
        }
        // Movements inside a gap are still applied, but they are flagged: the hole
        // means there may be *other* movements we never received.
        const inside = (state.applied ?? []).filter((e) => e.declared_gap);
        if (inside.length) {
          state.warnings.push({
            code: 'MOVEMENTS_INSIDE_DECLARED_GAP',
            message: `${inside.length} applied movement(s) fall inside a declared coverage gap; completeness cannot be proven`,
            event_ids: inside.map((e) => e.event_id),
          });
        }
        break;
      }
      case 'assemble': {
        const unitsList = state.units;
        const unitOf = new Map();
        for (const r of unitsList) if (!unitOf.has(r.unit)) unitOf.set(r.unit, r.dimension);
        const anchor = state.anchor;
        const baseUnit = anchor?.unit_base ?? (state.applied ?? [])[0]?.unit_base ?? unitsList[0]?.unit ?? null;
        if (!baseUnit) throw new CutviewError('no unit information available for this cut');
        state.unit_base = baseUnit;
        const issues = [];
        if (!unitsList.some((u) => u.unit === baseUnit)) issues.push(`base unit ${baseUnit} is not in the pinned rule set`);
        for (const e of state.applied ?? []) {
          if (e.unit_base !== baseUnit) issues.push(`movement ${e.event_id} is in ${e.unit_base}, anchor is in ${baseUnit}`);
        }
        if (issues.length) throw new CutviewError('quantity dimensions do not reconcile', { issues: issues.slice(0, 10), count: issues.length });

        const replaySum = sum((state.applied ?? []).map((e) => e.delta_base));
        const baseQty = state.baseline?.usable ? state.incremental_base_qty : anchor?.qty_base ?? 0;
        state.replay_sum = replaySum;
        state.qty_base = round6(baseQty + replaySum);
        state.unit_base = baseUnit;
        state.delta_base = replaySum;
        state.anchor_qty_base = anchor?.qty_base ?? null;

        // Transit is an overlay. It is never added to on-hand.
        const openNotices = state.transit?.open ?? [];
        const overdue = openNotices.filter((t) => t.eta_at && t.eta_at <= plan.at);
        state.transit_summary = {
          counted_in_onhand: false,
          policy: 'in_transit_notices_are_never_added_to_onhand; the closing ledger receipt is',
          open_count: openNotices.length,
          open_qty_base: sum(openNotices.map((t) => t.qty_base)),
          unit_base: baseUnit,
          overdue_count: overdue.length,
          overdue_qty_base: sum(overdue.map((t) => t.qty_base)),
          open: openNotices,
          overdue: overdue.map((t) => t.notice_id),
          closed: (state.transit?.all ?? []).filter((t) => t.status === 'received'),
          cancelled: (state.transit?.all ?? []).filter((t) => t.status === 'cancelled').map((t) => t.notice_id),
        };
        // Cross-stream check: every received notice must have its receipt inside the
        // ledger, and the quantity must agree. This catches double counting directly.
        const checks = [];
        for (const n of state.transit?.all ?? []) {
          if (n.status !== 'received') continue;
          const ev = db.prepare('SELECT * FROM ledger_entries WHERE event_id = ?').get(n.received_event_id);
          if (!ev) checks.push({ notice_id: n.notice_id, ok: false, code: 'RECEIPT_MISSING', message: `linked receipt ${n.received_event_id} vanished` });
          else if (Math.abs(ev.delta_base - n.qty_base) > 1e-9) {
            checks.push({ notice_id: n.notice_id, ok: false, code: 'RECEIPT_QTY_MISMATCH', message: `notice ${n.qty_base} vs receipt ${ev.delta_base}`, notice_qty_base: n.qty_base, receipt_qty_base: ev.delta_base });
          } else checks.push({ notice_id: n.notice_id, ok: true, receipt_event_id: ev.event_id, qty_base: n.qty_base });
        }
        state.transit_summary.reconciliation = checks;
        const failed = checks.filter((c) => !c.ok);
        if (failed.length) state.warnings.push({ code: 'TRANSIT_RECONCILIATION_FAILED', message: `${failed.length} received notice(s) do not reconcile with the ledger`, checks: failed });

        const lateCount = (state.applied ?? []).filter((e) => e.late).length;
        const unknownReversals = (state.ledger ?? [])
          .filter((r) => r.reversed_event_id && !db.prepare('SELECT 1 FROM ledger_entries WHERE event_id = ?').get(r.reversed_event_id))
          .map((r) => r.event_id);
        const countSkew = anchor ? Math.max(0, secondsBetween(anchor.effective_at, anchor.counted_at)) : 0;
        const staleDays = anchor ? secondsBetween(anchor.effective_at, plan.at) / 86400 : 0;
        const confidenceParts = [{ label: 'base', delta: POLICY.confidence.base }];
        let confidence = POLICY.confidence.base;
        const gapPenalty = Math.max(POLICY.confidence.gapCap, state.unverified.length * POLICY.confidence.perGap);
        if (state.unverified.length) {
          confidence += gapPenalty;
          confidenceParts.push({ label: `${state.unverified.length} unverified interval(s)`, delta: gapPenalty });
        }
        if (lateCount) {
          confidence += POLICY.confidence.lateApplied;
          confidenceParts.push({ label: `${lateCount} late-arriving movement(s) applied`, delta: POLICY.confidence.lateApplied });
        }
        if (anchor && countSkew > POLICY.countSkewAfterSeconds) {
          confidence += POLICY.confidence.countSkew;
          confidenceParts.push({ label: 'count was keyed after its effective instant', delta: POLICY.confidence.countSkew });
        }
        if (anchor && staleDays * 86400 > POLICY.staleAnchorAfterSeconds) {
          confidence += POLICY.confidence.staleAnchor;
          confidenceParts.push({ label: `anchor is ${staleDays.toFixed(1)} days before the cut`, delta: POLICY.confidence.staleAnchor });
        }
        if (plan.knowledge_at < plan.at) {
          confidence += POLICY.confidence.knowledgeLimited;
          confidenceParts.push({ label: 'knowledge cutoff precedes the cut instant', delta: POLICY.confidence.knowledgeLimited });
        }
        if (unknownReversals.length) {
          confidence += POLICY.confidence.unknownReversal;
          confidenceParts.push({ label: `${unknownReversals.length} reversal(s) point at unseen events`, delta: POLICY.confidence.unknownReversal });
        }
        confidence = anchor ? Math.max(POLICY.confidence.floor, Math.min(1, round6(confidence))) : 0;
        state.confidence = confidence;
        state.confidence_breakdown = confidenceParts;
        state.late_count = lateCount;
        state.count_skew_seconds = countSkew;
        state.anchor_age_days = round6(staleDays);
        state.unknown_reversals = unknownReversals;

        let status;
        // Without a physical anchor the replay total is a movement sum, not a stock
        // quantity. Report it as such rather than dressing it up as on-hand.
        if (!anchor) {
          state.delta_base = round6(state.qty_base ?? 0);
          state.qty_base = null;
        }
        // Nothing to anchor from means nothing is verified, whatever the arithmetic.
        if (!anchor) state.confidence = 0;
        if (!anchor) status = CUT_STATUS.NO_ANCHOR;
        else if (state.unverified.length) status = CUT_STATUS.DEGRADED;
        else if (plan.knowledge_at < plan.at) status = CUT_STATUS.KNOWLEDGE_LIMITED;
        else status = CUT_STATUS.VERIFIED;
        state.status = status;

        // Exact deltas by period, for diffing two cuts.
        state.periods_report = bucketByPeriod(
          (state.applied ?? []).map((e) => ({ effective_at: e.effective_at, delta_base: e.delta_base })),
          state.periods,
        );
        state.cut_period = periodFor(state.periods, plan.at)?.label ?? null;

        const unitsInPlay = uniq([
          ...(state.applied ?? []).flatMap((e) => [e.unit_input, e.unit_base]),
          ...(anchor ? [anchor.unit_base] : []),
          ...(state.revisions ?? []).flatMap((r) => [r.unit_base]),
        ]);
        state.units = unitsInPlay.map((u) => {
          const rules = unitsList.filter((r) => r.unit === u).map((r) => ({
            version: r.version, factor_to_base: r.factor_to_base, effective_from: r.effective_from, effective_to: r.effective_to, label: r.label,
          }));
          const usedBy = [
            ...(anchor && anchor.unit_version === rules.find((r) => r.version === anchor.unit_version)?.version ? [`anchor ${anchor.snapshot_id}@r${anchor.revision} (v${anchor.unit_version})`] : []),
          ];
          for (const e of state.applied ?? []) if (e.unit_input === u) usedBy.push(`${e.event_id} (v${e.unit_version})`);
          return { unit: u, dimension: unitOf.get(u), versions: rules, used_as_input_by: uniq(usedBy) };
        });
        break;
      }
      case 'finalize': {
        const payload = {
          sku: plan.sku,
          location: plan.location,
          at_iso: plan.at,
          knowledge_at: plan.knowledge_at,
          status: state.status,
          qty_base: state.qty_base,
          unit_base: state.unit_base,
          confidence: state.confidence,
          confidence_breakdown: state.confidence_breakdown,
          anchor: {
            ...buildAnchorReport(state),
            candidates: state.anchor_candidates,
          },
          unverified: state.unverified,
          warnings: state.warnings,
          transit: state.transit_summary,
          deltas: state.applied,
          excluded: state.excluded,
          lineage: buildLineage(db, plan, state),
          units: state.units,
          periods: state.periods_report,
          cut_period: state.cut_period,
          warnings: state.warnings,
          policy: { ...POLICY, source: policyDigestSource(POLICY) },
          baseline: state.baseline,
          policy_version: POLICY.version,
          replay_from: state.replay_from,
          inherited_count: state.inherited_count ?? 0,
        };
        const digest = digestOf(payload);
        const cutviewId = `cv-${digest.slice(0, 20)}`;
        const requestedAt = nowIso();
        const existing = db.prepare('SELECT * FROM cutviews WHERE cutview_id = ?').get(cutviewId);
        if (!existing) {
          db.prepare(`INSERT INTO cutviews(cutview_id,sku,location,at_iso,knowledge_at,requested_at,status,qty_base,unit_base,confidence,confidence_breakdown,anchor,unverified,warnings,transit,deltas,excluded,lineage,units,periods,digest,policy_version,run_id,rebuilt_from)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            cutviewId, plan.sku, plan.location, plan.at, plan.knowledge_at, requestedAt, state.status,
            state.qty_base, state.unit_base ?? 'unknown', state.confidence, JSON.stringify(state.confidence_breakdown),
            JSON.stringify(payload.anchor), JSON.stringify(payload.unverified), JSON.stringify(payload.warnings), JSON.stringify(payload.transit),
            JSON.stringify(payload.deltas), JSON.stringify(payload.excluded), JSON.stringify(payload.lineage), JSON.stringify(payload.units),
            JSON.stringify(payload.periods), digest, POLICY.version, plan.run_id, plan.baseline_cutview_id ?? null,
          );
        }
        state.cutview_id = cutviewId;
        state.digest = digest;
        state.payload = payload;
        break;
      }
      default:
        throw new CutviewError(`unknown plan step ${step.kind}`);
    }
  };

  const startIndex = plan.resume_from_step ?? 0;
  if (plan.resume_state) state = { ...state, ...plan.resume_state, units: plan.resume_state.units ?? plan.units, periods: plan.periods, manifest: plan.manifest, policy: plan.policy };
  for (let i = startIndex; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    runStep(step, i);
    if (step.kind !== 'finalize') {
      writeCheckpoint(db, runId, i, step.kind, state);
      db.prepare('UPDATE rebuild_runs SET steps_done = ? WHERE run_id = ?').run(i + 1, runId);
    } else {
      db.prepare('UPDATE rebuild_runs SET steps_done = ?, status = ?, finished_at = ? WHERE run_id = ?')
        .run(plan.steps.length, 'completed', nowIso(), plan.run_id);
      if (plan.resumed_from_run) {
        db.prepare("UPDATE rebuild_runs SET status = 'resumed', finished_at = ? WHERE run_id = ? AND status = 'aborted'")
          .run(nowIso(), plan.resumed_from_run);
      }
    }
    onStep?.({ index: i, step, cutview_id: state.cutview_id ?? null });
    if (crashAfter != null && i + 1 >= crashAfter && i + 1 < plan.steps.length) {
      db.prepare("UPDATE rebuild_runs SET status = 'aborted', note = ? WHERE run_id = ?")
        .run(`simulated process exit after step ${i + 1} (${step.kind}); cutview not published`, runId);
      const err = new Error(`SIMULATED_CRASH after step ${i + 1} (${step.kind})`);
      err.code = 'SIMULATED_CRASH';
      throw err;
    }
  }
  return { cutview_id: state.cutview_id, status: state.status, payload: state.payload, state };
}

function buildAnchorReport(state) {
  const a = state.anchor;
  if (!a) {
    return {
      snapshot_id: null,
      reason: 'no eligible physical count at or before the cut',
      candidates: state.anchor_candidates,
      superseded_revisions: (state.revisions ?? []).map((r) => ({ snapshot_id: r.snapshot_id, revision: r.revision, superseded_by_revision: r.superseded_by_revision, qty_base: r.qty_base })),
    };
  }
  return {
    snapshot_id: a.snapshot_id,
    revision: a.revision,
    effective_at: a.effective_at,
    counted_at: a.counted_at,
    qty_base: a.qty_base,
    unit_base: a.unit_base,
    unit_version: a.unit_version,
    batch_id: a.batch_id,
    threading: a.threading,
    replay_from: state.replay_from ?? null,
    replay_policy: 'movements strictly after the count instant; the count already includes anything effective at or before it',
    revisions: a.revisions ?? (state.revisions ?? []).filter((r) => r.snapshot_id === a.snapshot_id),
    superseded_revisions: (state.revisions ?? [])
      .filter((r) => r.snapshot_id === a.snapshot_id && r.superseded_by_revision != null)
      .map((r) => ({ revision: r.revision, qty_base: r.qty_base, superseded_by_revision: r.superseded_by_revision })),
  };
}

function buildLineage(db, plan, state) {
  const lines = [];
  lines.push({
    step: 'source', stream: 'reference',
    detail: `unit rules pinned with ${state.units?.length ?? 0} unit(s) in play; policy ${plan.policy.version}`,
    unit_rules_sha256: digestOf(state.units ?? []),
  });
  if (state.baseline) lines.push({ step: 'baseline', stream: 'cutview', detail: state.baseline });
  if (state.anchor) {
    lines.push({
      step: 'anchor', stream: 'snapshot', ref: `${state.anchor.snapshot_id}@r${state.anchor.revision}`,
      effective_at: state.anchor.effective_at, qty_base: state.anchor.qty_base, unit_base: state.anchor.unit_base,
      detail: state.anchor.threading === 'incremental_from_baseline'
        ? `inherited from baseline cutview at ${state.incremental_base_at}`
        : 'physical count chosen as the replay baseline',
    });
    for (const r of (state.anchor.revisions ?? [])) {
      if (r.revision === state.anchor.revision) continue;
      lines.push({
        step: 'snapshot_revision', stream: 'snapshot', ref: `${state.anchor.snapshot_id}@r${r.revision}`,
        delta_qty: round6(r.qty_base - (state.anchor.qty_base ?? 0)), detail: r.superseded_by_revision != null ? `superseded by revision ${r.superseded_by_revision}; never applied to the ledger` : 'not the current revision at the knowledge cutoff',
      });
    }
  } else {
    lines.push({ step: 'anchor', stream: 'snapshot', detail: 'none eligible' });
  }
  for (const e of state.applied ?? []) {
    lines.push({
      step: 'replay', stream: 'ledger', ref: e.event_id, effective_at: e.effective_at, delta_base: e.delta_base,
      unit_input: e.unit_input, qty_input: e.qty_input, unit_version: e.unit_version,
      batch_id: e.batch_id, recorded_at: e.recorded_at,
      detail: [
        e.reason || 'movement',
        e.reversals ? `reverses ${e.reversals}` : null,
        e.late ? `late by ${(e.late_seconds / 3600).toFixed(1)}h` : null,
        e.declared_gap ? 'inside a declared coverage gap' : null,
      ].filter(Boolean).join('; '),
    });
  }
  for (const e of state.excluded ?? []) {
    lines.push({ step: 'excluded', stream: 'ledger', ref: e.event_id, effective_at: e.effective_at, delta_base: e.delta_base, code: e.code, detail: e.message });
  }
  for (const g of state.unverified ?? []) {
    lines.push({ step: 'unverified', stream: 'ledger', start_at: g.start_at, end_at: g.end_at, detail: `declared ${g.reason}; completeness not provable` });
  }
  for (const t of state.transit_summary?.open ?? []) {
    lines.push({ step: 'transit', stream: 'transit', ref: `${t.notice_id}@r${t.revision}`, qty_base: t.qty_base, status: t.status, detail: `open in-transit; not added to on-hand${t.eta_at && t.eta_at <= plan.at ? ' (past ETA)' : ''}` });
  }
  for (const t of state.transit_summary?.closed ?? []) {
    lines.push({ step: 'transit', stream: 'transit', ref: `${t.notice_id}@r${t.revision}`, qty_base: t.qty_base, status: t.status, detail: `closed by receipt ${t.received_event_id}; counted once, through the ledger` });
  }
  const totalDelta = sum((state.applied ?? []).map((e) => e.delta_base));
  lines.push({
    step: 'total', detail: `anchor ${state.anchor_qty_base ?? 0} + replay ${totalDelta} = ${state.qty_base} ${state.unit_base}`,
    anchor_qty_base: state.anchor_qty_base, replay_delta_base: totalDelta, qty_base: state.qty_base, unit_base: state.unit_base,
  });
  return lines;
}

function writeCheckpoint(db, runId, step, kind, state) {
  const { payload, ...rest } = state;
  // `units` here is the assembled report (per-unit versions and who used them), not
  // the reference table. It must survive a checkpoint: a resume after `assemble`
  // would otherwise recompute nothing and publish a different digest.
  const serializable = { ...rest, periods: undefined, manifest: undefined };
  const text = JSON.stringify(serializable);
  const digest = digestOf(serializable);
  db.prepare('INSERT OR REPLACE INTO rebuild_checkpoints(run_id,step,kind,payload,state_digest,created_at) VALUES(?,?,?,?,?,?)')
    .run(runId, step, kind, text, digest, nowIso());
}

export function openRun(db, plan, { runId, resumedFrom = null, resumeFromStep: stepsDone = 0 }) {
  db.prepare(`INSERT INTO rebuild_runs(run_id,status,mode,sku,location,at_iso,knowledge_at,started_at,resumed_from,steps_total,steps_done,plan_digest)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    runId, 'running', plan.mode, plan.sku, plan.location, plan.at, plan.knowledge_at,
    nowIso(), resumedFrom, plan.steps.length, stepsDone, digestOf(plan.steps),
  );
  return runId;
}

export function loadCutview(db, cutviewId) {
  const row = db.prepare('SELECT * FROM cutviews WHERE cutview_id = ?').get(cutviewId);
  if (!row) return null;
  return hydrateCutview(row);
}

export function hydrateCutview(row) {
  return {
    cutview_id: row.cutview_id,
    sku: row.sku,
    location: row.location,
    at_iso: row.at_iso,
    knowledge_at: row.knowledge_at,
    requested_at: row.requested_at,
    status: row.status,
    qty_base: row.qty_base,
    unanchored_replay_total_base: row.qty_base == null ? JSON.parse(row.deltas).reduce((a, d) => a + d.delta_base, 0) : null,
    unit_base: row.unit_base,
    confidence: row.confidence,
    confidence_breakdown: JSON.parse(row.confidence_breakdown),
    anchor: JSON.parse(row.anchor),
    unverified: JSON.parse(row.unverified),
    transit: JSON.parse(row.transit),
    deltas: JSON.parse(row.deltas),
    excluded: JSON.parse(row.excluded ?? '[]'),
    lineage: JSON.parse(row.lineage),
    warnings: JSON.parse(row.warnings ?? '[]'),
    units: JSON.parse(row.units),
    periods: JSON.parse(row.periods),
    digest: row.digest,
    // Surfaced so a diff can tell whether two cuts were computed under the same
    // accounting policy; a blank policy would make the comparison look safer than
    // it is.
    policy_version: row.policy_version ?? POLICY.version,
    run_id: row.run_id,
    rebuilt_from: row.rebuilt_from,
  };
}
