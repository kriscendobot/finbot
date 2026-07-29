import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The `finbot-ooda` flags that ARM the pre-execution data-sufficiency gate. The
// whole justification for their validation is fail-fast-on-typo, so a rejection
// path with no test is the one place where "it works" is least worth believing:
// a flag that silently disarms a safety gate looks exactly like a flag that
// armed it. These drive the binary rather than the parser, since the parser is
// module-private and the operator's surface is the process.

// Checkout-relative, never machine-relative, so it ports to any clone. Asserted
// at module scope so a layout drift fails as itself rather than as an opaque
// `expected null to equal 2` from a spawn that never found the binary.
const CLI = fileURLToPath(new URL('../../../bin/finbot-ooda', import.meta.url));
assert.ok(existsSync(CLI), `the finbot-ooda binary is missing at ${CLI}`);

function runCli(...flags) {
  // `process.execPath` with the script path, not the script's shebang: the exec
  // bit and `/usr/bin/env node` are not preconditions on every checkout. Timeout
  // and maxBuffer are pinned rather than inherited, so a wedged or unexpectedly
  // verbose child fails as itself instead of hanging the suite or dying at
  // JSON.parse.
  const result = spawnSync(process.execPath, [CLI, ...flags], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 8 << 20,
  });
  assert.equal(result.error, undefined, `spawning the CLI failed: ${result.error}`);
  return result;
}

test('finbot-ooda: a threshold the gate could not evaluate exits 2', () => {
  // Every one of these is a value an unvalidated `Number()` would turn into NaN
  // or into 0 — and 0 is the OFF value, so the operator would get no gate at all.
  for (const flag of ['--data-sufficiency-min', '--data-sufficiency-min=',
    '--data-sufficiency-min=   ', '--data-sufficiency-min=abc', '--data-sufficiency-min=-1',
    '--data-sufficiency-min=Infinity', '--data-sufficiency-min=1e-13',
    '--data-sufficiency-min=1e-5000']) {
    const result = runCli(flag, '--ensemble=4');
    assert.equal(result.status, 2, flag);
    assert.match(result.stderr, /--data-sufficiency-min must be a finite number/);
  }
});

test('finbot-ooda: zero threshold exponent forms remain the documented off value', () => {
  const plain = runCli('--ensemble=8', '--json', '--data-sufficiency-min=0');
  const exponent = runCli('--ensemble=8', '--json', '--data-sufficiency-min=0e1');
  assert.equal(exponent.status, 0);
  assert.equal(exponent.stdout, plain.stdout);
});

test('finbot-ooda: an armed gate rejects an unusable horizon-stretch override', () => {
  for (const flag of ['--regime-horizon-stretch=abc', '--regime-horizon-stretch=-0.5',
    '--regime-horizon-stretch=Infinity']) {
    const result = runCli(flag, '--data-sufficiency-min=1', '--ensemble=4');
    assert.equal(result.status, 2, flag);
    assert.match(result.stderr, /--regime-horizon-stretch must be a finite number/);
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
  assert.match(result.stdout, /data-sufficiency: coverage=0\.450 on ATOM .*SCARCE/);
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

test('finbot-ooda: an armed gate that the forecast CLEARS approves, with no SCARCE label', () => {
  // The reject path and both validations are pinned above; this is the branch the
  // header's operator guidance rests on ("widen the observed window with
  // --fit-window ... to make a requirement of 1.0 reachable") and the one where a
  // wiring slip reads as success rather than as failure.
  const result = runCli('--warmup=40', '--fit-window=40', '--horizon=20',
    '--data-sufficiency-min=1', '--ensemble=8');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /data-sufficiency: coverage=1\.950 on ATOM/);
  assert.ok(!/SCARCE/.test(result.stdout), 'a cleared gate never labels the forecast scarce');
  assert.match(result.stdout, /\[PASS\] forecast-data-sufficiency/);
  assert.match(result.stdout, /auditor: APPROVED/);
});

test('finbot-ooda: the gate is wired in the MULTI world too, not only the single one', () => {
  // Both world builders got the same two lines (arm the auditor knob, report the
  // forecaster evidence), and the default seed's multi run takes the no-action
  // branch — so without a seed that actually reaches the audit stage, the
  // multi-world half of the wiring was pinned by nothing.
  const result = runCli('--multi', '--seed=3', '--drift=-0.03', '--horizon=20',
    '--data-sufficiency-min=1', '--ensemble=8');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /data-sufficiency: coverage=0\.450 on ATOM .*SCARCE/);
  assert.match(result.stdout, /auditor: REJECTED failed=forecast-data-sufficiency/);
});

test('finbot-ooda: a window flag that is not a tick count exits 2', () => {
  // `--fit-window` is the NUMERATOR's window, so it validates for the same reason
  // `--horizon` does: unvalidated, `Number('abc')` is NaN, `NaN > windowTicks` is
  // false, and the window silently collapses back to `--warmup` — the operator
  // gets a rejection naming a gate they believe they widened past.
  for (const flag of ['--fit-window=abc', '--fit-window=2.5', '--fit-window=-1', '--fit-window',
    '--warmup=abc', '--warmup=2.5']) {
    const result = runCli(flag, '--data-sufficiency-min=1', '--ensemble=4');
    assert.equal(result.status, 2, flag);
    assert.match(result.stderr, /must be a whole number of ticks/);
  }
});
