/**
 * Driver compute-hook tests.
 *
 * `makeDryRunCompute` is the wiring that lets the harness loop run an in-process
 * OODA cycle: it builds a warmed simulator world and drives `runOodaCycle` in
 * DRY-RUN. These tests pin the contract the harness relies on (a function taking
 * the tick context, returning an OodaResult, never touching a wallet) and the
 * per-tick seed derivation that keeps successive ticks distinct yet reproducible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDryRunCompute, deriveSeed } from '../driver-compute.js';

test('makeDryRunCompute: returns a function', () => {
  assert.equal(typeof makeDryRunCompute(), 'function');
});

test('makeDryRunCompute: runs a dry-run cycle and never touches a wallet', async () => {
  // drift biases a dip so the oracle crosses and the full chain runs.
  const compute = makeDryRunCompute({ seed: 11, drift: -0.01, warmup: 10 });
  const res = await compute({ tickId: 'a1b2c3' });
  assert.equal(res.walletTouched, false);
  assert.ok(
    ['no-opportunity', 'no-action', 'rejected', 'dry-run-complete'].includes(res.outcome),
    `unexpected outcome ${res.outcome}`,
  );
  // with this seed/drift the chain reaches a dry-run execution
  assert.equal(res.outcome, 'dry-run-complete');
  assert.ok(res.execution);
  assert.equal(res.execution.mode, 'dry-run');
});

test('makeDryRunCompute: records each stage through the injected recorder', async () => {
  const recorded = [];
  const recorder = { record: async (e) => { recorded.push(e.kind); return `entry:${e.kind}`; } };
  const compute = makeDryRunCompute({ seed: 11, drift: -0.01 });
  await compute({ tickId: 'deadbe', recorder });
  // observe -> analysis -> forecast -> proposal -> audit -> execution
  assert.deepEqual(recorded, ['oracle-read', 'analysis', 'forecast', 'proposal', 'audit', 'execution']);
});

test('makeDryRunCompute: is reproducible given the same tickId', async () => {
  const compute = makeDryRunCompute({ seed: 7, drift: -0.01 });
  const a = await compute({ tickId: 'cafe01' });
  const b = await compute({ tickId: 'cafe01' });
  assert.equal(a.proposal?.proposal_hash, b.proposal?.proposal_hash);
  assert.equal(a.summary, b.summary);
});

test('makeDryRunCompute: different ticks face different markets', async () => {
  const compute = makeDryRunCompute({ seed: 7, drift: -0.01 });
  const a = await compute({ tickId: '000001' });
  const b = await compute({ tickId: '000002' });
  // a different derived seed yields a different oracle window, so the summaries
  // (which embed prices/NAV) differ. We don't assert on the decision branch, only
  // that the two ticks are not byte-identical replays of one frozen cycle.
  assert.notEqual(a.summary, b.summary);
});

test('deriveSeed: stable, varies by tickId, falls back without one', () => {
  assert.equal(deriveSeed(7, undefined), 7);
  assert.equal(deriveSeed(7, 'zzzzzz'), 7, 'non-hex falls back to base seed');
  assert.equal(deriveSeed(7, '000000'), 7);
  assert.equal(deriveSeed(7, '000001'), 8);
  assert.equal(deriveSeed(7, 'a1b2c3'), (7 + parseInt('a1b2c3', 16)) % 0x7fffffff);
});
