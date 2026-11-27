(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const CT_SNAPSHOT_SCHEMA_VERSION = 'CT-StateSnapshot-v5.0';
  const CT_SNAPSHOT_PREVIOUS_SCHEMA_VERSION = 'CT-StateSnapshot-v4.0';
  const CT_SNAPSHOT_LEGACY_SCHEMA_VERSION = 'CT-StateSnapshot-v3.0';

  function isCTState(value) {
    return !!value && typeof value === 'object' &&
      value.normalizedKState && value.fractalState && value.currentBarIndex !== undefined;
  }

  function collectActiveMemory(parserState) {
    const layerFields = core.CT_LAYER_FIELDS || {};
    const activeMemory = {};
    for (const field of Object.values(layerFields)) {
      activeMemory[field] = core.clonePlain?.(parserState?.[field]?.activeMemory || {}) || {};
    }
    return (core.deepFreeze || Object.freeze)(activeMemory);
  }

  function sequentialContinuationOf(input, parserState) {
    if (input.sequentialContinuation !== undefined) return input.sequentialContinuation;
    if (input.sequential_continuation !== undefined) return input.sequential_continuation;
    return parserState?.segmentState?.activeMemory?.sequentialContinuation ?? null;
  }

  function emptyPivotContinuation() {
    if (typeof core.createEmptyPivotContinuation === 'function') return core.createEmptyPivotContinuation();
    return (core.deepFreeze || Object.freeze)({
      continuationVersion: 'CT-Pivot-Continuation-v2.0',
      mode: 'NONE',
      formingSourceWindow: [],
      sourceCursor: null,
      consumedSegmentIds: [],
      latestEstablishedPivot: null,
      publicationCursor: 0,
      stopReason: null,
      ruleVersion: 'CT-Pivot-Establishment-R1.0',
      timeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
    });
  }

  function pivotContinuationOf(input, parserState) {
    if (input.pivotContinuation !== undefined) return input.pivotContinuation;
    if (input.pivot_continuation !== undefined) return input.pivot_continuation;
    return parserState?.pivotZoneState?.activeMemory?.pivotContinuation ?? emptyPivotContinuation();
  }

  function createStateSnapshot(input = {}, options = {}) {
    const parserState = isCTState(input)
      ? input
      : (input.parserState ?? input.parser_state ?? input.ctState ?? input.ct_state);
    if (!isCTState(parserState)) throw new Error('StateSnapshot requires a CTState parserState');
    const stateWithHash = parserState.stateHash ? parserState : core.attachStateHash(parserState);
    const stateHash = stateWithHash.stateHash;
    const barIndex = Number(input.barIndex ?? input.bar_index ?? stateWithHash.currentBarIndex);
    if (!Number.isInteger(barIndex) || barIndex < -1) {
      throw new Error('snapshot.barIndex must be an integer >= -1');
    }
    const barTime = input.barTime ?? input.bar_time ?? stateWithHash.currentBarTime ?? null;
    const ruleVersion = String(input.ruleVersion ?? input.rule_version ?? stateWithHash.ruleVersion);
    const sequentialContinuation = sequentialContinuationOf(input, stateWithHash);
    const pivotContinuation = pivotContinuationOf(input, stateWithHash);
    const coreContinuation = input.coreContinuation ?? input.core_continuation ?? null;
    const snapshotId = String(input.snapshotId ?? input.snapshot_id ??
      `snapshot:${CT_SNAPSHOT_SCHEMA_VERSION}:${ruleVersion}:${barIndex}:${String(stateHash).slice(0, 16)}`);
    return (core.deepFreeze || Object.freeze)({
      snapshotId,
      snapshotSchemaVersion: CT_SNAPSHOT_SCHEMA_VERSION,
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      barIndex,
      barTime: Number.isFinite(Number(barTime)) ? Number(barTime) : null,
      parserState: stateWithHash,
      activeMemory: input.activeMemory ?? input.active_memory ?? collectActiveMemory(stateWithHash),
      sequentialContinuation,
      pivotContinuation,
      coreContinuation,
      ruleVersion,
      stateHash,
      createdAt: options.createdAt ?? input.createdAt ?? input.created_at ?? null,
      snapshotFeatures: Object.freeze({ boundedContinuation: true, pivotPublications: true, continuationOnlySuffix: true }),
    });
  }

  function assertStateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot is required');
    if (snapshot.snapshotSchemaVersion !== CT_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(`INCOMPATIBLE_SNAPSHOT_SCHEMA: expected ${CT_SNAPSHOT_SCHEMA_VERSION}, got ${String(snapshot.snapshotSchemaVersion || 'UNVERSIONED')}`);
    }
    if (snapshot.structuralTimeSchemaVersion !== core.CT_STRUCTURAL_TIME_SCHEMA_VERSION) {
      throw new Error(`INCOMPATIBLE_STRUCTURAL_TIME_SCHEMA: expected ${core.CT_STRUCTURAL_TIME_SCHEMA_VERSION}, got ${String(snapshot.structuralTimeSchemaVersion || 'UNVERSIONED')}`);
    }
    if (!snapshot.snapshotFeatures || snapshot.snapshotFeatures.boundedContinuation !== true || snapshot.snapshotFeatures.pivotPublications !== true || snapshot.snapshotFeatures.continuationOnlySuffix !== true) {
      throw new Error('SNAPSHOT_V5_FEATURES_REQUIRED');
    }
    if (!Object.prototype.hasOwnProperty.call(snapshot, 'sequentialContinuation')) {
      throw new Error('SNAPSHOT_SEQUENTIAL_CONTINUATION_REQUIRED');
    }
    if (!Object.prototype.hasOwnProperty.call(snapshot, 'pivotContinuation')) {
      throw new Error('SNAPSHOT_PIVOT_CONTINUATION_REQUIRED');
    }
    if (!snapshot.pivotContinuation ||
        snapshot.pivotContinuation.continuationVersion !== 'CT-Pivot-Continuation-v2.0') {
      throw new Error('INCOMPATIBLE_PIVOT_CONTINUATION');
    }
    if (!String(snapshot.snapshotId || '')) throw new Error('snapshotId is required');
    if (!Number.isInteger(Number(snapshot.barIndex)) || Number(snapshot.barIndex) < -1) {
      throw new Error('snapshot.barIndex must be an integer >= -1');
    }
    if (!isCTState(snapshot.parserState)) throw new Error('snapshot.parserState must be CTState');
    const expected = core.computeStateHash(snapshot.parserState);
    if (snapshot.stateHash !== expected) throw new Error('snapshot.stateHash does not match parserState');
    return true;
  }

  function migrateStateSnapshotV2ToV3(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot is required');
    if (snapshot.snapshotSchemaVersion === 'CT-StateSnapshot-v4.0') {
      return snapshot;
    }
    if (snapshot.snapshotSchemaVersion !== CT_SNAPSHOT_LEGACY_SCHEMA_VERSION) {
      throw new Error(`LOSSY_SNAPSHOT_MIGRATION: unsupported source ${String(snapshot.snapshotSchemaVersion)}`);
    }
    const confirmed = Number(snapshot.parserState?.segmentState?.continuousState?.confirmedSegmentCount || 0);
    const existing = snapshot.parserState?.segmentState?.activeMemory?.sequentialContinuation;
    if (confirmed > 0 && !existing) {
      throw new Error('LOSSY_SNAPSHOT_MIGRATION: v2 confirmed Segment state has no sequential continuation');
    }
    const parserState = snapshot.parserState.stateHash
      ? snapshot.parserState : core.attachStateHash(snapshot.parserState);
    return (core.deepFreeze || Object.freeze)({
      snapshotId: `snapshot:CT-StateSnapshot-v4.0:${snapshot.ruleVersion}:${snapshot.barIndex}:${String(parserState.stateHash).slice(0, 16)}`,
      snapshotSchemaVersion: 'CT-StateSnapshot-v4.0',
      structuralTimeSchemaVersion: core.CT_STRUCTURAL_TIME_SCHEMA_VERSION,
      parserState,
      activeMemory: snapshot.activeMemory ?? collectActiveMemory(parserState),
      barIndex: snapshot.barIndex,
      barTime: snapshot.barTime,
      ruleVersion: snapshot.ruleVersion,
      sequentialContinuation: existing ?? null,
      stateHash: parserState.stateHash,
      createdAt: snapshot.createdAt ?? null,
    });
  }

  function migrateStateSnapshotV4ToV5(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot is required');
    if (snapshot.snapshotSchemaVersion === CT_SNAPSHOT_SCHEMA_VERSION) {
      assertStateSnapshot(snapshot);
      return snapshot;
    }
    if (snapshot.snapshotSchemaVersion !== CT_SNAPSHOT_PREVIOUS_SCHEMA_VERSION) {
      throw new Error(`LOSSY_SNAPSHOT_MIGRATION: unsupported source ${String(snapshot.snapshotSchemaVersion)}`);
    }
    const pivotLayer = snapshot.parserState?.pivotZoneState;
    const pivotMode = String(pivotLayer?.mode || 'NONE');
    const pivotStructures = pivotLayer?.structures || [];
    if (pivotMode !== 'NONE' || pivotStructures.length > 0) {
      throw new Error('LOSSY_SNAPSHOT_MIGRATION: v3 contains Pivot state without pivotContinuation');
    }
    return createStateSnapshot({
      parserState: snapshot.parserState,
      barIndex: snapshot.barIndex,
      barTime: snapshot.barTime,
      ruleVersion: snapshot.ruleVersion,
      sequentialContinuation: snapshot.sequentialContinuation ?? null,
      pivotContinuation: emptyPivotContinuation(),
      coreContinuation: null,
      createdAt: snapshot.createdAt ?? null,
    });
  }

  function migrateStateSnapshotToV5(snapshot) {
    if (snapshot?.snapshotSchemaVersion === CT_SNAPSHOT_LEGACY_SCHEMA_VERSION) {
      return migrateStateSnapshotV4ToV5(migrateStateSnapshotV2ToV3(snapshot));
    }
    return migrateStateSnapshotV4ToV5(snapshot);
  }

  function restoreCTStateFromSnapshot(snapshot) {
    assertStateSnapshot(snapshot);
    return core.clonePlain ? core.clonePlain(snapshot.parserState) : JSON.parse(JSON.stringify(snapshot.parserState));
  }

  Object.assign(core, {
    CT_SNAPSHOT_SCHEMA_VERSION,
    CT_SNAPSHOT_PREVIOUS_SCHEMA_VERSION,
    CT_SNAPSHOT_LEGACY_SCHEMA_VERSION,
    collectActiveMemory,
    createStateSnapshot,
    assertStateSnapshot,
    migrateStateSnapshotV2ToV3,
    migrateStateSnapshotV4ToV5,
    migrateStateSnapshotToV5,
    restoreCTStateFromSnapshot,
  });
})();


