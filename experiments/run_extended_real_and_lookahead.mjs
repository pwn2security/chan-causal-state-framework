/**
 * R8 Step 4: Parallel Real-Market Runner covering:
 *   - Arm 1: 24 weekday 48h 1m real windows (mB=2 & mB=4) + FSS(720,1440,2880) + 4-clock lookahead
 *   - Arm 2: 4 contiguous 30d 15m real windows (mB=2 & mB=4) + FSS(720,1440,2880) + 4-clock lookahead
 *   - Matched TQ-GBM: 24 48h 1m paths (mB=2 & mB=4) + 4-clock mechanical lookahead control
 *   - Contiguous 10,000-bar BTCUSDT 1m seamless runtime scaling + FSS(120..10000)
 *
 * Uses frozen CT-Core-Parser-R1.0.4 (Variant A, Snapshot v5) in bit-identical 'audit_hooks_off' mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createSandboxCore, loadFrozenRuleConfig } from './sandbox_core.mjs';
import { generateSurrogate } from './null_surrogates.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R8_ROOT = process.env.CT_DATA_ROOT || path.join(REPO_ROOT, 'local_data', 'extended_validation');
const OUT_DIR = process.env.CT_RESULTS_DIR || path.join(REPO_ROOT, 'results');

function resolveWindowPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(R8_ROOT, filePath);
}

const LAYERS = [
  ['normalizedK', 'K'],
  ['fractals', 'F'],
  ['strokes', 'B'],
  ['segments', 'S'],
  ['pivots', 'Z'],
];

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function getDirection(obj) {
  const d = obj.direction ?? obj.metadata?.direction ?? obj.geometry?.direction;
  if (d === 1 || d === 'UP' || d === 'up' || d === '+1') return 1;
  if (d === -1 || d === 'DOWN' || d === 'down' || d === '-1') return -1;
  const sp = obj.startPrice ?? obj.geometry?.startPrice ?? obj.metadata?.startPrice;
  const ep = obj.endPrice ?? obj.geometry?.endPrice ?? obj.metadata?.endPrice;
  if (typeof sp === 'number' && typeof ep === 'number' && ep !== sp) {
    return ep > sp ? 1 : -1;
  }
  return 0;
}

function computeBarMicrostructure(bars, n) {
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

function snapshotMetrics(sealed, bars, n, stepMin, firstPivotBar) {
  const K = sealed.normalizedK.length;
  const F = sealed.fractals.length;
  const B = sealed.strokes.length;
  const S = sealed.segments.length;
  const Z = sealed.pivots.length;
  const bLags = sealed.strokes.map(o => (o.confirmTime - o.eventTime) / 60000);
  const sLags = sealed.segments.map(o => (o.confirmTime - o.eventTime) / 60000);
  const zLags = sealed.pivots.map(o => (o.confirmTime - o.eventTime) / 60000);
  const ms = computeBarMicrostructure(bars, n);
  return {
    N: n,
    K, F, B, S, Z,
    K_over_N: (100 * K) / n,
    F_over_K: K > 0 ? (100 * F) / K : null,
    B_over_K: K > 0 ? (100 * B) / K : null,
    B_over_F: F > 0 ? (100 * B) / F : null,
    S_norm_720: S / (n / 720),
    I_Z: Z >= 1 ? 1 : 0,
    firstPivotBar,
    firstPivotMin: firstPivotBar !== null ? firstPivotBar * stepMin : null,
    meanBLagMin: bLags.length ? bLags.reduce((a, b) => a + b, 0) / bLags.length : null,
    medianBLagMin: median(bLags),
    medianSLagMin: median(sLags),
    meanSLagMin: sLags.length ? sLags.reduce((a, b) => a + b, 0) / sLags.length : null,
    zLagMin: zLags.length ? zLags[0] : null,
    zeroRangePct: ms.zeroRangePct,
    equalBoundPct: ms.equalBoundPct,
  };
}

function runOneJob(job) {
  const core = createSandboxCore('audit_hooks_off');
  const ruleOverrides = job.mB === 2 ? {} : { minimumStrokeSeparation: job.mB };
  const cfg = loadFrozenRuleConfig(ruleOverrides);
  const raw = JSON.parse(fs.readFileSync(job.filePath, 'utf8'));
  let bars = raw.bars;
  if (job.sourceKind === 'tq_gbm') {
    bars = generateSurrogate('tq_gbm', raw.bars, job.windowId, 0, job.tickSize, null);
  }
  const n = bars.length;
  const stepMin = job.interval === '15m' ? 15 : 1;
  const checkpoints = new Set(job.checkpoints);

  const parser = new core.CTCoreParser(cfg);
  const firstSeen = new Map();
  let firstPivotBar = null;
  const fssSnapshots = {};
  const stepDurationsMs = job.recordTiming ? new Array(n) : null;
  const timingCheckpoints = {};

  const tStartAll = performance.now();
  let finalSealed = null;

  for (let k = 0; k < n; k += 1) {
    const b = bars[k];
    const t0 = job.recordTiming ? performance.now() : 0;
    parser.ingestClosedBar({
      index: k,
      startTime: b.startTime,
      endTime: b.endTime,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      closed: true,
    });
    if (job.recordTiming) {
      stepDurationsMs[k] = performance.now() - t0;
    }

    const sealed = parser.getConfirmedStructures();
    if (firstPivotBar === null && sealed.pivots.length > 0) {
      firstPivotBar = k;
    }

    if (job.recordFourClock) {
      for (const [prop, layerCode] of LAYERS) {
        const list = sealed[prop];
        for (let i = 0; i < list.length; i += 1) {
          const obj = list[i];
          const key = `${layerCode}|${obj.structureId}`;
          if (!firstSeen.has(key)) {
            firstSeen.set(key, {
              layer: layerCode,
              structureId: obj.structureId,
              k_event: obj.eventRawBarIndex,
              k_native: obj.confirmRawBarIndex,
              k_emit: k,
              t_event: obj.eventTime,
              t_native: obj.confirmTime,
              t_emit: b.endTime,
            });
          }
        }
      }
    }

    const barCount = k + 1;
    if (checkpoints.has(barCount)) {
      fssSnapshots[barCount] = snapshotMetrics(sealed, bars, barCount, stepMin, firstPivotBar);
      if (job.recordTiming) {
        const sub = stepDurationsMs.slice(0, barCount);
        const last250 = stepDurationsMs.slice(Math.max(0, barCount - 250), barCount);
        timingCheckpoints[barCount] = {
          N: barCount,
          elapsedSec: (performance.now() - tStartAll) / 1000,
          meanMs: sub.reduce((a, x) => a + x, 0) / sub.length,
          p50Ms: quantile(sub, 0.5),
          p95Ms: quantile(sub, 0.95),
          p99Ms: quantile(sub, 0.99),
          tail250P99Ms: quantile(last250, 0.99),
        };
      }
    }
    if (k === n - 1) finalSealed = sealed;
  }

  const elapsedSec = (performance.now() - tStartAll) / 1000;

  // Build compact event table for terminal sealed B, S, Z (and four-clock lag summary across all layers)
  let events = [];
  let fourClockLagSummary = null;
  let sigmaBarBps = null;

  if (job.recordFourClock) {
    // 1-bar close-to-close log return SD in bps
    const rets = [];
    for (let i = 1; i < n; i += 1) {
      rets.push(Math.log(bars[i].close / bars[i - 1].close) * 1e4);
    }
    const meanR = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varR = rets.reduce((s, r) => s + (r - meanR) ** 2, 0) / (rets.length - 1);
    sigmaBarBps = Math.sqrt(Math.max(varR, 1e-16));

    const horizons = job.interval === '15m' ? [1, 2, 4, 8, 16, 5, 15, 30, 60] : [5, 15, 30, 60];
    const uniqueHorizons = [...new Set(horizons)].sort((a, b) => a - b);

    // Four-clock lag medians across ALL first-seen structures per layer
    fourClockLagSummary = {};
    for (const [, layerCode] of LAYERS) {
      const nat = [], em = [], gap = [];
      for (const rec of firstSeen.values()) {
        if (rec.layer === layerCode) {
          nat.push((rec.t_native - rec.t_event) / 60000);
          em.push((rec.t_emit - rec.t_event) / 60000);
          gap.push((rec.t_emit - rec.t_native) / 60000);
        }
      }
      fourClockLagSummary[layerCode] = {
        firstExposureN: nat.length,
        nativeMedianMin: median(nat),
        emitMedianMin: median(em),
        gapMedianMin: median(gap),
        gapMaxMin: gap.length ? Math.max(...gap) : null,
      };
    }

    // Terminal sealed B, S, Z events with precomputed forward log-returns at t_event, t_native, t_emit
    for (const [prop, layerCode] of [['strokes', 'B'], ['segments', 'S'], ['pivots', 'Z']]) {
      for (const obj of finalSealed[prop]) {
        const key = `${layerCode}|${obj.structureId}`;
        const fsRec = firstSeen.get(key);
        if (!fsRec) continue;
        const dir = layerCode === 'Z' ? 0 : getDirection(obj);
        const kEv = fsRec.k_event;
        const kNa = fsRec.k_native;
        const kEm = fsRec.k_emit;

        const fwd = {};
        for (const h of uniqueHorizons) {
          if (kEm + h < n && kEv >= 0 && kNa >= 0) {
            const rEv = Math.log(bars[kEv + h].close / bars[kEv].close) * 1e4;
            const rNa = Math.log(bars[kNa + h].close / bars[kNa].close) * 1e4;
            const rEm = Math.log(bars[kEm + h].close / bars[kEm].close) * 1e4;
            // Realized volatility over (k0, k0+h] in bps
            const rv = (k0) => {
              let s2 = 0;
              for (let j = k0 + 1; j <= k0 + h; j += 1) {
                const r = Math.log(bars[j].close / bars[j - 1].close) * 1e4;
                s2 += r * r;
              }
              return Math.sqrt(s2);
            };
            fwd[h] = {
              ev: dir !== 0 ? -dir * rEv : Math.abs(rEv),
              na: dir !== 0 ? -dir * rNa : Math.abs(rNa),
              em: dir !== 0 ? -dir * rEm : Math.abs(rEm),
              rvEv: rv(kEv),
              rvNa: rv(kNa),
              rvEm: rv(kEm),
            };
          }
        }
        // Pre-emission banked return [k_event, k_emit], [k_event, k_native], [k_native, k_emit]
        const bankEvEm = (kEv >= 0 && kEm < n && dir !== 0) ? -dir * Math.log(bars[kEm].close / bars[kEv].close) * 1e4 : null;
        const bankEvNa = (kEv >= 0 && kNa < n && dir !== 0) ? -dir * Math.log(bars[kNa].close / bars[kEv].close) * 1e4 : null;
        const bankNaEm = (kNa >= 0 && kEm < n && dir !== 0) ? -dir * Math.log(bars[kEm].close / bars[kNa].close) * 1e4 : null;

        events.push({
          windowId: job.windowId,
          symbol: job.symbol,
          interval: job.interval,
          arm: job.arm,
          sourceKind: job.sourceKind,
          mB: job.mB,
          layer: layerCode,
          structureId: obj.structureId,
          dir,
          kEv, kNa, kEm,
          nativeLagMin: (fsRec.t_native - fsRec.t_event) / 60000,
          emitLagMin: (fsRec.t_emit - fsRec.t_event) / 60000,
          gapMin: (fsRec.t_emit - fsRec.t_native) / 60000,
          bankEvEm, bankEvNa, bankNaEm,
          sigmaBarBps,
          fwd,
        });
      }
    }
  }

  return {
    jobId: job.jobId,
    windowId: job.windowId,
    symbol: job.symbol,
    interval: job.interval,
    arm: job.arm,
    sourceKind: job.sourceKind,
    mB: job.mB,
    elapsedSec,
    sigmaBarBps,
    fssSnapshots,
    timingCheckpoints: job.recordTiming ? timingCheckpoints : null,
    fourClockLagSummary,
    events,
  };
}

if (!isMainThread) {
  const res = runOneJob(workerData);
  parentPort.postMessage(res);
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifestPath = fs.existsSync(path.join(R8_ROOT, 'manifests/extended_window_manifest.json'))
    ? path.join(R8_ROOT, 'manifests/extended_window_manifest.json')
    : path.join(REPO_ROOT, 'manifests/extended_window_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const jobs = [];
  // 1. Arm 1 real (24 windows) at mB=2 & mB=4
  for (const mB of [2, 4]) {
    for (const w of manifest.arm1_1m_48h) {
      jobs.push({
        jobId: `${w.windowId}|real|mB${mB}`,
        windowId: w.windowId,
        symbol: w.symbol,
        interval: '1m',
        arm: mB === 2 ? 'arm1_1m_48h' : 'arm3_mB4_1m_48h',
        sourceKind: 'real',
        mB,
        tickSize: w.tickSize,
        filePath: resolveWindowPath(w.filePath),
        checkpoints: [720, 1440, 2880],
        recordFourClock: true,
        recordTiming: mB === 2,
      });
    }
  }
  // 2. Arm 2 real (4 windows, 15m 30d) at mB=2 & mB=4
  for (const mB of [2, 4]) {
    for (const w of manifest.arm2_15m_30d) {
      jobs.push({
        jobId: `${w.windowId}|real|mB${mB}`,
        windowId: w.windowId,
        symbol: w.symbol,
        interval: '15m',
        arm: mB === 2 ? 'arm2_15m_30d' : 'arm2_mB4_15m_30d',
        sourceKind: 'real',
        mB,
        tickSize: w.tickSize,
        filePath: resolveWindowPath(w.filePath),
        checkpoints: [720, 1440, 2880],
        recordFourClock: true,
        recordTiming: false,
      });
    }
  }
  // 3. Matched TQ-GBM (24 paths, 1 per Arm-1 window) at mB=2 & mB=4 for mechanical look-ahead baseline
  for (const mB of [2, 4]) {
    for (const w of manifest.arm1_1m_48h) {
      jobs.push({
        jobId: `${w.windowId}|tq_gbm|mB${mB}`,
        windowId: w.windowId,
        symbol: w.symbol,
        interval: '1m',
        arm: mB === 2 ? 'arm1_tq_gbm_lookahead' : 'arm3_tq_gbm_mB4_lookahead',
        sourceKind: 'tq_gbm',
        mB,
        tickSize: w.tickSize,
        filePath: resolveWindowPath(w.filePath),
        checkpoints: [720, 1440, 2880],
        recordFourClock: true,
        recordTiming: false,
      });
    }
  }
  // 4. Contiguous 10,000-bar BTCUSDT real scaling benchmark (hooks-off, zero artificial seams)
  const sc = manifest.scaling_contiguous[0];
  jobs.push({
    jobId: `${sc.windowId}|real|mB2`,
    windowId: sc.windowId,
    symbol: sc.symbol,
    interval: '1m',
    arm: 'scaling_contiguous',
    sourceKind: 'real',
    mB: 2,
    tickSize: sc.tickSize,
    filePath: resolveWindowPath(sc.filePath),
    checkpoints: [120, 500, 1000, 2000, 2880, 5000, 10000],
    recordFourClock: false,
    recordTiming: true,
  });

  // Put the heavy 10,000-bar job FIRST so it runs in parallel with all shorter jobs!
  jobs.sort((a, b) => (b.arm === 'scaling_contiguous' ? 1 : 0) - (a.arm === 'scaling_contiguous' ? 1 : 0));

  const maxWorkers = Math.min(8, os.cpus().length);
  console.log(`Launching ${jobs.length} R8 Step-4 jobs across ${maxWorkers} worker threads...`);
  const tAll = performance.now();

  const results = [];
  let nextIdx = 0;
  let doneCount = 0;

  await new Promise((resolve, reject) => {
    let active = 0;
    function dispatch() {
      while (active < maxWorkers && nextIdx < jobs.length) {
        const job = jobs[nextIdx++];
        active += 1;
        const w = new Worker(fileURLToPath(import.meta.url), { workerData: job });
        w.on('message', (msg) => {
          results.push(msg);
          doneCount += 1;
          const snapEnd = msg.fssSnapshots[2880] || msg.fssSnapshots[10000];
          console.log(
            `[${String(doneCount).padStart(3)}/${jobs.length}] ${msg.jobId} ` +
            `(${msg.elapsedSec.toFixed(1)}s) K/N=${snapEnd.K_over_N.toFixed(1)}% ` +
            `B/K=${snapEnd.B_over_K.toFixed(1)}% S=${snapEnd.S} Z=${snapEnd.Z} ` +
            `ev=${msg.events.length}`
          );
        });
        w.on('error', reject);
        w.on('exit', (code) => {
          active -= 1;
          if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
          else if (doneCount === jobs.length) resolve();
          else dispatch();
        });
      }
    }
    dispatch();
  });

  const totalSec = (performance.now() - tAll) / 1000;
  console.log(`\nStep-4 finished ${results.length} jobs in ${totalSec.toFixed(1)}s!`);

  // Separate summaries & event tables for clean downstream Python stats
  const summaries = results.map(({ events, ...rest }) => ({ ...rest, eventCount: events.length }));
  const allEvents = results.flatMap(r => r.events);

  fs.writeFileSync(path.join(OUT_DIR, 'extended_real_summaries.json'), JSON.stringify({ generatedAtUtc: new Date().toISOString(), totalSec, summaries }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'extended_real_events.json'), JSON.stringify({ generatedAtUtc: new Date().toISOString(), totalEvents: allEvents.length, events: allEvents }));
  console.log(`Saved extended_real_summaries.json and extended_real_events.json (${allEvents.length} events).`);
}
