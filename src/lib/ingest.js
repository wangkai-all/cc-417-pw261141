/**
 * Connector / ingester. Accepts one manifest of connector batches and applies them
 * in declared order. Each batch is atomic: either every valid row lands, or the
 * batch is rejected wholesale (with per-row diagnostics). Every accepted row is
 * pinned with the unit rule version that was effective at its own effective time.
 *
 * Manifest shape:
 * {
 *   "connectors": { "ledger": {...minority metadata...}, ... },
 *   "unit_rules": [ {unit, dimension, version, factor_to_base, effective_from, effective_to} ],
 *   "periods": [ {label, start_at, end_at} ],
 *   "skus": {...}, "locations": {...},
 *   "batches": [
 *     { "batch_id": "...", "stream": "ledger"|"snapshot"|"transit", "file": "...",
 *       "format": "csv"|"jsonl"|"json", "received_at": "...", "declared_coverage": [...] }
 *   ]
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { getMeta, setMeta, tx } from './db.js';
import { normalizeUnitRules, toBase, UnitError } from './units.js';
import { normalizePeriods } from './periods.js';
import { iso, digestOf, round6, stableStringify, nowIso, gapsWithin } from './util.js';
import {
  formatFor, parseRows, readInputFile, requireNumber, requireString, optionalString, resolveInput,
} from './streams.js';

const STREAMS = new Set(['ledger', 'snapshot', 'transit']);

export class IngestError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'IngestError';
    this.code = 'INGEST_REJECTED';
    this.detail = detail;
  }
}

function registerDimensions(unitRules, dims, label) {
  for (const r of unitRules) {
    const known = dims.get(r.unit);
    if (known && known !== r.dimension) throw new Error(`${label}: unit ${r.unit} mixes dimensions ${known} and ${r.dimension}`);
    dims.set(r.unit, r.dimension);
  }
}

/** Pin reference data once; re-ingesting identical reference data is a no-op. */
function pinReference(db, manifest) {
  const existingRules = db.prepare('SELECT * FROM unit_rules ORDER BY unit, version').all();
  // A batch that carries no reference data (manual entries) must not attempt to
  // re-pin any: it relies on what the machine feeds already pinned.
  if (manifest.unit_rules === undefined && existingRules.length > 0) {
    // nothing to pin
  } else if (existingRules.length > 0) {
    const stored = existingRules.map(({ unit, version, dimension, factor_to_base, effective_from, effective_to, label, note }) => ({ unit, dimension, version, factor_to_base, effective_from, effective_to, label, note }));
    const incoming = normalizeUnitRules(manifest.unit_rules ?? []);
    if (digestOf(stored) !== digestOf(incoming)) {
      throw new Error('unit rules changed after first ingest; historical rows would need a new conversion version instead');
    }
    for (const r of incoming) {
      db.prepare('INSERT OR IGNORE INTO unit_rules(unit,version,dimension,factor_to_base,effective_from,effective_to,label,note) VALUES(?,?,?,?,?,?,?,?)')
        .run(r.unit, r.version, r.dimension, r.factor_to_base, r.effective_from, r.effective_to, r.label, r.note);
    }
  } else {
    const rules = normalizeUnitRules(manifest.unit_rules ?? []);
    for (const r of rules) {
      db.prepare('INSERT INTO unit_rules(unit,version,dimension,factor_to_base,effective_from,effective_to,label,note) VALUES(?,?,?,?,?,?,?,?)')
        .run(r.unit, r.version, r.dimension, r.factor_to_base, r.effective_from, r.effective_to, r.label, r.note);
    }
  }

  const periods = normalizePeriods(manifest.periods ?? []);
  for (const p of periods) {
    const row = db.prepare('SELECT * FROM periods WHERE label = ?').get(p.label);
    if (row && (row.start_at !== p.start_at || row.end_at !== p.end_at)) {
      throw new Error(`period ${p.label} changed after first ingest`);
    }
    db.prepare('INSERT INTO periods(label,start_at,end_at) VALUES(?,?,?) ON CONFLICT(label) DO NOTHING').run(p.label, p.start_at, p.end_at);
  }

  for (const [sku, description] of Object.entries(manifest.skus ?? {})) {
    db.prepare('INSERT INTO skus(sku,description) VALUES(?,?) ON CONFLICT(sku) DO UPDATE SET description=excluded.description').run(sku, String(description));
  }
  for (const [loc, description] of Object.entries(manifest.locations ?? {})) {
    db.prepare('INSERT INTO locations(location,description) VALUES(?,?) ON CONFLICT(location) DO UPDATE SET description=excluded.description').run(loc, String(description));
  }
  return { rules: db.prepare('SELECT * FROM unit_rules').all(), periods: db.prepare('SELECT * FROM periods ORDER BY start_at').all() };
}

function ledgerRow(row, ctx) {
  const event_id = requireString(row.event_id, 'event_id');
  const sku = requireString(row.sku, 'sku');
  const location = requireString(row.location, 'location');
  if (!ctx.knownSkus.has(sku)) throw new Error(`unknown sku ${sku}`);
  if (!ctx.knownLocations.has(location)) throw new Error(`unknown location ${location}`);
  const qty = requireNumber(row.qty, 'qty');
  const unit = requireString(row.unit, 'unit');
  const effective_at = iso(row.effective_at, 'effective_at');
  const recorded_at = row.recorded_at ? iso(row.recorded_at, 'recorded_at') : ctx.receivedAt;
  if (recorded_at > ctx.ingestNow) throw new Error(`recorded_at ${recorded_at} is in the future relative to ingest`);
  const kind = (optionalString(row.kind) ?? 'movement').toLowerCase();
  const reversalOf = optionalString(row.reverses_event_id);
  const correctionOf = optionalString(row.correction_of);
  const magnitude = Math.abs(qty);
  let sign;
  switch (kind) {
    case 'receipt':
      sign = 1;
      break;
    case 'issue':
      sign = -1;
      break;
    case 'adjustment':
    case 'movement':
      if (qty === 0) throw new Error(`qty must be non-zero for kind ${kind}`);
      sign = qty > 0 ? 1 : -1;
      break;
    case 'reversal': {
      if (!reversalOf) throw new Error('reversal requires reverses_event_id');
      // Direction depends on what is being reversed: reversing a receipt removes
      // stock, reversing an issue adds it back. Assume nothing: resolve the target
      // (earlier row in this batch, or already stored) and take the opposite sign.
      const target = ctx.resolveLedgerEvent?.(reversalOf);
      if (!target) {
        throw new Error(`reversal ${event_id} references ${reversalOf}, which has not been ingested; its direction cannot be determined`);
      }
      sign = target.delta_base > 0 ? -1 : 1;
      break;
    }
    default:
      throw new Error(`unknown kind ${kind}`);
  }
  if (kind === 'reversal' && reversalOf === event_id) throw new Error('a reversal cannot reverse itself');
  const conv = toBase(magnitude, unit, ctx.unitRules, effective_at);
  const delta_base = round6(sign * conv.qty_base);
  return {
    event_id, sku, location, delta_base, unit_base: conv.base_unit,
    qty_input: round6(qty), unit_input: unit, unit_version: conv.unit_version,
    factor_to_base: conv.factor_to_base, dimension: conv.dimension,
    effective_at, recorded_at, reversed_event_id: reversalOf, correction_of: correctionOf,
    reason: optionalString(row.reason), operator: optionalString(row.operator), kind,
  };
}

function snapshotRow(row, ctx) {
  const snapshot_id = requireString(row.snapshot_id, 'snapshot_id');
  const revision = Math.trunc(requireNumber(row.revision, 'revision'));
  if (revision < 1) throw new Error('revision must be >= 1');
  // Revisions only move forward. Checked here, during row validation, so a stale
  // revision rejects its batch with a diagnostic instead of throwing mid-insert.
  if (ctx.db) {
    const latest = ctx.db.prepare('SELECT MAX(revision) AS rev FROM snapshots WHERE snapshot_id = ?').get(snapshot_id);
    if (latest?.rev != null && revision < latest.rev) {
      throw new Error(`snapshot ${snapshot_id} revision ${revision} is older than stored revision ${latest.rev}`);
    }
  }
  const sku = requireString(row.sku, 'sku');
  const location = requireString(row.location, 'location');
  if (!ctx.knownSkus.has(sku)) throw new Error(`unknown sku ${sku}`);
  if (!ctx.knownLocations.has(location)) throw new Error(`unknown location ${location}`);
  const qty = requireNumber(row.qty, 'qty');
  if (qty < 0) throw new Error('snapshot quantity cannot be negative');
  const unit = requireString(row.unit, 'unit');
  const counted_at = iso(row.counted_at, 'counted_at');
  const effective_at = iso(row.effective_at ?? row.counted_at, 'effective_at');
  if (counted_at > ctx.ingestNow) throw new Error('counted_at is in the future relative to ingest');
  const conv = toBase(qty, unit, ctx.unitRules, effective_at);
  if (!Number.isFinite(conv.qty_base)) throw new Error('invalid converted quantity');
  return {
    snapshot_id, revision, sku, location, counted_at, effective_at,
    qty_base: conv.qty_base, unit_base: conv.base_unit, qty_counted: round6(qty), unit_counted: unit,
    unit_version: conv.unit_version, factor_to_base: conv.factor_to_base, dimension: conv.dimension,
    reason: optionalString(row.reason), operator: optionalString(row.operator),
  };
}

function transitRow(row, ctx) {
  const notice_id = requireString(row.notice_id, 'notice_id');
  const revision = Math.trunc(requireNumber(row.revision ?? 1, 'revision'));
  if (revision < 1) throw new Error('revision must be >= 1');
  const sku = requireString(row.sku, 'sku');
  const location = requireString(row.location, 'location');
  if (!ctx.knownSkus.has(sku)) throw new Error(`unknown sku ${sku}`);
  if (!ctx.knownLocations.has(location)) throw new Error(`unknown location ${location}`);
  const qty = requireNumber(row.qty, 'qty');
  if (qty < 0) throw new Error('notice quantity cannot be negative');
  const unit = requireString(row.unit, 'unit');
  const status = requireString(row.status, 'status').toLowerCase();
  if (!['in_transit', 'received', 'cancelled', 'delayed'].includes(status)) throw new Error(`unknown transit status ${status}`);
  if (ctx.db) {
    const latest = ctx.db.prepare('SELECT MAX(revision) AS rev FROM transit_notices WHERE notice_id = ?').get(notice_id);
    if (latest?.rev != null && revision < latest.rev) {
      throw new Error(`notice ${notice_id} revision ${revision} is older than stored revision ${latest.rev}`);
    }
  }
  const eta_at = row.eta_at ? iso(row.eta_at, 'eta_at') : null;
  const dispatched_at = row.dispatched_at ? iso(row.dispatched_at, 'dispatched_at') : null;
  const received_event_id = optionalString(row.received_event_id);
  if (status === 'received' && !received_event_id) throw new Error('received notice must link received_event_id');
  const recorded_at = row.recorded_at ? iso(row.recorded_at, 'recorded_at') : ctx.receivedAt;
  const conv = toBase(qty, unit, ctx.unitRules, effective_atOfTransit(eta_at, dispatched_at, ctx.receivedAt));
  return {
    notice_id, revision, sku, location, qty_base: conv.qty_base, unit_base: conv.base_unit,
    qty_noticed: round6(qty), unit_noticed: unit, unit_version: conv.unit_version,
    factor_to_base: conv.factor_to_base, dimension: conv.dimension, status,
    dispatched_at, eta_at, received_event_id, recorded_at, note: optionalString(row.note),
  };
}

function effective_atOfTransit(eta_at, dispatched_at, receivedAt) {
  return eta_at ?? dispatched_at ?? receivedAt;
}

const ADAPTERS = {
  ledger: {
    key: (r) => `ledger:${r.event_id}`,
    normalize: ledgerRow,
    insert(db, batchId, r, rowSha, line) {
      db.prepare(`INSERT INTO ledger_entries(stream,event_id,batch_id,sku,location,delta_base,unit_base,qty_input,unit_input,unit_version,factor_to_base,dimension,kind,effective_at,recorded_at,reversed_event_id,correction_of,reason,operator,source_line,row_sha256)
        VALUES('ledger',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        r.event_id, batchId, r.sku, r.location, r.delta_base, r.unit_base, r.qty_input, r.unit_input,
        r.unit_version, r.factor_to_base, r.dimension, r.kind, r.effective_at, r.recorded_at,
        r.reversed_event_id, r.correction_of, r.reason, r.operator, line, rowSha,
      );
    },
    afterBatch(db, ctx, batchId) {
      // Link reversals to the events they reverse; the reversed row is retained,
      // never deleted, so the ledger history stays auditable.
      const revs = db.prepare('SELECT event_id, reversed_event_id FROM ledger_entries WHERE batch_id = ? AND reversed_event_id IS NOT NULL').all(batchId);
      const linked = [];
      for (const rv of revs) {
        const target = db.prepare('SELECT delta_base FROM ledger_entries WHERE event_id = ?').get(rv.reversed_event_id);
        if (!target) ctx.warn({ code: 'REVERSAL_TARGET_UNKNOWN', message: `reversal ${rv.event_id} references unknown event ${rv.reversed_event_id}` });
        else linked.push(rv);
      }
      return { linked };
    },
  },
  snapshot: {
    key: (r) => `snapshot:${r.snapshot_id}@${r.revision}`,
    normalize: snapshotRow,
    insert(db, batchId, r, rowSha, line) {
      const prev = db.prepare('SELECT revision FROM snapshots WHERE snapshot_id = ? AND revision = ?').get(r.snapshot_id, r.revision);
      if (prev) throw new Error(`snapshot ${r.snapshot_id} revision ${r.revision} already exists; revisions are append-only`);
      const latest = db.prepare('SELECT MAX(revision) AS rev FROM snapshots WHERE snapshot_id = ?').get(r.snapshot_id);
      if (latest?.rev != null && r.revision < latest.rev) {
        throw new Error(`snapshot ${r.snapshot_id} revision ${r.revision} is older than stored revision ${latest.rev}`);
      }
      if (latest?.rev != null) {
        db.prepare('UPDATE snapshots SET superseded_by_revision = ? WHERE snapshot_id = ? AND revision = ? AND superseded_by_revision IS NULL')
          .run(r.revision, r.snapshot_id, latest.rev);
      }
      db.prepare(`INSERT INTO snapshots(stream,snapshot_id,revision,batch_id,sku,location,counted_at,effective_at,qty_base,unit_base,qty_counted,unit_counted,unit_version,factor_to_base,dimension,reason,operator,source_line,row_sha256)
        VALUES('snapshot',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        r.snapshot_id, r.revision, batchId, r.sku, r.location, r.counted_at, r.effective_at,
        r.qty_base, r.unit_base, r.qty_counted, r.unit_counted, r.unit_version, r.factor_to_base,
        r.dimension, r.reason, r.operator, line, rowSha,
      );
    },
    afterBatch() {
      return {};
    },
  },
  transit: {
    key: (r) => `transit:${r.notice_id}@${r.revision}`,
    normalize: transitRow,
    insert(db, batchId, r, rowSha, line) {
      if (db.prepare('SELECT 1 FROM transit_notices WHERE notice_id = ? AND revision = ?').get(r.notice_id, r.revision)) {
        throw new Error(`notice ${r.notice_id} revision ${r.revision} already exists; revisions are append-only`);
      }
      const latest = db.prepare('SELECT MAX(revision) AS rev FROM transit_notices WHERE notice_id = ?').get(r.notice_id);
      if (latest?.rev != null) {
        if (r.revision < latest.rev) throw new Error(`notice ${r.notice_id} revision ${r.revision} is older than stored revision ${latest.rev}`);
        db.prepare('UPDATE transit_notices SET superseded_by_revision = ? WHERE notice_id = ? AND revision = ? AND superseded_by_revision IS NULL')
          .run(r.revision, r.notice_id, latest.rev);
      }
      if (r.status === 'received') {
        const ev = db.prepare('SELECT event_id FROM ledger_entries WHERE event_id = ?').get(r.received_event_id);
        if (!ev) throw new Error(`notice ${r.notice_id} links unknown receipt event ${r.received_event_id}`);
      }
      db.prepare(`INSERT INTO transit_notices(stream,notice_id,revision,batch_id,sku,location,qty_base,unit_base,qty_noticed,unit_noticed,unit_version,factor_to_base,dimension,status,dispatched_at,eta_at,received_event_id,recorded_at,note,source_line,row_sha256)
        VALUES('transit',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        r.notice_id, r.revision, batchId, r.sku, r.location, r.qty_base, r.unit_base,
        r.qty_noticed, r.unit_noticed, r.unit_version, r.factor_to_base, r.dimension, r.status,
        r.dispatched_at, r.eta_at, r.received_event_id, r.recorded_at, r.note, line, rowSha,
      );
    },
    afterBatch() {
      return {};
    },
  },
};

export function loadManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new IngestError(`manifest is not valid JSON: ${err.message}`);
  }
  if (!manifest || typeof manifest !== 'object') throw new IngestError('manifest must be a JSON object');
  if (!Array.isArray(manifest.batches) || manifest.batches.length === 0) throw new IngestError('manifest.batches must be a non-empty array');
  const seen = new Set();
  for (const b of manifest.batches) {
    if (!b || typeof b !== 'object') throw new IngestError('each batch must be an object');
    const id = requireString(b.batch_id, 'batch.batch_id');
    if (seen.has(id)) throw new IngestError(`duplicate batch_id in manifest: ${id}`);
    seen.add(id);
    if (!STREAMS.has(b.stream)) throw new IngestError(`batch ${id}: stream must be one of ${[...STREAMS].join(', ')}`);
    if (!b.file) throw new IngestError(`batch ${id}: file is required`);
    b.batch_id = id;
    b.received_at = iso(b.received_at, `batch ${id} received_at`);
  }
  return { manifest, baseDir: path.dirname(path.resolve(manifestPath)), manifestSha: digestOf(manifest) };
}

/**
 * Apply a manifest. Ordering is the manifest's batch order; within a batch rows are
 * validated against a stable set of reference data, and row-level failures reject
 * the batch. `delivery` controls whether a partially-valid batch is all-or-nothing.
 */
export function ingestManifest(manifestPath, { db, strictBatches = true } = {}) {
  const { manifest, baseDir, manifestSha } = loadManifest(manifestPath);
  const pinned = tx(db, () => pinReference(db, manifest));
  const unitRules = pinned.rules.map((r) => ({ ...r }));
  const knownSkus = new Set(db.prepare('SELECT sku FROM skus').all().map((r) => r.sku));
  const knownLocations = new Set(db.prepare('SELECT location FROM locations').all().map((r) => r.location));
  const results = [];
  const connectors = manifest.connectors ?? {};

  for (const batch of manifest.batches) {
    const receivedAt = batch.received_at;
    const ingestNow = nowIso();
    const fileAbs = resolveInput(baseDir, batch.file);
    const text = readInputFile(fileAbs);
    const sourceSha = digestOf(text);
    const payloadSha = sourceSha;

    const prior = db.prepare('SELECT * FROM batches WHERE batch_id = ?').get(batch.batch_id);
    if (prior) {
      if (prior.payload_sha256 !== payloadSha) {
        throw new IngestError(`batch ${batch.batch_id} already accepted with different contents`, {
          batch_id: batch.batch_id, stored_sha256: prior.payload_sha256, incoming_sha256: payloadSha,
        });
      }
      results.push({
        batch_id: batch.batch_id, stream: batch.stream, status: 'duplicate',
        accepted: prior.accepted_count, rejected: prior.rejected_count, duplicate: 0,
        reason: 'identical batch already accepted',
      });
      continue;
    }
    const format = formatFor(batch.file, batch.format);
    const rows = parseRows(text, format);
    const adapter = ADAPTERS[batch.stream];
    const warnings = [];
    const ctx = {
      db,
      unitRules,
      knownSkus,
      knownLocations,
      receivedAt,
      ingestNow,
      warn: (w) => warnings.push(w),
    };

    const normalized = [];
    const errors = [];
    const observedByKey = new Map();
    // Reversal direction is resolved against the target row. Within one batch a
    // reversal may name a movement that appears earlier in the same file, so the
    // batch's own resolved rows are searched before the stored ledger.
    const resolvedInBatch = new Map();
    ctx.resolveLedgerEvent = (id) => resolvedInBatch.get(id) ?? db.prepare('SELECT delta_base FROM ledger_entries WHERE event_id = ?').get(id) ?? null;
    rows.forEach((row) => {
      const line = row.__line ?? null;
      try {
        const clean = { ...row };
        delete clean.__line;
        const n = adapter.normalize(clean, ctx);
        if (batch.stream === 'ledger') resolvedInBatch.set(n.event_id, { delta_base: n.delta_base, effective_at: n.effective_at });
        const key = adapter.key(n);
        if (observedByKey.has(key)) {
          throw new Error(`duplicate ${key.split(':')[0]} key in batch (first at line ${observedByKey.get(key)})`);
        }
        observedByKey.set(key, line);
        const existing = db
          .prepare(
            batch.stream === 'ledger'
              ? 'SELECT row_sha256 FROM ledger_entries WHERE event_id = ?'
              : batch.stream === 'snapshot'
                ? 'SELECT row_sha256 FROM snapshots WHERE snapshot_id = ? AND revision = ?'
                : 'SELECT row_sha256 FROM transit_notices WHERE notice_id = ? AND revision = ?',
          )
          .get(...(batch.stream === 'ledger' ? [n.event_id] : [n.snapshot_id ?? n.notice_id, n.revision]));
        if (existing) {
          if (existing.row_sha256 === digestOf(n)) {
            normalized.push({ n, line, raw: clean, duplicateOfStored: true });
            return;
          }
          throw new Error(`row collides with an existing ${batch.stream} row under a different payload`);
        }
        normalized.push({ n, line, raw: clean, duplicateOfStored: false });
      } catch (err) {
        errors.push({ stream: batch.stream, stream_key: row.event_id ?? row.snapshot_id ?? row.notice_id ?? null, source_line: line, code: err.code ?? 'ROW_INVALID', message: err.message });
      }
    });

    if (errors.length > 0 && strictBatches) {
      tx(db, () => {
        const recAt = nowIso();
        // Rejected batches stay in the audit trail with zero accepted rows, so a
        // missing data range is visible rather than silent.
        db.prepare('DELETE FROM batches WHERE batch_id = ?').run(batch.batch_id);
        db.prepare(`INSERT INTO batches(batch_id,stream,source_file,source_sha256,received_at,accepted_at,ingested_at,row_count,accepted_count,rejected_count,duplicate_count,status,payload_sha256,payload)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          batch.batch_id, batch.stream, path.relative(baseDir, fileAbs) || batch.file, sourceSha,
          receivedAt, receivedAt, recAt, rows.length, 0, errors.length, 0, 'rejected', payloadSha, text,
        );
        db.prepare('DELETE FROM rejected_rows WHERE batch_id = ?').run(batch.batch_id);
        for (const e of errors) {
          db.prepare('INSERT INTO rejected_rows(batch_id,stream,stream_key,source_line,code,message,raw,rejected_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(batch.batch_id, e.stream, e.stream_key, e.source_line, e.code, e.message, null, recAt);
        }
      });
      results.push({
        batch_id: batch.batch_id, stream: batch.stream, status: 'rejected',
        accepted: 0, rejected: errors.length, duplicate: 0,
        errors: errors.slice(0, 50), error_count: errors.length,
        reason: 'batch rejected whole; no rows were applied',
      });
      continue;
    }

    const outcome = tx(db, () => {
      const wallClock = nowIso();
      db.prepare('DELETE FROM rejected_rows WHERE batch_id = ?').run(batch.batch_id);
      for (const e of errors) {
        db.prepare('INSERT INTO rejected_rows(batch_id,stream,stream_key,source_line,code,message,raw,rejected_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(batch.batch_id, e.stream, e.stream_key, e.source_line, e.code, e.message, null, wallClock);
      }
      // Knowledge time is the connector-declared receipt instant, not our wall
      // clock: that is the only claim we have about when the data became knowable.
      // ingested_at records when this process actually wrote it, for audit only.
      db.prepare(`INSERT INTO batches(batch_id,stream,source_file,source_sha256,received_at,accepted_at,ingested_at,row_count,accepted_count,rejected_count,duplicate_count,payload_sha256,payload)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        batch.batch_id, batch.stream, path.relative(baseDir, fileAbs) || batch.file, sourceSha, receivedAt, receivedAt, wallClock,
        rows.length, 0, errors.length, 0, payloadSha, text,
      );
      let accepted = 0;
      let duplicates = 0;
      for (const item of normalized) {
        if (item.duplicateOfStored) {
          duplicates += 1;
          continue;
        }
        adapter.insert(db, batch.batch_id, item.n, digestOf(item.n), item.line);
        accepted += 1;
      }
      // A row that normalized identically to an already-stored row is still recorded
      // in the batch payload; it is counted as a duplicate, never re-applied.
      const after = adapter.afterBatch(db, ctx, batch.batch_id);
      db.prepare('UPDATE batches SET accepted_count = ?, duplicate_count = ?, rejected_count = ?, status = ? WHERE batch_id = ?')
        .run(accepted, duplicates, errors.length, accepted === 0 && duplicates > 0 ? 'duplicate' : 'accepted', batch.batch_id);
      db.prepare(`INSERT INTO connectors(stream,connector,last_batch_id,last_received_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(stream) DO UPDATE SET connector=excluded.connector, last_batch_id=excluded.last_batch_id, last_received_at=excluded.last_received_at, updated_at=excluded.updated_at`)
        .run(batch.stream, connectors[batch.stream]?.name ?? `${batch.stream}-connector`, batch.batch_id, receivedAt, wallClock);
      const coverageRows = [];
      for (const cov of batch.declared_coverage ?? []) {
        const sku = requireString(cov.sku, 'declared_coverage.sku');
        const location = requireString(cov.location, 'declared_coverage.location');
        const start_at = iso(cov.start_at, 'declared_coverage.start_at');
        const end_at = iso(cov.end_at, 'declared_coverage.end_at');
        if (end_at <= start_at) throw new Error('declared_coverage end_at must be after start_at');
        const ackId = cov.ack_id ? String(cov.ack_id) : null;
        // SQLite treats NULLs as distinct in a UNIQUE index, so deduplicate explicitly.
        const dupe = db.prepare('SELECT 1 FROM coverage WHERE stream = ? AND sku = ? AND location = ? AND IFNULL(ack_id, \'\') = IFNULL(?, \'\') AND start_at = ? AND end_at = ? AND reason = ?')
          .get(batch.stream, sku, location, ackId, start_at, end_at, String(cov.reason ?? 'declared'));
        if (!dupe) {
          db.prepare(`INSERT INTO coverage(stream,sku,location,ack_id,start_at,end_at,reason,detail,batch_id)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(
            batch.stream, sku, location, ackId, start_at, end_at,
            String(cov.reason ?? 'declared'), cov.detail ? JSON.stringify(cov.detail) : null, batch.batch_id,
          );
        }
        coverageRows.push({ sku, location, start_at, end_at, reason: String(cov.reason ?? 'declared') });
      }
      return { accepted, duplicates, coverageRows, after };
    });

    results.push({
      batch_id: batch.batch_id, stream: batch.stream, status: 'accepted',
      accepted: outcome.accepted, rejected: errors.length, duplicate: outcome.duplicates,
      declared_coverage: outcome.coverageRows.length, warnings: warnings.slice(0, 20), ...outcome.after,
    });
  }

  setMeta(db, 'manifest', { path: path.basename(manifestPath), sha256: manifestSha, ingested_at: nowIso() });
  return { manifest_sha256: manifestSha, batches: results, unit_rules: unitRules.length, periods: pinned.periods.length };
}

export { gapsWithin };
