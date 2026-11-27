(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};

  const DEFAULT_CT_RULE_CONFIG = Object.freeze({
    ruleVersion: 'CT-R1.0',
    inclusionRule: 'streaming-propagating-inclusion',
    equalHighLowRule: 'equal-range-is-inclusion',
    minimumStrokeSeparation: 4,
    minimumSegmentStrokeCount: 3,
    strokeEndpointRule: 'same-type-extreme-replacement',
    segmentRuleVersion: 'TODO-segment-rule-v0',
    pivotRuleVersion: 'CT-Pivot-Establishment-R1.0',
    pivotEtaZ: 1e-12,
    pivotBreakRule: 'TODO-pivot-break-rule-v0',
    divergenceFunction: 'geometric',
    tradingPointRuleVersion: 'TODO-trading-point-rule-v0',
    priceTolerance: 0,
    numericTolerance: 1e-10,
  });

  function cleanText(value, fallback) {
    const text = value === null || value === undefined ? '' : String(value).trim();
    return text || fallback;
  }

  function nonNegativeNumber(value, fallback, field) {
    const number = value === null || value === undefined || value === '' ? fallback : Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be a non-negative finite number`);
    return number;
  }

  function nonNegativeInteger(value, fallback, field) {
    const number = nonNegativeNumber(value, fallback, field);
    if (!Number.isInteger(number)) throw new Error(`${field} must be a non-negative integer`);
    return number;
  }

  function createCTRuleConfig(input = {}) {
    const merged = { ...DEFAULT_CT_RULE_CONFIG, ...(input || {}) };
    const config = {
      ruleVersion: cleanText(input.ruleVersion ?? input.rule_version ?? merged.ruleVersion, DEFAULT_CT_RULE_CONFIG.ruleVersion),
      inclusionRule: cleanText(input.inclusionRule ?? input.inclusion_rule ?? merged.inclusionRule, DEFAULT_CT_RULE_CONFIG.inclusionRule),
      equalHighLowRule: cleanText(input.equalHighLowRule ?? input.equal_high_low_rule ?? merged.equalHighLowRule, DEFAULT_CT_RULE_CONFIG.equalHighLowRule),
      minimumStrokeSeparation: nonNegativeInteger(
        input.minimumStrokeSeparation ?? input.minimum_stroke_separation ?? merged.minimumStrokeSeparation,
        DEFAULT_CT_RULE_CONFIG.minimumStrokeSeparation,
        'minimumStrokeSeparation',
      ),
      minimumSegmentStrokeCount: (() => {
        const value = input.minimumSegmentStrokeCount ?? input.minimum_segment_stroke_count ?? DEFAULT_CT_RULE_CONFIG.minimumSegmentStrokeCount;
        if (!Number.isInteger(value) || value < 3) throw new Error('minimumSegmentStrokeCount must be an integer >= 3');
        return value;
      })(),
      strokeEndpointRule: cleanText(input.strokeEndpointRule ?? input.stroke_endpoint_rule ?? merged.strokeEndpointRule, DEFAULT_CT_RULE_CONFIG.strokeEndpointRule),
      segmentRuleVersion: cleanText(input.segmentRuleVersion ?? input.segment_rule_version ?? merged.segmentRuleVersion, DEFAULT_CT_RULE_CONFIG.segmentRuleVersion),
      pivotRuleVersion: cleanText(input.pivotRuleVersion ?? input.pivot_rule_version ?? merged.pivotRuleVersion, DEFAULT_CT_RULE_CONFIG.pivotRuleVersion),
      pivotEtaZ: (() => {
        const number = Number(input.pivotEtaZ ?? input.pivot_eta_z ?? merged.pivotEtaZ);
        if (!Number.isFinite(number) || number <= 0) throw new Error('pivotEtaZ must be a positive finite number');
        return number;
      })(),
      pivotBreakRule: cleanText(input.pivotBreakRule ?? input.pivot_break_rule ?? merged.pivotBreakRule, DEFAULT_CT_RULE_CONFIG.pivotBreakRule),
      divergenceFunction: cleanText(input.divergenceFunction ?? input.divergence_function ?? merged.divergenceFunction, DEFAULT_CT_RULE_CONFIG.divergenceFunction),
      tradingPointRuleVersion: cleanText(input.tradingPointRuleVersion ?? input.trading_point_rule_version ?? merged.tradingPointRuleVersion, DEFAULT_CT_RULE_CONFIG.tradingPointRuleVersion),
      priceTolerance: nonNegativeNumber(input.priceTolerance ?? input.price_tolerance ?? merged.priceTolerance, DEFAULT_CT_RULE_CONFIG.priceTolerance, 'priceTolerance'),
      numericTolerance: nonNegativeNumber(input.numericTolerance ?? input.numeric_tolerance ?? merged.numericTolerance, DEFAULT_CT_RULE_CONFIG.numericTolerance, 'numericTolerance'),
    };
    return (core.deepFreeze || Object.freeze)(config);
  }

  Object.assign(core, { DEFAULT_CT_RULE_CONFIG, createCTRuleConfig });
})();
