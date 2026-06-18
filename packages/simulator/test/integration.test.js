/**
 * Integration test: drive a 100-tick simulation end-to-end with a
 * trivial agent tickFn that does a small position size, emit metrics
 * to JSONL, run a forecast, and run the self-improvement reflection.
 *
 * The agent tickFn in this test is intentionally minimal — a
 * mean-reversion stand-in that buys when price dips below the prior
 * tick and sells when it rises. It is not a real strategy; the point
 * is to exercise the full loop end to end and verify the metric
 * stream + forecast + reflection all wire up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { makeWorld } from '../world.js';
import { runSimulator } from '../runner.js';
import { perTickMetrics, summaryMetrics, rowsToJsonl } from '../metrics.js';
import { forecast } from '../forecast.js';
import { reflectAndRecord } from '../self-improvement.js';

function meanRevertTickFn(world, t, prices) {
  // Track the previous price out-of-band on the world's harnessConfig.
  const prev = world.harnessConfig._lastPrice;
  world.harnessConfig._lastPrice = prices.ATOM;
  if (prev == null) return { action: 'init', t };

  const tradeSize = world.harnessConfig.tradeSize || 1;
  const minNotional = world.harnessConfig.minTradeNotional || 0;
  const notional = tradeSize * prices.ATOM;
  if (notional < minNotional) return { action: 'skip-small', t, notional };

  // Buy on dip
  if (prices.ATOM < prev && world.portfolio.cash >= notional) {
    try {
      world.portfolio.applyTrade({ t, side: 'buy', asset: 'ATOM', qty: tradeSize, price: prices.ATOM });
      return { action: 'buy', t, qty: tradeSize, price: prices.ATOM };
    } catch (e) {
      return { action: 'buy-error', t, error: e.message };
    }
  }
  // Sell on lift
  if (prices.ATOM > prev && (world.portfolio.balances.ATOM || 0) >= tradeSize) {
    try {
      world.portfolio.applyTrade({ t, side: 'sell', asset: 'ATOM', qty: tradeSize, price: prices.ATOM });
      return { action: 'sell', t, qty: tradeSize, price: prices.ATOM };
    } catch (e) {
      return { action: 'sell-error', t, error: e.message };
    }
  }
  return { action: 'hold', t };
}

test('integration: 100-tick simulation emits metrics JSONL and reflects', async () => {
  // Seed = 42 deterministically.
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
    priceFeed: {
      kind: 'gbm',
      initialPrices: { ATOM: 10 },
      volatilities: { ATOM: 0.03 },
      drifts: { ATOM: 0.0005 },
      seed: 42,
    },
    harnessConfig: {
      tradeSize: 1,
      minTradeNotional: 5,
      weights: { momentum: 0.5 },
      drawdownStopPct: 0.20,
      proposeThreshold: 0.05,
      maxAllocationPct: 0.5,
    },
    seed: 42,
    tag: 'integration',
  });

  const sim = runSimulator(world, { tickFn: meanRevertTickFn });
  const TICKS = 100;
  for (let i = 0; i < TICKS; i += 1) sim.tick();

  // history includes the t=0 seed observation plus 100 ticks
  assert.equal(sim.history.length, TICKS + 1);

  const metricRows = perTickMetrics(sim.history);
  assert.equal(metricRows.length, TICKS + 1);

  // Emit JSONL to a tmp file and verify it lands and parses
  const dir = await mkdtemp(path.join(tmpdir(), 'finbot-sim-integ-'));
  const outPath = path.join(dir, 'sim-metrics.jsonl');
  try {
    await writeFile(outPath, rowsToJsonl(metricRows));
    const raw = await readFile(outPath, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, TICKS + 1);
    const first = JSON.parse(lines[0]);
    assert.equal(first.t, 0);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.t, TICKS);
    assert.ok('equity' in last);
    assert.ok('drawdown' in last);
    assert.ok('logReturn' in last);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // Run a forecast from the final state with no proposed action; verify it works
  const f = forecast({
    from: sim,
    horizon: 20,
    ensembleSize: 10,
    baseSeed: 9000,
  });
  assert.equal(f.outcomes.length, 10);
  assert.ok(f.summary.meanEquity > 0);
  assert.ok(f.histogram.counts.reduce((a, b) => a + b, 0) === 10);

  // Reflect on the run; verify proposals (if any) carry the expected shape.
  // We pass dryRun:true since this is a unit test and we do not want to
  // write to any real journal.
  const reflection = await reflectAndRecord({
    observations: sim.history,
    harnessConfig: world.harnessConfig,
    journalRoot: dir,
    recordEntry: async () => 'unused',
    dryRun: true,
    tag: `integration-${TICKS}`,
  });
  // Proposals are 0 or more depending on what the GBM walk produced. We
  // do not assert on count beyond bounds.
  assert.ok(Array.isArray(reflection.proposals));
  assert.ok(reflection.proposals.length <= 3);
  // The body should always render the window summary.
  assert.match(reflection.body, /# Self-improvement reflection/);
  assert.match(reflection.body, /ticks: 101/);

  // Summary metrics should report the same final equity as the last row.
  const sum = summaryMetrics(sim.history);
  assert.ok(Math.abs(sum.finalEquity - metricRows[metricRows.length - 1].equity) < 1e-9);
});

test('integration: same seed yields byte-identical metric stream', async () => {
  function runIt() {
    const world = makeWorld({
      portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
      priceFeed: {
        kind: 'gbm',
        initialPrices: { ATOM: 10 },
        volatilities: { ATOM: 0.03 },
        drifts: { ATOM: 0.0005 },
        seed: 42,
      },
      harnessConfig: { tradeSize: 1 },
      seed: 42,
      tag: 'integration',
    });
    const sim = runSimulator(world, { tickFn: meanRevertTickFn });
    for (let i = 0; i < 50; i += 1) sim.tick();
    return rowsToJsonl(perTickMetrics(sim.history));
  }
  const a = runIt();
  const b = runIt();
  assert.equal(a, b);
});

test('integration: deterministic forecast at end of run is reproducible', async () => {
  function runIt() {
    const world = makeWorld({
      portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
      priceFeed: {
        kind: 'gbm',
        initialPrices: { ATOM: 10 },
        volatilities: { ATOM: 0.03 },
        seed: 42,
      },
      harnessConfig: { tradeSize: 1 },
    });
    const sim = runSimulator(world, { tickFn: meanRevertTickFn });
    for (let i = 0; i < 30; i += 1) sim.tick();
    return forecast({ from: sim, horizon: 10, ensembleSize: 8, baseSeed: 1234 });
  }
  const a = runIt();
  const b = runIt();
  assert.deepEqual(a.outcomes, b.outcomes);
  assert.deepEqual(a.histogram, b.histogram);
});
