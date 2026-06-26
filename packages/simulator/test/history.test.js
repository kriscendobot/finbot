import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parsePriceSeriesCsv,
  seriesFromFrames,
  validateSeries,
  loadPriceSeries,
  loadPriceFrames,
  parseCsvFrames,
} from '../history.js';
import { instrumentReturns, dividendInstrument } from '../instruments.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('parsePriceSeriesCsv: one price per line, no header', () => {
  const { series, meta } = parsePriceSeriesCsv('100\n101.5\n99.25\n102');
  assert.deepEqual(series, [100, 101.5, 99.25, 102]);
  assert.equal(meta.hadHeader, false);
  assert.equal(meta.rows, 4);
});

test('parsePriceSeriesCsv: t,price table uses the price column', () => {
  const { series, meta } = parsePriceSeriesCsv('t,price\n0,100\n1,101\n2,103');
  assert.deepEqual(series, [100, 101, 103]);
  assert.equal(meta.hadHeader, true);
  assert.equal(meta.column, 'price');
});

test('parsePriceSeriesCsv: wide table selects a named column', () => {
  const csv = 't,BTC,ETH\n0,60000,3000\n1,61000,3100\n2,59000,2900';
  const { series } = parsePriceSeriesCsv(csv, { column: 'ETH' });
  assert.deepEqual(series, [3000, 3100, 2900]);
});

test('parsePriceSeriesCsv: ignores blank lines and comments', () => {
  const { series } = parsePriceSeriesCsv('# my prices\n100\n\n101\n# tail\n102\n');
  assert.deepEqual(series, [100, 101, 102]);
});

test('parsePriceSeriesCsv: unknown column is an error', () => {
  assert.throws(
    () => parsePriceSeriesCsv('t,BTC\n0,100', { column: 'DOGE' }),
    /column "DOGE" not in header/,
  );
});

test('parsePriceSeriesCsv: non-finite cell is an error', () => {
  assert.throws(() => parsePriceSeriesCsv('100\nNaN\n102'), /non-finite value/);
});

test('validateSeries: rejects too-short and non-positive series', () => {
  assert.throws(() => validateSeries([100]), /at least two/);
  assert.throws(() => validateSeries([100, 0, 101]), /non-positive/);
  assert.throws(() => validateSeries([100, -5]), /non-positive/);
  assert.ok(validateSeries([100, 0, 101], { allowZero: true }));
});

test('seriesFromFrames: extracts an asset column from frames', () => {
  const frames = parseCsvFrames('t,A,B\n0,1,2\n1,1.1,2.2\n2,1.2,2.4');
  assert.deepEqual(seriesFromFrames(frames, 'A'), [1, 1.1, 1.2]);
  assert.deepEqual(seriesFromFrames(frames, 'B'), [2, 2.2, 2.4]);
  assert.throws(() => seriesFromFrames(frames, 'C'), /asset "C" missing/);
});

test('loadPriceSeries / loadPriceFrames: round-trip through a temp file', () => {
  const seriesPath = join(tmpdir(), `finbot-hist-series-${process.pid}.csv`);
  const framesPath = join(tmpdir(), `finbot-hist-frames-${process.pid}.csv`);
  try {
    writeFileSync(seriesPath, 'date,close\n2024-01-01,100\n2024-01-02,102\n2024-01-03,101\n');
    writeFileSync(framesPath, 't,USDC,ETH\n0,1,3000\n1,1,3050\n');
    const { series } = loadPriceSeries(seriesPath);
    assert.deepEqual(series, [100, 102, 101]);
    const frames = loadPriceFrames(framesPath);
    assert.deepEqual(frames, [{ USDC: 1, ETH: 3000 }, { USDC: 1, ETH: 3050 }]);
  } finally {
    rmSync(seriesPath, { force: true });
    rmSync(framesPath, { force: true });
  }
});

test('ingested historical series drives an instrument end to end', () => {
  // A real-shaped monthly close series feeding a dividend instrument.
  const csv = 't,close\n' + Array.from({ length: 13 }, (_, i) => `${i},${100 + i}`).join('\n');
  const { series } = parsePriceSeriesCsv(csv);
  const out = instrumentReturns(dividendInstrument({ series, dividendPerUnit: 1, period: 4 }));
  assert.equal(series.length, 13);
  // 3 payouts (t=4,8,12) of 1 each into cash, plus price appreciation 100->112.
  assert.ok(close(out.cumulativeCash, 3, 1e-9));
  assert.ok(out.totalReturn > (112 / 100 - 1)); // appreciation plus dividends
});
