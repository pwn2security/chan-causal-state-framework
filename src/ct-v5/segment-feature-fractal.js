(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};

  const SEGMENT_FEATURE_FRACTAL_VERSION = 'feature-fractal-v0.1';
  const FEATURE_FRACTAL_TYPES = Object.freeze({
    top: 'FEATURE_TOP',
    bottom: 'FEATURE_BOTTOM',
  });
  const STATUS_STANDARDIZED = core.FEATURE_SEQUENCE_STANDARDIZATION_STATUS?.standardized || 'STANDARDIZED';
  const STATUS_RULE_UNSPECIFIED = core.FEATURE_SEQUENCE_STANDARDIZATION_STATUS?.ruleUnspecified || 'RULE_UNSPECIFIED';
  const STATUS_INVALID = core.FEATURE_SEQUENCE_STANDARDIZATION_STATUS?.invalid || 'INVALID';
  const STATUS_CANDIDATE = core.CT_STATUSES?.candidate || 'CANDIDATE';
  const STATUS_CONFIRMED = core.CT_STATUSES?.confirmed || 'CONFIRMED';
  const STATUS_INVALIDATED = core.CT_STATUSES?.invalidated || 'INVALIDATED';
  const EVENT_CANDIDATE = core.CT_EVENT_ACTIONS?.candidate || 'CANDIDATE';
  const EVENT_CONFIRMED = core.CT_EVENT_ACTIONS?.confirmed || 'CONFIRMED';
  const EVENT_INVALIDATED = core.CT_EVENT_ACTIONS?.invalidated || 'INVALIDATED';
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
    if (!Number.isFinite(number)) throw new Error(`FeatureFractal ${field} must be finite`);
    return number;
  }

  function optionalFinite(value, field, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    return finiteNumber(value, field);
  }

  function nonNegativeInteger(value, field) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      throw new Error(`FeatureFractal ${field} must be a non-negative integer`);
    }
    return number;
  }

  function nonNegativeTolerance(value, field = 'priceTolerance') {
    const number = Number(value ?? 0);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`FeatureFractal ${field} must be a non-negative finite number`);
    }
    return number;
  }

  function normalizeDirection(value, field = 'direction') {
    const text = String(value || '').toUpperCase();
    if (text === DIR_UP || text === 'UP') return DIR_UP;
    if (text === DIR_DOWN || text === 'DOWN') return DIR_DOWN;
    throw new Error(`FeatureFractal ${field} must be UP or DOWN, got ${String(value)}`);
  }

  function resolveRuleConfig(input = {}) {
    if (typeof core.createCTRuleConfig === 'function') return core.createCTRuleConfig(input.ruleConfig || input);
    return freeze({
      ruleVersion: String(input.ruleVersion || input.rule_version || 'CT-R1.0'),
      priceTolerance: nonNegativeTolerance(input.priceTolerance || input.price_tolerance || 0),
      numericTolerance: nonNegativeTolerance(input.numericTolerance || input.numeric_tolerance || 1e-10, 'numericTolerance'),
    });
  }

  function resolveTolerance(options = {}, ruleConfig = null) {
    return nonNegativeTolerance(options.priceTolerance ?? options.price_tolerance ?? ruleConfig?.priceTolerance ?? ruleConfig?.price_tolerance ?? 0);
  }

  function uniqueStable(values) {
    const seen = new Set();
    const output = [];
    for (const value of values) {
      const text = String(value || '');
      if (!text || seen.has(text)) continue;
      seen.add(text);
      output.push(text);
    }
    return output;
  }

  function elementLow(element) {
    return finiteNumber(element.low ?? element.priceLow ?? element.price_low ?? element.interval?.low, 'element.low');
  }

  function elementHigh(element) {
    return finiteNumber(element.high ?? element.priceHigh ?? element.price_high ?? element.interval?.high, 'element.high');
  }

  function sourceFeatureIdsOf(element) {
    const ids = element.sourceFeatureElementIds || element.source_feature_element_ids;
    if (Array.isArray(ids) && ids.length) return uniqueStable(ids);
    const single = element.featureElementId ?? element.feature_element_id ?? element.elementId ?? element.element_id;
    if (!single) throw new Error('FeatureFractal standardized element missing sourceFeatureElementIds');
    return [String(single)];
  }

  function sourceStrokeIdsOf(element) {
    const ids = element.sourceStrokeIds || element.source_stroke_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error(`FeatureFractal element ${String(element.featureElementId || element.elementId || '')} missing sourceStrokeIds`);
    }
    return uniqueStable(ids);
  }

  function normalizeStandardizedElement(element, index, sequenceId) {
    if (!element || typeof element !== 'object') throw new Error(`FeatureFractal elements[${index}] is required`);
    const featureElementId = String(element.featureElementId ?? element.feature_element_id ?? element.elementId ?? element.element_id ?? '');
    if (!featureElementId) throw new Error(`FeatureFractal elements[${index}] missing featureElementId`);
    const elementSequenceId = String(element.sequenceId ?? element.sequence_id ?? '');
    if (elementSequenceId && elementSequenceId !== sequenceId) {
      throw new Error(`FeatureFractal cross sequence element ${featureElementId} belongs to ${elementSequenceId}, expected ${sequenceId}`);
    }
    const low = elementLow(element);
    const high = elementHigh(element);
    if (high < low) throw new Error(`FeatureFractal element ${featureElementId} high must be >= low`);
    const sourceFeatureElementIds = sourceFeatureIdsOf(element);
    const sourceStrokeIds = sourceStrokeIdsOf(element);
    const featureSequenceIndex = nonNegativeInteger(
      element.featureSequenceIndex ?? element.feature_sequence_index ?? element.sequenceOrdinal ?? element.sequence_ordinal ?? index,
      `elements[${index}].featureSequenceIndex`,
    );
    const availableRawBarIndex = nonNegativeInteger(
      element.availableRawBarIndex ?? element.available_raw_bar_index ?? element.availableAtIndex ?? element.available_at_index ?? element.confirmIndex ?? element.confirm_index,
      `elements[${index}].availableRawBarIndex`,
    );
    const availableAtTime = finiteNumber(
      element.availableTime ?? element.available_time ?? element.availableAtTime ??
        element.available_at_time ?? element.confirmTime ?? element.confirm_time,
      `elements[${index}].availableTime`,
    );
    const eventIndex = nonNegativeInteger(
      element.eventRawBarIndex ?? element.event_raw_bar_index ??
        element.eventIndex ?? element.event_index ?? availableRawBarIndex,
      `elements[${index}].eventRawBarIndex`,
    );
    const eventTime = finiteNumber(
      element.eventTime ?? element.event_time ?? availableAtTime,
      `elements[${index}].eventTime`,
    );
    const confirmIndex = nonNegativeInteger(
      element.confirmRawBarIndex ?? element.confirm_raw_bar_index ??
        element.confirmIndex ?? element.confirm_index ?? availableRawBarIndex,
      `elements[${index}].confirmRawBarIndex`,
    );
    const confirmTime = finiteNumber(
      element.confirmTime ?? element.confirm_time ?? availableAtTime,
      `elements[${index}].confirmTime`,
    );
    if (availableRawBarIndex < eventIndex || availableAtTime < eventTime) {
      throw new Error(`FeatureFractal element ${featureElementId} available must be >= event`);
    }
    if (confirmIndex < availableRawBarIndex || confirmTime < availableAtTime) {
      throw new Error(`FeatureFractal element ${featureElementId} confirm must be >= available`);
    }
    return freeze({
      ...clone(element),
      featureElementId,
      feature_element_id: featureElementId,
      elementId: featureElementId,
      element_id: featureElementId,
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      sequenceId,
      sequence_id: sequenceId,
      featureSequenceIndex,
      feature_sequence_index: featureSequenceIndex,
      low,
      high,
      priceLow: low,
      priceHigh: high,
      price_low: low,
      price_high: high,
      interval: freeze({ low, high }),
      sourceFeatureElementIds,
      source_feature_element_ids: sourceFeatureElementIds,
      sourceStrokeIds,
      source_stroke_ids: sourceStrokeIds,
      availableRawBarIndex,
      available_raw_bar_index: availableRawBarIndex,
      availableTime: availableAtTime,
      available_time: availableAtTime,
      availableAtIndex: availableRawBarIndex,
      available_at_index: availableRawBarIndex,
      availableAtTime,
      available_at_time: availableAtTime,
      eventRawBarIndex: eventIndex,
      event_raw_bar_index: eventIndex,
      eventIndex,
      event_index: eventIndex,
      eventTime,
      event_time: eventTime,
      confirmRawBarIndex: confirmIndex,
      confirm_raw_bar_index: confirmIndex,
      confirmIndex,
      confirm_index: confirmIndex,
      confirmTime,
      confirm_time: confirmTime,
    });
  }

  function validateStandardizedSequence(sequence) {
    if (!sequence || typeof sequence !== 'object') throw new Error('FeatureFractal expects a standardized feature sequence object');
    const status = sequence.standardizationStatus ?? sequence.standardization_status ?? sequence.status;
    const sequenceId = String(sequence.sequenceId ?? sequence.sequence_id ?? '');
    if (!sequenceId) throw new Error('FeatureFractal standardized sequence missing sequenceId');
    const featureDirection = normalizeDirection(sequence.featureDirection ?? sequence.feature_direction, 'featureDirection');
    const segmentStartDirection = normalizeDirection(sequence.segmentStartDirection ?? sequence.segment_start_direction, 'segmentStartDirection');
    if (status !== STATUS_STANDARDIZED) {
      return freeze({
        consumable: false,
        status: status === STATUS_RULE_UNSPECIFIED ? STATUS_RULE_UNSPECIFIED : STATUS_INVALID,
        reason: `FeatureFractalDetector consumes only ${STATUS_STANDARDIZED} sequences, got ${String(status)}`,
        sequenceId,
        featureDirection,
        segmentStartDirection,
        elements: [],
      });
    }
    if (!Array.isArray(sequence.elements)) throw new Error('FeatureFractal standardized sequence missing elements');
    const elements = sequence.elements.map((element, index) => normalizeStandardizedElement(element, index, sequenceId));
    for (let index = 1; index < elements.length; index += 1) {
      if (elements[index].featureSequenceIndex <= elements[index - 1].featureSequenceIndex) {
        throw new Error('FeatureFractal featureSequenceIndex must be strictly increasing');
      }
      if (elements[index].availableRawBarIndex < elements[index - 1].availableRawBarIndex) {
        throw new Error('FeatureFractal availableRawBarIndex must be non-decreasing');
      }
    }
    return freeze({
      consumable: true,
      status: STATUS_STANDARDIZED,
      sequenceId,
      featureDirection,
      segmentStartDirection,
      sequenceRole: sequence.sequenceRole ?? sequence.sequence_role ?? null,
      ruleVersion: String(sequence.ruleVersion ?? sequence.rule_version ?? 'CT-R1.0'),
      elements,
      rawElementCount: Number(sequence.rawElementCount ?? sequence.raw_element_count ?? sequence.elements.length),
      activeFeatureMemorySize: Number(sequence.activeFeatureMemorySize ?? sequence.active_feature_memory_size ?? elements.length),
    });
  }

  function isFeatureTop(left, middle, right, tolerance = 0) {
    const tol = nonNegativeTolerance(tolerance);
    return middle.high > left.high + tol &&
      middle.high > right.high + tol &&
      middle.low > left.low + tol &&
      middle.low > right.low + tol;
  }

  function isFeatureBottom(left, middle, right, tolerance = 0) {
    const tol = nonNegativeTolerance(tolerance);
    return middle.high < left.high - tol &&
      middle.high < right.high - tol &&
      middle.low < left.low - tol &&
      middle.low < right.low - tol;
  }

  function featureFractalTypeOfTriple(left, middle, right, tolerance = 0) {
    if (isFeatureTop(left, middle, right, tolerance)) return FEATURE_FRACTAL_TYPES.top;
    if (isFeatureBottom(left, middle, right, tolerance)) return FEATURE_FRACTAL_TYPES.bottom;
    return null;
  }

  function candidateTypeFromPair(previous, current, tolerance = 0) {
    const tol = nonNegativeTolerance(tolerance);
    if (current.high > previous.high + tol && current.low > previous.low + tol) return FEATURE_FRACTAL_TYPES.top;
    if (current.high < previous.high - tol && current.low < previous.low - tol) return FEATURE_FRACTAL_TYPES.bottom;
    return null;
  }

  function eventIdFor(fractal, action) {
    return `${fractal.ruleVersion}:feature-fractal-event:${fractal.featureFractalId}:${action}:${fractal.confirmRawBarIndex ?? fractal.eventRawBarIndex}`;
  }

  function makeEvent(fractal, action, element, metadata = {}) {
    const barIndex = element?.availableRawBarIndex ?? fractal.confirmRawBarIndex ?? fractal.eventRawBarIndex;
    const barTime = element?.availableAtTime ?? fractal.confirmTime ?? fractal.eventTime;
    return freeze({
      eventId: eventIdFor(fractal, action),
      event_id: eventIdFor(fractal, action),
      uniqueId: eventIdFor(fractal, action),
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      eventAction: action,
      event_action: action,
      structureType: 'featureFractal',
      structure_type: 'featureFractal',
      structureId: fractal.featureFractalId,
      structure_id: fractal.featureFractalId,
      barIndex,
      bar_index: barIndex,
      barTime,
      bar_time: barTime,
      eventFeatureIndex: fractal.eventFeatureIndex,
      event_feature_index: fractal.eventFeatureIndex,
      confirmFeatureIndex: fractal.confirmFeatureIndex,
      confirm_feature_index: fractal.confirmFeatureIndex,
      eventRawBarIndex: fractal.eventRawBarIndex,
      event_raw_bar_index: fractal.eventRawBarIndex,
      confirmRawBarIndex: fractal.confirmRawBarIndex,
      confirm_raw_bar_index: fractal.confirmRawBarIndex,
      eventTime: fractal.eventTime,
      event_time: fractal.eventTime,
      availableRawBarIndex: fractal.availableRawBarIndex,
      available_raw_bar_index: fractal.availableRawBarIndex,
      availableTime: fractal.availableTime,
      available_time: fractal.availableTime,
      confirmTime: fractal.confirmTime,
      confirm_time: fractal.confirmTime,
      ruleVersion: fractal.ruleVersion,
      rule_version: fractal.ruleVersion,
      featureFractalVersion: SEGMENT_FEATURE_FRACTAL_VERSION,
      feature_fractal_version: SEGMENT_FEATURE_FRACTAL_VERSION,
      provenance: fractal.provenance,
      metadata: freeze({ ...metadata }),
    });
  }

  function makeFeatureFractal(type, left, middle, right, context, ruleConfig, status = STATUS_CONFIRMED) {
    const sourceElements = [left, middle, right].filter(Boolean);
    const sourceFeatureElementIds = uniqueStable(sourceElements.flatMap(sourceFeatureIdsOf));
    const sourceStrokeIds = uniqueStable(sourceElements.flatMap(sourceStrokeIdsOf));
    const sourceStandardizedFeatureElementIds = sourceElements.map(element => element.featureElementId);
    const sourceFractalIds = uniqueStable(sourceElements.flatMap(element => element.provenance?.fractalIds || []));
    const sourceNormalizedKIds = uniqueStable(sourceElements.flatMap(element => element.provenance?.normalizedKIds || []));
    const confirmElement = right || middle;
    const confirmFeatureIndex = right ? right.featureSequenceIndex : null;
    const confirmRawBarIndex = right ? right.availableRawBarIndex : null;
    const confirmTime = right ? right.availableAtTime : null;
    const featureFractalId = `${context.sequenceId}:feature-fractal:${type}:${middle.featureSequenceIndex}:${middle.featureElementId}`;
    return freeze({
      featureFractalId,
      feature_fractal_id: featureFractalId,
      structureId: featureFractalId,
      structure_id: featureFractalId,
      schemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      type,
      featureSequenceDirection: context.featureDirection,
      feature_sequence_direction: context.featureDirection,
      segmentStartDirection: context.segmentStartDirection,
      segment_start_direction: context.segmentStartDirection,
      eventFeatureIndex: middle.featureSequenceIndex,
      event_feature_index: middle.featureSequenceIndex,
      confirmFeatureIndex,
      confirm_feature_index: confirmFeatureIndex,
      eventRawBarIndex: middle.eventRawBarIndex,
      event_raw_bar_index: middle.eventRawBarIndex,
      eventIndex: middle.eventRawBarIndex,
      event_index: middle.eventRawBarIndex,
      availableRawBarIndex: middle.availableRawBarIndex,
      available_raw_bar_index: middle.availableRawBarIndex,
      availableFeatureIndex: middle.featureSequenceIndex,
      available_feature_index: middle.featureSequenceIndex,
      confirmRawBarIndex,
      confirm_raw_bar_index: confirmRawBarIndex,
      confirmIndex: confirmRawBarIndex,
      confirm_index: confirmRawBarIndex,
      eventTime: middle.eventTime,
      event_time: middle.eventTime,
      availableTime: middle.availableTime,
      available_time: middle.availableTime,
      confirmTime,
      confirm_time: confirmTime,
      priceHigh: middle.high,
      priceLow: middle.low,
      price_high: middle.high,
      price_low: middle.low,
      sourceFeatureElementIds,
      source_feature_element_ids: sourceFeatureElementIds,
      sourceStandardizedFeatureElementIds,
      source_standardized_feature_element_ids: sourceStandardizedFeatureElementIds,
      sourceStrokeIds,
      source_stroke_ids: sourceStrokeIds,
      status,
      ruleVersion: ruleConfig.ruleVersion,
      rule_version: ruleConfig.ruleVersion,
      featureFractalVersion: SEGMENT_FEATURE_FRACTAL_VERSION,
      feature_fractal_version: SEGMENT_FEATURE_FRACTAL_VERSION,
      provenance: freeze({
        featureFractalId,
        standardizedFeatureElementIds: sourceStandardizedFeatureElementIds,
        rawFeatureElementIds: sourceFeatureElementIds,
        strokeIds: sourceStrokeIds,
        fractalIds: sourceFractalIds,
        normalizedKIds: sourceNormalizedKIds,
        rawObservationRanges: sourceElements.map(element => [
          element.sourceRawStartIndex ?? element.geometricSourceStartIndex ?? element.eventRawBarIndex,
          element.sourceRawEndIndex ?? element.geometricSourceEndIndex ?? element.eventRawBarIndex,
        ]),
        eventSourceStandardizedFeatureElementId: middle.featureElementId,
      }),
      metadata: freeze({
        sourceLayer: 'standardizedFeatureElements',
        detectorKind: 'standalone-feature-fractal-detector',
        provisional: status === STATUS_CANDIDATE,
        confirmElementId: confirmElement?.featureElementId ?? null,
        note: 'eventTime is the middle standardized feature geometric source time; availableTime is middle-feature sealing availability; confirmTime is right stable evidence availability.',
      }),
    });
  }

  function makeCandidateFeatureFractal(previous, current, context, ruleConfig, tolerance = 0) {
    const type = candidateTypeFromPair(previous, current, tolerance);
    if (!type) return null;
    return makeFeatureFractal(type, previous, current, null, context, ruleConfig, STATUS_CANDIDATE);
  }

  function makeInvalidatedFeatureFractal(candidate, invalidatingElement) {
    if (!candidate) return null;
    const invalidated = freeze({
      ...clone(candidate),
      status: STATUS_INVALIDATED,
      confirmFeatureIndex: invalidatingElement.featureSequenceIndex,
      confirm_feature_index: invalidatingElement.featureSequenceIndex,
      confirmRawBarIndex: invalidatingElement.availableRawBarIndex,
      confirm_raw_bar_index: invalidatingElement.availableRawBarIndex,
      confirmIndex: invalidatingElement.availableRawBarIndex,
      confirm_index: invalidatingElement.availableRawBarIndex,
      confirmTime: invalidatingElement.availableAtTime,
      confirm_time: invalidatingElement.availableAtTime,
      metadata: freeze({
        ...(candidate.metadata || {}),
        provisional: false,
        invalidatedByFeatureElementId: invalidatingElement.featureElementId,
        invalidationReason: 'candidate_did_not_satisfy_strict_three-element_feature_fractal_rule',
      }),
    });
    return invalidated;
  }

  function compactFractalKey(fractal) {
    if (!fractal) return null;
    return `${fractal.type}:${fractal.status}:${fractal.eventFeatureIndex}:${fractal.confirmFeatureIndex ?? 'na'}:${fractal.eventRawBarIndex}:${fractal.confirmRawBarIndex ?? 'na'}`;
  }

  function featureFractalToCompactRow(fractal) {
    if (!fractal) return null;
    return [
      fractal.featureFractalId,
      fractal.type,
      fractal.status,
      fractal.eventFeatureIndex,
      fractal.confirmFeatureIndex,
      fractal.eventRawBarIndex,
      fractal.availableRawBarIndex,
      fractal.confirmRawBarIndex,
      fractal.eventTime,
      fractal.availableTime,
      fractal.confirmTime,
      fractal.priceLow,
      fractal.priceHigh,
      fractal.sourceFeatureElementIds,
      fractal.sourceStrokeIds,
    ];
  }

  function featureFractalsToCompactRows(fractals) {
    if (!Array.isArray(fractals)) return [];
    return fractals.map(featureFractalToCompactRow);
  }

  function evaluateFeatureFractalState(standardizedSequence, options = {}) {
    const ruleConfig = resolveRuleConfig(options);
    const tolerance = resolveTolerance(options, ruleConfig);
    const normalized = validateStandardizedSequence(standardizedSequence);
    if (!normalized.consumable) {
      const packet = {
        sequenceId: normalized.sequenceId,
        sequence_id: normalized.sequenceId,
        status: normalized.status,
        featureFractalVersion: SEGMENT_FEATURE_FRACTAL_VERSION,
        feature_fractal_version: SEGMENT_FEATURE_FRACTAL_VERSION,
        reason: normalized.reason,
        elementsConsumed: 0,
        elements_consumed: 0,
        confirmedFeatureFractals: [],
        confirmed_feature_fractals: [],
        candidateFeatureFractal: null,
        candidate_feature_fractal: null,
        invalidatedFeatureFractals: [],
        invalidated_feature_fractals: [],
        events: [],
        activeFeatureMemorySize: 0,
        active_feature_memory_size: 0,
        metadata: freeze({
          confirmationRuleStatus: 'NOT_EVALUATED',
          segmentOutputProduced: false,
        }),
      };
      const frozen = freeze(packet);
      return core.attachStateHash ? core.attachStateHash(frozen) : frozen;
    }
    const context = {
      sequenceId: normalized.sequenceId,
      featureDirection: normalized.featureDirection,
      segmentStartDirection: normalized.segmentStartDirection,
    };
    const confirmed = [];
    const invalidated = [];
    let candidate = null;
    const transitionEvents = [];
    for (let index = 0; index < normalized.elements.length; index += 1) {
      const current = normalized.elements[index];
      if (index > 1 && candidate && candidate.eventFeatureIndex === normalized.elements[index - 1].featureSequenceIndex) {
        const left = normalized.elements[index - 2];
        const middle = normalized.elements[index - 1];
        const type = featureFractalTypeOfTriple(left, middle, current, tolerance);
        if (type === candidate.type) {
          const fractal = makeFeatureFractal(type, left, middle, current, context, ruleConfig, STATUS_CONFIRMED);
          confirmed.push(fractal);
          transitionEvents.push(makeEvent(fractal, EVENT_CONFIRMED, current, {
            previousCandidateId: candidate.featureFractalId,
          }));
        } else {
          const invalidatedCandidate = makeInvalidatedFeatureFractal(candidate, current);
          invalidated.push(invalidatedCandidate);
          transitionEvents.push(makeEvent(invalidatedCandidate, EVENT_INVALIDATED, current, {
            previousCandidateId: candidate.featureFractalId,
          }));
        }
        candidate = null;
      }
      if (index >= 1) {
        const previous = normalized.elements[index - 1];
        const nextCandidate = makeCandidateFeatureFractal(previous, current, context, ruleConfig, tolerance);
        candidate = nextCandidate;
        if (nextCandidate) {
          transitionEvents.push(makeEvent(nextCandidate, EVENT_CANDIDATE, current, {
            previousElementId: previous.featureElementId,
          }));
        }
      }
    }
    const lastElement = normalized.elements[normalized.elements.length - 1] || null;
    const activeFeatureMemorySize = core.estimateActiveMemorySize
      ? core.estimateActiveMemorySize({ lastTwoElements: normalized.elements.slice(-2), candidate })
      : normalized.elements.slice(-2).length + (candidate ? 1 : 0);
    const packet = {
      sequenceId: normalized.sequenceId,
      sequence_id: normalized.sequenceId,
      status: STATUS_STANDARDIZED,
      featureFractalVersion: SEGMENT_FEATURE_FRACTAL_VERSION,
      feature_fractal_version: SEGMENT_FEATURE_FRACTAL_VERSION,
      ruleVersion: ruleConfig.ruleVersion,
      rule_version: ruleConfig.ruleVersion,
      priceTolerance: tolerance,
      price_tolerance: tolerance,
      featureSequenceDirection: normalized.featureDirection,
      feature_sequence_direction: normalized.featureDirection,
      segmentStartDirection: normalized.segmentStartDirection,
      segment_start_direction: normalized.segmentStartDirection,
      elementsConsumed: normalized.elements.length,
      elements_consumed: normalized.elements.length,
      currentFeatureIndex: lastElement?.featureSequenceIndex ?? -1,
      current_feature_index: lastElement?.featureSequenceIndex ?? -1,
      currentRawBarIndex: lastElement?.availableRawBarIndex ?? null,
      current_raw_bar_index: lastElement?.availableRawBarIndex ?? null,
      currentTime: lastElement?.availableAtTime ?? null,
      current_time: lastElement?.availableAtTime ?? null,
      confirmedFeatureFractals: clone(confirmed),
      confirmed_feature_fractals: clone(confirmed),
      candidateFeatureFractal: candidate ? clone(candidate) : null,
      candidate_feature_fractal: candidate ? clone(candidate) : null,
      invalidatedFeatureFractals: clone(invalidated),
      invalidated_feature_fractals: clone(invalidated),
      events: clone(transitionEvents),
      activeFeatureMemorySize,
      active_feature_memory_size: activeFeatureMemorySize,
      metadata: freeze({
        sourceLayer: 'standardizedFeatureSequence',
        confirmationRuleStatus: 'FEATURE_FRACTAL_READY',
        segmentOutputProduced: false,
        note: 'Phase 5D stops at FeatureFractalDetector; Segment Case 1/2 is intentionally not evaluated.',
      }),
    };
    const frozen = freeze(packet);
    return core.attachStateHash ? core.attachStateHash(frozen) : frozen;
  }

  function detectFeatureFractals(standardizedSequence, options = {}) {
    return evaluateFeatureFractalState(standardizedSequence, options);
  }

  class FeatureFractalDetector {
    constructor(options = {}) {
      this.ruleConfig = resolveRuleConfig(options);
      this.reset();
    }

    reset() {
      this.sequenceId = null;
      this.status = null;
      this.confirmedFeatureFractals = [];
      this.candidateFeatureFractal = null;
      this.invalidatedFeatureFractals = [];
      this.events = [];
      this.activeFeatureMemorySize = 0;
      this.currentFeatureIndex = -1;
      this.currentRawBarIndex = null;
      this.currentTime = null;
    }

    update(standardizedSequence, options = {}) {
      const ruleConfig = resolveRuleConfig(options.ruleConfig ? options : this.ruleConfig);
      const packet = evaluateFeatureFractalState(standardizedSequence, { ...options, ruleConfig });
      const previousConfirmed = new Set(this.confirmedFeatureFractals.map(item => item.featureFractalId));
      const previousInvalidated = new Set(this.invalidatedFeatureFractals.map(item => `${item.featureFractalId}:${item.confirmFeatureIndex}`));
      const previousCandidateKey = compactFractalKey(this.candidateFeatureFractal);
      const deltaEvents = [];
      for (const fractal of packet.confirmedFeatureFractals || []) {
        if (!previousConfirmed.has(fractal.featureFractalId)) deltaEvents.push(makeEvent(fractal, EVENT_CONFIRMED, null, { delta: true }));
      }
      for (const fractal of packet.invalidatedFeatureFractals || []) {
        const key = `${fractal.featureFractalId}:${fractal.confirmFeatureIndex}`;
        if (!previousInvalidated.has(key)) deltaEvents.push(makeEvent(fractal, EVENT_INVALIDATED, null, { delta: true }));
      }
      const candidateKey = compactFractalKey(packet.candidateFeatureFractal);
      if (candidateKey && candidateKey !== previousCandidateKey) {
        deltaEvents.push(makeEvent(packet.candidateFeatureFractal, EVENT_CANDIDATE, null, { delta: true }));
      }
      this.sequenceId = packet.sequenceId;
      this.status = packet.status;
      this.confirmedFeatureFractals = clone(packet.confirmedFeatureFractals || []);
      this.candidateFeatureFractal = packet.candidateFeatureFractal ? clone(packet.candidateFeatureFractal) : null;
      this.invalidatedFeatureFractals = clone(packet.invalidatedFeatureFractals || []);
      this.events = this.events.concat(deltaEvents);
      this.activeFeatureMemorySize = packet.activeFeatureMemorySize || 0;
      this.currentFeatureIndex = packet.currentFeatureIndex ?? -1;
      this.currentRawBarIndex = packet.currentRawBarIndex ?? null;
      this.currentTime = packet.currentTime ?? null;
      return freeze({
        ...clone(packet),
        events: clone(deltaEvents),
        allEvents: clone(this.events),
        all_events: clone(this.events),
      });
    }

    getConfirmedFeatureFractals() {
      return clone(this.confirmedFeatureFractals);
    }

    getCandidateFeatureFractal() {
      return this.candidateFeatureFractal ? clone(this.candidateFeatureFractal) : null;
    }

    getInvalidatedFeatureFractals() {
      return clone(this.invalidatedFeatureFractals);
    }

    getEvents() {
      return clone(this.events);
    }

    getState() {
      return freeze({
        sequenceId: this.sequenceId,
        sequence_id: this.sequenceId,
        status: this.status,
        currentFeatureIndex: this.currentFeatureIndex,
        current_feature_index: this.currentFeatureIndex,
        currentRawBarIndex: this.currentRawBarIndex,
        current_raw_bar_index: this.currentRawBarIndex,
        currentTime: this.currentTime,
        current_time: this.currentTime,
        confirmedFeatureFractalCount: this.confirmedFeatureFractals.length,
        confirmed_feature_fractal_count: this.confirmedFeatureFractals.length,
        invalidatedFeatureFractalCount: this.invalidatedFeatureFractals.length,
        invalidated_feature_fractal_count: this.invalidatedFeatureFractals.length,
        hasCandidate: !!this.candidateFeatureFractal,
        has_candidate: !!this.candidateFeatureFractal,
        activeFeatureMemorySize: this.activeFeatureMemorySize,
        active_feature_memory_size: this.activeFeatureMemorySize,
        featureFractalVersion: SEGMENT_FEATURE_FRACTAL_VERSION,
        feature_fractal_version: SEGMENT_FEATURE_FRACTAL_VERSION,
        ruleVersion: this.ruleConfig.ruleVersion,
        rule_version: this.ruleConfig.ruleVersion,
        metadata: freeze({
          sourceLayer: 'standardizedFeatureSequence',
          segmentOutputProduced: false,
        }),
      });
    }
  }

  Object.assign(core, {
    FEATURE_FRACTAL_VERSION: SEGMENT_FEATURE_FRACTAL_VERSION,
    SEGMENT_FEATURE_FRACTAL_VERSION,
    FEATURE_FRACTAL_TYPES,
    isFeatureTop,
    isFeatureBottom,
    featureFractalTypeOfTriple,
    candidateTypeFromPair,
    featureFractalToCompactRow,
    featureFractalsToCompactRows,
    detectFeatureFractals,
    FeatureFractalDetector,
  });
})();
