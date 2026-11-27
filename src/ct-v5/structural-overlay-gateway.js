(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};

  function knownAtCursor(items, cursorIndex, retrospective) {
    if (retrospective) return items.slice();
    return items.filter(item => {
      const confirm = Number(item.confirmRawBarIndex);
      return Number.isFinite(confirm) && confirm <= cursorIndex;
    });
  }

  class StructuralOverlayGateway {
    build(records, cursorIndex, options = {}) {
      const source = records || {};
      if (source.source && source.source !== 'CTParserPipeline' && source.source !== 'parser') {
        throw new Error('STRUCTURAL_OVERLAY_REQUIRES_PARSER_RECORDS');
      }
      const retrospective = options.retrospective === true || options.paperFigureMode === true;
      const fractals = options.showFractals === false ? []
        : knownAtCursor(source.fractals || [], cursorIndex, retrospective);
      const strokes = options.showStrokes === false ? []
        : knownAtCursor(source.strokes || [], cursorIndex, retrospective);
      const segments = options.showSegments === false ? []
        : knownAtCursor(source.segments || [], cursorIndex, retrospective);
      const pivots = options.showPivots === false ? []
        : knownAtCursor(source.pivots || [], cursorIndex, retrospective);
      return Object.freeze({
        source: 'parser',
        fractals: Object.freeze(fractals.slice()),
        strokes: Object.freeze(strokes.slice()),
        segments: Object.freeze(segments.slice()),
        pivots: Object.freeze(pivots.slice()),
        metrics: Object.freeze({
          inputFractalCount: (source.fractals || []).length,
          inputStrokeCount: (source.strokes || []).length,
          inputSegmentCount: (source.segments || []).length,
          inputPivotCount: (source.pivots || []).length,
          knownFractalCount: fractals.length,
          knownStrokeCount: strokes.length,
          knownSegmentCount: segments.length,
          knownPivotCount: pivots.length,
        }),
      });
    }
  }

  core.StructuralOverlayGateway = StructuralOverlayGateway;
})();
