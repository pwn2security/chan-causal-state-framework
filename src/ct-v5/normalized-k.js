(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const STRUCTURE_TYPE = core.CT_STRUCTURE_TYPES?.normalizedK || 'normalizedK';
  const STATUS_CONFIRMED = core.CT_STATUSES?.confirmed || 'CONFIRMED';
  const ACTION_CREATED = core.CT_EVENT_ACTIONS?.created || 'CREATED';
  const ACTION_EXTENDED = core.CT_EVENT_ACTIONS?.extended || 'EXTENDED';
  const ACTION_REPLACED = core.CT_EVENT_ACTIONS?.replaced || 'REPLACED';
  const DIR_UP = core.CT_DIRECTIONS?.up || 'UP';
  const DIR_DOWN = core.CT_DIRECTIONS?.down || 'DOWN';
  const DIR_NONE = core.CT_DIRECTIONS?.none || 'NONE';
  const CONTINUATION_VERSION = 'CT-NormalizedK-Continuation-v1.0';

  function requireDependencies() {
    for (const name of ['createCTRuleConfig', 'createCTBar', 'createStructuralState',
      'createStructuralEvent', 'createBaseCTState', 'createCTState', 'attachStateHash']) {
      if (typeof core[name] !== 'function') throw new Error(`CT normalized-k requires MarketCore.${name}`);
    }
  }

  function clone(value) {
    return core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  }

  function freeze(value) {
    return core.deepFreeze ? core.deepFreeze(value) : Object.freeze(value);
  }

  function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function inclusionTolerance(config) {
    return Math.max(0, Number(config?.priceTolerance ?? config?.numericTolerance ?? 0) || 0);
  }

  function isIncluded(a, b, tolerance = 0) {
    return (
      b.high <= a.high + tolerance && b.low >= a.low - tolerance
    ) || (
      b.high >= a.high - tolerance && b.low <= a.low + tolerance
    );
  }

  function inclusionDirection(activeBars, tolerance = 0) {
    if (activeBars.length < 2) return DIR_UP;
    const last = activeBars[activeBars.length - 1];
    const previous = activeBars[activeBars.length - 2];
    // This intentionally pins the current WorkBuddy inclusion context:
    // last.high > previous.high means upward; equality falls to downward.
    return last.high > previous.high + tolerance ? DIR_UP : DIR_DOWN;
  }

  function activeDirection(activeBars, tolerance = 0) {
    if (!activeBars.length) return DIR_NONE;
    if (activeBars.length === 1) return DIR_UP;
    return inclusionDirection(activeBars, tolerance);
  }

  function normalizedId(ruleVersion, sourceStartIndex, sourceEndIndex) {
    return `${ruleVersion}:normalizedK:${sourceStartIndex}:${sourceEndIndex}`;
  }

  function rawBarToNormalized(rawBar, ruleVersion) {
    const bar = core.createCTBar(rawBar);
    return freeze({
      structureId: normalizedId(ruleVersion, bar.barIndex, bar.barIndex),
      structureType: STRUCTURE_TYPE,
      status: STATUS_CONFIRMED,
      normalizedIndex: -1,
      barIndex: -1,
      startIndex: bar.barIndex,
      endIndex: bar.barIndex,
      startTime: bar.startTime,
      endTime: bar.endTime,
      barTime: bar.barTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      tickCount: bar.tickCount,
      volume: bar.volume,
      synthetic: bar.synthetic,
      closed: bar.closed,
      sourceStartIndex: bar.barIndex,
      sourceEndIndex: bar.barIndex,
      sourceStartTime: bar.startTime,
      sourceEndTime: bar.endTime,
      direction: DIR_NONE,
      ruleVersion,
      metadata: freeze({
        source: bar.source,
        inputSourceStartIndex: bar.sourceStartIndex,
        inputSourceEndIndex: bar.sourceEndIndex,
      }),
    });
  }

  function withNormalizedIndex(record, index, direction, ruleVersion) {
    const sourceStartIndex = Number(record.sourceStartIndex);
    const sourceEndIndex = Number(record.sourceEndIndex);
    if (!Number.isInteger(sourceStartIndex) || sourceStartIndex < 0 ||
        !Number.isInteger(sourceEndIndex) || sourceEndIndex < sourceStartIndex ||
        !Number.isInteger(index) || index < 0) {
      throw new Error('NormalizedK structural indices must be non-negative integers in their declared spaces');
    }
    return freeze({
      ...record,
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structureId: normalizedId(ruleVersion, sourceStartIndex, sourceEndIndex),
      normalizedIndex: index,
      barIndex: index,
      startIndex: sourceStartIndex,
      endIndex: sourceEndIndex,
      eventRawBarIndex: sourceEndIndex,
      availableRawBarIndex: sourceEndIndex,
      confirmRawBarIndex: sourceEndIndex,
      eventNormalizedKIndex: index,
      availableNormalizedKIndex: index,
      confirmNormalizedKIndex: index,
      eventTime: record.endTime,
      availableTime: record.endTime,
      confirmTime: record.endTime,
      direction: direction || record.direction || DIR_NONE,
      status: STATUS_CONFIRMED,
      ruleVersion,
    });
  }

  function mergeNormalizedBars(left, right, direction, ruleVersion) {
    const upward = direction === DIR_UP;
    return freeze({
      structureId: normalizedId(ruleVersion, left.sourceStartIndex, right.sourceEndIndex),
      structureType: STRUCTURE_TYPE,
      status: STATUS_CONFIRMED,
      normalizedIndex: -1,
      barIndex: -1,
      startIndex: left.sourceStartIndex,
      endIndex: right.sourceEndIndex,
      startTime: left.startTime,
      endTime: right.endTime,
      barTime: right.barTime,
      open: left.open,
      // Chan inclusion uses structural high/low.  Open/close are preserved as
      // first/last raw prices and may sit outside this transformed interval.
      high: upward ? Math.max(left.high, right.high) : Math.min(left.high, right.high),
      low: upward ? Math.max(left.low, right.low) : Math.min(left.low, right.low),
      close: right.close,
      tickCount: Number(left.tickCount || 0) + Number(right.tickCount || 0),
      volume: Number(left.volume || 0) + Number(right.volume || 0),
      synthetic: !!left.synthetic && !!right.synthetic,
      closed: left.closed !== false && right.closed !== false,
      sourceStartIndex: left.sourceStartIndex,
      sourceEndIndex: right.sourceEndIndex,
      sourceStartTime: left.sourceStartTime,
      sourceEndTime: right.sourceEndTime,
      direction,
      ruleVersion,
      metadata: freeze({
        inclusionRule: 'streaming-propagating-inclusion',
        mergedFrom: [left.structureId, right.structureId],
      }),
    });
  }

  function normalizedKToStructuralState(record) {
    return core.createStructuralState({
      structureId: record.structureId,
      structureType: STRUCTURE_TYPE,
      status: record.status || STATUS_CONFIRMED,
      eventRawBarIndex: record.sourceEndIndex,
      eventTime: record.endTime,
      availableRawBarIndex: record.sourceEndIndex,
      availableTime: record.endTime,
      confirmRawBarIndex: record.sourceEndIndex,
      confirmTime: record.endTime,
      eventNormalizedKIndex: record.normalizedIndex,
      availableNormalizedKIndex: record.normalizedIndex,
      confirmNormalizedKIndex: record.normalizedIndex,
      eventIndex: record.sourceEndIndex,
      confirmIndex: record.sourceEndIndex,
      startIndex: record.sourceStartIndex,
      endIndex: record.sourceEndIndex,
      startTime: record.startTime,
      endTime: record.endTime,
      direction: record.direction,
      priceLow: record.low,
      priceHigh: record.high,
      ruleVersion: record.ruleVersion,
      metadata: {
        normalizedIndex: record.normalizedIndex,
        open: record.open,
        close: record.close,
        tickCount: record.tickCount,
        volume: record.volume,
        synthetic: record.synthetic,
        closed: record.closed,
        sourceStartTime: record.sourceStartTime,
        sourceEndTime: record.sourceEndTime,
      },
    });
  }

  function normalizedKToCompactRow(record) {
    return [
      record.normalizedIndex,
      record.startTime,
      record.endTime,
      record.open,
      record.high,
      record.low,
      record.close,
      record.tickCount,
      record.sourceStartIndex,
      record.sourceEndIndex,
      record.direction,
    ];
  }

  class NormalizedKStateMachine {
    #ruleConfig;
    #bars = [];
    #events = [];
    #currentBarIndex = -1;
    #currentBarTime = null;
    #rawCount = 0;
    #direction = DIR_NONE;

    constructor(ruleConfig = {}) {
      requireDependencies();
      this.#ruleConfig = core.createCTRuleConfig(ruleConfig.ruleConfig || ruleConfig);
      this.reset();
    }

    reset() {
      this.#bars = [];
      this.#events = [];
      this.#currentBarIndex = -1;
      this.#currentBarTime = null;
      this.#rawCount = 0;
      this.#direction = DIR_NONE;
      return this;
    }

    getRuleConfig() { return clone(this.#ruleConfig); }
    getCurrentDirection() { return this.#direction; }
    getNormalizedBars() { return clone(this.#bars); }
    getEvents() { return clone(this.#events); }

    serializeContinuationState() {
      return freeze({
        continuationVersion: CONTINUATION_VERSION,
        ruleVersion: this.#ruleConfig.ruleVersion,
        structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        bars: clone(this.#bars),
        currentBarIndex: this.#currentBarIndex,
        currentBarTime: this.#currentBarTime,
        rawCount: this.#rawCount,
        direction: this.#direction,
      });
    }

    restoreContinuationState(snapshot) {
      if (!snapshot || snapshot.continuationVersion !== CONTINUATION_VERSION) {
        throw new Error('INCOMPATIBLE_NORMALIZED_K_CONTINUATION');
      }
      if (snapshot.ruleVersion !== this.#ruleConfig.ruleVersion) {
        throw new Error('NORMALIZED_K_CONTINUATION_RULE_VERSION_MISMATCH');
      }
      const bars = Array.isArray(snapshot.bars) ? snapshot.bars.map((bar, index) =>
        withNormalizedIndex(clone(bar), index, bar.direction, this.#ruleConfig.ruleVersion)) : [];
      const currentBarIndex = Number(snapshot.currentBarIndex);
      const rawCount = Number(snapshot.rawCount);
      if (!Number.isInteger(currentBarIndex) || currentBarIndex < -1 ||
          !Number.isInteger(rawCount) || rawCount < 0 ||
          (rawCount > 0 && currentBarIndex !== rawCount - 1)) {
        throw new Error('INVALID_NORMALIZED_K_CONTINUATION_CURSOR');
      }
      this.#bars = bars;
      this.#events = [];
      this.#currentBarIndex = currentBarIndex;
      this.#currentBarTime = snapshot.currentBarTime == null ? null : Number(snapshot.currentBarTime);
      this.#rawCount = rawCount;
      this.#direction = String(snapshot.direction || DIR_NONE);
      return this;
    }

    #assertNextRawBar(bar) {
      if (this.#currentBarIndex >= 0 && bar.barIndex !== this.#currentBarIndex + 1) {
        throw new Error(`NormalizedKStateMachine expects contiguous raw bars: previous=${this.#currentBarIndex}, current=${bar.barIndex}`);
      }
    }

    #activeMemorySize() {
      return core.estimateActiveMemorySize({
        rawCount: this.#rawCount,
        direction: this.#direction,
        bars: this.#bars,
      });
    }

    #event(action, record, currentBar, metadata = {}, modeBefore = this.#direction, modeAfter = this.#direction) {
      return core.createStructuralEvent({
        barIndex: currentBar.barIndex,
        barTime: currentBar.barTime,
        structureId: record.structureId,
        structureType: STRUCTURE_TYPE,
        eventRawBarIndex: record.sourceEndIndex,
        eventTime: record.endTime,
        availableRawBarIndex: currentBar.barIndex,
        availableTime: currentBar.barTime,
        confirmRawBarIndex: currentBar.barIndex,
        confirmTime: currentBar.barTime,
        eventNormalizedKIndex: record.normalizedIndex,
        availableNormalizedKIndex: record.normalizedIndex,
        confirmNormalizedKIndex: record.normalizedIndex,
        eventIndex: record.sourceEndIndex,
        confirmIndex: currentBar.barIndex,
        modeBefore,
        modeAfter,
        eventAction: action,
        ruleVersion: this.#ruleConfig.ruleVersion,
        activeMemorySize: this.#activeMemorySize(),
        provenance: {
          normalizedKId: record.structureId,
          rawObservationRange: [record.sourceStartIndex, record.sourceEndIndex],
        },
        metadata,
      });
    }

    update(inputBar, options = {}) {
      const currentBar = core.createCTBar(inputBar);
      this.#assertNextRawBar(currentBar);
      const directionBefore = this.#direction;
      const tolerance = inclusionTolerance(this.#ruleConfig);
      const replaced = [];
      let current = rawBarToNormalized(currentBar, this.#ruleConfig.ruleVersion);
      let inclusionCount = 0;

      while (true) {
        if (!this.#bars.length) {
          const record = withNormalizedIndex(current, 0, DIR_UP, this.#ruleConfig.ruleVersion);
          this.#bars.push(record);
          current = record;
          break;
        }
        const last = this.#bars[this.#bars.length - 1];
        if (!isIncluded(last, current, tolerance)) {
          const direction = last.high > current.high + tolerance ? DIR_DOWN : DIR_UP;
          const record = withNormalizedIndex(current, this.#bars.length, direction, this.#ruleConfig.ruleVersion);
          this.#bars.push(record);
          current = record;
          break;
        }
        const direction = inclusionDirection(this.#bars, tolerance);
        replaced.push(last);
        inclusionCount += 1;
        current = mergeNormalizedBars(last, current, direction, this.#ruleConfig.ruleVersion);
        this.#bars.pop();
      }

      this.#rawCount += 1;
      this.#currentBarIndex = currentBar.barIndex;
      this.#currentBarTime = currentBar.barTime;
      this.#direction = activeDirection(this.#bars, tolerance);

      const events = [];
      for (const oldRecord of replaced) {
        events.push(this.#event(ACTION_REPLACED, oldRecord, currentBar, {
          reason: 'inclusion',
          replacedBy: current.structureId,
        }, directionBefore, this.#direction));
      }
      events.push(this.#event(replaced.length ? ACTION_EXTENDED : ACTION_CREATED, current, currentBar, {
        inclusionCount,
        sourceStartIndex: current.sourceStartIndex,
        sourceEndIndex: current.sourceEndIndex,
        absorbedRawBars: current.sourceEndIndex - current.sourceStartIndex + 1,
      }, directionBefore, this.#direction));
      this.#events.push(...events);
      const packet = { events: clone(events), normalizedBars: this.getNormalizedBars() };
      if (options.includeState) packet.state = this.getState();
      return freeze(packet);
    }

    getState() {
      const last = this.#bars[this.#bars.length - 1] || null;
      const layer = core.createBaseCTState({
        structureType: STRUCTURE_TYPE,
        mode: this.#direction,
        continuousState: {
          rawCount: this.#rawCount,
          normalizedCount: this.#bars.length,
          lastHigh: finite(last?.high),
          lastLow: finite(last?.low),
          currentBarIndex: this.#currentBarIndex,
          currentBarTime: this.#currentBarTime,
        },
        activeMemory: {
          rawCount: this.#rawCount,
          currentDirection: this.#direction,
          bars: this.#bars,
        },
        structures: this.#bars.map(normalizedKToStructuralState),
        lastEventId: this.#events[this.#events.length - 1]?.eventId || null,
        metadata: {
          ruleVersion: this.#ruleConfig.ruleVersion,
          inclusionRule: this.#ruleConfig.inclusionRule,
          equalHighLowRule: this.#ruleConfig.equalHighLowRule,
          priceTolerance: this.#ruleConfig.priceTolerance,
          note: 'Phase 2 pins the existing WorkBuddy streaming inclusion semantics; it is not the final CT rule set.',
        },
      });
      return core.attachStateHash(core.createCTState({
        currentBarIndex: this.#currentBarIndex,
        currentBarTime: this.#currentBarTime,
        ruleVersion: this.#ruleConfig.ruleVersion,
        activeMemorySize: this.#activeMemorySize(),
        normalizedKState: layer,
        parserMetadata: {
          parser: 'NormalizedKStateMachine',
          phase: 'CT-Phase2',
        },
      }));
    }
  }

  function parseNormalizedKBatch(rawBars, ruleConfig = {}) {
    const machine = new NormalizedKStateMachine(ruleConfig);
    for (const bar of rawBars || []) machine.update(bar);
    return freeze({
      state: machine.getState(),
      normalizedBars: machine.getNormalizedBars(),
      events: machine.getEvents(),
    });
  }

  Object.assign(core, {
    NormalizedKStateMachine,
    CT_NORMALIZED_K_CONTINUATION_VERSION: CONTINUATION_VERSION,
    parseNormalizedKBatch,
    normalizedKToStructuralState,
    normalizedKToCompactRow,
    isNormalizedKIncluded: isIncluded,
  });
})();
