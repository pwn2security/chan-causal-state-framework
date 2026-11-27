(function () {
  'use strict';

  const c = window.MarketCore = window.MarketCore || {};
  const PROPOSAL_RULE_VERSION = 'CT-Segment-Endpoint-Proposal-R1.0';
  const PROPOSAL_IDENTITY_VERSION = 'CT-Segment-Endpoint-Proposal-Identity-v1.0';
  const STATUS = Object.freeze({ provisional: 'PROVISIONAL', eligible: 'ELIGIBLE', rejected: 'REJECTED' });
  const freeze = value => c.deepFreeze ? c.deepFreeze(c.clonePlain(value)) : Object.freeze(value);
  const clone = value => c.clonePlain ? c.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const unique = values => [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))];
  const elementId = element => element?.standardizedFeatureElementId ?? element?.featureElementId ?? null;
  const same = (a, b) => (c.canonicalStateJson ? c.canonicalStateJson(a) : JSON.stringify(a)) ===
    (c.canonicalStateJson ? c.canonicalStateJson(b) : JSON.stringify(b));

  function requireDependencies() {
    for (const name of ['createCTRuleConfig', 'detectFeatureFractals', 'evaluateDirectionalExtremeEndpoint']) {
      if (typeof c[name] !== 'function') throw new Error(`CT endpoint proposal requires MarketCore.${name}`);
    }
  }

  function candidateIdOf(candidate) {
    return candidate?.segmentCandidateId ?? candidate?.segmentId ?? null;
  }

  function canonicalNumber(value, field) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`INVALID_ENDPOINT_PROPOSAL_${field.toUpperCase()}`);
    return number.toString();
  }

  function computeEndpointProposalIdentity(input) {
    const parts = [
      'proposal', input.segmentCandidateId, input.candidateRevisionAtProposal,
      'FEATURE_FRACTAL', input.sourceFeatureFractalId, input.endpointStrokeId,
      input.endpointFractalId, canonicalNumber(input.endpointPrice, 'price'),
      input.eventRawBarIndex, canonicalNumber(input.eventTime, 'eventTime'), input.ruleVersion,
    ];
    if (parts.some(value => value === null || value === undefined || value === '')) {
      throw new Error('INVALID_ENDPOINT_PROPOSAL_IDENTITY_SEED');
    }
    return parts.join(':');
  }

  function proposalPacket(reason, trace, proposal = null) {
    return freeze({
      eligible: Boolean(proposal),
      reason,
      endpointProposal: proposal,
      decisionTrace: { ...trace, proposalResult: proposal ? STATUS.eligible : 'EMPTY', reason },
    });
  }

  function sourceAvailabilityClock(items) {
    let latest = { rawBarIndex: -1, time: Number.NEGATIVE_INFINITY };
    for (const item of items) {
      if (!Number.isInteger(item.rawBarIndex) || item.rawBarIndex < 0 || !finite(item.time)) return null;
      if ((item.rawBarIndex > latest.rawBarIndex && item.time < latest.time) ||
          (item.rawBarIndex < latest.rawBarIndex && item.time > latest.time)) return null;
      if (item.rawBarIndex > latest.rawBarIndex || item.time > latest.time) latest = item;
    }
    return latest.rawBarIndex >= 0 ? latest : null;
  }

  function validateEndpointProposal(proposal, context = {}) {
    const required = [
      'endpointProposalId', 'segmentCandidateId', 'candidateRevisionAtProposal', 'segmentDirection',
      'proposalStatus', 'sourceFeatureFractalId', 'sourceStandardizedFeatureIds',
      'sourceRawFeatureIds', 'sourceStrokeIds', 'endpointStrokeId', 'endpointFractalId',
      'endpointPrice', 'eventRawBarIndex', 'eventTime', 'proposalAvailableRawBarIndex',
      'proposalAvailableTime', 'ruleVersion', 'timeSchemaVersion', 'provenance', 'metadata',
    ];
    if (!proposal || required.some(field => !Object.prototype.hasOwnProperty.call(proposal, field))) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_SCHEMA_INVALID' });
    }
    if (proposal.proposalStatus !== STATUS.eligible || !['UP', 'DOWN'].includes(proposal.segmentDirection) ||
        !Number.isInteger(proposal.candidateRevisionAtProposal) || proposal.candidateRevisionAtProposal < 0) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_STATUS_INVALID' });
    }
    if (!Number.isInteger(proposal.eventRawBarIndex) || !Number.isInteger(proposal.proposalAvailableRawBarIndex) ||
        proposal.eventRawBarIndex > proposal.proposalAvailableRawBarIndex ||
        !finite(proposal.eventTime) || !finite(proposal.proposalAvailableTime) ||
        proposal.eventTime > proposal.proposalAvailableTime) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_TIME_INVALID' });
    }
    if (proposal.timeSchemaVersion !== c.CT_STRUCTURAL_TIME_SCHEMA_VERSION) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_TIME_SCHEMA_MISMATCH' });
    }
    if (!Array.isArray(proposal.sourceStandardizedFeatureIds) || !proposal.sourceStandardizedFeatureIds.length ||
        !Array.isArray(proposal.sourceRawFeatureIds) || !proposal.sourceRawFeatureIds.length ||
        !Array.isArray(proposal.sourceStrokeIds) || !proposal.sourceStrokeIds.length ||
        !proposal.provenance?.sourceFeatureFractalId || !proposal.provenance?.endpointStrokeId) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_PROVENANCE_INVALID' });
    }
    const provenance = proposal.provenance;
    if (provenance.sourceFeatureFractalId !== proposal.sourceFeatureFractalId ||
        provenance.endpointStrokeId !== proposal.endpointStrokeId ||
        provenance.endpointFractalId !== proposal.endpointFractalId ||
        !proposal.sourceStrokeIds.includes(proposal.endpointStrokeId) ||
        !same(provenance.sourceStandardizedFeatureIds, proposal.sourceStandardizedFeatureIds) ||
        !same(provenance.sourceRawFeatureIds, proposal.sourceRawFeatureIds) ||
        !same(provenance.sourceStrokeIds, proposal.sourceStrokeIds)) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_PROVENANCE_INVALID' });
    }
    const expectedId = computeEndpointProposalIdentity(proposal);
    if (proposal.endpointProposalId !== expectedId) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_IDENTITY_INVALID' });
    }
    const candidate = context.candidateSegmentState ?? context.candidate;
    if (candidate && (proposal.segmentCandidateId !== candidateIdOf(candidate) ||
        proposal.candidateRevisionAtProposal !== Number(candidate.candidateRevision ?? 0) ||
        proposal.segmentDirection !== candidate.direction)) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_CANDIDATE_MISMATCH' });
    }
    const now = context.currentAvailability;
    if (now && (proposal.proposalAvailableRawBarIndex > now.rawBarIndex ||
        proposal.proposalAvailableTime > now.time)) {
      return freeze({ valid: false, reason: 'ENDPOINT_PROPOSAL_FUTURE_EVIDENCE' });
    }
    return freeze({ valid: true, reason: 'ENDPOINT_PROPOSAL_VALID' });
  }

  // Production rule implementation. It consumes an already causal structural update;
  // it never scans market data or derives a proposal from a naked price extreme.
  function evaluateEndpointProposal(input) {
    requireDependencies();
    const candidate = input?.candidateSegmentState ?? input?.candidate;
    const fractal = input?.confirmedFeatureFractal ?? input?.featureFractal;
    const sequence = input?.standardizedSequence;
    const strokes = Array.isArray(input?.confirmedStrokes) ? input.confirmedStrokes : [];
    const now = input?.currentAvailability;
    const config = c.createCTRuleConfig(input?.ruleConfig ?? {});
    const candidateId = candidateIdOf(candidate);
    const candidateRevision = Number(candidate?.candidateRevision ?? 0);
    const trace = {
      proposalRuleVersion: PROPOSAL_RULE_VERSION,
      segmentCandidateId: candidateId,
      candidateRevisionAtProposal: candidateRevision,
      segmentDirection: candidate?.direction ?? null,
      sourceFeatureFractalId: fractal?.featureFractalId ?? null,
      sourceMaturity: fractal?.status === 'CONFIRMED'
        ? 'CONFIRMED_PRIMARY_FEATURE_FRACTAL' : (fractal ? 'FEATURE_FRACTAL_CANDIDATE' : 'NO_STRUCTURAL_SOURCE'),
      decisionAvailableRawBarIndex: now?.rawBarIndex ?? null,
      decisionAvailableTime: now?.time ?? null,
    };
    const fail = reason => proposalPacket(reason, trace);
    if (!candidate || !['FORMING', 'EXTENDING'].includes(candidate.status ?? candidate.mode)) {
      return fail(candidate?.status === 'CONFIRMED'
        ? 'PROPOSAL_BLOCKED_CONFIRMED_IMMUTABLE' : 'PROPOSAL_CANDIDATE_NOT_ACTIVE');
    }
    if (!candidateId || !Number.isInteger(candidateRevision) || candidateRevision < 0) {
      return fail('PROPOSAL_CANDIDATE_IDENTITY_INVALID');
    }
    if (!now || !Number.isInteger(now.rawBarIndex) || now.rawBarIndex < 0 || !finite(now.time)) {
      return fail('PROPOSAL_AVAILABILITY_INVALID');
    }
    if (!fractal) return fail('NO_PROPOSAL_SOURCE_MATURITY');
    if (fractal.status !== 'CONFIRMED') return fail('PROVISIONAL_ONLY');
    const expectedType = candidate.direction === 'UP' ? 'FEATURE_TOP' : 'FEATURE_BOTTOM';
    const expectedFeatureDirection = candidate.direction === 'UP' ? 'DOWN' : 'UP';
    if (fractal.type !== expectedType) return fail('PROPOSAL_DIRECTION_MISMATCH');
    if (config.segmentRuleVersion !== 'CT-Segment-R1.0' || !sequence ||
        sequence.ruleVersion !== 'CT-Segment-R1.0' || sequence.candidateSegmentId !== candidateId ||
        sequence.segmentStartDirection !== candidate.direction ||
        sequence.featureDirection !== expectedFeatureDirection) return fail('PROPOSAL_RULE_OR_SEQUENCE_MISMATCH');
    const position = sequence.elements?.findIndex(element =>
      element.featureSequenceIndex === fractal.eventFeatureIndex) ?? -1;
    const triple = position >= 1 ? sequence.elements.slice(position - 1, position + 2) : [];
    if (triple.length !== 3 || triple.some(element => element.status !== 'STANDARDIZED' ||
        element.ruleVersion !== 'CT-Segment-R1.0' || element.sequenceId !== sequence.sequenceId ||
        element.candidateSegmentId !== candidateId ||
        element.metadata?.sealingPolicy !== 'NON_INCLUDING_SUCCESSOR')) {
      return fail('PROPOSAL_SOURCE_NOT_STABLE');
    }
    let trusted = null;
    try {
      trusted = c.detectFeatureFractals({ ...sequence, standardizationStatus: 'STANDARDIZED' },
        { ruleConfig: config }).confirmedFeatureFractals.find(item =>
        item.featureFractalId === fractal.featureFractalId);
    } catch {
      return fail('PROPOSAL_FEATURE_EVIDENCE_INVALID');
    }
    if (!trusted || !same(trusted, fractal)) return fail('PROPOSAL_FEATURE_EVIDENCE_MISMATCH');
    const byId = new Map(strokes.map(stroke => [stroke.strokeId, stroke]));
    if (byId.size !== strokes.length || candidate.strokeCount !== strokes.length ||
        !same(candidate.strokeIds, strokes.map(stroke => stroke.strokeId))) {
      return fail('PROPOSAL_INVALID_PROVENANCE');
    }
    const evidenceStrokeIds = unique(triple.flatMap(element => [
      ...(element.sourceStrokeIds || []), ...(element.metadata?.witnessStrokeIds || []),
    ]));
    if (evidenceStrokeIds.some(strokeId => !byId.has(strokeId))) {
      return fail('PROPOSAL_INVALID_PROVENANCE');
    }
    const middle = triple[1];
    const target = candidate.direction === 'UP' ? middle.high : middle.low;
    const hit = strokes.map((stroke, index) => ({ stroke, index })).find(({ stroke }) =>
      middle.sourceStrokeIds.includes(stroke.strokeId) && stroke.direction === sequence.featureDirection &&
      Math.abs(stroke.startPrice - target) <= config.numericTolerance);
    if (!hit || hit.index === 0) return fail('PROPOSAL_ENDPOINT_MAPPING_UNRESOLVED');
    const endpoint = strokes[hit.index - 1];
    const primarySourceStroke = hit.stroke;
    const members = strokes.slice(0, hit.index);
    const continuous = members.every((stroke, index) => {
      const previous = members[index - 1];
      return stroke.status === 'CONFIRMED' && (stroke.direction === 'UP'
        ? stroke.endPrice > stroke.startPrice : stroke.endPrice < stroke.startPrice) &&
        stroke.endIndex >= stroke.startIndex && stroke.endTime >= stroke.startTime && (!previous ||
        (stroke.direction !== previous.direction && previous.endFractalId === stroke.startFractalId &&
          previous.endIndex === stroke.startIndex && previous.endTime === stroke.startTime &&
          Math.abs(previous.endPrice - stroke.startPrice) <= config.numericTolerance));
    });
    const endpointMappingValid = members.length >= config.minimumSegmentStrokeCount && members.length % 2 === 1 &&
      members[0].strokeId === candidate.startStrokeId && members[0].direction === candidate.direction &&
      endpoint.direction === candidate.direction && primarySourceStroke.startFractalId &&
      endpoint.endFractalId === primarySourceStroke.startFractalId &&
      endpoint.endIndex === primarySourceStroke.startIndex && endpoint.endTime === primarySourceStroke.startTime &&
      Math.abs(endpoint.endPrice - primarySourceStroke.startPrice) <= config.numericTolerance && continuous;
    if (!endpointMappingValid) return fail('PROPOSAL_INVALID_PROVENANCE');
    const endpointGuard = c.evaluateDirectionalExtremeEndpoint({
      direction: candidate.direction, startPrice: members[0].startPrice,
      endpointPrice: endpoint.endPrice,
      memberPrices: members.flatMap(stroke => [stroke.startPrice, stroke.endPrice]),
      numericTolerance: config.numericTolerance,
    });
    if (!endpointGuard.valid) return fail('PROPOSAL_ENDPOINT_GUARD_REJECTED');
    const availabilityItems = [
      { rawBarIndex: fractal.confirmRawBarIndex, time: fractal.confirmTime },
      ...triple.map(element => ({ rawBarIndex: element.standardizationAvailableRawBarIndex,
        time: element.standardizationAvailableTime })),
      { rawBarIndex: endpoint.availableRawBarIndex ?? endpoint.confirmRawBarIndex ?? endpoint.confirmIndex,
        time: endpoint.availableTime ?? endpoint.confirmTime },
      ...evidenceStrokeIds.map(strokeId => ({ rawBarIndex: byId.get(strokeId).confirmRawBarIndex ??
        byId.get(strokeId).confirmIndex, time: byId.get(strokeId).confirmTime })),
    ];
    const available = sourceAvailabilityClock(availabilityItems);
    if (!available || available.rawBarIndex > now.rawBarIndex || available.time > now.time ||
        endpoint.endIndex > available.rawBarIndex || endpoint.endTime > available.time) {
      return fail('PROPOSAL_FUTURE_EVIDENCE_REQUIRED');
    }
    const sourceStandardizedFeatureIds = triple.map(elementId);
    const sourceRawFeatureIds = unique(triple.flatMap(element => element.sourceFeatureElementIds || []));
    const sourceStrokeIds = unique([...evidenceStrokeIds, ...members.map(stroke => stroke.strokeId)]);
    const seed = {
      segmentCandidateId: candidateId,
      candidateRevisionAtProposal: candidateRevision,
      sourceFeatureFractalId: fractal.featureFractalId,
      endpointStrokeId: endpoint.strokeId,
      endpointFractalId: endpoint.endFractalId,
      endpointPrice: endpoint.endPrice,
      eventRawBarIndex: endpoint.endIndex,
      eventTime: endpoint.endTime,
      ruleVersion: config.segmentRuleVersion,
    };
    const proposal = {
      endpointProposalId: computeEndpointProposalIdentity(seed),
      proposalId: computeEndpointProposalIdentity(seed),
      ...seed,
      segmentDirection: candidate.direction,
      proposalStatus: STATUS.eligible,
      sourceStructuralType: 'FEATURE_FRACTAL',
      sourceStructuralId: fractal.featureFractalId,
      sourceStrokeId: endpoint.strokeId,
      sourceFractalId: endpoint.endFractalId,
      price: endpoint.endPrice,
      sourceStandardizedFeatureIds,
      sourceRawFeatureIds,
      sourceStrokeIds,
      proposalAvailableRawBarIndex: available.rawBarIndex,
      proposalAvailableTime: available.time,
      timeSchemaVersion: c.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      provenance: {
        sourceFeatureFractalId: fractal.featureFractalId,
        sourceStandardizedFeatureIds,
        sourceRawFeatureIds,
        sourceStrokeIds,
        endpointStrokeId: endpoint.strokeId,
        endpointFractalId: endpoint.endFractalId,
        candidateMemberStrokeIds: members.map(stroke => stroke.strokeId),
      },
      metadata: {
        proposalRuleVersion: PROPOSAL_RULE_VERSION,
        proposalIdentityVersion: PROPOSAL_IDENTITY_VERSION,
        mapping: 'CONFIRMED_FEATURE_FRACTAL_MIDDLE_TO_PRECEDING_MEMBER_STROKE',
        endpointGuardRuleId: endpointGuard.ruleId,
        endpointGuardRuleStatus: endpointGuard.ruleStatus,
      },
    };
    const validation = validateEndpointProposal(proposal, {
      candidateSegmentState: candidate, currentAvailability: now,
    });
    if (!validation.valid) return fail(validation.reason);
    return proposalPacket('ENDPOINT_PROPOSAL_ELIGIBLE', trace, proposal);
  }

  Object.assign(c, {
    SEGMENT_ENDPOINT_PROPOSAL_RULE_VERSION: PROPOSAL_RULE_VERSION,
    SEGMENT_ENDPOINT_PROPOSAL_IDENTITY_VERSION: PROPOSAL_IDENTITY_VERSION,
    SEGMENT_ENDPOINT_PROPOSAL_STATUSES: STATUS,
    computeEndpointProposalIdentity,
    validateEndpointProposal,
    evaluateEndpointProposal,
  });
})();
