(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const STRUCTURE_TYPE = core.CT_STRUCTURE_TYPES?.segment || 'segment';
  const STROKE_TYPE = core.CT_STRUCTURE_TYPES?.stroke || 'stroke';
  const STATUS_FORMING = core.CT_STATUSES?.forming || 'FORMING';
  const STATUS_EXTENDING = core.CT_STATUSES?.extending || 'EXTENDING';
  const STATUS_CONFIRMED = core.CT_STATUSES?.confirmed || 'CONFIRMED';
  const STATUS_REPLACED = core.CT_STATUSES?.replaced || 'REPLACED';
  const STATUS_INVALIDATED = core.CT_STATUSES?.invalidated || 'INVALIDATED';
  const STATUS_NONE = core.CT_STATUSES?.none || 'NONE';
  const ACTION_CREATED = core.CT_EVENT_ACTIONS?.created || 'CREATED';
  const ACTION_EXTENDED = core.CT_EVENT_ACTIONS?.extended || 'EXTENDED';
  const ACTION_REPLACED = core.CT_EVENT_ACTIONS?.replaced || 'REPLACED';
  const ACTION_INVALIDATED = core.CT_EVENT_ACTIONS?.invalidated || 'INVALIDATED';
  const DIR_UP = core.CT_DIRECTIONS?.up || 'UP';
  const DIR_DOWN = core.CT_DIRECTIONS?.down || 'DOWN';
  const DIR_CONSOLIDATION = core.CT_DIRECTIONS?.consolidation || 'CONSOLIDATION';

  const SEGMENT_INTERFACE_VERSION = 'event-driven-interface-v1';

  function requireDependencies() {
    for (const name of ['createCTRuleConfig', 'createStructuralState',
      'createStructuralEvent', 'createBaseCTState', 'createCTState', 'attachStateHash',
      'evaluateSequentialHandoff', 'buildSuccessorBacklog', 'decorateConfirmedPublication']) {
      if (typeof core[name] !== 'function') throw new Error(`CT segment requires MarketCore.${name}`);
    }
  }

  function clone(value) {
    return core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  }

  function freeze(value) {
    return core.deepFreeze ? core.deepFreeze(value) : Object.freeze(value);
  }

  function finiteNumber(value, field) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`SegmentStateMachine ${field} must be finite`);
    return number;
  }

  function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function integerNumber(value, field) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      throw new Error(`SegmentStateMachine ${field} must be a non-negative integer`);
    }
    return number;
  }

  function strokeDirection(value) {
    const text = String(value || '').toUpperCase();
    if (text === DIR_UP || text === 'UP') return DIR_UP;
    if (text === DIR_DOWN || text === 'DOWN') return DIR_DOWN;
    throw new Error(`SegmentStateMachine stroke direction must be UP or DOWN, got ${String(value)}`);
  }

  function strokeStatusOf(value) {
    return String(value || STATUS_CONFIRMED).toUpperCase();
  }

  function normalizeStroke(input, ordinal) {
    if (!input || typeof input !== 'object') {
      throw new Error(`SegmentStateMachine strokes[${ordinal}] is required`);
    }
    const status = strokeStatusOf(input.status);
    if (status !== STATUS_CONFIRMED) return null;
    const eventIndex = integerNumber(input.eventRawBarIndex ?? input.event_raw_bar_index ??
      input.eventIndex ?? input.event_index, `strokes[${ordinal}].eventRawBarIndex`);
    const eventTime = finiteNumber(input.eventTime ?? input.event_time, `strokes[${ordinal}].eventTime`);
    const confirmIndex = integerNumber(input.confirmRawBarIndex ?? input.confirm_raw_bar_index ??
      input.confirmIndex ?? input.confirm_index, `strokes[${ordinal}].confirmRawBarIndex`);
    const confirmTime = finiteNumber(input.confirmTime ?? input.confirm_time, `strokes[${ordinal}].confirmTime`);
    if (confirmIndex < eventIndex || confirmTime < eventTime) {
      throw new Error(`SegmentStateMachine strokes[${ordinal}] confirm must be >= event`);
    }
    const startPrice = finiteNumber(input.startPrice ?? input.start_price, `strokes[${ordinal}].startPrice`);
    const endPrice = finiteNumber(input.endPrice ?? input.end_price, `strokes[${ordinal}].endPrice`);
    const strokeId = String(input.strokeId ?? input.stroke_id ?? input.structureId ?? input.structure_id ??
      `${input.ruleVersion || 'CT-R1.0'}:stroke:${ordinal}:${eventIndex}:${confirmIndex}`);
    return freeze({
      structureId: String(input.structureId ?? input.structure_id ?? strokeId),
      strokeId,
      structureType: STROKE_TYPE,
      status,
      startFractalId: String(input.startFractalId ?? input.start_fractal_id ?? ''),
      endFractalId: String(input.endFractalId ?? input.end_fractal_id ?? ''),
      direction: strokeDirection(input.direction),
      startPrice,
      endPrice,
      amplitude: finiteOrNull(input.amplitude) ?? Math.abs(endPrice - startPrice),
      duration: finiteOrNull(input.duration) ?? Math.max(0, confirmTime - eventTime),
      slope: finiteOrNull(input.slope) ?? 0,
      eventRawBarIndex: eventIndex,
      eventIndex,
      eventTime,
      availableRawBarIndex: integerNumber(input.availableRawBarIndex ?? input.available_raw_bar_index ??
        confirmIndex, `strokes[${ordinal}].availableRawBarIndex`),
      availableTime: finiteNumber(input.availableTime ?? input.available_time ?? confirmTime,
        `strokes[${ordinal}].availableTime`),
      confirmRawBarIndex: confirmIndex,
      confirmIndex,
      confirmTime,
      eventNormalizedKIndex: finiteOrNull(input.eventNormalizedKIndex ?? input.event_normalized_k_index),
      confirmNormalizedKIndex: finiteOrNull(input.confirmNormalizedKIndex ?? input.confirm_normalized_k_index),
      eventStrokeIndex: integerNumber(input.eventStrokeIndex ?? input.event_stroke_index ??
        input.strokeIndex ?? input.stroke_index ?? ordinal, `strokes[${ordinal}].eventStrokeIndex`),
      startIndex: integerNumber(input.startIndex ?? input.start_index ?? eventIndex, `strokes[${ordinal}].startIndex`),
      endIndex: integerNumber(input.endIndex ?? input.end_index ?? eventIndex, `strokes[${ordinal}].endIndex`),
      startTime: finiteNumber(input.startTime ?? input.start_time ?? eventTime, `strokes[${ordinal}].startTime`),
      endTime: finiteNumber(input.endTime ?? input.end_time ?? eventTime, `strokes[${ordinal}].endTime`),
      normalizedDuration: finiteOrNull(input.normalizedDuration ?? input.normalized_duration),
      ruleVersion: String(input.ruleVersion ?? input.rule_version ?? 'CT-R1.0'),
      metadata: freeze(clone(input.metadata || {})),
    });
  }

  function inputToStrokes(input) {
    const source = Array.isArray(input)
      ? input
      : (input?.confirmedStrokes || input?.strokes || input?.segmentInputStrokes || []);
    if (!Array.isArray(source)) throw new Error('SegmentStateMachine.update expects confirmedStrokes array or a Stroke packet');
    const strokes = [];
    for (let index = 0; index < source.length; index += 1) {
      const normalized = normalizeStroke(source[index], index);
      if (normalized) strokes.push(normalized);
    }
    for (let index = 1; index < strokes.length; index += 1) {
      const previous = strokes[index - 1];
      const current = strokes[index];
      if (current.confirmIndex < previous.confirmIndex) {
        throw new Error('SegmentStateMachine stroke confirmIndex must be non-decreasing');
      }
    }
    return strokes;
  }

  function strokeSignature(stroke) {
    return [
      stroke.strokeId,
      stroke.direction,
      stroke.startPrice,
      stroke.endPrice,
      stroke.eventIndex,
      stroke.eventTime,
      stroke.confirmIndex,
      stroke.confirmTime,
    ].join(':');
  }

  function strokesSignature(strokes) {
    return strokes.map(strokeSignature).join('|');
  }

  function sameStrokePrefix(previous, next) {
    if (previous.length > next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index].strokeId !== next[index].strokeId) return false;
    }
    return true;
  }

  function netDirection(first, last) {
    if (Number(last.endPrice) > Number(first.startPrice)) return DIR_UP;
    if (Number(last.endPrice) < Number(first.startPrice)) return DIR_DOWN;
    return DIR_CONSOLIDATION;
  }

  function segmentId(ruleVersion, segmentRuleVersion, firstStroke) {
    return `${ruleVersion}:segment:${segmentRuleVersion}:${SEGMENT_INTERFACE_VERSION}:${firstStroke.strokeId}`;
  }

  function withSnakeAliases(segment) {
    return freeze({
      ...segment,
      segment_id: segment.segmentId,
      start_stroke_id: segment.startStrokeId,
      end_stroke_id: segment.endStrokeId,
      stroke_ids: clone(segment.strokeIds),
      start_price: segment.startPrice,
      end_price: segment.endPrice,
      event_time: segment.eventTime,
      event_raw_bar_index: segment.eventRawBarIndex,
      available_time: segment.availableTime,
      available_raw_bar_index: segment.availableRawBarIndex,
      confirm_time: segment.confirmTime,
      confirm_raw_bar_index: segment.confirmRawBarIndex,
    });
  }

  function makeSegment(strokes, status, ruleConfig, lifecycle = {}) {
    if (!strokes.length) return null;
    const first = strokes[0];
    const last = strokes[strokes.length - 1];
    const ruleVersion = ruleConfig.ruleVersion;
    const segmentRuleVersion = ruleConfig.segmentRuleVersion || 'TODO-segment-rule-v0';
    const priceDelta = Number(last.endPrice) - Number(first.startPrice);
    const duration = Math.max(0, Number(last.endTime) - Number(first.startTime));
    const strokeSpan = Math.max(1, strokes.length - 1);
    const candidateId = lifecycle.segmentCandidateId || segmentId(ruleVersion, segmentRuleVersion, first);
    return withSnakeAliases({
      structureId: candidateId,
      segmentId: candidateId,
      segmentCandidateId: candidateId,
      predecessorSegmentId: lifecycle.predecessorSegmentId ?? null,
      candidateCreatedTime: lifecycle.candidateCreatedTime ?? first.confirmTime,
      candidateAvailableRawBarIndex: lifecycle.candidateAvailableRawBarIndex ?? first.confirmIndex,
      candidateRevision: Number.isInteger(lifecycle.candidateRevision) ? lifecycle.candidateRevision : 0,
      activeEndpoint: lifecycle.activeEndpoint ? clone(lifecycle.activeEndpoint) : null,
      structureType: STRUCTURE_TYPE,
      status,
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      startStrokeId: first.strokeId,
      endStrokeId: last.strokeId,
      strokeIds: strokes.map(stroke => stroke.strokeId),
      strokeCount: strokes.length,
      direction: segmentRuleVersion === 'CT-Segment-R1.0' ? first.direction : netDirection(first, last),
      lastStrokeDirection: last.direction,
      startPrice: Number(first.startPrice),
      endPrice: Number(last.endPrice),
      amplitude: Math.abs(priceDelta),
      duration,
      slope: priceDelta / strokeSpan,
      eventRawBarIndex: first.eventRawBarIndex,
      eventIndex: first.eventRawBarIndex,
      eventTime: first.eventTime,
      availableRawBarIndex: first.availableRawBarIndex,
      availableTime: first.availableTime,
      confirmRawBarIndex: status === STATUS_CONFIRMED ? last.confirmRawBarIndex : null,
      confirmIndex: status === STATUS_CONFIRMED ? last.confirmRawBarIndex : null,
      confirmTime: status === STATUS_CONFIRMED ? last.confirmTime : null,
      eventStrokeIndex: first.eventStrokeIndex,
      availableStrokeIndex: first.eventStrokeIndex,
      confirmStrokeIndex: status === STATUS_CONFIRMED ? last.eventStrokeIndex : null,
      startIndex: first.startIndex,
      endIndex: last.endIndex,
      startTime: first.startTime,
      endTime: last.endTime,
      ruleVersion,
      segmentRuleVersion,
      metadata: {
        segmentInterfaceVersion: SEGMENT_INTERFACE_VERSION,
        segmentRuleVersion,
        confirmationRuleStatus: 'TODO_NOT_IMPLEMENTED',
        note: 'Phase 5 intentionally models event-driven Segment state without confirming segments by a 3-stroke shortcut.',
        strokeIds: strokes.map(stroke => stroke.strokeId),
        activeEndpointId: lifecycle.activeEndpoint?.endpointId ?? null,
        recentStrokes: clone(strokes.slice(-6)),
        priceDelta,
      },
    });
  }

  function segmentToStructuralState(segment) {
    return core.createStructuralState({
      structureId: segment.structureId,
      structureType: STRUCTURE_TYPE,
      status: segment.status,
      eventRawBarIndex: segment.eventRawBarIndex,
      eventTime: segment.eventTime,
      availableRawBarIndex: segment.availableRawBarIndex,
      availableTime: segment.availableTime,
      confirmRawBarIndex: segment.confirmRawBarIndex,
      confirmTime: segment.confirmTime,
      eventStrokeIndex: segment.eventStrokeIndex,
      availableStrokeIndex: segment.availableStrokeIndex,
      confirmStrokeIndex: segment.confirmStrokeIndex,
      eventIndex: segment.eventRawBarIndex,
      confirmIndex: segment.confirmRawBarIndex,
      startIndex: segment.startIndex,
      endIndex: segment.endIndex,
      startTime: segment.startTime,
      endTime: segment.endTime,
      direction: segment.direction,
      priceLow: Math.min(segment.startPrice, segment.endPrice),
      priceHigh: Math.max(segment.startPrice, segment.endPrice),
      ruleVersion: segment.ruleVersion,
      metadata: {
        segmentId: segment.segmentId,
        segmentCandidateId: segment.segmentCandidateId,
        candidateRevision: segment.candidateRevision,
        activeEndpointId: segment.activeEndpoint?.endpointId ?? null,
        segment_id: segment.segmentId,
        startStrokeId: segment.startStrokeId,
        endStrokeId: segment.endStrokeId,
        start_stroke_id: segment.startStrokeId,
        end_stroke_id: segment.endStrokeId,
        strokeIds: clone(segment.strokeIds),
        stroke_ids: clone(segment.strokeIds),
        strokeCount: segment.strokeCount,
        startPrice: segment.startPrice,
        endPrice: segment.endPrice,
        amplitude: segment.amplitude,
        duration: segment.duration,
        slope: segment.slope,
        lastStrokeDirection: segment.lastStrokeDirection,
        segmentRuleVersion: segment.segmentRuleVersion,
        segmentInterfaceVersion: segment.metadata?.segmentInterfaceVersion || SEGMENT_INTERFACE_VERSION,
        confirmationRuleStatus: segment.metadata?.confirmationRuleStatus || 'TODO_NOT_IMPLEMENTED',
        caseType: segment.caseType || null,
        case2RuleVersion: segment.case2RuleVersion || null,
        pendingTerminationId: segment.metadata?.pendingTerminationId || null,
        primaryFeatureFractalId: segment.metadata?.primaryFeatureFractalId || null,
        reverseFeatureFractalId: segment.metadata?.reverseFeatureFractalId || null,
      },
    });
  }

  function segmentToCompactRow(segment) {
    return [
      segment.segmentId,
      segment.status,
      segment.startStrokeId,
      segment.endStrokeId,
      segment.strokeCount,
      segment.direction,
      segment.startPrice,
      segment.endPrice,
      segment.amplitude,
      segment.duration,
      segment.slope,
      segment.eventIndex,
      segment.confirmIndex,
    ];
  }

  class SegmentStateMachine {
    #ruleConfig;
    #strokes = [];
    #activeSegment = null;
    #confirmedSegments = [];
    #brokenSegments = [];
    #events = [];
    #currentBarIndex = -1;
    #currentBarTime = null;
    #lastInputSignature = '';
    #hasSeenInput = false;
    #hasSeenNonEmptyInput = false;

    #candidateStrokes = [];
    #latestConfirmedAnchor = null;
    #handoffConsumedPredecessorIds = [];
    #consumedSuccessorStrokeIdentities = [];
    #candidateLineageOrdinal = 0;
    #nextConfirmedSegmentSequenceIndex = 0;
    #successorSourceCursor = null;
    #backlogProgress = null;
    #handoffEvents = [];
    #sequentialStopReason = null;
    #cascadeDepth = 0;
    #acceptContinuationSuffix = false;
    #pendingBacklogStrokes = [];
    #lastHandoffAvailability = null;
    #inHandoff = false;
    #inGuardEvaluation = false;
    #pendingHandoffClock = null;
    #case1Decisions = [];
    #case2Machine = null;
    #endpointLifecycleMachine = null;
    #lifecycleEvents = [];

    constructor(ruleConfig = {}) {
      requireDependencies();
      this.#ruleConfig = core.createCTRuleConfig(ruleConfig.ruleConfig || ruleConfig);
      this.reset();
    }

    reset() {
      this.#case1Decisions = [];
      this.#case2Machine = null;
      this.#endpointLifecycleMachine = null;
      this.#lifecycleEvents = [];
      this.#candidateStrokes = [];
      this.#latestConfirmedAnchor = null;
      this.#handoffConsumedPredecessorIds = [];
      this.#consumedSuccessorStrokeIdentities = [];
      this.#candidateLineageOrdinal = 0;
      this.#nextConfirmedSegmentSequenceIndex = 0;
      this.#successorSourceCursor = null;
      this.#backlogProgress = null;
      this.#handoffEvents = [];
      this.#sequentialStopReason = null;
      this.#cascadeDepth = 0;
      this.#acceptContinuationSuffix = false;
      this.#pendingBacklogStrokes = [];
      this.#lastHandoffAvailability = null;
      this.#inHandoff = false;
      this.#inGuardEvaluation = false;
      this.#pendingHandoffClock = null;
      this.#strokes = [];
      this.#activeSegment = null;
      this.#confirmedSegments = [];
      this.#brokenSegments = [];
      this.#events = [];
      this.#currentBarIndex = -1;
      this.#currentBarTime = null;
      this.#lastInputSignature = '';
      this.#hasSeenInput = false;
      this.#hasSeenNonEmptyInput = false;
      return this;
    }

    getCase1Decisions() { return clone(this.#case1Decisions); }
    getCase2State() { return this.#case2Machine ? this.#case2Machine.getState() : null; }
    getEndpointLifecycleState() {
      return this.#endpointLifecycleMachine ? this.#endpointLifecycleMachine.getState() : null;
    }
    getLifecycleEvents() { return clone(this.#lifecycleEvents); }
    getPendingTerminations() {
      const pending = this.#case2Machine?.getPendingTermination();
      return pending ? [pending] : [];
    }

    getRuleConfig() { return clone(this.#ruleConfig); }
    getInputStrokes() { return clone(this.#strokes); }
    getActiveSegment() { return clone(this.#activeSegment); }
    getConfirmedSegments() { return clone(this.#confirmedSegments); }
    getBrokenSegments() { return clone(this.#brokenSegments); }
    getEvents() { return clone(this.#events); }
    getLatestConfirmedAnchor() { return clone(this.#latestConfirmedAnchor); }
    getSequentialStopReason() { return this.#sequentialStopReason; }
    getHandoffEvents() { return clone(this.#handoffEvents); }
    getCandidateStrokes() { return clone(this.#candidateStrokes); }
    getConsumedSuccessorStrokeIdentities() { return clone(this.#consumedSuccessorStrokeIdentities); }

    #isPublishedCandidate(id) {
      if (!id) return false;
      return this.#confirmedSegments.some(segment =>
        segment.segmentId === id || segment.confirmedSegmentId === id ||
        segment.sourceCandidateId === id || segment.segmentCandidateId === id);
    }

    #handoffClock(now) {
      return {
        rawBarIndex: integerNumber(now.rawBarIndex ?? now.confirmRawBarIndex ?? this.#currentBarIndex, 'handoff.rawBarIndex'),
        time: finiteNumber(now.time ?? now.confirmTime ?? this.#currentBarTime, 'handoff.time'),
      };
    }

    #successorConfirmClock(now) {
      const created = this.#activeSegment?.candidateCreatedTime;
      const createdIndex = this.#activeSegment?.candidateAvailableRawBarIndex;
      return {
        rawBarIndex: Math.max(Number(now.rawBarIndex), Number.isInteger(createdIndex) ? createdIndex : Number(now.rawBarIndex)),
        time: Math.max(Number(now.time), Number.isFinite(Number(created)) ? Number(created) : Number(now.time)),
      };
    }

    // Establishes the current candidate endpoint baseline. This is not an
    // EndpointProposal and therefore does not increment candidateRevision.
    // Subsequent endpoint changes must pass through processEndpointProposal().
    initializeActiveEndpoint(endpointInput, currentAvailability) {
      if (typeof core.SegmentEndpointLifecycleStateMachine !== 'function' ||
          typeof core.createActiveSegmentEndpoint !== 'function') throw new Error('ENDPOINT_LIFECYCLE_MODULE_NOT_LOADED');
      if (!this.#activeSegment) throw new Error('ACTIVE_SEGMENT_REQUIRED');
      const strokeId = endpointInput?.endpointStrokeId;
      const sourceStroke = this.#strokes.find(stroke => stroke.strokeId === strokeId);
      if (!sourceStroke || sourceStroke.direction !== this.#activeSegment.direction ||
          sourceStroke.endFractalId !== endpointInput.endpointFractalId ||
          Math.abs(sourceStroke.endPrice - Number(endpointInput.endpointPrice)) > this.#ruleConfig.numericTolerance ||
          sourceStroke.endIndex !== Number(endpointInput.endpointRawBarIndex ?? endpointInput.eventRawBarIndex) ||
          sourceStroke.endTime !== Number(endpointInput.endpointTime ?? endpointInput.eventTime)) {
        throw new Error('INVALID_INITIAL_ACTIVE_ENDPOINT_PROVENANCE');
      }
      const now = currentAvailability || {
        rawBarIndex: endpointInput.endpointAvailableRawBarIndex ?? endpointInput.proposalAvailableRawBarIndex,
        time: endpointInput.endpointAvailableTime ?? endpointInput.proposalAvailableTime,
      };
      if (!now || sourceStroke.confirmRawBarIndex > now.rawBarIndex || sourceStroke.confirmTime > now.time) {
        throw new Error('INITIAL_ACTIVE_ENDPOINT_FUTURE_EVIDENCE');
      }
      const activeEndpoint = core.createActiveSegmentEndpoint(endpointInput,
        this.#activeSegment, this.#ruleConfig);
      if (this.#endpointLifecycleMachine) {
        const existing = this.#endpointLifecycleMachine.getState().activeEndpoint;
        if (existing?.endpointId !== activeEndpoint.endpointId) throw new Error('ACTIVE_ENDPOINT_ALREADY_INITIALIZED');
        return freeze({ initialized: false, duplicate: true, activeEndpoint: existing });
      }
      this.#activeSegment = freeze({ ...this.#activeSegment, activeEndpoint,
        metadata: { ...(this.#activeSegment.metadata || {}), activeEndpointId: activeEndpoint.endpointId } });
      this.#endpointLifecycleMachine = new core.SegmentEndpointLifecycleStateMachine({
        ruleConfig: this.#ruleConfig, candidate: this.#activeSegment, activeEndpoint,
        pendingTermination: null, reverseState: null, currentAvailability: now,
      });
      return freeze({ initialized: true, activeEndpoint, activeSegment: this.getActiveSegment() });
    }

    #activeMemorySize() {
      return core.estimateActiveMemorySize({
        activeSegment: this.#activeSegment,
        unfinishedStrokeIds: this.#strokes.map(stroke => stroke.strokeId),
        recentStrokes: this.#strokes.slice(-6),
        confirmedSegmentIds: this.#confirmedSegments.map(segment => segment.segmentId),
        case2ActiveMemory: this.#case2Machine?.getState()?.activeMemory ?? null,
        endpointLifecycle: this.#endpointLifecycleMachine?.getState() ?? null,
      });
    }

    #logicalLastEventId() {
      if (!this.#activeSegment) return this.#confirmedSegments.length ? this.#events.at(-1)?.eventId ?? null : null;
      return `${this.#ruleConfig.ruleVersion}:logical:segment:${this.#activeSegment.segmentId}:${this.#activeSegment.status}:${this.#activeSegment.endStrokeId}:${this.#activeSegment.strokeCount}`;
    }

    #event(action, segment, currentStroke, metadata = {}) {
      const eventStroke = currentStroke || this.#strokes[this.#strokes.length - 1] || {
        confirmIndex: this.#currentBarIndex,
        confirmTime: this.#currentBarTime,
      };
      return core.createStructuralEvent({
        barIndex: eventStroke.confirmIndex,
        barTime: eventStroke.confirmTime,
        structureId: segment.structureId,
        structureType: STRUCTURE_TYPE,
        eventRawBarIndex: segment.eventRawBarIndex,
        eventTime: segment.eventTime,
        availableRawBarIndex: eventStroke.confirmRawBarIndex,
        availableTime: eventStroke.confirmTime,
        confirmRawBarIndex: null,
        confirmTime: null,
        eventStrokeIndex: segment.eventStrokeIndex,
        availableStrokeIndex: eventStroke.eventStrokeIndex,
        eventIndex: segment.eventRawBarIndex,
        confirmIndex: null,
        modeBefore: null,
        modeAfter: segment.status,
        eventAction: action,
        ruleVersion: this.#ruleConfig.ruleVersion,
        activeMemorySize: this.#activeMemorySize(),
        provenance: {
          strokeIds: clone(segment.strokeIds),
        },
        metadata: {
          segmentId: segment.segmentId,
          segment_id: segment.segmentId,
          status: segment.status,
          startStrokeId: segment.startStrokeId,
          endStrokeId: segment.endStrokeId,
          strokeCount: segment.strokeCount,
          segmentRuleVersion: segment.segmentRuleVersion,
          segmentInterfaceVersion: SEGMENT_INTERFACE_VERSION,
          confirmationRuleStatus: 'TODO_NOT_IMPLEMENTED',
          ...metadata,
        },
      });
    }

    #rebuildWithoutEvents(strokes) {
      if (this.#latestConfirmedAnchor) {
        throw new Error('R1_UPSTREAM_REVISION_REQUIRES_REBUILD');
      }
      this.#candidateStrokes = strokes.slice();
      this.#activeSegment = strokes.length
        ? makeSegment(strokes, strokes.length === 1 ? STATUS_FORMING : STATUS_EXTENDING, this.#ruleConfig, {
          candidateRevision: Math.max(0, strokes.length - 1),
        })
        : null;
      const last = strokes[strokes.length - 1] || null;
      this.#currentBarIndex = last?.confirmIndex ?? -1;
      this.#currentBarTime = last?.confirmTime ?? null;
      this.#confirmedSegments = [];
      this.#brokenSegments = [];
    }

    #appendStroke(stroke, events, lifecycle = {}) {
      this.#currentBarIndex = stroke.confirmIndex;
      this.#currentBarTime = stroke.confirmTime;
      if (!this.#activeSegment) {
        this.#candidateStrokes = [stroke];
        this.#activeSegment = makeSegment([stroke], STATUS_FORMING, this.#ruleConfig, lifecycle);
        events.push(this.#event(ACTION_CREATED, this.#activeSegment, stroke, {
          reason: lifecycle.reason || 'first-confirmed-stroke-starts-forming-segment',
        }));
        return;
      }
      this.#candidateStrokes = [...this.#candidateStrokes, stroke];
      this.#activeSegment = makeSegment(this.#candidateStrokes, STATUS_EXTENDING, this.#ruleConfig, {
        candidateRevision: this.#activeSegment.candidateRevision + 1,
        activeEndpoint: this.#activeSegment.activeEndpoint,
        segmentCandidateId: this.#activeSegment.segmentCandidateId,
        predecessorSegmentId: this.#activeSegment.predecessorSegmentId,
        candidateCreatedTime: this.#activeSegment.candidateCreatedTime,
        candidateAvailableRawBarIndex: this.#activeSegment.candidateAvailableRawBarIndex,
      });
      if (this.#endpointLifecycleMachine) {
        this.#endpointLifecycleMachine.syncCandidate(this.#activeSegment);
        this.#activeSegment = freeze(clone(this.#endpointLifecycleMachine.getState().candidate));
      }
      events.push(this.#event(ACTION_EXTENDED, this.#activeSegment, stroke, {
        reason: 'confirmed-stroke-extends-active-segment-interface-state',
        warning: 'segment-confirmation-rule-not-implemented',
      }));
    }

    // Confirmation is explicit for the first candidate. After publication, H_S may
    // evaluate the successor with the same Case1 guard on replayed prefix evidence.
    confirmCase1(input) {
      const requested = input.segmentState?.segmentId || input.segmentState?.segmentCandidateId ||
        input.candidateSegmentState?.segmentId || input.candidateSegmentState?.segmentCandidateId;
      if (requested && this.#isPublishedCandidate(requested)) {
        return freeze({events: [], decision: null, reason: 'ALREADY_CONFIRMED', confirmedSegments: this.getConfirmedSegments()});
      }
      if (!this.#activeSegment) {
        return freeze({events: [], decision: null,
          reason: this.#confirmedSegments.length ? 'ALREADY_CONFIRMED' : 'NO_ACTIVE_CANDIDATE',
          confirmedSegments: this.getConfirmedSegments()});
      }
      if (typeof core.evaluateSegmentCase1 !== 'function') throw new Error('CASE1_MODULE_NOT_LOADED');
      const now = this.#successorConfirmClock(input.currentAvailability);
      if (now && (now.rawBarIndex < this.#currentBarIndex || now.time < this.#currentBarTime)) throw new Error('NON_MONOTONIC_CASE1_CLOCK');
      const decision = core.evaluateSegmentCase1({...input, segmentState:this.#activeSegment,
        confirmedStrokes:this.#candidateStrokes, ruleConfig:this.#ruleConfig});
      this.#case1Decisions.push(freeze(clone(decision)));
      if (!decision.eligible) return freeze({events:[],decision,confirmedSegments:this.getConfirmedSegments()});
      const old = this.#activeSegment, end = decision.eventEndpoint;
      const lifecycleEndpoint = this.#endpointLifecycleMachine?.getState()?.activeEndpoint ?? null;
      if (lifecycleEndpoint && (lifecycleEndpoint.endpointStrokeId !== end.endpointStrokeId ||
        lifecycleEndpoint.endpointFractalId !== end.endpointFractalId ||
        lifecycleEndpoint.eventTime !== end.endpointTime)) {
        return freeze({ events: [], decision, reason: 'CASE1_ENDPOINT_LIFECYCLE_MISMATCH',
          confirmedSegments: this.getConfirmedSegments() });
      }
      const members = decision.sourceIds.segmentStrokeIds;
      const sourceCandidateId = old.segmentCandidateId || old.segmentId;
      const confirmed = withSnakeAliases({...old, status:STATUS_CONFIRMED, mode:STATUS_CONFIRMED,
        ...end,...decision.sourceIds,caseType:'CASE_1',case1RuleVersion:core.SEGMENT_CASE1_RULE_VERSION,
        endStrokeId:end.endpointStrokeId,strokeIds:members,strokeCount:members.length,
        lastStrokeDirection:old.direction,endPrice:end.endpointPrice,endTime:end.endpointTime,endIndex:end.endpointRawBarIndex,
        schemaVersion:core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        structuralTimeSchemaVersion:core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        eventRawBarIndex:end.endpointRawBarIndex,eventIndex:end.endpointRawBarIndex,eventTime:end.endpointTime,
        availableRawBarIndex:end.endpointAvailableRawBarIndex,availableTime:end.endpointAvailableTime,
        confirmRawBarIndex:now.rawBarIndex,confirmIndex:now.rawBarIndex,confirmTime:now.time,
        eventStrokeIndex:this.#candidateStrokes.findIndex(stroke=>stroke.strokeId===end.endpointStrokeId),
        availableStrokeIndex:this.#candidateStrokes.findIndex(stroke=>stroke.strokeId===end.endpointStrokeId),
        confirmStrokeIndex:this.#candidateStrokes.length-1,
        amplitude:Math.abs(end.endpointPrice-old.startPrice),duration:end.endpointTime-old.startTime,
        slope:(end.endpointPrice-old.startPrice)/Math.max(1,members.length-1),
        metadata:{case1RuleVersion:core.SEGMENT_CASE1_RULE_VERSION,confirmationRuleStatus:'CASE1_CONFIRMED',
          decisionTrace:decision.decisionTrace,endpointPolicy:'MIDDLE_EXTREME_EARLIEST_SOURCE',
          scope:'sequential-handoff; Case1 publication then H_S; no BROKEN or invented restart'}});
      const published = this.#publishConfirmed(confirmed, 'CASE_1', now, {
        featureFractalId:decision.sourceIds.sourceFeatureFractalId,
        standardizedFeatureElementIds:decision.sourceIds.sourceStandardizedFeatureIds,
        rawFeatureElementIds:decision.sourceIds.sourceFeatureElementIds,
        strokeIds:decision.sourceIds.sourceStrokeIds,
      }, {...end,...decision.sourceIds,sourceCandidateId,direction:confirmed.direction,caseType:'CASE_1',
        case1RuleVersion:core.SEGMENT_CASE1_RULE_VERSION,decisionTrace:decision.decisionTrace});
      return freeze({events: published.events, decision, confirmedSegments: this.getConfirmedSegments(),
        handoff: published.handoff});
    }

    #adoptCase2Result(packet) {
      const confirmed = packet?.confirmedSegment ?? this.#case2Machine?.getConfirmedSegment();
      if (!confirmed || this.#isPublishedCandidate(confirmed.segmentId) ||
          this.#isPublishedCandidate(confirmed.confirmedSegmentId)) return null;
      const now = {
        rawBarIndex: confirmed.confirmRawBarIndex,
        time: confirmed.confirmTime,
      };
      const emitted = packet?.events || [];
      for (const event of emitted) {
        if (event?.eventAction === (core.CT_EVENT_ACTIONS?.confirmed || 'CONFIRMED') &&
            !this.#events.some(existing => existing.eventId === event.eventId)) {
          this.#events.push(freeze(clone(event)));
        }
      }
      return this.#publishConfirmed(confirmed, 'CASE_2', now, {
        strokeIds: confirmed.strokeIds || confirmed.provenance?.strokeIds || [],
      }, { caseType: 'CASE_2', reuseExistingConfirmedEvent: true });
    }

    // Phase 5E2 explicit entry. It never treats a generic Case1 failure as Case2.
    beginCase2(input) {
      const requested = input.candidateSegmentState?.segmentId || input.segmentState?.segmentId ||
        input.candidateSegmentState?.segmentCandidateId;
      if (requested && this.#isPublishedCandidate(requested)) {
        return freeze({ events: [], reason: 'ALREADY_CONFIRMED', confirmedSegments: this.getConfirmedSegments() });
      }
      if (!this.#activeSegment) {
        return freeze({ events: [], reason: this.#confirmedSegments.length ? 'ALREADY_CONFIRMED' : 'NO_ACTIVE_CANDIDATE',
          confirmedSegments: this.getConfirmedSegments() });
      }
      if (typeof core.SegmentCase2StateMachine !== 'function') throw new Error('CASE2_MODULE_NOT_LOADED');
      const preflight = core.evaluateSegmentCase2Entry({ ...input,
        candidateSegmentState: this.#activeSegment, confirmedStrokes: this.#candidateStrokes,
        ruleConfig: this.#ruleConfig });
      const lifecycleEndpoint = this.#endpointLifecycleMachine?.getState()?.activeEndpoint ?? null;
      if (preflight.eligible && lifecycleEndpoint &&
          (lifecycleEndpoint.endpointStrokeId !== preflight.candidateEndpoint.endpointStrokeId ||
           lifecycleEndpoint.endpointFractalId !== preflight.candidateEndpoint.endpointFractalId ||
           lifecycleEndpoint.eventTime !== preflight.candidateEndpoint.endpointTime)) {
        return freeze({ entry: preflight, events: [], blocked: true,
          reason: 'CASE2_ENDPOINT_LIFECYCLE_MISMATCH', confirmedSegments: this.getConfirmedSegments() });
      }
      if (!this.#case2Machine) this.#case2Machine = new core.SegmentCase2StateMachine(this.#ruleConfig);
      const packet = this.#case2Machine.begin({ ...input, candidateSegmentState: this.#activeSegment,
        confirmedStrokes: this.#candidateStrokes, ruleConfig: this.#ruleConfig });
      if (packet.entry?.eligible && !this.#endpointLifecycleMachine) {
        if (typeof core.SegmentEndpointLifecycleStateMachine === 'function' &&
            typeof core.createActiveSegmentEndpoint === 'function') {
          this.initializeActiveEndpoint(packet.entry.candidateEndpoint, packet.entry.entryAvailability);
          this.#endpointLifecycleMachine.syncPending(packet.pendingTermination,
            packet.state?.activeMemory ?? null);
        }
      } else if (this.#endpointLifecycleMachine) {
        this.#endpointLifecycleMachine.syncCandidate(this.#activeSegment).syncPending(
          this.#case2Machine.getPendingTermination(), this.#case2Machine.getState().activeMemory);
      }
      const handoff = this.#adoptCase2Result(packet);
      return freeze({ ...clone(packet), confirmedSegments: this.getConfirmedSegments(), handoff });
    }

    evaluateEndpointProposal(input) {
      if (typeof core.evaluateEndpointProposal !== 'function') throw new Error('ENDPOINT_PROPOSAL_MODULE_NOT_LOADED');
      return core.evaluateEndpointProposal({ ...input, candidateSegmentState: this.#activeSegment,
        confirmedStrokes: this.#strokes, ruleConfig: this.#ruleConfig });
    }

    processEndpointProposal(endpointProposal, currentAvailability) {
      if (!this.#activeSegment) return freeze({ applied: false,
        reason: 'REPLACEMENT_FORBIDDEN_CONFIRMED_SEGMENT', events: [],
        confirmedSegments: this.getConfirmedSegments() });
      if (!this.#endpointLifecycleMachine) return freeze({ applied: false,
        reason: 'REPLACEMENT_ACTIVE_ENDPOINT_REQUIRED', events: [] });
      const packet = this.#endpointLifecycleMachine.process(endpointProposal, currentAvailability);
      if (!packet.applied) return freeze({ ...clone(packet), lifecycleEvents: this.getLifecycleEvents() });
      this.#activeSegment = freeze(clone(packet.state.candidate));
      const invalidation = this.#case2Machine
        ? this.#case2Machine.invalidateForEndpointReplacement(packet.lifecycleEvent, currentAvailability)
        : null;
      if (this.#case2Machine) this.#endpointLifecycleMachine.syncPending(
        this.#case2Machine.getPendingTermination(), this.#case2Machine.getState().activeMemory);
      this.#lifecycleEvents.push(freeze(clone(packet.lifecycleEvent)));
      this.#currentBarIndex = Math.max(this.#currentBarIndex, currentAvailability.rawBarIndex);
      this.#currentBarTime = Math.max(this.#currentBarTime ?? Number.NEGATIVE_INFINITY, currentAvailability.time);
      return freeze({ ...clone(packet), invalidation,
        activeSegment: this.getActiveSegment(), lifecycleEvents: this.getLifecycleEvents() });
    }

    updateCase2Stroke(stroke, currentAvailability, identity = {}) {
      if (!this.#case2Machine) throw new Error('NO_CASE2_STATE');
      const normalized = normalizeStroke(stroke, this.#strokes.length);
      if (normalized && !this.#strokes.some(existing => existing.strokeId === normalized.strokeId)) {
        this.#strokes.push(normalized);
      }
      const packet = this.#case2Machine.updateConfirmedStroke(stroke, currentAvailability, identity);
      if (this.#endpointLifecycleMachine) this.#endpointLifecycleMachine.syncPending(
        this.#case2Machine.getPendingTermination(), this.#case2Machine.getState().activeMemory);
      const handoff = this.#adoptCase2Result(packet);
      return freeze({ ...clone(packet), confirmedSegments: this.getConfirmedSegments(), handoff });
    }

    update(input, options = {}) {
      const strokes = inputToStrokes(input);
      if (this.#acceptContinuationSuffix) {
        return this.#updateContinuationSuffix(strokes, options);
      }
      const signature = strokesSignature(strokes);
      if (this.#ruleConfig.segmentRuleVersion === 'CT-Segment-R1.0' &&
          (strokes.length < this.#strokes.length || this.#strokes.some((b,i)=>strokeSignature(b)!==strokeSignature(strokes[i]))))
        throw new Error('R1_UPSTREAM_REVISION_REQUIRES_REBUILD');
      if (this.#hasSeenInput && signature === this.#lastInputSignature) {
        const packet = {
          events: [],
          activeSegment: this.getActiveSegment(),
          confirmedSegments: this.getConfirmedSegments(),
          brokenSegments: this.getBrokenSegments(),
        };
        if (options.includeState) packet.state = this.getState();
        return freeze(packet);
      }

      const hasNoPriorStroke = !this.#hasSeenNonEmptyInput;
      const isColdHistoricalBootstrap = hasNoPriorStroke && strokes.length > 1 && options.allowHistoricalBootstrap === true;
      if (hasNoPriorStroke && strokes.length > 1 && !isColdHistoricalBootstrap) {
        throw new Error('SegmentStateMachine refuses cold historical bootstrap; feed Stroke prefixes incrementally or pass allowHistoricalBootstrap=true for read-only reconstruction.');
      }

      if (isColdHistoricalBootstrap) {
        this.#strokes = strokes;
        this.#rebuildWithoutEvents(strokes);
        this.#lastInputSignature = signature;
        this.#hasSeenInput = true;
        this.#hasSeenNonEmptyInput = strokes.length > 0;
        const packet = {
          events: [],
          activeSegment: this.getActiveSegment(),
          confirmedSegments: this.getConfirmedSegments(),
          brokenSegments: this.getBrokenSegments(),
          bootstrapped: true,
        };
        if (options.includeState) packet.state = this.getState();
        return freeze(packet);
      }

      const events = [];
      if (!this.#hasSeenInput || sameStrokePrefix(this.#strokes, strokes)) {
        const oldStrokes = this.#strokes;
        const start = this.#hasSeenInput ? oldStrokes.length : 0;
        this.#strokes = oldStrokes.slice();
        for (let index = start; index < strokes.length; index += 1) {
          this.#strokes.push(strokes[index]);
          if (this.#latestConfirmedAnchor) this.#ingestPostConfirmStroke(strokes[index], events);
          else this.#appendStroke(strokes[index], events);
        }
      } else {
        const oldActive = this.#activeSegment;
        this.#strokes = strokes;
        this.#rebuildWithoutEvents(strokes);
        if (oldActive && this.#activeSegment &&
            JSON.stringify(segmentToCompactRow(oldActive)) !== JSON.stringify(segmentToCompactRow(this.#activeSegment))) {
          const replaced = withSnakeAliases({ ...oldActive, status: STATUS_REPLACED });
          events.push(this.#event(ACTION_REPLACED, replaced, strokes[strokes.length - 1] || null, {
            reason: 'stroke-upstream-rewrite',
            replacedBy: this.#activeSegment.segmentId,
          }));
        } else if (oldActive && !this.#activeSegment) {
          const invalidated = withSnakeAliases({ ...oldActive, status: STATUS_INVALIDATED });
          events.push(this.#event(ACTION_INVALIDATED, invalidated, strokes[strokes.length - 1] || null, {
            reason: 'stroke-upstream-rewrite',
          }));
        }
      }

      this.#lastInputSignature = signature;
      this.#hasSeenInput = true;
      if (strokes.length > 0) this.#hasSeenNonEmptyInput = true;
      this.#events.push(...events);
      const packet = {
        events: clone(events),
        activeSegment: this.getActiveSegment(),
        confirmedSegments: this.getConfirmedSegments(),
        brokenSegments: this.getBrokenSegments(),
      };
      if (options.includeState) packet.state = this.getState();
      packet.sequentialStopReason = this.#sequentialStopReason;
      return freeze(packet);
    }

    #updateContinuationSuffix(strokes, options) {
      const events = [];
      for (const stroke of strokes) {
        const key = core.strokeRevisionKey(stroke);
        if (this.#strokes.some(existing => core.strokeRevisionKey(existing) === key)) continue;
        this.#strokes.push(stroke);
        if (this.#latestConfirmedAnchor) this.#ingestPostConfirmStroke(stroke, events);
        else this.#appendStroke(stroke, events);
      }
      this.#lastInputSignature = strokesSignature(this.#strokes);
      this.#hasSeenInput = true;
      if (this.#strokes.length) this.#hasSeenNonEmptyInput = true;
      this.#events.push(...events);
      const packet = {
        events: clone(events),
        activeSegment: this.getActiveSegment(),
        confirmedSegments: this.getConfirmedSegments(),
        brokenSegments: this.getBrokenSegments(),
        sequentialStopReason: this.#sequentialStopReason,
        restoredContinuation: true,
      };
      if (options.includeState) packet.state = this.getState();
      return freeze(packet);
    }

    #publishConfirmed(confirmed, caseType, now, provenance, metadata = {}) {
      const predecessorId = this.#latestConfirmedAnchor?.confirmedSegmentId ||
        this.#latestConfirmedAnchor?.segmentId || null;
      const decorated = core.decorateConfirmedPublication(confirmed, {
        caseType,
        ruleVersion: this.#ruleConfig.segmentRuleVersion,
        segmentSequenceIndex: this.#nextConfirmedSegmentSequenceIndex,
        predecessorSegmentId: confirmed.predecessorSegmentId ?? predecessorId,
      });
      const publicationId = decorated.confirmedSegmentId;
      const published = withSnakeAliases({
        ...decorated,
        segmentId: publicationId,
        structureId: publicationId,
        status: STATUS_CONFIRMED,
        mode: STATUS_CONFIRMED,
        caseType,
      });
      if (this.#isPublishedCandidate(publicationId) ||
          this.#isPublishedCandidate(decorated.sourceCandidateId)) {
        return { events: [], handoff: null };
      }
      const events = [];
      if (!metadata.reuseExistingConfirmedEvent) {
        const event = core.createStructuralEvent({
          eventId: `${publicationId}:${caseType}:CONFIRMED`,
          barIndex: now.rawBarIndex, barTime: now.time,
          structureId: publicationId, structureType: STRUCTURE_TYPE,
          eventAction: core.CT_EVENT_ACTIONS.confirmed,
          modeBefore: STATUS_EXTENDING, modeAfter: STATUS_CONFIRMED,
          eventTime: published.eventTime, availableTime: published.availableTime,
          confirmTime: published.confirmTime,
          eventRawBarIndex: published.eventRawBarIndex,
          availableRawBarIndex: published.availableRawBarIndex,
          confirmRawBarIndex: published.confirmRawBarIndex,
          eventStrokeIndex: published.eventStrokeIndex,
          availableStrokeIndex: published.availableStrokeIndex,
          confirmStrokeIndex: published.confirmStrokeIndex,
          eventIndex: published.eventRawBarIndex,
          confirmIndex: published.confirmRawBarIndex,
          ruleVersion: this.#ruleConfig.segmentRuleVersion,
          provenance,
          metadata: { ...metadata, segmentId: publicationId, confirmedSegmentId: publicationId,
            sourceCandidateId: decorated.sourceCandidateId, caseType,
            segmentSequenceIndex: published.segmentSequenceIndex },
        });
        this.#events.push(event);
        events.push(event);
      }
      this.#confirmedSegments.push(published);
      this.#latestConfirmedAnchor = published;
      this.#nextConfirmedSegmentSequenceIndex += 1;
      this.#activeSegment = null;
      this.#candidateStrokes = [];
      this.#case2Machine = null;
      this.#endpointLifecycleMachine = null;
      this.#pendingBacklogStrokes = [];
      const ownedStrokeIds = new Set(this.#confirmedSegments.flatMap(segment => segment.strokeIds || []));
      this.#consumedSuccessorStrokeIdentities = this.#consumedSuccessorStrokeIdentities.filter(key =>
        ownedStrokeIds.has(String(key).split('@')[0]));
      this.#currentBarIndex = now.rawBarIndex;
      this.#currentBarTime = now.time;
      const handoff = this.#inHandoff ? (this.#pendingHandoffClock = now, null) : this.#tryHandoff(now);
      return { events, handoff, published };
    }

    #tryHandoff(now) {
      const predecessor = this.#latestConfirmedAnchor;
      if (!predecessor || typeof core.evaluateSequentialHandoff !== 'function') return null;
      if (this.#inHandoff) {
        this.#pendingHandoffClock = now;
        return null;
      }
      if (this.#cascadeDepth >= (core.SEGMENT_SEQUENTIAL_MAX_CASCADE || 32)) {
        this.#sequentialStopReason = core.SEGMENT_SEQUENTIAL_STOP.maxCascade;
        return freeze({ action: 'NO_HANDOFF', reason: this.#sequentialStopReason });
      }
      this.#inHandoff = true;
      const clock = this.#handoffClock(now);
      this.#lastHandoffAvailability = clock;
      try {
        const decision = core.evaluateSequentialHandoff({
          predecessor,
          confirmedStrokeContinuationBuffer: this.#boundedContinuationBuffer(),
          handoffAvailability: clock,
          handoffConsumedPredecessorIds: this.#handoffConsumedPredecessorIds,
          consumedStrokeIdentities: this.#consumedSuccessorStrokeIdentities,
          ruleConfig: this.#ruleConfig,
        });
        if (decision.action === 'NO_HANDOFF') {
          if (decision.reason !== core.SEGMENT_SEQUENTIAL_STOP.handoffConsumed) {
            this.#sequentialStopReason = decision.reason;
          }
          return decision;
        }
        if (decision.implementationBoundaryViolation) {
          this.#sequentialStopReason = decision.reason;
          return decision;
        }
        if (decision.action === 'EMPTY_RETAIN_CONFIRMED_ANCHOR' || decision.seed?.kind === 'EMPTY') {
          this.#sequentialStopReason = decision.reason || core.SEGMENT_SEQUENTIAL_STOP.noSuccessorYet;
          return decision;
        }
        return this.#createSuccessorAndReplay(decision, clock);
      } finally {
        this.#inHandoff = false;
        if (this.#pendingHandoffClock) {
          const pending = this.#pendingHandoffClock;
          this.#pendingHandoffClock = null;
          if (this.#latestConfirmedAnchor &&
              !this.#handoffConsumedPredecessorIds.includes(
                this.#latestConfirmedAnchor.confirmedSegmentId || this.#latestConfirmedAnchor.segmentId)) {
            this.#tryHandoff(pending);
          }
        }
      }
    }

    #createSuccessorAndReplay(decision, clock) {
      const predecessor = this.#latestConfirmedAnchor;
      const predecessorId = predecessor.confirmedSegmentId || predecessor.segmentId;
      if (this.#handoffConsumedPredecessorIds.includes(predecessorId)) {
        return freeze({ action: 'NO_HANDOFF', reason: core.SEGMENT_SEQUENTIAL_STOP.handoffConsumed });
      }
      const seed = {
        ...decision.seed,
        candidateLineageOrdinal: this.#candidateLineageOrdinal + 1,
        predecessorConfirmedSegmentIndex: predecessor.segmentSequenceIndex,
        initialDirection: decision.seed.successorDirection,
      };
      this.#handoffConsumedPredecessorIds.push(predecessorId);
      this.#candidateLineageOrdinal += 1;
      this.#sequentialStopReason = null;
      this.#backlogProgress = {
        start: seed.backlogStartCursor,
        end: seed.backlogEndCursor,
        consumed: 0,
        total: decision.backlog.strokes.length,
      };
      this.#successorSourceCursor = seed.sourceCursorStart;
      const record = freeze({
        kind: 'SEQUENTIAL_HANDOFF',
        predecessorSegmentId: predecessorId,
        successorCandidateId: seed.successorCandidateId,
        sharedEndpointId: seed.sharedEndpointId,
        successorDirection: seed.successorDirection,
        candidateCreatedTime: seed.candidateCreatedTime,
        eventTime: seed.eventTime,
        backlogCount: decision.backlog.strokes.length,
      });
      this.#handoffEvents.push(record);
      this.#cascadeDepth += 1;
      try {
        this.#replaySuccessorBacklog(seed, decision.backlog, clock);
      } finally {
        this.#cascadeDepth -= 1;
      }
      return freeze({ action: 'CREATE_SUCCESSOR_SEED_AND_BOUNDED_REPLAY', seed, backlog: decision.backlog });
    }

    #replaySuccessorBacklog(seed, backlog, clock) {
      const lifecycle = {
        segmentCandidateId: seed.successorCandidateId,
        predecessorSegmentId: seed.predecessorSegmentId,
        candidateCreatedTime: seed.candidateCreatedTime,
        candidateAvailableRawBarIndex: seed.candidateAvailableRawBarIndex,
        reason: 'sequential-handoff-successor',
      };
      this.#pendingBacklogStrokes = clone(backlog.strokes || []);
      for (const stroke of backlog.strokes || []) {
        const key = core.strokeRevisionKey(stroke);
        if (this.#consumedSuccessorStrokeIdentities.includes(key) ||
            this.#consumedSuccessorStrokeIdentities.includes(stroke.strokeId)) {
          this.#pendingBacklogStrokes = this.#pendingBacklogStrokes.filter(item =>
            core.strokeRevisionKey(item) !== key);
          continue;
        }
        const events = [];
        this.#appendStroke(stroke, events, lifecycle);
        this.#consumedSuccessorStrokeIdentities.push(key);
        this.#events.push(...events);
        this.#handoffEvents.push(...events.map(event => freeze({ ...clone(event), via: 'BACKLOG_REPLAY' })));
        if (this.#backlogProgress) this.#backlogProgress.consumed += 1;
        this.#pendingBacklogStrokes = this.#pendingBacklogStrokes.filter(item =>
          core.strokeRevisionKey(item) !== key);
        const publishedBefore = this.#confirmedSegments.length;
        this.#evaluateActiveCandidateGuards(clock);
        if (this.#confirmedSegments.length > publishedBefore) break;
        if (this.#case2Machine && this.#activeSegment && this.#case2Machine.getPendingTermination()) {
          try {
            this.updateCase2Stroke(stroke, clock, {
              candidateSegmentId: this.#case2Machine.getPendingTermination().candidateSegmentId,
              endpointIdentity: this.#case2Machine.getPendingTermination().endpointIdentity,
              ruleVersion: this.#case2Machine.getPendingTermination().ruleVersion,
            });
          } catch { /* reverse identity mismatch is not a restart */ }
          if (!this.#activeSegment) break;
        }
      }
    }

    #ingestPostConfirmStroke(stroke, events) {
      const key = core.strokeRevisionKey(stroke);
      if (this.#consumedSuccessorStrokeIdentities.includes(key) ||
          this.#consumedSuccessorStrokeIdentities.includes(stroke.strokeId)) return;
      const members = new Set(this.#latestConfirmedAnchor.strokeIds || []);
      if (members.has(stroke.strokeId)) return;
      const clock = { rawBarIndex: stroke.confirmIndex, time: stroke.confirmTime };
      if (!this.#activeSegment) {
        this.#tryHandoff(this.#lastHandoffAvailability || {
          rawBarIndex: this.#latestConfirmedAnchor.confirmRawBarIndex,
          time: this.#latestConfirmedAnchor.confirmTime,
        });
        if (this.#consumedSuccessorStrokeIdentities.includes(key)) return;
        if (!this.#activeSegment) {
          const endpoint = core.sharedEndpointOf(this.#latestConfirmedAnchor);
          const opposite = core.oppositeSegmentDirection(this.#latestConfirmedAnchor.direction);
          const legalFirst = core.startsAtSharedEndpoint(stroke, endpoint, this.#ruleConfig.numericTolerance) &&
            stroke.direction === opposite;
          if (legalFirst) {
            const backlog = core.buildSuccessorBacklog({
              predecessor: this.#latestConfirmedAnchor,
              strokesFromCursor: [stroke],
              handoffAvailability: clock,
              consumedStrokeIdentities: this.#consumedSuccessorStrokeIdentities,
              ruleConfig: this.#ruleConfig,
            });
            const seed = core.createSuccessorSeed({
              predecessor: this.#latestConfirmedAnchor,
              backlog,
              handoffAvailability: clock,
              ruleVersion: this.#ruleConfig.segmentRuleVersion,
            });
            if (seed.kind === 'SuccessorSeed') {
              this.#createSuccessorAndReplay({ seed, backlog, action: 'CREATE_SUCCESSOR_SEED_AND_BOUNDED_REPLAY' }, clock);
              return;
            }
          }
          this.#sequentialStopReason = core.SEGMENT_SEQUENTIAL_STOP.restartUnresolved;
          return;
        }
      }
      const last = this.#candidateStrokes[this.#candidateStrokes.length - 1];
      const legal = last
        ? core.continuesSuccessorChain(last, stroke, this.#ruleConfig.numericTolerance)
        : (core.startsAtSharedEndpoint(stroke, core.sharedEndpointOf(this.#latestConfirmedAnchor),
          this.#ruleConfig.numericTolerance) &&
          stroke.direction === core.oppositeSegmentDirection(this.#latestConfirmedAnchor.direction));
      if (!legal) {
        this.#sequentialStopReason = core.SEGMENT_SEQUENTIAL_STOP.restartUnresolved;
        return;
      }
      this.#appendStroke(stroke, events, {
        segmentCandidateId: this.#activeSegment.segmentCandidateId,
        predecessorSegmentId: this.#activeSegment.predecessorSegmentId,
        candidateCreatedTime: this.#activeSegment.candidateCreatedTime,
        candidateAvailableRawBarIndex: this.#activeSegment.candidateAvailableRawBarIndex,
      });
      this.#consumedSuccessorStrokeIdentities.push(key);
      if (this.#case2Machine && !this.#case2Machine.getConfirmedSegment()) {
        try {
          this.updateCase2Stroke(stroke, clock, {
            candidateSegmentId: this.#case2Machine.getPendingTermination()?.candidateSegmentId,
            endpointIdentity: this.#case2Machine.getPendingTermination()?.endpointIdentity,
            ruleVersion: this.#case2Machine.getPendingTermination()?.ruleVersion,
          });
        } catch {
          /* Case2 identity may be absent; successor still consumes the Stroke. */
        }
      }
      this.#evaluateActiveCandidateGuards(clock);
    }

    #evaluateActiveCandidateGuards(now) {
      if (this.#inGuardEvaluation) return;
      if (!this.#activeSegment || this.#candidateStrokes.length < 3) return;
      this.#inGuardEvaluation = true;
      try {
      if (typeof core.buildFeatureSequence !== 'function' ||
          typeof core.FeatureSequenceInclusionStateMachine !== 'function' ||
          typeof core.detectFeatureFractals !== 'function' ||
          typeof core.evaluateSegmentCase1 !== 'function') return;
      const raw = core.buildFeatureSequence(this.#candidateStrokes, {
        ruleConfig: this.#ruleConfig,
        segmentStartDirection: this.#activeSegment.direction,
      });
      const engine = new core.FeatureSequenceInclusionStateMachine({
        ...raw,
        candidateSegmentId: this.#activeSegment.segmentId,
      });
      for (const element of raw.elements) engine.update(element);
      const sequence = engine.getState();
      const fractals = core.detectFeatureFractals(engine.getDetectorInput(), { ruleConfig: this.#ruleConfig });
      const clock = this.#successorConfirmClock(now);
      for (const featureFractal of fractals.confirmedFeatureFractals || []) {
        if (!this.#activeSegment) return;
        const gapResult = core.getCase1RelevantGap(sequence, featureFractal, this.#ruleConfig);
        const input = {
          standardizedSequence: sequence,
          featureFractal,
          confirmedFeatureFractal: featureFractal,
          gapResult,
          currentAvailability: clock,
          segmentState: this.#activeSegment,
          candidateSegmentState: this.#activeSegment,
          confirmedStrokes: this.#candidateStrokes,
          ruleConfig: this.#ruleConfig,
        };
        const decision = core.evaluateSegmentCase1(input);
        if (decision.eligible) {
          this.confirmCase1(input);
          return;
        }
        if (decision.reason === 'GAP_REQUIRES_CASE2' && typeof core.evaluateSegmentCase2Entry === 'function') {
          this.beginCase2(input);
          if (!this.#activeSegment) return;
        }
      }
      } finally {
        this.#inGuardEvaluation = false;
      }
    }

    #boundedContinuationBuffer() {
      if (!this.#latestConfirmedAnchor) {
        return clone(this.#candidateStrokes);
      }
      const start = core.findSuccessorBacklogStartOrdinal(this.#strokes, this.#latestConfirmedAnchor);
      if (start.boundaryViolation) {
        const endpointId = this.#latestConfirmedAnchor.endpointStrokeId || this.#latestConfirmedAnchor.endStrokeId;
        const endpoint = this.#strokes.find(stroke => stroke.strokeId === endpointId);
        return clone([endpoint, ...this.#candidateStrokes, ...this.#pendingBacklogStrokes].filter(Boolean));
      }
      return clone(this.#strokes.slice(Math.max(0, start.startOrdinal - 1)));
    }

    serializeSequentialContinuation() {
      return freeze({
        continuationVersion: core.SEGMENT_SEQUENTIAL_CONTINUATION_VERSION,
        latestConfirmedSegmentAnchor: clone(this.#latestConfirmedAnchor),
        activeSuccessorCandidate: clone(this.#activeSegment),
        candidateStrokes: clone(this.#candidateStrokes),
        confirmedSegments: clone(this.#confirmedSegments),
        segmentSequenceIndex: this.#nextConfirmedSegmentSequenceIndex,
        handoffConsumedCursor: clone(this.#handoffConsumedPredecessorIds),
        strokeSourceCursor: this.#successorSourceCursor,
        backlogStartCursor: this.#backlogProgress?.start ?? null,
        backlogEndCursor: this.#backlogProgress?.end ?? null,
        backlogProgress: clone(this.#backlogProgress),
        pendingBacklogStrokes: clone(this.#pendingBacklogStrokes),
        continuationStrokeBuffer: this.#boundedContinuationBuffer(),
        consumedSuccessorStrokeIdentities: clone(this.#consumedSuccessorStrokeIdentities),
        candidateLineageOrdinal: this.#candidateLineageOrdinal,
        sequentialStopReason: this.#sequentialStopReason,
        handoffAvailability: clone(this.#lastHandoffAvailability),
        case2ContinuationState: this.#case2Machine?.serializeContinuationState() ?? null,
        endpointLifecycleContinuationState:
          this.#endpointLifecycleMachine?.serializeContinuationState() ?? null,
        candidateIdentity: this.#activeSegment?.segmentCandidateId ?? null,
        ruleVersion: this.#ruleConfig.segmentRuleVersion,
        timeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      });
    }

    restoreSequentialContinuation(snapshot) {
      if (!snapshot || snapshot.continuationVersion !== core.SEGMENT_SEQUENTIAL_CONTINUATION_VERSION) {
        throw new Error('INCOMPATIBLE_SEQUENTIAL_CONTINUATION');
      }
      this.reset();
      this.#acceptContinuationSuffix = true;
      this.#latestConfirmedAnchor = snapshot.latestConfirmedSegmentAnchor
        ? freeze(clone(snapshot.latestConfirmedSegmentAnchor)) : null;
      this.#confirmedSegments = clone(snapshot.confirmedSegments ||
        (snapshot.latestConfirmedSegmentAnchor ? [snapshot.latestConfirmedSegmentAnchor] : []));
      this.#nextConfirmedSegmentSequenceIndex = Number(snapshot.segmentSequenceIndex || 0);
      this.#handoffConsumedPredecessorIds = clone(snapshot.handoffConsumedCursor || []);
      this.#consumedSuccessorStrokeIdentities = clone(snapshot.consumedSuccessorStrokeIdentities || []);
      this.#candidateLineageOrdinal = Number(snapshot.candidateLineageOrdinal || 0);
      this.#activeSegment = snapshot.activeSuccessorCandidate
        ? freeze(clone(snapshot.activeSuccessorCandidate)) : null;
      this.#candidateStrokes = clone(snapshot.candidateStrokes || []);
      this.#strokes = clone(snapshot.continuationStrokeBuffer || []);
      this.#backlogProgress = snapshot.backlogProgress ? clone(snapshot.backlogProgress) : null;
      this.#successorSourceCursor = snapshot.strokeSourceCursor ?? null;
      this.#sequentialStopReason = snapshot.sequentialStopReason ?? null;
      this.#pendingBacklogStrokes = clone(snapshot.pendingBacklogStrokes || []);
      this.#lastHandoffAvailability = snapshot.handoffAvailability
        ? clone(snapshot.handoffAvailability) : (this.#latestConfirmedAnchor ? {
          rawBarIndex: this.#latestConfirmedAnchor.confirmRawBarIndex,
          time: this.#latestConfirmedAnchor.confirmTime,
        } : null);
      if (snapshot.case2ContinuationState) {
        if (typeof core.SegmentCase2StateMachine !== 'function') {
          throw new Error('CASE2_MODULE_NOT_LOADED_FOR_CONTINUATION');
        }
        this.#case2Machine = new core.SegmentCase2StateMachine(
          this.#ruleConfig, snapshot.case2ContinuationState);
      }
      if (snapshot.endpointLifecycleContinuationState) {
        if (typeof core.SegmentEndpointLifecycleStateMachine !== 'function') {
          throw new Error('ENDPOINT_LIFECYCLE_MODULE_NOT_LOADED_FOR_CONTINUATION');
        }
        this.#endpointLifecycleMachine = new core.SegmentEndpointLifecycleStateMachine(
          { ruleConfig: this.#ruleConfig }, snapshot.endpointLifecycleContinuationState);
      }
      this.#hasSeenInput = true;
      this.#hasSeenNonEmptyInput = this.#strokes.length > 0;
      this.#lastInputSignature = strokesSignature(this.#strokes);
      const last = this.#strokes[this.#strokes.length - 1];
      this.#currentBarIndex = last?.confirmIndex ?? this.#latestConfirmedAnchor?.confirmRawBarIndex ?? -1;
      this.#currentBarTime = last?.confirmTime ?? this.#latestConfirmedAnchor?.confirmTime ?? null;
      if (this.#pendingBacklogStrokes.length && this.#activeSegment && this.#lastHandoffAvailability) {
        this.#replaySuccessorBacklog({
          successorCandidateId: this.#activeSegment.segmentCandidateId,
          predecessorSegmentId: this.#activeSegment.predecessorSegmentId,
          candidateCreatedTime: this.#activeSegment.candidateCreatedTime,
          candidateAvailableRawBarIndex: this.#activeSegment.candidateAvailableRawBarIndex,
        }, { strokes: this.#pendingBacklogStrokes }, this.#lastHandoffAvailability);
      } else if (this.#latestConfirmedAnchor && !this.#activeSegment && this.#lastHandoffAvailability) {
        this.#tryHandoff(this.#lastHandoffAvailability);
      }
      return this;
    }

    getState() {
      const activeStructures = this.#activeSegment ? [segmentToStructuralState(this.#activeSegment)] : [];
      const confirmedStructures = this.#confirmedSegments.map(segmentToStructuralState);
      const brokenStructures = this.#brokenSegments.map(segmentToStructuralState);
      const layer = core.createBaseCTState({
        structureType: STRUCTURE_TYPE,
        mode: this.#activeSegment?.status || (this.#confirmedSegments.length ? STATUS_CONFIRMED : STATUS_NONE),
        continuousState: {
          inputStrokeCount: this.#strokes.length,
          activeSegmentId: this.#activeSegment?.segmentId || null,
          activeSegmentStatus: this.#activeSegment?.status || null,
          confirmedSegmentCount: this.#confirmedSegments.length,
          brokenSegmentCount: this.#brokenSegments.length,
          currentBarIndex: this.#currentBarIndex,
          currentBarTime: this.#currentBarTime,
        },
        activeMemory: {
          activeSegment: this.#activeSegment,
          latestConfirmedSegmentAnchor: this.#latestConfirmedAnchor,
          unfinishedStrokeIds: this.#strokes.map(stroke => stroke.strokeId),
          recentStrokes: this.#strokes.slice(-6),
          confirmationRuleStatus: this.#confirmedSegments.length
            ? `${this.#confirmedSegments.at(-1).caseType || 'CASE_1'}_CONFIRMED`
            : (this.#case2Machine ? 'CASE2_PENDING_OR_STALE' : 'CASE2_NOT_STARTED'),
          pendingTermination: this.#case2Machine?.getPendingTermination() ?? null,
          case2ContinuationState: this.#case2Machine?.serializeContinuationState() ?? null,
          endpointLifecycleContinuationState:
            this.#endpointLifecycleMachine?.serializeContinuationState() ?? null,
          lifecycleEvents: this.#lifecycleEvents,
          sequentialContinuation: this.serializeSequentialContinuation(),
        },
        structures: [...confirmedStructures, ...brokenStructures, ...activeStructures],
        lastEventId: this.#logicalLastEventId(),
        metadata: {
          ruleVersion: this.#ruleConfig.ruleVersion,
          segmentRuleVersion: this.#ruleConfig.segmentRuleVersion,
          segmentInterfaceVersion: SEGMENT_INTERFACE_VERSION,
          sourceLayer: 'strokeState',
          warning: 'Phase 5E3C-B implements frozen shared-endpoint sequential handoff; Candidate Restart and BROKEN remain unresolved.',
        },
      });
      return core.attachStateHash(core.createCTState({
        currentBarIndex: this.#currentBarIndex,
        currentBarTime: this.#currentBarTime,
        ruleVersion: this.#ruleConfig.ruleVersion,
        activeMemorySize: this.#activeMemorySize(),
        segmentState: layer,
        parserMetadata: {
          parser: 'SegmentStateMachine',
          phase: 'CT-Phase5E3C-B',
          upstream: 'StrokeStateMachine',
          confirmationRuleStatus: this.#confirmedSegments.length
            ? `${this.#confirmedSegments.at(-1).caseType || 'CASE_1'}_CONFIRMED`
            : (this.#case2Machine ? 'CASE2_PENDING_OR_STALE' : 'CASE2_NOT_STARTED'),
          sequentialStopReason: this.#sequentialStopReason,
        },
      }));
    }
  }

  function parseSegmentsBatch(strokes, ruleConfig = {}) {
    const machine = new SegmentStateMachine(ruleConfig);
    const inputStrokes = inputToStrokes(strokes);
    for (let index = 0; index < inputStrokes.length; index += 1) {
      machine.update(inputStrokes.slice(0, index + 1));
    }
    return freeze({
      state: machine.getState(),
      activeSegment: machine.getActiveSegment(),
      confirmedSegments: machine.getConfirmedSegments(),
      brokenSegments: machine.getBrokenSegments(),
      events: machine.getEvents(),
    });
  }

  Object.assign(core, {
    SEGMENT_INTERFACE_VERSION,
    SegmentStateMachine,
    parseSegmentsBatch,
    segmentToStructuralState,
    segmentToCompactRow,
  });
})();

