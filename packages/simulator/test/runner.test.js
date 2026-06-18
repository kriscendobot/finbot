import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSimulator, runSimulatorFromConfig } from '../runner.js';
import { makeWorld } from '../world.js';
import { Portfolio } from '../portfolio.js';

test('runSimulator: throws on missing portfolio or priceFeed', () => {
  assert.throws(() => runSimulator({}));
  assert.throws(() => runSimulator({ portfolio: new Portfolio() }));
});

test('runSimulator: tick advances price feed t', () => {
  const sim = runSimulator(makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
  }));
  assert.equal(sim.world.priceFeed.t, 0);
  const obs1 = sim.tick();
  assert.equal(obs1.t, 1);
  const obs2 = sim.tick();
  assert.equal(obs2.t, 2);
});

test('runSimulator: observe returns current snapshot without advancing', () => {
  const sim = runSimulator(makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
  }));
  const t0 = sim.world.priceFeed.t;
  sim.observe();
  sim.observe();
  assert.equal(sim.world.priceFeed.t, t0);
});

test('runSimulator: records history when enabled', () => {
  const sim = runSimulator(
    makeWorld({
      portfolio: { cash: 1000 },
      priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
    }),
    { recordHistory: true },
  );
  // history seeded with t=0 observation
  assert.equal(sim.history.length, 1);
  sim.tick();
  sim.tick();
  assert.equal(sim.history.length, 3);
});

test('runSimulator: recordHistory=false skips history', () => {
  const sim = runSimulator(
    makeWorld({
      portfolio: { cash: 1000 },
      priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
    }),
    { recordHistory: false },
  );
  sim.tick();
  sim.tick();
  assert.equal(sim.history.length, 0);
});

test('runSimulator: tickFn receives world + t + prices and runs each tick', () => {
  const calls = [];
  const tickFn = (w, t, prices) => {
    calls.push({ t, prices });
    return { acted: false };
  };
  const sim = runSimulator(
    makeWorld({
      portfolio: { cash: 1000 },
      priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
    }),
    { tickFn },
  );
  sim.tick();
  sim.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].t, 1);
  assert.equal(calls[1].t, 2);
});

test('runSimulator: tickFn can mutate portfolio (apply trades)', () => {
  const tickFn = (w, t, prices) => {
    if (t === 1) {
      w.portfolio.applyTrade({ t, side: 'buy', asset: 'ATOM', qty: 10, price: prices.ATOM });
    }
  };
  const sim = runSimulator(
    makeWorld({
      portfolio: { cash: 1000 },
      priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
    }),
    { tickFn },
  );
  sim.tick();
  assert.equal(sim.world.portfolio.balances.ATOM, 10);
  assert.ok(sim.world.portfolio.cash < 1000);
});

test('runSimulator: fork(seed) returns an independent child simulator', () => {
  const sim = runSimulator(makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
  }));
  sim.tick();
  const before = sim.world.priceFeed.current().ATOM;
  const child = sim.fork(999);
  // child's initial price equals parent's current price (clone preserves
  // state, but rng diverges).
  assert.equal(child.world.priceFeed.current().ATOM, before);
  child.tick();
  child.tick();
  // parent untouched by child ticks
  assert.equal(sim.world.priceFeed.t, 1);
  assert.equal(child.world.priceFeed.t, 3);
});

test('runSimulator: fork tag defaults to derived label', () => {
  const sim = runSimulator(makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
    tag: 'outer',
  }));
  const child = sim.fork(7);
  assert.match(child.world.tag, /outer\/fork-7/);
});

test('runSimulator: meta-circular — child can fork grandchild', () => {
  const sim = runSimulator(makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, seed: 1 },
  }));
  const child = sim.fork(7);
  const grandchild = child.fork(11);
  assert.ok(grandchild.tick);
  assert.equal(grandchild.world.seed, 11);
  // All three are independent
  sim.tick();
  child.tick();
  grandchild.tick();
  grandchild.tick();
  assert.equal(sim.world.priceFeed.t, 1);
  assert.equal(child.world.priceFeed.t, 1);
  assert.equal(grandchild.world.priceFeed.t, 2);
});

test('runSimulatorFromConfig: builds world + sim in one call', () => {
  const sim = runSimulatorFromConfig({
    portfolio: { cash: 500 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 5 }, seed: 3 },
  });
  assert.equal(sim.world.portfolio.cash, 500);
  assert.equal(sim.world.priceFeed.current().ATOM, 5);
});

test('runSimulator: deterministic — two sims with same seed yield identical observations', () => {
  function buildSim() {
    return runSimulator(makeWorld({
      portfolio: { cash: 1000 },
      priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 42 },
    }));
  }
  const a = buildSim();
  const b = buildSim();
  for (let i = 0; i < 30; i += 1) {
    const oa = a.tick();
    const ob = b.tick();
    assert.equal(oa.prices.ATOM, ob.prices.ATOM);
    assert.equal(oa.portfolio.equity, ob.portfolio.equity);
  }
});
