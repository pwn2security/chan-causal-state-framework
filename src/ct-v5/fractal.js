(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const STRUCTURE_TYPE = core.CT_STRUCTURE_TYPES?.fractal || 'fractal';
  const STATUS_CANDIDATE = core.CT_STATUSES?.candidate || 'CANDIDATE';
  const STATUS_CONFIRMED = core.CT_STATUSES?.confirmed || 'CONFIRMED';
  const STATUS_INVALIDATED = core.CT_STATUSES?.invalidated || 'INVALIDATED';
  const ACTION_CANDIDATE = core.CT_EVENT_ACTIONS?.candidate || 'CANDIDATE';
  const ACTION_CONFIRMED = core.CT_EVENT_ACTIONS?.confirmed || 'CONFIRMED';
  const ACTION_INVALIDATED = core.CT_EVENT_ACTIONS?.invalidated || 'INVALIDATED';
  const DIR_UP = core.CT_DIRECTIONS?.up || 'UP';
  const DIR_DOWN = core.CT_DIRECTIONS?.down || 'DOWN';

  const CT_FRACTAL_TYPES = Object.freeze({
    top: 'TOP',
    bottom: 'BOTTOM',
  });

  const FRACTAL_RULE_VERSION = 'three-normalized-k-v1';
  const CONTINUATION_VERSION = 'CT-Fractal-Continuation-v1.0';

  function requireDependencies() {
    for (const name of ['createCTRuleConfig', 'createStructuralState',
      'createStructuralEvent', 'createBaseCTState', 'createCTState', 'attachStateHash']) {
      if (typeof core[name] !== 'function') throw new Error(`CT fractal requires MarketCore.${name}`);
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
    if (!Number.isFinite(number)) throw new Error(`FractalStateMachine ${field} must be finite`);
    return number;
  }

  function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function integerNumber(value, field) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      throw new Error(`FractalStateMachine ${field} must be a non-negative integer`);
    }
    return number;
  }

  function toleranceFromConfig(config) {
    return Math.max(0, Number(config?.priceTolerance ?? config?.numericTolerance ?? 0) || 0);
  }

  function gt(a, b, tolerance) {
    return Number(a) > Number(b) + tolerance;
  }

  function lt(a, b, tolerance) {
    return Number(a) < Number(b) - tolerance;
  }

  function normalizeKRecord(input, ordinal) {
    if (!input || typeof input !== 'object') {
      throw new Error(`FractalStateMachine normalizedBars[${ordinal}] is required`);
    }
    const normalizedIndex = Number(input.normalizedIndex ?? input.barIndex ?? ordinal);
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) {
      throw new Error(`FractalStateMachine normalizedBars[${ordinal}].normalizedIndex must be a non-negative integer`);
    }
    const sourceStartIndex = integerNumber(input.sourceStartIndex ?? input.startIndex ?? input.barIndex ?? normalizedIndex,
      `normalizedBars[${ordinal}].sourceStartIndex`);
    const sourceEndIndex = integerNumber(input.sourceEndIndex ?? input.endIndex ?? input.barIndex ?? normalizedIndex,
      `normalizedBars[${ordinal}].sourceEndIndex`);
    if (sourceEndIndex < sourceStartIndex) {
      throw new Error(`FractalStateMachine normalizedBars[${ordinal}] sourceEndIndex must be >= sourceStartIndex`);
    }
    const startTime = finiteNumber(input.startTime ?? input.sourceStartTime ?? input.barTime, `normalizedBars[${ordinal}].startTime`);
    const endTime = finiteNumber(input.endTime ?? input.sourceEndTime ?? input.barTime ?? startTime, `normalizedBars[${ordinal}].endTime`);
    if (endTime < startTime) {
      throw new Error(`FractalStateMachine normalizedBars[${ordinal}] endTime must be >= startTime`);
    }
    const high = finiteNumber(input.high, `normalizedBars[${ordinal}].high`);
    const low = finiteNumber(input.low, `normalizedBars[${ordinal}].low`);
    if (high < low) {
      throw new Error(`FractalStateMachine normalizedBars[${ordinal}] high must be >= low`);
    }
    return freeze({
      ...clone(input),
      structureId: String(input.structureId || `${input.ruleVersion || 'CT-R1.0'}:normalizedK:${sourceStartIndex}:${sourceEndIndex}`),
      normalizedIndex,
      barIndex: normalizedIndex,
      sourceStartIndex,
      sourceEndIndex,
      startIndex: sourceStartIndex,
      endIndex: sourceEndIndex,
      sourceStartTime: finiteOrNull(input.sourceStartTime) ?? startTime,
      sourceEndTime: finiteOrNull(input.sourceEndTime) ?? endTime,
      startTime,
      endTime,
      barTime: finiteOrNull(input.barTime) ?? endTime,
      high,
      low,
      open: finiteOrNull(input.open),
      close: finiteOrNull(input.close),
    });
  }

  function inputToBars(input) {
    const source = Array.isArray(input) ? input : (input?.normalizedBars || input?.bars || []);
    if (!Array.isArray(source)) throw new Error('FractalStateMachine.update expects normalizedBars array or a NormalizedK packet');
    const bars = source.map(normalizeKRecord);
    for (let index = 1; index < bars.length; index += 1) {
      const previous = bars[index - 1];
      const current = bars[index];
      if (current.normalizedIndex <= previous.normalizedIndex) {
        throw new Error('FractalStateMachine normalizedIndex must be strictly increasing');
      }
      if (current.sourceStartIndex <= previous.sourceEndIndex) {
        throw new Error('FractalStateMachine normalized K source ranges must be ordered and non-overlapping');
      }
      if (current.endTime < previous.endTime) {
        throw new Error('FractalStateMachine normalized K endTime must be non-decreasing');
      }
    }
    return bars;
  }

  function barSignature(bar) {
    return [
      bar.structureId,
      bar.normalizedIndex,
      bar.sourceStartIndex,
      bar.sourceEndIndex,
      bar.startTime,
      bar.endTime,
      bar.high,
      bar.low,
    ].join(':');
  }

  function barsSignature(bars) {
    return bars.map(barSignature).join('|');
  }

  function isTopFractal(left, middle, right, tolerance = 0) {
    return gt(middle.high, left.high, tolerance) &&
      gt(middle.high, right.high, tolerance) &&
      gt(middle.low, left.low, tolerance) &&
      gt(middle.low, right.low, tolerance);
  }

  function isBottomFractal(left, middle, right, tolerance = 0) {
    return lt(middle.low, left.low, tolerance) &&
      lt(middle.low, right.low, tolerance) &&
      lt(middle.high, left.high, tolerance) &&
      lt(middle.high, right.high, tolerance);
  }

  function candidateType(left, middle, tolerance = 0) {
    const top = gt(middle.high, left.high, tolerance) && gt(middle.low, left.low, tolerance);
    const bottom = lt(middle.low, left.low, tolerance) && lt(middle.high, left.high, tolerance);
    if (top && !bottom) return CT_FRACTAL_TYPES.top;
    if (bottom && !top) return CT_FRACTAL_TYPES.bottom;
    if (!top && !bottom) return null;
    const upMagnitude = Math.abs(Number(middle.high) - Number(left.high)) + Math.abs(Number(middle.low) - Number(left.low));
    const downMagnitude = Math.abs(Number(left.high) - Number(middle.high)) + Math.abs(Number(left.low) - Number(middle.low));
    return upMagnitude >= downMagnitude ? CT_FRACTAL_TYPES.top : CT_FRACTAL_TYPES.bottom;
  }

  function fractalPrice(type, middle) {
    return type === CT_FRACTAL_TYPES.top ? Number(middle.high) : Number(middle.low);
  }

  function confirmedFractalId(ruleVersion, type, middle, right, sourceKIds) {
    return `${ruleVersion}:fractal:${FRACTAL_RULE_VERSION}:${type}:${middle.sourceEndIndex}:${right.sourceEndIndex}:${sourceKIds.join('>')}`;
  }

  function candidateFractalId(ruleVersion, type, left, middle) {
    return `${ruleVersion}:fractal:${FRACTAL_RULE_VERSION}:candidate:${type}:${middle.sourceEndIndex}:${left.structureId}>${middle.structureId}`;
  }

  function withSnakeAliases(fractal) {
    return freeze({
      ...fractal,
      event_index: fractal.eventIndex,
      event_time: fractal.eventTime,
      confirm_index: fractal.confirmIndex,
      confirm_time: fractal.confirmTime,
      source_k_ids: clone(fractal.sourceKIds),
    });
  }

  function makeFractal({ ruleVersion, type, status, left, middle, right = null, currentBar = null }) {
    const sourceKIds = right
      ? [left.structureId, middle.structureId, right.structureId]
      : [left.structureId, middle.structureId];
    const confirmIndex = right ? right.sourceEndIndex : null;
    const confirmTime = right ? right.endTime : null;
    const availableElement = right || middle;
    const structureId = right
      ? confirmedFractalId(ruleVersion, type, middle, right, sourceKIds)
      : candidateFractalId(ruleVersion, type, left, middle);
    return withSnakeAliases({
      structureId,
      structureType: STRUCTURE_TYPE,
      type,
      status,
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      eventRawBarIndex: middle.sourceEndIndex,
      eventIndex: middle.sourceEndIndex,
      eventTime: middle.endTime,
      availableRawBarIndex: availableElement.sourceEndIndex,
      availableTime: availableElement.endTime,
      eventNormalizedKIndex: middle.normalizedIndex,
      availableNormalizedKIndex: availableElement.normalizedIndex,
      confirmRawBarIndex: confirmIndex,
      confirmIndex,
      confirmTime,
      confirmNormalizedKIndex: right?.normalizedIndex ?? null,
      price: fractalPrice(type, middle),
      sourceKIds,
      leftKId: left.structureId,
      middleKId: middle.structureId,
      rightKId: right?.structureId || null,
      startIndex: left.sourceStartIndex,
      endIndex: (right || middle).sourceEndIndex,
      startTime: left.startTime,
      endTime: (right || middle).endTime,
      currentBarIndex: currentBar?.sourceEndIndex ?? (right || middle).sourceEndIndex,
      currentBarTime: currentBar?.endTime ?? (right || middle).endTime,
      ruleVersion,
      metadata: {
        fractalRuleVersion: FRACTAL_RULE_VERSION,
        normalizedWindow: [left.normalizedIndex, middle.normalizedIndex, right?.normalizedIndex ?? null],
        sourceRange: {
          left: [left.sourceStartIndex, left.sourceEndIndex],
          middle: [middle.sourceStartIndex, middle.sourceEndIndex],
          right: right ? [right.sourceStartIndex, right.sourceEndIndex] : null,
        },
      },
    });
  }

  function detectConfirmedFractals(bars, ruleVersion, tolerance = 0) {
    const confirmed = [];
    for (let index = 1; index < bars.length - 1; index += 1) {
      const left = bars[index - 1];
      const middle = bars[index];
      const right = bars[index + 1];
      if (isTopFractal(left, middle, right, tolerance)) {
        confirmed.push(makeFractal({
          ruleVersion,
          type: CT_FRACTAL_TYPES.top,
          status: STATUS_CONFIRMED,
          left,
          middle,
          right,
          currentBar: bars[bars.length - 1],
        }));
      } else if (isBottomFractal(left, middle, right, tolerance)) {
        confirmed.push(makeFractal({
          ruleVersion,
          type: CT_FRACTAL_TYPES.bottom,
          status: STATUS_CONFIRMED,
          left,
          middle,
          right,
          currentBar: bars[bars.length - 1],
        }));
      }
    }
    return confirmed;
  }

  function detectCandidateFractal(bars, ruleVersion, tolerance = 0) {
    if (bars.length < 2) return null;
    const left = bars[bars.length - 2];
    const middle = bars[bars.length - 1];
    const type = candidateType(left, middle, tolerance);
    if (!type) return null;
    return makeFractal({
      ruleVersion,
      type,
      status: STATUS_CANDIDATE,
      left,
      middle,
      right: null,
      currentBar: middle,
    });
  }

  function fractalToStructuralState(fractal) {
    const direction = fractal.type === CT_FRACTAL_TYPES.top ? DIR_DOWN : DIR_UP;
    return core.createStructuralState({
      structureId: fractal.structureId,
      structureType: STRUCTURE_TYPE,
      status: fractal.status,
      eventRawBarIndex: fractal.eventRawBarIndex,
      eventTime: fractal.eventTime,
      availableRawBarIndex: fractal.availableRawBarIndex,
      availableTime: fractal.availableTime,
      confirmRawBarIndex: fractal.confirmRawBarIndex,
      confirmTime: fractal.confirmTime,
      eventNormalizedKIndex: fractal.eventNormalizedKIndex,
      availableNormalizedKIndex: fractal.availableNormalizedKIndex,
      confirmNormalizedKIndex: fractal.confirmNormalizedKIndex,
      eventIndex: fractal.eventRawBarIndex,
      confirmIndex: fractal.confirmRawBarIndex,
      startIndex: fractal.startIndex,
      endIndex: fractal.endIndex,
      startTime: fractal.startTime,
      endTime: fractal.endTime,
      direction,
      priceLow: fractal.price,
      priceHigh: fractal.price,
      ruleVersion: fractal.ruleVersion,
      metadata: {
        type: fractal.type,
        price: fractal.price,
        sourceKIds: clone(fractal.sourceKIds),
        source_k_ids: clone(fractal.sourceKIds),
        fractalRuleVersion: fractal.metadata?.fractalRuleVersion || FRACTAL_RULE_VERSION,
        normalizedWindow: clone(fractal.metadata?.normalizedWindow || []),
        sourceRange: clone(fractal.metadata?.sourceRange || {}),
      },
    });
  }

  function fractalToCompactRow(fractal) {
    return [
      fractal.type,
      fractal.status,
      fractal.eventIndex,
      fractal.eventTime,
      fractal.confirmIndex,
      fractal.confirmTime,
      fractal.price,
      fractal.sourceKIds.join('>'),
    ];
  }

  function idsOf(fractals) {
    return new Set((fractals || []).map(fractal => fractal.structureId));
  }

  function mapById(fractals) {
    const result = new Map();
    for (const fractal of fractals || []) result.set(fractal.structureId, fractal);
    return result;
  }

  class FractalStateMachine {
    #ruleConfig;
    #bars = [];
    #confirmed = [];
    #confirmedById = new Map();
    #candidate = null;
    #events = [];
    #currentBarIndex = -1;
    #currentBarTime = null;
    #lastInputSignature = '';
    #hasSeenInput = false;

    constructor(ruleConfig = {}) {
      requireDependencies();
      this.#ruleConfig = core.createCTRuleConfig(ruleConfig.ruleConfig || ruleConfig);
      this.reset();
    }

    reset() {
      this.#bars = [];
      this.#confirmed = [];
      this.#confirmedById = new Map();
      this.#candidate = null;
      this.#events = [];
      this.#currentBarIndex = -1;
      this.#currentBarTime = null;
      this.#lastInputSignature = '';
      this.#hasSeenInput = false;
      return this;
    }

    getRuleConfig() { return clone(this.#ruleConfig); }
    getNormalizedWindow() { return clone(this.#bars.slice(-4)); }
    getConfirmedFractals() { return clone(this.#confirmed); }
    getCandidate() { return clone(this.#candidate); }
    getEvents() { return clone(this.#events); }

    serializeContinuationState() {
      return freeze({
        continuationVersion: CONTINUATION_VERSION,
        ruleVersion: this.#ruleConfig.ruleVersion,
        fractalRuleVersion: FRACTAL_RULE_VERSION,
        structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        normalizedBars: clone(this.#bars),
      });
    }

    restoreContinuationState(snapshot) {
      if (!snapshot || snapshot.continuationVersion !== CONTINUATION_VERSION) {
        throw new Error('INCOMPATIBLE_FRACTAL_CONTINUATION');
      }
      if (snapshot.ruleVersion !== this.#ruleConfig.ruleVersion ||
          snapshot.fractalRuleVersion !== FRACTAL_RULE_VERSION) {
        throw new Error('FRACTAL_CONTINUATION_RULE_VERSION_MISMATCH');
      }
      this.reset();
      const bars = Array.isArray(snapshot.normalizedBars) ? snapshot.normalizedBars : [];
      if (bars.length) this.update(bars, { allowHistoricalBootstrap: true });
      return this;
    }

    #activeMemorySize() {
      return core.estimateActiveMemorySize({
        recentNormalizedWindow: this.#bars.slice(-4),
        candidate: this.#candidate,
        confirmedIds: this.#confirmed.map(fractal => fractal.structureId),
      });
    }

    #event(action, fractal, currentBar, metadata = {}) {
      const eventBar = currentBar || this.#bars[this.#bars.length - 1] || {
        sourceEndIndex: this.#currentBarIndex,
        endTime: this.#currentBarTime,
      };
      const isConfirmation = action === ACTION_CONFIRMED;
      return core.createStructuralEvent({
        barIndex: eventBar.sourceEndIndex,
        barTime: eventBar.endTime,
        structureId: fractal.structureId,
        structureType: STRUCTURE_TYPE,
        eventRawBarIndex: fractal.eventRawBarIndex,
        eventTime: fractal.eventTime,
        availableRawBarIndex: eventBar.sourceEndIndex,
        availableTime: eventBar.endTime,
        confirmRawBarIndex: isConfirmation ? fractal.confirmRawBarIndex : null,
        confirmTime: isConfirmation ? fractal.confirmTime : null,
        eventNormalizedKIndex: fractal.eventNormalizedKIndex,
        availableNormalizedKIndex: eventBar.normalizedIndex,
        confirmNormalizedKIndex: isConfirmation ? fractal.confirmNormalizedKIndex : null,
        eventIndex: fractal.eventRawBarIndex,
        confirmIndex: isConfirmation ? fractal.confirmRawBarIndex : null,
        modeBefore: null,
        modeAfter: fractal.status,
        eventAction: action,
        ruleVersion: this.#ruleConfig.ruleVersion,
        activeMemorySize: this.#activeMemorySize(),
        provenance: {
          normalizedKIds: clone(fractal.sourceKIds),
          eventNormalizedKIndex: fractal.eventNormalizedKIndex,
        },
        metadata: {
          type: fractal.type,
          status: fractal.status,
          price: fractal.price,
          sourceKIds: clone(fractal.sourceKIds),
          source_k_ids: clone(fractal.sourceKIds),
          fractalRuleVersion: FRACTAL_RULE_VERSION,
          ...metadata,
        },
      });
    }

    update(input, options = {}) {
      const bars = inputToBars(input);
      const signature = barsSignature(bars);
      if (this.#hasSeenInput && signature === this.#lastInputSignature) {
        const packet = {
          events: [],
          candidate: this.getCandidate(),
          confirmedFractals: this.getConfirmedFractals(),
        };
        if (options.includeState) packet.state = this.getState();
        return freeze(packet);
      }
      const isColdHistoricalBootstrap = !this.#hasSeenInput && bars.length > 1 && options.allowHistoricalBootstrap === true;
      if (!this.#hasSeenInput && bars.length > 1 && !isColdHistoricalBootstrap) {
        throw new Error('FractalStateMachine refuses cold historical bootstrap; feed Normalized K prefixes incrementally or pass allowHistoricalBootstrap=true for read-only reconstruction.');
      }

      const tolerance = toleranceFromConfig(this.#ruleConfig);
      const previousConfirmed = this.#confirmedById;
      const previousConfirmedIds = idsOf(this.#confirmed);
      const previousCandidate = this.#candidate;
      const nextConfirmed = detectConfirmedFractals(bars, this.#ruleConfig.ruleVersion, tolerance);
      const nextConfirmedById = mapById(nextConfirmed);
      const nextConfirmedIds = idsOf(nextConfirmed);
      const nextCandidate = detectCandidateFractal(bars, this.#ruleConfig.ruleVersion, tolerance);
      const currentBar = bars[bars.length - 1] || null;
      const events = [];

      if (isColdHistoricalBootstrap) {
        this.#bars = bars;
        this.#confirmed = nextConfirmed;
        this.#confirmedById = nextConfirmedById;
        this.#candidate = nextCandidate;
        this.#currentBarIndex = currentBar?.sourceEndIndex ?? -1;
        this.#currentBarTime = currentBar?.endTime ?? null;
        this.#lastInputSignature = signature;
        this.#hasSeenInput = true;
        const packet = {
          events: [],
          candidate: this.getCandidate(),
          confirmedFractals: this.getConfirmedFractals(),
          bootstrapped: true,
        };
        if (options.includeState) packet.state = this.getState();
        return freeze(packet);
      }

      for (const [structureId, oldFractal] of previousConfirmed.entries()) {
        if (!nextConfirmedIds.has(structureId)) {
          const invalidated = withSnakeAliases({
            ...oldFractal,
            status: STATUS_INVALIDATED,
            currentBarIndex: currentBar?.sourceEndIndex ?? oldFractal.currentBarIndex,
            currentBarTime: currentBar?.endTime ?? oldFractal.currentBarTime,
          });
          events.push(this.#event(ACTION_INVALIDATED, invalidated, currentBar, {
            reason: 'normalized-k-upstream-rewrite',
          }));
        }
      }

      const candidateBecameConfirmed = previousCandidate &&
        nextConfirmed.some(fractal =>
          fractal.type === previousCandidate.type &&
          fractal.eventIndex === previousCandidate.eventIndex &&
          fractal.leftKId === previousCandidate.leftKId &&
          fractal.middleKId === previousCandidate.middleKId);

      if (previousCandidate &&
          (!nextCandidate || previousCandidate.structureId !== nextCandidate.structureId) &&
          !candidateBecameConfirmed) {
        const invalidated = withSnakeAliases({
          ...previousCandidate,
          status: STATUS_INVALIDATED,
          currentBarIndex: currentBar?.sourceEndIndex ?? previousCandidate.currentBarIndex,
          currentBarTime: currentBar?.endTime ?? previousCandidate.currentBarTime,
        });
        events.push(this.#event(ACTION_INVALIDATED, invalidated, currentBar, {
          reason: 'candidate-not-confirmed-by-next-normalized-k',
        }));
      }

      for (const fractal of nextConfirmed) {
        if (!previousConfirmedIds.has(fractal.structureId)) {
          events.push(this.#event(ACTION_CONFIRMED, fractal, currentBar, {
            reason: 'three-normalized-k-window-confirmed',
          }));
        }
      }

      if (nextCandidate && (!previousCandidate || previousCandidate.structureId !== nextCandidate.structureId)) {
        events.push(this.#event(ACTION_CANDIDATE, nextCandidate, currentBar, {
          reason: 'two-normalized-k-potential-turning-point',
        }));
      }

      this.#bars = bars;
      this.#confirmed = nextConfirmed;
      this.#confirmedById = nextConfirmedById;
      this.#candidate = nextCandidate;
      this.#currentBarIndex = currentBar?.sourceEndIndex ?? -1;
      this.#currentBarTime = currentBar?.endTime ?? null;
      this.#lastInputSignature = signature;
      this.#hasSeenInput = true;
      this.#events.push(...events);

      const packet = {
        events: clone(events),
        candidate: this.getCandidate(),
        confirmedFractals: this.getConfirmedFractals(),
      };
      if (options.includeState) packet.state = this.getState();
      return freeze(packet);
    }

    getState() {
      const candidateStructure = this.#candidate ? [fractalToStructuralState(this.#candidate)] : [];
      const confirmedStructures = this.#confirmed.map(fractalToStructuralState);
      const layer = core.createBaseCTState({
        structureType: STRUCTURE_TYPE,
        mode: this.#candidate ? STATUS_CANDIDATE : (this.#confirmed.length ? STATUS_CONFIRMED : core.CT_STATUSES?.none || 'NONE'),
        continuousState: {
          normalizedCount: this.#bars.length,
          confirmedCount: this.#confirmed.length,
          candidateType: this.#candidate?.type || null,
          currentBarIndex: this.#currentBarIndex,
          currentBarTime: this.#currentBarTime,
        },
        activeMemory: {
          recentNormalizedWindow: this.#bars.slice(-4),
          candidate: this.#candidate,
          confirmedIds: this.#confirmed.map(fractal => fractal.structureId),
        },
        structures: [...confirmedStructures, ...candidateStructure],
        lastEventId: this.#events[this.#events.length - 1]?.eventId || null,
        metadata: {
          ruleVersion: this.#ruleConfig.ruleVersion,
          fractalRuleVersion: FRACTAL_RULE_VERSION,
          sourceLayer: 'normalizedKState',
          note: 'Phase 3 derives candidate/confirmed fractals only from the current as-of Normalized K state.',
        },
      });
      return core.attachStateHash(core.createCTState({
        currentBarIndex: this.#currentBarIndex,
        currentBarTime: this.#currentBarTime,
        ruleVersion: this.#ruleConfig.ruleVersion,
        activeMemorySize: this.#activeMemorySize(),
        fractalState: layer,
        parserMetadata: {
          parser: 'FractalStateMachine',
          phase: 'CT-Phase3',
          upstream: 'NormalizedKStateMachine',
        },
      }));
    }
  }

  function parseFractalsBatch(normalizedBars, ruleConfig = {}) {
    const machine = new FractalStateMachine(ruleConfig);
    const bars = inputToBars(normalizedBars);
    for (let index = 0; index < bars.length; index += 1) {
      machine.update(bars.slice(0, index + 1));
    }
    return freeze({
      state: machine.getState(),
      confirmedFractals: machine.getConfirmedFractals(),
      candidate: machine.getCandidate(),
      events: machine.getEvents(),
    });
  }

  Object.assign(core, {
    CT_FRACTAL_TYPES,
    FRACTAL_RULE_VERSION,
    CT_FRACTAL_CONTINUATION_VERSION: CONTINUATION_VERSION,
    FractalStateMachine,
    parseFractalsBatch,
    detectConfirmedFractals,
    detectCandidateFractal,
    fractalToStructuralState,
    fractalToCompactRow,
    isTopFractal,
    isBottomFractal,
  });
})();
