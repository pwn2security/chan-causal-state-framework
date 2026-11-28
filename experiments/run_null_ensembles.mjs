/**
 * R8 Step 5: Checkpointed, Resumable Parallel Dual-Axis Null-Model Engine.
 *
 * Runs CT-Core-Parser-R1.0.4 (Variant A, Snapshot v5) in bit-identical 'audit_hooks_off' mode
 * (verified 8/8 SHA-256 identical in equivalence_spotcheck.json).
 *
 * Captures single-pass Finite-Size Scaling (FSS) snapshots at N in {720, 1440, 2880}
 * on EVERY null trajectory and writes results incrementally to JSONL so runs are 100% resumable.
 *
 * Usage:
 *   node run_null_ensembles.mjs --arm arm1 --paths 25 --workers 8
 *   node run_null_ensembles.mjs --arm arm2 --paths 25 --workers 8
 *   node run_null_ensembles.mjs --arm arm3 --paths 10 --workers 8
 *   node run_null_ensembles.mjs --arm cbb_sens --paths 10 --workers 8
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createFastSandboxCore, loadFrozenRuleConfig } from './incremental_tail_sandbox.mjs';
import { generateSurrogate } from './null_surrogates.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R8_ROOT = process.env.CT_DATA_ROOT || path.join(REPO_ROOT, 'local_data', 'extended_validation');
const OUT_DIR = process.env.CT_RESULTS_DIR || path.join(REPO_ROOT, 'results');

function resolveWindowPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(R8_ROOT, filePath);
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

function computeBarMicro(bars, n) {
  let zr = 0, eb = 0;
  for (let i = 0; i < n; i += 1) {
    if (bars[i].high === bars[i].low) zr += 1;
    if (i > 0 && (bars[i].high === bars[i - 1].high || bars[i].low === bars[i - 1].low)) eb += 1;
  }
  return {
    zeroRangePct: (100 * zr) / n,
    equalBoundPct: (100 * eb) / (n - 1),
  };
}

function extractSnap(sealed, bars, n) {
  const K = sealed.normalizedK.length;
  const F = sealed.fractals.length;
  const B = sealed.strokes.length;
  const S = sealed.segments.length;
  const Z = sealed.pivots.length;
  const bLags = sealed.strokes.map(o => (o.confirmTime - o.eventTime) / 60000);
  const sLags = sealed.segments.map(o => (o.confirmTime - o.eventTime) / 60000);
  const zLags = sealed.pivots.map(o => (o.confirmTime - o.eventTime) / 60000);
  const ms = computeBarMicro(bars, n);
  const firstPivotNativeBar = Z > 0 ? sealed.pivots[0].confirmRawBarIndex : null;
  return {
    N: n,
    K, F, B, S, Z,
    K_over_N: (100 * K) / n,
    F_over_K: K > 0 ? (100 * F) / K : null,
    B_over_K: K > 0 ? (100 * B) / K : null,
    B_over_F: F > 0 ? (100 * B) / F : null,
    S_norm_720: S / (n / 720),
    I_Z: Z >= 1 ? 1 : 0,
    firstPivotNativeBar,
    meanBLagMin: bLags.length ? bLags.reduce((a, b) => a + b, 0) / bLags.length : null,
    medianSLagMin: median(sLags),
    zLagMin: zLags.length ? zLags[0] : null,
    zeroRangePct: ms.zeroRangePct,
    equalBoundPct: ms.equalBoundPct,
  };
}

// Persistent worker thread: caches window files and sandbox core across jobs!
if (!isMainThread) {
  const core = createFastSandboxCore();
  const winCache = new Map();
  const cfgCache = new Map();

  parentPort.on('message', (job) => {
    try {
      let realBars = winCache.get(job.filePath);
      if (!realBars) {
        realBars = JSON.parse(fs.readFileSync(job.filePath, 'utf8')).bars;
        winCache.set(job.filePath, realBars);
      }
      let cfg = cfgCache.get(job.mB);
      if (!cfg) {
        cfg = loadFrozenRuleConfig(job.mB === 2 ? {} : { minimumStrokeSeparation: job.mB });
        cfgCache.set(job.mB, cfg);
      }

      const bars = generateSurrogate(job.model, realBars, job.windowId, job.pathIdx, job.tickSize, job.garchFit);
      const parser = new core.CTCoreParser(cfg);
      const t0 = performance.now();
      const snaps = {};

      for (let k = 0; k < bars.length; k += 1) {
        parser.ingestClosedBar(bars[k]);
        const bc = k + 1;
        if (bc === 720 || bc === 1440 || bc === 2880) {
          snaps[bc] = extractSnap(parser.getConfirmedStructures(), bars, bc);
        }
      }
      const elapsedSec = (performance.now() - t0) / 1000;
      parentPort.postMessage({
        ok: true,
        result: {
          jobKey: job.jobKey,
          arm: job.arm,
          windowId: job.windowId,
          symbol: job.symbol,
          startDate: job.startDate,
          interval: job.interval,
          mB: job.mB,
          model: job.model,
          pathIdx: job.pathIdx,
          elapsedSec: Number(elapsedSec.toFixed(2)),
          snaps,
        },
      });
    } catch (err) {
      parentPort.postMessage({ ok: false, jobKey: job.jobKey, error: String(err?.stack || err) });
    }
  });
} else {
  // Parse CLI flags
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
  };
  const arm = getArg('--arm', 'arm1');
  const modelFilter = getArg('--model', 'all');
  const pathsPerWin = Number(getArg('--paths', arm === 'arm3' || arm === 'cbb_sens' ? '10' : '25'));
  const numWorkers = Number(getArg('--workers', String(Math.min(8, Math.max(2, os.cpus().length - 2)))));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifestPath = fs.existsSync(path.join(R8_ROOT, 'manifests/extended_window_manifest.json'))
    ? path.join(R8_ROOT, 'manifests/extended_window_manifest.json')
    : path.join(REPO_ROOT, 'manifests/extended_window_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const garchPath = fs.existsSync(path.join(OUT_DIR, 'garch_qmle_fit_log.json'))
    ? path.join(OUT_DIR, 'garch_qmle_fit_log.json')
    : path.join(REPO_ROOT, 'manifests/results_summary/garch_qmle_fit_log.json');
  const garchLog = JSON.parse(fs.readFileSync(garchPath, 'utf8')).fits;

  const armSpecs = {
    arm1: {
      windows: manifest.arm1_1m_48h,
      mB: 2,
      models: ['shuffled_L1', 'cbb_L30', 'cont_gbm', 'tq_gbm', 'tq_garch'],
      outFile: path.join(OUT_DIR, 'nulls_arm1_mB2.jsonl'),
    },
    arm2: {
      windows: manifest.arm2_15m_30d,
      mB: 2,
      models: ['shuffled_L1', 'cbb_L30', 'cont_gbm', 'tq_gbm', 'tq_garch'],
      outFile: path.join(OUT_DIR, 'nulls_arm2_15m_mB2.jsonl'),
    },
    arm3: {
      windows: manifest.arm1_1m_48h,
      mB: 4,
      models: ['shuffled_L1', 'cbb_L30', 'tq_gbm', 'tq_garch'],
      outFile: path.join(OUT_DIR, 'nulls_arm3_mB4.jsonl'),
    },
    cbb_sens: {
      windows: manifest.arm1_1m_48h,
      mB: 2,
      models: ['cbb_L15', 'cbb_L60', 'sbb_L30'],
      outFile: path.join(OUT_DIR, 'nulls_cbb_sensitivity.jsonl'),
    },
  };

  const spec = armSpecs[arm];
  if (!spec) throw new Error(`Unknown --arm ${arm}`);

  // Load already-completed keys for 100% safe resume
  const completed = new Set();
  if (fs.existsSync(spec.outFile)) {
    const lines = fs.readFileSync(spec.outFile, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.jobKey) completed.add(rec.jobKey);
      } catch {}
    }
  }

  const activeModels = modelFilter === 'all' ? spec.models : spec.models.filter(m => m === modelFilter);
  const pendingJobs = [];
  for (const model of activeModels) {
    for (let p = 0; p < pathsPerWin; p += 1) {
      for (const w of spec.windows) {
        const jobKey = `${arm}|${w.windowId}|mB${spec.mB}|${model}|p${p}`;
        if (completed.has(jobKey)) continue;
        pendingJobs.push({
          jobKey,
          arm,
          windowId: w.windowId,
          symbol: w.symbol,
          startDate: w.startDate,
          interval: w.interval,
          tickSize: w.tickSize,
          filePath: resolveWindowPath(w.filePath),
          mB: spec.mB,
          model,
          pathIdx: p,
          garchFit: model === 'tq_garch' ? garchLog[w.windowId] : null,
        });
      }
    }
  }

  console.log(`[${arm}] totalModels=${activeModels.join(',')} paths/win=${pathsPerWin} alreadyDone=${completed.size} pending=${pendingJobs.length} workers=${numWorkers}`);
  if (pendingJobs.length === 0) {
    console.log(`[${arm}] All jobs already complete!`);
    process.exit(0);
  }

  const tStart = performance.now();
  let nextIdx = 0;
  let doneCount = 0;
  const outStream = fs.createWriteStream(spec.outFile, { flags: 'a' });

  await new Promise((resolve, reject) => {
    const workers = [];
    let alive = numWorkers;

    const sendNext = (worker) => {
      if (nextIdx < pendingJobs.length) {
        worker.postMessage(pendingJobs[nextIdx++]);
      } else {
        worker.terminate();
      }
    };

    for (let i = 0; i < numWorkers; i += 1) {
      const worker = new Worker(fileURLToPath(import.meta.url));
      workers.push(worker);
      worker.on('message', (msg) => {
        if (!msg.ok) {
          reject(new Error(`Job failed ${msg.jobKey}: ${msg.error}`));
          return;
        }
        outStream.write(JSON.stringify(msg.result) + '\n');
        doneCount += 1;
        if (doneCount % 20 === 0 || doneCount === pendingJobs.length || doneCount <= 8) {
          const elSec = (performance.now() - tStart) / 1000;
          const rate = doneCount / elSec;
          const etaMin = (pendingJobs.length - doneCount) / Math.max(rate, 1e-9) / 60;
          console.log(
            `  [${arm}] ${doneCount}/${pendingJobs.length} (${((100 * doneCount) / pendingJobs.length).toFixed(1)}%) ` +
            `elapsed=${(elSec / 60).toFixed(1)}m ETA=${etaMin.toFixed(1)}m last=${msg.result.model}:${msg.result.symbol} (${msg.result.elapsedSec}s)`
          );
        }
        sendNext(worker);
      });
      worker.on('error', reject);
      worker.on('exit', () => {
        alive -= 1;
        if (alive === 0) resolve();
      });
      sendNext(worker);
    }
  });

  outStream.end();
  console.log(`[${arm}] COMPLETE! Finished ${doneCount} jobs in ${((performance.now() - tStart) / 60000).toFixed(2)} min -> ${spec.outFile}`);
}

