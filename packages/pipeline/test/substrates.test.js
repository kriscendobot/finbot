import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '@finbot/simulator/world';
import { plan } from '../planner.js';
import { execute } from '../executor.js';
import { audit } from '../auditor.js';
import {
  SUBSTRATES, selectSubstrate, routeResolverFor, stepHasRealRoute,
} from '../substrates.js';
import { makeWalletCapability, CapabilityError } from '../cap-attenuation.js';

// A FAKE in-memory signer — no keys, no funds, no network. Records what it was
// asked to sign/submit so the live-gate test can assert it was never called in
// dry-run. Never a real wallet (per the job's hard safety bound).
function fakeSigner() {
  const calls = [];
  return {
    calls,
    address: () => 'sim1faketestaddr',
    sign: (tx) => { calls.push(['sign', tx]); return { signed: true, tx }; },
    submit: (signed) => { calls.push(['submit', signed]); return { txid: 'fake-0xdeadbeef', signed }; },
  };
}

function setup(substrate, venueMap) {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { USDC: 0 }, initialPrice: 1 },
    priceFeed: { kind: 'gbm', initialPrices: { USDC: 1 }, volatilities: { USDC: 0.0001 }, drifts: { USDC: 0 }, seed: 5 },
    seed: 5,
  });
  const prices = world.priceFeed.current();
  const proposal = plan({
    portfolio: world.portfolio.markToMarket(prices),
    prices,
    targetWeights: { USDC: 0.5 },
    bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 },
    cited_forecasts: ['f'],
    cited_analyses: ['a'],
    substrate,
    venueMap,
  });
  const forecast = { p05Equity: 950, summary: { p05: 950, p50: 1000, p95: 1050 } };
  return { world, proposal, forecast, prices };
}

test('default substrate is sim: route placeholder preserved (back-compat)', () => {
  const { proposal } = setup(); // no substrate selected
  assert.equal(proposal.substrate, 'sim');
  assert.ok(proposal.steps.length >= 1);
  for (const s of proposal.steps) assert.equal(s.route, 'sim:single-venue');
});

test('Path A (agoric): steps carry a REAL pool place, not sim:single-venue', () => {
  const { proposal } = setup('agoric', { USDC: 'Aave_Arbitrum' });
  assert.equal(proposal.substrate, 'agoric');
  const s = proposal.steps[0];
  assert.notEqual(s.route, 'sim:single-venue');
  assert.equal(typeof s.route, 'object');
  assert.equal(s.route.substrate, 'agoric');
  assert.equal(s.route.place, 'Aave_Arbitrum');
  assert.equal(s.route.protocol, 'Aave');
  assert.equal(s.route.chain, 'Arbitrum');
  assert.equal(s.route.transport, 'axelar-gmp');
  // Deploy-config detail is flagged, not fabricated.
  assert.ok(s.route.needs_internal_detail.includes('pool-contract-address'));
  assert.ok(s.route.needs_internal_detail.includes('axelar-gmp-channel'));
  assert.ok(stepHasRealRoute(s));
});

test('Path C (evm): real chain+protocol place; USDN-style flags absent', () => {
  const { proposal } = setup('evm', { USDC: 'Aave_Base' });
  const s = proposal.steps[0];
  assert.equal(s.route.substrate, 'evm');
  assert.equal(s.route.place, 'evm:Base:Aave-v3');
  assert.equal(s.route.chain, 'Base');
  assert.equal(s.route.transport, 'direct-evm');
  assert.ok(s.route.needs_internal_detail.includes('pool-market-address'));
  assert.ok(stepHasRealRoute(s));
});

test('Path C (solana): real cluster+program place', () => {
  const { proposal } = setup('solana', { USDC: 'Kamino_Mainnet' });
  const s = proposal.steps[0];
  assert.equal(s.route.substrate, 'solana');
  assert.equal(s.route.place, 'solana:mainnet-beta:Kamino');
  assert.ok(s.route.needs_internal_detail.includes('program-id'));
  assert.ok(stepHasRealRoute(s));
});

test('an unmapped asset yields a flagged, non-reachable route (not fabricated)', () => {
  const { proposal } = setup('agoric', {}); // no venue mapped for USDC
  const s = proposal.steps[0];
  assert.equal(s.route.substrate, 'agoric');
  assert.ok(s.route.needs_internal_detail.includes('venue-mapping'));
  assert.equal(stepHasRealRoute(s), false);
});

test('auditor place-route reachability: passes on a real route, fails when unmapped', () => {
  const real = setup('agoric', { USDC: 'Compound_Arbitrum' });
  const vReal = audit({
    proposal: real.proposal, forecast: real.forecast,
    portfolio: real.world.portfolio.markToMarket(real.prices), prices: real.prices,
    currentTick: real.world.priceFeed.t, oracleReadings: [],
  }, { tailFloorPct: 0.8, maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 });
  const routeInvReal = vReal.invariant_results.find((r) => r.name === 'place-route-reachability');
  assert.equal(routeInvReal.pass, true);

  const bad = setup('agoric', {}); // unmapped
  const vBad = audit({
    proposal: bad.proposal, forecast: bad.forecast,
    portfolio: bad.world.portfolio.markToMarket(bad.prices), prices: bad.prices,
    currentTick: bad.world.priceFeed.t, oracleReadings: [],
  }, { tailFloorPct: 0.8, maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 });
  const routeInvBad = vBad.invariant_results.find((r) => r.name === 'place-route-reachability');
  assert.equal(routeInvBad.pass, false);
  assert.ok(vBad.failed_invariants.includes('place-route-reachability'));
});

test('agoric adapter builds a rebalanceTx-shaped UNSIGNED transaction', () => {
  const { proposal } = setup('agoric', { USDC: 'Aave_Arbitrum' });
  const tx = SUBSTRATES.agoric.buildTransaction({ steps: proposal.steps });
  assert.equal(tx.kind, 'agoric.rebalanceTx');
  assert.equal(tx.signed, false);
  assert.equal(tx.invitationSpec.invitationMakerName, 'Rebalance');
  assert.equal(tx.invitationSpec.source, 'continuing');
  assert.ok(Array.isArray(tx.offerArgs.flows));
  assert.equal(tx.offerArgs.flows[0].dest, 'Aave_Arbitrum'); // buy: cash -> pool
});

test('evm adapter builds an approve+supply call batch, unsigned', () => {
  const { proposal } = setup('evm', { USDC: 'Aave_Base' });
  const tx = SUBSTRATES.evm.buildTransaction({ steps: proposal.steps });
  assert.equal(tx.kind, 'evm.callBatch');
  assert.equal(tx.signed, false);
  assert.deepEqual(tx.calls.map((c) => c.method), ['approve', 'supply']);
});

test('DRY-RUN executor on agoric: builds the tx, NEVER signs, wallet untouched', async () => {
  const { world, proposal, forecast } = setup('agoric', { USDC: 'Aave_Arbitrum' });
  const signer = fakeSigner();
  const { cap } = makeWalletCapability(signer);
  // Even if a wallet is in the parent caps, dry-run attenuation drops it.
  const r = await execute(
    { proposal, world, forecast, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: { wallet: cap } },
    { mode: 'dry-run', auditConfig: { tailFloorPct: 0.8, maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 } },
  );
  assert.equal(r.mode, 'dry-run');
  assert.equal(r.walletTouched, false);
  assert.equal(r.substrate, 'agoric');
  assert.equal(r.prepared_transaction.kind, 'agoric.rebalanceTx');
  assert.equal(r.prepared_transaction.signed, false);
  assert.equal(r.submission, null);
  // The proof: the signer was never asked to sign or submit anything.
  assert.equal(signer.calls.length, 0);
  // Steps carry their real route in the completed report.
  assert.equal(r.steps_completed[0].route.place, 'Aave_Arbitrum');
});

test('executor refuses live without authorization on a real substrate too', async () => {
  const { world, proposal, forecast } = setup('agoric', { USDC: 'Aave_Arbitrum' });
  const r = await execute(
    { proposal, world, forecast, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: {} },
    { mode: 'live', live_authorized: false },
  );
  assert.ok(r.refusal);
  assert.equal(r.walletTouched, false);
  assert.equal(r.submission, null);
});

test('signAndSubmit is unreachable without a wallet capability (fails closed)', async () => {
  const { proposal } = setup('agoric', { USDC: 'Aave_Arbitrum' });
  const tx = SUBSTRATES.agoric.buildTransaction({ steps: proposal.steps });
  await assert.rejects(() => SUBSTRATES.agoric.signAndSubmit(tx, undefined), CapabilityError);
});

test('selectSubstrate / routeResolverFor reject an unknown substrate', () => {
  assert.throws(() => selectSubstrate('dogecoin-l3'), CapabilityError);
  assert.throws(() => routeResolverFor('dogecoin-l3'), CapabilityError);
});

test('sim substrate has no live path', async () => {
  await assert.rejects(() => SUBSTRATES.sim.signAndSubmit({}, {}), CapabilityError);
});
