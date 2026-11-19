/**
 * Accounting period registry. A period closes at its end_at; movements with an
 * effective time inside a closed period are still accepted (late arrival) but are
 * flagged so explainability never silently pretends they were known at close.
 */
import { iso, round6 } from './util.js';

export function normalizePeriods(periods = []) {
  const out = (periods || []).map((p, i) => {
    const label = String(p.label ?? '').trim();
    if (!label) throw new Error(`periods[${i}]: label is required`);
    const start_at = iso(p.start_at, `periods[${i}].start_at`);
    const end_at = iso(p.end_at, `periods[${i}].end_at`);
    if (end_at <= start_at) throw new Error(`periods[${i}]: end_at must be after start_at`);
    return { label, start_at, end_at };
  });
  out.sort((a, b) => a.start_at.localeCompare(b.start_at));
  for (let i = 1; i < out.length; i++) {
    if (out[i].start_at < out[i - 1].end_at) throw new Error(`periods overlap: ${out[i - 1].label} and ${out[i].label}`);
  }
  return out;
}

export function periodFor(periods, atIso) {
  return periods.find((p) => p.start_at <= atIso && atIso < p.end_at) ?? null;
}

/** Quantities reported per period, used in diffs. Buckets use effective time. */
export function bucketByPeriod(events, periods) {
  const buckets = new Map();
  for (const e of events) {
    const p = periodFor(periods, e.effective_at);
    const key = p ? p.label : `∈/${e.effective_at.slice(0, 10)}`;
    const cur = buckets.get(key) ?? { period: key, delta: 0, count: 0 };
    cur.delta = round6(cur.delta + (e.delta_base ?? 0));
    cur.count += 1;
    buckets.set(key, cur);
  }
  return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
}
