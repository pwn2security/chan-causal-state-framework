(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const clone = value => core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const freeze = value => core.deepFreeze ? core.deepFreeze(clone(value)) : Object.freeze(clone(value));

  function opposite(direction) {
    if (direction === 'UP') return 'DOWN';
    if (direction === 'DOWN') return 'UP';
    return null;
  }

  function segmentIdOf(segment) {
    return segment.confirmedSegmentId || segment.segmentId;
  }

  function endpointKey(segment, side) {
    if (side === 'start') {
      return [
        segment.startFractalId || segment.startStrokeId,
        segment.startIndex,
        segment.startTime ?? segment.eventTime,
        segment.startPrice,
      ].join(':');
    }
    return [
      segment.endpointFractalId || segment.endFractalId || segment.endStrokeId,
      segment.eventRawBarIndex ?? segment.endIndex,
      segment.eventTime ?? segment.endTime,
      segment.endpointPrice ?? segment.endPrice,
    ].join(':');
  }

  function buildSegmentTraceRecord(segment, handoff) {
    return freeze({
      segmentId: segmentIdOf(segment),
      sourceCandidateId: segment.sourceCandidateId || segment.segmentCandidateId || null,
      sequenceIndex: segment.segmentSequenceIndex,
      caseType: segment.caseType || null,
      direction: segment.direction,
      startEndpoint: {
        strokeId: segment.startStrokeId,
        fractalId: segment.startFractalId || null,
        price: segment.startPrice,
        time: segment.startTime ?? segment.eventTime,
        rawBarIndex: segment.startIndex,
      },
      endEndpoint: {
        strokeId: segment.endStrokeId || segment.endpointStrokeId,
        fractalId: segment.endpointFractalId || segment.endFractalId || null,
        price: segment.endpointPrice ?? segment.endPrice,
        time: segment.eventTime ?? segment.endTime,
        rawBarIndex: segment.eventRawBarIndex ?? segment.endIndex,
      },
      eventTime: segment.eventTime,
      confirmTime: segment.confirmTime,
      confirmationDelay: Number.isFinite(Number(segment.confirmTime)) && Number.isFinite(Number(segment.eventTime))
        ? Number(segment.confirmTime) - Number(segment.eventTime) : null,
      case2EntryTime: segment.case2EntryTime || segment.metadata?.case2EntryTime || null,
      candidateCreatedTime: segment.candidateCreatedTime ?? null,
      predecessorSegmentId: segment.predecessorSegmentId || null,
      memberStrokeIds: clone(segment.strokeIds || []),
      handoffTime: handoff?.candidateCreatedTime ?? null,
      ruleVersion: segment.segmentRuleVersion || segment.ruleVersion || null,
    });
  }

  function verifySequentialIntegrity(confirmedSegments) {
    const violations = [];
    const ids = new Set();
    const allStrokes = [];
    const caseSeen = { CASE_1: new Set(), CASE_2: new Set() };
    const segments = Array.isArray(confirmedSegments) ? confirmedSegments : [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const id = segmentIdOf(segment);
      if (!id) violations.push({ code: 'MISSING_SEGMENT_ID', index });
      if (ids.has(id)) violations.push({ code: 'DUPLICATE_SEGMENT_ID', id });
      ids.add(id);
      if (Number(segment.segmentSequenceIndex) !== index) {
        violations.push({
          code: 'SEQUENCE_INDEX_GAP',
          expected: index,
          actual: segment.segmentSequenceIndex,
          id,
        });
      }
      if (!(Number(segment.eventTime) <= Number(segment.confirmTime))) {
        violations.push({ code: 'EVENT_AFTER_CONFIRM', id });
      }
      if (segment.candidateCreatedTime != null &&
          Number(segment.confirmTime) < Number(segment.candidateCreatedTime)) {
        violations.push({ code: 'CONFIRM_BEFORE_CANDIDATE_CREATED', id });
      }
      const members = segment.strokeIds || [];
      for (const strokeId of members) {
        if (allStrokes.includes(strokeId)) {
          violations.push({ code: 'STROKE_MEMBERSHIP_OVERLAP', strokeId, id });
        }
        allStrokes.push(strokeId);
      }
      if (segment.caseType === 'CASE_1' || segment.caseType === 'CASE_2') {
        if (caseSeen[segment.caseType].has(id)) {
          violations.push({ code: 'DUPLICATE_CASE_PUBLICATION', id, caseType: segment.caseType });
        }
        caseSeen[segment.caseType].add(id);
      }
      if (index === 0) continue;
      const previous = segments[index - 1];
      if ((segment.predecessorSegmentId || null) !== segmentIdOf(previous)) {
        violations.push({ code: 'PREDECESSOR_MISMATCH', id, expected: segmentIdOf(previous) });
      }
      if (endpointKey(previous, 'end') !== endpointKey(segment, 'start')) {
        const priceOk = Number(previous.endpointPrice ?? previous.endPrice) === Number(segment.startPrice);
        if (!priceOk) violations.push({ code: 'SHARED_ENDPOINT_MISMATCH', id });
      }
      if (segment.direction !== opposite(previous.direction)) {
        violations.push({ code: 'SEQUENTIAL_DIRECTION_VIOLATION', id });
      }
    }
    const predecessors = segments.map(item => item.predecessorSegmentId).filter(Boolean);
    if (new Set(predecessors).size !== predecessors.length) {
      violations.push({ code: 'DUPLICATE_PREDECESSOR' });
    }
    return freeze({
      ok: violations.length === 0,
      confirmedCount: segments.length,
      violations,
      ids: [...ids],
    });
  }

  function verifyBacklogIntegrity(input) {
    const predecessor = input.predecessor;
    const backlog = input.backlog || {};
    const strokes = Array.isArray(backlog.strokes) ? backlog.strokes : [];
    const members = new Set(predecessor.strokeIds || []);
    const confirmTime = Number(predecessor.confirmTime);
    const violations = [];
    const rejected = [];
    for (const stroke of strokes) {
      if (members.has(stroke.strokeId)) {
        violations.push({ code: 'PREDECESSOR_MEMBER_IN_BACKLOG', strokeId: stroke.strokeId });
      }
      if (Number(stroke.confirmTime) > confirmTime) {
        violations.push({ code: 'FUTURE_STROKE_IN_BACKLOG', strokeId: stroke.strokeId });
      }
    }
    const ids = strokes.map(item => item.strokeId);
    if (new Set(ids).size !== ids.length) {
      violations.push({ code: 'DUPLICATE_BACKLOG_STROKE' });
    }
    return freeze({
      ok: violations.length === 0,
      predecessorConfirmTime: predecessor.confirmTime,
      sharedEndpointTime: predecessor.eventTime,
      backlogCursorStart: backlog.startCursor || null,
      backlogCursorEnd: backlog.endCursor || null,
      eligibleStrokeIds: ids,
      consumedStrokeIds: input.consumedStrokeIds || ids,
      rejectedStrokeIds: rejected.map(item => item.strokeId),
      rejectionReason: rejected.map(item => item.reason),
      violations,
    });
  }

  function classifyCaseTransition(previous, next) {
    if (!previous || !next) return 'NOT_CONSTRUCTED';
    return `${previous.caseType}→${next.caseType}`;
  }

  function summarizeCaseCoverage(pairs) {
    const keys = ['CASE_1→CASE_1', 'CASE_1→CASE_2', 'CASE_2→CASE_1', 'CASE_2→CASE_2'];
    const out = {};
    for (const key of keys) {
      const hit = pairs.includes(key);
      if (key === 'CASE_1→CASE_2') {
        out[key] = hit ? 'COVERED' : (pairs.includes('CASE_1→HANDOFF') ? 'PARTIALLY_COVERED' : 'NOT_CONSTRUCTED');
      } else {
        out[key] = hit ? 'COVERED' : 'NOT_CONSTRUCTED';
      }
    }
    return freeze(out);
  }

  function buildDevelopmentMetrics(segment) {
    const confirmed = segment.getConfirmedSegments();
    const active = segment.getActiveSegment();
    const handoffs = segment.getHandoffEvents().filter(item => item.kind === 'SEQUENTIAL_HANDOFF');
    const latest = confirmed.at(-1) || null;
    const newlyConfirmed = confirmed.length > 1 ? confirmed[1] : null;
    return freeze({
      confirmedSegmentCount: confirmed.length,
      successorCandidateCount: handoffs.length,
      backlogStrokeCount: handoffs[0]?.backlogCount ?? 0,
      backlogConsumedCount: segment.serializeSequentialContinuation()?.backlogProgress?.consumed ?? 0,
      newlyConfirmedSuccessorDirection: newlyConfirmed?.direction ?? null,
      currentActiveCandidateDirection: active?.direction ?? null,
      currentActiveCandidateMode: active?.status ?? null,
      latestConfirmedSegmentDirection: latest?.direction ?? null,
      successorSegmentConfirmationCount: Math.max(0, confirmed.length - 1),
      sequentialStopReason: core.successorDisplayStopReason(segment),
    });
  }

  Object.assign(core, {
    verifySequentialIntegrity,
    verifyBacklogIntegrity,
    buildSegmentTraceRecord,
    classifyCaseTransition,
    summarizeCaseCoverage,
    buildDevelopmentMetrics,
  });
})();
