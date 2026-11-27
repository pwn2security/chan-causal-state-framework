(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};

  const SEGMENT_FEATURE_SEQUENCE_VERSION = 'feature-sequence-v0.1';
  const FEATURE_SEQUENCE_STANDARDIZATION_STATUS = Object.freeze({
    raw: 'RAW_NOT_STANDARDIZED',
    standardized: 'STANDARDIZED',
    ruleUnspecified: 'RULE_UNSPECIFIED',
    invalid: 'INVALID',
  });
  const FEATURE_SEQUENCE_ROLES = Object.freeze({
    primary: 'primary',
    reverse: 'reverse',
  });

  const STATUS_CONFIRMED = core.CT_STATUSES?.confirmed || 'CONFIRMED';
  const DIR_UP = core.CT_DIRECTIONS?.up || 'UP';
  const DIR_DOWN = core.CT_DIRECTIONS?.down || 'DOWN';

  function clone(value) {
    return core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  }

  function freeze(value) {
    return core.deepFreeze ? core.deepFreeze(value) : Object.freeze(value);
  }

  function finiteNumber(value, field) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`FeatureSequence ${field} must be finite`);
    return number;
  }

  function integerNumber(value, field) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      throw new Error(`FeatureSequence ${field} must be a non-negative integer`);
    }
    return number;
  }

  function normalizeDirection(value, field = 'direction') {
    const text = String(value || '').toUpperCase();
    if (text === DIR_UP || text === 'UP') return DIR_UP;
    if (text === DIR_DOWN || text === 'DOWN') return DIR_DOWN;
    throw new Error(`FeatureSequence ${field} must be UP or DOWN, got ${String(value)}`);
  }

  function oppositeDirection(direction) {
    const normalized = normalizeDirection(direction, 'direction');
    return normalized === DIR_UP ? DIR_DOWN : DIR_UP;
  }

  function normalizeInterval(input, field = 'interval') {
    if (!input || typeof input !== 'object') throw new Error(`FeatureSequence ${field} is required`);
    const low = finiteNumber(input.low ?? input.priceLow ?? input.price_low, `${field}.low`);
    const high = finiteNumber(input.high ?? input.priceHigh ?? input.price_high, `${field}.high`);
    return freeze({ low: Math.min(low, high), high: Math.max(low, high) });
  }

  function inputToStrokes(input) {
    const source = Array.isArray(input)
      ? input
      : (input?.confirmedStrokes || input?.strokes || input?.segmentInputStrokes || input?.inputStrokes || []);
    if (!Array.isArray(source)) throw new Error('buildFeatureSequence expects an array or a packet with confirmedStrokes');
    const strokes = [];
    for (let index = 0; index < source.length; index += 1) {
      const stroke = source[index];
      if (!stroke || typeof stroke !== 'object') throw new Error(`FeatureSequence strokes[${index}] is required`);
      const status = String(stroke.status || STATUS_CONFIRMED).toUpperCase();
      if (status !== STATUS_CONFIRMED) continue;
      const direction = normalizeDirection(stroke.direction, `strokes[${index}].direction`);
      const startPrice = finiteNumber(stroke.startPrice ?? stroke.start_price, `strokes[${index}].startPrice`);
      const endPrice = finiteNumber(stroke.endPrice ?? stroke.end_price, `strokes[${index}].endPrice`);
      const eventIndex = integerNumber(stroke.eventRawBarIndex ?? stroke.event_raw_bar_index ??
        stroke.eventIndex ?? stroke.event_index, `strokes[${index}].eventRawBarIndex`);
      const confirmIndex = integerNumber(stroke.confirmRawBarIndex ?? stroke.confirm_raw_bar_index ??
        stroke.confirmIndex ?? stroke.confirm_index, `strokes[${index}].confirmRawBarIndex`);
      const eventTime = finiteNumber(stroke.eventTime ?? stroke.event_time, `strokes[${index}].eventTime`);
      const confirmTime = finiteNumber(stroke.confirmTime ?? stroke.confirm_time, `strokes[${index}].confirmTime`);
      if (confirmIndex < eventIndex || confirmTime < eventTime) {
        throw new Error(`FeatureSequence strokes[${index}] confirm must be >= event`);
      }
      const strokeId = String(stroke.strokeId ?? stroke.stroke_id ?? stroke.structureId ?? stroke.structure_id ?? `stroke:${index}`);
      strokes.push(freeze({
        ...clone(stroke),
        structureId: String(stroke.structureId ?? stroke.structure_id ?? strokeId),
        strokeId,
        stroke_id: strokeId,
        status,
        direction,
        startPrice,
        start_price: startPrice,
        endPrice,
        end_price: endPrice,
        priceLow: Math.min(startPrice, endPrice),
        priceHigh: Math.max(startPrice, endPrice),
        price_low: Math.min(startPrice, endPrice),
        price_high: Math.max(startPrice, endPrice),
        eventRawBarIndex: eventIndex,
        event_raw_bar_index: eventIndex,
        eventIndex,
        event_index: eventIndex,
        eventTime,
        event_time: eventTime,
        availableRawBarIndex: integerNumber(stroke.availableRawBarIndex ?? stroke.available_raw_bar_index ??
          confirmIndex, `strokes[${index}].availableRawBarIndex`),
        available_raw_bar_index: integerNumber(stroke.availableRawBarIndex ?? stroke.available_raw_bar_index ??
          confirmIndex, `strokes[${index}].availableRawBarIndex`),
        availableTime: finiteNumber(stroke.availableTime ?? stroke.available_time ?? confirmTime,
          `strokes[${index}].availableTime`),
        available_time: finiteNumber(stroke.availableTime ?? stroke.available_time ?? confirmTime,
          `strokes[${index}].availableTime`),
        confirmRawBarIndex: confirmIndex,
        confirm_raw_bar_index: confirmIndex,
        confirmIndex,
        confirm_index: confirmIndex,
        confirmTime,
        confirm_time: confirmTime,
        sourceStrokeIndex: index,
      }));
    }
    for (let index = 1; index < strokes.length; index += 1) {
      if (strokes[index].confirmIndex < strokes[index - 1].confirmIndex) {
        throw new Error('FeatureSequence stroke confirmIndex must be non-decreasing');
      }
    }
    return strokes;
  }

  function resolveRuleConfig(options = {}) {
    if (typeof core.createCTRuleConfig === 'function') return core.createCTRuleConfig(options.ruleConfig || options);
    return freeze({
      ruleVersion: String(options.ruleVersion || options.rule_version || 'CT-R1.0'),
      priceTolerance: Number(options.priceTolerance || options.price_tolerance || 0),
      numericTolerance: Number(options.numericTolerance || options.numeric_tolerance || 1e-10),
    });
  }

  function resolveTolerance(options = {}, ruleConfig = null) {
    const value = options.priceTolerance ?? options.price_tolerance ?? ruleConfig?.priceTolerance ?? ruleConfig?.price_tolerance ?? 0;
    const tolerance = Number(value);
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('FeatureSequence tolerance must be a non-negative finite number');
    return tolerance;
  }

  function intervalsOverlap(left, right, tolerance = 0) {
    const a = normalizeInterval(left, 'left');
    const b = normalizeInterval(right, 'right');
    const tol = finiteNumber(tolerance, 'tolerance');
    if (tol < 0) throw new Error('FeatureSequence tolerance must be non-negative');
    return Math.max(a.low, b.low) <= Math.min(a.high, b.high) + tol;
  }

  function createFeatureElement(stroke, sequenceOrdinal, sequenceContext) {
    const priceLow = Math.min(stroke.startPrice, stroke.endPrice);
    const priceHigh = Math.max(stroke.startPrice, stroke.endPrice);
    const elementId = `${sequenceContext.sequenceId}:element:${sequenceOrdinal}:${stroke.strokeId}`;
    return freeze({
      elementId,
      element_id: elementId,
      sequenceId: sequenceContext.sequenceId,
      sequence_id: sequenceContext.sequenceId,
      sequenceRole: sequenceContext.sequenceRole,
      sequence_role: sequenceContext.sequenceRole,
      sequenceOrdinal,
      sequence_ordinal: sequenceOrdinal,
      sourceStrokeIndex: stroke.sourceStrokeIndex,
      source_stroke_index: stroke.sourceStrokeIndex,
      sourceStrokeId: stroke.strokeId,
      source_stroke_id: stroke.strokeId,
      segmentStartDirection: sequenceContext.segmentStartDirection,
      segment_start_direction: sequenceContext.segmentStartDirection,
      featureDirection: sequenceContext.featureDirection,
      feature_direction: sequenceContext.featureDirection,
      strokeDirection: stroke.direction,
      stroke_direction: stroke.direction,
      startPrice: stroke.startPrice,
      start_price: stroke.startPrice,
      endPrice: stroke.endPrice,
      end_price: stroke.endPrice,
      startTime: stroke.startTime,
      start_time: stroke.startTime,
      endTime: stroke.endTime,
      end_time: stroke.endTime,
      sourceStartTime: stroke.startTime,
      source_start_time: stroke.startTime,
      sourceEndTime: stroke.endTime,
      source_end_time: stroke.endTime,
      sourceRawStartIndex: stroke.startIndex,
      source_raw_start_index: stroke.startIndex,
      sourceRawEndIndex: stroke.endIndex,
      source_raw_end_index: stroke.endIndex,
      priceLow,
      priceHigh,
      price_low: priceLow,
      price_high: priceHigh,
      interval: freeze({ low: priceLow, high: priceHigh }),
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      eventRawBarIndex: stroke.eventRawBarIndex,
      event_raw_bar_index: stroke.eventRawBarIndex,
      eventIndex: stroke.eventIndex,
      event_index: stroke.eventIndex,
      eventTime: stroke.eventTime,
      event_time: stroke.eventTime,
      availableRawBarIndex: stroke.availableRawBarIndex,
      available_raw_bar_index: stroke.availableRawBarIndex,
      availableTime: stroke.availableTime,
      available_time: stroke.availableTime,
      confirmRawBarIndex: stroke.confirmRawBarIndex,
      confirm_raw_bar_index: stroke.confirmRawBarIndex,
      confirmIndex: stroke.confirmIndex,
      confirm_index: stroke.confirmIndex,
      confirmTime: stroke.confirmTime,
      confirm_time: stroke.confirmTime,
      eventStrokeIndex: stroke.sourceStrokeIndex,
      event_stroke_index: stroke.sourceStrokeIndex,
      availableStrokeIndex: stroke.sourceStrokeIndex,
      available_stroke_index: stroke.sourceStrokeIndex,
      confirmStrokeIndex: stroke.sourceStrokeIndex,
      confirm_stroke_index: stroke.sourceStrokeIndex,
      eventFeatureIndex: sequenceOrdinal,
      event_feature_index: sequenceOrdinal,
      availableFeatureIndex: sequenceOrdinal,
      available_feature_index: sequenceOrdinal,
      confirmFeatureIndex: sequenceOrdinal,
      confirm_feature_index: sequenceOrdinal,
      provenance: freeze({
        rawFeatureElementId: elementId,
        strokeId: stroke.strokeId,
        fractalIds: [stroke.startFractalId, stroke.endFractalId],
        rawObservationRange: [stroke.startIndex, stroke.endIndex],
      }),
      sourceStroke: freeze(clone(stroke)),
    });
  }

  function featureElementGap(left, right, options = {}) {
    const tolerance = resolveTolerance(options, options.ruleConfig);
    const leftInterval = normalizeInterval(left.interval || left, 'left');
    const rightInterval = normalizeInterval(right.interval || right, 'right');
    const overlapLow = Math.max(leftInterval.low, rightInterval.low);
    const overlapHigh = Math.min(leftInterval.high, rightInterval.high);
    const hasGap = overlapLow > overlapHigh + tolerance;
    const gapSize = hasGap ? overlapLow - overlapHigh : 0;
    return freeze({
      leftElementId: String(left.elementId ?? left.element_id ?? ''),
      left_element_id: String(left.elementId ?? left.element_id ?? ''),
      rightElementId: String(right.elementId ?? right.element_id ?? ''),
      right_element_id: String(right.elementId ?? right.element_id ?? ''),
      leftInterval,
      left_interval: leftInterval,
      rightInterval,
      right_interval: rightInterval,
      hasGap,
      has_gap: hasGap,
      gapSize,
      gap_size: gapSize,
      gapLower: hasGap ? overlapHigh : null,
      gap_lower: hasGap ? overlapHigh : null,
      gapUpper: hasGap ? overlapLow : null,
      gap_upper: hasGap ? overlapLow : null,
      overlapLow: hasGap ? null : overlapLow,
      overlap_low: hasGap ? null : overlapLow,
      overlapHigh: hasGap ? null : overlapHigh,
      overlap_high: hasGap ? null : overlapHigh,
      tolerance,
    });
  }

  function detectFeatureSequenceGaps(elements, options = {}) {
    if (!Array.isArray(elements)) throw new Error('detectFeatureSequenceGaps expects elements array');
    const gaps = [];
    for (let index = 1; index < elements.length; index += 1) {
      gaps.push(freeze({
        pairIndex: index - 1,
        pair_index: index - 1,
        ...featureElementGap(elements[index - 1], elements[index], options),
      }));
    }
    return freeze(gaps);
  }

  function makeSequenceId(ruleConfig, sequenceRole, segmentStartDirection, firstStroke) {
    const seed = firstStroke?.strokeId || 'empty';
    return `${ruleConfig.ruleVersion}:segment-feature:${SEGMENT_FEATURE_SEQUENCE_VERSION}:${sequenceRole}:${segmentStartDirection}:${seed}`;
  }

  function buildFeatureSequence(input, options = {}) {
    const strokes = inputToStrokes(input);
    const ruleConfig = resolveRuleConfig(options);
    const segmentStartDirection = normalizeDirection(
      options.segmentStartDirection ?? options.segment_start_direction ?? strokes[0]?.direction ?? DIR_UP,
      'segmentStartDirection',
    );
    const featureDirection = normalizeDirection(
      options.featureDirection ?? options.feature_direction ?? oppositeDirection(segmentStartDirection),
      'featureDirection',
    );
    const sequenceRole = String(options.sequenceRole || options.sequence_role || FEATURE_SEQUENCE_ROLES.primary);
    if (!Object.values(FEATURE_SEQUENCE_ROLES).includes(sequenceRole)) {
      throw new Error(`FeatureSequence sequenceRole must be primary or reverse, got ${sequenceRole}`);
    }
    const sequenceId = String(options.sequenceId || options.sequence_id || makeSequenceId(ruleConfig, sequenceRole, segmentStartDirection, strokes[0]));
    const sequenceContext = freeze({ sequenceId, sequenceRole, segmentStartDirection, featureDirection });
    const elements = strokes
      .filter(stroke => stroke.direction === featureDirection)
      .map((stroke, index) => createFeatureElement(stroke, index, sequenceContext));
    const gaps = detectFeatureSequenceGaps(elements, { ...options, ruleConfig });
    return freeze({
      sequenceId,
      sequence_id: sequenceId,
      sequenceRole,
      sequence_role: sequenceRole,
      segmentStartDirection,
      segment_start_direction: segmentStartDirection,
      featureDirection,
      feature_direction: featureDirection,
      ruleVersion: ruleConfig.ruleVersion,
      rule_version: ruleConfig.ruleVersion,
      featureSequenceVersion: SEGMENT_FEATURE_SEQUENCE_VERSION,
      feature_sequence_version: SEGMENT_FEATURE_SEQUENCE_VERSION,
      standardizationStatus: FEATURE_SEQUENCE_STANDARDIZATION_STATUS.raw,
      standardization_status: FEATURE_SEQUENCE_STANDARDIZATION_STATUS.raw,
      inputStrokeCount: strokes.length,
      input_stroke_count: strokes.length,
      elementCount: elements.length,
      element_count: elements.length,
      elements: clone(elements),
      gaps: clone(gaps),
      hasAnyGap: gaps.some(gap => gap.hasGap),
      has_any_gap: gaps.some(gap => gap.hasGap),
      metadata: freeze({
        note: 'Phase 5C builds raw characteristic sequences and gap records only. It does not standardize inclusion or confirm segments.',
        sourceLayer: 'confirmedStrokes',
        confirmationRuleStatus: 'NOT_EVALUATED',
      }),
    });
  }

  function buildReverseFeatureSequence(input, options = {}) {
    const baseDirection = normalizeDirection(
      options.segmentStartDirection ?? options.segment_start_direction ?? input?.segmentStartDirection ?? input?.segment_start_direction ?? DIR_UP,
      'segmentStartDirection',
    );
    return buildFeatureSequence(input, {
      ...options,
      segmentStartDirection: oppositeDirection(baseDirection),
      sequenceRole: FEATURE_SEQUENCE_ROLES.reverse,
    });
  }

  // Incremental Case-2 adapter. It reuses the Phase 5C element constructor but
  // emits at most one reverse raw element for one newly confirmed Stroke.
  // The caller owns the monotonically increasing sequenceOrdinal and stable
  // sequenceId; no historical Stroke archive is scanned here.
  function buildReverseFeatureElement(inputStroke, options = {}) {
    const candidateDirection = normalizeDirection(
      options.candidateSegmentDirection ?? options.candidate_segment_direction ??
        options.segmentStartDirection ?? options.segment_start_direction,
      'candidateSegmentDirection',
    );
    const strokes = inputToStrokes([inputStroke]);
    if (!strokes.length) return null;
    const stroke = strokes[0];
    if (stroke.direction !== candidateDirection) return null;
    const ordinal = integerNumber(
      options.sequenceOrdinal ?? options.sequence_ordinal ?? 0,
      'sequenceOrdinal',
    );
    const ruleConfig = resolveRuleConfig(options);
    const sequenceId = String(options.sequenceId ?? options.sequence_id ?? '');
    if (!sequenceId) throw new Error('buildReverseFeatureElement requires stable sequenceId');
    const context = freeze({
      sequenceId,
      sequenceRole: FEATURE_SEQUENCE_ROLES.reverse,
      segmentStartDirection: oppositeDirection(candidateDirection),
      featureDirection: candidateDirection,
    });
    return createFeatureElement(stroke, ordinal, context);
  }

  function featureSequenceToCompactRows(sequence) {
    if (!sequence || !Array.isArray(sequence.elements)) return [];
    return sequence.elements.map(element => [
      element.sequenceOrdinal,
      element.sourceStrokeIndex,
      element.sourceStrokeId,
      element.strokeDirection,
      element.priceLow,
      element.priceHigh,
      element.eventIndex,
      element.confirmIndex,
    ]);
  }

  Object.assign(core, {
    SEGMENT_FEATURE_SEQUENCE_VERSION,
    FEATURE_SEQUENCE_STANDARDIZATION_STATUS,
    FEATURE_SEQUENCE_ROLES,
    oppositeSegmentDirection: oppositeDirection,
    intervalsOverlap,
    featureElementGap,
    detectFeatureSequenceGaps,
    buildFeatureSequence,
    buildReverseFeatureSequence,
    buildReverseFeatureElement,
    featureSequenceToCompactRows,
  });
})();
