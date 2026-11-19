// Console for the cutview engine. All numbers come from the API; nothing is
// recomputed in the browser, so the page cannot disagree with the audit trail.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => {
  if (n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  const r = Math.round(x * 1e6) / 1e6;
  return Number.isInteger(r) ? r.toLocaleString('en-US') : r.toLocaleString('en-US', { maximumFractionDigits: 3 });
};
const signed = (n) => (Number(n) > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(Number(n)));
const shortDate = (iso) => (iso ? iso.replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, 'Z').replace(/\.000Z$/, 'Z') : '—');
const dayOnly = (iso) => (iso ? iso.slice(0, 10) : '—');
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

let state = null;
let cursorKey = null;
let lastBuilt = null;

const statusLabel = {
  verified: 'verified', degraded: 'degraded', unverified: 'unverified',
  knowledge_limited: 'knowledge-limited', no_anchor: 'no anchor',
  completed: 'completed', aborted: 'aborted', running: 'running', resumed: 'resumed',
  accepted: 'accepted', rejected: 'rejected', duplicate: 'duplicate',
};
const badge = (status) => `<span class="badge ${esc(status)}">${esc(statusLabel[status] ?? status)}</span>`;

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, kind === 'bad' ? 8000 : 4500);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.json();
  // A simulated process exit is a successful dry-run of the crash path: the server
  // answers 409 because nothing was published, but the console must render it.
  if (!res.ok && !body.simulated_exit) {
    const err = new Error(body.error ?? `request failed (${res.status})`);
    err.body = body;
    throw err;
  }
  return body;
}

// ---- overview -------------------------------------------------------------
function renderStreams() {
  const c = state.counts;
  const streams = [
    { name: 'ledger', rows: c.ledger_entries, note: 'append-only movements', warn: state.rejected.some((r) => r.stream === 'ledger') },
    { name: 'snapshots', rows: c.snapshots, note: 'physical counts, revisioned' },
    { name: 'transit', rows: c.transit_notices, note: 'notices, never on-hand' },
  ];
  $('#stream-strip').innerHTML = streams
    .map((s) => `<span class="stream-chip"><span class="dot ${s.warn ? 'warn' : ''}"></span><strong>${s.name}</strong> ${fmt(s.rows)} · ${s.note}</span>`)
    .join('');
  $('#stream-cards').innerHTML = streams
    .map((s) => `<div class="notice"><span class="title">${s.name} <span class="muted">· ${fmt(s.rows)} rows</span></span><p>${s.note}</p></div>`)
    .join('') + `<div class="notice"><span class="title">Batches</span><p>${fmt(c.batches)} received · ${fmt(c.rejected_batches)} rejected whole · ${fmt(c.duplicate_batches)} duplicate redeliveries · ${fmt(c.rejected_rows)} bad rows</p></div>`;
}

function renderCoverage() {
  // The same hole may be declared by several batches (a redelivery included). The
  // hole is one fact; show it once and name every batch that asserted it, so a
  // double-declared outage does not read as two separate holes.
  const merged = new Map();
  for (const c of state.coverage) {
    const key = `${c.stream}|${c.sku}|${c.location}|${c.start_at}|${c.end_at}|${c.reason}`;
    const prior = merged.get(key);
    if (prior) prior.batches.push(c.batch_id);
    else merged.set(key, { ...c, batches: [c.batch_id] });
  }
  const rows = [...merged.values()];
  $('#coverage-list').innerHTML = rows.length
    ? rows.map((c) => `<div class="notice warn"><span class="title">${esc(c.stream)} · ${esc(c.sku)} / ${esc(c.location)}</span><p>${dayOnly(c.start_at)} → ${dayOnly(c.end_at)} · <code>${esc(c.reason)}</code> · declared by ${c.batches.map((b) => `<code>${esc(b)}</code>`).join(', ')}</p></div>`).join('')
    : '<div class="notice"><p>No coverage holes declared. Cuts will say so: completeness is asserted by the connector, not proven.</p></div>';
}

function renderKeys() {
  const t = $('#keys-table');
  t.innerHTML = `<thead><tr><th>SKU</th><th>Location</th><th class="num">Ledger rows</th><th>Ledger span</th><th>Latest count</th><th></th></tr></thead><tbody>${state.keys
    .map((k) => `<tr>
      <td class="mono">${esc(k.sku)}</td><td class="mono">${esc(k.location)}</td>
      <td class="num">${fmt(k.ledger_rows)}</td>
      <td class="muted">${dayOnly(k.ledger_first)} → ${dayOnly(k.ledger_last)}</td>
      <td>${k.latest_count ? `<code>${esc(k.latest_count.snapshot_id)}</code> r${k.latest_count.revision} · ${fmt(k.latest_count.qty_base)} ${esc(k.latest_count.unit_base)} · ${dayOnly(k.latest_count.effective_at)}` : '<span class="muted">none</span>'}</td>
      <td><button class="small" data-build="${esc(k.sku)}|${esc(k.location)}">Build</button></td>
    </tr>`).join('')}</tbody>`;
  $$('[data-build]', t).forEach((b) => b.addEventListener('click', () => {
    const [sku, location] = b.dataset.build.split('|');
    switchTab('build');
    $('#build-sku').value = sku;
    $('#build-location').value = location;
    const latest = state.keys.find((k) => k.sku === sku && k.location === location)?.latest_count;
    $('[name=at]', $('#build-form')).value = toLocalInput(latest?.effective_at ?? new Date().toISOString());
    $('#build-sku').focus();
  }));
}

function renderCutviews() {
  const t = $('#cutviews-table');
  if (!state.cutviews.length) {
    t.innerHTML = '<tbody><tr><td class="muted">No cutviews yet. Build one from a key above.</td></tr></tbody>';
    return;
  }
  t.innerHTML = `<thead><tr><th>Cutview</th><th>Key</th><th>At</th><th>Knowable at</th><th class="num">Qty</th><th>Status</th><th class="num">Conf.</th><th>Threading</th><th></th></tr></thead><tbody>${state.cutviews
    .map((c) => `<tr>
      <td><code>${esc(c.cutview_id)}</code></td>
      <td class="mono">${esc(c.sku)} / ${esc(c.location)}</td>
      <td class="muted">${shortDate(c.at_iso)}</td>
      <td class="muted">${shortDate(c.knowledge_at)}</td>
      <td class="num"><strong>${fmt(c.qty_base)}</strong> ${esc(c.unit_base)}</td>
      <td>${badge(c.status)}</td>
      <td class="num">${Math.round(c.confidence * 100)}%</td>
      <td class="muted">${c.rebuilt_from ? 'incremental' : 'replay'}</td>
      <td><button class="small" data-open="${esc(c.cutview_id)}">Open</button></td>
    </tr>`).join('')}</tbody>`;
  $$('[data-open]', t).forEach((b) => b.addEventListener('click', async () => {
    const data = await api(`/api/cutviews/${encodeURIComponent(b.dataset.open)}`);
    switchTab('build');
    renderCutResult(data.cutview, data.run, { fromTable: true });
    $('#build-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function renderLedger() {
  const t = $('#ledger-table');
  t.innerHTML = `<thead><tr><th>Event</th><th>Key</th><th>Kind</th><th class="num">Qty in</th><th class="num">Δ base</th><th>Effective</th><th>Recorded</th><th>Link</th><th>Reason</th></tr></thead><tbody>${state.ledger
    .map((l) => `<tr>
      <td class="mono">${esc(l.event_id)}</td>
      <td class="mono">${esc(l.sku)} / ${esc(l.location)}</td>
      <td>${esc(l.kind)}</td>
      <td class="num">${fmt(l.qty_input)} ${esc(l.unit_input)}<span class="muted"> v${l.unit_version}</span></td>
      <td class="num">${signed(l.delta_base)} ${esc(l.unit_base)}</td>
      <td class="muted">${shortDate(l.effective_at)}</td>
      <td class="muted">${shortDate(l.recorded_at)}</td>
      <td class="mono muted">${esc(l.reversed_event_id || l.correction_of || '—')}</td>
      <td class="muted">${esc(l.reason || '')}</td>
    </tr>`).join('')}</tbody>`;
}

function renderSelectors() {
  const keys = state.keys;
  const skus = [...new Set(keys.map((k) => k.sku))];
  const opts = (list, selected) => list.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
  for (const profile of ['build', 'count']) {
    const skuSel = $(`#${profile}-sku`);
    if (!skuSel) continue;
    const prevSku = skuSel.value;
    skuSel.innerHTML = opts(skus, prevSku || skus[0]);
    const locSel = $(`#${profile}-location`);
    const fillLocs = () => {
      const locs = keys.filter((k) => k.sku === skuSel.value).map((k) => k.location).sort();
      const prev = locSel.value;
      locSel.innerHTML = opts(locs, locs.includes(prev) ? prev : locs[0]);
    };
    fillLocs();
    if (!skuSel.dataset.wired) {
      skuSel.dataset.wired = '1';
      skuSel.addEventListener('change', fillLocs);
    }
  }
  // One option per snapshot_id, showing the latest revision: revising an earlier
  // revision would append the next revision anyway, so listing every superseded
  // revision would just repeat the same target.
  const latestById = new Map();
  for (const s of state.snapshots) {
    const prior = latestById.get(s.snapshot_id);
    if (!prior || s.revision > prior.revision) latestById.set(s.snapshot_id, s);
  }
  const snaps = [...latestById.values()];
  const snapSel = $('#count-snapshot');
  const prevSnap = snapSel.value;
  const fillSnapshots = () => {
    const sku = $('#count-sku').value;
    const loc = $('#count-location').value;
    const relevant = snaps
      .filter((s) => s.sku === sku && s.location === loc)
      .sort((a, b) => b.effective_at.localeCompare(a.effective_at));
    snapSel.innerHTML = '<option value="">new count</option>' + relevant.map((s) => `<option value="${esc(s.snapshot_id)}"${s.snapshot_id === prevSnap ? ' selected' : ''}>${esc(s.snapshot_id)} · r${s.revision}${s.superseded_by_revision ? ' (superseded)' : ''} · ${dayOnly(s.effective_at)}</option>`).join('');
  };
  fillSnapshots();
  if (!snapSel.dataset.wired) {
    snapSel.dataset.wired = '1';
    ['#count-sku', '#count-location'].forEach((sel) => $(sel).addEventListener('change', fillSnapshots));
  }
  const cuts = state.cutviews.filter((c) => c.status !== 'no_anchor');
  $('#baseline-select').innerHTML = '<option value="">—</option>' + cuts.map((c) => `<option value="${esc(c.cutview_id)}">${esc(c.cutview_id)} · ${shortDate(c.at_iso)} · ${fmt(c.qty_base)} ${esc(c.unit_base)}</option>`).join('');
  const diffOpts = (sel, selected) => cuts.map((c) => `<option value="${esc(c.cutview_id)}"${c.cutview_id === selected ? ' selected' : ''}>${esc(c.cutview_id)} · ${esc(c.sku)}/${esc(c.location)} · ${shortDate(c.at_iso)} · ${fmt(c.qty_base)} ${esc(c.unit_base)}</option>`).join('');
  const a = $('#diff-a');
  const b = $('#diff-b');
  const prevA = a.value;
  const prevB = b.value;
  a.innerHTML = diffOpts(a, prevA || cuts.at(-1)?.cutview_id);
  b.innerHTML = diffOpts(b, prevB || cuts[0]?.cutview_id);
  $('#correct-event').innerHTML = state.ledger
    .slice(0, 120)
    .map((l) => `<option value="${esc(l.event_id)}">${esc(l.event_id)} · ${esc(l.sku)}/${esc(l.location)} · ${esc(l.kind)} ${signed(l.delta_base)} ${esc(l.unit_base)} · ${shortDate(l.effective_at)}</option>`)
    .join('');
}

// ---- build ----------------------------------------------------------------
function confidenceMeter(cut) {
  const pct = Math.round(cut.confidence * 100);
  return `<div class="conf-meter"><div class="conf-track"><div class="conf-fill" style="width:${pct}%"></div></div><strong>${pct}%</strong></div>`;
}

function renderTimeline(cut) {
  const items = [];
  if (cut.anchor?.snapshot_id) {
    items.push({
      kind: 'anchor', title: `${cut.anchor.snapshot_id} r${cut.anchor.revision}`,
      badge: `<span class="tag">anchor</span>`,
      note: `physical count at ${shortDate(cut.anchor.effective_at)} · ${fmt(cut.anchor.qty_base)} ${esc(cut.anchor.unit_base)} · thread: ${esc(cut.anchor.threading)}`,
      sub: `replay starts strictly after this instant (${esc(cut.anchor.replay_policy)})`,
    });
  } else {
    items.push({ kind: 'anchor', title: 'no eligible count', badge: '<span class="tag gap">no anchor</span>', note: 'nothing to thread from; the quantity is an unanchored replay' });
  }
  for (const d of cut.deltas) {
    const tags = [
      d.reversals ? `<span class="tag rev">reverses ${esc(d.reversals)}</span>` : '',
      d.late ? `<span class="tag late">late ${Math.round(d.late_seconds / 3600)}h</span>` : '',
      d.declared_gap ? '<span class="tag gap">in declared gap</span>' : '',
    ].filter(Boolean).join(' ');
    items.push({
      kind: 'replay', title: `${esc(d.event_id)} <span class="muted">${esc(d.kind)}</span>`,
      badge: `<span class="tag">${signed(d.delta_base)} ${esc(d.unit_base)}</span> ${tags}`,
      note: `${fmt(d.qty_input)} ${esc(d.unit_input)} @ v${d.unit_version} (×${d.factor_to_base}) · effective ${shortDate(d.effective_at)} · recorded ${shortDate(d.recorded_at)}`,
      sub: esc(d.reason || ''),
    });
  }
  const excludedByCode = new Map();
  for (const e of cut.excluded) excludedByCode.set(e.code, [...(excludedByCode.get(e.code) ?? []), e]);
  for (const [code, list] of excludedByCode) {
    items.push({
      kind: 'excluded', title: `${list.length} movement(s) not applied`,
      badge: `<span class="tag">${esc(code)}</span>`,
      note: list.slice(0, 4).map((e) => `${esc(e.event_id)} ${signed(e.delta_base)}`).join(' · ') + (list.length > 4 ? ` · +${list.length - 4} more` : ''),
      sub: esc(list[0].message),
    });
  }
  for (const g of cut.unverified) {
    items.push({
      kind: 'unverified', title: `${dayOnly(g.start_at)} → ${dayOnly(g.end_at)}`,
      badge: '<span class="tag gap">unverified</span>',
      note: `declared ${esc(g.reason)}`, sub: 'completeness of this window cannot be proven; movements inside it are still applied but may be incomplete',
    });
  }
  const t = cut.transit;
  if (t?.open_count) {
    items.push({
      kind: 'transit', title: `${t.open_count} open notice(s)`,
      badge: '<span class="tag">not in on-hand</span>',
      note: `${fmt(t.open_qty_base)} ${esc(t.unit_base)}${t.overdue_count ? ` · ${t.overdue_count} past ETA` : ''} · ${t.open.map((x) => `${esc(x.notice_id)} r${x.revision} ${esc(x.status)}`).join(', ')}`,
      sub: esc(t.policy),
    });
  }
  for (const tr of (t?.reconciliation ?? [])) {
    items.push({
      kind: 'transit', title: tr.ok ? `${tr.notice_id} reconciled` : `${tr.notice_id} does not reconcile`,
      badge: tr.ok ? '<span class="tag">closed by receipt</span>' : '<span class="tag gap">mismatch</span>',
      note: tr.ok ? `${fmt(tr.qty_base)} ${esc(cut.unit_base)} counted once, through ${esc(tr.receipt_event_id)}` : esc(tr.message),
      sub: '',
    });
  }
  return `<div class="timeline">${items.map((i) => `<div class="tl-row"><div class="tl-kind">${esc(i.kind)}</div><div class="tl-body"><div class="tl-title">${i.title} ${i.badge}</div>${i.note ? `<div class="tl-note">${i.note}</div>` : ''}${i.sub ? `<div class="tl-note muted">${i.sub}</div>` : ''}</div></div>`).join('')}</div>`;
}

function gapStrip(cut) {
  if (!cut.unverified.length) return '';
  const start = new Date(cut.anchor?.effective_at ?? cut.at_iso).getTime();
  const end = new Date(cut.at_iso).getTime();
  const span = Math.max(1, end - start);
  return `<div class="gap-strip" role="img" aria-label="Declared coverage holes within the replay window">${cut.unverified
    .map((g) => {
      const a = Math.max(0, ((new Date(g.start_at) - start) / span) * 100);
      const b = Math.min(100, ((new Date(g.end_at) - start) / span) * 100);
      return `<span class="gap-window" style="left:${a}%;width:${Math.max(0.5, b - a)}%" title="${esc(g.reason)} ${shortDate(g.start_at)} → ${shortDate(g.end_at)}"></span>`;
    })
    .join('')}</div>
    <div class="gap-labels"><span>${dayOnly(cut.anchor?.effective_at ?? cut.at_iso)}</span><span>${cut.unverified.length} declared hole(s) in window</span><span>${dayOnly(cut.at_iso)}</span></div>`;
}

function renderUnits(cut) {
  if (!cut.units?.length) return '';
  return `<details><summary>Unit rules in play (${cut.units.length} units)</summary><div class="stack">${cut.units
    .map((u) => `<div class="unit-row"><strong>${esc(u.unit)}</strong><span class="muted">${esc(u.dimension)}</span>${u.versions
      .map((v) => `<span class="vin${v.effective_to ? '' : ' current'}">v${v.version} ×${v.factor_to_base} · ${dayOnly(v.effective_from)} → ${v.effective_to ? dayOnly(v.effective_to) : 'open'}</span>`)
      .join('')}${u.used_as_input_by.length ? `<span class="muted">used by ${u.used_as_input_by.length} billed row(s)</span>` : ''}</div>`)
    .join('')}</div><p class="hint" style="margin-top:8px">Each movement was converted with the rule effective at its own effective instant; the rule version is pinned on the row and never re-derived.</p></details>`;
}

function renderAnchorCandidates(cut) {
  const cands = cut.anchor?.candidates ?? [];
  if (!cands.length) return '';
  return `<details><summary>Why this anchor? (${cands.length} candidate count(s) considered)</summary>
    <div class="table-wrap"><table><thead><tr><th>Count</th><th>Rev</th><th class="num">Qty</th><th>Effective</th><th>Counted</th><th>Received</th><th>Decision</th></tr></thead><tbody>
    ${cands.map((c) => `<tr><td class="mono">${esc(c.snapshot_id)}</td><td>r${c.revision}</td><td class="num">${fmt(c.qty_base)} ${esc(c.unit_base)}</td>
      <td class="muted">${shortDate(c.effective_at)}</td><td class="muted">${shortDate(c.counted_at)}</td><td class="muted">${shortDate(c.batch_accepted_at)}</td>
      <td>${c.eligible ? '<span class="tag">eligible</span>' : c.checks.map((x) => `<div class="muted">${esc(x.message)}</div>`).join('')}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

function renderExcluded(cut) {
  if (!cut.excluded.length) return '';
  return `<details><summary>Movements deliberately not applied (${cut.excluded.length})</summary>
    <div class="table-wrap"><table><thead><tr><th>Event</th><th class="num">Δ</th><th>Effective</th><th>Reason</th></tr></thead><tbody>
    ${cut.excluded.map((e) => `<tr><td class="mono">${esc(e.event_id)}</td><td class="num">${signed(e.delta_base)}</td><td class="muted">${shortDate(e.effective_at)}</td><td class="muted">${esc(e.message)}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

function renderLineage(cut) {
  return `<details><summary>Lineage (${cut.lineage.length} recorded steps)</summary>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Step</th><th>Stream</th><th>Reference</th><th>Detail</th></tr></thead><tbody>
    ${cut.lineage.map((l, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(l.step)}</td><td>${esc(l.stream ?? '')}</td><td class="mono">${esc(l.ref ?? l.event_id ?? '')}</td><td class="muted">${esc(typeof l.detail === 'object' ? JSON.stringify(l.detail) : l.detail ?? '')}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint" style="margin-top:8px">Digest <code>${esc(cut.digest)}</code> — recomputing the same inputs under the same policy reproduces this id.</p></details>`;
}

function renderCutResult(cut, run, { fromTable = false } = {}) {
  lastBuilt = cut;
  const pct = Math.round(cut.confidence * 100);
  const confRows = cut.confidence_breakdown?.length
    ? cut.confidence_breakdown.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${p.delta > 0 ? '+' : ''}${p.delta.toFixed(2)}</td></tr>`).join('')
    : '';
  $('#build-result').innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start">
      <div>
        <h2>${esc(cut.sku)} / ${esc(cut.location)}</h2>
        <p class="hint">Cut at ${shortDate(cut.at_iso)} · knowable as of ${shortDate(cut.knowledge_at)} ${fromTable ? '' : '· just built'}</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">${badge(cut.status)}<code>${esc(cut.cutview_id)}</code></div>
    </div>
    <div class="qty-hero"><span class="value">${fmt(cut.qty_base)}</span><span class="unit">${esc(cut.unit_base)}</span></div>
    <p class="hint">On hand at the cut. In-transit notices are excluded by policy, not by accident.</p>
    <div class="identity" style="margin-top:14px">
      <span class="term anchor"><span class="label">anchor${cut.anchor?.snapshot_id ? ` · r${cut.anchor.revision}` : ''}</span><strong>${fmt(cut.anchor?.qty_base ?? 0)}</strong></span>
      <span class="op">+</span>
      <span class="term move"><span class="label">replayed movements (${cut.deltas.length})</span><strong>${signed(cut.deltas.reduce((a, d) => a + d.delta_base, 0))}</strong></span>
      <span class="op">=</span>
      <span class="term result"><span class="label">on hand</span><strong>${fmt(cut.qty_base)} ${esc(cut.unit_base)}</strong></span>
    </div>
    ${gapStrip(cut)}
  </div>
  <div class="grid two">
    <div class="card">
      <h2>Confidence: ${pct}%</h2>
      <p class="hint">A disclosure, never a quantity. Each deduction names its cause.</p>
      <div style="margin:10px 0">${confidenceMeter(cut)}</div>
      <div class="table-wrap"><table><tbody>${confRows || '<tr><td class="muted">no deductions</td><td></td></tr>'}</tbody></table></div>
      ${cut.warnings?.length ? `<div class="stack" style="margin-top:12px">${cut.warnings.map((w) => `<div class="notice warn"><span class="title">${esc(w.code)}</span><p>${esc(w.message)}${w.event_ids ? ` · ${w.event_ids.map(esc).join(', ')}` : ''}</p></div>`).join('')}</div>` : ''}
      ${run ? `<details><summary>Rebuild run</summary><dl class="kv"><dt>run</dt><dd class="mono">${esc(run.run_id)}</dd><dt>status</dt><dd>${badge(run.status)}</dd><dt>steps</dt><dd>${run.steps_done}/${run.steps_total}</dd><dt>resumed from</dt><dd class="mono">${esc(run.resumed_from ?? '—')}</dd><dt>started</dt><dd class="muted">${shortDate(run.started_at)}</dd></dl></details>` : ''}
    </div>
    <div class="card">
      <h2>In transit</h2>
      <p class="hint">${esc(cut.transit?.policy ?? '')}</p>
      ${cut.transit?.open?.length ? `<div class="table-wrap"><table><thead><tr><th>Notice</th><th class="num">Qty</th><th>Status</th><th>ETA</th><th>Receipt</th></tr></thead><tbody>${cut.transit.open
        .map((t) => `<tr><td class="mono">${esc(t.notice_id)} r${t.revision}</td><td class="num">${fmt(t.qty_base)} ${esc(t.unit_base)}</td><td>${esc(t.status)}${cut.transit.overdue.includes(t.notice_id) ? ' <span class="tag late">past ETA</span>' : ''}</td><td class="muted">${shortDate(t.eta_at)}</td><td class="muted">—</td></tr>`)
        .join('')}</tbody></table></div>` : '<p class="muted" style="margin-top:8px">No open notices at this knowledge cutoff.</p>'}
      ${cut.transit?.reconciliation?.length ? `<details open><summary>Received notices reconcile to the ledger</summary><div class="stack">${cut.transit.reconciliation.map((r) => `<div class="notice ${r.ok ? '' : 'bad'}"><span class="title">${r.ok ? 'counted once' : 'mismatch'} · ${esc(r.notice_id)}</span><p>${esc(r.message ?? `${fmt(r.qty_base)} ${esc(cut.unit_base)} via ${r.receipt_event_id}`)}</p></div>`).join('')}</div></details>` : ''}
    </div>
  </div>
  <div class="card">
    <h2>How this number was built</h2>
    ${renderTimeline(cut)}
    ${renderAnchorCandidates(cut)}
    ${renderExcluded(cut)}
    ${renderUnits(cut)}
    ${renderLineage(cut)}
  </div>`;
  $('#build-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- compare --------------------------------------------------------------
function renderDiff(report) {
  const e = report.explanation;
  const total = Math.max(1, Math.abs(e.movement_total_base) + Math.abs(e.anchor_delta_base));
  const mv = (Math.abs(e.movement_total_base) / total) * 100;
  const an = (Math.abs(e.anchor_delta_base) / total) * 100;
  const periodRows = (report.periods ?? []).map((p) => `<tr><td>${esc(p.period)}</td><td class="num">${signed(p.delta)}</td><td class="num">${p.count}</td></tr>`).join('');
  $('#diff-result').innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div><h2>${esc(report.key.sku)} / ${esc(report.key.location)}</h2><p class="hint">${shortDate(report.a.at_iso)} → ${shortDate(report.b.at_iso)} ${report.orientation === 'b_to_a' ? '(arguments were in reverse order)' : ''}</p></div>
      <div style="display:flex;gap:8px;align-items:center">${badge(report.explanation.reconciles ? 'verified' : 'unverified').replace('verified', 'attributed').replace('unverified', 'does not close')}<code>${esc(report.diff_id)}</code></div>
    </div>
    <div class="qty-hero"><span class="value">${signed(report.qty_delta_base)}</span><span class="unit">${esc(report.unit_base)}</span></div>
    <p class="hint">${esc(e.identity)}</p>
    <div class="bar" aria-hidden="true">
      <span style="width:${mv}%;background:var(--series-2)" ${mv ? '' : 'hidden'}></span>
      <span style="width:${an}%;background:var(--series-1)" ${an ? '' : 'hidden'}></span>
      <span class="only" style="width:100%;background:transparent;border:1px dashed var(--border-strong)" ${mv || an ? 'hidden' : ''}></span>
    </div>
    <div class="legend">
      <span><span class="swatch" style="background:var(--series-1)"></span>anchor ${signed(e.anchor_delta_base)}</span>
      <span><span class="swatch" style="background:var(--series-2)"></span>movements ${signed(e.movement_total_base)}</span>
      <span class="muted">unattributed ${signed(e.unattributed_base)}</span>
    </div>
    ${e.reconciles ? '' : `<div class="notice bad" style="margin-top:12px"><span class="title">Does not close</span><p>The attribution leaves ${signed(e.unattributed_base)} unexplained. Treat this comparison as incomplete.</p></div>`}
  </div>
  <div class="grid two">
    <div class="card">
      <h2>Anchor change</h2>
      ${e.anchor_change.kind === 'same'
        ? '<p class="hint">Both cuts thread from the same count and revision.</p>'
        : `<div class="notice"><span class="title">${esc(e.anchor_change.kind.replace(/_/g, ' '))}</span><p>${esc(e.anchor_change.detail)}</p><p class="mono">${esc(e.anchor_change.from ?? 'none')} → ${esc(e.anchor_change.to ?? 'none')} · ${signed(e.anchor_delta_base)} ${esc(report.unit_base)}</p></div>`}
      <h3 style="margin-top:16px">Periods touched</h3>
      ${periodRows ? `<div class="table-wrap"><table><thead><tr><th>Period</th><th class="num">Δ</th><th class="num">Movements</th></tr></thead><tbody>${periodRows}</tbody></table></div>` : '<p class="hint">No movement differences.</p>'}
    </div>
    <div class="card">
      <h2>Movement effects (${e.movement_effects.length})</h2>
      ${e.movement_effects.length ? `<div class="table-wrap"><table><thead><tr><th>Event</th><th>Change</th><th class="num">Δ</th></tr></thead><tbody>${e.movement_effects
        .map((m) => `<tr><td class="mono">${esc(m.event_id)}</td><td>${esc(m.kind.replace(/_/g, ' '))}<div class="muted">${esc(m.detail)}</div></td><td class="num">${signed(m.delta_base)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No movement differences.</p>'}
    </div>
  </div>
  <div class="grid two">
    <div class="card">
      <h2>Coverage</h2>
      ${report.coverage.newly_unverified.length || report.coverage.no_longer_unverified.length
        ? `<div class="stack">${report.coverage.newly_unverified.map((g) => `<div class="notice warn"><span class="title">newly unverified</span><p>${shortDate(g.start_at)} → ${shortDate(g.end_at)} · ${esc(g.reason)}</p></div>`).join('')}${report.coverage.no_longer_unverified.map((g) => `<div class="notice"><span class="title">no longer unverified</span><p>${shortDate(g.start_at)} → ${shortDate(g.end_at)} · ${esc(g.reason)}</p></div>`).join('')}</div>`
        : `<p class="hint">Unchanged: ${report.coverage.a_gaps} declared hole(s) in A, ${report.coverage.b_gaps} in B.</p>`}
    </div>
    <div class="card">
      <h2>Transit</h2>
      <p class="hint">Not part of either quantity. Listed so a receiver is not confused by notices opening or closing.</p>
      ${report.transit.changes.length ? `<div class="table-wrap"><table><thead><tr><th>Notice</th><th>Change</th><th class="num">Qty</th></tr></thead><tbody>${report.transit.changes
        .map((t) => `<tr><td class="mono">${esc(t.notice_id)}</td><td>${esc(t.change)}${t.to ? `<div class="muted">→ ${esc(t.to.status)} · ETA ${shortDate(t.to.eta_at)}</div>` : ''}</td><td class="num">${fmt(t.qty_base)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No notice changes.</p>'}
    </div>
  </div>
  <div class="card"><h2>Knowledge context</h2><p class="hint">${esc(report.context.note)}</p>
    <dl class="kv" style="margin-top:10px"><dt>A confidence</dt><dd>${Math.round(report.context.a_confidence * 100)}%</dd><dt>B confidence</dt><dd>${Math.round(report.context.b_confidence * 100)}%</dd><dt>Policy</dt><dd>${esc(report.policy.a)} → ${esc(report.policy.b)} ${report.policy.same ? '' : '(different policies; compare with care)'}</dd></dl>
  </div>`;
}

// ---- runs -----------------------------------------------------------------
function renderRuns() {
  const t = $('#runs-table');
  t.innerHTML = `<thead><tr><th>Run</th><th>Key</th><th>At</th><th>Mode</th><th>Status</th><th class="num">Steps</th><th>Resumed from</th><th>Note</th><th></th></tr></thead><tbody>${state.runs
    .map((r) => `<tr>
      <td class="mono">${esc(r.run_id)}</td>
      <td class="mono">${esc(r.sku)} / ${esc(r.location)}</td>
      <td class="muted">${shortDate(r.at_iso)}</td>
      <td>${esc(r.mode)}</td>
      <td>${badge(r.status)}</td>
      <td class="num">${r.steps_done}/${r.steps_total}</td>
      <td class="mono muted">${esc(r.resumed_from ?? '—')}</td>
      <td class="muted">${esc(r.note ?? '')}</td>
      <td><button class="small" data-run="${esc(r.run_id)}">Detail</button>${r.status === 'aborted' ? ` <button class="small" data-resume="${esc(r.run_id)}">Resume</button>` : ''}</td>
    </tr>`).join('')}</tbody>`;
  $$('[data-run]', t).forEach((b) => b.addEventListener('click', () => openRun(b.dataset.run)));
  $$('[data-resume]', t).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const out = await api('/api/runs/resume', { method: 'POST', body: { run_id: b.dataset.resume } });
      toast(`Resumed at step ${out.resumed_at_step}; produced ${out.cutview.cutview_id}`);
      await loadState();
      renderCutResult(out.cutview, null);
      switchTab('build');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      b.disabled = false;
    }
  }));
}

async function openRun(runId) {
  const data = await api(`/api/runs/${encodeURIComponent(runId)}`);
  $('#run-detail').innerHTML = `<div class="card"><h2>${esc(data.run.run_id)} · ${badge(data.run.status)}</h2>
    <p class="hint">${esc(data.run.note ?? '')}</p>
    <dl class="kv" style="margin:10px 0"><dt>key</dt><dd class="mono">${esc(data.run.sku)} / ${esc(data.run.location)}</dd><dt>cut</dt><dd>${shortDate(data.run.at_iso)} · knowable ${shortDate(data.run.knowledge_at)}</dd><dt>plan digest</dt><dd class="mono">${esc(data.run.plan_digest ?? '—')}</dd></dl>
    <h3>Checkpoints</h3>
    ${data.checkpoints.length ? `<div class="table-wrap"><table><thead><tr><th>Step</th><th>Kind</th><th>State digest</th><th>Written</th></tr></thead><tbody>${data.checkpoints.map((c) => `<tr><td class="num">${c.step}</td><td>${esc(c.kind)}</td><td class="mono muted">${esc(c.state_digest.slice(0, 16))}…</td><td class="muted">${shortDate(c.created_at)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">This run checkpointed nothing before finishing.</p>'}
    <h3 style="margin-top:14px">Published cutviews</h3>
    ${data.cutviews.length ? data.cutviews.map((c) => `<div class="notice"><span class="title mono">${esc(c.cutview_id)}</span><p>${fmt(c.qty_base)} ${esc(c.unit_base)} · ${esc(c.status)}</p></div>`).join('') : '<p class="hint">None. An aborted run publishes nothing, so no partial number can be mistaken for a result.</p>'}
  </div>`;
  $('#run-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- state ----------------------------------------------------------------
async function loadState() {
  state = await api('/api/state');
  renderStreams();
  renderCoverage();
  renderKeys();
  renderCutviews();
  renderLedger();
  renderSelectors();
  renderRuns();
  const latestRun = state.runs[0];
  if (!$('[name=at]', $('#build-form')).value) {
    $('[name=at]', $('#build-form')).value = toLocalInput(latestRun?.at_iso ?? new Date().toISOString());
  }
}

function switchTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
}

// ---- wiring ---------------------------------------------------------------
$$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$('#build-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#build-error');
  err.hidden = true;
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    const fd = new FormData(form);
    const body = {
      sku: fd.get('sku'),
      location: fd.get('location'),
      at: fromLocalInput(fd.get('at')),
      knowledge_at: fd.get('knowledge_at') ? fromLocalInput(fd.get('knowledge_at')) : 'now',
      mode: fd.get('mode'),
      baseline_cutview_id: fd.get('baseline_cutview_id') || null,
      crash_after: fd.get('crash_after') || null,
    };
    const out = await api('/api/cutviews', { method: 'POST', body });
    if (out.simulated_exit) {
      $('#build-result').innerHTML = `<div class="card"><h2>Process exited mid-rebuild</h2>
        <div class="notice bad" style="margin-top:10px"><span class="title">Nothing published</span><p>${esc(out.message)}</p></div>
        <dl class="kv" style="margin-top:12px"><dt>run</dt><dd class="mono">${esc(out.run_id)}</dd><dt>checkpoints</dt><dd>${out.steps_done} of ${out.steps_total} steps</dd><dt>published</dt><dd>${out.published_cutview ?? 'none'}</dd></dl>
        <div class="actions"><button class="primary" id="resume-now">Resume from checkpoint</button><button class="ghost" id="go-runs">Open runs</button></div>
        <p class="hint" style="margin-top:10px">${esc(out.hint)}</p></div>`;
      $('#resume-now')?.addEventListener('click', async () => {
        try {
          const r = await api('/api/runs/resume', { method: 'POST', body: { run_id: out.run_id } });
          toast(`Resumed at step ${r.resumed_at_step} · ${r.cutview.cutview_id}`);
          await loadState();
          renderCutResult(r.cutview, null);
        } catch (error) { toast(error.message, 'bad'); }
      });
      $('#go-runs')?.addEventListener('click', () => switchTab('runs'));
      toast('Simulated exit: checkpoints kept, nothing published', 'bad');
    } else {
      toast(`Cutview ${out.cutview.cutview_id} · ${fmt(out.cutview.qty_base)} ${out.cutview.unit_base}`);
      await loadState();
      renderCutResult(out.cutview, out.run, {});
    }
  } catch (error) {
    err.textContent = error.body?.detail ? `${error.message}\n${JSON.stringify(error.body.detail, null, 2)}` : error.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#diff-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#diff-error');
  err.hidden = true;
  const fd = new FormData(e.currentTarget);
  try {
    const report = await api('/api/diffs', { method: 'POST', body: { a: fd.get('a'), b: fd.get('b') } });
    renderDiff(report);
    await loadState();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  }
});

$('#count-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#count-error');
  err.hidden = true;
  // currentTarget is cleared once the submit event finishes dispatching, so hold
  // the form now: the reset happens after the await.
  const form = e.currentTarget;
  const fd = new FormData(form);
  try {
    const out = await api('/api/counts', {
      method: 'POST',
      body: {
        sku: fd.get('sku'), location: fd.get('location'),
        counted_at: fromLocalInput(fd.get('counted_at')),
        effective_at: fd.get('effective_at') ? fromLocalInput(fd.get('effective_at')) : null,
        qty: Number(fd.get('qty')), unit: fd.get('unit'),
        snapshot_id: fd.get('snapshot_id') || null,
        reason: fd.get('reason') || null,
      },
    });
    $('#entry-result').innerHTML = `<div class="card"><h2>Count appended</h2>
      <div class="notice" style="margin-top:10px"><span class="title">${esc(out.snapshot.snapshot_id)} · revision ${out.snapshot.revision}</span><p>${fmt(out.snapshot.qty)} ${esc(out.snapshot.unit)} counted ${shortDate(out.snapshot.counted_at)}, valued ${shortDate(out.snapshot.effective_at)}.</p><p>${esc(out.revision_note)}</p></div>
      <dl class="kv" style="margin-top:12px"><dt>batch</dt><dd class="mono">${esc(out.batch.batch_id)}</dd><dt>batch file</dt><dd class="mono">${esc(out.manifest)}</dd><dt>ledger</dt><dd>untouched — ${out.ledger_untouched ? 'no row was edited' : 'unexpected'}</dd></dl></div>`;
    toast(`Count revision ${out.snapshot.revision} recorded`);
    form.reset();
    await loadState();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  }
});

$('#correct-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#correct-error');
  err.hidden = true;
  const form = e.currentTarget;
  const fd = new FormData(form);
  try {
    const out = await api('/api/ledger/correct', {
      method: 'POST',
      body: {
        event_id: fd.get('event_id'),
        qty: fd.get('qty') || null,
        unit: fd.get('unit') || null,
        effective: fd.get('effective'),
        effective_at: fd.get('effective_at') ? fromLocalInput(fd.get('effective_at')) : null,
        reason: fd.get('reason'),
      },
    });
    $('#entry-result').innerHTML = `<div class="card"><h2>Correction appended</h2>
      <div class="notice" style="margin-top:10px"><span class="title">${esc(out.original.event_id)} retained</span><p>Original ${signed(out.original.delta_base)} ${esc(out.original.unit_base)} (${fmt(out.original.qty_input)} ${esc(out.original.unit_input)}) stays on the ledger. ${out.overwritten_rows} rows overwritten.</p></div>
      <div class="table-wrap"><table><thead><tr><th>New row</th><th>Kind</th><th class="num">Qty</th><th>Effective</th></tr></thead><tbody>${out.appended.map((r) => `<tr><td class="mono">${esc(r.event_id)}</td><td>${esc(r.kind)}</td><td class="num">${fmt(r.qty)} ${esc(r.unit)}</td><td class="muted">${shortDate(r.effective_at)}</td></tr>`).join('')}</tbody></table></div>
      <p class="hint" style="margin-top:10px">${esc(out.mode_note)}</p>
      <dl class="kv" style="margin-top:8px"><dt>batch</dt><dd class="mono">${esc(out.batch.batch_id)}</dd><dt>batch file</dt><dd class="mono">${esc(out.manifest)}</dd></dl></div>`;
    toast('Reversal and replacement appended');
    form.reset();
    await loadState();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  }
});

loadState().catch((err) => toast(`Could not load state: ${err.message}`, 'bad'));
