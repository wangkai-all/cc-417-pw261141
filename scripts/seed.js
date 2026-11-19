#!/usr/bin/env node
/**
 * Rebuild a curated set of cutviews so the console opens onto a meaningful set.
 * Idempotent: identical inputs produce identical cutview ids.
 */
import { openStore, defaultDbPath } from '../src/lib/store.js';
import { planCutview, openRun, executePlan } from '../src/lib/cutview.js';
import { newId, parseArgs } from '../src/lib/util.js';

const args = parseArgs(process.argv.slice(2));
const db = openStore(args.db ?? defaultDbPath());
const SETS = [
  ['SKU-ALPHA', 'WH-A', '2026-01-15T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-01-25T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-02-15T00:00:00Z', '2026-03-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-02-15T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-03-01T00:00:00Z', '2026-03-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-03-01T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-03-06T12:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-03-20T00:00:00Z', '2026-03-19T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-03-20T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-A', '2026-04-01T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-ALPHA', 'WH-B', '2026-04-01T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-BETA', 'WH-A', '2026-02-15T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-BETA', 'WH-A', '2026-03-01T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-BETA', 'WH-A', '2026-03-02T12:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-BETA', 'WH-A', '2026-04-01T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-GAMMA', 'WH-B', '2026-03-01T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-GAMMA', 'WH-B', '2026-04-01T00:00:00Z', '2026-04-10T00:00:00Z'],
  ['SKU-GAMMA', 'WH-A', '2026-04-01T00:00:00Z', '2026-04-10T00:00:00Z'],
];
const made = [];
for (const [sku, location, at, knowledge_at] of SETS) {
  const plan = planCutview(db, { sku, location, at, knowledge_at });
  plan.run_id = newId('run');
  openRun(db, plan, { runId: plan.run_id });
  const res = executePlan(db, plan);
  made.push({ cutview_id: res.cutview_id, sku, location, at, status: res.status, qty_base: res.payload.qty_base, unit_base: res.payload.unit_base });
}
process.stdout.write(JSON.stringify({ seeded: made.length, cutviews: made }, null, 2) + '\n');
