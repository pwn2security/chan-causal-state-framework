(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const API_VERSION = 'CT-Core-Parser-API-v1.0.1';
  const RECORD_SCHEMA_VERSION = 'CT-Core-Structure-Record-v1.0';
  const COMPARATOR_VERSION = 'CT-Core-Semantic-Comparator-v1.0';
  const EXCLUDED_SEMANTIC_FIELDS = Object.freeze([
    'stateHash', 'activeMemorySize', 'lastEventId', 'createdAt',
    'parserRuntimeMs', 'segmentRuntimeMs', 'pivotRuntimeMs',
  ]);

  const clone = value => core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const freeze = value => core.deepFreeze ? core.deepFreeze(value) : Object.freeze(value);

  function requireCore() {
    for (const name of ['CTParserPipeline', 'createCTRuleConfig', 'canonicalStateJson',
      'computeStateHash', 'assertStateSnapshot']) {
      if (typeof core[name] !== 'function') throw new Error(`CT core API requires MarketCore.${name}`);
    }
  }

  function compactIds(values) {
    return [...new Set((values || []).filter(value => value != null).map(String))];
  }

  function timeFields(item) {
    return {
      eventTime: item.eventTime ?? null,
      availableTime: item.availableTime ?? item.confirmTime ?? null,
      confirmTime: item.confirmTime ?? null,
      eventRawBarIndex: item.eventRawBarIndex ?? item.eventIndex ?? null,
      availableRawBarIndex: item.availableRawBarIndex ?? item.confirmRawBarIndex ?? item.confirmIndex ?? null,
      confirmRawBarIndex: item.confirmRawBarIndex ?? item.confirmIndex ?? null,
    };
  }

  function normalizeStructureRecord(item, type) {
    const structureType = String(type || item.structureType || 'unknown');
    let geometry = {};
    let sourceIds = [];
    if (structureType === 'normalizedK') {
      geometry = { high: item.high, low: item.low, open: item.open, close: item.close,
        sourceStartRawBarIndex: item.sourceStartIndex, sourceEndRawBarIndex: item.sourceEndIndex };
      sourceIds = item.metadata?.mergedFrom || [];
    } else if (structureType === 'fractal') {
      geometry = { type: item.type, price: item.price, normalizedKIndex: item.eventNormalizedKIndex };
      sourceIds = item.sourceKIds || item.metadata?.sourceKIds || [];
    } else if (structureType === 'stroke') {
      geometry = { startPrice: item.startPrice, endPrice: item.endPrice,
        startRawBarIndex: item.startIndex, endRawBarIndex: item.endIndex };
      sourceIds = [item.startFractalId, item.endFractalId];
    } else if (structureType === 'segment') {
      geometry = { startPrice: item.startPrice, endPrice: item.endPrice,
        startRawBarIndex: item.startIndex, endRawBarIndex: item.endIndex,
        caseType: item.caseType || null };
      sourceIds = item.strokeIds || item.provenance?.strokeIds || [];
    } else if (structureType === 'pivotZone') {
      geometry = { ZD: item.ZD, ZG: item.ZG, DD: item.DD, GG: item.GG,
        startRawBarIndex: item.displayStartRawBarIndex,
        endRawBarIndex: item.displayEndRawBarIndex };
      sourceIds = item.sourceSegmentIds || item.provenance?.sourceSegmentIds || [];
    }
    const id = item.structureId || item.strokeId || item.segmentId || item.confirmedSegmentId || item.pivotId;
    if (!id) throw new Error(`STRUCTURE_RECORD_ID_REQUIRED:${structureType}`);
    return freeze({
      schemaVersion: RECORD_SCHEMA_VERSION,
      structureId: String(id),
      structureType,
      status: String(item.status || (structureType === 'pivotZone' ? 'ESTABLISHED' : 'CONFIRMED')),
      ruleVersion: String(item.ruleVersion || item.segmentRuleVersion || 'UNSPECIFIED'),
      ...timeFields(item),
      direction: item.direction ?? null,
      geometry: clone(geometry),
      sourceIds: compactIds(sourceIds),
      provenance: clone(item.provenance || {}),
    });
  }

  function stripRuntimeMetadata(value) {
    if (Array.isArray(value)) return value.map(stripRuntimeMetadata);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      if (EXCLUDED_SEMANTIC_FIELDS.includes(key)) continue;
      if (key === 'parserMetadata') {
        const metadata = value[key] || {};
        result[key] = stripRuntimeMetadata({ parserVersion: metadata.parserVersion,
          phase: metadata.phase, ruleVersion: metadata.ruleVersion });
        continue;
      }
      result[key] = stripRuntimeMetadata(value[key]);
    }
    return result;
  }

  function semanticProjection(input) {
    const state = input?.parserState || input;
    if (!state || typeof state !== 'object') throw new Error('SEMANTIC_STATE_REQUIRED');
    return freeze(stripRuntimeMetadata(clone(state)));
  }

  function firstDifference(left, right, path = '$') {
    if (Object.is(left, right)) return null;
    if (typeof left !== typeof right || left == null || right == null) return path;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return `${path}.length`;
      for (let index = 0; index < left.length; index += 1) {
        const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
        if (difference) return difference;
      }
      return null;
    }
    if (typeof left === 'object') {
      const keysA = Object.keys(left).sort();
      const keysB = Object.keys(right).sort();
      if (keysA.join('\u0000') !== keysB.join('\u0000')) return `${path}.{keys}`;
      for (const key of keysA) {
        const difference = firstDifference(left[key], right[key], `${path}.${key}`);
        if (difference) return difference;
      }
    }
    return path;
  }

  function compareParserSemantics(left, right) {
    const leftProjection = semanticProjection(left);
    const rightProjection = semanticProjection(right);
    const leftJson = core.canonicalStateJson(leftProjection);
    const rightJson = core.canonicalStateJson(rightProjection);
    return freeze({
      comparatorVersion: COMPARATOR_VERSION,
      equal: leftJson === rightJson,
      leftHash: core.computeStateHash(leftProjection),
      rightHash: core.computeStateHash(rightProjection),
      firstDifference: leftJson === rightJson ? null : firstDifference(leftProjection, rightProjection),
      excludedFields: [...EXCLUDED_SEMANTIC_FIELDS],
    });
  }

  class CTCoreParser {
    constructor(config = {}) {
      requireCore();
      this.initialize(config);
    }

    initialize(config = {}) {
      this.ruleConfig = core.createCTRuleConfig(config.ruleConfig || config);
      this.pipeline = new core.CTParserPipeline(this.ruleConfig);
      return this;
    }

    ingestClosedBar(bar) {
      if (!bar || bar.closed === false) throw new Error('CT_CORE_REQUIRES_CLOSED_BAR');
      this.pipeline.updateBar(bar);
      return this;
    }

    ingestClosedBars(bars) {
      for (const bar of bars || []) this.ingestClosedBar(bar);
      return this;
    }

    snapshot() { return this.pipeline.createSnapshot(); }

    restore(snapshot) {
      core.assertStateSnapshot(snapshot);
      this.ruleConfig = core.createCTRuleConfig({ ...this.ruleConfig, ruleVersion: snapshot.ruleVersion });
      this.pipeline = new core.CTParserPipeline(this.ruleConfig);
      this.pipeline.restoreSnapshot(snapshot);
      return this;
    }

    getCurrentStructures() {
      const normalizedK = this.pipeline.normalized.getNormalizedBars()
        .map(item => normalizeStructureRecord(item, 'normalizedK'));
      const fractals = this.pipeline.getConfirmedFractals()
        .map(item => normalizeStructureRecord(item, 'fractal'));
      const strokes = this.pipeline.getConfirmedStrokes()
        .map(item => normalizeStructureRecord(item, 'stroke'));
      const segments = this.pipeline.getConfirmedSegments()
        .map(item => normalizeStructureRecord(item, 'segment'));
      const pivots = this.pipeline.getConfirmedPivots()
        .map(item => normalizeStructureRecord(item, 'pivotZone'));
      return freeze({ schemaVersion: RECORD_SCHEMA_VERSION, normalizedK, fractals, strokes, segments, pivots });
    }

    getConfirmedStructures() {
      // Publication is deliberately stricter than the parser's mutable working
      // state.  A terminal normalized K-line may still absorb a future raw bar;
      // a Fractal using that tail and the final replaceable Stroke therefore
      // remain continuation state rather than append-only public output.
      const current = this.getCurrentStructures();
      const normalizedK = current.normalizedK.slice(0, -1);
      const sealedKIds = new Set(normalizedK.map(item => item.structureId));
      const fractals = current.fractals.filter(item => item.sourceIds.length > 0 &&
        item.sourceIds.every(id => sealedKIds.has(id)));
      const sealedFractalIds = new Set(fractals.map(item => item.structureId));
      const segmentStrokeIds = new Set(current.segments.flatMap(item => item.sourceIds));
      const endpointStableStrokes = current.strokes.filter(item => item.sourceIds.length === 2 &&
        item.sourceIds.every(id => sealedFractalIds.has(id)));
      const strokes = endpointStableStrokes.filter((item, index) =>
        index < endpointStableStrokes.length - 1 || segmentStrokeIds.has(item.structureId));
      return freeze({
        schemaVersion: RECORD_SCHEMA_VERSION,
        publicationPolicyVersion: 'CT-Core-Sealed-Publication-v1.0',
        normalizedK, fractals, strokes,
        segments: current.segments,
        pivots: current.pivots,
      });
    }

    getCurrentState() { return clone(this.snapshot().parserState); }

    getStructuralEvents() {
      return freeze({
        archiveBoundary: 'CALLER_OWNED_APPEND_ONLY_FROM_CONFIRMED_PUBLICATIONS_ONLY',
        confirmedPublications: this.getConfirmedStructures(),
        normalizedK: this.pipeline.normalized.getEvents(),
        fractals: this.pipeline.fractal.getEvents(),
        strokes: this.pipeline.stroke.getEvents(),
        segments: this.pipeline.getSegmentMachine().getEvents(),
        pivots: this.pipeline.getConfirmedPivots().map(item => item.event || item),
      });
    }

    toDrawingRecords() { return this.pipeline.toDrawingRecords(); }
  }

  Object.assign(core, {
    CT_CORE_PARSER_API_VERSION: API_VERSION,
    CT_CORE_STRUCTURE_RECORD_SCHEMA_VERSION: RECORD_SCHEMA_VERSION,
    CT_CORE_SEMANTIC_COMPARATOR_VERSION: COMPARATOR_VERSION,
    CT_CORE_SEMANTIC_EXCLUDED_FIELDS: EXCLUDED_SEMANTIC_FIELDS,
    CTCoreParser,
    normalizeCoreStructureRecord: normalizeStructureRecord,
    projectCoreSemanticState: semanticProjection,
    compareCoreParserSemantics: compareParserSemantics,
  });
})();


