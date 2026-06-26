import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '@finbot/simulator/world';
import {
  project,
  projectionId,
  projectionArtifact,
  writeForecastArtifacts,
} from '../forecaster.js';

function world(seed) {
  return makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0.001 }, seed },
    seed,
  });
}

/** A minimal in-memory fs capturing writes. */
function fakeFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    mkdirSync(dir) { dirs.add(dir); },
    writeFileSync(path, contents) { files.set(path, contents); },
  };
}

const cfg = { ensembleSize: 50, horizon: 10, baseSeed: 100, bins: 8 };
const input = { world: world(7), targetWeights: { ATOM: 0.3 }, bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 } };

test('project: now carries quantile bands, path stats, and an SVG projection', () => {
  const p = project(input, cfg);
  assert.ok(Array.isArray(p.quantileBands) && p.quantileBands.length > 0);
  assert.ok(p.pathStats && 'recoveryRate' in p.pathStats);
  assert.ok(typeof p.projectionSvg === 'string' && p.projectionSvg.startsWith('<svg'));
});

test('writeForecastArtifacts: writes histogram_path + projection_path with a stable id', () => {
  const p = project(input, cfg);
  const fs = fakeFs();
  const out = writeForecastArtifacts(p, { dir: '/forecasts/2026/06/26', fs });
  assert.ok(out.histogram_path.endsWith(`${out.id}.json`));
  assert.ok(out.projection_path.endsWith(`${out.id}.svg`));
  assert.ok(fs.files.has(out.histogram_path), 'json written');
  assert.ok(fs.files.has(out.projection_path), 'svg written');
  assert.ok(fs.dirs.has('/forecasts/2026/06/26'), 'directory created');
  // The JSON parses and excludes the (derived) SVG.
  const parsed = JSON.parse(fs.files.get(out.histogram_path));
  assert.equal(parsed.ensembleSize, 50);
  assert.ok(!('projectionSvg' in parsed));
  // The SVG file is the rendered projection.
  assert.ok(fs.files.get(out.projection_path).startsWith('<svg'));
});

test('projectionId: deterministic across identical forecasts (auditor recompute)', () => {
  const a = project(input, cfg);
  const b = project({ world: world(7), targetWeights: { ATOM: 0.3 }, bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 } }, cfg);
  assert.equal(projectionId(a), projectionId(b));
  assert.deepEqual(projectionArtifact(a), projectionArtifact(b));
});

test('writeForecastArtifacts: different forecasts land on different ids', () => {
  const a = project(input, cfg);
  const b = project(input, { ...cfg, baseSeed: 200 });
  assert.notEqual(projectionId(a), projectionId(b));
});

test('writeForecastArtifacts: refuses a projection with no SVG', () => {
  const p = project(input, { ...cfg, render: false });
  assert.equal(p.projectionSvg, undefined);
  assert.throws(() => writeForecastArtifacts(p, { dir: '/x', fs: fakeFs() }), /no projectionSvg/);
});
