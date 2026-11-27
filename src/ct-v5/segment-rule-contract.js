(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};

  const SEGMENT_RULE_CONTRACT_VERSION = 'CT-Segment-Rule-Audit-v0.1';
  const SEGMENT_RULE_IMPLEMENTATION_STATUS = 'AUDIT_FIXTURE_ONLY';
  const CT_SEGMENT_R1_ENDPOINT_GUARD_REVIEW = Object.freeze({
    ruleId: 'CT-Segment-Case1-R1.0/G-ENDPOINT-DIRECTIONAL-EXTREME',
    segmentRuleVersion: 'CT-Segment-R1.0',
    ruleStatus: 'UNRESOLVED',
    researchStatus: 'POST_HOC_RULE_REQUIRES_THEORETICAL_REVIEW',
    implementationStatus: 'IMPLEMENTED',
    verificationStatus: 'UNIT_VERIFIED',
    comparisonDomain: 'PROSPECTIVE_TERMINATED_SEGMENT_MEMBER_PREFIX',
    excludedDomain: 'ENTIRE_OBSERVED_CANDIDATE_STREAM',
    endpointConcept: 'SEGMENT_ENDPOINT_DIRECTIONAL_EXTREME',
    distinctFrom: Object.freeze([
      'STROKE_ENDPOINT_EXTREME_REPLACEMENT',
      'FEATURE_FRACTAL_MIDDLE_ELEMENT_EXTREME',
    ]),
    caveat: 'The prototype enforces this post-hoc guard, but CT-Segment-R1.0 does not freeze it as a universal Chan Theory rule. Replacement versus restart remains theoretical-review work.',
  });

  const SEGMENT_RULE_CONTRACT_V0_1 = Object.freeze({
    contractVersion: SEGMENT_RULE_CONTRACT_VERSION,
    implementationStatus: SEGMENT_RULE_IMPLEMENTATION_STATUS,
    ruleName: 'strict-standardized-characteristic-sequence',
    inputLayer: 'confirmedStrokes',
    outputLayer: 'segmentState',
    causalPolicy: Object.freeze({
      eventTimeAndConfirmTimeSeparated: true,
      noFutureStrokeBeyondCurrentPacket: true,
      candidateBoundaryCanRemainPending: true,
      historicalBootstrapMustNotEmitSyntheticPastEvents: true,
    }),
    nonRules: Object.freeze([
      'threeStrokesAreNotSufficientForConfirmedSegment',
      'strokeBreakIsNotSufficientForConfirmedSegmentBreak',
      'sameNatureSegmentCannotBreakSameNatureSegment',
      'crossCharacteristicSequenceInclusionIsInvalid',
      'screenCoordinatesOrBarIndexAreNotSegmentIdentity',
    ]),
    requiredStateObjects: Object.freeze([
      'activeSegment',
      'candidateBoundary',
      'featureSequence',
      'standardFeatureSequence',
      'featureFractal',
      'reverseFeatureSequence',
      'pendingBreakCase',
      'confirmedSegments',
      'brokenSegments',
    ]),
    necessaryConditions: Object.freeze([
      Object.freeze({
        id: 'minThreeStrokes',
        sufficient: false,
        description: 'A segment needs at least three strokes, but this never confirms a segment by itself.',
      }),
      Object.freeze({
        id: 'oddStrokeCountAtBoundary',
        sufficient: false,
        description: 'A completed segment starts and ends with strokes of the same direction.',
      }),
      Object.freeze({
        id: 'firstThreeOverlap',
        sufficient: false,
        description: 'The first three strokes of a new segment need a valid overlap region.',
      }),
      Object.freeze({
        id: 'oppositeNatureBreak',
        sufficient: false,
        description: 'A segment completion requires destruction by an opposite-nature segment.',
      }),
    ]),
    rules: Object.freeze([
      Object.freeze({ id: 'R1_feature_sequence_direction', sourceRefs: Object.freeze(['PPT slide 39']) }),
      Object.freeze({ id: 'R2_feature_element_gap', sourceRefs: Object.freeze(['PPT slide 39', 'PPT slide 60']) }),
      Object.freeze({ id: 'R3_standardize_before_fractal', sourceRefs: Object.freeze(['PPT slide 39', 'PPT slide 47', 'PPT slide 50-52']) }),
      Object.freeze({ id: 'R4_inclusion_scope', sourceRefs: Object.freeze(['PPT slide 48-49', 'PPT slide 56-60']) }),
      Object.freeze({ id: 'R5_case1_no_gap', sourceRefs: Object.freeze(['PPT slide 40-41', 'PPT slide 61']) }),
      Object.freeze({ id: 'R6_case2_gap_reverse_confirmation', sourceRefs: Object.freeze(['PPT slide 42-46', 'PPT slide 52', 'PPT slide 67']) }),
      Object.freeze({ id: 'R7_direct_break_without_reverse_fractal_extends', sourceRefs: Object.freeze(['PPT slide 46', 'PPT slide 64', 'PPT slide 72-74']) }),
      Object.freeze({ id: 'R8_pseudo_segment_pending_zone', sourceRefs: Object.freeze(['PPT slide 43', 'PPT slide 47', 'PPT slide 49', 'PPT slide 56']) }),
      Object.freeze({ id: 'R9_segment_standardization_for_upper_layers', sourceRefs: Object.freeze(['PPT slide 65']) }),
    ]),
  });

  function clonePlain(value) {
    return core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  }

  function getSegmentRuleContractV01() {
    return clonePlain(SEGMENT_RULE_CONTRACT_V0_1);
  }

  function assertSegmentRuleContractV01(contract) {
    if (!contract || typeof contract !== 'object') throw new Error('Segment rule contract must be an object');
    if (contract.contractVersion !== SEGMENT_RULE_CONTRACT_VERSION) {
      throw new Error(`Unexpected segment rule contract version: ${String(contract.contractVersion)}`);
    }
    if (contract.implementationStatus !== SEGMENT_RULE_IMPLEMENTATION_STATUS) {
      throw new Error('Phase 5B contract must remain audit/fixture-only before Segment rule implementation');
    }
    const nonRules = new Set(contract.nonRules || []);
    if (!nonRules.has('threeStrokesAreNotSufficientForConfirmedSegment')) {
      throw new Error('Segment rule contract must explicitly forbid 3-strokes shortcut confirmation');
    }
    const ruleIds = new Set((contract.rules || []).map(rule => rule.id));
    for (const required of [
      'R1_feature_sequence_direction',
      'R3_standardize_before_fractal',
      'R4_inclusion_scope',
      'R6_case2_gap_reverse_confirmation',
    ]) {
      if (!ruleIds.has(required)) throw new Error(`Segment rule contract missing ${required}`);
    }
    return true;
  }

  Object.assign(core, {
    SEGMENT_RULE_CONTRACT_VERSION,
    SEGMENT_RULE_IMPLEMENTATION_STATUS,
    CT_SEGMENT_R1_ENDPOINT_GUARD_REVIEW,
    SEGMENT_RULE_CONTRACT_V0_1,
    getSegmentRuleContractV01,
    assertSegmentRuleContractV01,
  });
})();
