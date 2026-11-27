(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const clone = value => core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const PARSER_VERSION = 'CT-Core-Parser-R1.0.4';
  const CORE_CONTINUATION_VERSION = 'CT-Core-Continuation-v2.0';

  class CTParserPipeline {
    constructor(ruleConfig = {}) {
      this.ruleConfig = core.createCTRuleConfig(ruleConfig);
      this.normalized = new core.NormalizedKStateMachine(this.ruleConfig);
      this.fractal = new core.FractalStateMachine(this.ruleConfig);
      this.stroke = new core.StrokeStateMachine(this.ruleConfig);
      this.session = core.createGuardedSegmentSession(this.ruleConfig);
      this.pivot = new core.PivotStateMachine(this.ruleConfig);
      this.processedBarCount = 0;
      this.segmentStrokeCursor = 0;
      this.segmentStrokeSignatures = [];
      this.segmentRebuildCount = 0;
      this.lastSegmentRebuild = null;
      this.deferSegmentRebuild = false;
      this.pendingSegmentRebuild = null;
      this.pivotSegmentCursor = 0;
      this.pivotRebuildCount = 0;
      this.pivotRuntimeMs = 0;
      this.parserRuntimeMs = 0;
      this.segmentRuntimeMs = 0;
      this.restoredContinuation = false;
    }

    reset() {
      this.normalized = new core.NormalizedKStateMachine(this.ruleConfig);
      this.fractal = new core.FractalStateMachine(this.ruleConfig);
      this.stroke = new core.StrokeStateMachine(this.ruleConfig);
      this.session = core.createGuardedSegmentSession(this.ruleConfig);
      this.pivot = new core.PivotStateMachine(this.ruleConfig);
      this.processedBarCount = 0;
      this.segmentStrokeCursor = 0;
      this.segmentStrokeSignatures = [];
      this.segmentRebuildCount = 0;
      this.lastSegmentRebuild = null;
      this.deferSegmentRebuild = false;
      this.pendingSegmentRebuild = null;
      this.pivotSegmentCursor = 0;
      this.pivotRebuildCount = 0;
      this.pivotRuntimeMs = 0;
      this.parserRuntimeMs = 0;
      this.segmentRuntimeMs = 0;
      this.restoredContinuation = false;
    }

    updateBar(bar) {
      const started = now();
      this.stroke.update(this.fractal.update(this.normalized.update(bar)));
      this.processedBarCount += 1;
      const afterLayers = now();
      this.#advanceSegment();
      this.#advancePivot();
      const ended = now();
      this.parserRuntimeMs += ended - started;
      this.segmentRuntimeMs += ended - afterLayers;
      return this;
    }

    updateBars(bars) {
      this.deferSegmentRebuild = true;
      try {
        for (const bar of bars || []) this.updateBar(bar);
        this.#flushPendingSegmentRebuild();
      } finally {
        this.deferSegmentRebuild = false;
      }
      return this;
    }

    ensureParsed(bars) {
      const list = Array.isArray(bars) ? bars : [];
      if (list.length < this.processedBarCount) this.reset();
      this.updateBars(list.slice(this.processedBarCount));
      return this;
    }

    #advanceSegment() {
      if (this.pendingSegmentRebuild) return;
      const strokes = sealedSegmentSourceStrokes(this.stroke.getConfirmedStrokes());
      const signatures = strokes.map(strokeSignature);
      if (this.restoredContinuation) {
        const revisionIndex = firstRevisionIndex(this.segmentStrokeSignatures, signatures);
        if (revisionIndex >= 0) {
          this.#rebuildSegment(strokes, signatures, revisionIndex, this.processedBarCount);
          this.restoredContinuation = false;
          return;
        }
        while (this.segmentStrokeCursor < strokes.length) {
          core.advanceGuardedSegment(this.session, strokes, this.segmentStrokeCursor,
            { continuationOnly: true });
          this.segmentStrokeCursor += 1;
        }
        this.segmentStrokeSignatures = signatures;
        return;
      }
      const revisionIndex = firstRevisionIndex(this.segmentStrokeSignatures, signatures);
      if (revisionIndex >= 0) {
        this.#requestSegmentRebuild(strokes, signatures, revisionIndex);
        return;
      }
      let advanced = false;
      while (this.segmentStrokeCursor < strokes.length) {
        try {
          core.advanceGuardedSegment(this.session, strokes, this.segmentStrokeCursor);
        } catch (error) {
          if (error?.message !== 'R1_UPSTREAM_REVISION_REQUIRES_REBUILD') throw error;
          this.#requestSegmentRebuild(strokes, signatures,
            firstRevisionIndex(this.segmentStrokeSignatures, signatures));
          return;
        }
        this.segmentStrokeCursor += 1;
        advanced = true;
      }
      if (advanced) this.segmentStrokeSignatures = signatures;
    }

    #requestSegmentRebuild(strokes, signatures, revisionIndex) {
      if (!this.deferSegmentRebuild) {
        this.#rebuildSegment(strokes, signatures, revisionIndex, this.processedBarCount);
        return;
      }
      this.pendingSegmentRebuild = {
        firstRevisionStrokeIndex: revisionIndex,
        detectedRawBarCount: this.processedBarCount,
      };
    }

    #flushPendingSegmentRebuild() {
      if (!this.pendingSegmentRebuild) return;
      const pending = this.pendingSegmentRebuild;
      const strokes = sealedSegmentSourceStrokes(this.stroke.getConfirmedStrokes());
      const signatures = strokes.map(strokeSignature);
      this.pendingSegmentRebuild = null;
      this.#rebuildSegment(strokes, signatures, pending.firstRevisionStrokeIndex,
        pending.detectedRawBarCount);
    }

    #rebuildSegment(strokes, signatures, revisionIndex, detectedRawBarCount) {
      const previousConfirmed = this.session.segment.getConfirmedSegments();
      const previousStrokeCount = this.segmentStrokeSignatures.length;
      const rebuilt = core.runGuardedSegmentPipeline(strokes, this.ruleConfig);
      const rebuiltConfirmed = rebuilt.segment.getConfirmedSegments();
      if (!confirmedPrefixIsImmutable(previousConfirmed, rebuiltConfirmed)) {
        throw new Error('R1_CONFIRMED_SEGMENT_CHANGED_BY_UPSTREAM_REBUILD');
      }
      this.session = rebuilt;
      this.segmentStrokeCursor = strokes.length;
      this.segmentStrokeSignatures = signatures;
      this.segmentRebuildCount += 1;
      this.lastSegmentRebuild = {
        reason: 'R1_UPSTREAM_REVISION_REQUIRES_REBUILD',
        firstRevisionStrokeIndex: revisionIndex,
        detectedRawBarCount,
        rebuiltAtRawBarCount: this.processedBarCount,
        previousStrokeCount,
        rebuiltStrokeCount: strokes.length,
      };
      this.restoredContinuation = false;
      this.#rebuildPivot(rebuiltConfirmed);
    }

    #advancePivot() {
      if (this.pendingSegmentRebuild) return;
      const started = now();
      const segments = this.session.segment.getConfirmedSegments();
      while (this.pivotSegmentCursor < segments.length) {
        this.pivot.update(segments[this.pivotSegmentCursor]);
        this.pivotSegmentCursor += 1;
      }
      this.pivotRuntimeMs += now() - started;
    }

    #rebuildPivot(confirmedSegments) {
      const previousPublications = this.pivot.getPublications();
      const rebuilt = new core.PivotStateMachine(this.ruleConfig);
      for (const segment of confirmedSegments) rebuilt.update(segment);
      const rebuiltPublications = rebuilt.getPublications();
      assertPivotConfirmedPrefixImmutable(previousPublications, rebuiltPublications);
      this.pivot = rebuilt;
      this.pivotSegmentCursor = confirmedSegments.length;
      this.pivotRebuildCount += 1;
    }

    getConfirmedFractals() {
      return this.fractal.getConfirmedFractals ? this.fractal.getConfirmedFractals()
        : (this.fractal.getState?.().confirmedFractals || []);
    }

    getConfirmedStrokes() { return this.stroke.getConfirmedStrokes(); }
    getConfirmedSegments() { return this.session.segment.getConfirmedSegments(); }
    getActiveSegment() { return this.session.segment.getActiveSegment(); }
    getHandoffEvents() { return this.session.segment.getHandoffEvents(); }
    getSegmentMachine() { return this.session.segment; }
    getConfirmedPivots() { return this.pivot.getPublications(); }
    getPivotMachine() { return this.pivot; }

    createSnapshot() {
      const normalized = this.normalized.getState();
      const fractal = this.fractal.getState();
      const stroke = this.stroke.getState();
      const segment = this.session.segment.getState();
      const pivot = this.pivot.getState();
      const parserState = core.createCTState({
        currentBarIndex: this.processedBarCount - 1,
        currentBarTime: normalized.currentBarTime,
        ruleVersion: this.ruleConfig.ruleVersion,
        normalizedKState: normalized.normalizedKState,
        fractalState: fractal.fractalState,
        strokeState: stroke.strokeState,
        segmentState: segment.segmentState,
        pivotZoneState: pivot,
        parserMetadata: { parserVersion: PARSER_VERSION, phase: 'Phase6B1' },
      });
      return core.createStateSnapshot({
        parserState,
        sequentialContinuation: this.session.segment.serializeSequentialContinuation(),
        pivotContinuation: this.pivot.serializeContinuation(),
        coreContinuation: this.serializeContinuation(),
      });
    }

    serializeContinuation() {
      return clone({
        continuationVersion: CORE_CONTINUATION_VERSION,
        parserVersion: PARSER_VERSION,
        ruleVersion: this.ruleConfig.ruleVersion,
        structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
        normalizedK: this.normalized.serializeContinuationState(),
        fractal: this.fractal.serializeContinuationState(),
        stroke: this.stroke.serializeContinuationState(),
        segment: this.session.segment.serializeSequentialContinuation(),
        pivot: this.pivot.serializeContinuation(),
        processedBarCount: this.processedBarCount,
        segmentStrokeCursor: this.segmentStrokeCursor,
        segmentStrokeSignatures: this.segmentStrokeSignatures,
        pivotSegmentCursor: this.pivotSegmentCursor,
      });
    }

    restoreSnapshot(snapshot) {
      core.assertStateSnapshot(snapshot);
      const continuation = snapshot.coreContinuation;
      if (!continuation || continuation.continuationVersion !== CORE_CONTINUATION_VERSION) {
        throw new Error('SNAPSHOT_CORE_CONTINUATION_REQUIRED');
      }
      if (continuation.parserVersion !== PARSER_VERSION ||
          continuation.ruleVersion !== this.ruleConfig.ruleVersion ||
          snapshot.ruleVersion !== this.ruleConfig.ruleVersion) {
        throw new Error('CORE_CONTINUATION_VERSION_OR_RULE_MISMATCH');
      }
      this.reset();
      this.normalized.restoreContinuationState(continuation.normalizedK);
      this.fractal.restoreContinuationState(continuation.fractal);
      this.stroke.restoreContinuationState(continuation.stroke);
      this.session.segment.restoreSequentialContinuation(continuation.segment);
      this.pivot.restoreContinuation(continuation.pivot);
      this.processedBarCount = Number(continuation.processedBarCount);
      this.segmentStrokeCursor = Number(continuation.segmentStrokeCursor);
      this.segmentStrokeSignatures = clone(continuation.segmentStrokeSignatures || []);
      this.pivotSegmentCursor = Number(continuation.pivotSegmentCursor);
      if (!Number.isInteger(this.processedBarCount) || this.processedBarCount < 0 ||
          this.processedBarCount !== snapshot.barIndex + 1 ||
          !Number.isInteger(this.segmentStrokeCursor) || this.segmentStrokeCursor < 0 ||
          !Number.isInteger(this.pivotSegmentCursor) || this.pivotSegmentCursor < 0) {
        throw new Error('INVALID_CORE_CONTINUATION_CURSOR');
      }
      this.restoredContinuation = true;
      return this;
    }

    getDiagnostics() {
      const confirmed = this.getConfirmedSegments();
      return {
        parserVersion: PARSER_VERSION,
        rawBars: this.processedBarCount,
        confirmedFractals: this.getConfirmedFractals().length,
        confirmedStrokes: this.getConfirmedStrokes().length,
        confirmedSegments: confirmed.length,
        confirmedPivots: this.getConfirmedPivots().length,
        case1Count: confirmed.filter(item => item.caseType === 'CASE_1').length,
        case2Count: confirmed.filter(item => item.caseType === 'CASE_2').length,
        currentCandidateMode: this.getActiveSegment()?.status || null,
        sequentialStopReason: core.successorDisplayStopReason(this.session.segment),
        segmentRebuildCount: this.segmentRebuildCount,
        lastSegmentRebuild: clone(this.lastSegmentRebuild),
        pivotMode: this.pivot.getMode(),
        pivotFormingSourceCount: this.pivot.serializeContinuation().formingSourceWindow.length,
        lastPivotId: this.pivot.getLatestEstablishedPivot()?.pivotId ?? null,
        lastPivotSourceSequence:
          this.pivot.getLatestEstablishedPivot()?.sourceSequenceIndices ?? [],
        lastPivotEventTime: this.pivot.getLatestEstablishedPivot()?.eventTime ?? null,
        lastPivotConfirmTime: this.pivot.getLatestEstablishedPivot()?.confirmTime ?? null,
        lastPivotZD: this.pivot.getLatestEstablishedPivot()?.ZD ?? null,
        lastPivotZG: this.pivot.getLatestEstablishedPivot()?.ZG ?? null,
        pivotStopReason: this.pivot.getStopReason(),
        pivotRebuildCount: this.pivotRebuildCount,
        pivotRuntimeMs: this.pivotRuntimeMs,
        parserRuntimeMs: this.parserRuntimeMs,
        segmentRuntimeMs: this.segmentRuntimeMs,
      };
    }

    toDrawingRecords() {
      return {
        source: 'CTParserPipeline',
        fractals: this.getConfirmedFractals().map(toFractalView),
        strokes: this.getConfirmedStrokes().map(toStrokeView),
        segments: this.getConfirmedSegments().map(toSegmentView),
        pivots: this.getConfirmedPivots().map(toPivotView),
      };
    }
  }

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function strokeSignature(stroke) {
    const structuralIdentity = {
      strokeId: stroke.strokeId || stroke.structureId || null,
      status: stroke.status || null,
      direction: stroke.direction || null,
      startFractalId: stroke.startFractalId || null,
      endFractalId: stroke.endFractalId || null,
      startIndex: stroke.startIndex ?? null,
      endIndex: stroke.endIndex ?? null,
      startPrice: stroke.startPrice ?? null,
      endPrice: stroke.endPrice ?? null,
      eventTime: stroke.eventTime ?? null,
      confirmTime: stroke.confirmTime ?? null,
      ruleVersion: stroke.ruleVersion || null,
    };
    return core.canonicalStateJson
      ? core.canonicalStateJson(structuralIdentity)
      : JSON.stringify(structuralIdentity);
  }

  function sealedSegmentSourceStrokes(strokes) {
    const list = Array.isArray(strokes) ? strokes : [];
    return list.length > 0 ? list.slice(0, -1) : [];
  }

  function firstRevisionIndex(previous, current) {
    const shared = Math.min(previous.length, current.length);
    for (let index = 0; index < shared; index += 1) {
      if (previous[index] !== current[index]) return index;
    }
    return current.length < previous.length ? current.length : -1;
  }

  function confirmedPrefixIsImmutable(previous, rebuilt) {
    if (rebuilt.length < previous.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      const left = core.canonicalStateJson
        ? core.canonicalStateJson(previous[index])
        : JSON.stringify(previous[index]);
      const right = core.canonicalStateJson
        ? core.canonicalStateJson(rebuilt[index])
        : JSON.stringify(rebuilt[index]);
      if (left !== right) return false;
    }
    return true;
  }

  function assertPivotConfirmedPrefixImmutable(previous, rebuilt) {
    if (!confirmedPrefixIsImmutable(previous, rebuilt)) {
      throw new Error('PIVOT_CONFIRMED_PREFIX_IMMUTABILITY_VIOLATION');
    }
    return true;
  }

  function toFractalView(fractal) {
    return {
      kind: 'FRACTAL',
      structureId: fractal.structureId,
      type: fractal.type,
      barIndex: fractal.eventRawBarIndex ?? fractal.eventIndex,
      price: fractal.price,
      eventTime: fractal.eventTime,
      confirmTime: fractal.confirmTime,
      confirmRawBarIndex: fractal.confirmRawBarIndex ?? fractal.confirmIndex,
      ruleVersion: fractal.ruleVersion,
      sourceNormalizedKIds: clone(fractal.sourceKIds || []),
    };
  }

  function toStrokeView(stroke) {
    return {
      kind: 'STROKE',
      structureId: stroke.strokeId || stroke.structureId,
      startBarIndex: stroke.startIndex,
      startPrice: stroke.startPrice,
      endBarIndex: stroke.endIndex,
      endPrice: stroke.endPrice,
      direction: stroke.direction,
      eventTime: stroke.eventTime,
      confirmTime: stroke.confirmTime,
      confirmRawBarIndex: stroke.confirmRawBarIndex ?? stroke.confirmIndex,
      ruleVersion: stroke.ruleVersion,
    };
  }

  function toSegmentView(segment) {
    return {
      kind: 'SEGMENT',
      structureId: segment.confirmedSegmentId || segment.segmentId,
      sequenceIndex: segment.segmentSequenceIndex,
      direction: segment.direction,
      caseType: segment.caseType,
      startBarIndex: segment.startIndex,
      startPrice: segment.startPrice,
      endBarIndex: segment.eventRawBarIndex ?? segment.endIndex,
      endPrice: segment.endpointPrice ?? segment.endPrice,
      eventTime: segment.eventTime,
      confirmTime: segment.confirmTime,
      case2EntryTime: segment.case2EntryTime || segment.metadata?.case2EntryTime || null,
      confirmRawBarIndex: segment.confirmRawBarIndex ?? segment.confirmIndex,
      ruleVersion: segment.segmentRuleVersion || segment.ruleVersion,
      predecessorSegmentId: segment.predecessorSegmentId || null,
    };
  }

  function toPivotView(pivot) {
    return {
      kind: 'PIVOT',
      structureId: pivot.pivotId,
      pivotId: pivot.pivotId,
      status: 'ESTABLISHED',
      label: 'CT Pivot',
      ZD: pivot.ZD,
      ZG: pivot.ZG,
      DD: pivot.DD,
      GG: pivot.GG,
      W_Z: pivot.W_Z,
      R_Z: pivot.R_Z,
      omega_Z: pivot.omega_Z,
      eta_Z: pivot.eta_Z,
      startBarIndex: pivot.displayStartRawBarIndex,
      endBarIndex: pivot.displayEndRawBarIndex,
      eventTime: pivot.eventTime,
      confirmTime: pivot.confirmTime,
      confirmRawBarIndex: pivot.confirmRawBarIndex,
      sourceSegmentIds: clone(pivot.sourceSegmentIds),
      sourceSequenceIndices: clone(pivot.sourceSequenceIndices),
      ruleVersion: pivot.ruleVersion,
      timeSchemaVersion: pivot.timeSchemaVersion,
      provenance: clone(pivot.provenance),
    };
  }

  Object.assign(core, {
    CT_CORE_PARSER_VERSION: PARSER_VERSION,
    CT_CORE_CONTINUATION_VERSION: CORE_CONTINUATION_VERSION,
    CT_PARSER_PIPELINE_VERSION: PARSER_VERSION,
    CTParserPipeline,
    assertPivotConfirmedPrefixImmutable,
    toFractalDrawingRecord: toFractalView,
    toStrokeDrawingRecord: toStrokeView,
    toSegmentDrawingRecord: toSegmentView,
    toPivotDrawingRecord: toPivotView,
  });
})();

