import crypto from 'node:crypto';

/** Stable, key-sorted JSON (sufficient for our plain data, no cycles). */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function digestOf(value) {
  return sha256(stableStringify(value));
}

export function round6(n) {
  if (!Number.isFinite(n)) throw new Error(`non-finite quantity: ${n}`);
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

export function fmtQty(n) {
  const r = round6(Number(n));
  return Number.isInteger(r) ? String(r) : r.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Normalize any accepted ISO timestamp to UTC milliseconds + Z. Throws on bad input. */
export function iso(value, label = 'timestamp') {
  if (typeof value !== 'string' || !ISO_RE.test(value)) {
    throw new Error(`${label} must be an ISO-8601 timestamp, got ${JSON.stringify(value)}`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid date: ${value}`);
  return d.toISOString();
}

export function isIso(value) {
  try {
    iso(value);
    return true;
  } catch {
    return false;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function addSeconds(isoString, seconds) {
  return new Date(new Date(isoString).getTime() + seconds * 1000).toISOString();
}

export function addDays(isoString, days) {
  return addSeconds(isoString, days * 86400);
}

/** Whole seconds between two ISO timestamps (b - a). */
export function secondsBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
}

export function newId(prefix) {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${t}-${crypto.randomUUID().slice(0, 8)}`;
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Parse CLI flags: --key value, --flag, repeated --key yields arrays. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function firstLine(text, max = 300) {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
}

export function sum(values) {
  return round6(values.reduce((a, b) => a + b, 0));
}

export function uniq(values) {
  return [...new Set(values)];
}

/** Split [start,end] around covered windows. Coverage is inclusive at both ends. */
export function gapsWithin(start, end, windows) {
  if (!start || !end || start >= end) return [];
  const clipped = windows
    .filter((w) => w.start_at < end && w.end_at > start)
    .map((w) => ({ start_at: maxIso(w.start_at, start), end_at: minIso(w.end_at, end) }))
    .sort((a, b) => (a.start_at === b.start_at ? a.end_at.localeCompare(b.end_at) : a.start_at.localeCompare(b.start_at)));
  const gaps = [];
  let cursor = start;
  for (const w of clipped) {
    if (w.start_at > cursor) gaps.push({ start_at: cursor, end_at: w.start_at });
    if (w.end_at > cursor) cursor = w.end_at;
  }
  if (cursor < end) gaps.push({ start_at: cursor, end_at: end });
  return gaps.map((g) => ({ start_at: g.start_at, end_at: g.end_at }));
}

export function maxIso(a, b) {
  return a >= b ? a : b;
}
export function minIso(a, b) {
  return a <= b ? a : b;
}

/** Overlap of two inclusive windows, or null. */
export function intersect(a, b) {
  const start = maxIso(a.start_at, b.start_at);
  const end = minIso(a.end_at, b.end_at);
  return start < end ? { start_at: start, end_at: end } : null;
}
