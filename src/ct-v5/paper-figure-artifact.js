(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const clone = value => core.clonePlain ? core.clonePlain(value) : JSON.parse(JSON.stringify(value));
  const ARTIFACT_SCHEMA = 'CT-Paper-Figure-Artifact-v1.0';

  function hashJson(value) {
    const text = core.canonicalStateJson ? core.canonicalStateJson(value) : JSON.stringify(value);
    if (typeof core.sha256Hex === 'function') return core.sha256Hex(text);
    if (typeof core.computeUtf8Sha256 === 'function') return core.computeUtf8Sha256(text);
    return `len:${text.length}`;
  }

  function createPaperFigureArtifact(input = {}) {
    const ohlc = clone(input.ohlc || []);
    const fractals = clone(input.fractals || []);
    const strokes = clone(input.strokes || []);
    const segments = clone(input.segments || []);
    const pivots = clone(input.pivots || []);
    const artifact = {
      artifactSchemaVersion: ARTIFACT_SCHEMA,
      figureCaseId: String(input.figureCaseId || 'UNNAMED'),
      dataset: input.dataset || null,
      datasetHash: input.datasetHash || (input.dataset ? hashJson(input.dataset) : null),
      ruleManifest: clone(input.ruleManifest || {}),
      parserVersion: input.parserVersion || core.CT_PARSER_PIPELINE_VERSION,
      snapshotVersion: input.snapshotVersion || core.CT_SNAPSHOT_SCHEMA_VERSION,
      timeSchemaVersion: input.timeSchemaVersion || core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      range: clone(input.range || null),
      classification: input.classification || 'development',
      ohlc,
      fractals,
      strokes,
      segments,
      pivots,
      case2Timeline: clone(input.case2Timeline || null),
      sequentialTrace: clone(input.sequentialTrace || []),
      diagnostics: clone(input.diagnostics || {}),
      createdBy: input.createdBy || 'CT-Structural-Parser',
      note: input.note || 'Machine-readable structural data. Not a Formal E1-E5 result.',
    };
    artifact.artifactHash = hashJson({
      figureCaseId: artifact.figureCaseId,
      datasetHash: artifact.datasetHash,
      segments: artifact.segments,
      strokes: artifact.strokes,
      fractals: artifact.fractals,
      pivots: artifact.pivots,
    });
    return artifact;
  }

  function buildCase2Timeline(segment) {
    if (!segment || segment.caseType !== 'CASE_2') return null;
    return {
      t_event: segment.eventTime,
      t_entry: segment.case2EntryTime || segment.metadata?.case2EntryTime || null,
      t_confirm: segment.confirmTime,
      endpointEvent: segment.eventTime,
      case2Entry: segment.case2EntryTime || segment.metadata?.case2EntryTime || null,
      reverseConfirmation: segment.confirmTime,
      segmentConfirmation: segment.confirmTime,
      segmentId: segment.confirmedSegmentId || segment.segmentId,
    };
  }

  Object.assign(core, {
    CT_PAPER_FIGURE_ARTIFACT_SCHEMA: ARTIFACT_SCHEMA,
    createPaperFigureArtifact,
    buildCase2Timeline,
  });
})();
