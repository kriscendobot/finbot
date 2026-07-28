import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The `finbot-ooda` flags that ARM the pre-execution data-sufficiency gate. The
// whole justification for their validation is fail-fast-on-typo, so a rejection
// path with no test is the one place where "it works" is least worth believing:
// a flag that silently disarms a safety gate looks exactly like a flag that
// armed it. These drive the binary rather than the parser, since the parser is
// module-private and the operator's surface is the process.

const CLI = fileURLToPath(new URL('../../../bin/finbot-ooda', import.meta.url));

function runCli(...flags) {
  return spawnSync(process.execPath, [CLI, ...flags], { encoding: 'utf8' });
}

test('finbot-ooda: a threshold the gate could not evaluate exits 2', () => {
  // Every one of these is a value an unvalidated `Number()` would turn into NaN
  // or into 0 — and 0 is the OFF value, so the operator would get no gate at all.
  for (const flag of ['--data-sufficiency-min', '--data-sufficiency-min=',
    '--data-sufficiency-min=   ', '--data-sufficiency-min=abc', '--data-sufficiency-min=-1',
    '--data-sufficiency-min=Infinity', '--data-sufficiency-min=1e-13']) {
    const result = runCli(flag, '--ensemble=4');
    assert.equal(result.status, 2, flag);
    assert.match(result.stderr, /--data-sufficiency-min must be a finite number/);
  }
});

test('finbot-ooda: a horizon that is not a tick count exits 2', () => {
  // The horizon is the DENOMINATOR of the ratio the gate reads, so leaving it
  // unvalidated disarms the gate through the sibling flag: `--horizon=abc` once
  // printed `coverage=0.00 ... 0-tick horizon` and `[PASS]` under an armed gate.
  for (const flag of ['--horizon=abc', '--horizon=0', '--horizon=-5', '--horizon=2.5',
    '--horizon', '--horizon=']) {
    const result = runCli(flag, '--data-sufficiency-min=1', '--ensemble=4');
    assert.equal(result.status, 2, flag);
    assert.match(result.stderr, /--horizon must be a whole number of ticks/);
  }
});

test('finbot-ooda: an armed gate rejects a thin forecast and labels it SCARCE', () => {
  // 9 observed returns over a 20-tick horizon is coverage 0.45, below the 1.0
  // the operator required.
  const result = runCli('--horizon=20', '--data-sufficiency-min=1', '--ensemble=8');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /data-sufficiency: coverage=0\.45 on ATOM .*SCARCE/);
  assert.match(result.stdout, /auditor: REJECTED failed=forecast-data-sufficiency/);
});

test('finbot-ooda: the gate is OFF by default and at F=0 — six invariants, unchanged', () => {
  // The invariant the whole feature is built to preserve: off, the seventh
  // invariant is not emitted and the verdict is byte-identical to before.
  const off = runCli('--ensemble=8', '--json');
  const zero = runCli('--ensemble=8', '--json', '--data-sufficiency-min=0');
  assert.equal(off.status, 0);
  assert.equal(zero.status, 0);
  assert.equal(off.stdout, zero.stdout);
  const verdict = JSON.parse(off.stdout).audit;
  assert.equal(verdict.invariant_results.length, 6);
  assert.ok(!verdict.invariant_results.some((r) => r.name === 'forecast-data-sufficiency'));
  assert.equal(JSON.parse(off.stdout).forecast.dataSufficiency, null);
});
