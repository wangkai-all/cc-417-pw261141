/**
 * Accounting policy, versioned. Changing a rule here changes the cutview id, so
 * old artifacts can always be recomputed under the policy that produced them.
 */
export const POLICY = {
  version: 'cutview/1',
  // A physical count at instant T states stock *including* every movement with
  // effective_at <= T. Replay therefore starts strictly after the anchor. Movements
  // stamped exactly at the count instant are treated as already inside the count.
  anchorRule: 'count_includes_movement_at_or_before_anchor',
  replayWindow: 'exclusive_anchor_inclusive_cut',
  // A row whose recorded_at trails its effective_at by more than this is "late".
  // Late rows are still applied (they happened), but they lower confidence and are
  // called out per row, because back-dated posting can rewrite prior cutviews.
  lateAfterSeconds: 48 * 3600,
  // Counts keyed after the fact: if counted_at is much later than effective_at the
  // count is still usable but the skew is disclosed.
  countSkewAfterSeconds: 12 * 3600,
  // Older than this and the replay tail is long enough to disclose.
  staleAnchorAfterSeconds: 31 * 86400,
  // Confidence weights. Confidence is a disclosure, never a quantity.
  confidence: {
    base: 1.0,
    perGap: -0.3,
    gapCap: -0.45,
    lateApplied: -0.1,
    countSkew: -0.05,
    staleAnchor: -0.1,
    knowledgeLimited: -0.1,
    unknownReversal: -0.05,
    floor: 0.05,
  },
  // How many days of a baseline a snapshot may supply before replay. Purely a
  // disclosure threshold: a cut beyond this is still computed.
  longReplayDays: 180,
};

export function policyDigestSource(policy = POLICY) {
  return {
    version: policy.version,
    anchorRule: policy.anchorRule,
    replayWindow: policy.replayWindow,
    lateAfterSeconds: policy.lateAfterSeconds,
    countSkewAfterSeconds: policy.countSkewAfterSeconds,
    staleAnchorAfterSeconds: policy.staleAnchorAfterSeconds,
    confidence: policy.confidence,
  };
}
