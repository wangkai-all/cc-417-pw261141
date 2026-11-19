#!/usr/bin/env node
/**
 * One-shot, end-to-end demonstration on fictional data.
 *
 *   rm -rf artifacts data && npm run demo
 *
 * Generates the dataset, ingests it through the connector path, rebuilds a set of
 * cuts, shows an aborted rebuild resuming to the same digest, compares two cuts,
 * and records a manual count revision plus a ledger correction. Every number is
 * printed with the rows that explain it. Nothing here is a stock or replenishment
 * decision: the dataset is invented and the outputs are purely analytical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, counts } from '../src/lib/store.js';
import { ingestManifest } from '../src/lib/ingest.js';
import { executePlan, loadCutview, openRun, planCutview } from '../src/lib/cutview.js';
import { diffCutviews, persistDiff } from '../src/lib/diff.js';
import { addCount, correctLedgerMovement } from '../src/lib/manual.js';
import { newId, fmtQty } from '../src/lib/util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'artifacts', 'cutview.db');
const dataDir = path.join(root, 'data');

const say = (s = '') => process.stdout.write(`${s}\n`);
const head = (s) => say(`\n\x1b[1m${s}\x1b[0m\n${'─'.repeat(Math.min(s.length + 8, 78))}`);
const kv = (k, v) => say(`  ${k.padEnd(26)} ${v}`);

function run(script, args) {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) {
    process.stderr.write(res.stderr || res.stdout);
    throw new Error(`${script} exited ${res.status}`);
  }
  return res.stdout;
}

head('1. Generate the fictional dataset');
const generated = JSON.parse(run('generate-data.js', ['--out', dataDir, '--reset']));
kv('files', `${generated.files.ledger} ledger, ${generated.files.snapshots} snapshot, ${generated.files.transit} transit`);
kv('rows', `${generated.rows.ledger} ledger, ${generated.rows.snapshots} counts, ${generated.rows.transit} notices`);
for (const r of generated.reconciliation) {
  kv(`${r.sku}/${r.location}`, `opening ${r.opening} + ledger ${fmtQty(r.ledger_delta)} = replay ${fmtQty(r.replay_total)}; April count ${r.april_count}; variance ${fmtQty(r.count_minus_replay)}`);
}

head('2. Ingest: three independent streams, all-or-nothing batches');
fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
const db = openStore(dbPath);
const ingested = ingestManifest(path.join(dataDir, 'manifest.json'), { db });
for (const b of ingested.batches) {
  const note = b.status === 'rejected' ? `REJECTED — ${b.reason}` : b.status === 'duplicate' ? 'duplicate redelivery — nothing re-applied' : `${b.accepted} rows accepted`;
  kv(b.batch_id, `${b.stream}: ${note}`);
}
kv('totals', JSON.stringify(counts(db)));

head('3. Rebuild cuts from the last trusted count');
const requests = [
  { sku: 'SKU-ALPHA', location: 'WH-A', at: '2026-01-15T00:00:00Z', knowledge_at: '2026-04-10T00:00:00Z' },
  { sku: 'SKU-ALPHA', location: 'WH-A', at: '2026-03-20T00:00:00Z', knowledge_at: '2026-04-10T00:00:00Z' },
  { sku: 'SKU-ALPHA', location: 'WH-A', at: '2026-04-01T00:00:00Z', knowledge_at: '2026-04-10T00:00:00Z' },
  { sku: 'SKU-BETA', location: 'WH-A', at: '2026-04-01T00:00:00Z', knowledge_at: '2026-04-10T00:00:00Z' },
  { sku: 'SKU-GAMMA', location: 'WH-A', at: '2026-04-01T00:00:00Z', knowledge_at: '2026-04-10T00:00:00Z' },
];
const made = [];
for (const req of requests) {
  const plan = planCutview(db, req);
  plan.run_id = newId('run');
  openRun(db, plan, { runId: plan.run_id });
  const res = executePlan(db, plan);
  const cv = loadCutview(db, res.cutview_id);
  made.push(cv);
  const qty = cv.qty_base == null ? 'no quantity (no anchor)' : `${fmtQty(cv.qty_base)} ${cv.unit_base}`;
  kv(`${cv.sku}/${cv.location} @ ${cv.at_iso.slice(0, 10)}`, `${qty} · ${cv.status} · confidence ${Math.round(cv.confidence * 100)}%`);
  if (cv.anchor.snapshot_id) {
    kv('  anchor', `${cv.anchor.snapshot_id}@r${cv.anchor.revision} = ${fmtQty(cv.anchor.qty_base)} ${cv.anchor.unit_base}`);
    kv('  replayed', cv.deltas.length ? cv.deltas.map((d) => `${d.event_id} ${d.delta_base > 0 ? '+' : ''}${fmtQty(d.delta_base)}`).join(', ') : 'none');
  }
  for (const u of cv.unverified) kv('  unverified', `${u.start_at.slice(0, 10)} → ${u.end_at.slice(0, 10)} (${u.reason})`);
  if (cv.warnings.length) kv('  warnings', cv.warnings.map((w) => w.code).join(', '));
}

head('4. Simulate the rebuild process exiting mid-flight, then resume');
const crashReq = { sku: 'SKU-ALPHA', location: 'WH-A', at: '2026-04-01T00:00:00Z', knowledge_at: '2026-04-10T00:00:00Z' };
const abortedPlan = planCutview(db, crashReq);
abortedPlan.run_id = newId('run');
openRun(db, abortedPlan, { runId: abortedPlan.run_id });
try {
  executePlan(db, abortedPlan, { crashAfter: 4 });
} catch (err) {
  if (err.code !== 'SIMULATED_CRASH') throw err;
  const run = db.prepare('SELECT * FROM rebuild_runs WHERE run_id = ?').get(abortedPlan.run_id);
  kv('simulated exit', `after ${run.steps_done}/${run.steps_total} steps (${run.status}); published cutviews for this run: ${db.prepare('SELECT COUNT(*) AS n FROM cutviews WHERE run_id = ?').get(run.run_id).n}`);
  kv('checkpoints', `${db.prepare('SELECT COUNT(*) AS n FROM rebuild_checkpoints WHERE run_id = ?').get(run.run_id).n} written before exit`);
}
const lastCp = db.prepare('SELECT * FROM rebuild_checkpoints WHERE run_id = ? ORDER BY step DESC LIMIT 1').get(abortedPlan.run_id);
const resumed = planCutview(db, crashReq);
resumed.run_id = newId('run');
resumed.resume_from_step = lastCp.step + 1;
resumed.resume_state = JSON.parse(lastCp.payload);
resumed.resumed_from_run = abortedPlan.run_id;
resumed.units = db.prepare('SELECT * FROM unit_rules ORDER BY unit, version').all();
openRun(db, resumed, { runId: resumed.run_id, resumedFrom: abortedPlan.run_id, resumeFromStep: resumed.resume_from_step });
const resumedResult = executePlan(db, resumed);
const plain = makePlain(db, crashReq);
kv('resumed from step', String(resumed.resume_from_step));
kv('resumed cutview', `${resumedResult.cutview_id} = ${fmtQty(loadCutview(db, resumedResult.cutview_id).qty_base)} ${loadCutview(db, resumedResult.cutview_id).unit_base}`);
kv('clean-replay digest', plain.digest);
kv('identical digest', String(plain.digest === loadCutview(db, resumedResult.cutview_id).digest));

head('5. Compare two cuts and attribute the difference');
const early = made.find((c) => c.sku === 'SKU-ALPHA' && c.at_iso.startsWith('2026-01-15'));
const late = made.find((c) => c.sku === 'SKU-ALPHA' && c.at_iso.startsWith('2026-04-01'));
const report = persistDiff(db, diffCutviews(early, late, { periods: db.prepare('SELECT * FROM periods ORDER BY start_at').all() }));
kv('cuts', `${early.cutview_id} → ${late.cutview_id}`);
kv('quantity', `${fmtQty(report.a.qty_base)} → ${fmtQty(report.b.qty_base)} (${report.qty_delta_base >= 0 ? '+' : ''}${fmtQty(report.qty_delta_base)} ${report.unit_base})`);
kv('identity', report.explanation.identity);
kv('unattributed', fmtQty(report.explanation.unattributed_base));
kv('reconciles', String(report.explanation.reconciles));
kv('anchor change', `${report.explanation.anchor_change.kind} (${fmtQty(report.explanation.anchor_delta_base)})`);
kv('movements', report.explanation.movement_effects.map((m) => `${m.event_id} ${m.kind} ${m.delta_base > 0 ? '+' : ''}${fmtQty(m.delta_base)}`).join(', ') || 'none');
for (const p of report.periods) kv(`period ${p.period}`, `${p.delta >= 0 ? '+' : ''}${fmtQty(p.delta)} across ${p.count} movement(s)`);

head('6. Manual entry: count revision and ledger correction (append-only)');
const count = addCount(db, dbPath, {
  sku: 'SKU-ALPHA', location: 'WH-A',
  counted_at: '2026-04-02T09:00:00Z', effective_at: '2026-04-01T00:00:00Z',
  qty: 834, unit: 'EA', snapshot_id: 'C-2026-04-01-ALPHA-A', reason: 'recount after a keying error on the cycle sheet',
});
kv('count revision', `${count.snapshot.snapshot_id}@r${count.snapshot.revision} = ${fmtQty(count.snapshot.qty)} ${count.snapshot.unit}`);
kv('ledger touched', count.ledger_untouched ? 'no' : 'YES (unexpected)');
kv('batch written', count.batch.batch_id);
kv('note', count.revision_note);

const correction = correctLedgerMovement(db, dbPath, {
  event_id: 'L-0023', qty: 2, unit: 'BOX', effective: 'restate', reason: 'the consolidation moved two cartons, not one',
});
kv('original retained', `${correction.original.event_id} stays at ${fmtQty(correction.original.qty_input)} ${correction.original.unit_input} (${fmtQty(correction.original.delta_base)} ${correction.original.unit_base})`);
kv('rows overwritten', String(correction.overwritten_rows));
for (const row of correction.appended) kv(`appended ${row.kind}`, `${row.event_id} ${fmtQty(row.qty)} ${row.unit} @ ${row.effective_at}`);
kv('mode', correction.mode_note);

head('7. Result');
kv('cutviews stored', String(db.prepare('SELECT COUNT(*) AS n FROM cutviews').get().n));
kv('rejected batches', String(db.prepare("SELECT COUNT(*) AS n FROM batches WHERE status='rejected'").get().n));
kv('duplicate batches', String(db.prepare("SELECT COUNT(*) AS n FROM batches WHERE status='duplicate'").get().n));
kv('database', dbPath);
say('\nOpen the console:  npm run server   →  http://localhost:4173');
say('Nothing in this run records or recommends a real stock movement or replenishment.\n');

/** Independent clean replay used only to prove the resumed digest matches. */
function makePlain(database, req) {
  const plan = planCutview(database, req);
  plan.run_id = newId('run');
  openRun(database, plan, { runId: plan.run_id });
  const res = executePlan(database, plan);
  return loadCutview(database, res.cutview_id);
}
