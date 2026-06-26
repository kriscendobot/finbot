/**
 * Named, parameterized synthetic-oracle fixture presets.
 *
 * Each preset names a generating process and a known parameter set. The
 * presets are the rows of the forecast-evaluation table: feeding each into
 * the ensemble forecaster and scoring against fresh realizations of the
 * same process tells us where the forecaster is well-calibrated and where
 * it is not.
 *
 * A preset is `{ name, kind, params }`. `generate(preset, overrides?)`
 * builds the series; `seedVariant(preset, seed)` reseeds it for held-out
 * realizations (the evaluation needs many independent draws of the same
 * process). All presets share a default `length` so horizons line up.
 */

import { cyclicSeries, gbmSeries, synthesisSeries } from '../../fixtures.js';

const GENERATORS = {
  cyclic: cyclicSeries,
  gbm: gbmSeries,
  synthesis: synthesisSeries,
};

/** @type {Array<{name: string, kind: string, params: object}>} */
export const PRESETS = [
  // --- Cyclic: vary frequency and amplitude. ---
  {
    name: 'cyclic-calm',
    kind: 'cyclic',
    params: { initialPrice: 100, frequency: 1 / 64, amplitude: 0.05, length: 256, seed: 11 },
  },
  {
    name: 'cyclic-wild',
    kind: 'cyclic',
    params: { initialPrice: 100, frequency: 1 / 24, amplitude: 0.2, length: 256, seed: 12 },
  },
  {
    name: 'cyclic-drifting',
    kind: 'cyclic',
    params: { initialPrice: 100, frequency: 1 / 48, amplitude: 0.1, drift: 0.001, length: 256, seed: 13 },
  },

  // --- GBM: vary drift mu and volatility sigma. ---
  {
    name: 'gbm-flat-lowvol',
    kind: 'gbm',
    params: { initialPrice: 100, mu: 0, sigma: 0.01, length: 256, seed: 21 },
  },
  {
    name: 'gbm-bull',
    kind: 'gbm',
    params: { initialPrice: 100, mu: 0.002, sigma: 0.02, length: 256, seed: 22 },
  },
  {
    name: 'gbm-bear-volatile',
    kind: 'gbm',
    params: { initialPrice: 100, mu: -0.0015, sigma: 0.05, length: 256, seed: 23 },
  },

  // --- Synthesis: superposed cycles of varying freq+amplitude over a GBM trend. ---
  {
    name: 'synthesis-gentle',
    kind: 'synthesis',
    params: {
      initialPrice: 100,
      gbm: { mu: 0.0005, sigma: 0.012 },
      cycles: [
        { frequency: 1 / 80, amplitude: 0.07 },
        { frequency: 1 / 20, amplitude: 0.025 },
      ],
      length: 256,
      seed: 31,
    },
  },
  {
    name: 'synthesis-turbulent',
    kind: 'synthesis',
    params: {
      initialPrice: 100,
      gbm: { mu: 0, sigma: 0.035 },
      cycles: [
        { frequency: 1 / 50, amplitude: 0.12 },
        { frequency: 1 / 12, amplitude: 0.05 },
        { frequency: 1 / 5, amplitude: 0.02 },
      ],
      length: 256,
      seed: 32,
    },
  },
];

/**
 * Generate a preset's series.
 *
 * @param {{kind: string, params: object}} preset
 * @param {object} [overrides]          merged over the preset params
 * @returns {{ series: number[], meta: object }}
 */
export function generate(preset, overrides = {}) {
  const gen = GENERATORS[preset.kind];
  if (!gen) throw new Error(`presets.generate: unknown kind ${preset.kind}`);
  return gen({ ...preset.params, ...overrides });
}

/**
 * Generate an independent realization of the same process by reseeding.
 * Used to draw the held-out outcomes the forecast is scored against.
 *
 * @param {{kind: string, params: object}} preset
 * @param {number} seed
 * @returns {{ series: number[], meta: object }}
 */
export function seedVariant(preset, seed) {
  return generate(preset, { seed });
}

/**
 * Look up a preset by name.
 *
 * @param {string} name
 * @returns {{name: string, kind: string, params: object}}
 */
export function presetByName(name) {
  const p = PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`presets: no preset named ${name}`);
  return p;
}
