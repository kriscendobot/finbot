/**
 * Instrument types — different return shapes over the same price oracle.
 *
 * An instrument wraps an underlying price series (a synthetic fixture, or a
 * user-supplied / user-speculated historical series; see `history.js`) and a
 * payout policy that determines its *total return shape*:
 *
 *   - growth     — capital appreciation only; value tracks the underlying,
 *                  no cash flows (but transaction fees and capital-gains tax
 *                  still bite).
 *   - yield      — interest accrued on the position's market value, at a rate
 *                  that may be constant, a yield curve (array), a stochastic
 *                  short-rate (function), or DeFi utilization-driven; simple
 *                  or compounding; paid into cash or reinvested (DRIP).
 *   - dividend   — discrete payouts that may grow or be cut, follow an
 *                  irregular schedule, or be driven by a payout ratio over an
 *                  earnings series; with an optional ex-dividend price
 *                  adjustment wired through the oracle.
 *
 * Every instrument also carries optional `fees` (per-payout and per-reinvest
 * frictions) and `tax` (income tax on payouts, capital-gains tax on the
 * realized terminal gain), so a return is reported gross *and* net.
 *
 * The walk is stateful (DRIP grows the held quantity; ex-dividend marks the
 * price down) but pure over its inputs: it never mutates the instrument or
 * its series, and never calls Math.random — any stochastic rate threads a
 * seeded rng through a closure. Two walks over identical inputs are identical.
 *
 * Total value = position value (marked) + accumulated cash. Under a flat
 * price, growth returns 0 while yield and dividend return their accumulated
 * cash, so the three shapes stay cleanly distinguishable.
 */

/**
 * @typedef {object} FeeModel
 * @property {number} [payoutBps]     fee on each gross payout, basis points
 * @property {number} [reinvestBps]   fee on each DRIP reinvestment, basis points
 * @property {number} [gasPerPayout]  flat quote-currency charge per payout
 */

/**
 * @typedef {object} TaxModel
 * @property {number} [income]         tax rate on payouts (yield/dividend income)
 * @property {number} [capGains]       tax rate on realized capital gains
 * @property {boolean} [realizeAtEnd]  realize the terminal unrealized gain (default true when capGains set)
 */

/**
 * @typedef {object} Instrument
 * @property {string} type            'growth' | 'yield' | 'dividend'
 * @property {string} asset
 * @property {number[]} series         underlying price series (length+1 entries)
 * @property {object} policy           payout parameters (+ optional fees/tax)
 */

/**
 * Growth instrument: capital appreciation only.
 *
 * @param {object} cfg
 * @param {string} [cfg.asset]
 * @param {number[]} cfg.series
 * @param {FeeModel} [cfg.fees]
 * @param {TaxModel} [cfg.tax]
 * @returns {Instrument}
 */
export function growthInstrument(cfg) {
  return {
    type: 'growth',
    asset: cfg.asset || 'ASSET',
    series: cfg.series,
    policy: { fees: cfg.fees, tax: cfg.tax },
  };
}

/**
 * Yield-bearing instrument: accrue interest on the position's market value
 * into cash (or back into the position via DRIP) every `accrualPeriod` ticks.
 *
 * The per-accrual-period rate is one of:
 *   - a number                       constant rate
 *   - a number[]                     a rate curve / short-rate path, sampled
 *                                    by tick (held flat past its end)
 *   - a function (t, ctx) => rate    a stochastic short-rate process; thread
 *                                    a seeded rng through the closure
 *   - utilization-driven             pass `utilization` (number | array |
 *                                    function) plus `apyFromUtilization`
 *                                    (e.g. from `kinkedUtilizationApy`)
 *
 * @param {object} cfg
 * @param {string} [cfg.asset]
 * @param {number[]} cfg.series
 * @param {number|number[]|((t:number, ctx:object)=>number)} [cfg.yieldRate]  default 0.001
 * @param {number} [cfg.accrualPeriod]    ticks between accruals, default 1
 * @param {boolean} [cfg.compounding]     accrue on (position + accrued cash); default false (simple)
 * @param {'cash'|'position'} [cfg.reinvest]  pay into cash, or DRIP into the position; default 'cash'
 * @param {number|number[]|((t:number, ctx:object)=>number)} [cfg.utilization]
 * @param {(util:number, ctx:object)=>number} [cfg.apyFromUtilization]
 * @param {FeeModel} [cfg.fees]
 * @param {TaxModel} [cfg.tax]
 * @returns {Instrument}
 */
export function yieldInstrument(cfg) {
  return {
    type: 'yield',
    asset: cfg.asset || 'ASSET',
    series: cfg.series,
    policy: {
      yieldRate: cfg.yieldRate != null ? cfg.yieldRate : 0.001,
      accrualPeriod: cfg.accrualPeriod != null ? cfg.accrualPeriod : 1,
      compounding: !!cfg.compounding,
      reinvest: cfg.reinvest || 'cash',
      utilization: cfg.utilization,
      apyFromUtilization: cfg.apyFromUtilization,
      fees: cfg.fees,
      tax: cfg.tax,
    },
  };
}

/**
 * Dividend-paying instrument: discrete payouts into cash (or DRIP) on a
 * schedule. The per-unit dividend is one of:
 *   - a number                          constant per-unit dividend
 *   - a number[]                        a per-payout schedule (growth/cuts),
 *                                       indexed by payout occurrence
 *   - a function (t, ctx) => perUnit    ctx.payoutIndex is the payout count
 *   - `dividendGrowth` g                geometric growth: base * (1+g)^k
 *   - `payoutRatio` + `earningsPerUnit` payout = ratio * earnings (cuts when
 *                                       earnings fall)
 *
 * The schedule is `period` ticks by default, or `payoutTicks` (an explicit
 * list) / `scheduleAt` (a predicate) for irregular payouts.
 *
 * With `exDividendDrop`, the marked price is reduced by the cumulative
 * per-unit dividend at each ex-dividend tick, so total wealth is conserved at
 * the payout instant (the classic ex-div adjustment, wired through the price
 * the position is marked at). See `exDividendAdjustedSeries` to materialize
 * that adjustment onto the oracle series for downstream consumers.
 *
 * @param {object} cfg
 * @param {string} [cfg.asset]
 * @param {number[]} cfg.series
 * @param {number|number[]|((t:number, ctx:object)=>number)} [cfg.dividendPerUnit]  default 1
 * @param {number} [cfg.period]            ticks between payouts, default 30
 * @param {number[]} [cfg.payoutTicks]     explicit irregular schedule
 * @param {(t:number)=>boolean} [cfg.scheduleAt]  schedule predicate
 * @param {number} [cfg.dividendGrowth]    per-payout geometric growth rate
 * @param {number} [cfg.payoutRatio]       fraction of earnings paid out
 * @param {number|number[]|((t:number, ctx:object)=>number)} [cfg.earningsPerUnit]
 * @param {boolean} [cfg.exDividendDrop]   apply the ex-dividend price adjustment, default false
 * @param {'cash'|'position'} [cfg.reinvest]  default 'cash'
 * @param {FeeModel} [cfg.fees]
 * @param {TaxModel} [cfg.tax]
 * @returns {Instrument}
 */
export function dividendInstrument(cfg) {
  return {
    type: 'dividend',
    asset: cfg.asset || 'ASSET',
    series: cfg.series,
    policy: {
      dividendPerUnit: cfg.dividendPerUnit != null ? cfg.dividendPerUnit : 1,
      period: cfg.period != null ? cfg.period : 30,
      payoutTicks: cfg.payoutTicks,
      scheduleAt: cfg.scheduleAt,
      dividendGrowth: cfg.dividendGrowth,
      payoutRatio: cfg.payoutRatio,
      earningsPerUnit: cfg.earningsPerUnit,
      exDividendDrop: !!cfg.exDividendDrop,
      reinvest: cfg.reinvest || 'cash',
      fees: cfg.fees,
      tax: cfg.tax,
    },
  };
}

/**
 * Sample a value that may be a scalar, an array (held flat past its end), or
 * a function of an index and context.
 *
 * @param {number|number[]|((idx:number, ctx:object)=>number)} v
 * @param {number} idx
 * @param {object} ctx
 * @returns {number}
 */
function sampleSeries(v, idx, ctx) {
  if (typeof v === 'function') return v(idx, ctx);
  if (Array.isArray(v)) return v.length ? v[Math.min(idx, v.length - 1)] : 0;
  return v != null ? v : 0;
}

/**
 * Resolve a yield instrument's per-accrual-period rate at tick `t`.
 *
 * @param {object} policy
 * @param {object} ctx     { t, ... }
 * @returns {number}
 */
export function resolveYieldRate(policy, ctx) {
  if (policy.apyFromUtilization) {
    const util = sampleSeries(policy.utilization != null ? policy.utilization : 0, ctx.t, ctx);
    return policy.apyFromUtilization(util, ctx);
  }
  return sampleSeries(policy.yieldRate != null ? policy.yieldRate : 0, ctx.t, ctx);
}

/**
 * Resolve a dividend instrument's per-unit dividend for a payout.
 *
 * @param {object} policy
 * @param {object} ctx     { t, payoutIndex, ... }
 * @returns {number}
 */
export function resolveDividendPerUnit(policy, ctx) {
  if (policy.payoutRatio != null) {
    const eps = sampleSeries(policy.earningsPerUnit != null ? policy.earningsPerUnit : 0, ctx.t, ctx);
    return Math.max(0, policy.payoutRatio * eps);
  }
  if (policy.dividendGrowth != null) {
    const base = policy.dividendPerUnit != null ? policy.dividendPerUnit : 1;
    return base * Math.pow(1 + policy.dividendGrowth, ctx.payoutIndex);
  }
  return sampleSeries(policy.dividendPerUnit != null ? policy.dividendPerUnit : 1, ctx.payoutIndex, ctx);
}

/**
 * Is tick `t` a dividend payout tick under this policy?
 *
 * @param {object} policy
 * @param {number} t
 * @returns {boolean}
 */
export function isPayoutTick(policy, t) {
  if (t <= 0) return false;
  if (typeof policy.scheduleAt === 'function') return !!policy.scheduleAt(t);
  if (Array.isArray(policy.payoutTicks)) return policy.payoutTicks.includes(t);
  const period = policy.period != null ? policy.period : 30;
  return period > 0 && t % period === 0;
}

/**
 * The classic two-slope (kinked) DeFi utilization interest-rate model, as
 * used by Aave/Compound: the rate climbs gently up to an optimal utilization,
 * then steeply past it. Returns a function suitable as `apyFromUtilization`;
 * its output is the per-accrual-period rate (scale the model's parameters to
 * the accrual period you walk).
 *
 * @param {object} [model]
 * @param {number} [model.base]      rate at zero utilization (default 0)
 * @param {number} [model.slope1]    added rate at optimal utilization (default 0.0005)
 * @param {number} [model.slope2]    added rate from optimal to full (default 0.004)
 * @param {number} [model.optimal]   optimal utilization in [0,1] (default 0.8)
 * @returns {(util:number)=>number}
 */
export function kinkedUtilizationApy(model = {}) {
  const base = model.base != null ? model.base : 0;
  const slope1 = model.slope1 != null ? model.slope1 : 0.0005;
  const slope2 = model.slope2 != null ? model.slope2 : 0.004;
  const optimal = model.optimal != null ? model.optimal : 0.8;
  return function rateAt(utilRaw) {
    const util = Math.max(0, Math.min(1, utilRaw));
    if (util <= optimal) {
      return base + slope1 * (optimal > 0 ? util / optimal : 0);
    }
    const over = (util - optimal) / (1 - optimal || 1);
    return base + slope1 + slope2 * over;
  };
}

/**
 * Materialize the ex-dividend price adjustment onto a price series, so a
 * downstream oracle consumer sees the drop directly (rather than relying on
 * the instrument's internal marking). At each payout tick the series is
 * reduced by the cumulative per-unit dividend paid so far.
 *
 * @param {number[]} series
 * @param {object} policy   a dividend policy (period/payoutTicks/scheduleAt + dividend amount)
 * @returns {number[]}      a new, adjusted series (input is not mutated)
 */
export function exDividendAdjustedSeries(series, policy) {
  const out = new Array(series.length);
  let cum = 0;
  let payoutIndex = 0;
  for (let t = 0; t < series.length; t += 1) {
    if (isPayoutTick(policy, t)) {
      const perUnit = resolveDividendPerUnit(policy, { t, payoutIndex });
      cum += perUnit;
      payoutIndex += 1;
    }
    out[t] = Math.max(0, series[t] - cum);
  }
  return out;
}

/**
 * Initialize the per-walk state for an instrument.
 *
 * @param {Instrument} inst
 * @param {object} [opts]
 * @param {number} [opts.qty]   units held, default 1
 * @returns {{qty: number, cumulativeDivPerUnit: number, payoutIndex: number, costBasis: number}}
 */
export function initInstrumentState(inst, opts = {}) {
  const qty = opts.qty != null ? opts.qty : 1;
  return {
    qty,
    cumulativeDivPerUnit: 0,
    payoutIndex: 0,
    costBasis: qty * inst.series[0],
  };
}

/**
 * Advance one instrument one tick. Pure: returns a fresh state and the
 * tick's flows; never mutates `state` or `inst`. The single source of truth
 * for payout, fee, tax, ex-dividend marking, and DRIP behavior — shared by
 * `instrumentReturns` (single leg) and `rebalanceMix` (multi-leg).
 *
 * @param {Instrument} inst
 * @param {object} state    from `initInstrumentState`
 * @param {number} t
 * @param {object} [ctx]
 * @param {number} [ctx.accruedCash]   cash accrued so far (for compounding yield base)
 * @returns {{state: object, markedPrice: number, positionValue: number, grossCashFlow: number, fee: number, incomeTax: number, cashToAccount: number, reinvested: number}}
 */
export function stepInstrument(inst, state, t, ctx = {}) {
  const p = inst.policy || {};
  const fees = p.fees || {};
  const tax = p.tax || {};
  const payoutBps = fees.payoutBps || 0;
  const reinvestBps = fees.reinvestBps || 0;
  const gasPerPayout = fees.gasPerPayout || 0;
  const incomeRate = tax.income || 0;
  const reinvest = p.reinvest || 'cash';
  const price = inst.series[t];

  const next = {
    qty: state.qty,
    cumulativeDivPerUnit: state.cumulativeDivPerUnit,
    payoutIndex: state.payoutIndex,
    costBasis: state.costBasis,
  };

  // Resolve a dividend payout first so the ex-dividend drop applies to *this*
  // tick's marked price (price drops by the dividend at the ex-div instant).
  let gross = 0;
  if (inst.type === 'dividend' && isPayoutTick(p, t)) {
    const perUnit = resolveDividendPerUnit(p, { t, payoutIndex: state.payoutIndex });
    gross = perUnit * state.qty;
    next.payoutIndex = state.payoutIndex + 1;
    if (p.exDividendDrop) next.cumulativeDivPerUnit = state.cumulativeDivPerUnit + perUnit;
  }

  const exDiv = inst.type === 'dividend' && p.exDividendDrop;
  const markedPrice = exDiv ? Math.max(0, price - next.cumulativeDivPerUnit) : price;
  const positionValue = state.qty * markedPrice;

  // Yield accrues on the (post-mark) position value.
  if (inst.type === 'yield' && t > 0) {
    const accrualPeriod = p.accrualPeriod != null ? p.accrualPeriod : 1;
    if (accrualPeriod > 0 && t % accrualPeriod === 0) {
      const rate = resolveYieldRate(p, { t, positionValue, qty: state.qty, price });
      const base = positionValue + (p.compounding ? (ctx.accruedCash || 0) : 0);
      gross = rate * base;
    }
  }

  let fee = 0;
  let incomeTax = 0;
  let cashToAccount = 0;
  let reinvested = 0;
  if (gross > 0) {
    fee += gross * (payoutBps / 10000) + gasPerPayout;
    const afterFee = Math.max(0, gross - fee);
    incomeTax = afterFee * incomeRate;
    const net = afterFee - incomeTax;
    if (reinvest === 'position' && markedPrice > 0) {
      const reinvestFee = net * (reinvestBps / 10000);
      fee += reinvestFee;
      const invest = Math.max(0, net - reinvestFee);
      next.qty = state.qty + invest / markedPrice;
      next.costBasis = state.costBasis + invest;
      reinvested = invest;
    } else {
      cashToAccount = net;
    }
  }

  return {
    state: next,
    markedPrice,
    positionValue: next.qty * markedPrice,
    grossCashFlow: gross,
    fee,
    incomeTax,
    cashToAccount,
    reinvested,
  };
}

/**
 * Walk an instrument over its series and produce its total-return trajectory,
 * gross and net of fees and taxes.
 *
 * @param {Instrument} inst
 * @param {object} [opts]
 * @param {number} [opts.qty]           units held, default 1
 * @param {number} [opts.length]        steps to walk, default series.length-1
 * @returns {object}
 */
export function instrumentReturns(inst, opts = {}) {
  const length = opts.length != null ? opts.length : inst.series.length - 1;
  let state = initInstrumentState(inst, opts);
  const positionValueSeries = [];
  const cashFlowSeries = [];
  const totalValueSeries = [];
  const feeSeries = [];
  const taxSeries = [];
  const qtySeries = [];
  let cumulativeCash = 0;
  let cumulativeFees = 0;
  let incomeTaxPaid = 0;
  for (let t = 0; t <= length; t += 1) {
    const r = stepInstrument(inst, state, t, { accruedCash: cumulativeCash });
    state = r.state;
    cumulativeCash += r.cashToAccount;
    cumulativeFees += r.fee;
    incomeTaxPaid += r.incomeTax;
    positionValueSeries.push(r.positionValue);
    cashFlowSeries.push(r.cashToAccount);
    feeSeries.push(r.fee);
    taxSeries.push(r.incomeTax);
    qtySeries.push(state.qty);
    totalValueSeries.push(r.positionValue + cumulativeCash);
  }

  // Capital-gains tax on the realized terminal gain (income tax on payouts is
  // already deducted tick by tick above).
  const tax = (inst.policy && inst.policy.tax) || {};
  let capGainsTax = 0;
  if (tax.capGains && tax.realizeAtEnd !== false) {
    const terminalPos = positionValueSeries[positionValueSeries.length - 1];
    const gain = terminalPos - state.costBasis;
    if (gain > 0) {
      capGainsTax = gain * tax.capGains;
      totalValueSeries[totalValueSeries.length - 1] -= capGainsTax;
    }
  }

  const v0 = totalValueSeries[0];
  const vN = totalValueSeries[totalValueSeries.length - 1];
  const totalReturn = v0 > 0 ? vN / v0 - 1 : 0;
  // Per-step simple returns of total value, for volatility/risk metrics.
  const returns = [];
  for (let i = 1; i < totalValueSeries.length; i += 1) {
    const a = totalValueSeries[i - 1];
    if (a > 0) returns.push(totalValueSeries[i] / a - 1);
  }
  return {
    type: inst.type,
    positionValueSeries,
    cashFlowSeries,
    qtySeries,
    feeSeries,
    taxSeries,
    cumulativeCash,
    cumulativeFees,
    incomeTaxPaid,
    capGainsTax,
    costBasis: state.costBasis,
    totalValueSeries,
    totalReturn,
    returns,
  };
}

/**
 * Mix several instrument legs into one buy-and-hold portfolio total-value
 * trajectory (no rebalancing; see `rebalanceMix` in `instrument-mix.js` for
 * the target-allocation rebalancer).
 *
 * @param {Array<{instrument: Instrument, qty?: number}>} legs
 * @param {object} [opts]
 * @param {number} [opts.length]
 * @returns {object}                    { totalValueSeries, totalReturn, returns, legs }
 */
export function mixReturns(legs, opts = {}) {
  if (legs.length === 0) throw new Error('mixReturns: need at least one leg');
  const perLeg = legs.map((leg) => instrumentReturns(leg.instrument, { qty: leg.qty, length: opts.length }));
  const len = perLeg[0].totalValueSeries.length;
  const totalValueSeries = new Array(len).fill(0);
  for (const lr of perLeg) {
    for (let i = 0; i < len; i += 1) totalValueSeries[i] += lr.totalValueSeries[i];
  }
  const v0 = totalValueSeries[0];
  const vN = totalValueSeries[len - 1];
  const totalReturn = v0 > 0 ? vN / v0 - 1 : 0;
  const returns = [];
  for (let i = 1; i < len; i += 1) {
    const a = totalValueSeries[i - 1];
    if (a > 0) returns.push(totalValueSeries[i] / a - 1);
  }
  return { totalValueSeries, totalReturn, returns, legs: perLeg };
}

/**
 * Build a (reward, risk) candidate for the risk-reward sweep by walking an
 * instrument over an ensemble of price realizations and collecting each
 * realization's total return. The realizations come from `makeSeries(seed)`
 * — a synthetic fixture generator, or a bootstrap over a user-supplied
 * historical series, so the same instrument can be driven from real or
 * speculated data.
 *
 * @param {object} cfg
 * @param {string} cfg.id                          candidate id (e.g. 'yield')
 * @param {(series: number[]) => Instrument} cfg.makeInstrument  wraps a realization in the instrument
 * @param {(seed: number) => number[]} cfg.makeSeries            realization source
 * @param {number} [cfg.qty]                       default 1
 * @param {number} [cfg.length]
 * @param {number} [cfg.realizationCount]          default 300
 * @param {number} [cfg.seedBase]                  default 500000
 * @returns {{id: string, reward: number, risk: number, downside: number, worstLoss: number, returns: number[]}}
 */
export function instrumentReturnDistribution(cfg) {
  const realizationCount = cfg.realizationCount != null ? cfg.realizationCount : 300;
  const seedBase = cfg.seedBase != null ? cfg.seedBase : 500000;
  const totalReturns = [];
  for (let r = 0; r < realizationCount; r += 1) {
    const series = cfg.makeSeries(seedBase + r);
    const inst = cfg.makeInstrument(series);
    const { totalReturn } = instrumentReturns(inst, { qty: cfg.qty, length: cfg.length });
    totalReturns.push(totalReturn);
  }
  const n = totalReturns.length;
  const reward = totalReturns.reduce((a, b) => a + b, 0) / n;
  const variance = totalReturns.reduce((acc, x) => acc + (x - reward) * (x - reward), 0) / n;
  let downAcc = 0;
  let worstLoss = 0;
  for (const x of totalReturns) {
    if (x < 0) downAcc += x * x;
    if (x < worstLoss) worstLoss = x;
  }
  return {
    id: cfg.id,
    reward,
    risk: Math.sqrt(variance),
    downside: Math.sqrt(downAcc / n),
    worstLoss,
    returns: totalReturns,
  };
}
