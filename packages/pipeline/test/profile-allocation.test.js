import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileSignals,
  signalFromSlider,
  makeVolatilityProfile,
} from '@finbot/simulator';
import {
  toleranceFromProfile,
  selectAllocationForProfile,
  planForProfile,
} from '../profile-allocation.js';
import { hashProposal } from '../planner.js';

// Three allocations spanning the frontier, each with the weights that realize it.
const candidates = [
  { id: 'conservative', reward: 0.02, risk: 0.05, targetWeights: { YIELD: 0.8, GROWTH: 0.2 } },
  { id: 'balanced', reward: 0.06, risk: 0.15, targetWeights: { YIELD: 0.5, GROWTH: 0.5 } },
  { id: 'aggressive', reward: 0.12, risk: 0.32, targetWeights: { YIELD: 0.1, GROWTH: 0.9 } },
];

function profileWithTau(tau) {
  const posterior = reconcileSignals([signalFromSlider(tau, { sigma: 0.02 })]);
  return makeVolatilityProfile({ userId: 'u', posterior, now: 0 });
}

test('toleranceFromProfile: reads tau from a profile or accepts a bare number', () => {
  assert.equal(toleranceFromProfile(0.42), 0.42);
  assert.ok(Math.abs(toleranceFromProfile(profileWithTau(0.7)) - 0.7) < 0.01);
  assert.throws(() => toleranceFromProfile({}));
  assert.throws(() => toleranceFromProfile(null));
});

test('selectAllocationForProfile: appetite picks the matching allocation', () => {
  const averse = selectAllocationForProfile({ profile: profileWithTau(0.05), candidates });
  assert.equal(averse.chosen.id, 'conservative');
  const bold = selectAllocationForProfile({ profile: profileWithTau(0.97), candidates });
  assert.equal(bold.chosen.id, 'aggressive');
  // A direct tolerance overrides any profile.
  const mid = selectAllocationForProfile({ tolerance: 0.5, candidates });
  assert.ok(['balanced', 'conservative', 'aggressive'].includes(mid.chosen.id));
  assert.equal(mid.tolerance, 0.5);
});

test('planForProfile: formalizes the chosen allocation through plan()', () => {
  const portfolio = { cash: 1000, balances: { GROWTH: 0, YIELD: 0 }, quoteCurrency: 'USDC' };
  const prices = { GROWTH: 10, YIELD: 10 };
  const bounds = { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 };

  const proposal = planForProfile({
    profile: profileWithTau(0.97), candidates, portfolio, prices, bounds,
  });
  assert.equal(proposal.chosenAllocationId, 'aggressive');
  // The proposal targets the aggressive allocation's weights.
  assert.deepEqual(proposal.targetWeights, { YIELD: 0.1, GROWTH: 0.9 });
  // It is a real, hashable planner proposal.
  assert.equal(proposal.proposal_hash, hashProposal(proposal.steps));
  assert.ok(proposal.steps.length > 0);
  // The bold appetite buys mostly GROWTH.
  const growthBuy = proposal.steps.find((s) => s.asset === 'GROWTH');
  assert.ok(growthBuy && growthBuy.side === 'buy');
});

test('planForProfile: deterministic — same profile yields the same proposal hash', () => {
  const portfolio = { cash: 1000, balances: { GROWTH: 1, YIELD: 1 } };
  const prices = { GROWTH: 10, YIELD: 10 };
  const bounds = { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 };
  const a = planForProfile({ tolerance: 0.5, candidates, portfolio, prices, bounds });
  const b = planForProfile({ tolerance: 0.5, candidates, portfolio, prices, bounds });
  assert.equal(a.proposal_hash, b.proposal_hash);
});

test('selectAllocationForProfile: no candidates throws', () => {
  assert.throws(() => selectAllocationForProfile({ tolerance: 0.5, candidates: [] }));
});
