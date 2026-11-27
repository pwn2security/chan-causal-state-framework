(function () {
  'use strict';

  const core = window.MarketCore = window.MarketCore || {};
  const BAR_SCHEMA_VERSION = 2;
  const CONFIG_VERSION = 2;

  function toInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
  }

  function createSymbolMeta(meta = {}) {
    const source = meta.symbol_meta || meta.symbolMeta || {};
    const precision = Math.max(0, toInteger(source.price_precision ?? source.pricePrecision, 2));
    return Object.freeze({
      symbol: String(source.symbol || meta.symbol || 'BTCUSDT'),
      // Legacy player rendered BTCUSDT with two decimals. This fallback preserves that
      // behavior; generated payloads now carry the value explicitly.
      tickSize: Number(source.tick_size ?? source.tickSize ?? 0.01),
      pricePrecision: precision,
      quantityPrecision: source.quantity_precision ?? source.quantityPrecision ?? null,
      timezone: String(source.timezone || 'UTC'),
    });
  }

  function formatPrice(price, symbolMeta) {
    const value = Number(price);
    if (!Number.isFinite(value)) return '-';
    return value.toFixed(symbolMeta?.pricePrecision ?? 2);
  }

  function normalizeMarketConfig(config = {}) {
    return config.market || config;
  }

  function createSeriesDescriptor(config = {}, source) {
    const market = normalizeMarketConfig(config);
    const barSource = source || market.barSource || market.source || 'raw';
    const barMode = market.barMode || 'time';
    return Object.freeze({
      symbol: String(market.symbol || 'BTCUSDT'),
      priceSource: String(market.priceSource || 'last'),
      barSource,
      barMode,
      timeIntervalMs: barMode === 'time' ? Math.max(1, toInteger(market.timeIntervalMs, 1000)) : null,
      tickBarSize: barMode === 'tick' ? Math.max(1, toInteger(market.tickBarSize, 50)) : null,
      emptyBarMode: String(market.emptyBarMode || 'skip'),
      includePartialBar: market.includePartialBar !== false && market.includePartialTickBar !== false,
    });
  }

  function createSeriesKey(descriptor) {
    const size = descriptor.barMode === 'time'
      ? `${descriptor.timeIntervalMs}ms`
      : `${descriptor.tickBarSize}tick`;
    return [
      descriptor.symbol,
      descriptor.priceSource,
      descriptor.barSource,
      descriptor.barMode,
      size,
      descriptor.emptyBarMode,
      descriptor.includePartialBar ? 'partial' : 'closed-only',
    ].join('|');
  }

  function createBarId(seriesKey, barIndex) {
    return `${seriesKey}:${barIndex}`;
  }

  function createBarRecord(values, seriesKey = 'unknown-series') {
    const barIndex = toInteger(values.barIndex ?? values.index, -1);
    const record = {
      id: String(values.id || createBarId(seriesKey, barIndex)),
      barIndex,
      startTimestamp: Number(values.startTimestamp ?? values.startTime),
      endTimestamp: Number(values.endTimestamp ?? values.endTime),
      open: Number(values.open),
      high: Number(values.high),
      low: Number(values.low),
      close: Number(values.close),
      tickCount: toInteger(values.tickCount, 0),
      volume: Number(values.volume || 0),
      synthetic: !!values.synthetic,
      closed: values.closed !== false,
      durationMs: Math.max(0, toInteger(values.durationMs, 0)),
      sourceStartIndex: toInteger(values.sourceStartIndex, -1),
      sourceEndIndex: toInteger(values.sourceEndIndex, -1),
    };

    // Phase-1 compatibility only: getters alias the canonical fields and never
    // create a second source of truth. New business code must use canonical names.
    Object.defineProperties(record, {
      index: { enumerable: false, get: () => record.barIndex },
      startTime: { enumerable: false, get: () => record.startTimestamp },
      endTime: { enumerable: false, get: () => record.endTimestamp },
    });
    return record;
  }

  function validateBarRecord(bar, context = {}) {
    const prefix = `[${context.seriesKey || 'unknown-series'} barIndex=${bar?.barIndex}]`;
    const fail = message => { throw new Error(`${prefix} invalid BarRecord: ${message}`); };
    if (!Number.isInteger(bar?.barIndex) || bar.barIndex < 0) fail('barIndex must be a non-negative integer');
    if (!Number.isFinite(bar.startTimestamp) || !Number.isFinite(bar.endTimestamp)) fail('timestamps must be finite');
    if (bar.startTimestamp > bar.endTimestamp) fail('startTimestamp must be <= endTimestamp');
    for (const field of ['open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(bar[field])) fail(`${field} must be finite`);
    }
    if (bar.high < bar.low) fail('high must be >= low');
    // The existing Chan inclusion algorithm preserves the first open and last
    // close while transforming only high/low. Its legacy output can therefore
    // place open/close outside the transformed envelope. Phase 1 preserves that
    // math; Raw bars retain the stricter canonical OHLC validation.
    if (context.barSource !== 'chan') {
      if (bar.high < bar.open || bar.high < bar.close) fail('high must cover open and close');
      if (bar.low > bar.open || bar.low > bar.close) fail('low must cover open and close');
    }
    if (!Number.isInteger(bar.tickCount) || bar.tickCount < 0) fail('tickCount must be a non-negative integer');
    return true;
  }

  function assertApiBarsValid(bars, context = 'api bars') {
    if (!Array.isArray(bars)) throw new Error(`MARKET DATA INVALID: ${context} is not an array`);
    let previous = null;
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index];
      const time = Number(bar?.time);
      const open = Number(bar?.open);
      const high = Number(bar?.high);
      const low = Number(bar?.low);
      const close = Number(bar?.close);
      const volume = Number(bar?.volume || 0);
      if (!Number.isFinite(time)) {
        throw new Error(`MARKET DATA INVALID: ${context}[${index}] time is not finite ${JSON.stringify(bar)}`);
      }
      if (previous !== null && time <= previous) {
        throw new Error(
          `MARKET DATA INVALID: ${context} time not strictly increasing at ${index}\n` +
          `previous=${JSON.stringify(bars[index - 1])}\ncurrent=${JSON.stringify(bar)}`
        );
      }
      for (const [name, value] of [['open', open], ['high', high], ['low', low], ['close', close], ['volume', volume]]) {
        if (!Number.isFinite(value)) {
          throw new Error(`MARKET DATA INVALID: ${context}[${index}] ${name} is not finite ${JSON.stringify(bar)}`);
        }
      }
      if (high < open || high < close || low > open || low > close || high < low) {
        throw new Error(`MARKET DATA INVALID: ${context}[${index}] OHLC invariant failed ${JSON.stringify(bar)}`);
      }
      previous = time;
    }
    return bars;
  }

  function assertChartBarsValid(bars, context = 'chart bars', options = {}) {
    if (!Array.isArray(bars)) throw new Error(`MARKET DATA INVALID: ${context} is not an array`);
    const skipEnvelope = options.barSource === 'chan';
    let previousTime = null;
    let previousStart = null;
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index];
      const time = Number(bar?.time);
      const start = Number(bar?.customValues?.startTimestamp ?? bar?.startTimestamp);
      const open = Number(bar?.open);
      const high = Number(bar?.high);
      const low = Number(bar?.low);
      const close = Number(bar?.close);
      if (!Number.isFinite(time)) {
        throw new Error(`MARKET DATA INVALID: ${context}[${index}] time is not finite`);
      }
      if (previousTime !== null && time <= previousTime) {
        throw new Error(
          `MARKET DATA INVALID: ${context} time not strictly increasing at ${index} ` +
          `prev=${JSON.stringify(bars[index - 1])} current=${JSON.stringify(bar)}`
        );
      }
      if (Number.isFinite(start)) {
        // Tick bars may share a millisecond; time bars must never go backwards.
        // LWC `time` (barIndex) remains strictly increasing above.
        if (previousStart !== null && start < previousStart) {
          throw new Error(
            `MARKET DATA INVALID: ${context} startTimestamp went backwards at ${index} ` +
            `prev=${JSON.stringify(bars[index - 1])} current=${JSON.stringify(bar)}`
          );
        }
        previousStart = start;
      }
      for (const [name, value] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
        if (!Number.isFinite(value)) {
          throw new Error(`MARKET DATA INVALID: ${context}[${index}] ${name} is not finite`);
        }
      }
      if (high < low) {
        throw new Error(`MARKET DATA INVALID: ${context}[${index}] high < low ${JSON.stringify(bar)}`);
      }
      if (!skipEnvelope && (high < open || high < close || low > open || low > close)) {
        throw new Error(`MARKET DATA INVALID: ${context}[${index}] OHLC invariant failed ${JSON.stringify(bar)}`);
      }
      previousTime = time;
    }
    return bars;
  }

  function mergeOlderAndCurrentBars(olderBars, currentBars, context = 'lazy-load merge') {
    const older = Array.isArray(olderBars) ? olderBars : [];
    const current = Array.isArray(currentBars) ? currentBars : [];
    assertApiBarsValid(older, `${context} older`);
    assertApiBarsValid(current, `${context} current`);
    if (older.length && current.length) {
      const olderMax = Number(older[older.length - 1].time);
      const currentMin = Number(current[0].time);
      if (!(olderMax < currentMin)) {
        throw new Error(
          `MARKET DATA INVALID: ${context} older is not older ` +
          `max(older)=${olderMax} min(current)=${currentMin}`
        );
      }
    }
    const seen = new Set(older.map(bar => Number(bar.time)));
    const merged = older.slice();
    for (const bar of current) {
      const time = Number(bar.time);
      if (seen.has(time)) {
        throw new Error(`MARKET DATA INVALID: ${context} duplicate timestamp ${time}`);
      }
      seen.add(time);
      merged.push(bar);
    }
    assertApiBarsValid(merged, `${context} merged`);
    return merged;
  }

  function replaySliceBarsByTime(bars, replayTime) {
    assertApiBarsValid(bars, 'replay slice source');
    if (!Number.isFinite(replayTime)) return [];
    return bars.filter(bar => Number(bar.time) <= replayTime);
  }

  function assertPayloadSchema(payload) {
    const version = Number(payload?.meta?.schemaVersion ?? payload?.meta?.schema_version ?? payload?.version);
    if (version !== BAR_SCHEMA_VERSION) {
      throw new Error(`Unsupported market payload schema ${version}; expected ${BAR_SCHEMA_VERSION}`);
    }
    return version;
  }

  Object.assign(core, {
    BAR_SCHEMA_VERSION,
    CONFIG_VERSION,
    createSymbolMeta,
    formatPrice,
    normalizeMarketConfig,
    createSeriesDescriptor,
    createSeriesKey,
    createBarId,
    createBarRecord,
    validateBarRecord,
    assertApiBarsValid,
    assertChartBarsValid,
    mergeOlderAndCurrentBars,
    replaySliceBarsByTime,
    assertPayloadSchema,
  });
})();
