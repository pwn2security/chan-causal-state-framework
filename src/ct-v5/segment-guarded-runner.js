(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};

  function createGuardedSegmentSession(ruleConfig) {
    const config = core.createCTRuleConfig(ruleConfig || {});
    return {
      ruleConfig: config,
      segment: new core.SegmentStateMachine(config),
      engine: null,
      featureOrdinal: 0,
    };
  }

  function advanceGuardedSegment(session, strokes, index, options = {}) {
    const segment = session.segment;
    const prefix = strokes.slice(0, index + 1);
    // A restored parser has only a bounded continuation buffer.  Feeding the
    // entire historical prefix would invoke a different input path than the
    // continuous parser.  Consume exactly the newly sealed suffix stroke.
    segment.update(options.continuationOnly ? [strokes[index]] : prefix);
    const candidate = segment.getActiveSegment();
    if (!candidate) return session;
    const raw = core.buildFeatureSequence(segment.getCandidateStrokes(), {
      ruleConfig: session.ruleConfig,
      segmentStartDirection: candidate.direction,
    });
    if (!session.engine || session.engine.context.candidateSegmentId !== candidate.segmentId) {
      session.engine = new core.FeatureSequenceInclusionStateMachine({
        ...raw,
        candidateSegmentId: candidate.segmentId,
      });
      session.featureOrdinal = 0;
    }
    while (session.featureOrdinal < raw.elements.length) {
      session.engine.update(raw.elements[session.featureOrdinal++]);
    }
    const sequence = session.engine.getState();
    const fractals = core.detectFeatureFractals(session.engine.getDetectorInput(), {
      ruleConfig: session.ruleConfig,
    });
    for (const featureFractal of fractals.confirmedFeatureFractals) {
      if (!segment.getActiveSegment()) break;
      const input = {
        standardizedSequence: sequence,
        featureFractal,
        confirmedFeatureFractal: featureFractal,
        gapResult: core.getCase1RelevantGap(sequence, featureFractal, session.ruleConfig),
        currentAvailability: {
          rawBarIndex: strokes[index].confirmIndex ?? strokes[index].confirmRawBarIndex,
          time: strokes[index].confirmTime,
        },
        ruleConfig: session.ruleConfig,
      };
      const case1 = segment.confirmCase1(input);
      if (!case1.decision?.eligible && case1.decision?.reason === 'GAP_REQUIRES_CASE2') {
        segment.beginCase2(input);
      }
    }
    const pending = segment.getPendingTerminations()[0];
    if (pending) {
      try {
        segment.updateCase2Stroke(strokes[index], {
          rawBarIndex: strokes[index].confirmIndex ?? strokes[index].confirmRawBarIndex,
          time: strokes[index].confirmTime,
        }, {
          candidateSegmentId: pending.candidateSegmentId,
          endpointIdentity: pending.endpointIdentity,
          ruleVersion: pending.ruleVersion,
        });
      } catch { /* reverse identity may not match this prefix stroke */ }
    }
    return session;
  }

  function runGuardedSegmentPipeline(strokes, ruleConfig) {
    const session = createGuardedSegmentSession(ruleConfig);
    for (let index = 0; index < strokes.length; index += 1) {
      advanceGuardedSegment(session, strokes, index);
    }
    return session;
  }

  function successorDisplayStopReason(segment) {
    const stop = segment.getSequentialStopReason();
    if (stop) return stop;
    if (segment.getActiveSegment()) return 'END_OF_DATA_WITH_ACTIVE_CANDIDATE';
    return null;
  }

  Object.assign(core, {
    createGuardedSegmentSession,
    advanceGuardedSegment,
    runGuardedSegmentPipeline,
    successorDisplayStopReason,
  });
})();

