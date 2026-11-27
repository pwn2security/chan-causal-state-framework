(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const {
    createSeriesDescriptor, createSeriesKey, createBarRecord,
    validateBarRecord, assertPayloadSchema, createSymbolMeta,
  } = core;

  const BAR = Object.freeze({
    index: 0, startTime: 1, endTime: 2, open: 3, high: 4, low: 5, close: 6,
    tickCount: 7, volume: 8, synthetic: 9, closed: 10, durationMs: 11,
    sourceStartIndex: 12, sourceEndIndex: 13,
  });
  const TICK = Object.freeze({ time: 0, price: 1, volume: 2, tradeId: 3 });

  function rowToBar(row, seriesKey) {
    return createBarRecord({
      barIndex: row[BAR.index],
      startTimestamp: row[BAR.startTime],
      endTimestamp: row[BAR.endTime],
      open: row[BAR.open], high: row[BAR.high], low: row[BAR.low], close: row[BAR.close],
      tickCount: row[BAR.tickCount], volume: row[BAR.volume], synthetic: !!row[BAR.synthetic],
      closed: !!row[BAR.closed], durationMs: row[BAR.durationMs],
      sourceStartIndex: row[BAR.sourceStartIndex], sourceEndIndex: row[BAR.sourceEndIndex],
    }, seriesKey);
  }

  function rawDescriptorFor(mode, size, emptyMode = 'skip', includePartialBar = true) {
    return createSeriesDescriptor({
      symbol: 'BTCUSDT', priceSource: 'last', barSource: 'raw', barMode: mode,
      timeIntervalMs: mode === 'time' ? size : 1000,
      tickBarSize: mode === 'tick' ? size : 50,
      emptyBarMode, includePartialBar,
    }, 'raw');
  }

  function buildTimeBars(ticks, intervalMs, emptyMode = 'skip', descriptor = null) {
    if (!(intervalMs > 0)) throw new Error('intervalMs must be positive');
    if (!ticks.length) return [];
    const series = descriptor || rawDescriptorFor('time', intervalMs, emptyMode);
    const seriesKey = createSeriesKey(series);
    const bars = [];
    let currentBucket = null;
    let startOffset = 0;

    const flush = (endOffset, bucket) => {
      let high = -Infinity, low = Infinity, volume = 0;
      for (let i = startOffset; i < endOffset; i++) {
        const row = ticks[i];
        high = Math.max(high, row[TICK.price]);
        low = Math.min(low, row[TICK.price]);
        volume += row[TICK.volume] || 0;
      }
      const startTimestamp = bucket * intervalMs;
      bars.push(createBarRecord({
        barIndex: bars.length, startTimestamp, endTimestamp: startTimestamp + intervalMs - 1,
        open: ticks[startOffset][TICK.price], high, low, close: ticks[endOffset - 1][TICK.price],
        tickCount: endOffset - startOffset, volume, synthetic: false, closed: true,
        durationMs: intervalMs, sourceStartIndex: startOffset, sourceEndIndex: endOffset - 1,
      }, seriesKey));
    };

    for (let i = 0; i < ticks.length; i++) {
      const bucket = Math.floor(ticks[i][TICK.time] / intervalMs);
      if (currentBucket === null) currentBucket = bucket;
      if (bucket !== currentBucket) {
        flush(i, currentBucket);
        if (emptyMode === 'synthetic') {
          const previousClose = bars[bars.length - 1].close;
          for (let missing = currentBucket + 1; missing < bucket; missing++) {
            const startTimestamp = missing * intervalMs;
            bars.push(createBarRecord({
              barIndex: bars.length, startTimestamp, endTimestamp: startTimestamp + intervalMs - 1,
              open: previousClose, high: previousClose, low: previousClose, close: previousClose,
              tickCount: 0, volume: 0, synthetic: true, closed: true, durationMs: intervalMs,
              sourceStartIndex: -1, sourceEndIndex: -1,
            }, seriesKey));
          }
        }
        currentBucket = bucket;
        startOffset = i;
      }
    }
    flush(ticks.length, currentBucket);
    return bars;
  }

  function buildTickBars(ticks, tickBarSize, includePartial = true, descriptor = null) {
    if (!(tickBarSize > 0)) throw new Error('tickBarSize must be positive');
    const series = descriptor || rawDescriptorFor('tick', tickBarSize, 'skip', includePartial);
    const seriesKey = createSeriesKey(series);
    const bars = [];
    for (let offset = 0; offset < ticks.length; offset += tickBarSize) {
      const end = Math.min(ticks.length, offset + tickBarSize);
      if (end - offset < tickBarSize && !includePartial) break;
      let high = -Infinity, low = Infinity, volume = 0;
      for (let i = offset; i < end; i++) {
        high = Math.max(high, ticks[i][TICK.price]);
        low = Math.min(low, ticks[i][TICK.price]);
        volume += ticks[i][TICK.volume] || 0;
      }
      const startTimestamp = ticks[offset][TICK.time];
      const endTimestamp = ticks[end - 1][TICK.time];
      bars.push(createBarRecord({
        barIndex: bars.length, startTimestamp, endTimestamp,
        open: ticks[offset][TICK.price], high, low, close: ticks[end - 1][TICK.price],
        tickCount: end - offset, volume, synthetic: false, closed: end - offset === tickBarSize,
        durationMs: Math.max(0, endTimestamp - startTimestamp),
        sourceStartIndex: offset, sourceEndIndex: end - 1,
      }, seriesKey));
    }
    return bars;
  }

  function mergeChanBars(rawBars, descriptor = null) {
    const base = descriptor || createSeriesDescriptor({
      symbol: 'BTCUSDT', priceSource: 'last', barSource: 'chan', barMode: 'time',
      timeIntervalMs: 1000, emptyBarMode: 'skip', includePartialBar: true,
    }, 'chan');
    const seriesKey = createSeriesKey({ ...base, barSource: 'chan' });
    const included = (a, b) =>
      (b.high <= a.high && b.low >= a.low) || (b.high >= a.high && b.low <= a.low);
    const merged = [];

    for (const source of rawBars) {
      let cur = { ...source, sourceStartIndex: source.barIndex, sourceEndIndex: source.barIndex };
      while (true) {
        if (!merged.length) { merged.push(cur); break; }
        const last = merged[merged.length - 1];
        if (!included(last, cur)) { merged.push(cur); break; }
        const up = merged.length >= 2 ? last.high > merged[merged.length - 2].high : true;
        cur = {
          barIndex: last.barIndex,
          startTimestamp: last.startTimestamp,
          endTimestamp: cur.endTimestamp,
          open: last.open,
          high: up ? Math.max(last.high, cur.high) : Math.min(last.high, cur.high),
          low: up ? Math.max(last.low, cur.low) : Math.min(last.low, cur.low),
          close: cur.close,
          tickCount: last.tickCount + cur.tickCount,
          volume: last.volume + cur.volume,
          synthetic: last.synthetic && cur.synthetic,
          closed: last.closed && cur.closed,
          durationMs: cur.endTimestamp - last.startTimestamp + 1,
          sourceStartIndex: last.sourceStartIndex,
          sourceEndIndex: cur.sourceEndIndex,
        };
        merged.pop();
      }
    }
    return merged.map((bar, barIndex) => createBarRecord({ ...bar, barIndex }, seriesKey));
  }

  /**
   * Incrementally extend a Chan prefix.  `merged` is the state that was known
   * after the previous raw bar; no precomputed final-series record is read.
   */
  function appendChanBar(merged, source, descriptor) {
    const seriesKey = createSeriesKey({ ...descriptor, barSource: 'chan' });
    const included = (a, b) =>
      (b.high <= a.high && b.low >= a.low) || (b.high >= a.high && b.low <= a.low);
    let cur = { ...source, sourceStartIndex: source.barIndex, sourceEndIndex: source.barIndex };
    while (true) {
      if (!merged.length) { merged.push(createBarRecord({ ...cur, barIndex: 0 }, seriesKey)); break; }
      const last = merged[merged.length - 1];
      if (!included(last, cur)) {
        merged.push(createBarRecord({ ...cur, barIndex: merged.length }, seriesKey));
        break;
      }
      const up = merged.length >= 2 ? last.high > merged[merged.length - 2].high : true;
      cur = {
        barIndex: last.barIndex,
        startTimestamp: last.startTimestamp,
        endTimestamp: cur.endTimestamp,
        open: last.open,
        high: up ? Math.max(last.high, cur.high) : Math.min(last.high, cur.high),
        low: up ? Math.max(last.low, cur.low) : Math.min(last.low, cur.low),
        close: cur.close,
        tickCount: last.tickCount + cur.tickCount,
        volume: last.volume + cur.volume,
        synthetic: last.synthetic && cur.synthetic,
        closed: last.closed && cur.closed,
        durationMs: cur.endTimestamp - last.startTimestamp + 1,
        sourceStartIndex: last.sourceStartIndex,
        sourceEndIndex: cur.sourceEndIndex,
      };
      merged.pop();
    }
    return merged;
  }

  class MarketDataStore {
    constructor(payload) {
      assertPayloadSchema(payload);
      this.payload = payload;
      this.ticks = payload.ticks || [];
      this.symbolMeta = createSymbolMeta(payload.meta || {});
      this.cache = new Map();
      this.causalChanCache = new Map();
    }

    getSeriesDescriptor(config, source) { return createSeriesDescriptor(config, source); }
    key(config, source) { return createSeriesKey(this.getSeriesDescriptor(config, source)); }

    cacheSeries(key, bars, barSource) {
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].barIndex !== i) throw new Error(`[${key}] non-continuous barIndex at ${i}`);
      }
      for (const index of [0, Math.floor(bars.length / 2), bars.length - 1]) {
        if (index >= 0 && bars[index]) validateBarRecord(bars[index], { seriesKey: key, barSource });
      }
      this.cache.set(key, bars);
      return bars;
    }

    getBars(config, source) {
      const market = core.normalizeMarketConfig(config);
      const barSource = source || market.barSource || 'raw';
      const descriptor = this.getSeriesDescriptor(market, barSource);
      const key = createSeriesKey(descriptor);
      if (this.cache.has(key)) return this.cache.get(key);

      const bucketKey = String(market.barMode === 'time' ? market.timeIntervalMs : market.tickBarSize);
      const precomputed = market.emptyBarMode === 'skip'
        ? this.payload.bar_cache?.[market.barMode]?.[bucketKey]
        : null;
      const rawDescriptor = this.getSeriesDescriptor(market, 'raw');
      const rawKey = createSeriesKey(rawDescriptor);
      let rawBars = this.cache.get(rawKey);
      if (!rawBars) {
        if (precomputed?.raw) rawBars = precomputed.raw.map(row => rowToBar(row, rawKey));
        else if (market.barMode === 'time') rawBars = buildTimeBars(this.ticks, market.timeIntervalMs, market.emptyBarMode, rawDescriptor);
        else rawBars = buildTickBars(this.ticks, market.tickBarSize, market.includePartialBar, rawDescriptor);
        this.cacheSeries(rawKey, rawBars, 'raw');
      }

      if (barSource === 'raw') return rawBars;
      const chanBars = precomputed?.chan
        ? precomputed.chan.map(row => rowToBar(row, key))
        : mergeChanBars(rawBars, descriptor);
      return this.cacheSeries(key, chanBars, 'chan');
    }

    getBarsAsOf(config, source, rawCursorIndex) {
      const market = core.normalizeMarketConfig(config);
      const rawBars = this.getBars(market, 'raw');
      if (!rawBars.length) return [];
      const rawCount = Math.max(0, Math.min(rawBars.length, Math.trunc(rawCursorIndex) + 1));
      if ((source || market.barSource) === 'raw') return rawBars.slice(0, rawCount);

      const descriptor = this.getSeriesDescriptor(market, 'chan');
      const rawKey = createSeriesKey(this.getSeriesDescriptor(market, 'raw'));
      let state = this.causalChanCache.get(rawKey);
      if (!state || rawCount < state.rawCount) state = { rawCount: 0, bars: [] };
      for (let index = state.rawCount; index < rawCount; index++) {
        appendChanBar(state.bars, rawBars[index], descriptor);
      }
      state.rawCount = rawCount;
      this.causalChanCache.set(rawKey, state);
      // Return a snapshot: later appends must not rewrite a frame already handed
      // to an adapter or an algorithm consumer.
      return state.bars.slice();
    }
  }

  Object.assign(core, {
    BAR, TICK, MarketDataStore, rowToBar,
    buildTimeBars, buildTickBars, mergeChanBars, appendChanBar,
  });
})();
