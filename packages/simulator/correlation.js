/**
 * Correlation tooling for multi-asset walks.
 *
 * A correlated multi-asset GBM draws a vector of standard-normal shocks
 * per tick whose covariance matches an asset-by-asset correlation
 * matrix. The standard construction: factor the correlation matrix R
 * into L * Lᵀ (the Cholesky factorization, L lower-triangular), draw a
 * vector z of independent standard normals, and take y = L · z. Then
 * Cov(y) = L · Lᵀ = R, so the components of y carry the requested
 * correlation while each marginal stays unit-variance standard normal.
 *
 * Everything here is pure arithmetic over plain arrays — no RNG, no
 * mutation of inputs — so the determinism contract is preserved: the
 * shocks' randomness comes entirely from the seeded sfc32 stream that
 * supplies z.
 */

/**
 * Cholesky factorization of a symmetric positive-definite matrix.
 *
 * Returns the lower-triangular L such that L · Lᵀ = matrix. Throws if
 * the matrix is not positive-definite (a non-positive pivot appears),
 * which for a correlation matrix means the requested correlations are
 * mutually inconsistent.
 *
 * @param {number[][]} matrix      n×n symmetric matrix
 * @returns {number[][]}           n×n lower-triangular L
 */
export function cholesky(matrix) {
  const n = matrix.length;
  for (const row of matrix) {
    if (row.length !== n) throw new Error('cholesky: matrix must be square');
  }
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k += 1) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) {
          throw new Error(
            `cholesky: matrix is not positive-definite (non-positive pivot ${sum} at index ${i}); `
            + 'the requested correlations are mutually inconsistent',
          );
        }
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

/**
 * Multiply a lower-triangular matrix L by a vector z (y = L · z).
 *
 * @param {number[][]} L           n×n lower-triangular
 * @param {number[]} z             length-n vector
 * @returns {number[]}             length-n vector y
 */
export function applyCholesky(L, z) {
  const n = L.length;
  if (z.length !== n) throw new Error('applyCholesky: dimension mismatch');
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let j = 0; j <= i; j += 1) sum += L[i][j] * z[j];
    y[i] = sum;
  }
  return y;
}

/**
 * Build a symmetric correlation matrix over a fixed asset order from a
 * sparse pair specification.
 *
 * The pair spec is `{ "ASSET_A:ASSET_B": rho, ... }` or a nested map
 * `{ ASSET_A: { ASSET_B: rho } }`. Unspecified off-diagonal entries
 * default to 0; the diagonal is always 1. Specifying a pair in either
 * order is honored (the matrix is symmetrized).
 *
 * @param {string[]} assetOrder
 * @param {Record<string, number> | Record<string, Record<string, number>>} [pairs]
 * @returns {number[][]}
 */
export function correlationMatrixFromPairs(assetOrder, pairs = {}) {
  const n = assetOrder.length;
  const idx = new Map(assetOrder.map((a, i) => [a, i]));
  const R = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
  const set = (a, b, rho) => {
    const i = idx.get(a);
    const j = idx.get(b);
    if (i == null || j == null) {
      throw new Error(`correlationMatrixFromPairs: unknown asset in pair ${a}:${b}`);
    }
    if (i === j) return;
    R[i][j] = rho;
    R[j][i] = rho;
  };
  for (const [key, val] of Object.entries(pairs)) {
    if (val != null && typeof val === 'object') {
      for (const [b, rho] of Object.entries(val)) set(key, b, rho);
    } else {
      const [a, b] = key.split(':');
      if (!a || !b) throw new Error(`correlationMatrixFromPairs: pair key "${key}" must be "ASSET_A:ASSET_B"`);
      set(a, b, val);
    }
  }
  return R;
}

/**
 * Normalize a correlation spec (full matrix or pair spec) into a
 * lower-triangular Cholesky factor over a fixed asset order. Returns
 * null when the spec is empty / identity (the caller then takes the
 * independent-walk fast path, preserving byte-for-byte the prior
 * uncorrelated behavior).
 *
 * @param {string[]} assetOrder
 * @param {number[][] | Record<string, any> | undefined} spec
 * @returns {number[][] | null}
 */
export function choleskyFactorFor(assetOrder, spec) {
  if (spec == null) return null;
  let R;
  if (Array.isArray(spec)) {
    R = spec;
  } else if (typeof spec === 'object' && Object.keys(spec).length > 0) {
    R = correlationMatrixFromPairs(assetOrder, spec);
  } else {
    return null;
  }
  // An identity matrix factors to identity; skip it so the draw pattern
  // stays identical to the independent walk.
  let isIdentity = true;
  for (let i = 0; i < R.length && isIdentity; i += 1) {
    for (let j = 0; j < R.length; j += 1) {
      const expected = i === j ? 1 : 0;
      if (Math.abs(R[i][j] - expected) > 1e-12) { isIdentity = false; break; }
    }
  }
  if (isIdentity) return null;
  return cholesky(R);
}
