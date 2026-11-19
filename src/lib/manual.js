/**
 * Manual, human-entered adjustments. They are never written directly into the
 * ledger tables: each becomes a normal connector batch on disk, then goes through
 * the same validation, idempotency, and unit-pinning path as machine feeds.
 *
 * Two rules that matter for an explainable cutview:
 *   1. A count correction is a NEW REVISION of the count. The ledger is untouched.
 *   2. A ledger correction is a reversal row PLUS a replacement row. Nothing is
 *      overwritten and nothing is deleted, so prior cutviews stay recomputable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ingestManifest } from './ingest.js';
import { digestOf, iso, newId, nowIso, round6 } from './util.js';
import { baseUnitOfDimension, dimensionOf, ruleAt } from './units.js';
import { requireNumber, requireString, optionalString } from './streams.js';

function inboxDir(dbPath) {
  return path.resolve(path.dirname(path.resolve(dbPath)), 'inbox');
}

function writeBatch(dbPath, batchId, stream, format, payload) {
  const dir = inboxDir(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${batchId}.${format}`;
  const abs = path.join(dir, file);
  const body = format === 'csv'
    ? payload
    : format === 'jsonl'
      ? payload.map((r) => JSON.stringify(r)).join('\n') + '\n'
      : JSON.stringify(payload, null, 2) + '\n';
  fs.writeFileSync(abs, body);
  return { dir, file, abs };
}

/** Manifest that pins no new reference data; reference data must already exist. */
function manualManifest(batch, relFile) {
  return {
    dataset: 'manual-entry',
    batches: [{ ...batch, file: relFile }],
  };
}

function runBatch(db, dbPath, batchId, stream, format, rows, { received_at = nowIso(), declared_coverage = [], note = null } = {}) {
  const extension = format;
  const { dir, file } = writeBatch(dbPath, batchId, stream, extension, rows);
  const manifestPath = path.join(dir, `${batchId}.manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manualManifest({ batch_id: batchId, stream, received_at, declared_coverage, format }, file), null, 2));
  const result = ingestManifest(manifestPath, { db });
  const batch = result.batches.find((b) => b.batch_id === batchId);
  if (!batch || batch.status === 'rejected') {
    const detail = (batch?.errors ?? []).map((e) => e.message).join('; ') || 'batch was not accepted';
    const err = new Error(detail);
    err.code = 'MANUAL_BATCH_REJECTED';
    err.detail = batch;
    throw err;
  }
  return { batch, note, manifest: path.relative(process.cwd(), manifestPath) };
}

export function addCount(db, dbPath, input) {
  const sku = requireString(input.sku, 'sku');
  const location = requireString(input.location, 'location');
  const counted_at = iso(input.counted_at, 'counted_at');
  const effective_at = input.effective_at ? iso(input.effective_at, 'effective_at') : counted_at;
  const qty = requireNumber(input.qty, 'qty');
  const unit = requireString(input.unit, 'unit');
  const units = db.prepare('SELECT * FROM unit_rules ORDER BY unit, version').all();
  const baseUnit = baseUnitOfDimension(units, dimensionOf(units, unit));
  void ruleAt(units, unit, effective_at); // fail fast on a missing rule
  if (qty < 0) throw new Error('counted quantity cannot be negative');

  const snapshot_id = input.snapshot_id ? requireString(input.snapshot_id, 'snapshot_id') : newId('C');
  // Revision is decided by the store, not the client, so a correction can never
  // silently replace an existing count.
  const latest = db.prepare('SELECT MAX(revision) AS rev FROM snapshots WHERE snapshot_id = ?').get(snapshot_id);
  const revision = latest?.rev == null ? 1 : latest.rev + 1;
  if (latest?.rev != null && input.revision !== undefined && Number(input.revision) !== revision) {
    throw new Error(`snapshot ${snapshot_id} is at revision ${latest.rev}; the next revision must be ${revision}`);
  }
  const batchId = newId('manual-snapshot');
  const row = {
    snapshot_id, revision, sku, location,
    counted_at, effective_at,
    qty: round6(qty), unit,
    reason: optionalString(input.reason) ?? (revision > 1 ? 'manual recount' : 'manual count'),
    operator: optionalString(input.operator) ?? 'web-user',
  };
  const out = runBatch(db, dbPath, batchId, 'snapshot', 'jsonl', [row], { note: input.note ?? null });
  return {
    ...out,
    snapshot: row,
    available_unit_base: baseUnit,
    // The count is applied; it does not rewrite any ledger row. Say so explicitly.
    ledger_untouched: true,
    revision_note: revision === 1
      ? 'first revision recorded'
      : `revision ${revision}: prior revision ${revision - 1} is retained and marked superseded; no ledger row was modified`,
  };
}

export function correctLedgerMovement(db, dbPath, input) {
  const event_id = requireString(input.event_id, 'event_id');
  const original = db.prepare('SELECT * FROM ledger_entries WHERE event_id = ?').get(event_id);
  if (!original) throw new Error(`no ledger movement ${event_id}`);
  const already = db.prepare('SELECT event_id FROM ledger_entries WHERE reversed_event_id = ?').get(event_id);
  if (already) throw new Error(`${event_id} was already reversed by ${already.event_id}`);

  const mode = input.effective === 'forward' ? 'forward' : 'restate';
  const qty = input.qty === undefined || input.qty === '' ? original.qty_input : requireNumber(input.qty, 'qty');
  const unit = input.unit ? requireString(input.unit, 'unit') : original.unit_input;
  const effective_at = mode === 'forward' ? iso(input.effective_at ?? nowIso(), 'effective_at') : original.effective_at;
  const recorded_at = nowIso();
  const reason = requireString(input.reason, 'reason');
  const operator = optionalString(input.operator) ?? 'web-user';

  const batchId = newId('manual-correction');
  // Unit input for the reversal must reproduce the original magnitude in the
  // original unit so the pair cancels exactly in base terms.
  const rows = [
    {
      event_id: `${event_id}-R${batchId.slice(-6)}`,
      sku: original.sku, location: original.location, kind: 'reversal',
      qty: Math.abs(original.qty_input), unit: original.unit_input,
      effective_at, recorded_at, reverses_event_id: event_id,
      reason: `reversal of ${event_id}: ${reason}`, operator,
    },
    {
      event_id: `${event_id}-C${batchId.slice(-6)}`,
      sku: original.sku, location: original.location,
      // Preserve the original's economic direction; only the quantity changes.
      kind: original.delta_base < 0 ? 'issue' : 'receipt',
      qty: round6(qty), unit,
      effective_at, recorded_at, correction_of: event_id,
      reason: `corrected entry for ${event_id}: ${reason}`, operator,
    },
  ];
  const fmt = 'csv';
  const header = 'event_id,sku,location,kind,qty,unit,effective_at,recorded_at,reverses_event_id,correction_of,reason,operator';
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows.map((r) => [r.event_id, r.sku, r.location, r.kind, r.qty, r.unit, r.effective_at, r.recorded_at, r.reverses_event_id, r.correction_of, r.reason, r.operator].map(esc).join(','))].join('\n') + '\n';
  const out = runBatch(db, dbPath, batchId, 'ledger', fmt, csv, { note: input.note ?? null });
  return {
    ...out,
    original: {
      event_id: original.event_id, delta_base: original.delta_base, unit_base: original.unit_base,
      qty_input: original.qty_input, unit_input: original.unit_input, effective_at: original.effective_at,
    },
    appended: rows.map((r) => ({ event_id: r.event_id, kind: r.kind, qty: r.qty, unit: r.unit, effective_at: r.effective_at })),
    mode,
    mode_note: mode === 'restate'
      ? 'both rows are effective at the original instant: history is restated. Published cutviews keep their digests; recomputing them is required to see the change'
      : 'both rows are effective now: prior cutviews are untouched, the correction lands in the current period',
    overwritten_rows: 0,
  };
}
