(function () {
  'use strict';

  const c = window.MarketCore = window.MarketCore || {};
  const HANDOFF_RULE_VERSION = 'CT-Segment-Sequential-Lifecycle-R1.0';
  const CONTINUATION_VERSION = 'CT-Segment-Sequential-Continuation-v2.0';
  const STOP = Object.freeze({
    noSuccessorYet: 'NO_LEGAL_SUCCESSOR_YET',
    emptyRetainAnchor: 'EMPTY_RETAIN_CONFIRMED_ANCHOR',
    restartUnresolved: 'RESTART_REQUIRED_BUT_UNRESOLVED',
    sourceIncompatible: 'SOURCE_CHAIN_INCOMPATIBLE',
    futureRejected: 'FUTURE_SOURCE_REJECTED',
    duplicate: 'DUPLICATE_SUCCESSOR_SOURCE',
    predecessorReuse: 'PREDECESSOR_STROKE_REUSE_FORBIDDEN',
    handoffConsumed: 'HANDOFF_ALREADY_CONSUMED',
    maxCascade: 'CASCADE_DEFENSIVE_LIMIT',
  });
  const DEFENSIVE_MAX_CASCADE = 32;
  const clone = value => c.clonePlain ? c.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const freeze = value => c.deepFreeze ? c.deepFreeze(clone(value)) : Object.freeze(clone(value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function oppositeDirection(direction) {
    if (direction === 'UP') return 'DOWN';
    if (direction === 'DOWN') return 'UP';
    throw new Error('INVALID_PREDECESSOR_DIRECTION');
  }

  function strokeRevisionKey(stroke) {
    return `${stroke.strokeId}@${stroke.confirmRawBarIndex ?? stroke.confirmIndex}@${stroke.confirmTime}`;
  }

  function sharedEndpointOf(predecessor) {
    return freeze({
      endpointStrokeId: predecessor.endpointStrokeId || predecessor.endStrokeId,
      endpointFractalId: predecessor.endpointFractalId || predecessor.endFractalId || null,
      eventRawBarIndex: predecessor.eventRawBarIndex ?? predecessor.endpointRawBarIndex,
      eventTime: predecessor.eventTime ?? predecessor.endpointTime,
      price: predecessor.endpointPrice ?? predecessor.endPrice,
    });
  }

  function startsAtSharedEndpoint(stroke, endpoint, tolerance) {
    if (!stroke || !endpoint) return false;
    const fractalOk = !endpoint.endpointFractalId || !stroke.startFractalId ||
      stroke.startFractalId === endpoint.endpointFractalId;
    const indexOk = !Number.isInteger(endpoint.eventRawBarIndex) ||
      stroke.startIndex === endpoint.eventRawBarIndex;
    const timeOk = !finite(endpoint.eventTime) || stroke.startTime === endpoint.eventTime;
    const priceOk = !finite(endpoint.price) ||
      Math.abs(Number(stroke.startPrice) - Number(endpoint.price)) <= tolerance;
    return fractalOk && indexOk && timeOk && priceOk;
  }

  function continuesChain(previous, stroke, tolerance) {
    if (!previous) return false;
    return previous.endFractalId === stroke.startFractalId &&
      previous.endIndex === stroke.startIndex &&
      previous.endTime === stroke.startTime &&
      Math.abs(Number(previous.endPrice) - Number(stroke.startPrice)) <= tolerance &&
      previous.direction !== stroke.direction;
  }

  function confirmClock(stroke) {
    return {
      rawBarIndex: stroke.confirmRawBarIndex ?? stroke.confirmIndex,
      time: stroke.confirmTime,
    };
  }

  function availableByHandoff(stroke, handoff) {
    const clock = confirmClock(stroke);
    return Number.isInteger(clock.rawBarIndex) && finite(clock.time) &&
      clock.rawBarIndex <= handoff.rawBarIndex && clock.time <= handoff.time;
  }

  function predecessorMemberIds(predecessor) {
    return new Set(predecessor.strokeIds || predecessor.memberStrokeIds || []);
  }

  function findStartOrdinal(strokes, predecessor) {
    const endpointId = predecessor.endpointStrokeId || predecessor.endStrokeId;
    const index = strokes.findIndex(stroke => stroke.strokeId === endpointId);
    if (index < 0) return { startOrdinal: -1, boundaryViolation: true };
    return { startOrdinal: index + 1, boundaryViolation: false };
  }

  function buildSuccessorBacklog(input) {
    const predecessor = input.predecessor;
    const strokes = Array.isArray(input.strokesFromCursor) ? input.strokesFromCursor : [];
    const handoff = input.handoffAvailability;
    const config = c.createCTRuleConfig(input.ruleConfig || {});
    const tolerance = Math.max(0, Number(config.numericTolerance || 0));
    const consumed = new Set(input.consumedStrokeIdentities || []);
    const members = predecessorMemberIds(predecessor);
    const endpoint = sharedEndpointOf(predecessor);
    const successorDirection = oppositeDirection(predecessor.direction);
    const admitted = [];
    let previous = null;
    let reason = 'EMPTY';
    if (!predecessor || predecessor.status !== 'CONFIRMED' && predecessor.caseType) {
      /* publication objects are CONFIRMED even if status field is present */
    }
    for (const stroke of strokes) {
      const key = strokeRevisionKey(stroke);
      if (members.has(stroke.strokeId)) {
        return freeze({
          strokes: [], startCursor: null, endCursor: null, reason: STOP.predecessorReuse,
          implementationBoundaryViolation: false, successorDirection,
        });
      }
      if (consumed.has(key) || consumed.has(stroke.strokeId)) {
        return freeze({
          strokes: admitted, startCursor: admitted[0] ? strokeRevisionKey(admitted[0]) : null,
          endCursor: admitted.at(-1) ? strokeRevisionKey(admitted.at(-1)) : null,
          reason: STOP.duplicate, implementationBoundaryViolation: false, successorDirection,
        });
      }
      if (!availableByHandoff(stroke, handoff)) {
        reason = STOP.futureRejected;
        break;
      }
      const legal = admitted.length === 0
        ? (startsAtSharedEndpoint(stroke, endpoint, tolerance) && stroke.direction === successorDirection)
        : continuesChain(previous, stroke, tolerance);
      if (!legal) {
        reason = admitted.length ? STOP.sourceIncompatible : STOP.noSuccessorYet;
        break;
      }
      admitted.push(stroke);
      previous = stroke;
      reason = 'ADMITTED';
    }
    if (!admitted.length) {
      return freeze({
        strokes: [], startCursor: null, endCursor: null,
        reason: reason === 'ADMITTED' ? STOP.noSuccessorYet : reason,
        implementationBoundaryViolation: false, successorDirection, endpoint,
      });
    }
    return freeze({
      strokes: clone(admitted),
      startCursor: strokeRevisionKey(admitted[0]),
      endCursor: strokeRevisionKey(admitted.at(-1)),
      reason: 'BOUNDED_CAUSAL_REPLAY',
      implementationBoundaryViolation: false,
      successorDirection,
      endpoint,
    });
  }

  function createSuccessorCandidateId(ruleVersion, predecessorId, firstStrokeId) {
    return `candidate:${ruleVersion}:${predecessorId}:${firstStrokeId}`;
  }

  function createConfirmedPublicationId(ruleVersion, sourceCandidateId, revision, caseType) {
    return `confirmed:${ruleVersion}:${sourceCandidateId}:${revision}:${caseType}`;
  }

  function createSuccessorSeed(input) {
    const predecessor = input.predecessor;
    const backlog = input.backlog;
    const ruleVersion = input.ruleVersion || predecessor.segmentRuleVersion || 'CT-Segment-R1.0';
    if (!backlog?.strokes?.length) {
      return freeze({
        kind: 'EMPTY',
        reason: backlog?.reason || STOP.noSuccessorYet,
        predecessorSegmentId: predecessor.segmentId || predecessor.confirmedSegmentId,
        successorDirection: oppositeDirection(predecessor.direction),
        ruleVersion,
        timeSchemaVersion: c.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      });
    }
    const first = backlog.strokes[0];
    const handoff = input.handoffAvailability;
    const sourceIds = backlog.strokes.map(stroke => stroke.strokeId);
    const createdTime = Math.max(Number(predecessor.confirmTime), Number(handoff.time));
    const createdIndex = Math.max(Number(predecessor.confirmRawBarIndex ?? predecessor.confirmIndex),
      Number(handoff.rawBarIndex));
    return freeze({
      kind: 'SuccessorSeed',
      predecessorSegmentId: predecessor.confirmedSegmentId || predecessor.segmentId,
      predecessorSequenceIndex: predecessor.segmentSequenceIndex ?? null,
      predecessorConfirmedSegmentIndex: predecessor.segmentSequenceIndex ??
        input.predecessorConfirmedSegmentIndex ?? null,
      candidateLineageOrdinal: input.candidateLineageOrdinal ?? null,
      initialDirection: backlog.successorDirection,
      sharedEndpointId: `${backlog.endpoint.endpointStrokeId}:${backlog.endpoint.endpointFractalId}`,
      sharedEndpointPrice: backlog.endpoint.price,
      sharedEndpointEventTime: backlog.endpoint.eventTime,
      sharedEndpointEventRawBarIndex: backlog.endpoint.eventRawBarIndex,
      predecessorConfirmTime: predecessor.confirmTime,
      predecessorConfirmRawBarIndex: predecessor.confirmRawBarIndex ?? predecessor.confirmIndex,
      successorDirection: backlog.successorDirection,
      successorCandidateId: createSuccessorCandidateId(ruleVersion,
        predecessor.confirmedSegmentId || predecessor.segmentId, first.strokeId),
      candidateCreatedTime: createdTime,
      candidateAvailableRawBarIndex: createdIndex,
      eventTime: backlog.endpoint.eventTime,
      eventRawBarIndex: backlog.endpoint.eventRawBarIndex,
      sourceCursorStart: backlog.startCursor,
      backlogStartCursor: backlog.startCursor,
      backlogEndCursor: backlog.endCursor,
      sourceStrokeIds: sourceIds,
      startAnchor: clone(backlog.endpoint),
      startEndpoint: clone(backlog.endpoint),
      sourceCursor: {
        startStrokeId: first.strokeId,
        endStrokeId: backlog.strokes.at(-1).strokeId,
        consumedCount: sourceIds.length,
      },
      ruleVersion,
      timeSchemaVersion: c.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      provenance: {
        handoffRuleVersion: HANDOFF_RULE_VERSION,
        confirmationType: predecessor.caseType,
        firstSuccessorStrokeId: first.strokeId,
      },
    });
  }

  function evaluateHandoff(input) {
    const predecessor = input.predecessor;
    const consumedIds = new Set(input.handoffConsumedPredecessorIds || []);
    const predecessorId = predecessor.confirmedSegmentId || predecessor.segmentId;
    if (!predecessor || (predecessor.status && predecessor.status !== 'CONFIRMED')) {
      return freeze({ action: 'NO_HANDOFF', reason: 'PREDECESSOR_NOT_CONFIRMED', seed: null });
    }
    if (consumedIds.has(predecessorId)) {
      return freeze({ action: 'NO_HANDOFF', reason: STOP.handoffConsumed, seed: null });
    }
    const start = findStartOrdinal(input.confirmedStrokeContinuationBuffer || [], predecessor);
    if (start.boundaryViolation) {
      return freeze({
        action: 'EMPTY_BLOCK_SOURCE',
        reason: 'IMPLEMENTATION_BOUNDARY_VIOLATION_ENDPOINT_NOT_IN_BUFFER',
        seed: null,
        implementationBoundaryViolation: true,
      });
    }
    const window = (input.confirmedStrokeContinuationBuffer || []).slice(start.startOrdinal);
    const backlog = buildSuccessorBacklog({
      predecessor,
      strokesFromCursor: window,
      handoffAvailability: input.handoffAvailability,
      consumedStrokeIdentities: input.consumedStrokeIdentities,
      ruleConfig: input.ruleConfig,
    });
    const seed = createSuccessorSeed({
      predecessor,
      backlog,
      handoffAvailability: input.handoffAvailability,
      ruleVersion: input.ruleConfig?.segmentRuleVersion || predecessor.segmentRuleVersion,
    });
    if (seed.kind === 'EMPTY') {
      return freeze({ action: 'EMPTY_RETAIN_CONFIRMED_ANCHOR', reason: seed.reason, seed, backlog });
    }
    return freeze({ action: 'CREATE_SUCCESSOR_SEED_AND_BOUNDED_REPLAY', reason: backlog.reason, seed, backlog });
  }

  function decorateConfirmedPublication(candidate, extra) {
    const sourceCandidateId = candidate.segmentCandidateId || candidate.segmentId;
    const caseType = extra.caseType;
    const revision = Number(candidate.candidateRevision || 0);
    const ruleVersion = extra.ruleVersion || candidate.segmentRuleVersion || 'CT-Segment-R1.0';
    const confirmedSegmentId = createConfirmedPublicationId(ruleVersion, sourceCandidateId, revision, caseType);
    return freeze({
      ...clone(candidate),
      confirmedSegmentId,
      sourceCandidateId,
      segmentSequenceIndex: extra.segmentSequenceIndex,
      predecessorSegmentId: extra.predecessorSegmentId ?? candidate.predecessorSegmentId ?? null,
      publicationIdentity: confirmedSegmentId,
    });
  }

  Object.assign(c, {
    SEGMENT_SEQUENTIAL_HANDOFF_RULE_VERSION: HANDOFF_RULE_VERSION,
    SEGMENT_SEQUENTIAL_CONTINUATION_VERSION: CONTINUATION_VERSION,
    SEGMENT_SEQUENTIAL_STOP: STOP,
    SEGMENT_SEQUENTIAL_MAX_CASCADE: DEFENSIVE_MAX_CASCADE,
    oppositeSegmentDirection: oppositeDirection,
    sharedEndpointOf,
    startsAtSharedEndpoint,
    continuesSuccessorChain: continuesChain,
    strokeRevisionKey,
    findSuccessorBacklogStartOrdinal: findStartOrdinal,
    buildSuccessorBacklog,
    createSuccessorSeed,
    createSuccessorCandidateId,
    createConfirmedPublicationId,
    evaluateSequentialHandoff: evaluateHandoff,
    decorateConfirmedPublication,
  });
})();

