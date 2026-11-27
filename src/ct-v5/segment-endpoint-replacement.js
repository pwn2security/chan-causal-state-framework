(function () {
  'use strict';

  const c = window.MarketCore = window.MarketCore || {};
  const REPLACEMENT_RULE_VERSION = 'CT-Segment-Endpoint-Replacement-R1.0';
  const CONTINUATION_VERSION = 'CT-Segment-Endpoint-Lifecycle-Continuation-v1.0';
  const freeze = value => c.deepFreeze ? c.deepFreeze(c.clonePlain(value)) : Object.freeze(value);
  const clone = value => c.clonePlain ? c.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function requireDependencies() {
    for (const name of ['createCTRuleConfig', 'validateEndpointProposal']) {
      if (typeof c[name] !== 'function') throw new Error(`CT endpoint replacement requires MarketCore.${name}`);
    }
  }

  function candidateIdOf(candidate) {
    return candidate?.segmentCandidateId ?? candidate?.segmentId ?? null;
  }

  function computeSegmentEndpointIdentity(input) {
    const values = [input.segmentCandidateId, input.endpointStrokeId, input.endpointFractalId,
      input.eventTime, input.ruleVersion];
    if (values.some(value => value === null || value === undefined || value === '') ||
        !finite(Number(input.eventTime))) throw new Error('INVALID_SEGMENT_ENDPOINT_IDENTITY_SEED');
    return `endpoint:${values.join(':')}`;
  }

  function createActiveSegmentEndpoint(input, candidate, ruleConfig = {}) {
    const config = c.createCTRuleConfig(ruleConfig.ruleConfig || ruleConfig);
    const segmentCandidateId = candidateIdOf(candidate);
    const endpointStrokeId = input.endpointStrokeId;
    const endpointFractalId = input.endpointFractalId;
    const endpointPrice = Number(input.endpointPrice ?? input.price);
    const eventRawBarIndex = Number(input.eventRawBarIndex ?? input.endpointRawBarIndex);
    const eventTime = Number(input.eventTime ?? input.endpointTime);
    const availableRawBarIndex = Number(input.availableRawBarIndex ??
      input.endpointAvailableRawBarIndex ?? input.proposalAvailableRawBarIndex);
    const availableTime = Number(input.availableTime ??
      input.endpointAvailableTime ?? input.proposalAvailableTime);
    if (!segmentCandidateId || !endpointStrokeId || !endpointFractalId || !finite(endpointPrice) ||
        !Number.isInteger(eventRawBarIndex) || !finite(eventTime) ||
        !Number.isInteger(availableRawBarIndex) || !finite(availableTime) ||
        eventRawBarIndex > availableRawBarIndex || eventTime > availableTime) {
      throw new Error('INVALID_ACTIVE_SEGMENT_ENDPOINT');
    }
    const endpointId = computeSegmentEndpointIdentity({ segmentCandidateId, endpointStrokeId,
      endpointFractalId, eventTime, ruleVersion: config.segmentRuleVersion });
    return freeze({ endpointId, segmentCandidateId, endpointStrokeId, endpointFractalId,
      endpointPrice, eventRawBarIndex, eventTime, availableRawBarIndex, availableTime,
      ruleVersion: config.segmentRuleVersion,
      sourceEndpointProposalId: input.endpointProposalId ?? null,
      provenance: clone(input.provenance || {}),
    });
  }

  function replacementDecision(reason, eligible, details = {}) {
    return freeze({ replacementEligible: eligible, reason,
      action: eligible ? 'ENDPOINT_REPLACED' : 'NO_REPLACEMENT', ...details });
  }

  function evaluateEndpointReplacement(input) {
    requireDependencies();
    const candidate = input?.candidateSegmentState ?? input?.candidate;
    const activeEndpoint = input?.activeEndpoint;
    const proposal = input?.endpointProposal ?? input?.proposal;
    const now = input?.currentAvailability;
    const config = c.createCTRuleConfig(input?.ruleConfig ?? {});
    const tolerance = Math.max(0, Number(config.numericTolerance ?? 0));
    const common = { segmentCandidateId: candidateIdOf(candidate),
      candidateRevision: Number(candidate?.candidateRevision ?? 0),
      endpointProposalId: proposal?.endpointProposalId ?? null,
      oldEndpointId: activeEndpoint?.endpointId ?? null,
      newEndpointId: null, comparison: 'NOT_EVALUATED' };
    if (!candidate || candidate.status === 'CONFIRMED') {
      return replacementDecision('REPLACEMENT_FORBIDDEN_CONFIRMED_SEGMENT', false, common);
    }
    if (!['FORMING', 'EXTENDING'].includes(candidate.status ?? candidate.mode)) {
      return replacementDecision('REPLACEMENT_CANDIDATE_NOT_ACTIVE', false, common);
    }
    if (!activeEndpoint) return replacementDecision('REPLACEMENT_ACTIVE_ENDPOINT_REQUIRED', false, common);
    if (!now || !Number.isInteger(now.rawBarIndex) || !finite(now.time)) {
      return replacementDecision('REPLACEMENT_AVAILABILITY_INVALID', false, common);
    }
    const validation = c.validateEndpointProposal(proposal, {
      candidateSegmentState: candidate, currentAvailability: now,
    });
    if (!validation.valid) return replacementDecision(validation.reason, false, common);
    if (proposal.ruleVersion !== config.segmentRuleVersion || activeEndpoint.ruleVersion !== config.segmentRuleVersion) {
      return replacementDecision('REPLACEMENT_RULE_VERSION_MISMATCH', false, common);
    }
    if (proposal.segmentCandidateId !== activeEndpoint.segmentCandidateId ||
        proposal.segmentCandidateId !== candidateIdOf(candidate)) {
      return replacementDecision('REPLACEMENT_CANDIDATE_MISMATCH', false, common);
    }
    if (proposal.segmentDirection !== candidate.direction) {
      return replacementDecision('REPLACEMENT_DIRECTION_MISMATCH', false, common);
    }
    const nextEndpoint = createActiveSegmentEndpoint(proposal, candidate, config);
    common.newEndpointId = nextEndpoint.endpointId;
    if (nextEndpoint.endpointId === activeEndpoint.endpointId) {
      return replacementDecision('REPLACEMENT_SAME_ENDPOINT', false,
        { ...common, comparison: 'SAME_ENDPOINT', nextEndpoint });
    }
    const delta = nextEndpoint.endpointPrice - activeEndpoint.endpointPrice;
    const equal = Math.abs(delta) <= tolerance;
    const moreExtreme = candidate.direction === 'UP' ? delta > tolerance : delta < -tolerance;
    const comparison = moreExtreme ? 'MORE_EXTREME' : (equal ? 'EQUAL_EXTREME' : 'LESS_EXTREME');
    if (!moreExtreme) return replacementDecision('NOT_MORE_EXTREME', false,
      { ...common, comparison, nextEndpoint });
    if (nextEndpoint.eventTime > now.time || nextEndpoint.availableTime > now.time ||
        nextEndpoint.eventRawBarIndex > now.rawBarIndex || nextEndpoint.availableRawBarIndex > now.rawBarIndex) {
      return replacementDecision('REPLACEMENT_FUTURE_EVIDENCE', false,
        { ...common, comparison, nextEndpoint });
    }
    return replacementDecision('REPLACEMENT_ELIGIBLE', true,
      { ...common, comparison, nextEndpoint });
  }

  function applyEndpointReplacementReset(input) {
    const decision = input?.decision;
    if (!decision?.replacementEligible || !decision.nextEndpoint) {
      return freeze({ applied: false, decision, candidate: clone(input.candidate),
        activeEndpoint: clone(input.activeEndpoint), pendingTermination: clone(input.pendingTermination),
        reverseState: clone(input.reverseState), lifecycleEvent: null });
    }
    const candidate = clone(input.candidate);
    const oldEndpoint = clone(input.activeEndpoint);
    const nextEndpoint = clone(decision.nextEndpoint);
    const now = input.currentAvailability;
    const oldRevision = Number(candidate.candidateRevision ?? 0);
    const newRevision = oldRevision + 1;
    const eventId = `${REPLACEMENT_RULE_VERSION}:event:${candidateIdOf(candidate)}:${oldRevision}>${newRevision}:${oldEndpoint.endpointId}>${nextEndpoint.endpointId}`;
    const lifecycleEvent = freeze({ eventId, lifecycleAction: 'ENDPOINT_REPLACED',
      segmentCandidateId: candidateIdOf(candidate), endpointProposalId: decision.endpointProposalId,
      oldEndpointId: oldEndpoint.endpointId, newEndpointId: nextEndpoint.endpointId,
      oldEndpointStrokeId: oldEndpoint.endpointStrokeId,
      newEndpointStrokeId: nextEndpoint.endpointStrokeId,
      oldEndpointFractalId: oldEndpoint.endpointFractalId,
      newEndpointFractalId: nextEndpoint.endpointFractalId,
      oldCandidateRevision: oldRevision, newCandidateRevision: newRevision,
      eventTime: nextEndpoint.eventTime, availableTime: nextEndpoint.availableTime,
      replacementDecisionRawBarIndex: now.rawBarIndex, replacementDecisionTime: now.time,
      sourceStrokeId: nextEndpoint.endpointStrokeId, ruleVersion: nextEndpoint.ruleVersion,
      provenance: clone(nextEndpoint.provenance) });
    const updatedCandidate = freeze({ ...candidate,
      segmentCandidateId: candidateIdOf(candidate), candidateRevision: newRevision,
      activeEndpoint: nextEndpoint,
      metadata: { ...(candidate.metadata || {}), activeEndpointId: nextEndpoint.endpointId,
        lastEndpointProposalId: decision.endpointProposalId,
        lastEndpointReplacementEventId: eventId } });
    let pending = clone(input.pendingTermination);
    if (pending?.status === 'PENDING') pending = freeze({ ...pending, status: 'STALE',
      staleReason: 'CASE2_BLOCKED_ENDPOINT_CHANGED', invalidatedByEndpointId: nextEndpoint.endpointId,
      invalidatedByProposalId: decision.endpointProposalId,
      replacementEventId: eventId,
      staleAtRawBarIndex: now.rawBarIndex, staleAtTime: now.time,
      lastUpdatedRawBarIndex: now.rawBarIndex, lastUpdatedTime: now.time });
    const reverseState = pending?.status === 'STALE' ? freeze({
      reverseRawElements: [], reverseStandardizationState: null,
      reverseFeatureState: null, consumedStrokeIds: [],
      reverseSequenceCursor: { consumedStrokeCount: 0, lastConsumedStrokeId: null,
        lastConfirmRawBarIndex: null, lastConfirmTime: null },
      invalidatedByEndpointId: nextEndpoint.endpointId,
    }) : clone(input.reverseState);
    return freeze({ applied: true, decision, candidate: updatedCandidate,
      activeEndpoint: nextEndpoint, pendingTermination: pending,
      reverseState, lifecycleEvent });
  }

  class SegmentEndpointLifecycleStateMachine {
    constructor(input = {}, continuationState = null) {
      requireDependencies();
      this.ruleConfig = c.createCTRuleConfig(input.ruleConfig || input);
      this.candidate = null;
      this.activeEndpoint = null;
      this.pendingTermination = null;
      this.reverseState = null;
      this.consumedProposalIds = [];
      this.lifecycleEvents = [];
      this.currentAvailability = null;
      if (continuationState) this.restoreContinuationState(continuationState);
      else this.initialize(input);
    }

    initialize(input) {
      this.candidate = freeze(clone(input.candidate));
      this.activeEndpoint = freeze(clone(input.activeEndpoint));
      this.pendingTermination = input.pendingTermination ? freeze(clone(input.pendingTermination)) : null;
      this.reverseState = input.reverseState ? freeze(clone(input.reverseState)) : null;
      this.currentAvailability = input.currentAvailability ? freeze(clone(input.currentAvailability)) : null;
      return this;
    }

    syncCandidate(candidate) {
      if (candidateIdOf(candidate) !== candidateIdOf(this.candidate)) throw new Error('LIFECYCLE_CANDIDATE_MISMATCH');
      this.candidate = freeze({ ...clone(candidate), candidateRevision: this.candidate.candidateRevision,
        activeEndpoint: this.activeEndpoint });
      return this;
    }

    syncPending(pendingTermination, reverseState = null) {
      this.pendingTermination = pendingTermination ? freeze(clone(pendingTermination)) : null;
      this.reverseState = reverseState ? freeze(clone(reverseState)) : null;
      return this;
    }

    process(proposal, currentAvailability) {
      const now = freeze(clone(currentAvailability));
      if (this.currentAvailability && (now.rawBarIndex < this.currentAvailability.rawBarIndex ||
          now.time < this.currentAvailability.time)) throw new Error('NON_MONOTONIC_ENDPOINT_LIFECYCLE_CLOCK');
      this.currentAvailability = now;
      if (this.consumedProposalIds.includes(proposal?.endpointProposalId)) {
        return freeze({ applied: false, reason: 'ENDPOINT_PROPOSAL_ALREADY_CONSUMED',
          state: this.getState(), events: [] });
      }
      const decision = evaluateEndpointReplacement({ candidate: this.candidate,
        activeEndpoint: this.activeEndpoint, endpointProposal: proposal,
        currentAvailability: now, ruleConfig: this.ruleConfig });
      if (!decision.replacementEligible) return freeze({ applied: false, reason: decision.reason,
        decision, state: this.getState(), events: [] });
      const reset = applyEndpointReplacementReset({ decision, candidate: this.candidate,
        activeEndpoint: this.activeEndpoint, pendingTermination: this.pendingTermination,
        reverseState: this.reverseState, currentAvailability: now });
      this.candidate = reset.candidate;
      this.activeEndpoint = reset.activeEndpoint;
      this.pendingTermination = reset.pendingTermination;
      this.reverseState = reset.reverseState;
      this.consumedProposalIds.push(proposal.endpointProposalId);
      this.lifecycleEvents.push(reset.lifecycleEvent);
      return freeze({ applied: true, reason: 'ENDPOINT_REPLACED', decision,
        lifecycleEvent: reset.lifecycleEvent, events: [reset.lifecycleEvent], state: this.getState() });
    }

    getState() {
      return freeze({ continuationVersion: CONTINUATION_VERSION,
        ruleVersion: this.ruleConfig.segmentRuleVersion,
        candidate: this.candidate, activeEndpoint: this.activeEndpoint,
        pendingTermination: this.pendingTermination, reverseState: this.reverseState,
        consumedProposalIds: this.consumedProposalIds,
        lifecycleEvents: this.lifecycleEvents,
        currentAvailability: this.currentAvailability });
    }

    serializeContinuationState() {
      return this.getState();
    }

    restoreContinuationState(snapshot) {
      const state = clone(snapshot);
      if (!state || state.continuationVersion !== CONTINUATION_VERSION) {
        throw new Error('INCOMPATIBLE_ENDPOINT_LIFECYCLE_CONTINUATION');
      }
      if (state.ruleVersion !== this.ruleConfig.segmentRuleVersion) {
        throw new Error('ENDPOINT_LIFECYCLE_CONTINUATION_RULE_MISMATCH');
      }
      this.candidate = freeze(state.candidate);
      this.activeEndpoint = freeze(state.activeEndpoint);
      this.pendingTermination = state.pendingTermination ? freeze(state.pendingTermination) : null;
      this.reverseState = state.reverseState ? freeze(state.reverseState) : null;
      this.consumedProposalIds = state.consumedProposalIds || [];
      this.lifecycleEvents = state.lifecycleEvents || [];
      this.currentAvailability = state.currentAvailability;
      return this;
    }
  }

  Object.assign(c, {
    SEGMENT_ENDPOINT_REPLACEMENT_RULE_VERSION: REPLACEMENT_RULE_VERSION,
    SEGMENT_ENDPOINT_LIFECYCLE_CONTINUATION_VERSION: CONTINUATION_VERSION,
    computeSegmentEndpointIdentity,
    createActiveSegmentEndpoint,
    evaluateEndpointReplacement,
    applyEndpointReplacementReset,
    SegmentEndpointLifecycleStateMachine,
  });
})();
