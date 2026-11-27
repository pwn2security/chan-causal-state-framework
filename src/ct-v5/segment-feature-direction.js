(function () {
  'use strict';
  const core = window.MarketCore = window.MarketCore || {};
  // Structural direction is independent of the candidate segment direction.
  function resolveFeatureSequenceDirection(previous, current, tolerance = 0) {
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('INVALID_TOLERANCE');
    const values = [previous.low, previous.high, current.low, current.high];
    if (!values.every(Number.isFinite) || previous.low > previous.high || current.low > current.high) throw new Error('INVALID_INTERVAL');
    if (current.high > previous.high + tolerance && current.low > previous.low + tolerance) return 'UP';
    if (current.high < previous.high - tolerance && current.low < previous.low - tolerance) return 'DOWN';
    return 'UNKNOWN';
  }
  core.resolveFeatureSequenceDirection = resolveFeatureSequenceDirection;
})();
