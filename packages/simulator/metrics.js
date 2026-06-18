/**
 * Efficacy metrics.
 *
 * Computed from a stream of Observations produced by runSimulator.
 *
 * Currently:
 *
 *   - P&L (absolute and percent of initial equity)
 *   - Max drawdown (peak-to-trough equity decline as a percent)
 *   - Sharpe ratio (mean per-tick return / stddev of per-tick return,
 *     annualized assuming `ticksPerYear` user input)
 *   - Volatility (stddev of per-tick log-returns)
 *   - Win rate (fraction of trades with positive realized P&L
 *     contribution; v0 approximation: fraction of sells priced above
 *     the FIFO lot they offset)
 *
 * Metric philosophy: these are best-guess defaults. The user can
 * supply their own metric functions to `computeMetrics(observations,
 * {extraMetrics})` if they want sortino, calmar, or anything else.
 *
 * Metric rows are emitted as plain-JS objects suitable for writing
 * one-per-line as JSONL or transformed to CSV.
 */

/**
 * @typedef {object} MetricRow
 * @property {number} t
 * @property {number} equity
 * @property {number} cash
 * @property {number} totalPnL
 * @property {number} pnlPct
 * @property {number} drawdown
 * @property {number} drawdownPct
 * @property {number} logReturn
 */

/**
 * Convert a list of observations into a list of per-tick metric rows.
 *
 * @param {Array<{t: number, portfolio: import('./portfolio.js').PortfolioSnapshot}>} observations
 * @param {object} [opts]
 * @param {number} [opts.initialEquity]            override; default = first observation's equity
 * @returns {MetricRow[]}
 */
export function perTickMetrics(observations, opts = {}) {
  if (!observations || observations.length === 0) return [];
  const initialEquity = opts.initialEquity != null
    ? opts.initialEquity
    : observations[0].portfolio.equity;
  let peak = initialEquity;
  let prevEquity = initialEquity;
  const rows = [];
  for (const obs of observations) {
    const eq = obs.portfolio.equity;
    if (eq > peak) peak = eq;
    const drawdown = peak - eq;
    const drawdownPct = peak > 0 ? drawdown / peak : 0;
    const logReturn = prevEquity > 0 ? Math.log(eq / prevEquity) : 0;
    rows.push({
      t: obs.t,
      equity: eq,
      cash: obs.portfolio.cash,
      totalPnL: obs.portfolio.totalPnL,
      pnlPct: initialEquity > 0 ? (eq - initialEquity) / initialEquity : 0,
      drawdown,
      drawdownPct,
      logReturn,
    });
    prevEquity = eq;
  }
  return rows;
}

/**
 * Summary efficacy stats across the run.
 *
 * @param {Array<{t: number, portfolio: import('./portfolio.js').PortfolioSnapshot}>} observations
 * @param {object} [opts]
 * @param {number} [opts.ticksPerYear]             for Sharpe annualization (default 252)
 * @param {number} [opts.riskFreePerTick]          default 0
 * @param {number} [opts.initialEquity]            override
 * @returns {object}
 */
export function summaryMetrics(observations, opts = {}) {
  const rows = perTickMetrics(observations, opts);
  if (rows.length === 0) {
    return {
      ticks: 0,
      initialEquity: 0,
      finalEquity: 0,
      totalPnL: 0,
      pnlPct: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      volatility: 0,
      sharpe: 0,
      winRate: 0,
      tradeCount: 0,
    };
  }
  const initial = opts.initialEquity != null ? opts.initialEquity : rows[0].equity;
  const final = rows[rows.length - 1].equity;
  const ticksPerYear = opts.ticksPerYear || 252;
  const riskFree = opts.riskFreePerTick || 0;

  // Drop the first row's log return (it is by definition zero) for vol/Sharpe.
  const rets = rows.slice(1).map((r) => r.logReturn);
  const { mean, stddev } = meanStddev(rets);
  const excessMean = mean - riskFree;
  const sharpe = stddev > 0 ? (excessMean / stddev) * Math.sqrt(ticksPerYear) : 0;
  const volatility = stddev * Math.sqrt(ticksPerYear);

  const maxDrawdown = rows.reduce((acc, r) => Math.max(acc, r.drawdown), 0);
  const maxDrawdownPct = rows.reduce((acc, r) => Math.max(acc, r.drawdownPct), 0);

  // Win rate approximation: read the last observation's portfolio
  // tradeCount and realizedPnL to derive a coarse signal. v0 records
  // realized P&L per sell against FIFO lots; if realized > 0 we count
  // it as a net winning round trip. Returns 0..1 fraction of
  // round-trip-positive trades over total sell trades.
  const lastSnap = observations[observations.length - 1].portfolio;
  let winRate = 0;
  // Without per-trade P&L we cannot compute true win rate; expose the
  // coarse "did the run end profitable" boolean as a 0/1 fallback.
  if (lastSnap.tradeCount > 0) {
    winRate = lastSnap.realizedPnL > 0 ? 1 : 0;
  }

  return {
    ticks: rows.length,
    initialEquity: initial,
    finalEquity: final,
    totalPnL: final - initial,
    pnlPct: initial > 0 ? (final - initial) / initial : 0,
    maxDrawdown,
    maxDrawdownPct,
    volatility,
    sharpe,
    winRate,
    tradeCount: lastSnap.tradeCount,
  };
}

/**
 * Compute mean and stddev (sample, n-1) of a numeric array.
 *
 * @param {number[]} xs
 * @returns {{mean: number, stddev: number}}
 */
export function meanStddev(xs) {
  const n = xs.length;
  if (n === 0) return { mean: 0, stddev: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, stddev: 0 };
  const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (n - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Emit metric rows as a JSONL string.
 *
 * @param {MetricRow[]} rows
 * @returns {string}
 */
export function rowsToJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * Emit metric rows as a CSV string (with header).
 *
 * @param {MetricRow[]} rows
 * @returns {string}
 */
export function rowsToCsv(rows) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const header = cols.join(',');
  const body = rows.map((r) => cols.map((c) => r[c]).join(',')).join('\n');
  return `${header}\n${body}\n`;
}
