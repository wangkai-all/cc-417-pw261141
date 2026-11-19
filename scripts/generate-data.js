#!/usr/bin/env node
/**
 * Fictional, deterministic warehouse dataset. Fixed timeline so every reported
 * number can be traced by hand. No real inventory, counterparties, or decisions.
 *
 * Streams: ledger (CSV movements), snapshots (JSONL physical counts),
 * transit (JSON notices). Batches are declared in data/manifest.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../src/lib/util.js';

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out ?? 'data');
if (args.reset) {
  for (const entry of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
    fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
}
fs.mkdirSync(outDir, { recursive: true });
const T = (s) => new Date(s).toISOString();

const UNIT_RULES = [
  { unit: 'EA', dimension: 'count', version: 1, factor_to_base: 1, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null, label: 'each' },
  { unit: 'BOX', dimension: 'count', version: 1, factor_to_base: 12, effective_from: T('2025-01-01T00:00:00Z'), effective_to: T('2026-03-01T00:00:00Z'), label: 'carton of 12', note: 'superseded by v2 at the March repack' },
  { unit: 'BOX', dimension: 'count', version: 2, factor_to_base: 10, effective_from: T('2026-03-01T00:00:00Z'), effective_to: null, label: 'carton of 10', note: 'supplier repacked 12→10; old movements stay v1' },
  { unit: 'KG', dimension: 'mass', version: 1, factor_to_base: 1, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null, label: 'kilogram' },
  { unit: 'G', dimension: 'mass', version: 1, factor_to_base: 0.001, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null, label: 'gram' },
];
const SKUS = { 'SKU-ALPHA': 'Fictional fast-moving widget', 'SKU-BETA': 'Fictional carton-packed component', 'SKU-GAMMA': 'Fictional bulk powder' };
const LOCATIONS = { 'WH-A': 'Fictional north warehouse', 'WH-B': 'Fictional south warehouse' };

// ---------------------------------------------------------------------------
// Ledger. `batch` is assigned explicitly; `reverses` names a prior local id.
// ---------------------------------------------------------------------------
const ledger = [];
const addLedger = (batch, row) => {
  const n = ledger.length + 1;
  ledger.push({
    event_id: `L-${String(n).padStart(4, '0')}`,
    batch,
    sku: row.sku,
    location: row.location,
    kind: row.kind ?? 'movement',
    qty: row.qty,
    unit: row.unit,
    effective_at: T(row.eff),
    recorded_at: T(row.rec ?? row.eff),
    reverses_event_id: row.reverses ? `L-${String(row.reverses).padStart(4, '0')}` : '',
    reason: row.reason ?? '',
    operator: 'fixture',
  });
};

addLedger('ledger-001', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'receipt', qty: 200, unit: 'EA', eff: '2026-01-03T09:00:00Z' }); // 1
addLedger('ledger-001', { sku: 'SKU-BETA', location: 'WH-A', kind: 'receipt', qty: 10, unit: 'BOX', eff: '2026-01-05T08:00:00Z' }); // 2  BOX v1 +120
addLedger('ledger-001', { sku: 'SKU-GAMMA', location: 'WH-B', kind: 'receipt', qty: 40, unit: 'KG', eff: '2026-01-07T11:00:00Z' }); // 3
addLedger('ledger-001', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'issue', qty: 75, unit: 'EA', eff: '2026-01-09T14:30:00Z' }); // 4
addLedger('ledger-001', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'issue', qty: 20, unit: 'EA', eff: '2026-01-20T10:00:00Z', reason: 'picked to line 8841' }); // 5
addLedger('ledger-001', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'reversal', qty: 20, unit: 'EA', eff: '2026-01-21T08:00:00Z', reverses: 5, reason: 'order cancelled before despatch' }); // 6
addLedger('ledger-001', { sku: 'SKU-BETA', location: 'WH-A', kind: 'issue', qty: 4, unit: 'BOX', eff: '2026-01-22T16:00:00Z' }); // 7  v1 -48
addLedger('ledger-001', { sku: 'SKU-GAMMA', location: 'WH-B', kind: 'issue', qty: 1500, unit: 'G', eff: '2026-01-28T13:00:00Z' }); // 8  -1.5 KG
addLedger('ledger-001', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'issue', qty: 40, unit: 'EA', eff: '2026-02-04T10:15:00Z' }); // 9
addLedger('ledger-002', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'receipt', qty: 100, unit: 'EA', eff: '2026-02-10T07:00:00Z', rec: '2026-03-05T12:00:00Z', reason: 'supplier ASN arrived after the fact' }); // 10 late
addLedger('ledger-001', { sku: 'SKU-BETA', location: 'WH-A', kind: 'receipt', qty: 12, unit: 'BOX', eff: '2026-02-12T09:00:00Z' }); // 11 v1 +144
addLedger('ledger-001', { sku: 'SKU-GAMMA', location: 'WH-B', kind: 'issue', qty: 15, unit: 'KG', eff: '2026-02-14T15:00:00Z' }); // 12
addLedger('ledger-001', { sku: 'SKU-BETA', location: 'WH-A', kind: 'issue', qty: 5, unit: 'BOX', eff: '2026-02-15T00:00:00Z', reason: 'exactly at count instant (ambiguity case)' }); // 13 v1 -60
addLedger('ledger-001', { sku: 'SKU-ALPHA', location: 'WH-B', kind: 'issue', qty: 30, unit: 'EA', eff: '2026-02-18T11:00:00Z' }); // 14
addLedger('ledger-001', { sku: 'SKU-GAMMA', location: 'WH-B', kind: 'receipt', qty: 60, unit: 'KG', eff: '2026-02-20T09:00:00Z' }); // 15
addLedger('ledger-002', { sku: 'SKU-BETA', location: 'WH-A', kind: 'receipt', qty: 6, unit: 'BOX', eff: '2026-03-02T10:00:00Z', reason: 'transit T-0002 arrived' }); // 16 v2 +60
addLedger('ledger-002', { sku: 'SKU-BETA', location: 'WH-A', kind: 'issue', qty: 3, unit: 'BOX', eff: '2026-03-03T10:00:00Z' }); // 17 v2 -30
addLedger('ledger-002', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'issue', qty: 50, unit: 'EA', eff: '2026-03-06T09:30:00Z', reason: 'shipped during exporter outage (row recovered)' }); // 18
addLedger('ledger-003', { sku: 'SKU-GAMMA', location: 'WH-B', kind: 'receipt', qty: 25, unit: 'KG', eff: '2026-03-10T13:00:00Z' }); // 19
addLedger('ledger-003', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'receipt', qty: 200, unit: 'EA', eff: '2026-03-12T08:00:00Z' }); // 20
addLedger('ledger-004', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'issue', qty: 30, unit: 'EA', eff: '2026-03-15T09:00:00Z', rec: '2026-04-01T09:00:00Z', reason: 'manual pick slip batched late' }); // 21
addLedger('ledger-004', { sku: 'SKU-ALPHA', location: 'WH-A', kind: 'reversal', qty: 30, unit: 'EA', eff: '2026-03-16T09:00:00Z', rec: '2026-04-01T09:05:00Z', reverses: 21, reason: 'wrong pick found during cycle count' }); // 22
addLedger('ledger-003', { sku: 'SKU-BETA', location: 'WH-A', kind: 'adjustment', qty: 1, unit: 'BOX', eff: '2026-03-20T17:00:00Z', rec: '2026-03-22T10:00:00Z', reason: 'one loose carton consolidated' }); // 23 v2 +10
addLedger('ledger-003', { sku: 'SKU-ALPHA', location: 'WH-B', kind: 'receipt', qty: 90, unit: 'EA', eff: '2026-03-24T09:00:00Z' }); // 24

const transitReceipt = ledger.find((r) => r.reason === 'transit T-0002 arrived');

// ---------------------------------------------------------------------------
// Snapshots. revision >1 of the same count is a correction, not a new count.
// ---------------------------------------------------------------------------
const snapshots = [];
const addSnap = (batch, row) => snapshots.push({
  batch,
  snapshot_id: row.id,
  revision: row.rev ?? 1,
  sku: row.sku,
  location: row.location,
  counted_at: T(row.counted),
  effective_at: T(row.effective ?? row.counted),
  qty: row.qty,
  unit: row.unit,
  reason: row.reason ?? '',
  operator: 'counter-7',
});
for (const [sku, loc, qty] of [['SKU-ALPHA', 'WH-A', 500], ['SKU-ALPHA', 'WH-B', 120], ['SKU-BETA', 'WH-A', 30], ['SKU-GAMMA', 'WH-B', 80]]) {
  addSnap('snapshot-001', { id: `C-2026-01-01-${sku.slice(4)}-${loc.slice(-1)}`, sku, location: loc, counted: '2026-01-01T00:00:00Z', qty, unit: sku === 'SKU-BETA' ? 'BOX' : sku === 'SKU-GAMMA' ? 'KG' : 'EA' });
}
for (const [sku, loc, qty] of [['SKU-ALPHA', 'WH-A', 600], ['SKU-ALPHA', 'WH-B', 120], ['SKU-BETA', 'WH-A', 36], ['SKU-GAMMA', 'WH-B', 120]]) {
  addSnap('snapshot-001', { id: `C-2026-02-01-${sku.slice(4)}-${loc.slice(-1)}`, sku, location: loc, counted: '2026-02-01T00:00:00Z', qty, unit: sku === 'SKU-BETA' ? 'BOX' : sku === 'SKU-GAMMA' ? 'KG' : 'EA', reason: 'monthly count' });
}
addSnap('snapshot-001', { id: 'C-2026-02-15-BETA-A', sku: 'SKU-BETA', location: 'WH-A', counted: '2026-02-16T08:00:00Z', effective: '2026-02-15T00:00:00Z', qty: 43, unit: 'BOX', reason: 'mid-month cycle count' });
for (const [sku, loc, qty] of [['SKU-ALPHA', 'WH-A', 835], ['SKU-ALPHA', 'WH-B', 90], ['SKU-BETA', 'WH-A', 56], ['SKU-GAMMA', 'WH-B', 190]]) {
  addSnap('snapshot-002', { id: `C-2026-04-01-${sku.slice(4)}-${loc.slice(-1)}`, sku, location: loc, counted: '2026-04-01T00:00:00Z', qty, unit: sku === 'SKU-BETA' ? 'BOX' : sku === 'SKU-GAMMA' ? 'KG' : 'EA', reason: 'quarter-end count' });
}
addSnap('snapshot-003', { id: 'C-2026-02-01-ALPHA-A', rev: 2, sku: 'SKU-ALPHA', location: 'WH-A', counted: '2026-02-01T00:00:00Z', qty: 625, unit: 'EA', reason: 'recount after keying error' });
// A count that arrives with a declared hole in the handheld feed.
snapshots.push({
  batch: 'snapshot-002', snapshot_id: 'C-2026-04-01-GAMMA-A', revision: 1, sku: 'SKU-GAMMA', location: 'WH-A',
  counted_at: T('2026-04-01T00:00:00Z'), effective_at: T('2026-04-01T00:00:00Z'), qty: 0, unit: 'KG', reason: 'no stock held at WH-A', operator: 'counter-7',
});

// ---------------------------------------------------------------------------
// Transit notices.
// ---------------------------------------------------------------------------
const transit = [
  { batch: 'transit-001', notice_id: 'T-0001', revision: 1, sku: 'SKU-ALPHA', location: 'WH-A', qty: 300, unit: 'EA', status: 'in_transit', dispatched_at: T('2026-03-18T06:00:00Z'), eta_at: T('2026-03-25T18:00:00Z'), received_event_id: '', note: 'fictional carrier NS-42' },
  { batch: 'transit-001', notice_id: 'T-0001', revision: 2, sku: 'SKU-ALPHA', location: 'WH-A', qty: 300, unit: 'EA', status: 'in_transit', dispatched_at: T('2026-03-18T06:00:00Z'), eta_at: T('2026-03-28T18:00:00Z'), received_event_id: '', note: 'carrier rebooked, now NS-57' },
  { batch: 'transit-001', notice_id: 'T-0002', revision: 1, sku: 'SKU-BETA', location: 'WH-A', qty: 6, unit: 'BOX', status: 'received', dispatched_at: T('2026-02-27T06:00:00Z'), eta_at: T('2026-03-02T10:00:00Z'), received_event_id: transitReceipt.event_id, note: `received and posted as ${transitReceipt.event_id}` },
  { batch: 'transit-001', notice_id: 'T-0003', revision: 1, sku: 'SKU-ALPHA', location: 'WH-B', qty: 50, unit: 'EA', status: 'cancelled', dispatched_at: T('2026-03-01T06:00:00Z'), eta_at: T('2026-03-06T18:00:00Z'), received_event_id: '', note: 'supplier cancelled' },
  { batch: 'transit-002', notice_id: 'T-0004', revision: 1, sku: 'SKU-GAMMA', location: 'WH-B', qty: 25, unit: 'KG', status: 'in_transit', dispatched_at: T('2026-03-24T06:00:00Z'), eta_at: T('2026-03-30T09:00:00Z'), received_event_id: '', note: 'fictional carrier NS-51' },
  { batch: 'transit-002', notice_id: 'T-0004', revision: 2, sku: 'SKU-GAMMA', location: 'WH-B', qty: 25, unit: 'KG', status: 'delayed', dispatched_at: T('2026-03-24T06:00:00Z'), eta_at: T('2026-04-02T09:00:00Z'), received_event_id: '', note: 'held at fictional customs' },
  { batch: 'transit-002', notice_id: 'T-0005', revision: 1, sku: 'SKU-BETA', location: 'WH-A', qty: 10, unit: 'BOX', status: 'in_transit', dispatched_at: T('2026-03-29T06:00:00Z'), eta_at: T('2026-04-04T12:00:00Z'), received_event_id: '', note: 'fictional carrier NS-63' },
];

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------
const csvEscape = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function writeCsv(rows, rel) {
  const cols = ['event_id', 'sku', 'location', 'kind', 'qty', 'unit', 'effective_at', 'recorded_at', 'reverses_event_id', 'reason', 'operator'];
  fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(outDir, rel), [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n') + '\n');
}
function writeJsonl(rows, rel) {
  fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(outDir, rel), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function writeJson(rows, rel) {
  fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(outDir, rel), JSON.stringify(rows, null, 2) + '\n');
}

const strip = (r, keys) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
const ledgerBatches = ['ledger-001', 'ledger-002', 'ledger-003', 'ledger-004'];
for (const b of ledgerBatches) {
  const rows = ledger.filter((r) => r.batch === b).sort((x, y) => x.effective_at.localeCompare(y.effective_at));
  writeCsv(rows.map((r) => strip(r, ['batch'])), `ledger/${b}.csv`);
}
const snapshotBatches = ['snapshot-001', 'snapshot-002', 'snapshot-003'];
for (const b of snapshotBatches) {
  writeJsonl(snapshots.filter((r) => r.batch === b).map((r) => strip(r, ['batch'])), `snapshots/${b}.jsonl`);
}
const transitBatches = ['transit-001', 'transit-002'];
for (const b of transitBatches) {
  writeJson(transit.filter((r) => r.batch === b).map((r) => strip(r, ['batch'])), `transit/${b}.json`);
}

// Deliberately broken batch: one unknown SKU, one bad timestamp. Whole batch must fail.
writeCsv([
  { event_id: 'L-9001', sku: 'SKU-ALPHA', location: 'WH-A', kind: 'receipt', qty: 10, unit: 'EA', effective_at: '2026-04-06T09:00:00Z', recorded_at: '2026-04-06T09:00:00Z', reason: 'fixture', operator: 'fixture' },
  { event_id: 'L-9002', sku: 'SKU-NOPE', location: 'WH-A', kind: 'receipt', qty: 10, unit: 'EA', effective_at: '2026-04-06T10:00:00Z', recorded_at: '2026-04-06T10:00:00Z', reason: 'fixture', operator: 'fixture' },
  { event_id: 'L-9003', sku: 'SKU-ALPHA', location: 'WH-A', kind: 'receipt', qty: 10, unit: 'EA', effective_at: 'not-a-date', recorded_at: '2026-04-06T11:00:00Z', reason: 'fixture', operator: 'fixture' },
], 'ledger/ledger-006-bad.csv');

const outage = [{ sku: 'SKU-ALPHA', location: 'WH-A', start_at: T('2026-03-05T00:00:00Z'), end_at: T('2026-03-08T00:00:00Z'), reason: 'connector_outage', detail: { ticket: 'FIC-1042', note: 'fictional WMS export down for the weekend' } }];
const batches = [
  { batch_id: 'ledger-001', stream: 'ledger', file: 'ledger/ledger-001.csv', format: 'csv', received_at: T('2026-02-02T06:00:00Z') },
  { batch_id: 'snapshot-001', stream: 'snapshot', file: 'snapshots/snapshot-001.jsonl', format: 'jsonl', received_at: T('2026-03-02T06:00:00Z') },
  { batch_id: 'ledger-002', stream: 'ledger', file: 'ledger/ledger-002.csv', format: 'csv', received_at: T('2026-03-10T06:00:00Z'), declared_coverage: outage },
  { batch_id: 'transit-001', stream: 'transit', file: 'transit/transit-001.json', format: 'json', received_at: T('2026-03-10T07:00:00Z') },
  { batch_id: 'ledger-003', stream: 'ledger', file: 'ledger/ledger-003.csv', format: 'csv', received_at: T('2026-03-31T06:00:00Z') },
  { batch_id: 'snapshot-002', stream: 'snapshot', file: 'snapshots/snapshot-002.jsonl', format: 'jsonl', received_at: T('2026-04-02T06:00:00Z') },
  { batch_id: 'ledger-004', stream: 'ledger', file: 'ledger/ledger-004.csv', format: 'csv', received_at: T('2026-04-05T06:00:00Z') },
  { batch_id: 'transit-002', stream: 'transit', file: 'transit/transit-002.json', format: 'json', received_at: T('2026-04-06T06:00:00Z'), declared_coverage: [{ sku: 'SKU-BETA', location: 'WH-A', start_at: T('2026-03-27T00:00:00Z'), end_at: T('2026-03-30T00:00:00Z'), reason: 'connector_outage', detail: { ticket: 'FIC-1101' } }] },
  { batch_id: 'snapshot-003', stream: 'snapshot', file: 'snapshots/snapshot-003.jsonl', format: 'jsonl', received_at: T('2026-04-06T07:00:00Z') },
  // Redelivery of an already-accepted batch: must be detected as a duplicate, not re-applied.
  { batch_id: 'ledger-002-redelivery', stream: 'ledger', file: 'ledger/ledger-002.csv', format: 'csv', received_at: T('2026-04-07T06:00:00Z'), declared_coverage: outage },
  // A batch with two bad rows: all-or-nothing.
  { batch_id: 'ledger-006-bad', stream: 'ledger', file: 'ledger/ledger-006-bad.csv', format: 'csv', received_at: T('2026-04-07T07:00:00Z') },
];
const manifest = {
  dataset: 'fictional-warehouse-2026',
  note: 'Every identifier and counterparty is invented; no real stock movements or replenishment decisions.',
  connectors: {
    ledger: { name: 'fictional-wms-export', batch_id: 'ledger-004' },
    snapshot: { name: 'fictional-handheld-counts', batch_id: 'snapshot-003' },
    transit: { name: 'fictional-carrier-feed', batch_id: 'transit-002' },
  },
  unit_rules: UNIT_RULES,
  periods: [
    { label: '2026-01', start_at: T('2026-01-01T00:00:00Z'), end_at: T('2026-02-01T00:00:00Z') },
    { label: '2026-02', start_at: T('2026-02-01T00:00:00Z'), end_at: T('2026-03-01T00:00:00Z') },
    { label: '2026-03', start_at: T('2026-03-01T00:00:00Z'), end_at: T('2026-04-01T00:00:00Z') },
    { label: '2026-04', start_at: T('2026-04-01T00:00:00Z'), end_at: T('2026-05-01T00:00:00Z') },
  ],
  skus: SKUS,
  locations: LOCATIONS,
  batches,
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Fixture self-check: independent arithmetic over the source rows.
// ---------------------------------------------------------------------------
function factorAt(unit, at) {
  const hits = UNIT_RULES.filter((u) => u.unit === unit && u.effective_from <= at && (!u.effective_to || at < u.effective_to));
  if (hits.length !== 1) throw new Error(`fixture unit lookup ambiguous for ${unit} at ${at}`);
  return hits[0].factor_to_base;
}
function signedBase(r) {
  const f = factorAt(r.unit, r.effective_at);
  if (r.kind === 'issue') return -Math.abs(r.qty) * f;
  if (r.kind === 'reversal') return Math.abs(r.qty) * f; // adds back what the issue removed
  return r.qty * f;
}
const opening = (sku, loc) => snapshots.filter((s) => s.snapshot_id === `C-2026-01-01-${sku.slice(4)}-${loc.slice(-1)}`).reduce((a, s) => a + s.qty * factorAt(s.unit, s.effective_at), 0);
const ledgerSum = (sku, loc) => ledger.filter((r) => r.sku === sku && r.location === loc).reduce((a, r) => a + signedBase(r), 0);
const aprilCount = (sku, loc) => snapshots.filter((s) => s.snapshot_id === `C-2026-04-01-${sku.slice(4)}-${loc.slice(-1)}` && s.revision === 1).reduce((a, s) => a + s.qty * factorAt(s.unit, s.effective_at), 0);
const keys = [['SKU-ALPHA', 'WH-A'], ['SKU-ALPHA', 'WH-B'], ['SKU-BETA', 'WH-A'], ['SKU-GAMMA', 'WH-B']];
const check = keys.map(([sku, location]) => {
  const open = opening(sku, location);
  const moves = ledgerSum(sku, location);
  const counted = aprilCount(sku, location);
  return { sku, location, opening: open, ledger_delta: moves, replay_total: open + moves, april_count: counted, count_minus_replay: counted - (open + moves) };
});
// These expectations are the hand-computed truth for the fixture; guard against typos.
const EXPECT = {
  'SKU-ALPHA/WH-A': { opening: 500, moves: 335, count: 835, variance: 0 },
  'SKU-ALPHA/WH-B': { opening: 120, moves: 60, count: 90, variance: -90 },
  'SKU-BETA/WH-A': { opening: 360, moves: 196, count: 560, variance: 4 },
  'SKU-GAMMA/WH-B': { opening: 80, moves: 108.5, count: 190, variance: 1.5 },
};
for (const row of check) {
  const e = EXPECT[`${row.sku}/${row.location}`];
  for (const field of ['opening', 'moves', 'count', 'variance']) {
    const actual = field === 'moves' ? row.ledger_delta : field === 'count' ? row.april_count : field === 'variance' ? row.count_minus_replay : row.opening;
    if (actual !== e[field]) throw new Error(`${row.sku}/${row.location} ${field} ${actual} != ${e[field]}`);
  }
}

console.log(JSON.stringify({
  out: outDir,
  files: { ledger: ledgerBatches.length, snapshots: snapshotBatches.length, transit: transitBatches.length, batches: batches.length },
  rows: { ledger: ledger.length, snapshots: snapshots.length, transit: transit.length },
  reconciliation: check,
}, null, 2));
