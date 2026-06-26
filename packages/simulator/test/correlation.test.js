import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cholesky,
  applyCholesky,
  correlationMatrixFromPairs,
  choleskyFactorFor,
} from '../correlation.js';

test('cholesky: factors identity to identity', () => {
  const L = cholesky([[1, 0], [0, 1]]);
  assert.deepEqual(L, [[1, 0], [0, 1]]);
});

test('cholesky: L * Lt reconstructs the matrix', () => {
  const R = [[1, 0.6, 0.3], [0.6, 1, 0.5], [0.3, 0.5, 1]];
  const L = cholesky(R);
  const n = R.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let sum = 0;
      for (let k = 0; k < n; k += 1) sum += L[i][k] * L[j][k];
      assert.ok(Math.abs(sum - R[i][j]) < 1e-12, `entry ${i},${j}`);
    }
  }
});

test('cholesky: rejects a non-positive-definite matrix', () => {
  // Correlation 1.5 is impossible; the matrix is not positive-definite.
  assert.throws(() => cholesky([[1, 1.5], [1.5, 1]]), /positive-definite/);
});

test('applyCholesky: y = L * z carries the requested covariance', () => {
  const R = [[1, 0.8], [0.8, 1]];
  const L = cholesky(R);
  const y = applyCholesky(L, [1, 1]);
  assert.equal(y.length, 2);
  // y0 = L00*z0 = 1; y1 = L10*z0 + L11*z1 = 0.8 + sqrt(1-0.64) = 0.8 + 0.6 = 1.4
  assert.ok(Math.abs(y[0] - 1) < 1e-12);
  assert.ok(Math.abs(y[1] - 1.4) < 1e-12);
});

test('correlationMatrixFromPairs: builds a symmetric matrix with unit diagonal', () => {
  const R = correlationMatrixFromPairs(['A', 'B', 'C'], { 'A:B': 0.5, 'B:C': -0.2 });
  assert.deepEqual(R, [
    [1, 0.5, 0],
    [0.5, 1, -0.2],
    [0, -0.2, 1],
  ]);
});

test('correlationMatrixFromPairs: accepts nested-map spec', () => {
  const R = correlationMatrixFromPairs(['A', 'B'], { A: { B: 0.4 } });
  assert.deepEqual(R, [[1, 0.4], [0.4, 1]]);
});

test('choleskyFactorFor: identity / empty spec returns null (independent fast path)', () => {
  assert.equal(choleskyFactorFor(['A', 'B'], null), null);
  assert.equal(choleskyFactorFor(['A', 'B'], {}), null);
  assert.equal(choleskyFactorFor(['A', 'B'], [[1, 0], [0, 1]]), null);
});

test('choleskyFactorFor: a real correlation spec returns a factor', () => {
  const L = choleskyFactorFor(['A', 'B'], { 'A:B': 0.5 });
  assert.ok(Array.isArray(L) && L.length === 2);
});

test('correlationMatrixFromPairs: throws on an unknown asset', () => {
  assert.throws(() => correlationMatrixFromPairs(['A'], { 'A:Z': 0.5 }), /unknown asset/);
});
