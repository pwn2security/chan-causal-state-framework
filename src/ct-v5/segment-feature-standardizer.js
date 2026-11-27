(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};

  const FEATURE_SEQUENCE_STANDARDIZER_VERSION = 'feature-standardizer-v0.1';
  const FEATURE_STANDARDIZATION_ACTIONS = Object.freeze({
    unchanged: 'UNCHANGED',
    merged: 'MERGED',
    extended: 'EXTENDED',
    replaced: 'REPLACED',
    ruleUnspecified: 'RULE_UNSPECIFIED',
  });
  const STATUS_RAW = core.FEATURE_SEQUENCE_STANDARDIZATION_STATUS?.raw || 'RAW_NOT_STANDARDIZED';
  const STATUS_STANDARDIZED = core.FEATURE_SEQUENCE_STANDARDIZATION_STATUS?.standardized || 'STANDARDIZED';
  const STATUS_RULE_UNSPECIFIED = core.FEATURE_SEQUENCE_STANDARDIZATION_STATUS?.ruleUnspecified || 'RULE_UNSPECIFIED';
  const STATUS_INVALID = core.FEATURE_SEQUENCE_STANDARDIZATION_STATUS?.invalid || 'INVALID';

  function clone(value) {
    return core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  }

  function freeze(value) {
    return core.deepFreeze ? core.deepFreeze(value) : Object.freeze(value);
  }

  function finiteNumber(value, field) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`FeatureSequenceStandardizer ${field} must be finite`);
    return number;
  }

  function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nonNegativeNumber(value, fallback, field) {
    const number = value === null || value === undefined || value === '' ? fallback : Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`FeatureSequenceStandardizer ${field} must be non-negative`);
    return number;
  }

  function readRuleConfig(options = {}) {
    if (typeof core.createCTRuleConfig === 'function') return core.createCTRuleConfig(options.ruleConfig || options);
    return freeze({
      ruleVersion: String(options.ruleVersion || options.rule_version || 'CT-R1.0'),
      priceTolerance: nonNegativeNumber(options.priceTolerance ?? options.price_tolerance, 0, 'priceTolerance'),
      numericTolerance: nonNegativeNumber(options.numericTolerance ?? options.numeric_tolerance, 1e-10, 'numericTolerance'),
    });
  }

  function readTolerance(options = {}, ruleConfig = null) {
    return nonNegativeNumber(
      options.priceTolerance ?? options.price_tolerance ?? ruleConfig?.priceTolerance ?? ruleConfig?.price_tolerance,
      0,
      'priceTolerance',
    );
  }

  function readPriceInterval(element, field) {
    if (element.interval && typeof element.interval === 'object') {
      const intervalLow = finiteNumber(element.interval.low, `${field}.interval.low`);
      const intervalHigh = finiteNumber(element.interval.high, `${field}.interval.high`);
      if (intervalHigh < intervalLow) throw new Error(`FeatureSequenceStandardizer ${field} interval high must be >= low`);
    }
    const low = finiteNumber(element.priceLow ?? element.price_low ?? element.low ?? element.interval?.low, `${field}.priceLow`);
    const high = finiteNumber(element.priceHigh ?? element.price_high ?? element.high ?? element.interval?.high, `${field}.priceHigh`);
    if (high < low) throw new Error(`FeatureSequenceStandardizer ${field} priceHigh must be >= priceLow`);
    return freeze({ low, high });
  }

  function readIndex(value, fallback, field) {
    const raw = value === null || value === undefined ? fallback : value;
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 0) throw new Error(`FeatureSequenceStandardizer ${field} must be non-negative integer`);
    return number;
  }

  function asArray(value, fallbackValue = null) {
    if (Array.isArray(value)) return value.map(String);
    if (value !== null && value !== undefined && value !== '') return [String(value)];
    if (fallbackValue !== null && fallbackValue !== undefined && fallbackValue !== '') return [String(fallbackValue)];
    return [];
  }

  function uniqueStrings(values) {
    return [...new Set(values.filter(value => value !== null && value !== undefined).map(String))];
  }

  function compactId(text) {
    const value = String(text || '').replace(/[^A-Za-z0-9_.:-]+/g, '_');
    if (value.length <= 96) return value;
    const hash = core.computeStateHash ? core.computeStateHash(value).slice(0, 16) : String(value.length);
    return `${value.slice(0, 40)}_${hash}_${value.slice(-32)}`;
  }

  function normalizeRawElement(element, ordinal, sequence) {
    if (!element || typeof element !== 'object') throw new Error(`FeatureSequenceStandardizer raw element ${ordinal} is required`);
    const featureElementId = String(element.elementId ?? element.element_id ?? element.featureElementId ?? element.feature_element_id ?? '');
    if (!featureElementId) throw new Error(`FeatureSequenceStandardizer raw element ${ordinal} missing featureElementId`);
    const sourceStrokeIds = uniqueStrings(asArray(element.sourceStrokeIds ?? element.source_stroke_ids, element.sourceStrokeId ?? element.source_stroke_id));
    if (!sourceStrokeIds.length) throw new Error(`FeatureSequenceStandardizer raw element ${ordinal} missing sourceStrokeIds`);
    const interval = readPriceInterval(element, `raw.elements[${ordinal}]`);
    const sequenceId = String(element.sequenceId ?? element.sequence_id ?? sequence.sequenceId ?? sequence.sequence_id ?? '');
    const sequenceRole = String(element.sequenceRole ?? element.sequence_role ?? sequence.sequenceRole ?? sequence.sequence_role ?? 'primary');
    const featureDirection = String(element.featureDirection ?? element.feature_direction ?? sequence.featureDirection ?? sequence.feature_direction ?? '');
    const segmentStartDirection = String(element.segmentStartDirection ?? element.segment_start_direction ?? sequence.segmentStartDirection ?? sequence.segment_start_direction ?? '');
    const eventIndex = readIndex(element.eventRawBarIndex ?? element.event_raw_bar_index ??
      element.eventIndex ?? element.event_index, ordinal, `raw.elements[${ordinal}].eventRawBarIndex`);
    const confirmIndex = readIndex(element.confirmRawBarIndex ?? element.confirm_raw_bar_index ??
      element.confirmIndex ?? element.confirm_index, eventIndex, `raw.elements[${ordinal}].confirmRawBarIndex`);
    const eventTime = finiteNumber(element.eventTime ?? element.event_time, `raw.elements[${ordinal}].eventTime`);
    const confirmTime = finiteNumber(element.confirmTime ?? element.confirm_time, `raw.elements[${ordinal}].confirmTime`);
    if (confirmIndex < eventIndex || confirmTime < eventTime) {
      throw new Error(`FeatureSequenceStandardizer raw element ${ordinal} confirm must be >= event`);
    }
    const rawSourceStroke = element.sourceStroke || element.source_stroke || {};
    const sourceRawStartIndex = readIndex(
      element.sourceRawStartIndex ?? element.source_raw_start_index ?? rawSourceStroke.startIndex ?? rawSourceStroke.start_index ?? element.eventIndex ?? element.event_index,
      eventIndex,
      `raw.elements[${ordinal}].sourceRawStartIndex`,
    );
    const sourceRawEndIndex = readIndex(
      element.sourceRawEndIndex ?? element.source_raw_end_index ?? rawSourceStroke.endIndex ?? rawSourceStroke.end_index ?? element.confirmIndex ?? element.confirm_index,
      confirmIndex,
      `raw.elements[${ordinal}].sourceRawEndIndex`,
    );
    if (sourceRawEndIndex < sourceRawStartIndex) throw new Error(`FeatureSequenceStandardizer raw element ${ordinal} sourceRawEndIndex must be >= sourceRawStartIndex`);
    return freeze({
      rawElement: freeze(clone(element)),
      featureElementId,
      sourceFeatureElementIds: [featureElementId],
      sourceStrokeIds,
      sequenceId,
      sequenceRole,
      featureDirection,
      segmentStartDirection,
      rawFeatureSequenceIndex: readIndex(element.sequenceOrdinal ?? element.sequence_ordinal, ordinal, `raw.elements[${ordinal}].sequenceOrdinal`),
      sourceStrokeStartIndex: readIndex(element.sourceStrokeIndex ?? element.source_stroke_index, ordinal, `raw.elements[${ordinal}].sourceStrokeStartIndex`),
      sourceStrokeEndIndex: readIndex(element.sourceStrokeIndex ?? element.source_stroke_index, ordinal, `raw.elements[${ordinal}].sourceStrokeEndIndex`),
      sourceRawStartIndex,
      sourceRawEndIndex,
      sourceStartTime: finiteNumber(element.startTime ?? element.start_time ??
        rawSourceStroke.startTime ?? rawSourceStroke.start_time ??
        element.eventTime ?? element.event_time, `raw.elements[${ordinal}].sourceStartTime`),
      sourceEndTime: finiteNumber(element.endTime ?? element.end_time ??
        rawSourceStroke.endTime ?? rawSourceStroke.end_time ??
        element.eventTime ?? element.event_time, `raw.elements[${ordinal}].sourceEndTime`),
      eventRawBarIndex: eventIndex,
      eventIndex,
      eventTime,
      availableRawBarIndex: readIndex(element.availableRawBarIndex ?? element.available_raw_bar_index ??
        element.availableAtIndex ?? element.available_at_index, confirmIndex, `raw.elements[${ordinal}].availableRawBarIndex`),
      availableTime: finiteNumber(element.availableTime ?? element.available_time ??
        element.availableAtTime ?? element.available_at_time ?? confirmTime, `raw.elements[${ordinal}].availableTime`),
      confirmRawBarIndex: confirmIndex,
      confirmIndex,
      confirmTime,
      availableAtIndex: readIndex(element.availableRawBarIndex ?? element.available_raw_bar_index ??
        element.availableAtIndex ?? element.available_at_index, confirmIndex, `raw.elements[${ordinal}].availableRawBarIndex`),
      availableAtTime: finiteNumber(element.availableTime ?? element.available_time ??
        element.availableAtTime ?? element.available_at_time ?? confirmTime, `raw.elements[${ordinal}].availableTime`),
      interval,
      priceLow: interval.low,
      priceHigh: interval.high,
    });
  }

  function validateRawSequence(rawSequence) {
    if (!rawSequence || typeof rawSequence !== 'object') throw new Error('FeatureSequenceStandardizer rawSequence is required');
    const status = String(rawSequence.standardizationStatus ?? rawSequence.standardization_status ?? STATUS_RAW);
    if (status !== STATUS_RAW) throw new Error(`FeatureSequenceStandardizer expects ${STATUS_RAW}, got ${status}`);
    if (!Array.isArray(rawSequence.elements)) throw new Error('FeatureSequenceStandardizer rawSequence.elements must be an array');
    const elements = rawSequence.elements.map((element, index) => normalizeRawElement(element, index, rawSequence));
    const sequenceIds = new Set(elements.map(element => element.sequenceId));
    const roles = new Set(elements.map(element => element.sequenceRole));
    const featureDirections = new Set(elements.map(element => element.featureDirection));
    if (sequenceIds.size > 1 || roles.size > 1 || featureDirections.size > 1) {
      throw new Error('FeatureSequenceStandardizer refuses cross Feature Sequence inclusion/standardization');
    }
    return freeze({
      rawSequence: freeze(clone(rawSequence)),
      sequenceId: String(rawSequence.sequenceId ?? rawSequence.sequence_id ?? elements[0]?.sequenceId ?? 'empty-sequence'),
      sequenceRole: String(rawSequence.sequenceRole ?? rawSequence.sequence_role ?? elements[0]?.sequenceRole ?? 'primary'),
      segmentStartDirection: String(rawSequence.segmentStartDirection ?? rawSequence.segment_start_direction ?? elements[0]?.segmentStartDirection ?? ''),
      featureDirection: String(rawSequence.featureDirection ?? rawSequence.feature_direction ?? elements[0]?.featureDirection ?? ''),
      ruleVersion: String(rawSequence.ruleVersion ?? rawSequence.rule_version ?? 'CT-R1.0'),
      elements,
    });
  }

  function containsInterval(outer, inner, tolerance) {
    return outer.low <= inner.low + tolerance && outer.high + tolerance >= inner.high;
  }

  function featureElementInclusion(left, right, options = {}) {
    const ruleConfig = readRuleConfig(options);
    const tolerance = readTolerance(options, ruleConfig);
    const a = readPriceInterval(left.interval ? { interval: left.interval } : left, 'left');
    const b = readPriceInterval(right.interval ? { interval: right.interval } : right, 'right');
    const leftContainsRight = containsInterval(a, b, tolerance);
    const rightContainsLeft = containsInterval(b, a, tolerance);
    const hasInclusion = leftContainsRight || rightContainsLeft;
    const inclusionType = !hasInclusion
      ? 'NONE'
      : (leftContainsRight && rightContainsLeft ? 'EQUAL_INTERVAL' : (leftContainsRight ? 'LEFT_CONTAINS_RIGHT' : 'RIGHT_CONTAINS_LEFT'));
    const ambiguous = leftContainsRight && rightContainsLeft;
    const relation = ambiguous ? 'MUTUAL' : inclusionType;
    const ruleStatus = hasInclusion ? STATUS_RULE_UNSPECIFIED : STATUS_STANDARDIZED;
    return freeze({
      leftElementId: String(left.featureElementId ?? left.elementId ?? left.element_id ?? ''),
      left_element_id: String(left.featureElementId ?? left.elementId ?? left.element_id ?? ''),
      rightElementId: String(right.featureElementId ?? right.elementId ?? right.element_id ?? ''),
      right_element_id: String(right.featureElementId ?? right.elementId ?? right.element_id ?? ''),
      leftInterval: a,
      left_interval: a,
      rightInterval: b,
      right_interval: b,
      hasInclusion,
      has_inclusion: hasInclusion,
      inclusionType,
      inclusion_type: inclusionType,
      relation,
      ambiguous,
      ruleStatus,
      rule_status: ruleStatus,
      tolerance,
    });
  }

  function detectFeatureSequenceInclusions(elements, options = {}) {
    if (!Array.isArray(elements)) throw new Error('detectFeatureSequenceInclusions expects elements array');
    const result = [];
    for (let index = 1; index < elements.length; index += 1) {
      const inclusion = featureElementInclusion(elements[index - 1], elements[index], options);
      if (inclusion.hasInclusion) {
        result.push(freeze({ pairIndex: index - 1, pair_index: index - 1, ...inclusion }));
      }
    }
    return freeze(result);
  }

  function elementIdForGroup(sequence, ordinal, sourceFeatureElementIds) {
    const seed = compactId(sourceFeatureElementIds.join('~'));
    return `${sequence.sequenceId}:std:${FEATURE_SEQUENCE_STANDARDIZER_VERSION}:${ordinal}:${seed}`;
  }

  function makeStandardizedElement(sequence, group, ordinal, action, status) {
    const sourceFeatureElementIds = uniqueStrings(group.flatMap(element => element.sourceFeatureElementIds));
    const sourceStrokeIds = uniqueStrings(group.flatMap(element => element.sourceStrokeIds));
    const sourceStrokeStartIndex = Math.min(...group.map(element => element.sourceStrokeStartIndex));
    const sourceStrokeEndIndex = Math.max(...group.map(element => element.sourceStrokeEndIndex));
    const sourceRawStartIndex = Math.min(...group.map(element => element.sourceRawStartIndex));
    const sourceRawEndIndex = Math.max(...group.map(element => element.sourceRawEndIndex));
    const sourceStartTime = Math.min(...group.map(element => element.sourceStartTime));
    const sourceEndTime = Math.max(...group.map(element => element.sourceEndTime));
    const eventIndex = Math.min(...group.map(element => element.eventIndex));
    const eventTime = Math.min(...group.map(element => element.eventTime));
    const availableAtIndex = Math.max(...group.map(element => element.availableAtIndex));
    const availableAtTime = Math.max(...group.map(element => element.availableAtTime));
    const priceLow = Math.min(...group.map(element => element.priceLow));
    const priceHigh = Math.max(...group.map(element => element.priceHigh));
    const standardizedElementId = elementIdForGroup(sequence, ordinal, sourceFeatureElementIds);
    return freeze({
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      featureElementId: standardizedElementId,
      feature_element_id: standardizedElementId,
      standardizedElementId,
      standardized_element_id: standardizedElementId,
      sequenceId: sequence.standardizedSequenceId || sequence.sequenceId,
      sequence_id: sequence.standardizedSequenceId || sequence.sequenceId,
      rawSequenceId: sequence.sequenceId,
      raw_sequence_id: sequence.sequenceId,
      rawSequenceId: sequence.sequenceId,
      raw_sequence_id: sequence.sequenceId,
      sequenceRole: sequence.sequenceRole,
      sequence_role: sequence.sequenceRole,
      featureSequenceIndex: ordinal,
      feature_sequence_index: ordinal,
      sequenceOrdinal: ordinal,
      sequence_ordinal: ordinal,
      segmentStartDirection: sequence.segmentStartDirection,
      segment_start_direction: sequence.segmentStartDirection,
      featureDirection: sequence.featureDirection,
      feature_direction: sequence.featureDirection,
      direction: sequence.featureDirection,
      high: priceHigh,
      low: priceLow,
      priceHigh,
      priceLow,
      price_high: priceHigh,
      price_low: priceLow,
      interval: freeze({ low: priceLow, high: priceHigh }),
      status,
      standardizationAction: action,
      standardization_action: action,
      sourceFeatureElementIds,
      source_feature_element_ids: clone(sourceFeatureElementIds),
      sourceStrokeIds,
      source_stroke_ids: clone(sourceStrokeIds),
      sourceStartIndex: Math.min(...group.map(element => element.rawFeatureSequenceIndex)),
      source_start_index: Math.min(...group.map(element => element.rawFeatureSequenceIndex)),
      sourceEndIndex: Math.max(...group.map(element => element.rawFeatureSequenceIndex)),
      source_end_index: Math.max(...group.map(element => element.rawFeatureSequenceIndex)),
      sourceStrokeStartIndex,
      source_stroke_start_index: sourceStrokeStartIndex,
      sourceStrokeEndIndex,
      source_stroke_end_index: sourceStrokeEndIndex,
      sourceRawStartIndex,
      source_raw_start_index: sourceRawStartIndex,
      sourceRawEndIndex,
      source_raw_end_index: sourceRawEndIndex,
      sourceStartTime,
      source_start_time: sourceStartTime,
      sourceEndTime,
      source_end_time: sourceEndTime,
      eventRawBarIndex: eventIndex,
      event_raw_bar_index: eventIndex,
      eventIndex,
      event_index: eventIndex,
      eventTime,
      event_time: eventTime,
      eventFeatureIndex: ordinal,
      event_feature_index: ordinal,
      availableAtIndex,
      available_at_index: availableAtIndex,
      availableRawBarIndex: availableAtIndex,
      available_raw_bar_index: availableAtIndex,
      availableTime: availableAtTime,
      available_time: availableAtTime,
      availableFeatureIndex: ordinal,
      available_feature_index: ordinal,
      availableAtTime,
      available_at_time: availableAtTime,
      confirmRawBarIndex: availableAtIndex,
      confirm_raw_bar_index: availableAtIndex,
      confirmIndex: availableAtIndex,
      confirm_index: availableAtIndex,
      confirmTime: availableAtTime,
      confirm_time: availableAtTime,
      confirmFeatureIndex: ordinal,
      confirm_feature_index: ordinal,
      ruleVersion: sequence.ruleVersion,
      rule_version: sequence.ruleVersion,
      standardizerVersion: FEATURE_SEQUENCE_STANDARDIZER_VERSION,
      standardizer_version: FEATURE_SEQUENCE_STANDARDIZER_VERSION,
      rawElements: group.map(element => element.rawElement),
      raw_elements: group.map(element => element.rawElement),
      provenance: freeze({
        standardizedFeatureElementId: standardizedElementId,
        rawFeatureElementIds: sourceFeatureElementIds,
        strokeIds: sourceStrokeIds,
        rawObservationRange: [sourceRawStartIndex, sourceRawEndIndex],
      }),
      metadata: freeze({
        action,
        status,
        provenance: 'standardizedFeatureElement -> rawFeatureElements -> confirmedStrokes',
        legacyIndexMapping: {
          eventIndex: 'eventRawBarIndex',
          confirmIndex: 'confirmRawBarIndex=availableRawBarIndex',
        },
      }),
    });
  }

  function standardizeFeatureSequence(rawSequence, options = {}) {
    // Explicit version selection preserves reproducibility of the Phase 5D audit baseline.
    if (options.segmentRuleVersion === 'CT-Segment-R1.0') {
      if (!core.standardizeFeatureSequenceR1) throw new Error('R1_STANDARDIZER_MODULE_NOT_LOADED');
      return core.standardizeFeatureSequenceR1(rawSequence, options);
    }
    const ruleConfig = readRuleConfig(options);
    const tolerance = readTolerance(options, ruleConfig);
    const sequence = validateRawSequence(rawSequence);
    const rawBefore = core.canonicalStateJson ? core.canonicalStateJson(sequence.rawSequence) : JSON.stringify(sequence.rawSequence);
    const unresolvedInclusions = detectFeatureSequenceInclusions(sequence.elements, { ...options, ruleConfig, priceTolerance: tolerance });
    const status = unresolvedInclusions.length ? STATUS_RULE_UNSPECIFIED : STATUS_STANDARDIZED;
    const action = unresolvedInclusions.length ? FEATURE_STANDARDIZATION_ACTIONS.ruleUnspecified : FEATURE_STANDARDIZATION_ACTIONS.unchanged;
    const standardizedSequenceId = `${sequence.sequenceId}:standardized:${FEATURE_SEQUENCE_STANDARDIZER_VERSION}`;
    const standardizedContext = freeze({ ...sequence, standardizedSequenceId });
    const identityMappedElements = sequence.elements.map((element, index) => makeStandardizedElement(standardizedContext, [element], index, action, status));
    const elements = unresolvedInclusions.length ? [] : identityMappedElements;
    const unresolvedElementArchive = unresolvedInclusions.length ? identityMappedElements : [];
    const rawGapResult = clone(sequence.rawSequence.gaps || (core.detectFeatureSequenceGaps ? core.detectFeatureSequenceGaps(sequence.rawSequence.elements || [], { ...options, ruleConfig }) : []));
    const standardizedGapResult = core.detectFeatureSequenceGaps ? clone(core.detectFeatureSequenceGaps(elements, { ...options, ruleConfig, priceTolerance: tolerance })) : [];
    const rawAfter = core.canonicalStateJson ? core.canonicalStateJson(sequence.rawSequence) : JSON.stringify(sequence.rawSequence);
    if (rawBefore !== rawAfter) throw new Error('FeatureSequenceStandardizer mutated raw input');
    const activeFeatureMemory = freeze({
      recentStandardizedElements: elements.slice(-6),
      unresolvedInclusionsTail: clone(unresolvedInclusions.slice(-6)),
      status,
    });
    const packet = {
      sequenceId: standardizedSequenceId,
      sequence_id: standardizedSequenceId,
      rawSequenceId: sequence.sequenceId,
      raw_sequence_id: sequence.sequenceId,
      sequenceRole: sequence.sequenceRole,
      sequence_role: sequence.sequenceRole,
      segmentStartDirection: sequence.segmentStartDirection,
      segment_start_direction: sequence.segmentStartDirection,
      featureDirection: sequence.featureDirection,
      feature_direction: sequence.featureDirection,
      ruleVersion: ruleConfig.ruleVersion,
      rule_version: ruleConfig.ruleVersion,
      standardizerVersion: FEATURE_SEQUENCE_STANDARDIZER_VERSION,
      standardizer_version: FEATURE_SEQUENCE_STANDARDIZER_VERSION,
      standardizationStatus: status,
      standardization_status: status,
      status,
      inputElementCount: sequence.elements.length,
      input_element_count: sequence.elements.length,
      elementCount: elements.length,
      element_count: elements.length,
      elements: clone(elements),
      historicalFeatureArchive: clone(elements),
      historical_feature_archive: clone(elements),
      unresolvedElementArchive: clone(unresolvedElementArchive),
      unresolved_element_archive: clone(unresolvedElementArchive),
      activeFeatureMemory,
      active_feature_memory: activeFeatureMemory,
      activeFeatureMemorySize: core.estimateActiveMemorySize ? core.estimateActiveMemorySize(activeFeatureMemory) : JSON.stringify(activeFeatureMemory).length,
      active_feature_memory_size: core.estimateActiveMemorySize ? core.estimateActiveMemorySize(activeFeatureMemory) : JSON.stringify(activeFeatureMemory).length,
      rawGapResult,
      raw_gap_result: rawGapResult,
      standardizedGapResult,
      standardized_gap_result: standardizedGapResult,
      unresolvedInclusions: clone(unresolvedInclusions),
      unresolved_inclusions: clone(unresolvedInclusions),
      ruleUnspecified: unresolvedInclusions.length > 0,
      rule_unspecified: unresolvedInclusions.length > 0,
      ruleUnspecifiedCodes: unresolvedInclusions.length ? ['FEATURE_INCLUSION_MERGE_DIRECTION_UNSPECIFIED'] : [],
      rule_unspecified_codes: unresolvedInclusions.length ? ['FEATURE_INCLUSION_MERGE_DIRECTION_UNSPECIFIED'] : [],
      metadata: freeze({
        sourceLayer: 'rawFeatureSequence',
        standardizationPolicy: unresolvedInclusions.length
          ? 'inclusion-detected-but-merge-direction-is-not-finalized-in-contract'
          : 'identity-standardization-no-inclusion-detected',
        note: unresolvedInclusions.length
          ? 'Phase 5D records unresolved same-sequence inclusion without inventing merge rules.'
          : 'Phase 5D standardized an inclusion-free feature sequence by preserving topology.',
        confirmationRuleStatus: 'FEATURE_STANDARDIZATION_READY',
      }),
    };
    const frozen = freeze(packet);
    return core.attachStateHash ? core.attachStateHash(frozen) : frozen;
  }

  function standardizedFeatureSequenceToCompactRows(sequence) {
    if (!sequence || !Array.isArray(sequence.elements)) return [];
    return sequence.elements.map(element => [
      element.featureSequenceIndex,
      element.status,
      element.standardizationAction,
      element.priceLow,
      element.priceHigh,
      element.availableAtIndex,
      element.availableAtTime,
      element.sourceFeatureElementIds,
      element.sourceStrokeIds,
    ]);
  }

  Object.assign(core, {
    SEGMENT_FEATURE_STANDARDIZER_VERSION: FEATURE_SEQUENCE_STANDARDIZER_VERSION,
    FEATURE_SEQUENCE_STANDARDIZER_VERSION,
    FEATURE_STANDARDIZATION_ACTIONS,
    featureElementInclusion,
    featureElementInclusionInfo: featureElementInclusion,
    detectFeatureSequenceInclusions,
    detectFeatureElementInclusions: detectFeatureSequenceInclusions,
    normalizeRawFeatureSequence: validateRawSequence,
    standardizeFeatureSequence,
    standardizedFeatureSequenceToCompactRows,
    FEATURE_SEQUENCE_STANDARDIZATION_RUNTIME_STATUS: freeze({
      raw: STATUS_RAW,
      standardized: STATUS_STANDARDIZED,
      ruleUnspecified: STATUS_RULE_UNSPECIFIED,
      invalid: STATUS_INVALID,
    }),
  });
})();
