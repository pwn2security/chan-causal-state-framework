(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};

  const CT_STRUCTURE_TYPES = Object.freeze({
    normalizedK: 'normalizedK',
    fractal: 'fractal',
    stroke: 'stroke',
    segment: 'segment',
    pivotZone: 'pivotZone',
    trend: 'trend',
    divergence: 'divergence',
    tradingPoint: 'tradingPoint',
  });

  const CT_LAYER_FIELDS = Object.freeze({
    normalizedK: 'normalizedKState',
    fractal: 'fractalState',
    stroke: 'strokeState',
    segment: 'segmentState',
    pivotZone: 'pivotZoneState',
    trend: 'trendState',
    divergence: 'divergenceState',
    tradingPoint: 'tradingPointState',
  });

  const CT_STATUSES = Object.freeze({
    none: 'NONE',
    candidate: 'CANDIDATE',
    confirmed: 'CONFIRMED',
    extended: 'EXTENDED',
    replaced: 'REPLACED',
    broken: 'BROKEN',
    invalidated: 'INVALIDATED',
    forming: 'FORMING',
    extending: 'EXTENDING',
    established: 'ESTABLISHED',
  });

  const CT_EVENT_ACTIONS = Object.freeze({
    created: 'CREATED',
    candidate: 'CANDIDATE',
    confirmed: 'CONFIRMED',
    replaced: 'REPLACED',
    extended: 'EXTENDED',
    broken: 'BROKEN',
    invalidated: 'INVALIDATED',
  });

  const CT_DIRECTIONS = Object.freeze({
    none: 'NONE',
    up: 'UP',
    down: 'DOWN',
    consolidation: 'CONSOLIDATION',
  });

  const CT_STRUCTURAL_TIME_SCHEMA_VERSION = 'CT-Structural-Time-v1.0';
  const CT_LEGACY_INDEX_ALIAS_POLICY = Object.freeze({
    eventIndex: 'deprecated alias of eventRawBarIndex',
    confirmIndex: 'deprecated alias of confirmRawBarIndex',
    barIndex: 'raw-bar decision/update cursor; never a structural-sequence index',
  });

  function clonePlain(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }

  function asNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function asInteger(value, fallback = null) {
    const number = asNumber(value, null);
    if (number === null) return fallback;
    return Math.trunc(number);
  }

  function requireFinite(value, field) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${field} must be finite`);
    return number;
  }

  function requireIndex(value, field) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`${field} must be a non-negative integer`);
    return number;
  }

  function optionalIndex(input, field) {
    const value = input?.[field] ?? input?.[field.replace(/[A-Z]/g, item => `_${item.toLowerCase()}`)];
    if (value === null || value === undefined || value === '') return null;
    return requireIndex(value, field);
  }

  function assertOneOf(value, candidates, field) {
    const allowed = new Set(Object.values(candidates));
    if (!allowed.has(value)) throw new Error(`${field} must be one of: ${[...allowed].join(', ')}`);
    return value;
  }

  function normalizeDirection(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
      if (value > 0) return CT_DIRECTIONS.up;
      if (value < 0) return CT_DIRECTIONS.down;
      return CT_DIRECTIONS.consolidation;
    }
    const text = String(value).toUpperCase();
    if (['UP', '+1', 'LONG'].includes(text)) return CT_DIRECTIONS.up;
    if (['DOWN', '-1', 'SHORT'].includes(text)) return CT_DIRECTIONS.down;
    if (['CONSOLIDATION', 'FLAT', 'SIDEWAYS', '0'].includes(text)) return CT_DIRECTIONS.consolidation;
    if (text === 'NONE') return CT_DIRECTIONS.none;
    return String(value);
  }

  function explicitIndex(input, explicitField, legacyField = null) {
    const explicit = optionalIndex(input, explicitField);
    const legacy = legacyField ? optionalIndex(input, legacyField) : null;
    if (explicit !== null && legacy !== null && explicit !== legacy) {
      throw new Error(`${legacyField} must equal ${explicitField} when both are supplied`);
    }
    return explicit ?? legacy;
  }

  function optionalTime(input, ...fields) {
    for (const field of fields) {
      const value = input?.[field];
      if (value === null || value === undefined || value === '') continue;
      return requireFinite(value, field);
    }
    return null;
  }

  function validateTimeCoordinates(eventRawBarIndex, availableRawBarIndex, confirmRawBarIndex,
      eventTime, availableTime, confirmTime) {
    if (eventRawBarIndex !== null && availableRawBarIndex !== null && availableRawBarIndex < eventRawBarIndex) {
      throw new Error(`availableRawBarIndex must be >= eventRawBarIndex (${availableRawBarIndex} < ${eventRawBarIndex})`);
    }
    if (availableRawBarIndex !== null && confirmRawBarIndex !== null && confirmRawBarIndex < availableRawBarIndex) {
      throw new Error(`confirmRawBarIndex must be >= availableRawBarIndex (${confirmRawBarIndex} < ${availableRawBarIndex})`);
    }
    if (availableRawBarIndex === null && eventRawBarIndex !== null && confirmRawBarIndex !== null &&
        confirmRawBarIndex < eventRawBarIndex) {
      throw new Error(`confirmRawBarIndex must be >= eventRawBarIndex (${confirmRawBarIndex} < ${eventRawBarIndex})`);
    }
    if (eventTime !== null && availableTime !== null && availableTime < eventTime) {
      throw new Error(`availableTime must be >= eventTime (${availableTime} < ${eventTime})`);
    }
    if (availableTime !== null && confirmTime !== null && confirmTime < availableTime) {
      throw new Error(`confirmTime must be >= availableTime (${confirmTime} < ${availableTime})`);
    }
    if (availableTime === null && eventTime !== null && confirmTime !== null && confirmTime < eventTime) {
      throw new Error(`confirmTime must be >= eventTime (${confirmTime} < ${eventTime})`);
    }
  }

  function readStructuralTime(input = {}) {
    const eventRawBarIndex = explicitIndex(input, 'eventRawBarIndex', 'eventIndex');
    const availableRawBarIndex = explicitIndex(input, 'availableRawBarIndex', 'availableAtIndex');
    const confirmRawBarIndex = explicitIndex(input, 'confirmRawBarIndex', 'confirmIndex');
    const eventTime = optionalTime(input, 'eventTime', 'event_time');
    const availableTime = optionalTime(input, 'availableTime', 'available_time', 'availableAtTime', 'available_at_time');
    const confirmTime = optionalTime(input, 'confirmTime', 'confirm_time');
    validateTimeCoordinates(
      eventRawBarIndex, availableRawBarIndex, confirmRawBarIndex,
      eventTime, availableTime, confirmTime,
    );
    return {
      structuralTimeSchemaVersion: CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      eventRawBarIndex,
      availableRawBarIndex,
      confirmRawBarIndex,
      eventTime,
      availableTime,
      confirmTime,
      eventIndex: eventRawBarIndex,
      confirmIndex: confirmRawBarIndex,
      eventNormalizedKIndex: optionalIndex(input, 'eventNormalizedKIndex'),
      availableNormalizedKIndex: optionalIndex(input, 'availableNormalizedKIndex'),
      confirmNormalizedKIndex: optionalIndex(input, 'confirmNormalizedKIndex'),
      eventStrokeIndex: optionalIndex(input, 'eventStrokeIndex'),
      availableStrokeIndex: optionalIndex(input, 'availableStrokeIndex'),
      confirmStrokeIndex: optionalIndex(input, 'confirmStrokeIndex'),
      eventFeatureIndex: optionalIndex(input, 'eventFeatureIndex'),
      availableFeatureIndex: optionalIndex(input, 'availableFeatureIndex'),
      confirmFeatureIndex: optionalIndex(input, 'confirmFeatureIndex'),
      legacyIndexAliases: CT_LEGACY_INDEX_ALIAS_POLICY,
    };
  }

  function createCTBar(input = {}) {
    const barIndex = requireIndex(input.barIndex ?? input.index, 'barIndex');
    const startTime = requireFinite(input.startTime ?? input.start_time ?? input.startTimestamp ?? input.time, 'startTime');
    const endTime = requireFinite(input.endTime ?? input.end_time ?? input.endTimestamp ?? input.time ?? startTime, 'endTime');
    if (endTime < startTime) throw new Error('endTime must be >= startTime');
    const open = requireFinite(input.open, 'open');
    const high = requireFinite(input.high, 'high');
    const low = requireFinite(input.low, 'low');
    const close = requireFinite(input.close, 'close');
    const volume = asNumber(input.volume, 0);
    if (high < low || high < open || high < close || low > open || low > close) {
      throw new Error('CTBar OHLC invariant failed');
    }
    if (volume < 0) throw new Error('volume must be >= 0');
    return deepFreeze({
      barIndex,
      barTime: requireFinite(input.barTime ?? input.bar_time ?? endTime, 'barTime'),
      startTime,
      endTime,
      open,
      high,
      low,
      close,
      volume,
      tickCount: Math.max(0, asInteger(input.tickCount ?? input.tick_count, 0)),
      synthetic: !!input.synthetic,
      closed: input.closed !== false,
      sourceStartIndex: asInteger(input.sourceStartIndex ?? input.source_start_index, -1),
      sourceEndIndex: asInteger(input.sourceEndIndex ?? input.source_end_index, -1),
      source: String(input.source || 'ohlcv'),
      metadata: deepFreeze(clonePlain(input.metadata || {})),
    });
  }

  function createStructuralState(input = {}) {
    const structureType = input.structureType ?? input.structure_type ?? null;
    assertOneOf(structureType, CT_STRUCTURE_TYPES, 'structureType');
    const status = input.status || CT_STATUSES.none;
    assertOneOf(status, CT_STATUSES, 'status');
    const structuralTime = readStructuralTime(input);
    const startIndex = optionalIndex(input, 'startIndex');
    const endIndex = optionalIndex(input, 'endIndex');
    if (startIndex !== null && endIndex !== null && endIndex < startIndex) {
      throw new Error('endIndex must be >= startIndex');
    }
    const startTime = asNumber(input.startTime ?? input.start_time, null);
    const endTime = asNumber(input.endTime ?? input.end_time, null);
    if (startTime !== null && endTime !== null && endTime < startTime) {
      throw new Error('endTime must be >= startTime');
    }
    const priceLow = asNumber(input.priceLow ?? input.price_low, null);
    const priceHigh = asNumber(input.priceHigh ?? input.price_high, null);
    if (priceLow !== null && priceHigh !== null && priceHigh < priceLow) {
      throw new Error('priceHigh must be >= priceLow');
    }
    const structureId = String(input.structureId ?? input.structure_id ??
      `${structureType}:${structuralTime.eventRawBarIndex ?? 'na'}:${structuralTime.confirmRawBarIndex ?? 'na'}:${status}`);
    return deepFreeze({
      structureId,
      structureType,
      status,
      schemaVersion: CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      ...structuralTime,
      startIndex,
      endIndex,
      startTime,
      endTime,
      direction: normalizeDirection(input.direction),
      priceLow,
      priceHigh,
      parentId: input.parentId ?? input.parent_id ?? null,
      ruleVersion: String(input.ruleVersion ?? input.rule_version ?? 'CT-R1.0'),
      createdAt: input.createdAt ?? input.created_at ?? null,
      updatedAt: input.updatedAt ?? input.updated_at ?? null,
      metadata: deepFreeze(clonePlain(input.metadata || {})),
    });
  }

  function createStructuralEvent(input = {}) {
    const structureType = input.structureType ?? input.structure_type ?? null;
    assertOneOf(structureType, CT_STRUCTURE_TYPES, 'structureType');
    const eventAction = input.eventAction ?? input.event_action ?? null;
    assertOneOf(eventAction, CT_EVENT_ACTIONS, 'eventAction');
    const barIndex = requireIndex(input.barIndex ?? input.bar_index, 'barIndex');
    const barTime = requireFinite(input.barTime ?? input.bar_time, 'barTime');
    const structuralTime = readStructuralTime(input);
    const suppliedProvenance = input.provenance ?? input.metadata?.provenance;
    if (eventAction === CT_EVENT_ACTIONS.confirmed) {
      if (structuralTime.eventTime === null || structuralTime.confirmTime === null) {
        throw new Error('CONFIRMED StructuralEvent requires eventTime and confirmTime');
      }
      if (!suppliedProvenance || typeof suppliedProvenance !== 'object' || Array.isArray(suppliedProvenance)) {
        throw new Error('CONFIRMED StructuralEvent requires explicit provenance');
      }
    }
    const ruleVersion = String(input.ruleVersion ?? input.rule_version ?? 'CT-R1.0');
    const structureId = String(input.structureId ?? input.structure_id ??
      `${structureType}:${structuralTime.eventRawBarIndex ?? 'na'}:${structuralTime.confirmRawBarIndex ?? 'na'}`);
    const eventId = String(input.eventId ?? input.event_id ??
      `${ruleVersion}:event:${structureType}:${structureId}:${eventAction}:${barIndex}`);
    return deepFreeze({
      eventId,
      uniqueId: eventId,
      schemaVersion: CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      barIndex,
      barTime,
      structureId,
      structureType,
      ...structuralTime,
      modeBefore: input.modeBefore ?? input.mode_before ?? null,
      modeAfter: input.modeAfter ?? input.mode_after ?? null,
      eventAction,
      parentStructureId: input.parentStructureId ?? input.parent_structure_id ?? null,
      ruleVersion,
      stateHash: input.stateHash ?? input.state_hash ?? null,
      activeMemorySize: Math.max(0, asInteger(input.activeMemorySize ?? input.active_memory_size, 0)),
      processingTimeUs: asNumber(input.processingTimeUs ?? input.processing_time_us, null),
      provenance: deepFreeze(clonePlain(suppliedProvenance ?? {})),
      metadata: deepFreeze(clonePlain(input.metadata || {})),
    });
  }

  function createBaseCTState(input = {}) {
    const structureType = input.structureType ?? input.structure_type ?? null;
    if (structureType !== null) assertOneOf(structureType, CT_STRUCTURE_TYPES, 'structureType');
    const structures = Array.isArray(input.structures)
      ? input.structures.map(createStructuralState)
      : [];
    return deepFreeze({
      continuousState: deepFreeze(clonePlain(input.continuousState ?? input.continuous_state ?? {})),
      mode: input.mode ?? CT_STATUSES.none,
      activeMemory: deepFreeze(clonePlain(input.activeMemory ?? input.active_memory ?? {})),
      structures: deepFreeze(structures),
      lastEventId: input.lastEventId ?? input.last_event_id ?? null,
      structureType,
      metadata: deepFreeze(clonePlain(input.metadata || {})),
    });
  }

  function estimateActiveMemorySize(value) {
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value)) return value.length + value.reduce((sum, item) => sum + estimateActiveMemorySize(item), 0);
    if (typeof value === 'object') {
      return Object.keys(value).length + Object.values(value).reduce((sum, item) => sum + estimateActiveMemorySize(item), 0);
    }
    return 1;
  }

  function layerInput(input, key) {
    return input[key] ?? input[key.replace(/[A-Z]/g, item => `_${item.toLowerCase()}`)] ?? {};
  }

  function createCTState(input = {}) {
    const ruleVersion = String(input.ruleVersion ?? input.rule_version ?? 'CT-R1.0');
    const currentBarIndex = asInteger(input.currentBarIndex ?? input.current_bar_index, -1);
    const currentBarTime = asNumber(input.currentBarTime ?? input.current_bar_time, null);
    const layers = {};
    for (const [structureType, field] of Object.entries(CT_LAYER_FIELDS)) {
      layers[field] = createBaseCTState({
        ...layerInput(input, field),
        structureType,
        ruleVersion,
      });
    }
    const activeMemorySize = asInteger(input.activeMemorySize ?? input.active_memory_size, null) ??
      Object.values(layers).reduce((sum, layer) => sum + estimateActiveMemorySize(layer.activeMemory), 0);
    return deepFreeze({
      ...layers,
      currentBarIndex,
      currentBarTime,
      ruleVersion,
      stateVersion: Math.max(1, asInteger(input.stateVersion ?? input.state_version, 1)),
      stateHash: input.stateHash ?? input.state_hash ?? null,
      activeMemorySize: Math.max(0, activeMemorySize),
      parserMetadata: deepFreeze(clonePlain(input.parserMetadata ?? input.parser_metadata ?? {})),
    });
  }

  Object.assign(core, {
    CT_STRUCTURE_TYPES,
    CT_LAYER_FIELDS,
    CT_STATUSES,
    CT_EVENT_ACTIONS,
    CT_DIRECTIONS,
    CT_STRUCTURAL_TIME_SCHEMA_VERSION,
    CT_LEGACY_INDEX_ALIAS_POLICY,
    clonePlain,
    deepFreeze,
    createCTBar,
    createStructuralState,
    createStructuralEvent,
    readStructuralTime,
    createBaseCTState,
    createCTState,
    estimateActiveMemorySize,
  });
})();
