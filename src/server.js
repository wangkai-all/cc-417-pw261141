#!/usr/bin/env node
/**
 * Local web console. Node built-ins only; no dependencies to install.
 * Every mutation goes to disk as a connector batch and then through the same
 * ingester the CLI uses, so the web path cannot bypass validation or idempotency.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, newId, nowIso, fmtQty } from './lib/util.js';
import { openStore, defaultDbPath, keysOf, counts } from './lib/store.js';
import { ingestManifest } from './lib/ingest.js';
import { planCutview, openRun, executePlan, loadCutview, hydrateCutview, CUT_STATUS } from './lib/cutview.js';
import { diffCutviews, persistDiff } from './lib/diff.js';
import { normalizeCutRequest } from './lib/request.js';
import { addCount, correctLedgerMovement } from './lib/manual.js';

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 4173);
const dbPath = args.db ?? defaultDbPath();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const allowed = new Set(['http://localhost:' + port, 'http://127.0.0.1:' + port]);

// One connection for the process. The server is single-threaded and every handler
// is synchronous, so a shared connection serialises naturally; opening a fresh
// SQLite handle per request would just leak file descriptors.
const db = openStore(dbPath);

// ---- request plumbing ------------------------------------------------------
const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
};
const fail = (res, err, status = 400) => json(res, err.code === 'SIMULATED_CRASH' ? 409 : status, { error: err.message, code: err.code ?? 'BAD_REQUEST', detail: err.detail ?? null });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resolve(parsed);
        else reject(Object.assign(new Error('body must be a JSON object'), { code: 'BODY_INVALID' }));
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON: ${err.message}`), { code: 'BODY_INVALID' }));
      }
    });
    req.on('error', reject);
  });
}

function checkOrigin(req) {
  // CSRF guard for a local tool: reject cross-origin form posts outright.
  const origin = req.headers.origin;
  if (!origin) return true;
  return allowed.has(origin);
}

// ---- API ------------------------------------------------------------------
function snapshotState(db) {
  const batchRows = db.prepare('SELECT batch_id,stream,source_file,received_at,accepted_count,rejected_count,duplicate_count,status FROM batches ORDER BY received_at, batch_id').all();
  const keyRows = keysOf(db);
  return {
    counts: counts(db),
    manifest: (() => {
      const row = db.prepare("SELECT value FROM meta WHERE key='manifest'").get();
      return row ? JSON.parse(row.value) : null;
    })(),
    batches: batchRows,
    rejected: db.prepare('SELECT batch_id,stream,stream_key,source_line,code,message FROM rejected_rows ORDER BY id').all(),
    keys: keyRows.map((k) => {
      const snap = db.prepare('SELECT snapshot_id,revision,effective_at,counted_at,qty_base,unit_base FROM snapshots WHERE sku=? AND location=? ORDER BY effective_at DESC, revision DESC LIMIT 1').get(k.sku, k.location);
      const led = db.prepare('SELECT COUNT(*) AS n, MIN(effective_at) AS first_at, MAX(effective_at) AS last_at FROM ledger_entries WHERE sku=? AND location=?').get(k.sku, k.location);
      return { ...k, latest_count: snap ?? null, ledger_rows: led.n, ledger_first: led.first_at, ledger_last: led.last_at };
    }),
    connectors: db.prepare('SELECT * FROM connectors ORDER BY stream').all(),
    unit_rules: db.prepare('SELECT * FROM unit_rules ORDER BY unit, version').all(),
    periods: db.prepare('SELECT * FROM periods ORDER BY start_at').all(),
    cutviews: db.prepare('SELECT cutview_id,sku,location,at_iso,knowledge_at,status,qty_base,unit_base,confidence,run_id,rebuilt_from,digest FROM cutviews ORDER BY requested_at DESC LIMIT 200').all(),
    runs: db.prepare('SELECT * FROM rebuild_runs ORDER BY started_at DESC LIMIT 50').all(),
    diffs: db.prepare('SELECT diff_id,a_cutview_id,b_cutview_id,created_at,digest FROM diffs ORDER BY created_at DESC LIMIT 50').all(),
    snapshots: db.prepare(`SELECT s.snapshot_id,s.revision,s.sku,s.location,s.counted_at,s.effective_at,s.qty_base,s.unit_base,s.qty_counted,s.unit_counted,s.unit_version,s.superseded_by_revision,s.reason,s.batch_id
                            FROM snapshots s ORDER BY s.effective_at DESC, s.snapshot_id, s.revision DESC`).all(),
    ledger: db.prepare(`SELECT l.event_id,l.sku,l.location,l.kind,l.delta_base,l.unit_base,l.qty_input,l.unit_input,l.unit_version,l.effective_at,l.recorded_at,l.reversed_event_id,l.correction_of,l.reason,l.batch_id
                          FROM ledger_entries l ORDER BY l.effective_at DESC, l.id DESC LIMIT 300`).all(),
    transit: db.prepare('SELECT notice_id,revision,sku,location,qty_base,unit_base,qty_noticed,unit_noticed,status,eta_at,received_event_id,superseded_by_revision,batch_id FROM transit_notices ORDER BY notice_id, revision').all(),
    coverage: db.prepare('SELECT stream,sku,location,ack_id,start_at,end_at,reason,detail,batch_id FROM coverage ORDER BY start_at').all(),
  };
}

function runCutview(db, body) {
  const req = normalizeCutRequest(body, { defaultKnowledge: 'now' });
  const plan = planCutview(db, req);
  const runId = newId('run');
  plan.run_id = runId;
  openRun(db, plan, { runId });
  try {
    const result = executePlan(db, plan, { crashAfter: req.crashAfter });
    return { ok: true, cutview: loadCutview(db, result.cutview_id), run_id: runId };
  } catch (err) {
    if (err.code === 'SIMULATED_CRASH') {
      const run = db.prepare('SELECT * FROM rebuild_runs WHERE run_id = ?').get(runId);
      const published = db.prepare('SELECT cutview_id FROM cutviews WHERE run_id = ?').get(runId);
      return {
        ok: false,
        simulated_exit: true,
        run_id: runId,
        message: run.note,
        steps_done: run.steps_done,
        steps_total: run.steps_total,
        published_cutview: published?.cutview_id ?? null,
        hint: 'Nothing partial was published. Resume replays from the last checkpoint.',
      };
    }
    throw err;
  }
}

function resumeRun(db, body) {
  const runId = body.run_id ? String(body.run_id) : null;
  const run = runId
    ? db.prepare('SELECT * FROM rebuild_runs WHERE run_id = ?').get(runId)
    : db.prepare("SELECT * FROM rebuild_runs WHERE status='aborted' ORDER BY started_at DESC LIMIT 1").get();
  if (!run) throw Object.assign(new Error('no aborted run to resume'), { code: 'NO_RESUMABLE_RUN' });
  if (run.status !== 'aborted') throw Object.assign(new Error(`run ${run.run_id} is ${run.status}, not aborted`), { code: 'RUN_NOT_ABORTED' });
  const last = db.prepare('SELECT * FROM rebuild_checkpoints WHERE run_id = ? ORDER BY step DESC LIMIT 1').get(run.run_id);
  if (!last) throw Object.assign(new Error('aborted run has no checkpoints'), { code: 'NO_CHECKPOINT' });
  const state = JSON.parse(last.payload);
  const plan = planCutview(db, { sku: run.sku, location: run.location, at: run.at_iso, knowledge_at: run.knowledge_at, mode: run.mode, baseline_cutview_id: state.baseline?.baseline_cutview_id ?? null });
  const newRunId = newId('run');
  plan.run_id = newRunId;
  plan.resumed_from_run = run.run_id;
  plan.resume_from_step = last.step + 1;
  plan.resume_state = state;
  plan.units = db.prepare('SELECT * FROM unit_rules ORDER BY unit, version').all();
  db.prepare('UPDATE rebuild_runs SET note = ? WHERE run_id = ?').run(`resumed by ${newRunId} from step ${last.step + 1}`, run.run_id);
  openRun(db, plan, { runId: newRunId, resumedFrom: run.run_id, resumeFromStep: last.step + 1 });
  const result = executePlan(db, plan, { crashAfter: null });
  return { ok: true, resumed_from: run.run_id, resumed_at_step: last.step + 1, run_id: newRunId, cutview: loadCutview(db, result.cutview_id) };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;

  if (method === 'GET' && parts[0] === 'state') return json(res, 200, snapshotState(db));
  if (method === 'GET' && parts[0] === 'cutviews' && parts[1]) {
    const cut = loadCutview(db, parts[1]);
    if (!cut) return json(res, 404, { error: 'cutview not found' });
    const run = cut.run_id ? db.prepare('SELECT * FROM rebuild_runs WHERE run_id = ?').get(cut.run_id) : null;
    return json(res, 200, { cutview: cut, run });
  }
  if (method === 'GET' && parts[0] === 'runs' && parts[1]) {
    const run = db.prepare('SELECT * FROM rebuild_runs WHERE run_id = ?').get(parts[1]);
    if (!run) return json(res, 404, { error: 'run not found' });
    return json(res, 200, {
      run,
      checkpoints: db.prepare('SELECT step,kind,state_digest,created_at FROM rebuild_checkpoints WHERE run_id = ? ORDER BY step').all(run.run_id),
      cutviews: db.prepare('SELECT cutview_id,status,qty_base,unit_base FROM cutviews WHERE run_id = ?').all(run.run_id),
    });
  }
  if (method === 'GET' && parts[0] === 'diffs' && parts[1]) {
    const row = db.prepare('SELECT * FROM diffs WHERE diff_id = ?').get(parts[1]);
    if (!row) return json(res, 404, { error: 'diff not found' });
    return json(res, 200, JSON.parse(row.report));
  }
  if (method === 'POST' && parts[0] === 'ingest') {
    const body = await readBody(req);
    if (!body.manifest) throw Object.assign(new Error('manifest path is required'), { code: 'MANIFEST_REQUIRED' });
    const manifestPath = path.resolve(String(body.manifest));
    const result = ingestManifest(manifestPath, { db });
    return json(res, 200, { ok: true, ...result, state: snapshotState(db) });
  }
  if (method === 'POST' && parts[0] === 'cutviews') {
    const body = await readBody(req);
    const result = runCutview(db, body);
    return json(res, result.ok ? 201 : 409, { ...result, state: snapshotState(db) });
  }
  if (method === 'POST' && parts[0] === 'runs' && parts[1] === 'resume') {
    const body = await readBody(req);
    const result = resumeRun(db, body);
    return json(res, 200, { ...result, state: snapshotState(db) });
  }
  if (method === 'POST' && parts[0] === 'diffs') {
    const body = await readBody(req);
    const a = loadCutview(db, String(body.a ?? ''));
    const b = loadCutview(db, String(body.b ?? ''));
    if (!a || !b) throw Object.assign(new Error('both cutviews must exist'), { code: 'CUTVIEW_NOT_FOUND' });
    const periods = db.prepare('SELECT * FROM periods ORDER BY start_at').all();
    const report = persistDiff(db, diffCutviews(a, b, { periods }));
    return json(res, 201, report);
  }
  if (method === 'POST' && parts[0] === 'counts') {
    const body = await readBody(req);
    const result = addCount(db, dbPath, body);
    return json(res, 201, { ok: true, ...result, state: snapshotState(db) });
  }
  if (method === 'POST' && parts[0] === 'ledger' && parts[1] === 'correct') {
    const body = await readBody(req);
    const result = correctLedgerMovement(db, dbPath, body);
    return json(res, 201, { ok: true, ...result, state: snapshotState(db) });
  }
  if (method === 'GET' && parts[0] === 'export') {
    const cut = loadCutview(db, parts[1]);
    if (!cut) return json(res, 404, { error: 'cutview not found' });
    return json(res, 200, cut);
  }
  return json(res, 404, { error: 'unknown endpoint' });
}

// ---- static files ---------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = path.resolve(publicDir, rel);
  if (!abs.startsWith(publicDir + path.sep) && abs !== path.join(publicDir, 'index.html')) return json(res, 403, { error: 'forbidden' });
  let body;
  try {
    body = fs.readFileSync(abs);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const isApi = url.pathname.startsWith('/api/');
  if (!checkOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
  if (!isApi) {
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'method not allowed' });
    return serveStatic(res, url.pathname);
  }
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'method not allowed' });
  try {
    await handleApi(req, res, url);
  } catch (err) {
    if (process.env.DEBUG) console.error(err);
    const status = err.code === 'MANUAL_BATCH_REJECTED' || err.code === 'CUTVIEW_NOT_FOUND' ? 422 : err.code === 'NO_RESUMABLE_RUN' || err.code === 'RUN_NOT_ABORTED' ? 409 : 400;
    fail(res, err, status);
  }
});

server.listen(port, () => {
  process.stdout.write(`cutview console: http://localhost:${port}\n`);
  process.stdout.write(`database: ${path.resolve(dbPath)}\n`);
});
