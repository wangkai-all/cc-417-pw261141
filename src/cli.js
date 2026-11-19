#!/usr/bin/env node
import path from 'node:path';
import { parseArgs, newId } from './lib/util.js';
import { openStore, defaultDbPath, keysOf, counts } from './lib/store.js';
import { ingestManifest } from './lib/ingest.js';
import { planCutview, openRun, executePlan, loadCutview, hydrateCutview } from './lib/cutview.js';
import { diffCutviews, persistDiff } from './lib/diff.js';
import { normalizeCutRequest } from './lib/request.js';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const dbPath = args.db ?? defaultDbPath();

function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
function fail(err) {
  process.stderr.write(JSON.stringify({ error: err.message, code: err.code ?? 'ERROR', detail: err.detail ?? null }, null, 2) + '\n');
  process.exitCode = 1;
}

function requireArg(name) {
  if (!args[name] || args[name] === true) throw new Error(`--${name} is required`);
  return String(args[name]);
}

const commands = {
  ingest() {
    const db = openStore(dbPath);
    const result = ingestManifest(path.resolve(requireArg('manifest')), { db });
    out({ database: dbPath, ...result, totals: counts(db) });
  },
  rebuild() {
    const db = openStore(dbPath);
    const req = normalizeCutRequest(
      {
        sku: requireArg('sku'), location: requireArg('location'), at: requireArg('at'),
        knowledge_at: args['knowledge-at'] ?? args.knowledge_at ?? 'now',
        mode: args.mode ?? 'replay', baseline_cutview_id: args['baseline-cutview'] ?? args.baseline_cutview_id,
        crash_after: args['crash-after'] ?? args.crash_after,
      },
      { defaultKnowledge: 'now' },
    );
    const plan = planCutview(db, req);
    const runId = newId('run');
    const resume = Boolean(args.resume);
    let startStep = 0;
    let resumeState = null;
    let resumedFrom = null;
    if (resume) {
      const run = args.run ? db.prepare('SELECT * FROM rebuild_runs WHERE run_id = ?').get(String(args.run)) : db.prepare("SELECT * FROM rebuild_runs WHERE status='aborted' ORDER BY started_at DESC LIMIT 1").get();
      if (!run) throw new Error('no aborted run to resume');
      if (run.status !== 'aborted') throw new Error(`run ${run.run_id} is ${run.status}, not aborted`);
      const last = db.prepare('SELECT * FROM rebuild_checkpoints WHERE run_id = ? ORDER BY step DESC LIMIT 1').get(run.run_id);
      if (!last) throw new Error('aborted run has no checkpoints to resume from');
      startStep = last.step + 1;
      resumeState = JSON.parse(last.payload);
      resumedFrom = run.run_id;
      plan.sku = run.sku; plan.location = run.location; plan.at = run.at_iso; plan.knowledge_at = run.knowledge_at;
      plan.mode = run.mode; plan.baseline_cutview_id = run.mode === 'incremental' ? (resumeState.baseline?.baseline_cutview_id ?? null) : null;
      plan.resume_from_step = startStep;
      plan.resume_state = resumeState;
      // The reference rule table is re-read from the store; the assembled unit report
      // (if the checkpoint has passed `assemble`) lives in resumeState and wins.
      plan.units = db.prepare('SELECT * FROM unit_rules ORDER BY unit, version').all();
      // A resume is a new run record that points at the aborted one; the aborted
      // record is closed out separately so both halves stay in the audit trail.
      plan.run_id = runId;
      plan.resumed_from_run = run.run_id;
      db.prepare("UPDATE rebuild_runs SET note = ? WHERE run_id = ?").run(`resumed by ${runId} from step ${startStep}`, run.run_id);
      openRun(db, plan, { runId, resumedFrom, resumeFromStep: startStep });
    } else {
      plan.run_id = runId;
      openRun(db, plan, { runId });
    }
    try {
      const result = executePlan(db, plan, { crashAfter: resume ? null : req.crashAfter });
      out({ database: dbPath, run_id: runId, resumed_from: resumedFrom, resumed_at_step: startStep, cutview_id: result.cutview_id, status: result.status, qty_base: result.payload.qty_base, unit_base: result.payload.unit_base, confidence: result.payload.confidence, anchor: result.payload.anchor.snapshot_id ? `${result.payload.anchor.snapshot_id}@r${result.payload.anchor.revision}` : null, unverified: result.payload.unverified.length, deltas_applied: result.payload.deltas.length, excluded: result.payload.excluded.length, warnings: result.payload.warnings });
      if (result.payload.status === 'unverified' || result.payload.status === 'no_anchor') process.exitCode = 2;
    } catch (err) {
      if (err.code === 'SIMULATED_CRASH') {
        const run = db.prepare('SELECT * FROM rebuild_runs WHERE run_id = ?').get(runId);
        out({ database: dbPath, simulated_exit: true, run_id: runId, status: run.status, steps_done: run.steps_done, steps_total: run.steps_total, note: run.note, published_cutview: null, resume_hint: `node src/cli.js rebuild --resume --run ${runId} --sku <sku> --location <loc> --at <iso>` });
        process.exitCode = 3;
        return;
      }
      throw err;
    }
  },
  cutview() {
    const db = openStore(dbPath);
    const id = requireArg('id');
    const row = loadCutview(db, id);
    if (!row) throw new Error(`no cutview ${id}`);
    out(row);
  },
  diff() {
    const db = openStore(dbPath);
    const a = loadCutview(db, requireArg('a'));
    const b = loadCutview(db, requireArg('b'));
    if (!a) throw new Error('cutview A not found');
    if (!b) throw new Error('cutview B not found');
    const periods = db.prepare('SELECT * FROM periods ORDER BY start_at').all();
    const report = persistDiff(db, diffCutviews(a, b, { periods }));
    out(report);
    if (!report.explanation.reconciles) process.exitCode = 4;
  },
  list() {
    const db = openStore(dbPath);
    if (args.what === 'runs') out(db.prepare('SELECT * FROM rebuild_runs ORDER BY started_at DESC LIMIT 50').all());
    else if (args.what === 'diffs') out(db.prepare('SELECT diff_id,a_cutview_id,b_cutview_id,created_at FROM diffs ORDER BY created_at DESC LIMIT 50').all());
    else if (args.what === 'keys') out(keysOf(db));
    else if (args.what === 'batches') out(db.prepare('SELECT batch_id,stream,received_at,accepted_count,rejected_count,duplicate_count,source_file FROM batches ORDER BY received_at, batch_id').all());
    else if (args.what === 'rejected') out(db.prepare('SELECT * FROM rejected_rows ORDER BY id').all());
    else out(db.prepare('SELECT cutview_id,sku,location,at_iso,knowledge_at,status,qty_base,unit_base,confidence,digest FROM cutviews ORDER BY requested_at DESC LIMIT 100').all());
  },
  counts() {
    const db = openStore(dbPath);
    out({ database: dbPath, ...counts(db) });
  },
  help() {
    out({
      usage: 'node src/cli.js <command> [flags]',
      commands: {
        ingest: '--manifest data/manifest.json [--db path]',
        rebuild: '--sku S --location L --at ISO [--knowledge-at ISO] [--mode replay|incremental] [--baseline-cutview ID] [--crash-after N] [--resume [--run ID]]',
        cutview: '--id CV_ID',
        diff: '--a CV_A --b CV_B',
        list: '[--what cutviews|runs|diffs|keys|batches|rejected]',
        counts: '',
      },
    });
  },
};

try {
  if (!cmd || !commands[cmd]) {
    commands.help();
    if (!cmd) process.exitCode = 1;
  } else {
    commands[cmd]();
  }
} catch (err) {
  fail(err);
}
