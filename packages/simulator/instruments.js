/**
 * Instrument types — different return shapes over the same price oracle.
 *
 * An instrument wraps an underlying price series (a synthetic fixture, or a
 * user-supplied / user-speculated historical series) and a payout policy
 * that determines its *total return shape*:
 *
 *   - growth     — capital appreciation only; value tracks the underlying,
 *                  no cash flows.
 *   - yield      — periodic interest accrued on the position's market value
 *                  into a cash account (yield-bearing).
 *   - dividend   — discrete payouts (`dividendPerUnit * qty`) every `period`
 *                  ticks into cash (dividend-paying).
 *
 * A strategy may mix instruments (`mixReturns`). Cash flows accumulate in a
 * side cash account (not reinvested), so total value = position value +
 * accumulated cash. This keeps the three shapes cleanly distinguishable:
 * under a flat price, growth returns 0 while yield and dividend return
 * their accumulated cash.
 *
 * The underlying series is exogenous (it is the oracle), so payouts are an
 * overlay; we do not mutate the series. An optional `exDividendDrop` records
 * the ex-dividend price adjustment a caller may choose to apply upstream,
 * but the default leaves the oracle untouched.
 */

/**
 * @typedef {object} Instrument
 * @property {string} type           'growth' | 'yield' | 'dividend'
 * @property {string} asset
 * @property {number[]} series        underlying price series (length+1 entries)
 * @property {object} policy          payout parameters
 */

/**
 * Growth instrument: capital appreciation only.
 *
 * @param {object} cfg
 * @param {string} [cfg.asset]
 * @param {number[]} cfg.series
 * @returns {Instrument}
 */
export function growthInstrument(cfg) {
  return { type: 'growth', asset: cfg.asset || 'ASSET', series: cfg.series, policy: {} };
}

/**
 * Yield-bearing instrument: accrue `yieldRate` of the position's market
 * value into cash every `accrualPeriod` ticks.
 *
 * @param {object} cfg
 * @param {string} [cfg.asset]
 * @param {number[]} cfg.series
 * @param {number} cfg.yieldRate          per-accrual-period rate (e.g. 0.001)
 * @param {number} [cfg.accrualPeriod]    ticks between accruals, default 1
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
    },
  };
}

/**
 * Dividend-paying instrument: pay `dividendPerUnit * qty` into cash every
 * `period` ticks.
 *
 * @param {object} cfg
 * @param {string} [cfg.asset]
 * @param {number[]} cfg.series
 * @param {number} cfg.dividendPerUnit    cash per held unit per payout
 * @param {number} [cfg.period]           ticks between payouts, default 30
 * @param {boolean} [cfg.exDividendDrop]  record the ex-div price drop (default false)
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
      exDividendDrop: !!cfg.exDividendDrop,
    },
  };
}

/**
 * The cash flow paid at tick `t` by an instrument holding `qty` units,
 * given the position's market value at `t`.
 *
 * @param {Instrument} inst
 * @param {number} t
 * @param {number} qty
 * @param {number} positionValue        qty * price_t
 * @returns {number}
 */
function cashFlowAt(inst, t, qty, positionValue) {
  if (t === 0) return 0;
  if (inst.type === 'yield') {
    const { yieldRate, accrualPeriod } = inst.policy;
    return t % accrualPeriod === 0 ? yieldRate * positionValue : 0;
  }
  if (inst.type === 'dividend') {
    const { dividendPerUnit, period } = inst.policy;
    return t % period === 0 ? dividendPerUnit * qty : 0;
  }
  return 0;
}

/**
 * Walk an instrument over its series and produce its total-return trajectory.
 *
 * @param {Instrument} inst
 * @param {object} [opts]
 * @param {number} [opts.qty]           units held, default 1
 * @param {number} [opts.length]        steps to walk, default series.length-1
 * @returns {object}                    { positionValueSeries, cashFlowSeries, cumulativeCash, totalValueSeries, totalReturn, returns }
 */
export function instrumentReturns(inst, opts = {}) {
  const qty = opts.qty != null ? opts.qty : 1;
  const length = opts.length != null ? opts.length : inst.series.length - 1;
  const positionValueSeries = [];
  const cashFlowSeries = [];
  const totalValueSeries = [];
  let cumulativeCash = 0;
  for (let t = 0; t <= length; t += 1) {
    const price = inst.series[t];
    const positionValue = qty * price;
    const cf = cashFlowAt(inst, t, qty, positionValue);
    cumulativeCash += cf;
    positionValueSeries.push(positionValue);
    cashFlowSeries.push(cf);
    totalValueSeries.push(positionValue + cumulativeCash);
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
    cumulativeCash,
    totalValueSeries,
    totalReturn,
    returns,
  };
}

/**
 * Mix several instrument legs into one portfolio total-value trajectory.
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
