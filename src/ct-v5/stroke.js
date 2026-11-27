(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const STRUCTURE_TYPE = core.CT_STRUCTURE_TYPES?.stroke || 'stroke';
  const FRACTAL_TYPE = core.CT_STRUCTURE_TYPES?.fractal || 'fractal';
  const STATUS_CANDIDATE = core.CT_STATUSES?.candidate || 'CANDIDATE';
  const STATUS_CONFIRMED = core.CT_STATUSES?.confirmed || 'CONFIRMED';
  const STATUS_REPLACED = core.CT_STATUSES?.replaced || 'REPLACED';
  const STATUS_INVALIDATED = core.CT_STATUSES?.invalidated || 'INVALIDATED';
  const ACTION_CANDIDATE = core.CT_EVENT_ACTIONS?.candidate || 'CANDIDATE';
  const ACTION_CONFIRMED = core.CT_EVENT_ACTIONS?.confirmed || 'CONFIRMED';
  const ACTION_REPLACED = core.CT_EVENT_ACTIONS?.replaced || 'REPLACED';
  const ACTION_INVALIDATED = core.CT_EVENT_ACTIONS?.invalidated || 'INVALIDATED';
  const DIR_UP = core.CT_DIRECTIONS?.up || 'UP';
  const DIR_DOWN = core.CT_DIRECTIONS?.down || 'DOWN';

  const STROKE_RULE_VERSION = 'alternating-fractal-min-separation-v1';
  const CONTINUATION_VERSION = 'CT-Stroke-Continuation-v1.0';

  function requireDependencies() {
    for (const name of ['createCTRuleConfig', 'createStructuralState',
      'createStructuralEvent', 'createBaseCTState', 'createCTState', 'attachStateHash']) {
      if (typeof core[name] !== 'function') throw new Error(`CT stroke requires MarketCore.${name}`);
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
    if (!Number.isFinite(number)) throw new Error(`StrokeStateMachine ${field} must be finite`);
    return number;
  }

  function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function integerNumber(value, field) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      throw new Error(`StrokeStateMachine ${field} must be a non-negative integer`);
    }
    return number;
  }

  function fractalTypeOf(value) {
    const text = String(value || '').toUpperCase();
    if (text === 'TOP' || text === 'BOTTOM') return text;
    throw new Error(`StrokeStateMachine fractal type must be TOP or BOTTOM, got ${String(value)}`);
  }

  function fractalStatusOf(value) {
    return String(value || STATUS_CONFIRMED).toUpperCase();
  }

  function normalizedIndexOf(input, fallback) {
    const direct = input.eventNormalizedIndex ?? input.event_normalized_index;
    if (direct !== null && direct !== undefined) return integerNumber(direct, 'fractal.eventNormalizedIndex');
    const window = input.metadata?.normalizedWindow ?? input.metadata?.normalized_window;
    if (Array.isArray(window) && window[1] !== null && window[1] !== undefined) {
      return integerNumber(window[1], 'fractal.metadata.normalizedWindow[1]');
    }
    const sourceRange = input.metadata?.sourceRange ?? input.metadata?.source_range;
    const middle = sourceRange?.middle;
    if (Array.isArray(middle) && middle[1] !== null && middle[1] !== undefined) {
      return integerNumber(middle[1], 'fractal.metadata.sourceRange.middle[1]');
    }
    return integerNumber(fallback, 'fractal.eventNormalizedIndex fallback');
  }

  function normalizeFractal(input, ordinal) {
    if (!input || typeof input !== 'object') {
      throw new Error(`StrokeStateMachine fractals[${ordinal}] is required`);
    }
    const status = fractalStatusOf(input.status);
    if (status !== STATUS_CONFIRMED) return null;
    const type = fractalTypeOf(input.type ?? input.metadata?.type);
    const eventIndex = integerNumber(input.eventRawBarIndex ?? input.event_raw_bar_index ??
      input.eventIndex ?? input.event_index, `fractals[${ordinal}].eventRawBarIndex`);
    const eventTime = finiteNumber(input.eventTime ?? input.event_time, `fractals[${ordinal}].eventTime`);
    const confirmIndex = integerNumber(input.confirmRawBarIndex ?? input.confirm_raw_bar_index ??
      input.confirmIndex ?? input.confirm_index, `fractals[${ordinal}].confirmRawBarIndex`);
    const confirmTime = finiteNumber(input.confirmTime ?? input.confirm_time, `fractals[${ordinal}].confirmTime`);
    if (confirmIndex < eventIndex || confirmTime < eventTime) {
      throw new Error(`StrokeStateMachine fractals[${ordinal}] confirm must be >= event`);
    }
    const price = finiteNumber(input.price ?? input.metadata?.price, `fractals[${ordinal}].price`);
    const eventNormalizedIndex = normalizedIndexOf(input, eventIndex);
    const sourceKIds = input.sourceKIds ?? input.source_k_ids ?? input.metadata?.sourceKIds ?? input.metadata?.source_k_ids ?? [];
    return freeze({
      structureId: String(input.structureId ?? input.structure_id ?? `${input.ruleVersion || 'CT-R1.0'}:fractal:${type}:${eventIndex}:${confirmIndex}`),
      structureType: FRACTAL_TYPE,
      type,
      status,
      eventRawBarIndex: eventIndex,
      eventIndex,
      eventTime,
      availableRawBarIndex: integerNumber(input.availableRawBarIndex ?? input.available_raw_bar_index ??
        confirmIndex, `fractals[${ordinal}].availableRawBarIndex`),
      availableTime: finiteNumber(input.availableTime ?? input.available_time ?? confirmTime,
        `fractals[${ordinal}].availableTime`),
      confirmRawBarIndex: confirmIndex,
      confirmIndex,
      confirmTime,
      price,
      eventNormalizedIndex,
      sourceKIds: Array.isArray(sourceKIds) ? sourceKIds.map(String) : [],
      ruleVersion: String(input.ruleVersion ?? input.rule_version ?? 'CT-R1.0'),
      metadata: freeze(clone(input.metadata || {})),
    });
  }

  function inputToFractals(input) {
    const source = Array.isArray(input)
      ? input
      : (input?.confirmedFractals || input?.fractals || input?.strokeInputFractals || []);
    if (!Array.isArray(source)) throw new Error('StrokeStateMachine.update expects confirmedFractals array or a Fractal packet');
    const fractals = [];
    for (let index = 0; index < source.length; index += 1) {
      const normalized = normalizeFractal(source[index], index);
      if (normalized) fractals.push(normalized);
    }
    for (let index = 1; index < fractals.length; index += 1) {
      const previous = fractals[index - 1];
      const current = fractals[index];
      if (current.eventNormalizedIndex <= previous.eventNormalizedIndex) {
        throw new Error('StrokeStateMachine fractal eventNormalizedIndex must be strictly increasing');
      }
      if (current.confirmIndex < previous.confirmIndex) {
        throw new Error('StrokeStateMachine fractal confirmIndex must be non-decreasing');
      }
    }
    return fractals;
  }

  function fractalSignature(fractal) {
    return [
      fractal.structureId,
      fractal.type,
      fractal.eventNormalizedIndex,
      fractal.eventIndex,
      fractal.eventTime,
      fractal.confirmIndex,
      fractal.confirmTime,
      fractal.price,
    ].join(':');
  }

  function fractalsSignature(fractals) {
    return fractals.map(fractalSignature).join('|');
  }

  function isMoreExtremeFractal(next, previous) {
    if (!next || !previous || next.type !== previous.type) return false;
    if (next.type === 'TOP') return Number(next.price) > Number(previous.price);
    return Number(next.price) < Number(previous.price);
  }

  function normalizedDistance(start, end) {
    return Math.abs(Number(end.eventNormalizedIndex) - Number(start.eventNormalizedIndex));
  }

  function strokeDirection(start, end) {
    if (start.type === 'BOTTOM' && end.type === 'TOP') return DIR_UP;
    if (start.type === 'TOP' && end.type === 'BOTTOM') return DIR_DOWN;
    throw new Error(`Stroke endpoints must alternate: ${start.type} -> ${end.type}`);
  }

  function strokeId(ruleVersion, minimumStrokeSeparation, start, end) {
    return `${ruleVersion}:stroke:${STROKE_RULE_VERSION}:m${minimumStrokeSeparation}:${start.structureId}>${end.structureId}`;
  }

  function withSnakeAliases(stroke) {
    return freeze({
      ...stroke,
      stroke_id: stroke.strokeId,
      start_fractal_id: stroke.startFractalId,
      end_fractal_id: stroke.endFractalId,
      start_price: stroke.startPrice,
      end_price: stroke.endPrice,
      event_time: stroke.eventTime,
      confirm_time: stroke.confirmTime,
    });
  }

  function makeStroke(start, end, status, ruleVersion, minimumStrokeSeparation, strokeIndex = null) {
    const direction = strokeDirection(start, end);
    const priceDelta = Number(end.price) - Number(start.price);
    const amplitude = Math.abs(priceDelta);
    const duration = Math.max(0, Number(end.eventTime) - Number(start.eventTime));
    const nDuration = Math.max(0, normalizedDistance(start, end));
    const confirmed = status === STATUS_CONFIRMED;
    const structureId = strokeId(ruleVersion, minimumStrokeSeparation, start, end);
    return withSnakeAliases({
      structureId,
      strokeId: structureId,
      structureType: STRUCTURE_TYPE,
      status,
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      strokeIndex,
      startFractalId: start.structureId,
      endFractalId: end.structureId,
      direction,
      startPrice: Number(start.price),
      endPrice: Number(end.price),
      amplitude,
      duration,
      slope: nDuration > 0 ? priceDelta / nDuration : 0,
      eventRawBarIndex: end.eventRawBarIndex,
      eventIndex: end.eventRawBarIndex,
      eventTime: end.eventTime,
      availableRawBarIndex: end.confirmRawBarIndex,
      availableTime: end.confirmTime,
      confirmRawBarIndex: confirmed ? end.confirmRawBarIndex : null,
      confirmIndex: confirmed ? end.confirmRawBarIndex : null,
      confirmTime: confirmed ? end.confirmTime : null,
      eventNormalizedKIndex: end.eventNormalizedIndex,
      availableNormalizedKIndex: end.eventNormalizedIndex,
      confirmNormalizedKIndex: confirmed ? end.eventNormalizedIndex : null,
      eventStrokeIndex: strokeIndex,
      availableStrokeIndex: strokeIndex,
      confirmStrokeIndex: confirmed ? strokeIndex : null,
      startIndex: start.eventIndex,
      endIndex: end.eventIndex,
      startTime: start.eventTime,
      endTime: end.eventTime,
      startEventNormalizedIndex: start.eventNormalizedIndex,
      endEventNormalizedIndex: end.eventNormalizedIndex,
      normalizedDuration: nDuration,
      sourceFractalIds: [start.structureId, end.structureId],
      ruleVersion,
      minimumStrokeSeparation,
      metadata: {
        strokeRuleVersion: STROKE_RULE_VERSION,
        startFractal: clone(start),
        endFractal: clone(end),
        priceDelta,
        timeSlope: duration > 0 ? priceDelta / duration : 0,
      },
    });
  }

  function strokeToStructuralState(stroke) {
    return core.createStructuralState({
      structureId: stroke.structureId,
      structureType: STRUCTURE_TYPE,
      status: stroke.status,
      eventRawBarIndex: stroke.eventRawBarIndex,
      eventTime: stroke.eventTime,
      availableRawBarIndex: stroke.availableRawBarIndex,
      availableTime: stroke.availableTime,
      confirmRawBarIndex: stroke.confirmRawBarIndex,
      confirmTime: stroke.confirmTime,
      eventNormalizedKIndex: stroke.eventNormalizedKIndex,
      availableNormalizedKIndex: stroke.availableNormalizedKIndex,
      confirmNormalizedKIndex: stroke.confirmNormalizedKIndex,
      eventStrokeIndex: stroke.eventStrokeIndex,
      availableStrokeIndex: stroke.availableStrokeIndex,
      confirmStrokeIndex: stroke.confirmStrokeIndex,
      eventIndex: stroke.eventRawBarIndex,
      confirmIndex: stroke.confirmRawBarIndex,
      startIndex: stroke.startIndex,
      endIndex: stroke.endIndex,
      startTime: stroke.startTime,
      endTime: stroke.endTime,
      direction: stroke.direction,
      priceLow: Math.min(stroke.startPrice, stroke.endPrice),
      priceHigh: Math.max(stroke.startPrice, stroke.endPrice),
      ruleVersion: stroke.ruleVersion,
      metadata: {
        strokeId: stroke.strokeId,
        stroke_id: stroke.strokeId,
        startFractalId: stroke.startFractalId,
        endFractalId: stroke.endFractalId,
        start_fractal_id: stroke.startFractalId,
        end_fractal_id: stroke.endFractalId,
        startPrice: stroke.startPrice,
        endPrice: stroke.endPrice,
        amplitude: stroke.amplitude,
        duration: stroke.duration,
        normalizedDuration: stroke.normalizedDuration,
        slope: stroke.slope,
        minimumStrokeSeparation: stroke.minimumStrokeSeparation,
        strokeRuleVersion: stroke.metadata?.strokeRuleVersion || STROKE_RULE_VERSION,
      },
    });
  }

  function strokeToCompactRow(stroke) {
    return [
      stroke.strokeId,
      stroke.status,
      stroke.startFractalId,
      stroke.endFractalId,
      stroke.direction,
      stroke.startPrice,
      stroke.endPrice,
      stroke.amplitude,
      stroke.duration,
      stroke.slope,
      stroke.eventIndex,
      stroke.confirmIndex,
    ];
  }

  function sameFractalPrefix(previous, next) {
    if (previous.length > next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index].structureId !== next[index].structureId) return false;
    }
    return true;
  }

  class StrokeStateMachine {
    #ruleConfig;
    #minimumStrokeSeparation;
    #fractals = [];
    #anchorFractal = null;
    #candidateStroke = null;
    #strokes = [];
    #events = [];
    #currentBarIndex = -1;
    #currentBarTime = null;
    #lastInputSignature = '';
    #hasSeenInput = false;
    #hasSeenNonEmptyInput = false;

    constructor(ruleConfig = {}) {
      requireDependencies();
      this.#ruleConfig = core.createCTRuleConfig(ruleConfig.ruleConfig || ruleConfig);
      this.#minimumStrokeSeparation = this.#ruleConfig.minimumStrokeSeparation;
      this.reset();
    }

    reset() {
      this.#fractals = [];
      this.#anchorFractal = null;
      this.#candidateStroke = null;
      this.#strokes = [];
      this.#events = [];
      this.#currentBarIndex = -1;
      this.#currentBarTime = null;
      this.#lastInputSignature = '';
      this.#hasSeenInput = false;
      this.#hasSeenNonEmptyInput = false;
      return this;
    }

    getRuleConfig() { return clone(this.#ruleConfig); }
    getMinimumStrokeSeparation() { return this.#minimumStrokeSeparation; }
    getConfirmedStrokes() { return clone(this.#strokes); }
    getCandidateStroke() { return clone(this.#candidateStroke); }
    getAnchorFractal() { return clone(this.#anchorFractal); }
    getInputFractals() { return clone(this.#fractals); }
    getEvents() { return clone(this.#events); }

    serializeContinuationState() {
      return freeze({
        continuationVersion: CONTINUATION_VERSION,
        ruleVersion: this.#ruleConfig.ruleVersion,
        strokeRuleVersion: STROKE_RULE_VERSION,
        structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        confirmedFractals: clone(this.#fractals),
      });
    }

    restoreContinuationState(snapshot) {
      if (!snapshot || snapshot.continuationVersion !== CONTINUATION_VERSION) {
        throw new Error('INCOMPATIBLE_STROKE_CONTINUATION');
      }
      if (snapshot.ruleVersion !== this.#ruleConfig.ruleVersion ||
          snapshot.strokeRuleVersion !== STROKE_RULE_VERSION) {
        throw new Error('STROKE_CONTINUATION_RULE_VERSION_MISMATCH');
      }
      this.reset();
      const fractals = Array.isArray(snapshot.confirmedFractals) ? snapshot.confirmedFractals : [];
      if (fractals.length) this.update(fractals, { allowHistoricalBootstrap: true });
      return this;
    }

    #activeMemorySize() {
      return core.estimateActiveMemorySize({
        recentFractals: this.#fractals.slice(-6),
        anchorFractal: this.#anchorFractal,
        candidateStroke: this.#candidateStroke,
        confirmedStrokeIds: this.#strokes.map(stroke => stroke.strokeId),
      });
    }

    #logicalLastEventId() {
      if (this.#candidateStroke) {
        return `${this.#ruleConfig.ruleVersion}:logical:stroke:${this.#candidateStroke.strokeId}:CANDIDATE:${this.#currentBarIndex}`;
      }
      const lastStroke = this.#strokes[this.#strokes.length - 1] || null;
      if (lastStroke) {
        return `${this.#ruleConfig.ruleVersion}:logical:stroke:${lastStroke.strokeId}:CONFIRMED:${lastStroke.confirmIndex}`;
      }
      return null;
    }

    #event(action, stroke, currentFractal, metadata = {}) {
      const eventFractal = currentFractal || stroke.metadata?.endFractal || this.#anchorFractal || {
        confirmIndex: this.#currentBarIndex,
        confirmTime: this.#currentBarTime,
      };
      const isConfirmation = action === ACTION_CONFIRMED;
      const eventConfirmIndex = isConfirmation ? stroke.confirmRawBarIndex : null;
      const eventConfirmTime = isConfirmation ? stroke.confirmTime : null;
      return core.createStructuralEvent({
        barIndex: eventFractal.confirmIndex,
        barTime: eventFractal.confirmTime,
        structureId: stroke.structureId,
        structureType: STRUCTURE_TYPE,
        eventRawBarIndex: stroke.eventRawBarIndex,
        eventTime: stroke.eventTime,
        availableRawBarIndex: eventFractal.confirmIndex,
        availableTime: eventFractal.confirmTime,
        confirmRawBarIndex: eventConfirmIndex,
        confirmTime: eventConfirmTime,
        eventNormalizedKIndex: stroke.eventNormalizedKIndex,
        availableNormalizedKIndex: stroke.availableNormalizedKIndex,
        confirmNormalizedKIndex: isConfirmation ? stroke.confirmNormalizedKIndex : null,
        eventStrokeIndex: stroke.eventStrokeIndex,
        availableStrokeIndex: stroke.availableStrokeIndex,
        confirmStrokeIndex: isConfirmation ? stroke.confirmStrokeIndex : null,
        eventIndex: stroke.eventRawBarIndex,
        confirmIndex: eventConfirmIndex,
        modeBefore: null,
        modeAfter: stroke.status,
        eventAction: action,
        ruleVersion: this.#ruleConfig.ruleVersion,
        activeMemorySize: this.#activeMemorySize(),
        provenance: {
          fractalIds: [stroke.startFractalId, stroke.endFractalId],
          normalizedKIds: [
            ...(stroke.metadata?.startFractal?.sourceKIds || []),
            ...(stroke.metadata?.endFractal?.sourceKIds || []),
          ],
        },
        metadata: {
          strokeId: stroke.strokeId,
          stroke_id: stroke.strokeId,
          status: stroke.status,
          direction: stroke.direction,
          startFractalId: stroke.startFractalId,
          endFractalId: stroke.endFractalId,
          amplitude: stroke.amplitude,
          duration: stroke.duration,
          slope: stroke.slope,
          minimumStrokeSeparation: this.#minimumStrokeSeparation,
          strokeRuleVersion: STROKE_RULE_VERSION,
          ...metadata,
        },
      });
    }

    #separationSatisfied(start, end) {
      return normalizedDistance(start, end) >= this.#minimumStrokeSeparation;
    }

    #replaceAnchorEndpoint(nextFractal, events) {
      const oldAnchor = this.#anchorFractal;
      if (!oldAnchor || !isMoreExtremeFractal(nextFractal, oldAnchor)) return false;
      const lastStroke = this.#strokes[this.#strokes.length - 1] || null;
      if (lastStroke && lastStroke.endFractalId === oldAnchor.structureId) {
        const start = lastStroke.metadata.startFractal;
        if (this.#separationSatisfied(start, nextFractal)) {
          const replacement = makeStroke(start, nextFractal, STATUS_CONFIRMED,
            this.#ruleConfig.ruleVersion, this.#minimumStrokeSeparation, this.#strokes.length - 1);
          this.#strokes[this.#strokes.length - 1] = replacement;
          this.#anchorFractal = nextFractal;
          const replaced = withSnakeAliases({ ...lastStroke, status: STATUS_REPLACED });
          events.push(this.#event(ACTION_REPLACED, replaced, nextFractal, {
            reason: 'same-type-extreme-replacement',
            replacedBy: replacement.strokeId,
          }));
          return true;
        }
      }
      this.#anchorFractal = nextFractal;
      return true;
    }

    #confirmCandidate(events, currentFractal) {
      if (!this.#candidateStroke) return false;
      const start = this.#candidateStroke.metadata.startFractal;
      const end = this.#candidateStroke.metadata.endFractal;
      if (!this.#separationSatisfied(start, end)) return false;
      const confirmed = makeStroke(start, end, STATUS_CONFIRMED,
        this.#ruleConfig.ruleVersion, this.#minimumStrokeSeparation, this.#strokes.length);
      this.#strokes.push(confirmed);
      this.#anchorFractal = end;
      this.#candidateStroke = null;
      events.push(this.#event(ACTION_CONFIRMED, confirmed, currentFractal, {
        reason: 'alternating-fractal-minimum-separation-confirmed',
      }));
      return true;
    }

    #processFractal(fractal, events) {
      this.#currentBarIndex = fractal.confirmIndex;
      this.#currentBarTime = fractal.confirmTime;
      if (!this.#anchorFractal) {
        this.#anchorFractal = fractal;
        return;
      }

      if (this.#candidateStroke) {
        const candidateEnd = this.#candidateStroke.metadata.endFractal;
        if (fractal.type === candidateEnd.type) {
          if (isMoreExtremeFractal(fractal, candidateEnd)) {
            const oldCandidate = this.#candidateStroke;
            const replacement = makeStroke(this.#anchorFractal, fractal, STATUS_CANDIDATE,
              this.#ruleConfig.ruleVersion, this.#minimumStrokeSeparation, this.#strokes.length);
            this.#candidateStroke = replacement;
            const replaced = withSnakeAliases({ ...oldCandidate, status: STATUS_REPLACED });
            events.push(this.#event(ACTION_REPLACED, replaced, fractal, {
              reason: 'candidate-endpoint-extreme-replacement',
              replacedBy: replacement.strokeId,
            }));
            this.#confirmCandidate(events, fractal);
          }
          return;
        }

        if (fractal.type === this.#anchorFractal.type && isMoreExtremeFractal(fractal, this.#anchorFractal)) {
          const oldCandidate = this.#candidateStroke;
          this.#candidateStroke = null;
          const invalidated = withSnakeAliases({ ...oldCandidate, status: STATUS_INVALIDATED });
          events.push(this.#event(ACTION_INVALIDATED, invalidated, fractal, {
            reason: 'anchor-endpoint-extreme-replacement-before-candidate-confirmation',
          }));
          this.#replaceAnchorEndpoint(fractal, events);
        }
        return;
      }

      if (fractal.type === this.#anchorFractal.type) {
        this.#replaceAnchorEndpoint(fractal, events);
        return;
      }

      this.#candidateStroke = makeStroke(this.#anchorFractal, fractal, STATUS_CANDIDATE,
        this.#ruleConfig.ruleVersion, this.#minimumStrokeSeparation, this.#strokes.length);
      events.push(this.#event(ACTION_CANDIDATE, this.#candidateStroke, fractal, {
        reason: 'opposite-fractal-candidate-endpoint',
      }));
      this.#confirmCandidate(events, fractal);
    }

    #rebuildWithoutEvents(fractals) {
      const savedEvents = this.#events;
      this.#anchorFractal = null;
      this.#candidateStroke = null;
      this.#strokes = [];
      this.#currentBarIndex = -1;
      this.#currentBarTime = null;
      for (const fractal of fractals) this.#processFractal(fractal, []);
      this.#events = savedEvents;
    }

    update(input, options = {}) {
      const fractals = inputToFractals(input);
      const signature = fractalsSignature(fractals);
      if (this.#hasSeenInput && signature === this.#lastInputSignature) {
        const packet = {
          events: [],
          candidateStroke: this.getCandidateStroke(),
          confirmedStrokes: this.getConfirmedStrokes(),
        };
        if (options.includeState) packet.state = this.getState();
        return freeze(packet);
      }
      const hasNoPriorFractal = !this.#hasSeenNonEmptyInput;
      const isColdHistoricalBootstrap = hasNoPriorFractal && fractals.length > 1 && options.allowHistoricalBootstrap === true;
      if (hasNoPriorFractal && fractals.length > 1 && !isColdHistoricalBootstrap) {
        throw new Error('StrokeStateMachine refuses cold historical bootstrap; feed Fractal prefixes incrementally or pass allowHistoricalBootstrap=true for read-only reconstruction.');
      }

      if (isColdHistoricalBootstrap) {
        this.#fractals = fractals;
        this.#rebuildWithoutEvents(fractals);
        this.#lastInputSignature = signature;
        this.#hasSeenInput = true;
        this.#hasSeenNonEmptyInput = fractals.length > 0;
        const packet = {
          events: [],
          candidateStroke: this.getCandidateStroke(),
          confirmedStrokes: this.getConfirmedStrokes(),
          bootstrapped: true,
        };
        if (options.includeState) packet.state = this.getState();
        return freeze(packet);
      }

      const events = [];
      if (!this.#hasSeenInput || sameFractalPrefix(this.#fractals, fractals)) {
        const start = this.#hasSeenInput ? this.#fractals.length : 0;
        for (let index = start; index < fractals.length; index += 1) {
          this.#processFractal(fractals[index], events);
        }
      } else {
        const oldStrokes = this.#strokes;
        const oldCandidate = this.#candidateStroke;
        this.#fractals = fractals;
        this.#rebuildWithoutEvents(fractals);
        const nextIds = new Set(this.#strokes.map(stroke => stroke.strokeId));
        for (const stroke of oldStrokes) {
          if (!nextIds.has(stroke.strokeId)) {
            const invalidated = withSnakeAliases({ ...stroke, status: STATUS_INVALIDATED });
            events.push(this.#event(ACTION_INVALIDATED, invalidated, fractals[fractals.length - 1] || null, {
              reason: 'fractal-upstream-rewrite',
            }));
          }
        }
        if (oldCandidate && (!this.#candidateStroke || oldCandidate.strokeId !== this.#candidateStroke.strokeId)) {
          const invalidated = withSnakeAliases({ ...oldCandidate, status: STATUS_INVALIDATED });
          events.push(this.#event(ACTION_INVALIDATED, invalidated, fractals[fractals.length - 1] || null, {
            reason: 'fractal-upstream-rewrite-candidate',
          }));
        }
      }

      this.#fractals = fractals;
      this.#lastInputSignature = signature;
      this.#hasSeenInput = true;
      if (fractals.length > 0) this.#hasSeenNonEmptyInput = true;
      this.#events.push(...events);
      const packet = {
        events: clone(events),
        candidateStroke: this.getCandidateStroke(),
        confirmedStrokes: this.getConfirmedStrokes(),
      };
      if (options.includeState) packet.state = this.getState();
      return freeze(packet);
    }

    getState() {
      const candidateStructure = this.#candidateStroke ? [strokeToStructuralState(this.#candidateStroke)] : [];
      const strokeStructures = this.#strokes.map(strokeToStructuralState);
      const layer = core.createBaseCTState({
        structureType: STRUCTURE_TYPE,
        mode: this.#candidateStroke ? STATUS_CANDIDATE : (this.#strokes.length ? STATUS_CONFIRMED : core.CT_STATUSES?.none || 'NONE'),
        continuousState: {
          inputFractalCount: this.#fractals.length,
          confirmedStrokeCount: this.#strokes.length,
          hasCandidateEndpoint: !!this.#candidateStroke,
          anchorFractalId: this.#anchorFractal?.structureId || null,
          currentBarIndex: this.#currentBarIndex,
          currentBarTime: this.#currentBarTime,
        },
        activeMemory: {
          recentFractals: this.#fractals.slice(-6),
          anchorFractal: this.#anchorFractal,
          candidateStroke: this.#candidateStroke,
          confirmedStrokeIds: this.#strokes.map(stroke => stroke.strokeId),
        },
        structures: [...strokeStructures, ...candidateStructure],
        // Upstream Normalized K / Fractal layers may rewrite the mutable tail.
        // The append-only event log is still exposed via getEvents(), but the
        // logical parser state should hash by current endpoints, not by the
        // incidental path that reached them.
        lastEventId: this.#logicalLastEventId(),
        metadata: {
          ruleVersion: this.#ruleConfig.ruleVersion,
          strokeRuleVersion: STROKE_RULE_VERSION,
          minimumStrokeSeparation: this.#minimumStrokeSeparation,
          strokeEndpointRule: this.#ruleConfig.strokeEndpointRule,
          sourceLayer: 'fractalState',
          note: 'Phase 4 derives strokes from confirmed Fractal endpoints only; segment/pivot rules remain TODO.',
        },
      });
      return core.attachStateHash(core.createCTState({
        currentBarIndex: this.#currentBarIndex,
        currentBarTime: this.#currentBarTime,
        ruleVersion: this.#ruleConfig.ruleVersion,
        activeMemorySize: this.#activeMemorySize(),
        strokeState: layer,
        parserMetadata: {
          parser: 'StrokeStateMachine',
          phase: 'CT-Phase4',
          upstream: 'FractalStateMachine',
        },
      }));
    }
  }

  function parseStrokesBatch(fractals, ruleConfig = {}) {
    const machine = new StrokeStateMachine(ruleConfig);
    const inputFractals = inputToFractals(fractals);
    for (let index = 0; index < inputFractals.length; index += 1) {
      machine.update(inputFractals.slice(0, index + 1));
    }
    return freeze({
      state: machine.getState(),
      confirmedStrokes: machine.getConfirmedStrokes(),
      candidateStroke: machine.getCandidateStroke(),
      events: machine.getEvents(),
    });
  }

  Object.assign(core, {
    STROKE_RULE_VERSION,
    CT_STROKE_CONTINUATION_VERSION: CONTINUATION_VERSION,
    StrokeStateMachine,
    parseStrokesBatch,
    strokeToStructuralState,
    strokeToCompactRow,
    isMoreExtremeFractal,
  });
})();
