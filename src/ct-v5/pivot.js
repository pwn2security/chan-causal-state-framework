(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const RULE_VERSION = 'CT-Pivot-Establishment-R1.0';
  const CONTINUATION_VERSION = 'CT-Pivot-Continuation-v2.0';
  const clone = value => core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const freeze = value => core.deepFreeze ? core.deepFreeze(value) : Object.freeze(value);

  function segmentId(segment) {
    return String(segment?.confirmedSegmentId || segment?.segmentId || segment?.structureId || '');
  }

  function sequenceIndex(segment) {
    const value = Number(segment?.segmentSequenceIndex ?? segment?.sequenceIndex);
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  function compactSource(segment) {
    const id = segmentId(segment);
    const index = sequenceIndex(segment);
    const startPrice = Number(segment?.startPrice);
    const endPrice = Number(segment?.endpointPrice ?? segment?.endPrice);
    const eventTime = Number(segment?.eventTime);
    const confirmTime = Number(segment?.confirmTime);
    const eventRawBarIndex = Number(segment?.eventRawBarIndex ?? segment?.endIndex);
    const confirmRawBarIndex = Number(segment?.confirmRawBarIndex ?? segment?.confirmIndex);
    const startRawBarIndex = Number(segment?.startRawBarIndex ?? segment?.startIndex ?? segment?.eventRawBarIndex);
    const startTime = Number(segment?.startTime ?? segment?.eventTime);
    if (!id) throw new Error('PIVOT_SOURCE_SEGMENT_ID_REQUIRED');
    if (segment?.status !== 'CONFIRMED') throw new Error('PIVOT_SOURCE_MUST_BE_CONFIRMED_SEGMENT');
    if (index === null) throw new Error('PIVOT_SOURCE_SEQUENCE_INDEX_REQUIRED');
    for (const [field, value] of Object.entries({
      startPrice, endPrice, eventTime, confirmTime, eventRawBarIndex,
      confirmRawBarIndex, startRawBarIndex, startTime,
    })) if (!Number.isFinite(value)) throw new Error(`PIVOT_SOURCE_${field.toUpperCase()}_REQUIRED`);
    if (eventTime > confirmTime || eventRawBarIndex > confirmRawBarIndex) {
      throw new Error('PIVOT_SOURCE_INVALID_DUAL_TIME');
    }
    return freeze({
      segmentId: id,
      status: 'CONFIRMED',
      sequenceIndex: index,
      direction: segment.direction || null,
      caseType: segment.caseType || null,
      startPrice,
      endPrice,
      priceLow: Math.min(startPrice, endPrice),
      priceHigh: Math.max(startPrice, endPrice),
      startRawBarIndex,
      eventRawBarIndex,
      confirmRawBarIndex,
      startTime,
      eventTime,
      confirmTime,
      ruleVersion: segment.segmentRuleVersion || segment.ruleVersion || null,
    });
  }

  function pivotGeometry(sources, etaZ) {
    const lows = sources.map(source => source.priceLow);
    const highs = sources.map(source => source.priceHigh);
    const ZD = Math.max(...lows);
    const ZG = Math.min(...highs);
    const DD = Math.min(...lows);
    const GG = Math.max(...highs);
    const W_Z = ZG - ZD;
    const R_Z = GG - DD;
    return freeze({ ZD, ZG, DD, GG, W_Z, R_Z, omega_Z: W_Z / (R_Z + etaZ), eta_Z: etaZ });
  }

  function pivotIdFor(sources) {
    return `confirmed:${RULE_VERSION}:${sources.map(source => source.segmentId).join('>')}`;
  }

  function createPivotEstablishedEvent(sourceSegments, ruleConfig = {}) {
    const config = core.createCTRuleConfig(ruleConfig);
    if (config.pivotRuleVersion !== RULE_VERSION) {
      throw new Error(`PIVOT_RULE_VERSION_MISMATCH: expected ${RULE_VERSION}`);
    }
    if (!Array.isArray(sourceSegments) || sourceSegments.length !== 3) {
      throw new Error('PIVOT_ESTABLISHMENT_REQUIRES_EXACTLY_THREE_SOURCES');
    }
    const sources = sourceSegments.map(compactSource);
    for (let index = 1; index < sources.length; index += 1) {
      if (sources[index].sequenceIndex !== sources[index - 1].sequenceIndex + 1) {
        throw new Error('PIVOT_SOURCE_CONTIGUITY_VIOLATION');
      }
    }
    const geometry = pivotGeometry(sources, config.pivotEtaZ);
    if (geometry.ZD > geometry.ZG) return null;
    const eventTime = Math.max(...sources.map(source => source.eventTime));
    const confirmTime = Math.max(...sources.map(source => source.confirmTime));
    const eventRawBarIndex = Math.max(...sources.map(source => source.eventRawBarIndex));
    const confirmRawBarIndex = Math.max(...sources.map(source => source.confirmRawBarIndex));
    const displayStartRawBarIndex = Math.min(...sources.map(source => source.startRawBarIndex));
    const displayEndRawBarIndex = eventRawBarIndex;
    const displayStartTime = Math.min(...sources.map(source => source.startTime));
    const displayEndTime = eventTime;
    const pivotId = pivotIdFor(sources);
    const provenance = {
      sourceLayer: 'confirmedSegmentPublications',
      sourceSegmentIds: sources.map(source => source.segmentId),
      sourceSequenceIndices: sources.map(source => source.sequenceIndex),
      sources,
    };
    const base = core.createStructuralEvent({
      eventId: `${pivotId}:PIVOT_ESTABLISHED`,
      structureId: pivotId,
      structureType: core.CT_STRUCTURE_TYPES.pivotZone,
      eventAction: core.CT_EVENT_ACTIONS.confirmed,
      barIndex: confirmRawBarIndex,
      barTime: confirmTime,
      eventRawBarIndex,
      confirmRawBarIndex,
      eventTime,
      confirmTime,
      modeBefore: core.CT_STATUSES.forming,
      modeAfter: core.CT_STATUSES.established,
      ruleVersion: RULE_VERSION,
      provenance,
      metadata: { eventType: 'PIVOT_ESTABLISHED', establishmentOnly: true },
    });
    return freeze({
      ...base,
      eventType: 'PIVOT_ESTABLISHED',
      pivotId,
      sourceSegmentIds: provenance.sourceSegmentIds,
      sourceSequenceIndices: provenance.sourceSequenceIndices,
      ...geometry,
      displayStartRawBarIndex,
      displayEndRawBarIndex,
      displayStartTime,
      displayEndTime,
      timeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
    });
  }

  function emptyContinuation() {
    return freeze({
      continuationVersion: CONTINUATION_VERSION,
      mode: core.CT_STATUSES.none,
      formingSourceWindow: [],
      sourceCursor: null,
      consumedSegmentIds: [],
      latestEstablishedPivot: null,
      publicationCursor: 0,
      stopReason: null,
      ruleVersion: RULE_VERSION,
      timeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
    });
  }

  class PivotStateMachine {
    constructor(ruleConfig = {}) {
      this.ruleConfig = core.createCTRuleConfig(ruleConfig);
      if (this.ruleConfig.pivotRuleVersion !== RULE_VERSION) {
        throw new Error(`PIVOT_RULE_VERSION_MISMATCH: expected ${RULE_VERSION}`);
      }
      this.reset();
    }

    reset() {
      this.mode = core.CT_STATUSES.none;
      this.formingSourceWindow = [];
      this.sourceCursor = null;
      this.consumedSegmentIds = new Set();
      this.latestEstablishedPivot = null;
      this.publications = [];
      this.publicationCursor = 0;
      this.stopReason = null;
      this.trace = [];
      return this;
    }

    update(segment) {
      let source;
      try { source = compactSource(segment); }
      catch (error) {
        const action = error.message === 'PIVOT_SOURCE_MUST_BE_CONFIRMED_SEGMENT'
          ? 'REJECT_UNCONFIRMED_SOURCE' : error.message;
        this.trace.push(freeze({ action, sourceSegmentId: segmentId(segment) || null }));
        return freeze({ action, events: [], state: this.getState() });
      }
      if (this.consumedSegmentIds.has(source.segmentId)) {
        return freeze({ action: 'IGNORE_DUPLICATE', events: [], state: this.getState() });
      }
      if (this.latestEstablishedPivot) {
        this.stopReason = 'PIVOT_POST_ESTABLISHMENT_LIFECYCLE_DEFERRED';
        this.trace.push(freeze({ action: this.stopReason, sourceSegmentId: source.segmentId }));
        return freeze({ action: this.stopReason, events: [], state: this.getState() });
      }
      const expected = this.sourceCursor === null ? source.sequenceIndex : this.sourceCursor + 1;
      if (source.sequenceIndex !== expected) {
        this.stopReason = 'PIVOT_SOURCE_CONTIGUITY_VIOLATION';
        this.trace.push(freeze({ action: this.stopReason, sourceSegmentId: source.segmentId,
          expectedSequenceIndex: expected, actualSequenceIndex: source.sequenceIndex }));
        return freeze({ action: this.stopReason, events: [], state: this.getState() });
      }
      this.consumedSegmentIds.add(source.segmentId);
      this.sourceCursor = source.sequenceIndex;
      this.formingSourceWindow.push(source);
      this.mode = core.CT_STATUSES.forming;
      if (this.formingSourceWindow.length < 3) {
        const action = `${this.formingSourceWindow.length}_OF_3`;
        this.stopReason = 'WAITING_FOR_THIRD_CONFIRMED_SEGMENT';
        this.trace.push(freeze({ action, sourceSegmentId: source.segmentId }));
        return freeze({ action, events: [], state: this.getState() });
      }
      const triple = this.formingSourceWindow.slice(-3);
      const publication = createPivotEstablishedEvent(triple, this.ruleConfig);
      if (!publication) {
        this.formingSourceWindow = triple.slice(1);
        this.stopReason = 'PIVOT_TRIPLE_NO_OVERLAP_SLIDING';
        this.trace.push(freeze({ action: this.stopReason,
          sourceSegmentIds: triple.map(item => item.segmentId) }));
        return freeze({ action: this.stopReason, events: [], state: this.getState() });
      }
      this.latestEstablishedPivot = publication;
      this.publications.push(publication);
      this.publicationCursor += 1;
      this.formingSourceWindow = [];
      this.mode = core.CT_STATUSES.established;
      this.stopReason = 'PIVOT_POST_ESTABLISHMENT_LIFECYCLE_DEFERRED';
      this.trace.push(freeze({ action: 'PIVOT_ESTABLISHED', pivotId: publication.pivotId }));
      return freeze({ action: 'PIVOT_ESTABLISHED', events: [publication],
        publication, state: this.getState() });
    }

    getPublications() { return clone(this.publications); }
    getLatestEstablishedPivot() { return clone(this.latestEstablishedPivot); }
    getTrace() { return clone(this.trace); }
    getMode() { return this.mode; }
    getStopReason() { return this.stopReason; }

    getState() {
      const latest = this.latestEstablishedPivot;
      return core.createBaseCTState({
        structureType: core.CT_STRUCTURE_TYPES.pivotZone,
        mode: this.mode,
        continuousState: {
          confirmedPivotCount: latest ? 1 : 0,
          formingSourceCount: this.formingSourceWindow.length,
          ZD: latest?.ZD ?? null,
          ZG: latest?.ZG ?? null,
          DD: latest?.DD ?? null,
          GG: latest?.GG ?? null,
        },
        activeMemory: {
          pivotContinuation: this.serializeContinuation(),
        },
        structures: latest ? [{
          structureId: latest.pivotId,
          structureType: core.CT_STRUCTURE_TYPES.pivotZone,
          status: core.CT_STATUSES.established,
          eventRawBarIndex: latest.eventRawBarIndex,
          confirmRawBarIndex: latest.confirmRawBarIndex,
          eventTime: latest.eventTime,
          confirmTime: latest.confirmTime,
          startIndex: latest.displayStartRawBarIndex,
          endIndex: latest.displayEndRawBarIndex,
          startTime: latest.displayStartTime,
          endTime: latest.displayEndTime,
          priceLow: latest.ZD,
          priceHigh: latest.ZG,
          ruleVersion: RULE_VERSION,
          metadata: { sourceSegmentIds: latest.sourceSegmentIds, establishmentOnly: true },
        }] : [],
        lastEventId: latest?.eventId ?? null,
        metadata: { ruleVersion: RULE_VERSION, lifecycleScope: 'ESTABLISHMENT_ONLY' },
      });
    }

    serializeContinuation() {
      return freeze({
        continuationVersion: CONTINUATION_VERSION,
        mode: this.mode,
        formingSourceWindow: clone(this.formingSourceWindow),
        sourceCursor: this.sourceCursor,
        consumedSegmentIds: [...this.consumedSegmentIds],
        latestEstablishedPivot: clone(this.latestEstablishedPivot),
        publications: clone(this.publications),
        publicationCursor: this.publicationCursor,
        stopReason: this.stopReason,
        ruleVersion: RULE_VERSION,
        timeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      });
    }

    restoreContinuation(snapshot) {
      if (!snapshot || snapshot.continuationVersion !== CONTINUATION_VERSION) {
        throw new Error('INCOMPATIBLE_PIVOT_CONTINUATION');
      }
      if (snapshot.ruleVersion !== RULE_VERSION ||
          snapshot.timeSchemaVersion !== core.CT_STRUCTURAL_TIME_SCHEMA_VERSION) {
        throw new Error('INCOMPATIBLE_PIVOT_CONTINUATION_RULE_OR_TIME_SCHEMA');
      }
      this.reset();
      this.mode = snapshot.mode;
      this.formingSourceWindow = clone(snapshot.formingSourceWindow || []);
      this.sourceCursor = snapshot.sourceCursor ?? null;
      this.consumedSegmentIds = new Set(snapshot.consumedSegmentIds || []);
      this.latestEstablishedPivot = snapshot.latestEstablishedPivot
        ? freeze(clone(snapshot.latestEstablishedPivot)) : null;
      this.publications = (snapshot.publications || (this.latestEstablishedPivot ? [this.latestEstablishedPivot] : []))
        .map(item => freeze(clone(item)));
      this.publicationCursor = Number(snapshot.publicationCursor || 0);
      this.stopReason = snapshot.stopReason ?? null;
      return this;
    }
  }

  Object.assign(core, {
    CT_PIVOT_ESTABLISHMENT_RULE_VERSION: RULE_VERSION,
    CT_PIVOT_CONTINUATION_VERSION: CONTINUATION_VERSION,
    createEmptyPivotContinuation: emptyContinuation,
    compactPivotSourceSegment: compactSource,
    computePivotEstablishmentGeometry: pivotGeometry,
    createPivotEstablishedEvent,
    PivotStateMachine,
  });
})();


