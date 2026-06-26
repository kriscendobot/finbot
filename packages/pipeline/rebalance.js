/**
 * ymax-shaped rebalance primitives.
 *
 * Mirrors the shape of Agoric's `@agoric/portfolio-api`
 * `computeTargetBalances` helper and `portfolio-contract/tools/plan-solve.ts`
 * (see `designs/ymax-integration.md` § Research findings). We do not import
 * the Agoric package — finbot borrows the *protocol* (target balances ->
 * funds-flow steps), not the *implementation*. Where internal ymax detail
 * (e.g. cross-chain place identifiers, Axelar GMP routing) would refine a
 * step, the code flags it rather than fabricating it.
 *
 * All functions here are pure over their inputs (the one mutating helper,
 * `applyStepsToPortfolio`, mutates the Portfolio it is handed and nothing
 * else), so the forecaster's projected action and the planner's emitted
 * steps are derived from the *same* helper and are therefore consistent.
 */

/**
 * Net asset value of a portfolio snapshot at a price book. Cash (the quote
 * currency) is worth 1; every other balance is marked at its price.
 *
 * @param {{ cash: number, balances: Record<string, number> }} snapshot
 * @param {Record<string, number>} prices
 * @returns {number}
 */
export function navOf(snapshot, prices) {
  let nav = snapshot.cash;
  for (const [asset, qty] of Object.entries(snapshot.balances || {})) {
    const p = prices[asset];
    if (p != null) nav += qty * p;
  }
  return nav;
}

/**
 * The target value (in quote currency) of each named asset, given a target
 * weight map and the current NAV. This is `computeTargetBalances`'s shape:
 * weight_i * NAV. Weights are interpreted as fractions of NAV held in the
 * risk asset; the residual is cash.
 *
 * @param {number} nav
 * @param {Record<string, number>} targetWeights  asset -> fraction of NAV
 * @returns {Record<string, number>}               asset -> target quote value
 */
export function computeTargetBalances(nav, targetWeights) {
  /** @type {Record<string, number>} */
  const target = {};
  for (const [asset, w] of Object.entries(targetWeights)) {
    target[asset] = w * nav;
  }
  return target;
}

/**
 * Derive an ordered list of funds-flow steps that move the portfolio toward
 * its target allocation, bounded by the risk parameters.
 *
 * Each step moves quote value between the cash account and one risk asset.
 * A buy step sources from cash (the quote currency) into the asset; a sell
 * step sources from the asset back to cash. The per-step notional is clamped
 * to `maxStepPct * NAV`; the cumulative notional across the plan is clamped
 * to `maxDayPct * NAV`; and no step is allowed to push an asset's resulting
 * weight above `concentrationCapPct`.
 *
 * @param {{ cash: number, balances: Record<string, number>, quoteCurrency?: string }} snapshot
 * @param {Record<string, number>} prices
 * @param {Record<string, number>} targetWeights
 * @param {object} [bounds]
 * @param {number} [bounds.maxStepPct]            per-step max move, fraction of NAV (default 0.25)
 * @param {number} [bounds.maxDayPct]             cumulative cap, fraction of NAV (default 0.50)
 * @param {number} [bounds.concentrationCapPct]   per-asset post-move weight cap (default 0.80)
 * @param {number} [bounds.minStepNotional]       skip dust steps below this (default 1)
 * @param {number} [bounds.gasPerStep]            flat estimated gas per step, quote units (default 0)
 * @returns {{ steps: Array<object>, clamped: boolean, projectedBalances: Record<string, number>, projectedCash: number }}
 */
export function deriveSteps(snapshot, prices, targetWeights, bounds = {}) {
  const quote = snapshot.quoteCurrency || 'USDC';
  const maxStepPct = bounds.maxStepPct != null ? bounds.maxStepPct : 0.25;
  const maxDayPct = bounds.maxDayPct != null ? bounds.maxDayPct : 0.50;
  const concentrationCapPct = bounds.concentrationCapPct != null ? bounds.concentrationCapPct : 0.80;
  const minStepNotional = bounds.minStepNotional != null ? bounds.minStepNotional : 1;
  const gasPerStep = bounds.gasPerStep || 0;

  const nav = navOf(snapshot, prices);
  const target = computeTargetBalances(nav, targetWeights);

  const maxStep = maxStepPct * nav;
  const maxDay = maxDayPct * nav;

  let cumulative = 0;
  let clamped = false;
  const steps = [];

  // Work on a mutable projection of balances/cash so concentration and
  // cumulative checks see the running state.
  const balances = { ...snapshot.balances };
  let cash = snapshot.cash;

  // Deterministic asset order so the proposal hash is stable.
  for (const asset of Object.keys(targetWeights).sort()) {
    const price = prices[asset];
    if (price == null || price <= 0) continue;
    const currentValue = (balances[asset] || 0) * price;
    let delta = target[asset] - currentValue; // >0 buy, <0 sell

    if (Math.abs(delta) < minStepNotional) continue;

    // Per-step clamp.
    if (Math.abs(delta) > maxStep) {
      delta = Math.sign(delta) * maxStep;
      clamped = true;
    }
    // Cumulative (per-day) clamp.
    if (cumulative + Math.abs(delta) > maxDay) {
      const room = Math.max(0, maxDay - cumulative);
      if (room < minStepNotional) { clamped = true; continue; }
      delta = Math.sign(delta) * room;
      clamped = true;
    }

    const side = delta > 0 ? 'buy' : 'sell';
    let notional = Math.abs(delta);

    if (side === 'buy') {
      // Cannot spend more cash than we hold.
      if (notional > cash) { notional = cash; clamped = true; }
      if (notional < minStepNotional) continue;
      const qty = notional / price;
      // Concentration check on the resulting weight.
      const resultingValue = (balances[asset] || 0) * price + notional;
      if (resultingValue > concentrationCapPct * nav + 1e-9) {
        const allowed = concentrationCapPct * nav - (balances[asset] || 0) * price;
        if (allowed < minStepNotional) { clamped = true; continue; }
        notional = allowed;
        clamped = true;
      }
      const finalQty = notional / price;
      cash -= notional;
      balances[asset] = (balances[asset] || 0) + finalQty;
      steps.push(makeStep({ source: quote, dest: asset, side, asset, qty: finalQty, price, notional, gas: gasPerStep }));
      cumulative += notional;
    } else {
      const have = balances[asset] || 0;
      let qty = notional / price;
      if (qty > have) { qty = have; notional = qty * price; clamped = true; }
      if (notional < minStepNotional) continue;
      cash += notional;
      balances[asset] = have - qty;
      steps.push(makeStep({ source: asset, dest: quote, side, asset, qty, price, notional, gas: gasPerStep }));
      cumulative += notional;
    }
  }

  return { steps, clamped, projectedBalances: balances, projectedCash: cash };
}

function makeStep({ source, dest, side, asset, qty, price, notional, gas }) {
  return {
    source,
    dest,
    side,
    asset,
    qty,
    price,
    notional,
    estGas: gas,
    // Where internal ymax detail would refine the step: on a real Agoric
    // portfolio this carries the place identifier (Aave/Compound/USDN via
    // Axelar GMP) and a pending-tx handle. The simulator has a single
    // in-memory venue, so the route is implicit. Flagged, not fabricated.
    route: 'sim:single-venue',
  };
}

/**
 * Apply an ordered list of steps to a Portfolio instance (mutates it).
 * Used by the executor's dry-run (on a *clone*) and by the forecaster's
 * projected action (on a forked world). Skips a step that the portfolio
 * rejects (e.g. insufficient cash after price drift) and returns the
 * applied / skipped split so the caller can report partial fills.
 *
 * @param {import('@finbot/simulator/portfolio').Portfolio} portfolio
 * @param {Record<string, number>} prices
 * @param {Array<object>} steps
 * @param {number} t  tick index recorded on each trade
 * @returns {{ applied: Array<object>, skipped: Array<object> }}
 */
export function applyStepsToPortfolio(portfolio, prices, steps, t) {
  const applied = [];
  const skipped = [];
  for (const step of steps) {
    const price = prices[step.asset] != null ? prices[step.asset] : step.price;
    try {
      portfolio.applyTrade({ t, side: step.side, asset: step.asset, qty: step.qty, price });
      applied.push({ ...step, executedPrice: price });
    } catch (err) {
      skipped.push({ ...step, reason: String(err.message || err) });
    }
  }
  return { applied, skipped };
}
