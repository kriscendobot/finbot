/**
 * Path-dependent statistics for a single equity trajectory.
 *
 * The terminal-value histogram is path-independent: it sees only where a
 * trajectory ends. But two programs with the same terminal distribution
 * can have very different lived experiences — one slides 40% underwater
 * and claws back, the other glides up monotonically. The planner bounds
 * risk against *that* experience, so the forecaster reports two
 * path-dependent distributions across the ensemble:
 *
 *   - Max drawdown: the deepest peak-to-trough equity decline along the
 *     path, as a fraction of the running peak.
 *   - Time to recovery: how many ticks the trajectory spent below the
 *     pre-drawdown peak before reclaiming it (null when it never
 *     reclaims the peak within the horizon — an "underwater at horizon"
 *     path).
 *
 * Pure arithmetic over an equity array; no RNG, deterministic.
 */

/**
 * @typedef {object} PathStat
 * @property {number} maxDrawdownAbs       deepest peak-to-trough drop (absolute)
 * @property {number} maxDrawdownPct       deepest drop as a fraction of the running peak
 * @property {number} peakIndex            index of the peak preceding the worst trough
 * @property {number} troughIndex          index of the worst trough
 * @property {number | null} timeToRecovery  ticks from worst trough back to the peak level, or null
 * @property {boolean} recovered           whether the peak level was reclaimed within the path
 */

/**
 * Compute path statistics from an equity series.
 *
 * @param {number[]} equity      per-tick equity, in chronological order
 * @returns {PathStat}
 */
export function pathStatsOf(equity) {
  if (!Array.isArray(equity) || equity.length === 0) {
    return {
      maxDrawdownAbs: 0,
      maxDrawdownPct: 0,
      peakIndex: 0,
      troughIndex: 0,
      timeToRecovery: 0,
      recovered: true,
    };
  }
  let peak = equity[0];
  let peakIndex = 0;
  let worstDropPct = 0;
  let worstDropAbs = 0;
  let worstPeakIndex = 0;
  let worstTroughIndex = 0;
  let worstPeakLevel = equity[0];
  for (let i = 0; i < equity.length; i += 1) {
    const e = equity[i];
    if (e > peak) {
      peak = e;
      peakIndex = i;
    }
    const dropAbs = peak - e;
    const dropPct = peak > 0 ? dropAbs / peak : 0;
    if (dropPct > worstDropPct) {
      worstDropPct = dropPct;
      worstDropAbs = dropAbs;
      worstPeakIndex = peakIndex;
      worstTroughIndex = i;
      worstPeakLevel = peak;
    }
  }
  // Time to recovery: first index after the worst trough at which equity
  // reclaims the pre-drawdown peak level.
  let timeToRecovery = null;
  let recovered = false;
  if (worstDropPct === 0) {
    // Monotone-non-decreasing path: never underwater.
    timeToRecovery = 0;
    recovered = true;
  } else {
    for (let i = worstTroughIndex + 1; i < equity.length; i += 1) {
      if (equity[i] >= worstPeakLevel) {
        timeToRecovery = i - worstTroughIndex;
        recovered = true;
        break;
      }
    }
  }
  return {
    maxDrawdownAbs: worstDropAbs,
    maxDrawdownPct: worstDropPct,
    peakIndex: worstPeakIndex,
    troughIndex: worstTroughIndex,
    timeToRecovery,
    recovered,
  };
}
