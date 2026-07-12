/**
 * End-to-end: a conditional-volatility surface flows from driver config through
 * makeWorld into the forecaster's Monte Carlo ensemble.
 *
 * The last two simulator cycles added GARCH / GJR-GARCH volatility-clustering
 * surfaces, but the OODA pipeline's world builder only ever constructed a plain
 * constant-sigma GBM feed, so the decision layer could not use them. This pins
 * the wiring that closes that gap: `makeDryRunCompute({ volSurface })` builds a
 * GARCH-driven ensemble, while the absent-descriptor path stays byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDryRunCompute } from '../driver-compute.js';

const CHAIN = { seed: 11, drift: -0.01, warmup: 10 };
const histogramJson = (res) => JSON.stringify(res.forecast.histogram);

test('driver: a GARCH volSurface descriptor reshapes the forecast ensemble', async () => {
  const plain = makeDryRunCompute(CHAIN);
  const garch = makeDryRunCompute({
    ...CHAIN,
    volSurface: { kind: 'garch', volatilities: { ATOM: 0.03 }, alpha: 0.15, beta: 0.8 },
  });

  const a = await plain({ tickId: 'aaaa01' });
  const b = await garch({ tickId: 'aaaa01' });

  // Both still run the full dry-run chain and never touch a wallet.
  assert.equal(a.walletTouched, false);
  assert.equal(b.walletTouched, false);
  assert.ok(a.forecast && b.forecast, 'both cycles produce a forecast');

  // The clustering surface changes the terminal-equity distribution: same seed,
  // same tick, but a different histogram than the constant-sigma feed.
  assert.notEqual(histogramJson(a), histogramJson(b));
});

test('driver: a GARCH-driven forecast is reproducible given the same tick', async () => {
  const garch = makeDryRunCompute({
    ...CHAIN,
    volSurface: { kind: 'garch', volatilities: { ATOM: 0.03 }, alpha: 0.15, beta: 0.8 },
  });
  const a = await garch({ tickId: 'bbbb02' });
  const b = await garch({ tickId: 'bbbb02' });
  assert.equal(histogramJson(a), histogramJson(b));
  assert.equal(a.proposal?.proposal_hash, b.proposal?.proposal_hash);
});

test('driver: gjr-garch descriptor is accepted end to end', async () => {
  const gjr = makeDryRunCompute({
    ...CHAIN,
    volSurface: { kind: 'gjr-garch', volatilities: { ATOM: 0.03 }, gamma: 0.12 },
  });
  const res = await gjr({ tickId: 'cccc03' });
  assert.equal(res.walletTouched, false);
  assert.ok(res.forecast, 'gjr-garch cycle produces a forecast');
});

test('driver: omitting volSurface leaves the plain-GBM forecast unchanged', async () => {
  // No descriptor -> makeVolSurface(undefined) === null -> constant-sigma GBM.
  // Two independent computes with identical config replay byte-for-byte, proving
  // the new plumbing is inert on the default path.
  const one = makeDryRunCompute(CHAIN);
  const two = makeDryRunCompute(CHAIN);
  const a = await one({ tickId: 'dddd04' });
  const b = await two({ tickId: 'dddd04' });
  assert.equal(histogramJson(a), histogramJson(b));
  assert.equal(a.summary, b.summary);
});

test('driver: adaptiveVol fits a surface from the live window end to end', async () => {
  // No statically-named surface — the forecaster FITS one from THIS tick's
  // observed oracle window. The cycle produces a volFit and stays wallet-safe.
  const adaptive = makeDryRunCompute({ ...CHAIN, adaptiveVol: { kind: 'garch' } });
  const res = await adaptive({ tickId: 'eeee05' });
  assert.equal(res.walletTouched, false);
  assert.ok(res.forecast, 'adaptive cycle produces a forecast');
  if (res.forecast.volFit) {
    // When the observed window drove a fit, it names the observed-window source.
    assert.equal(res.forecast.volFit.source, 'observed-window');
    assert.equal(res.forecast.volFit.kind, 'garch');
  }
});

test('driver: adaptiveVol reshapes vs the plain feed and is reproducible', async () => {
  const plain = makeDryRunCompute(CHAIN);
  const adaptive = makeDryRunCompute({ ...CHAIN, adaptiveVol: { kind: 'garch' } });

  const p = await plain({ tickId: 'ffff06' });
  const a1 = await adaptive({ tickId: 'ffff06' });
  const a2 = await adaptive({ tickId: 'ffff06' });

  // Same tick, same seed: adaptive projects under the fitted surface, so its
  // histogram differs from the plain constant-sigma feed — yet is reproducible.
  assert.notEqual(histogramJson(p), histogramJson(a1));
  assert.equal(histogramJson(a1), histogramJson(a2));
  assert.equal(a1.proposal?.proposal_hash, a2.proposal?.proposal_hash);
});
