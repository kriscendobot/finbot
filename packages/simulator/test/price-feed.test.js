import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GBMPriceFeed,
  ReplayPriceFeed,
  parseCsvFrames,
  sfc32,
  splitmix32,
  gaussian,
} from '../price-feed.js';
import { garchFromPriceHistory } from '../garch.js';

test('sfc32: deterministic for same seed', () => {
  const a = sfc32(42);
  const b = sfc32(42);
  for (let i = 0; i < 10; i += 1) assert.equal(a(), b());
});

test('sfc32: emits floats in [0, 1)', () => {
  const r = sfc32(1);
  for (let i = 0; i < 1000; i += 1) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('splitmix32: distinct seeds yield distinct first draws (overwhelmingly)', () => {
  const seen = new Set();
  for (let s = 1; s < 100; s += 1) seen.add(splitmix32(s)());
  assert.ok(seen.size > 90);
});

test('gaussian: mean ~0, stddev ~1 over many samples', () => {
  const r = sfc32(7);
  let s = 0;
  let s2 = 0;
  const N = 10000;
  for (let i = 0; i < N; i += 1) {
    const x = gaussian(r);
    s += x;
    s2 += x * x;
  }
  const mean = s / N;
  const variance = s2 / N - mean * mean;
  assert.ok(Math.abs(mean) < 0.05, `mean too far from 0: ${mean}`);
  assert.ok(Math.abs(variance - 1) < 0.1, `variance too far from 1: ${variance}`);
});

test('GBMPriceFeed: same seed yields same trajectory', () => {
  const a = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 99 });
  const b = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 99 });
  for (let i = 0; i < 50; i += 1) assert.equal(a.tick().ATOM, b.tick().ATOM);
});

test('GBMPriceFeed: different seeds yield different trajectories', () => {
  const a = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 1 });
  const b = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 2 });
  let differed = false;
  for (let i = 0; i < 5; i += 1) {
    if (Math.abs(a.tick().ATOM - b.tick().ATOM) > 1e-9) differed = true;
  }
  assert.ok(differed);
});

test('GBMPriceFeed: tick advances t', () => {
  const f = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, seed: 1 });
  assert.equal(f.t, 0);
  f.tick();
  assert.equal(f.t, 1);
  f.tick();
  assert.equal(f.t, 2);
});

test('GBMPriceFeed: clone preserves current price and continues sequence', () => {
  const a = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.03 }, seed: 5 });
  for (let i = 0; i < 7; i += 1) a.tick();
  const b = a.clone();
  assert.equal(b.t, a.t);
  assert.deepEqual(b.current(), a.current());
  // Subsequent ticks should match (continuing the same RNG sequence)
  const a8 = a.tick();
  const b8 = b.tick();
  assert.equal(a8.ATOM, b8.ATOM);
});

test('GBMPriceFeed: clone with new seed diverges', () => {
  const a = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.03 }, seed: 5 });
  for (let i = 0; i < 3; i += 1) a.tick();
  const b = a.clone({ seed: 999 });
  // first tick after divergence should disagree
  const aNext = a.tick();
  const bNext = b.tick();
  assert.notEqual(aNext.ATOM, bNext.ATOM);
});

test('ReplayPriceFeed: walks frames in order', () => {
  const f = new ReplayPriceFeed({
    frames: [{ ATOM: 10 }, { ATOM: 11 }, { ATOM: 12 }],
  });
  assert.equal(f.current().ATOM, 10);
  assert.equal(f.tick().ATOM, 11);
  assert.equal(f.tick().ATOM, 12);
});

test('ReplayPriceFeed: wraps by default', () => {
  const f = new ReplayPriceFeed({ frames: [{ ATOM: 10 }, { ATOM: 11 }] });
  // start t=0, prices=frames[0]=10
  assert.equal(f.tick().ATOM, 11); // t=1
  assert.equal(f.tick().ATOM, 10); // t=2 wraps to frames[0]
  assert.equal(f.tick().ATOM, 11); // t=3 wraps to frames[1]
});

test('ReplayPriceFeed: wrap=false holds last frame', () => {
  const f = new ReplayPriceFeed({ frames: [{ ATOM: 10 }, { ATOM: 11 }], wrap: false });
  f.tick();
  f.tick();
  assert.equal(f.tick().ATOM, 11);
});

test('ReplayPriceFeed: throws on empty frames', () => {
  assert.throws(() => new ReplayPriceFeed({ frames: [] }));
});

test('parseCsvFrames: parses header + rows', () => {
  const csv = 't,ATOM,OSMO\n0,10,5\n1,11,4.5\n';
  const frames = parseCsvFrames(csv);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].ATOM, 10);
  assert.equal(frames[1].OSMO, 4.5);
  // t column should not appear in frames
  assert.equal(frames[0].t, undefined);
});

test('parseCsvFrames: throws on too few lines', () => {
  assert.throws(() => parseCsvFrames('t,ATOM\n'));
});

test('parseCsvFrames: throws on NaN cell', () => {
  assert.throws(() => parseCsvFrames('t,ATOM\n0,banana\n'));
});

test('GBMPriceFeed.withVolSurface: swaps the surface, preserving prices and tick', () => {
  const feed = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.02 }, seed: 7 });
  for (let i = 0; i < 5; i += 1) feed.tick();
  const surface = garchFromPriceHistory(
    [{ ATOM: 10 }, { ATOM: 10.6 }, { ATOM: 10.0 }, { ATOM: 10.7 }, { ATOM: 10.1 }],
  );
  const swapped = feed.withVolSurface(surface);
  // Observable state carries over; the surface (and GARCH state) is the new one.
  assert.deepEqual(swapped.current(), feed.current());
  assert.equal(swapped.t, feed.t);
  assert.equal(swapped.volSurface, surface);
  assert.equal(swapped.isGarch, true);
  assert.ok(swapped.garchVar.ATOM > 0, 'GARCH variance is initialized from the new surface');
  // The original feed is untouched (no surface).
  assert.equal(feed.volSurface, null);
  assert.equal(feed.isGarch, false);
});

test('GBMPriceFeed.withVolSurface(null): clears a surface back to constant-sigma', () => {
  const surface = garchFromPriceHistory([{ ATOM: 10 }, { ATOM: 10.5 }, { ATOM: 10.1 }]);
  const feed = new GBMPriceFeed({ initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.02 }, seed: 7, volSurface: surface });
  assert.equal(feed.isGarch, true);
  const cleared = feed.withVolSurface(null);
  assert.equal(cleared.volSurface, null);
  assert.equal(cleared.isGarch, false);
  assert.equal(cleared.sigmaFor('ATOM'), 0.02, 'a cleared feed falls back to the config sigma');
});
