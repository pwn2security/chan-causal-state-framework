(function () {
  'use strict';

  const c = window.MarketCore = window.MarketCore || {};
  const CASE2_RULE_VERSION = 'CT-Segment-Case2-R1.0';
  const CONTINUATION_VERSION = 'CT-Segment-Case2-Continuation-v1.0';
  const STATUS = Object.freeze({ pending: 'PENDING', stale: 'STALE', confirmed: 'CONFIRMED' });
  const BLOCK_ACTION = Object.freeze({
    endpointChanged: 'CASE2_BLOCKED_ENDPOINT_CHANGED',
    candidateChanged: 'CASE2_BLOCKED_CANDIDATE_CHANGED',
    ruleVersionChanged: 'CASE2_BLOCKED_RULE_VERSION_CHANGED',
    identityRequired: 'CASE2_BLOCKED_IDENTITY_REQUIRED',
  });
  const DIR_UP = c.CT_DIRECTIONS?.up || 'UP';
  const DIR_DOWN = c.CT_DIRECTIONS?.down || 'DOWN';
  const STRUCTURE_SEGMENT = c.CT_STRUCTURE_TYPES?.segment || 'segment';

  const clone = value => c.clonePlain ? c.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const freeze = value => c.deepFreeze ? c.deepFreeze(clone(value)) : Object.freeze(clone(value));
  const unique = values => [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))];
  const same = (a, b) => (c.canonicalStateJson ? c.canonicalStateJson(a) : JSON.stringify(a)) ===
    (c.canonicalStateJson ? c.canonicalStateJson(b) : JSON.stringify(b));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const idOf = element => element?.standardizedFeatureElementId ?? element?.featureElementId ??
    element?.elementId ?? null;

  function requireDependencies() {
    for (const name of ['createCTRuleConfig', 'evaluateSegmentCase1', 'evaluateDirectionalExtremeEndpoint',
      'buildReverseFeatureElement', 'FeatureSequenceInclusionStateMachine', 'detectFeatureFractals',
      'createStructuralEvent']) {
      if (typeof c[name] !== 'function') throw new Error(`CT Case2 requires MarketCore.${name}`);
    }
  }

  function normalizeAvailability(value, field = 'currentAvailability') {
    const rawBarIndex = Number(value?.rawBarIndex ?? value?.raw_bar_index);
    const time = Number(value?.time);
    if (!Number.isInteger(rawBarIndex) || rawBarIndex < 0 || !Number.isFinite(time)) {
      throw new Error(`INVALID_${field.toUpperCase()}`);
    }
    return freeze({ rawBarIndex, time });
  }

  function availableAt(stroke, now) {
    const index = Number(stroke?.confirmRawBarIndex ?? stroke?.confirmIndex ?? stroke?.confirm_index);
    const time = Number(stroke?.confirmTime ?? stroke?.confirm_time);
    return Number.isInteger(index) && index >= 0 && Number.isFinite(time) &&
      index <= now.rawBarIndex && time <= now.time;
  }

  function canonicalFailure(reason) {
    const aliases = {
      WRONG_FEATURE_FRACTAL_TYPE: 'WRONG_FEATURE_FRACTAL_DIRECTION',
      FEATURE_FRACTAL_NOT_CONFIRMED: 'FEATURE_FRACTAL_NOT_CONFIRMED',
      SOURCE_NOT_AVAILABLE: 'FUTURE_DATA_REQUIRED',
      INVALID_AVAILABILITY: 'FUTURE_DATA_REQUIRED',
      WRONG_FEATURE_SEQUENCE: 'INVALID_PROVENANCE',
      FEATURE_FRACTAL_EVIDENCE_MISMATCH: 'INVALID_PROVENANCE',
      INVALID_FEATURE_EVIDENCE: 'INVALID_PROVENANCE',
      STROKE_PROVENANCE_MISMATCH: 'INVALID_PROVENANCE',
      ENDPOINT_UNRESOLVED: 'CANDIDATE_ENDPOINT_INVALID',
      ENDPOINT_PROVENANCE_MISMATCH: 'INVALID_PROVENANCE',
      INVALID_STROKE_STRUCTURE: 'INSUFFICIENT_STRUCTURE',
      INSUFFICIENT_STROKE_STRUCTURE: 'INSUFFICIENT_STRUCTURE',
      NO_INITIAL_THREE_STROKE_OVERLAP: 'INSUFFICIENT_STRUCTURE',
      SEGMENT_NOT_EXTENDING: 'INSUFFICIENT_STRUCTURE',
      INVALID_SEGMENT_DIRECTION: 'INSUFFICIENT_STRUCTURE',
      SOURCE_NOT_STABLE: 'SOURCE_NOT_STABLE',
      RULE_VERSION_MISMATCH: 'RULE_VERSION_CHANGED',
    };
    return aliases[reason] ?? reason;
  }

  // This is the shared R1.0 post-gap operational audit. It intentionally calls
  // the same endpoint predicate as Case 1. Its rule status remains UNRESOLVED.
  function evaluatePostGapEvidence(input, config) {
    const segment = input.candidateSegmentState ?? input.segmentState;
    const sequence = input.standardizedSequence;
    const fractal = input.confirmedFeatureFractal ?? input.featureFractal;
    const strokes = Array.isArray(input.confirmedStrokes) ? input.confirmedStrokes : [];
    const now = normalizeAvailability(input.currentAvailability);
    const result = { eligible: false, reason: null, eventEndpoint: null, sourceIds: null,
      endpointGuardResult: null, nonGapFailures: [] };
    const fail = reason => { result.nonGapFailures.push(reason); };

    const position = sequence?.elements?.findIndex(element =>
      element.featureSequenceIndex === fractal?.eventFeatureIndex) ?? -1;
    const triple = position >= 1 ? sequence.elements.slice(position - 1, position + 2) : [];
    if (triple.length !== 3 || triple.some(element => element.status !== 'STANDARDIZED' ||
      element.ruleVersion !== 'CT-Segment-R1.0' || element.sequenceId !== sequence.sequenceId ||
      element.candidateSegmentId !== segment.segmentId ||
      element.metadata?.sealingPolicy !== 'NON_INCLUDING_SUCCESSOR')) {
      fail('SOURCE_NOT_STABLE');
      result.reason = result.nonGapFailures[0];
      return freeze(result);
    }

    const sourceAvailable = (index, time) => Number.isInteger(index) && index >= 0 && finite(time) &&
      index <= now.rawBarIndex && time <= now.time;
    if (!sourceAvailable(fractal.confirmRawBarIndex, fractal.confirmTime) ||
      sequence.elements.some(element =>
        !sourceAvailable(element.standardizationAvailableRawBarIndex, element.standardizationAvailableTime) ||
        element.standardizationAvailableRawBarIndex < element.sourceRawEndIndex ||
        element.standardizationAvailableTime < element.sourceEndTime) ||
      strokes.some(stroke => stroke.status !== 'CONFIRMED' ||
        !sourceAvailable(stroke.confirmRawBarIndex ?? stroke.confirmIndex, stroke.confirmTime) ||
        stroke.confirmTime < stroke.endTime ||
        (stroke.confirmRawBarIndex ?? stroke.confirmIndex) < stroke.endIndex)) {
      fail('FUTURE_DATA_REQUIRED');
    }

    const byId = new Map(strokes.map(stroke => [stroke.strokeId, stroke]));
    const evidenceStrokeIds = unique(triple.flatMap(element => [
      ...(element.sourceStrokeIds || []), ...(element.metadata?.witnessStrokeIds || []),
    ]));
    if (byId.size !== strokes.length || segment.strokeCount !== strokes.length ||
      !Array.isArray(segment.strokeIds) || !same(segment.strokeIds, strokes.map(stroke => stroke.strokeId)) ||
      evidenceStrokeIds.some(strokeId => !byId.has(strokeId))) {
      fail('INVALID_PROVENANCE');
    }
    if (result.nonGapFailures.length) {
      result.reason = result.nonGapFailures[0];
      return freeze(result);
    }

    const middle = triple[1];
    const target = segment.direction === DIR_UP ? middle.high : middle.low;
    const hit = strokes.map((stroke, index) => ({ stroke, index })).find(({ stroke }) =>
      middle.sourceStrokeIds.includes(stroke.strokeId) && stroke.direction === sequence.featureDirection &&
      Math.abs(stroke.startPrice - target) <= config.numericTolerance);
    if (!hit || hit.index === 0) {
      fail('CANDIDATE_ENDPOINT_INVALID');
      result.reason = result.nonGapFailures[0];
      return freeze(result);
    }

    const endpoint = strokes[hit.index - 1];
    const reverse = hit.stroke;
    const members = strokes.slice(0, hit.index);
    const endpointProvenance = members[0].strokeId === segment.startStrokeId &&
      members[0].direction === segment.direction && endpoint.direction === segment.direction &&
      Boolean(reverse.startFractalId) && endpoint.endFractalId === reverse.startFractalId &&
      endpoint.endIndex === reverse.startIndex && endpoint.endTime === reverse.startTime &&
      Math.abs(endpoint.endPrice - reverse.startPrice) <= config.numericTolerance;
    const alternating = members.every((stroke, index) => {
      const previous = members[index - 1];
      const monotone = stroke.direction === DIR_UP ? stroke.endPrice > stroke.startPrice : stroke.endPrice < stroke.startPrice;
      return monotone && stroke.endIndex >= stroke.startIndex && stroke.endTime >= stroke.startTime && (!previous ||
        (stroke.direction !== previous.direction && previous.endFractalId === stroke.startFractalId &&
          previous.endIndex === stroke.startIndex && previous.endTime === stroke.startTime &&
          Math.abs(previous.endPrice - stroke.startPrice) <= config.numericTolerance));
    });
    const initial = members.slice(0, 3);
    const initialOverlap = initial.length === 3 &&
      Math.max(...initial.map(stroke => Math.min(stroke.startPrice, stroke.endPrice))) <=
      Math.min(...initial.map(stroke => Math.max(stroke.startPrice, stroke.endPrice))) + config.priceTolerance;
    if (members.length < config.minimumSegmentStrokeCount || members.length % 2 !== 1 ||
      !endpointProvenance || !alternating || !initialOverlap) fail('INSUFFICIENT_STRUCTURE');

    const endpointGuardResult = c.evaluateDirectionalExtremeEndpoint({
      direction: segment.direction, startPrice: members[0].startPrice,
      endpointPrice: endpoint.endPrice,
      memberPrices: members.flatMap(stroke => [stroke.startPrice, stroke.endPrice]),
      numericTolerance: config.numericTolerance,
    });
    result.endpointGuardResult = endpointGuardResult;
    if (!endpointGuardResult.valid) fail('INVALID_DIRECTIONAL_ENDPOINT');
    if (!sourceAvailable(endpoint.endIndex, endpoint.endTime)) fail('FUTURE_DATA_REQUIRED');

    result.eventEndpoint = {
      endpointIdentity: `${endpoint.strokeId}:${endpoint.endFractalId}:${endpoint.endIndex}:${endpoint.endPrice}`,
      endpointStrokeId: endpoint.strokeId,
      endpointStrokeIndex: endpoint.eventStrokeIndex ?? hit.index - 1,
      endpointFractalId: endpoint.endFractalId,
      endpointRawBarIndex: endpoint.endIndex,
      endpointPrice: endpoint.endPrice,
      endpointTime: endpoint.endTime,
      endpointAvailableRawBarIndex: endpoint.availableRawBarIndex ?? endpoint.confirmRawBarIndex ?? endpoint.confirmIndex,
      endpointAvailableTime: endpoint.availableTime ?? endpoint.confirmTime,
    };
    result.sourceIds = {
      sourceFeatureFractalId: fractal.featureFractalId,
      sourceStandardizedFeatureIds: triple.map(idOf),
      sourceFeatureElementIds: unique(triple.flatMap(element => element.sourceFeatureElementIds || [])),
      sourceStrokeIds: unique([...evidenceStrokeIds, ...members.map(stroke => stroke.strokeId)]),
      confirmationEvidenceStrokeIds: evidenceStrokeIds,
      segmentStrokeIds: members.map(stroke => stroke.strokeId),
    };
    result.reason = result.nonGapFailures[0] ?? 'ELIGIBLE';
    result.eligible = result.nonGapFailures.length === 0;
    return freeze(result);
  }

  function evaluateSegmentCase2Entry(input) {
    requireDependencies();
    const config = c.createCTRuleConfig(input.ruleConfig ?? {});
    const segment = input.candidateSegmentState ?? input.segmentState;
    const fractal = input.confirmedFeatureFractal ?? input.featureFractal;
    const now = normalizeAvailability(input.currentAvailability);
    const baseTrace = {
      candidateSegmentId: segment?.segmentId ?? null,
      segmentDirection: segment?.direction ?? null,
      primaryFeatureFractalId: fractal?.featureFractalId ?? null,
      gapDetected: input.gapResult?.hasGap ?? null,
      decisionAvailableRawBarIndex: now.rawBarIndex,
      decisionAvailableTime: now.time,
      ruleVersion: config.segmentRuleVersion,
      case2RuleVersion: CASE2_RULE_VERSION,
    };
    const reject = (reason, details = {}) => freeze({ eligible: false, reason,
      candidateEndpoint: null, primaryFeatureFractalId: fractal?.featureFractalId ?? null,
      eventClock: null, entryAvailability: now, sourceIds: null,
      decisionTrace: { ...baseTrace, eligible: false, reason, ...details } });
    if (input.case1Confirmed === true || segment?.status === 'CONFIRMED') return reject('CASE2_NOT_GAP_ONLY');
    const case1 = c.evaluateSegmentCase1({ ...input, segmentState: segment,
      featureFractal: fractal, ruleConfig: config });
    if (case1.eligible) return reject('CASE2_NOT_GAP_ONLY', { case1Reason: 'ELIGIBLE' });
    if (case1.reason !== 'GAP_REQUIRES_CASE2') {
      return reject(canonicalFailure(case1.reason), { case1Reason: case1.reason });
    }
    if (!input.gapResult?.hasGap) return reject('CASE2_NOT_GAP_ONLY', { case1Reason: case1.reason });
    const postGap = evaluatePostGapEvidence({ ...input, candidateSegmentState: segment,
      confirmedFeatureFractal: fractal }, config);
    if (!postGap.eligible) return reject(postGap.reason, {
      case1Reason: case1.reason, nonGapFailures: postGap.nonGapFailures,
      endpointGuardRuleStatus: postGap.endpointGuardResult?.ruleStatus ?? null,
    });
    const endpoint = postGap.eventEndpoint;
    return freeze({ eligible: true, reason: 'GAP_ONLY_CASE2_ENTRY',
      candidateEndpoint: endpoint, primaryFeatureFractalId: fractal.featureFractalId,
      eventClock: { rawBarIndex: endpoint.endpointRawBarIndex, time: endpoint.endpointTime },
      entryAvailability: now, sourceIds: postGap.sourceIds,
      gapSourceFeatureIds: [input.gapResult.leftElementId, input.gapResult.rightElementId],
      endpointGuardResult: postGap.endpointGuardResult,
      candidateSegment: clone(segment),
      decisionTrace: { ...baseTrace, eligible: true, reason: 'GAP_ONLY_CASE2_ENTRY',
        endpointIdentity: endpoint.endpointIdentity,
        endpointStrokeId: endpoint.endpointStrokeId,
        endpointFractalId: endpoint.endpointFractalId,
        endpointPrice: endpoint.endpointPrice,
        eventRawBarIndex: endpoint.endpointRawBarIndex,
        eventTime: endpoint.endpointTime,
        case2EntryRawBarIndex: now.rawBarIndex,
        case2EntryTime: now.time,
        endpointGuardRuleStatus: postGap.endpointGuardResult.ruleStatus,
      },
    });
  }

  function pendingIdentity(entry, config) {
    const endpoint = entry.candidateEndpoint;
    return `${CASE2_RULE_VERSION}:pending:${entry.candidateSegment.segmentId}:${endpoint.endpointIdentity}:${entry.primaryFeatureFractalId}:${config.segmentRuleVersion}`;
  }

  function createPendingTermination(entry, ruleConfig) {
    if (!entry?.eligible) throw new Error('CASE2_ENTRY_NOT_ELIGIBLE');
    const config = c.createCTRuleConfig(ruleConfig ?? {});
    const endpoint = entry.candidateEndpoint;
    const pendingTerminationId = pendingIdentity(entry, config);
    const reverseSequenceId = `${pendingTerminationId}:reverse-sequence`;
    return freeze({
      pendingTerminationId,
      candidateSegmentId: entry.candidateSegment.segmentId,
      segmentDirection: entry.candidateSegment.direction,
      endpointIdentity: endpoint.endpointIdentity,
      endpointStrokeId: endpoint.endpointStrokeId,
      endpointStrokeIndex: endpoint.endpointStrokeIndex,
      endpointFractalId: endpoint.endpointFractalId,
      endpointPrice: endpoint.endpointPrice,
      eventRawBarIndex: endpoint.endpointRawBarIndex,
      eventTime: endpoint.endpointTime,
      endpointAvailableRawBarIndex: endpoint.endpointAvailableRawBarIndex,
      endpointAvailableTime: endpoint.endpointAvailableTime,
      primaryFeatureFractalId: entry.primaryFeatureFractalId,
      case2EntryRawBarIndex: entry.entryAvailability.rawBarIndex,
      case2EntryTime: entry.entryAvailability.time,
      gapSourceFeatureIds: clone(entry.gapSourceFeatureIds || []),
      sourceStandardizedFeatureIds: clone(entry.sourceIds.sourceStandardizedFeatureIds || []),
      sourceRawFeatureIds: clone(entry.sourceIds.sourceFeatureElementIds || []),
      sourceStrokeIds: clone(entry.sourceIds.sourceStrokeIds || []),
      segmentMemberStrokeIds: clone(entry.sourceIds.segmentStrokeIds || []),
      reverseSequenceStartAnchor: freeze({ endpointIdentity: endpoint.endpointIdentity,
        endpointStrokeId: endpoint.endpointStrokeId, rawBarIndex: endpoint.endpointRawBarIndex,
        time: endpoint.endpointTime }),
      reverseSequenceId,
      reverseSequenceCursor: freeze({ consumedStrokeCount: 0, lastConsumedStrokeId: null,
        lastConfirmRawBarIndex: null, lastConfirmTime: null }),
      ruleVersion: config.segmentRuleVersion,
      case2RuleVersion: CASE2_RULE_VERSION,
      timeSchemaVersion: c.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      status: STATUS.pending,
      staleReason: null,
      createdAtRawBarIndex: entry.entryAvailability.rawBarIndex,
      createdAtTime: entry.entryAvailability.time,
      lastUpdatedRawBarIndex: entry.entryAvailability.rawBarIndex,
      lastUpdatedTime: entry.entryAvailability.time,
      metadata: freeze({ source: 'manual-or-parser-case2-entry',
        endpointGuardRuleId: entry.endpointGuardResult?.ruleId ?? null,
        endpointGuardRuleStatus: entry.endpointGuardResult?.ruleStatus ?? null,
        candidateSegment: clone(entry.candidateSegment),
        primaryDecisionTrace: clone(entry.decisionTrace),
      }),
    });
  }

  function requiredReverseFractalType(direction) {
    if (direction === DIR_UP) return 'FEATURE_BOTTOM';
    if (direction === DIR_DOWN) return 'FEATURE_TOP';
    throw new Error('INVALID_SEGMENT_DIRECTION');
  }

  function case2ConfirmationClock(pending, reverseFractal, currentAvailability) {
    const now = normalizeAvailability(currentAvailability);
    const entry = normalizeAvailability({ rawBarIndex: pending?.case2EntryRawBarIndex,
      time: pending?.case2EntryTime }, 'case2Entry');
    const reverse = normalizeAvailability({ rawBarIndex: reverseFractal?.confirmRawBarIndex,
      time: reverseFractal?.confirmTime }, 'reverseConfirmation');
    const entryBeforeReverse = entry.rawBarIndex <= reverse.rawBarIndex && entry.time <= reverse.time;
    const reverseBeforeEntry = reverse.rawBarIndex <= entry.rawBarIndex && reverse.time <= entry.time;
    if (!entryBeforeReverse && !reverseBeforeEntry) throw new Error('INCONSISTENT_CASE2_CONFIRMATION_CLOCK');
    const clock = entryBeforeReverse ? reverse : entry;
    if (clock.rawBarIndex > now.rawBarIndex || clock.time > now.time) {
      throw new Error('FUTURE_CASE2_CONFIRMATION_CLOCK');
    }
    return clock;
  }

  function validateReverseFeatureConfirmation(input) {
    const pending = input?.pendingTermination;
    const fractal = input?.reverseFeatureFractal;
    const standardizedElements = input?.standardizedElements || [];
    const rawElements = input?.rawElements || [];
    const consumedStrokeIds = input?.consumedStrokeIds || [];
    if (!pending || pending.status !== STATUS.pending) return freeze({ valid: false, reason: 'PENDING_NOT_VALID' });
    if (!fractal || fractal.status !== 'CONFIRMED' ||
      fractal.type !== requiredReverseFractalType(pending.segmentDirection)) {
      return freeze({ valid: false, reason: 'REVERSE_FEATURE_FRACTAL_NOT_CONFIRMED' });
    }
    if (fractal.ruleVersion !== input.ruleConfig.ruleVersion ||
      !String(fractal.featureFractalId || '').startsWith(`${pending.reverseSequenceId}:`)) {
      return freeze({ valid: false, reason: 'REVERSE_RULE_OR_SEQUENCE_MISMATCH' });
    }
    const eventIndex = Number(fractal.eventRawBarIndex);
    const availableIndex = Number(fractal.availableRawBarIndex);
    const confirmIndex = Number(fractal.confirmRawBarIndex);
    const eventTime = Number(fractal.eventTime);
    const availableTime = Number(fractal.availableTime);
    const confirmTime = Number(fractal.confirmTime);
    if (![eventIndex, availableIndex, confirmIndex].every(Number.isInteger) ||
      eventIndex > availableIndex || availableIndex > confirmIndex ||
      ![eventTime, availableTime, confirmTime].every(finite) ||
      eventTime > availableTime || availableTime > confirmTime) {
      return freeze({ valid: false, reason: 'REVERSE_TIME_SCHEMA_INVALID' });
    }
    const standardizedIds = new Set(standardizedElements.map(idOf));
    const rawIds = new Set(rawElements.map(idOf));
    const consumedIds = new Set(consumedStrokeIds);
    const provenance = fractal.provenance || {};
    const standardizedSourceIds = provenance.standardizedFeatureElementIds || [];
    const rawSourceIds = provenance.rawFeatureElementIds || [];
    const strokeSourceIds = provenance.strokeIds || [];
    const missingStandardizedIds = standardizedSourceIds.filter(id => !standardizedIds.has(id));
    const missingRawIds = rawSourceIds.filter(id => !rawIds.has(id));
    const missingStrokeIds = strokeSourceIds.filter(id => !consumedIds.has(id));
    if (!standardizedSourceIds.length || !rawSourceIds.length || !strokeSourceIds.length ||
      missingStandardizedIds.length || missingRawIds.length || missingStrokeIds.length) {
      return freeze({ valid: false, reason: 'REVERSE_PROVENANCE_INVALID',
        missingStandardizedIds, missingRawIds, missingStrokeIds });
    }
    return freeze({ valid: true, reason: 'REVERSE_FEATURE_CONFIRMATION_VALID' });
  }

  class SegmentCase2StateMachine {
    constructor(ruleConfig = {}, continuationState = null) {
      requireDependencies();
      this.ruleConfig = c.createCTRuleConfig(ruleConfig.ruleConfig || ruleConfig);
      this.reset();
      if (continuationState) this.restoreContinuationState(continuationState);
    }

    reset() {
      this.pendingTermination = null;
      this.stalePendingHistory = [];
      this.inclusionMachine = null;
      this.reverseRawElements = [];
      this.reverseFeaturePacket = null;
      this.consumedStrokeIds = [];
      this.confirmedSegment = null;
      this.structuralEvents = [];
      this.decisionEvents = [];
      this.currentAvailability = null;
      return this;
    }

    #reverseContext(pending) {
      return { sequenceId: pending.reverseSequenceId,
        candidateSegmentId: pending.candidateSegmentId, sequenceRole: 'reverse',
        featureDirection: pending.segmentDirection,
        segmentStartDirection: c.oppositeSegmentDirection(pending.segmentDirection),
        structuralContext: { pendingTerminationId: pending.pendingTerminationId,
          endpointIdentity: pending.endpointIdentity, ruleVersion: pending.ruleVersion } };
    }

    #setPending(patch) {
      this.pendingTermination = freeze({ ...this.pendingTermination, ...patch });
    }

    #decision(action, reason, now, metadata = {}) {
      const event = freeze({ action, reason, pendingTerminationId: this.pendingTermination?.pendingTerminationId ?? null,
        candidateSegmentId: this.pendingTermination?.candidateSegmentId ?? null,
        endpointIdentity: this.pendingTermination?.endpointIdentity ?? null,
        rawBarIndex: now.rawBarIndex, time: now.time, ruleVersion: this.ruleConfig.segmentRuleVersion,
        case2RuleVersion: CASE2_RULE_VERSION, metadata });
      this.decisionEvents.push(event);
      return event;
    }

    #markStale(action, now) {
      if (!this.pendingTermination || this.pendingTermination.status !== STATUS.pending) return null;
      this.#setPending({ status: STATUS.stale, staleReason: action,
        lastUpdatedRawBarIndex: now.rawBarIndex, lastUpdatedTime: now.time });
      return this.#decision(action, action, now);
    }

    // Endpoint replacement is a lifecycle reset, not a generic Case-2 restart.
    // It invalidates every endpoint-dependent reverse artifact and preserves the
    // old PendingTermination as an auditable stale record.
    invalidateForEndpointReplacement(replacementEvent, currentAvailability) {
      const now = normalizeAvailability(currentAvailability, 'replacement');
      if (this.currentAvailability && (now.rawBarIndex < this.currentAvailability.rawBarIndex ||
        now.time < this.currentAvailability.time)) throw new Error('NON_MONOTONIC_CASE2_REPLACEMENT_CLOCK');
      this.currentAvailability = now;
      if (!this.pendingTermination || this.pendingTermination.status !== STATUS.pending) {
        return freeze({ invalidated: false, reason: 'NO_PENDING_TERMINATION_TO_INVALIDATE',
          events: [], state: this.getState() });
      }
      const oldEndpointMatches = this.pendingTermination.lifecycleEndpointId
        ? replacementEvent?.oldEndpointId === this.pendingTermination.lifecycleEndpointId
        : (replacementEvent?.oldEndpointStrokeId === this.pendingTermination.endpointStrokeId &&
          replacementEvent?.oldEndpointFractalId === this.pendingTermination.endpointFractalId);
      if (!replacementEvent || replacementEvent.lifecycleAction !== 'ENDPOINT_REPLACED' ||
        replacementEvent.segmentCandidateId !== this.pendingTermination.candidateSegmentId ||
        !oldEndpointMatches) {
        return freeze({ invalidated: false, reason: 'ENDPOINT_REPLACEMENT_EVENT_MISMATCH',
          events: [], state: this.getState() });
      }
      this.#setPending({ status: STATUS.stale, staleReason: BLOCK_ACTION.endpointChanged,
        invalidatedByEndpointId: replacementEvent.newEndpointId,
        invalidatedByEndpointStrokeId: replacementEvent.newEndpointStrokeId,
        invalidatedByEndpointFractalId: replacementEvent.newEndpointFractalId,
        invalidatedByProposalId: replacementEvent.endpointProposalId,
        replacementEventId: replacementEvent.eventId,
        staleAtRawBarIndex: now.rawBarIndex, staleAtTime: now.time,
        lastUpdatedRawBarIndex: now.rawBarIndex, lastUpdatedTime: now.time });
      this.stalePendingHistory.push(clone(this.pendingTermination));
      this.inclusionMachine = null;
      this.reverseRawElements = [];
      this.reverseFeaturePacket = null;
      this.consumedStrokeIds = [];
      const event = this.#decision('PENDING_TERMINATION_STALE', BLOCK_ACTION.endpointChanged, now, {
        replacementEventId: replacementEvent.eventId,
        invalidatedByEndpointId: replacementEvent.newEndpointId,
        invalidatedByProposalId: replacementEvent.endpointProposalId,
      });
      return freeze({ invalidated: true, reason: BLOCK_ACTION.endpointChanged,
        events: [event], pendingTermination: this.getPendingTermination(), state: this.getState() });
    }

    begin(input) {
      const entry = evaluateSegmentCase2Entry(input);
      if (!entry.eligible) return freeze({ entry, events: [], state: this.getState() });
      const nextPending = createPendingTermination(entry, this.ruleConfig);
      if (this.pendingTermination?.pendingTerminationId === nextPending.pendingTerminationId) {
        return freeze({ entry, duplicate: true, events: [], state: this.getState() });
      }
      if (this.pendingTermination) {
        if (this.pendingTermination.status === STATUS.pending) {
          const action = this.pendingTermination.candidateSegmentId !== nextPending.candidateSegmentId
            ? BLOCK_ACTION.candidateChanged
            : (this.pendingTermination.endpointIdentity !== nextPending.endpointIdentity
              ? BLOCK_ACTION.endpointChanged : BLOCK_ACTION.candidateChanged);
          const event = this.#markStale(action, entry.entryAvailability);
          return freeze({ entry, blocked: true, reason: action, events: event ? [event] : [],
            pendingTermination: this.getPendingTermination(), confirmedSegment: this.getConfirmedSegment(),
            state: this.getState() });
        }
        const replacementReentry = this.pendingTermination.status === STATUS.stale &&
          this.pendingTermination.staleReason === BLOCK_ACTION.endpointChanged &&
          this.pendingTermination.candidateSegmentId === nextPending.candidateSegmentId &&
          this.pendingTermination.invalidatedByEndpointStrokeId === nextPending.endpointStrokeId &&
          this.pendingTermination.invalidatedByEndpointFractalId === nextPending.endpointFractalId;
        if (!replacementReentry) return freeze({ entry, blocked: true,
          reason: 'CASE2_RESTART_DEFERRED_TO_PHASE5E3', events: [],
          pendingTermination: this.getPendingTermination(), confirmedSegment: this.getConfirmedSegment(),
          state: this.getState() });
      }
      this.pendingTermination = nextPending;
      this.currentAvailability = entry.entryAvailability;
      this.reverseRawElements = [];
      this.reverseFeaturePacket = null;
      this.consumedStrokeIds = [];
      this.confirmedSegment = null;
      this.inclusionMachine = new c.FeatureSequenceInclusionStateMachine(
        this.#reverseContext(nextPending), { priceTolerance: this.ruleConfig.priceTolerance });
      const events = [this.#decision('PENDING_TERMINATION_CREATED', 'GAP_ONLY_CASE2_ENTRY',
        entry.entryAvailability, { pendingTerminationId: nextPending.pendingTerminationId })];
      const strokes = Array.isArray(input.confirmedStrokes) ? input.confirmedStrokes : [];
      const endpointPosition = strokes.findIndex(stroke => stroke.strokeId === nextPending.endpointStrokeId);
      if (endpointPosition >= 0) {
        for (const stroke of strokes.slice(endpointPosition + 1)) {
          if (!availableAt(stroke, entry.entryAvailability)) continue;
          const packet = this.updateConfirmedStroke(stroke, entry.entryAvailability, {
            candidateSegmentId: nextPending.candidateSegmentId,
            endpointIdentity: nextPending.endpointIdentity,
            ruleVersion: nextPending.ruleVersion,
          });
          events.push(...packet.events);
          if (this.pendingTermination.status !== STATUS.pending) break;
        }
      }
      return freeze({ entry, pendingTermination: this.getPendingTermination(),
        events, confirmedSegment: this.getConfirmedSegment(), state: this.getState() });
    }

    #finalize(reverseFractal, now, confirmingStroke) {
      const pending = this.pendingTermination;
      const confirmClock = case2ConfirmationClock(pending, reverseFractal, now);
      const candidate = pending.metadata.candidateSegment;
      const reverseSourceStrokeIds = unique(reverseFractal.sourceStrokeIds || []);
      const confirmed = freeze({ ...candidate, status: 'CONFIRMED', mode: 'CONFIRMED',
        caseType: 'CASE_2', case2RuleVersion: CASE2_RULE_VERSION,
        endStrokeId: pending.endpointStrokeId,
        strokeIds: clone(pending.segmentMemberStrokeIds),
        strokeCount: pending.segmentMemberStrokeIds.length,
        endPrice: pending.endpointPrice,
        endTime: pending.eventTime,
        endIndex: pending.eventRawBarIndex,
        endpointIdentity: pending.endpointIdentity,
        endpointStrokeId: pending.endpointStrokeId,
        endpointFractalId: pending.endpointFractalId,
        endpointPrice: pending.endpointPrice,
        eventRawBarIndex: pending.eventRawBarIndex,
        eventIndex: pending.eventRawBarIndex,
        eventTime: pending.eventTime,
        eventStrokeIndex: pending.endpointStrokeIndex,
        availableStrokeIndex: pending.endpointStrokeIndex,
        availableRawBarIndex: pending.endpointAvailableRawBarIndex,
        availableTime: pending.endpointAvailableTime,
        confirmRawBarIndex: confirmClock.rawBarIndex,
        confirmIndex: confirmClock.rawBarIndex,
        confirmTime: confirmClock.time,
        confirmStrokeIndex: Number.isInteger(confirmingStroke?.eventStrokeIndex)
          ? confirmingStroke.eventStrokeIndex : null,
        amplitude: Math.abs(pending.endpointPrice - candidate.startPrice),
        duration: Math.max(0, pending.eventTime - candidate.startTime),
        slope: (pending.endpointPrice - candidate.startPrice) /
          Math.max(1, pending.segmentMemberStrokeIds.length - 1),
        metadata: { ...(candidate.metadata || {}), confirmationRuleStatus: 'CASE2_CONFIRMED',
          case2RuleVersion: CASE2_RULE_VERSION, pendingTerminationId: pending.pendingTerminationId,
          primaryFeatureFractalId: pending.primaryFeatureFractalId,
          reverseFeatureFractalId: reverseFractal.featureFractalId,
          scope: 'single-candidate Case2; no endpoint replacement, BROKEN or successor handoff' } });
      const provenance = { primaryFeatureFractalId: pending.primaryFeatureFractalId,
        reverseFeatureFractalId: reverseFractal.featureFractalId,
        standardizedFeatureElementIds: unique([
          ...pending.sourceStandardizedFeatureIds,
          ...(reverseFractal.provenance?.standardizedFeatureElementIds || []),
        ]),
        rawFeatureElementIds: unique([
          ...pending.sourceRawFeatureIds,
          ...(reverseFractal.provenance?.rawFeatureElementIds || []),
        ]),
        strokeIds: unique([...pending.sourceStrokeIds, ...reverseSourceStrokeIds]),
        pendingTerminationId: pending.pendingTerminationId,
        endpointIdentity: pending.endpointIdentity };
      const event = c.createStructuralEvent({
        eventId: `${confirmed.segmentId}:CASE_2:CONFIRMED`,
        barIndex: confirmClock.rawBarIndex, barTime: confirmClock.time,
        structureId: confirmed.segmentId, structureType: STRUCTURE_SEGMENT,
        eventAction: c.CT_EVENT_ACTIONS.confirmed,
        modeBefore: 'EXTENDING', modeAfter: 'CONFIRMED',
        eventRawBarIndex: confirmed.eventRawBarIndex, eventTime: confirmed.eventTime,
        availableRawBarIndex: confirmed.availableRawBarIndex, availableTime: confirmed.availableTime,
        confirmRawBarIndex: confirmed.confirmRawBarIndex, confirmTime: confirmed.confirmTime,
        eventStrokeIndex: confirmed.eventStrokeIndex,
        availableStrokeIndex: confirmed.availableStrokeIndex,
        confirmStrokeIndex: confirmed.confirmStrokeIndex,
        eventIndex: confirmed.eventRawBarIndex, confirmIndex: confirmed.confirmRawBarIndex,
        ruleVersion: this.ruleConfig.segmentRuleVersion, provenance,
        metadata: { caseType: 'CASE_2', segmentId: confirmed.segmentId,
          direction: confirmed.direction, endpointIdentity: pending.endpointIdentity,
          endpointStrokeId: pending.endpointStrokeId,
          pendingTerminationId: pending.pendingTerminationId,
          primaryFeatureFractalId: pending.primaryFeatureFractalId,
          reverseFeatureFractalId: reverseFractal.featureFractalId,
          timeSchemaVersion: c.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
          case2RuleVersion: CASE2_RULE_VERSION },
      });
      this.confirmedSegment = confirmed;
      this.structuralEvents.push(event);
      this.#setPending({ status: STATUS.confirmed, staleReason: null,
        lastUpdatedRawBarIndex: now.rawBarIndex, lastUpdatedTime: now.time,
        metadata: { ...pending.metadata, reverseFeatureFractalId: reverseFractal.featureFractalId } });
      this.#decision('PENDING_TERMINATION_CONFIRMED', 'REVERSE_FEATURE_FRACTAL_CONFIRMED', confirmClock,
        { reverseFeatureFractalId: reverseFractal.featureFractalId });
      return event;
    }

    updateConfirmedStroke(stroke, currentAvailability, identity = {}) {
      if (!this.pendingTermination) throw new Error('NO_PENDING_TERMINATION');
      const now = normalizeAvailability(currentAvailability);
      const pending = this.pendingTermination;
      if (this.currentAvailability && (now.rawBarIndex < this.currentAvailability.rawBarIndex ||
        now.time < this.currentAvailability.time)) throw new Error('NON_MONOTONIC_CASE2_CLOCK');
      this.currentAvailability = now;
      if (pending.status !== STATUS.pending) return freeze({ events: [], reason: `PENDING_${pending.status}`,
        state: this.getState() });
      if (!identity.candidateSegmentId || !identity.endpointIdentity || !identity.ruleVersion) {
        return freeze({ events: [], reason: BLOCK_ACTION.identityRequired, state: this.getState() });
      }
      if (identity.candidateSegmentId !== pending.candidateSegmentId) {
        const event = this.#markStale(BLOCK_ACTION.candidateChanged, now);
        return freeze({ events: [event], reason: BLOCK_ACTION.candidateChanged, state: this.getState() });
      }
      if (identity.endpointIdentity !== pending.endpointIdentity) {
        const event = this.#markStale(BLOCK_ACTION.endpointChanged, now);
        return freeze({ events: [event], reason: BLOCK_ACTION.endpointChanged, state: this.getState() });
      }
      if (identity.ruleVersion !== pending.ruleVersion) {
        const event = this.#markStale(BLOCK_ACTION.ruleVersionChanged, now);
        return freeze({ events: [event], reason: BLOCK_ACTION.ruleVersionChanged, state: this.getState() });
      }
      if (stroke?.pendingTerminationId && stroke.pendingTerminationId !== pending.pendingTerminationId) {
        return freeze({ events: [], reason: 'CROSS_PENDING_EVIDENCE_FORBIDDEN', state: this.getState() });
      }
      const strokeId = String(stroke?.strokeId ?? stroke?.stroke_id ?? '');
      if (!strokeId) return freeze({ events: [], reason: 'INVALID_STROKE_PROVENANCE', state: this.getState() });
      if (this.consumedStrokeIds.includes(strokeId)) {
        return freeze({ events: [], reason: 'DUPLICATE_STROKE_IGNORED', state: this.getState() });
      }
      if (String(stroke.status || '').toUpperCase() !== 'CONFIRMED' || !availableAt(stroke, now)) {
        return freeze({ events: [], reason: 'FUTURE_DATA_REQUIRED', state: this.getState() });
      }
      const startIndex = Number(stroke.startIndex ?? stroke.start_index);
      const startTime = Number(stroke.startTime ?? stroke.start_time);
      if (!Number.isInteger(startIndex) || startIndex < pending.eventRawBarIndex ||
        !Number.isFinite(startTime) || startTime < pending.eventTime) {
        return freeze({ events: [], reason: 'REVERSE_SOURCE_BEFORE_ENDPOINT', state: this.getState() });
      }
      const confirmIndex = Number(stroke.confirmRawBarIndex ?? stroke.confirmIndex ?? stroke.confirm_index);
      const confirmTime = Number(stroke.confirmTime ?? stroke.confirm_time);
      const cursor = pending.reverseSequenceCursor;
      if (cursor.lastConfirmRawBarIndex !== null && (confirmIndex < cursor.lastConfirmRawBarIndex ||
        confirmTime < cursor.lastConfirmTime)) throw new Error('NON_MONOTONIC_REVERSE_STROKE');
      this.consumedStrokeIds.push(strokeId);
      const nextCursor = { consumedStrokeCount: cursor.consumedStrokeCount + 1,
        lastConsumedStrokeId: strokeId, lastConfirmRawBarIndex: confirmIndex, lastConfirmTime: confirmTime };
      this.#setPending({ reverseSequenceCursor: nextCursor,
        lastUpdatedRawBarIndex: now.rawBarIndex, lastUpdatedTime: now.time });

      const rawElement = c.buildReverseFeatureElement(stroke, {
        ruleConfig: this.ruleConfig,
        candidateSegmentDirection: pending.segmentDirection,
        sequenceId: pending.reverseSequenceId,
        sequenceOrdinal: this.reverseRawElements.length,
      });
      if (!rawElement) return freeze({ events: [], reason: 'NON_REVERSE_DIRECTION_STROKE_CONSUMED', state: this.getState() });
      const rawBefore = c.canonicalStateJson ? c.canonicalStateJson(rawElement) : JSON.stringify(rawElement);
      this.inclusionMachine.update(rawElement);
      if ((c.canonicalStateJson ? c.canonicalStateJson(rawElement) : JSON.stringify(rawElement)) !== rawBefore)
        throw new Error('REVERSE_RAW_SEQUENCE_MUTATED');
      this.reverseRawElements.push(clone(rawElement));
      const standardizationState = this.inclusionMachine.getState();
      this.reverseFeaturePacket = c.detectFeatureFractals(this.inclusionMachine.getDetectorInput(),
        { ruleConfig: this.ruleConfig });
      const requiredType = requiredReverseFractalType(pending.segmentDirection);
      const reverseFractalCandidate = this.reverseFeaturePacket.confirmedFeatureFractals.find(fractal =>
        fractal.type === requiredType && fractal.status === 'CONFIRMED');
      const reverseValidation = reverseFractalCandidate ? validateReverseFeatureConfirmation({
        pendingTermination: this.pendingTermination,
        reverseFeatureFractal: reverseFractalCandidate,
        standardizedElements: standardizationState.elements,
        rawElements: this.reverseRawElements,
        consumedStrokeIds: this.consumedStrokeIds,
        ruleConfig: this.ruleConfig,
      }) : freeze({ valid: false, reason: 'REVERSE_FEATURE_FRACTAL_NOT_CONFIRMED' });
      const reverseFractal = reverseValidation.valid ? reverseFractalCandidate : null;
      const events = [];
      if (reverseFractal) events.push(this.#finalize(reverseFractal, now, stroke));
      const reason = reverseFractal ? 'CASE2_CONFIRMED' :
        (reverseFractalCandidate ? reverseValidation.reason :
        (standardizationState.standardizationStatus === 'PENDING_DIRECTION'
          ? 'REVERSE_PENDING_DIRECTION' :
          (this.reverseFeaturePacket.candidateFeatureFractal
            ? 'REVERSE_FEATURE_FRACTAL_CANDIDATE' : 'INSUFFICIENT_REVERSE_EVIDENCE')));
      return freeze({ events, reason, reverseFeaturePacket: this.reverseFeaturePacket,
        reverseValidation,
        pendingTermination: this.getPendingTermination(), confirmedSegment: this.getConfirmedSegment(),
        state: this.getState() });
    }

    getPendingTermination() { return this.pendingTermination ? clone(this.pendingTermination) : null; }
    getConfirmedSegment() { return this.confirmedSegment ? clone(this.confirmedSegment) : null; }
    getStructuralEvents() { return clone(this.structuralEvents); }
    getDecisionEvents() { return clone(this.decisionEvents); }

    getState() {
      const inclusionState = this.inclusionMachine?.getState() ?? null;
      const activeMemory = { pendingTermination: this.pendingTermination,
        stalePendingHistory: this.stalePendingHistory,
        reverseSequenceCursor: this.pendingTermination?.reverseSequenceCursor ?? null,
        reverseRawElements: this.reverseRawElements,
        reverseStandardizationState: inclusionState,
        reverseFeatureState: this.reverseFeaturePacket,
        consumedStrokeIds: this.consumedStrokeIds };
      return freeze({ case2RuleVersion: CASE2_RULE_VERSION,
        continuationVersion: CONTINUATION_VERSION,
        ruleVersion: this.ruleConfig.segmentRuleVersion,
        status: this.pendingTermination?.status ?? 'NO_PENDING',
        currentAvailability: this.currentAvailability,
        activeMemory,
        activeMemorySize: c.estimateActiveMemorySize ? c.estimateActiveMemorySize(activeMemory) : 0,
        confirmedSegment: this.confirmedSegment,
        structuralEvents: this.structuralEvents,
        decisionEvents: this.decisionEvents });
    }

    serializeContinuationState() {
      return freeze({ continuationVersion: CONTINUATION_VERSION,
        timeSchemaVersion: c.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        ruleConfig: this.ruleConfig,
        pendingTermination: this.pendingTermination,
        stalePendingHistory: this.stalePendingHistory,
        reverseRawElements: this.reverseRawElements,
        inclusionContinuation: this.inclusionMachine?.getContinuationState() ?? null,
        reverseFeaturePacket: this.reverseFeaturePacket,
        consumedStrokeIds: this.consumedStrokeIds,
        confirmedSegment: this.confirmedSegment,
        structuralEvents: this.structuralEvents,
        decisionEvents: this.decisionEvents,
        currentAvailability: this.currentAvailability });
    }

    restoreContinuationState(snapshot) {
      const state = clone(snapshot);
      if (!state || state.continuationVersion !== CONTINUATION_VERSION ||
        state.timeSchemaVersion !== c.CT_STRUCTURAL_TIME_SCHEMA_VERSION) {
        throw new Error('INCOMPATIBLE_CASE2_CONTINUATION');
      }
      const restoredRule = c.createCTRuleConfig(state.ruleConfig || {});
      if (restoredRule.segmentRuleVersion !== this.ruleConfig.segmentRuleVersion ||
        restoredRule.priceTolerance !== this.ruleConfig.priceTolerance ||
        restoredRule.numericTolerance !== this.ruleConfig.numericTolerance) {
        throw new Error('CASE2_CONTINUATION_RULE_MISMATCH');
      }
      this.pendingTermination = state.pendingTermination;
      this.stalePendingHistory = state.stalePendingHistory || [];
      this.reverseRawElements = state.reverseRawElements || [];
      this.reverseFeaturePacket = state.reverseFeaturePacket;
      this.consumedStrokeIds = state.consumedStrokeIds || [];
      this.confirmedSegment = state.confirmedSegment;
      this.structuralEvents = state.structuralEvents || [];
      this.decisionEvents = state.decisionEvents || [];
      this.currentAvailability = state.currentAvailability;
      if (this.pendingTermination && state.inclusionContinuation) {
        this.inclusionMachine = new c.FeatureSequenceInclusionStateMachine(
          this.#reverseContext(this.pendingTermination), { priceTolerance: this.ruleConfig.priceTolerance });
        this.inclusionMachine.restoreContinuationState(state.inclusionContinuation);
      }
      return this;
    }
  }

  Object.assign(c, {
    SEGMENT_CASE2_RULE_VERSION: CASE2_RULE_VERSION,
    SEGMENT_CASE2_CONTINUATION_VERSION: CONTINUATION_VERSION,
    SEGMENT_PENDING_TERMINATION_STATUSES: STATUS,
    SEGMENT_CASE2_BLOCK_ACTIONS: BLOCK_ACTION,
    evaluateSegmentCase2Entry,
    createPendingTermination,
    requiredReverseFractalType,
    case2ConfirmationClock,
    validateReverseFeatureConfirmation,
    SegmentCase2StateMachine,
  });
})();
