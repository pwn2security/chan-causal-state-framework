(function () {
  'use strict';
  const c = window.MarketCore;
  const VERSION = 'CT-Segment-R1.0';
  const CONTINUATION_VERSION = 'CT-Feature-Inclusion-Continuation-v1.0';
  const copy = value => JSON.parse(JSON.stringify(value));
  const union = (a, b) => [...new Set([...a, ...b])];
  const frozen = value => c.deepFreeze(copy(value));

  // R1.0 engineering policy: seal only when a non-including successor arrives.
  // An unresolved initial group retains both directional envelopes, not guessed geometry.
  class FeatureSequenceInclusionStateMachine {
    constructor(context, options = {}) {
      this.context = { sequenceId: context.sequenceId, candidateSegmentId: context.candidateSegmentId ?? context.sequenceId,
        sequenceRole: context.sequenceRole ?? 'primary', featureDirection: context.featureDirection,
        segmentStartDirection: context.segmentStartDirection, structuralContext: context.structuralContext ?? null };
      if (!this.context.sequenceId) throw new Error('MISSING_SEQUENCE_ID');
      this.tolerance = options.priceTolerance ?? 0;
      if (!Number.isFinite(this.tolerance) || this.tolerance < 0) throw new Error('INVALID_TOLERANCE');
      this.archive = []; this.tail = null; this.pending = null; this.last = null;
      this.direction = 'UNKNOWN'; this.count = 0;
      this.counts = { upDirectionCount: 0, downDirectionCount: 0, pendingDirectionCount: 0,
        resolvedPendingCount: 0, mergeUpCount: 0, mergeDownCount: 0 };
    }
    directionOf(a, b) { return c.resolveFeatureSequenceDirection(a, b, this.tolerance); }
    includes(a, b) {
      return (a.high >= b.high - this.tolerance && a.low <= b.low + this.tolerance)
        || (b.high >= a.high - this.tolerance && b.low <= a.low + this.tolerance);
    }
    normalize(raw) {
      for (const key of Object.keys(this.context)) {
        if (raw[key] !== undefined && JSON.stringify(raw[key]) !== JSON.stringify(this.context[key]))
          throw new Error('CROSS_SEQUENCE_INCLUSION_FORBIDDEN');
      }
      const n = c.normalizeRawFeatureSequence({ ...this.context, elements: [raw] }).elements[0];
      const ordinal = raw.sequenceOrdinal ?? raw.sequence_ordinal ?? this.count;
      if (!Number.isInteger(ordinal) || ordinal < 0 || n.sourceStartTime > n.sourceEndTime
          || n.sourceEndTime > n.availableAtTime || n.sourceRawEndIndex > n.availableAtIndex)
        throw new Error('INVALID_SOURCE_RANGE');
      if (this.last && (ordinal <= this.last.ordinal || n.availableAtIndex < this.last.availableAtIndex
          || n.availableAtTime < this.last.availableAtTime || n.sourceRawStartIndex < this.last.sourceRawStartIndex
          || n.sourceStartTime < this.last.sourceStartTime)) throw new Error('MALFORMED_SEQUENCE_ORDER');
      const sourceStroke = n.rawElement?.sourceStroke || {};
      return { ...this.context, low: n.priceLow, high: n.priceHigh,
        sourceFeatureElementIds: n.sourceFeatureElementIds, sourceStrokeIds: n.sourceStrokeIds,
        sourceFractalIds: union(
          n.rawElement?.provenance?.fractalIds || [],
          [sourceStroke.startFractalId, sourceStroke.endFractalId].filter(Boolean),
        ),
        sourceNormalizedKIds: union(
          sourceStroke.metadata?.startFractal?.sourceKIds || [],
          sourceStroke.metadata?.endFractal?.sourceKIds || [],
        ),
        sourceRawStartIndex: n.sourceRawStartIndex, sourceRawEndIndex: n.sourceRawEndIndex,
        sourceStartTime: n.sourceStartTime, sourceEndTime: n.sourceEndTime,
        availableAtIndex: n.availableAtIndex, availableAtTime: n.availableAtTime,
        ordinal, standardizationAction: 'UNCHANGED', dependencyFeatureElementIds: n.sourceFeatureElementIds };
    }
    merge(a, b, direction) {
      const op = direction === 'UP' ? Math.max : Math.min;
      return { ...a, low: op(a.low, b.low), high: op(a.high, b.high),
        sourceFeatureElementIds: union(a.sourceFeatureElementIds, b.sourceFeatureElementIds),
        sourceStrokeIds: union(a.sourceStrokeIds, b.sourceStrokeIds),
        sourceFractalIds: union(a.sourceFractalIds, b.sourceFractalIds),
        sourceNormalizedKIds: union(a.sourceNormalizedKIds, b.sourceNormalizedKIds),
        sourceRawEndIndex: Math.max(a.sourceRawEndIndex, b.sourceRawEndIndex),
        sourceEndTime: Math.max(a.sourceEndTime, b.sourceEndTime),
        availableAtIndex: Math.max(a.availableAtIndex, b.availableAtIndex),
        availableAtTime: Math.max(a.availableAtTime, b.availableAtTime),
        dependencyFeatureElementIds: union(a.dependencyFeatureElementIds, b.dependencyFeatureElementIds),
        standardizationAction: direction === 'UP' ? 'MERGED_UP' : 'MERGED_DOWN' };
    }
    seal(witness) {
      const a = this.tail, index = this.archive.length;
      const id = `${this.context.sequenceId}:R1:${index}:${a.sourceFeatureElementIds[0]}`;
      this.archive.push(frozen({ ...a,
        schemaVersion: c.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        structuralTimeSchemaVersion: c.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        standardizedFeatureElementId: id, featureElementId: id,
        featureSequenceIndex: index, featureSequenceDirection: this.direction,
        status: 'STANDARDIZED', ruleVersion: VERSION,
        geometricSourceStartIndex: a.sourceRawStartIndex, geometricSourceEndIndex: a.sourceRawEndIndex,
        geometricSourceStartTime: a.sourceStartTime, geometricSourceEndTime: a.sourceEndTime,
        eventRawBarIndex: a.sourceRawEndIndex, eventIndex: a.sourceRawEndIndex, eventTime: a.sourceEndTime,
        eventFeatureIndex: index,
        standardizationAvailableRawBarIndex: witness.availableAtIndex,
        standardizationAvailableTime: witness.availableAtTime,
        availableRawBarIndex: witness.availableAtIndex, availableAtIndex: witness.availableAtIndex,
        availableTime: witness.availableAtTime, availableAtTime: witness.availableAtTime,
        availableFeatureIndex: index,
        confirmRawBarIndex: witness.availableAtIndex, confirmIndex: witness.availableAtIndex,
        confirmTime: witness.availableAtTime, confirmFeatureIndex: index,
        provenance: {
          standardizedFeatureElementId: id,
          rawFeatureElementIds: a.sourceFeatureElementIds,
          strokeIds: a.sourceStrokeIds,
          fractalIds: a.sourceFractalIds,
          normalizedKIds: a.sourceNormalizedKIds,
          rawObservationRange: [a.sourceRawStartIndex, a.sourceRawEndIndex],
        },
        metadata: { sealingPolicy: 'NON_INCLUDING_SUCCESSOR',
          legacyIndexMapping: { eventIndex: 'eventRawBarIndex',
            confirmIndex: 'confirmRawBarIndex=availableRawBarIndex' },
          dependencyFeatureElementIds: union(a.dependencyFeatureElementIds, witness.sourceFeatureElementIds),
          witnessStrokeIds: witness.sourceStrokeIds } }));
    }
    update(raw) {
      const e = this.normalize(raw); // Validate before changing continuation state.
      this.last = { ordinal: e.ordinal, availableAtIndex: e.availableAtIndex, availableAtTime: e.availableAtTime,
        sourceRawStartIndex: e.sourceRawStartIndex, sourceStartTime: e.sourceStartTime };
      this.count++;
      if (this.pending) {
        const up = this.directionOf(this.pending.up, e), down = this.directionOf(this.pending.down, e);
        // A witness must resolve BOTH hypothetical envelopes identically.
        if (up !== 'UNKNOWN' && up === down) {
          this.direction = up;
          this.tail = { ...this.pending[up.toLowerCase()], standardizationAction: 'RESOLVED_PENDING_DIRECTION' };
          this.counts.resolvedPendingCount++;
          this.counts[up === 'UP' ? 'mergeUpCount' : 'mergeDownCount'] += this.pending.mergeCount;
          this.counts[up === 'UP' ? 'upDirectionCount' : 'downDirectionCount']++;
          this.pending = null; this.seal(e); this.tail = e;
        } else {
          this.pending.up = this.merge(this.pending.up, e, 'UP');
          this.pending.down = this.merge(this.pending.down, e, 'DOWN');
          this.pending.mergeCount++;
        }
      } else if (!this.tail) this.tail = e;
      else if (this.includes(this.tail, e)) {
        if (this.direction === 'UNKNOWN') {
          this.pending = { up: this.merge(this.tail, e, 'UP'), down: this.merge(this.tail, e, 'DOWN'), mergeCount: 1 };
          this.tail = null; this.counts.pendingDirectionCount++;
        } else {
          this.tail = this.merge(this.tail, e, this.direction);
          this.counts[this.direction === 'UP' ? 'mergeUpCount' : 'mergeDownCount']++;
        }
      } else {
        const direction = this.directionOf(this.tail, e);
        if (direction === 'UNKNOWN') throw new Error('UNRESOLVED_NON_INCLUSION');
        this.direction = direction;
        this.counts[direction === 'UP' ? 'upDirectionCount' : 'downDirectionCount']++;
        this.seal(e); this.tail = e;
      }
      return this.getState();
    }
    getState() {
      const status = this.pending ? 'PENDING_DIRECTION' : (this.tail ? 'PARTIALLY_STANDARDIZED' : 'STANDARDIZED');
      return frozen({ ...this.context, ruleVersion: VERSION, standardizationStatus: status,
        inputElementCount: this.count, elements: this.archive, historicalFeatureArchive: this.archive,
        activeFeatureMemory: { direction: this.direction, tail: this.tail, pending: this.pending, last: this.last },
        counts: this.counts, pendingDirectionCount: this.pending ? 1 : 0,
        standardizedGapResult: c.detectFeatureSequenceGaps(this.archive, { priceTolerance: this.tolerance }),
        metadata: { activeTailIsProvisional: true, eofDoesNotSeal: true, confirmationRuleStatus: 'NOT_EVALUATED' } });
    }
    // Only the immutable prefix enters the existing detector; active tail is never relabelled as finalized.
    getDetectorInput() {
      return frozen({ ...this.context, ruleVersion: VERSION, standardizationStatus: 'STANDARDIZED', elements: this.archive });
    }
    getContinuationState() {
      return frozen({ continuationVersion: CONTINUATION_VERSION, context: this.context,
        tolerance: this.tolerance, archive: this.archive, tail: this.tail, pending: this.pending,
        last: this.last, direction: this.direction, count: this.count, counts: this.counts });
    }
    restoreContinuationState(snapshot) {
      const s = copy(snapshot);
      if (!s || s.continuationVersion !== CONTINUATION_VERSION) throw new Error('INCOMPATIBLE_FEATURE_INCLUSION_CONTINUATION');
      if (JSON.stringify(s.context) !== JSON.stringify(this.context)) throw new Error('FEATURE_INCLUSION_CONTEXT_MISMATCH');
      if (!Number.isFinite(s.tolerance) || s.tolerance < 0 || s.tolerance !== this.tolerance)
        throw new Error('FEATURE_INCLUSION_TOLERANCE_MISMATCH');
      if (!Array.isArray(s.archive) || !Number.isInteger(s.count) || s.count < 0 || !s.counts || typeof s.counts !== 'object')
        throw new Error('INVALID_FEATURE_INCLUSION_CONTINUATION');
      this.archive = s.archive; this.tail = s.tail ?? null; this.pending = s.pending ?? null;
      this.last = s.last ?? null; this.direction = s.direction; this.count = s.count; this.counts = s.counts;
      return this;
    }
  }
  function standardizeFeatureSequenceR1(raw, options = {}) {
    if (raw.standardizationStatus && raw.standardizationStatus !== 'RAW_NOT_STANDARDIZED') throw new Error('EXPECTED_RAW_SEQUENCE');
    if (!Array.isArray(raw.elements)) throw new Error('EXPECTED_ELEMENTS');
    const machine = new FeatureSequenceInclusionStateMachine(raw, options);
    for (const element of raw.elements) machine.update(element);
    return machine.getState();
  }
  Object.assign(c, { SEGMENT_INCLUSION_RULE_VERSION: VERSION,
    FEATURE_INCLUSION_CONTINUATION_VERSION: CONTINUATION_VERSION,
    FeatureSequenceInclusionStateMachine, standardizeFeatureSequenceR1 });
})();
