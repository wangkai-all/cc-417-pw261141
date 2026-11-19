# Cutview — explainable point-in-time inventory

Rebuilds an auditable on-hand cutview for any `(SKU, location, instant)` from three
independent streams, and explains every unit of the answer. The dataset is
**fictional**; nothing here records a real stock movement or recommends
replenishment.

```
ledger (CSV)     movements, append-only, effective-dated
snapshots (JSONL) physical counts — claims about stock at an instant, revisioned
transit (JSON)    in-transit notices — never added to on-hand, reconciled to receipts
        │
        ├── ingester        src/lib/ingest.js   (manifest → atomic batches → pinned rows)
        ├── rebuilder       src/lib/cutview.js  (plan → checkpointed steps → cutview)
        └── diff reporter   src/lib/diff.js     (two cutviews → attributed delta)
        all three run as separate CLI commands / server routes
```

Node 24 built-ins only (`node:sqlite`, `node:http`, `node:test`). No dependencies.

## Quick start from an empty tree

```bash
npm run generate          # write data/ (fictional fixture, self-checked arithmetic)
npm run ingest            # ingest data/manifest.json into artifacts/cutview.db
node scripts/seed.js      # optional: build a curated set of cuts for the console
npm run demo              # or: the whole story end to end in one command
npm test                  # 43 tests
npm run server            # console at http://localhost:4173
```

`npm run demo` regenerates the data, ingests it, builds cuts, crashes and resumes a
rebuild, compares two cuts, and appends a count revision plus a ledger correction —
printing the rows that justify each number.

CLI surface:

```bash
node src/cli.js ingest  --manifest data/manifest.json
node src/cli.js rebuild --sku SKU-ALPHA --location WH-A --at 2026-04-01T00:00:00Z \
                        [--knowledge-at ISO] [--mode replay|incremental] \
                        [--baseline-cutview ID] [--crash-after N] [--resume [--run ID]]
node src/cli.js cutview --id cv-...
node src/cli.js diff    --a cv-... --b cv-...
node src/cli.js list    --what cutviews|runs|diffs|keys|batches|rejected
node src/cli.js counts
```

## The chosen scheme: anchored replay, checkpointed

**Replay from the last trusted physical count** is the primary mode. A count at
instant `T` anchors the cut; movements strictly after `T` and at or before the cut
instant are replayed on top of it.

One anchor rule makes the arithmetic unambiguous:

> a physical count at `T` includes every movement with `effective_at <= T`.

So the replay window is *exclusive anchor / inclusive cut*. A movement stamped
exactly at the count instant is **inherited**, never replayed — see
`POLICY.anchorRule` and `POLICY.replayWindow` in `src/lib/policy.js`. In the
fixture, `SKU-BETA/WH-A` has a movement exactly at the 2026-02-15 count; the cut is
560 with that row disclosed as `at_or_before_anchor`, not 500.

### Why replay and not continuously maintained state

The two designs were both viable, and the trade-off is real:

| | Replay from last trusted count (chosen) | Continuously maintained state |
|---|---|---|
| Trust | Every number is re-derivable from immutable rows; a wrong answer is a bug, and the diff names it | The running balance is itself a claim; an error propagates until someone recounts |
| Late data | A late row simply enters the next replay; prior **published** cutviews keep their digests and are recomputed to change | A late row must be posted into a materialised balance, and there is no safe way to know which past cuts it affected |
| Cost | O(movements since the anchor) per cut; bounded by count cadence | O(1) reads, but requires a write path for every event and permanent vigilance |
| Failure | A crash leaves an aborted run and checkpoints; resume is exact (tested at every step boundary) | A crash mid-update leaves an ambiguous balance |
| Snapshots | A count replaces the anchor instead of having to be reconciled into a running total | A count must be diffed against maintained state and the difference booked somewhere |

Replay was chosen because the deliverable is **explainability**, not throughput.
The replay tail is capped by the count cadence (one month in the fixture), and
`staleAnchorAfterSeconds` (31 days) discloses a long tail by lowering confidence
rather than by silently accepting it. `--mode incremental` exists as the
maintained-state variant on top of a baseline cut; it is *forced back to replay*
whenever the baseline has been invalidated (`INCREMENTAL_INVALIDATED`) — a late
movement effective before the baseline, or a count learned after the baseline
cutoff. Forced replay re-selects the anchor from the counts eligible at the new
knowledge cutoff, so it agrees with a full replay instead of threading from a
stale anchor. Both modes are covered in `tests/incremental.test.js`.

The cost of replay is paid at rebuild time and made cheap by three things:

1. **Checkpointed steps.** Each of the nine plan steps writes a checkpoint. A
   simulated process exit (`--crash-after N` / the console's crash card) leaves
   `status = 'aborted'` and publishes **nothing**. Resuming from the last
   checkpoint produces the same cutview id and digest as a clean run —
   asserted for every crash step in `tests/recovery.test.js`.
2. **Content-addressed cutviews.** The id is `cv-` + the payload digest, so
   rebuilding an unchanged cut is a no-op insert, and two cuts that differ are
   different ids.
3. **A persisted diff.** A comparison is stored with its own digest and can be
   cited later.

## The three hard cases

### Late-arriving reversals and corrections

The ledger is never mutated. A correction appends a **reversal row plus a
replacement row**, both pointing at the original event id. Reversals are keyed by
the *original* event, and their direction is resolved from the original's sign,
so reversing a receipt produces an outgoing row rather than another receipt.

A reversal outside the replay window still matters:

* original inside the window, reversal at/before the cut → the pair nets to zero,
  both rows excluded with `cancelled_by_reversal` / `cancels_movement_before_cut`;
* original inside the window, reversal *after* the cut → the original still
  happened as of the cut and is replayed;
* original at/before the anchor → inherited from the count; the reversal is not
  re-applied (`reversal_before_anchor`).

Late arrivals (`recorded_at − effective_at > 48h`) are applied but disclosed, and
lower confidence. Rows whose batch was accepted after the cut's knowledge cutoff
are excluded with `received_after_knowledge` — the cut says what was knowable
then, not what is known now.

### Snapshot / ledger overlap

Counts are never summed with movements. The anchor selection lists every
candidate snapshot with the exact reason it was or was not eligible
(`after_cut`, `counted_after_knowledge`, `received_after_knowledge`,
`superseded_revision`, `revision_not_known`); the highest eligible revision of the
latest eligible count wins. Revisions are append-only and carry
`superseded_by_revision`, so a revision that arrived later cannot rewrite what was
believed earlier. A diff names the anchor change as `same`, `anchor_revised` or
`reanchored` and attributes the whole anchor delta to it — never to a movement.

### Versioned unit conversion

Rules are effective-dated and versioned, and the **rule in force at each row's own
effective instant** is pinned onto the row (`unit_version`, `factor_to_base`).
The fixture repacks `BOX` from 12 to 10 on 2026-03-01; January BOX movements stay
12, March ones use 10, and rebuilding an April cut does not re-convert the
January rows. Overlapping versions, a unit appearing in two dimensions, and a
dimension without a unique factor-1 base unit are all refused at ingest, and a
missing rule is an explicit `UNIT_RULE_MISSING`, never a silent 1:1.

## Missing intervals are first-class

Coverage rows are **declared holes**, not positive coverage. The absence of a
declaration is not proof of completeness, so it is reported as
`NO_COVERAGE_DECLARATION`; a cut that relies on an undeclared window is still
computed but carries that warning. A movement that falls inside a declared hole is
applied and flagged (`MOVEMENTS_INSIDE_DECLARED_GAP`), the interval is listed in
`unverified`, the status becomes `degraded`, and confidence is reduced. Without
any eligible count the cut has **no quantity** (`qty_base = null`,
`status = no_anchor`, confidence 0) rather than a movement sum dressed up as stock.

## Provenance

Every cutview stores: the anchor with its candidate list and revision history,
applied movements (with unit version, factor, late seconds, declared gap),
excluded rows **with the code that excluded them**, per-step lineage, confidence
breakdown by cause, the transit overlay and its receipt reconciliation, the unit
report, the policy version, and the run id. The digest covers all of it.

Diff attribution has a closing identity that is enforced, not asserted:

```
qty(B) − qty(A) = Σ movement effects + anchor delta + unattributed
```

and `reconciles` is false unless `unattributed` is zero. Unanchored cuts and mixed
base units are refused (`UNANCHORED_CUTVIEW`, `UNIT_MISMATCH`) instead of
returning a misleading number.

Movement effects carry the reason they differ, including the knowledge cutoffs:
a row absent from A only because A's cutoff excluded it is attributed as
`newly_knowable` (and the mirror case as `no_longer_knowable`) rather than as a
movement that appeared — the difference is what changed in what could be known,
not in what happened.

## Console

`npm run server` serves `public/`. Every mutation is written to disk as a connector
batch in `artifacts/inbox/` and then ingested through the same path as machine
feeds, so the web cannot bypass validation, idempotency or unit pinning.

* **Build** — cut requests including a simulated process exit, with the resume
  button on the failure card.
* **Compare** — attributed diff of two cuts, with policy and knowledge context.
* **Manual entry** — append a count revision (ledger untouched) and correct one
  ledger movement (reversal + replacement).
* **Runs & recovery** — run list, checkpoints, published cutviews, resume.

## Ingest guarantees

Batches are all-or-nothing: one bad row rejects the whole batch with per-row
diagnostics, and nothing is applied. Re-ingesting an identical batch is a no-op
(`duplicate`); the same `batch_id` with a different payload is refused. Reference
data is pinned once; a later change is refused rather than silently re-converting
history. The web server sets `cache-control: no-store`, enforces an origin
allowlist, caps request bodies at 1 MB, and confines static paths to `public/`.

## Layout

```
src/lib/{ingest,cutview,diff,manual,units,periods,streams,db,store,policy,util}.js
src/cli.js, src/server.js, public/{index.html,app.js,app.css}
scripts/{generate-data,seed,demo}.js
tests/{ingest,cutview,diff,recovery,units}.test.js
data/        generated fictional fixture (git-ignored output)
artifacts/   SQLite database + manual batch inbox (git-ignored)
```
