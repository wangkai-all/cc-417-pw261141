/**
 * Shared request normalization for CLI and web so both paths produce identical
 * cutviews for identical inputs (and therefore identical digests).
 */
import { iso } from './util.js';
import { nowIso } from './util.js';

export function normalizeCutRequest(body, { defaultKnowledge = 'now' } = {}) {
  const sku = String(body.sku ?? '').trim();
  const location = String(body.location ?? '').trim();
  if (!sku) throw new Error('sku is required');
  if (!location) throw new Error('location is required');
  const at = iso(body.at ?? nowIso(), 'at');
  let knowledge_at;
  if (body.knowledge_at && body.knowledge_at !== 'now') knowledge_at = iso(body.knowledge_at, 'knowledge_at');
  else if (defaultKnowledge === 'now') knowledge_at = nowIso();
  else knowledge_at = iso(defaultKnowledge, 'knowledge_at');
  const mode = body.mode === 'incremental' ? 'incremental' : 'replay';
  const baseline_cutview_id = body.baseline_cutview_id ? String(body.baseline_cutview_id) : null;
  const crashAfter = body.crash_after === undefined || body.crash_after === null || body.crash_after === '' ? null : Number(body.crash_after);
  if (crashAfter !== null && (!Number.isInteger(crashAfter) || crashAfter < 1)) throw new Error('crash_after must be a positive integer');
  return { sku, location, at, knowledge_at, mode, baseline_cutview_id, crashAfter };
}
