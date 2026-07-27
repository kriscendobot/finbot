/**
 * Inference-driven OBSERVE-stage (oracle-watcher) dispatch tests.
 *
 * Companion to `role-dispatch.test.js` (ORIENT), `planner-dispatch.test.js`
 * (DECIDE), `auditor-dispatch.test.js` and `executor-dispatch.test.js` (ACT).
 * Drives the OBSERVE stage end-to-end through `spawn` with the deterministic
 * observe-phase detector, using offline LLMs (the scripted observer double and
 * the harness stub). Verifies the stage completes, the subagent CALLS the
 * deterministic `observe_opportunities` tool, the observation is extracted from
 * the dispatch, the inference-driven path reproduces the headless
 * `observeOpportunities` crossings byte-for-byte, and a quiet window (no
 * crossing) is surfaced as zero crossings through the same tool.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from '@finbot/harness/spawn';

import { observeOpportunities } from '../oracle-watcher.js';
import { observerToolRegistry, OBSERVER_TOOL_NAMES } from '../agent-tools.js';
import {
  dispatchObserver, guardedObservation, observerBrief, makeScriptedObserverLlm, lastObservationResult,
} from '../role-dispatch.js';

async function withFinbotRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-observe-dispatch-'));
  try {
    await mkdir(path.join(root, 'roles', 'oracle-watcher'), { recursive: true });
    await writeFile(
      path.join(root, 'roles', 'oracle-watcher', 'AGENT.md'),
      '# Role: oracle-watcher\n\nRead a price window and emit opportunity-deviation events; read-only; you never trade.\n',
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A window whose ATOM price drifts down ~150bps from the reference, so at a
// 50bps threshold exactly one crossing is emitted (ATOM, down).
function observeInput(thresholdBps = 50) {
  return {
    readings: [
      { t: 0, prices: { ATOM: 10, OSMO: 2 } },
      { t: 1, prices: { ATOM: 9.9, OSMO: 2 } },
      { t: 2, prices: { ATOM: 9.85, OSMO: 2 } },
    ],
    thresholdBps,
  };
}

test('observerBrief: embeds the window and instructs detector use', () => {
  const brief = observerBrief(observeInput());
  assert.match(brief, /observe_opportunities/);
  assert.match(brief, /read-only/);
  assert.match(brief, /OBSERVE phase/);
  assert.match(brief, /never score, propose, or trade/);
});

test('observe stage exposes exactly the read-only detector — no wallet-reaching tool', () => {
  // Pins the no-wallet invariant the PR emphasizes: the observe-phase capability
  // subset is exactly the deviation detector. Reddens if a future edit widens
  // the registry (e.g. adds a signing/execution tool) or the capability names.
  assert.deepEqual(OBSERVER_TOOL_NAMES, ['observe_opportunities']);
  assert.deepEqual(Object.keys(observerToolRegistry()), ['observe_opportunities']);
  for (const name of Object.keys(observerToolRegistry())) {
    assert.doesNotMatch(name, /wallet|sign|execute|simulate|propose|audit/,
      'no observe-phase tool reaches a wallet / action capability');
  }
});

test('dispatchObserver (scripted LLM): drives the observe stage end-to-end via the deterministic detector', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput();
    const dispatch = await dispatchObserver(input, {
      spawn,
      finbotRoot,
      llm: makeScriptedObserverLlm(input),
    });

    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('observe_opportunities'),
      'observer called the deterministic detector');
    assert.equal(dispatch.observed, true);
    assert.ok(dispatch.observation, 'an observation was extracted');
    assert.equal(dispatch.reportedCrossings.length, 1);
    assert.equal(dispatch.reportedCrossings[0].asset, 'ATOM');
    assert.equal(dispatch.reportedCrossings[0].direction, 'down');
    assert.match(dispatch.finalText, /1 crossing/);
    assert.match(dispatch.finalText, /ATOM down/);
  });
});

test('dispatchObserver: the inference-driven crossings reproduce the headless observation', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput();
    const headless = observeOpportunities({ readings: input.readings }, { thresholdBps: input.thresholdBps });
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.deepEqual(dispatch.observation, headless,
      'the inference path and the headless path agree on the full observation');
  });
});

test('dispatchObserver: a faithful dispatch reconciles against the deterministic recompute', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput();
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.reconciled, true,
      'the extracted observation matches the recompute over the trusted window');
    assert.deepEqual(dispatch.observation, dispatch.canonical);
  });
});

// A subagent that calls `observe_opportunities` with a DIFFERENT threshold than
// the trusted dispatch input — the live-path failure mode the scripted double
// can never surface. The extracted crossings then diverge from the recompute,
// so `reconciled` must be false and the bin refuses to drive the loop on them.
function makeDivergentObserverLlm(input, tamperedThresholdBps) {
  return async function divergentObserverLlm(args) {
    if (args.turn === 0 && args.tools && args.tools.observe_opportunities) {
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Detecting crossings (with a tampered threshold).' },
          {
            type: 'toolCall',
            id: 'divergent',
            name: 'observe_opportunities',
            arguments: { readings: input.readings || [], thresholdBps: tamperedThresholdBps },
          },
        ],
        stopReason: 'tool_use',
        timestamp: 0,
      };
    }
    return { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', timestamp: 0 };
  };
}

test('dispatchObserver: non-canonical tool arguments fail reconciliation', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput(50); // trusted: 1 crossing (ATOM down ~150bps)
    // The subagent instead passes 300bps, which detects zero crossings.
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeDivergentObserverLlm(input, 300),
    });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('observe_opportunities'),
      'the tool was still called — the loose "was it called" gate would pass');
    assert.equal(dispatch.observed, true, 'a (divergent) observation was extracted');
    assert.equal(dispatch.reportedCrossings.length, 0, 'the tampered threshold surfaced zero crossings');
    assert.equal(dispatch.canonical.crossings.length, 1, 'the trusted recompute surfaces one');
    assert.equal(dispatch.reconciled, false,
      'divergent crossings do not reconcile with the recompute — the loop must refuse them');
  });
});

// A subagent that calls `observe_opportunities` with arbitrary caller-supplied
// tool arguments — the general form of {@link makeDivergentObserverLlm}, standing
// in for any live-path hallucination (a tampered window, threshold, or asset
// allowlist) the faithful scripted double never produces.
function makeTamperedObserverLlm(toolArguments) {
  return async function tamperedObserverLlm(args) {
    if (args.turn === 0 && args.tools && args.tools.observe_opportunities) {
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Detecting crossings (with tampered arguments).' },
          { type: 'toolCall', id: 'tampered', name: 'observe_opportunities', arguments: toolArguments },
        ],
        stopReason: 'tool_use',
        timestamp: 0,
      };
    }
    return { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', timestamp: 0 };
  };
}

test('dispatchObserver: a tampered readings window fails reconciliation', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput(50); // trusted: 1 crossing over the full 3-tick window
    // The subagent narrows the window to just the reference tick — no move, zero
    // crossings — diverging from the recompute over the trusted window.
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeTamperedObserverLlm({ readings: input.readings.slice(0, 1), thresholdBps: 50 }),
    });
    assert.equal(dispatch.reportedCrossings.length, 0, 'the tampered single-tick window surfaced zero crossings');
    assert.equal(dispatch.canonical.crossings.length, 1, 'the trusted recompute over the full window surfaces one');
    assert.equal(dispatch.reconciled, false,
      'a hallucinated readings window does not reconcile — the loop must refuse it');
  });
});

test('dispatchObserver: a below-trusted threshold (extra crossings) fails reconciliation', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput(50); // trusted: 1 crossing (ATOM ~150bps; flat OSMO at 0bps is below 50)
    // 0bps is BELOW the trusted 50bps, so the flat OSMO also crosses — a SUPERSET
    // of the trusted crossings. Reconciliation must reject extra crossings too,
    // not only missing ones.
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeTamperedObserverLlm({ readings: input.readings, thresholdBps: 0 }),
    });
    assert.equal(dispatch.reportedCrossings.length, 2, 'the below-trusted threshold surfaced an extra crossing');
    assert.equal(dispatch.canonical.crossings.length, 1, 'the trusted recompute surfaces one');
    assert.equal(dispatch.reconciled, false, 'reconciliation rejects a superset, not only a subset');
  });
});

test('dispatchObserver: a tampered asset allowlist fails reconciliation', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput(0); // trusted: 2 crossings (ATOM + flat OSMO at threshold 0, no allowlist)
    // The subagent restricts detection to OSMO only, dropping the ATOM crossing
    // the trusted (unrestricted) recompute surfaces.
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeTamperedObserverLlm({ readings: input.readings, thresholdBps: 0, assets: ['OSMO'] }),
    });
    assert.equal(dispatch.reportedCrossings.length, 1, 'the tampered allowlist restricted detection to OSMO');
    assert.equal(dispatch.canonical.crossings.length, 2, 'the trusted recompute over all assets surfaces both');
    assert.equal(dispatch.reconciled, false,
      'a hallucinated asset allowlist does not reconcile — the loop must refuse it');
  });
});

test('dispatchObserver: a faithful dispatch honoring an asset allowlist reconciles', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // Exercises the `assets` plumbing end-to-end: observerBrief embeds it,
    // makeScriptedObserverLlm forwards it to the tool, and the canonical recompute
    // honors it — so a restricted-but-faithful observation still reconciles.
    const input = { ...observeInput(0), assets: ['ATOM'] };
    const headless = observeOpportunities({ readings: input.readings }, { thresholdBps: 0, assets: ['ATOM'] });
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.reconciled, true, 'the allowlist is forwarded to both the tool and the recompute');
    assert.deepEqual(dispatch.observation, headless);
    assert.equal(dispatch.reportedCrossings.length, 1, 'only ATOM is in the allowlist');
    assert.equal(dispatch.reportedCrossings[0].asset, 'ATOM');
  });
});

test('dispatchObserver: an empty asset allowlist restricts to no assets and reconciles', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // `[]` is a truthy-but-empty allowlist meaning "restrict to no assets"; it
    // must detect nothing on BOTH the dispatch and the recompute (never silently
    // mean "all"), so the two still agree and reconcile.
    const input = { ...observeInput(0), assets: [] };
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.reportedCrossings.length, 0, 'an empty allowlist restricts to no assets');
    assert.equal(dispatch.reconciled, true, 'both the tool and the recompute honor the empty allowlist');
  });
});

test('dispatchObserver: an absent threshold reconciles against the tool default', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // No `thresholdBps` at all (distinct from an explicit `0`): the scripted
    // double OMITS the arg so the tool applies its own default (50), and the
    // canonical recompute passes `thresholdBps: undefined` (same default). The
    // absent-vs-explicit-zero corner — the null false-branch of both
    // makeScriptedObserverLlm and the canonical recompute — must still reconcile,
    // and agree with the headless call carrying no threshold option. Reddens if
    // the tool's default and the recompute's default ever drift apart.
    const input = { readings: observeInput().readings };
    const headless = observeOpportunities({ readings: input.readings }, {});
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.reconciled, true,
      'the absent-threshold dispatch reconciles with the default-threshold recompute');
    assert.deepEqual(dispatch.observation, headless);
    assert.deepEqual(dispatch.observation, dispatch.canonical);
    assert.equal(dispatch.reportedCrossings.length, 1, 'ATOM crosses the default 50bps; flat OSMO does not');
  });
});

test('dispatchObserver: honors a zero threshold rather than defaulting it', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // thresholdBps: 0 is a real threshold (every move crosses), not "absent"
    // (which would default to 50). OSMO is flat (0bps) and still crosses at 0.
    const input = observeInput(0);
    const headless = observeOpportunities({ readings: input.readings }, { thresholdBps: 0 });
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.reconciled, true);
    assert.deepEqual(dispatch.observation, headless);
    assert.equal(dispatch.reportedCrossings.length, 2, 'ATOM and the flat OSMO both cross at threshold 0');
  });
});

test('dispatchObserver: JSON-lossy prices (NaN/Infinity) collapse identically and still reconcile', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // Pins the reconciliation comment's load-bearing claim that JSON-lossy price
    // values (NaN/Infinity -> null) collapse identically on BOTH the round-tripped
    // observation and the in-process recompute at stringify time — so the strict
    // JSON.stringify compare still reconciles. ATOM moves ~150bps (crosses at 50);
    // the NaN/Infinity assets never cross (Math.abs(NaN) >= threshold is false).
    const input = {
      readings: [
        { t: 0, prices: { ATOM: 10, OSMO: NaN, TIA: Infinity } },
        { t: 1, prices: { ATOM: 9.85, OSMO: NaN, TIA: Infinity } },
      ],
      thresholdBps: 50,
    };
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.reconciled, true,
      'NaN/Infinity prices collapse to null identically on both operands, so the compare still reconciles');
    assert.equal(dispatch.reportedCrossings.length, 1, 'only ATOM crosses; the NaN/Infinity assets never do');
    assert.equal(dispatch.reportedCrossings[0].asset, 'ATOM');
  });
});

test('dispatchObserver: a -0 price collapses to 0 identically and still reconciles', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // Pins the second load-bearing member of the reconciliation comment's
    // JSON-lossy list (`-0 -> 0`), the sibling of the NaN/Infinity case above. A
    // `-0` price flows into the observation's price book (`{ ...last.prices }`)
    // but never crosses (`ref <= 0` skips it), so `JSON.stringify` collapses `-0`
    // to `"0"` identically on both the round-tripped observation and the
    // in-process recompute — the strict compare must still reconcile. ATOM moves
    // ~150bps (crosses at 50); the -0-priced TIA never crosses.
    const input = {
      readings: [
        { t: 0, prices: { ATOM: 10, TIA: -0 } },
        { t: 1, prices: { ATOM: 9.85, TIA: -0 } },
      ],
      thresholdBps: 50,
    };
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.reconciled, true,
      'a -0 price collapses to 0 identically on both operands, so the compare still reconciles');
    assert.equal(dispatch.reportedCrossings.length, 1, 'only ATOM crosses; the -0-priced TIA never does');
    assert.equal(dispatch.reportedCrossings[0].asset, 'ATOM');
  });
});

for (const [label, readings] of [['empty', []], ['singleton', [{ t: 0, prices: { ATOM: 10 } }]]]) {
  test(`dispatchObserver: a ${label} reading window yields zero crossings and reconciles`, async () => {
    await withFinbotRoot(async (finbotRoot) => {
      const input = { readings, thresholdBps: 50 };
      const dispatch = await dispatchObserver(input, {
        spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
      });
      assert.equal(dispatch.status, 'completed');
      assert.equal(dispatch.reportedCrossings.length, 0);
      assert.equal(dispatch.reconciled, true);
    });
  });
}

test('dispatchObserver: a quiet window surfaces zero crossings through the same tool', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // A 300bps threshold is above the ~150bps ATOM move, so nothing crosses.
    const input = observeInput(300);
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('observe_opportunities'));
    assert.equal(dispatch.observed, true);
    assert.equal(dispatch.reportedCrossings.length, 0);
    assert.match(dispatch.finalText, /0 crossing/);
  });
});

test('dispatchObserver (harness stub LLM): still completes and calls a deterministic tool offline', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const dispatch = await dispatchObserver(observeInput(), { spawn, finbotRoot });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.length > 0, 'a deterministic tool was invoked');
  });
});

test('lastObservationResult: returns null when no observe_opportunities call is present', () => {
  assert.equal(lastObservationResult([]), null);
  // Load-bearing for the tool-NAME filter: the foreign tool's result carries a
  // real json block, so returning null proves the `name !== 'observe_opportunities'`
  // guard rejected it — drop that guard and this value would surface instead.
  assert.equal(
    lastObservationResult([{
      type: 'tool_execution_end',
      toolCall: { name: 'score_opportunities' },
      result: { content: [{ type: 'json', value: { crossings: [{ asset: 'ATOM' }] } }] },
    }]),
    null,
  );
});

test('lastObservationResult: skips an errored or json-less observe_opportunities result', () => {
  // The `isError` skip branch: a matching-name but errored tool result is ignored
  // (dropping the guard would surface its json value).
  assert.equal(
    lastObservationResult([{
      type: 'tool_execution_end',
      toolCall: { name: 'observe_opportunities' },
      result: { isError: true, content: [{ type: 'json', value: { crossings: [{ asset: 'ATOM' }] } }] },
    }]),
    null,
  );
  // The matching-name-but-no-json-block fall-through: a successful result whose
  // content carries no json block yields null (surfaces downstream as observed:false).
  assert.equal(
    lastObservationResult([{
      type: 'tool_execution_end',
      toolCall: { name: 'observe_opportunities' },
      result: { content: [{ type: 'text', text: 'no json here' }] },
    }]),
    null,
  );
});

test('dispatchObserver: requires the harness spawn function', async () => {
  await assert.rejects(() => dispatchObserver(observeInput(), {}), /deps\.spawn/);
});

// `guardedObservation` is the load-bearing consumer-side safety step the bin
// (`bin/finbot-dispatch`) relies on but that the dispatch-return tests above do
// not exercise: it must REFUSE a non-reconciling dispatch, and on success feed
// the TRUSTED `canonical` recompute — never the boundary-crossed observation —
// downstream. Pinning it here means a regression that stopped acting on
// `reconciled` (or fed `observation`/`reportedCrossings` instead of `canonical`)
// reddens the suite rather than silently re-narrowing the trust boundary.
test('guardedObservation: refuses a non-reconciling dispatch and hands nothing downstream', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput(50); // trusted: 1 crossing; the subagent passes 300bps -> 0
    const divergent = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeDivergentObserverLlm(input, 300),
    });
    assert.equal(divergent.reconciled, false, 'precondition: the dispatch did not reconcile');
    const guard = guardedObservation(divergent);
    assert.equal(guard.ok, false, 'a divergent observe dispatch is refused');
    assert.match(guard.reason, /SAFETY/);
    assert.equal(guard.observation, undefined, 'no observation is handed downstream on refusal');
  });
});

test('guardedObservation: feeds the TRUSTED canonical recompute, never the surfaced observation', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput(50);
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    const guard = guardedObservation(dispatch);
    assert.equal(guard.ok, true);
    // Reference identity, not deep-equality: the value fed downstream is
    // `canonical` itself. `observation` is a distinct (boundary-crossed) object
    // even when reconciled, so a regression to `dispatch.observation` would
    // redden the notEqual below.
    assert.equal(guard.observation, dispatch.canonical, 'the fed value is the canonical recompute');
    assert.notEqual(guard.observation, dispatch.observation, 'it is NOT the boundary-crossed observation');
  });
});

test('guardedObservation: refuses a stage that never called the detector', () => {
  const guard = guardedObservation({ status: 'completed', toolCalls: [], reconciled: true, canonical: {} });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /never called/);
});

test('guardedObservation: refuses a called-but-unusable observation with an accurate reason', () => {
  // The detector was called but surfaced no usable observation (an errored/json-less
  // tool result); `reconciled` is false for a DIFFERENT reason than a divergence, so
  // the refusal must name that precondition rather than reporting "crossings diverge".
  const guard = guardedObservation({
    status: 'completed', toolCalls: ['observe_opportunities'], observed: false, reconciled: false, canonical: {},
  });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /no usable observation/);
  assert.doesNotMatch(guard.reason, /diverge/, 'does not misdescribe a no-observation case as a divergence');
});

test('guardedObservation: refuses an incomplete dispatch', () => {
  const guard = guardedObservation({ status: 'error', toolCalls: ['observe_opportunities'], reconciled: true, canonical: {} });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /did not complete/);
});
