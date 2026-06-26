import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHistogramSvg } from '../histogram-svg.js';
import { forecast } from '../forecast.js';
import { makeWorld } from '../world.js';

function sampleResult() {
  const world = makeWorld({
    portfolio: { cash: 500, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.1 }, seed: 1 },
  });
  return forecast({ from: world, horizon: 10, ensembleSize: 40, baseSeed: 100, bins: 8 });
}

test('renderHistogramSvg: produces a well-formed SVG document', () => {
  const svg = renderHistogramSvg(sampleResult(), { program: 'demo' });
  assert.ok(svg.startsWith('<svg'), 'starts with an svg tag');
  assert.ok(svg.trimEnd().endsWith('</svg>'), 'ends with a closing svg tag');
  assert.ok(svg.includes('Ensemble forecast'), 'has a header');
  assert.ok(svg.includes('demo'), 'cites the program');
  assert.ok(svg.includes('Terminal equity distribution'), 'has the equity panel');
});

test('renderHistogramSvg: byte-deterministic given the same result', () => {
  const r = sampleResult();
  const a = renderHistogramSvg(r, { program: 'demo' });
  const b = renderHistogramSvg(r, { program: 'demo' });
  assert.equal(a, b);
});

test('renderHistogramSvg: same forecast inputs -> identical SVG (end-to-end determinism)', () => {
  const a = renderHistogramSvg(sampleResult(), { program: 'demo' });
  const b = renderHistogramSvg(sampleResult(), { program: 'demo' });
  assert.equal(a, b, 'a re-run of the same forecast renders byte-identically');
});

test('renderHistogramSvg: compact style omits the drawdown panel', () => {
  const r = sampleResult();
  const report = renderHistogramSvg(r, { program: 'demo', style: 'report' });
  const compact = renderHistogramSvg(r, { program: 'demo', style: 'compact' });
  assert.ok(report.includes('Max-drawdown distribution'));
  assert.ok(!compact.includes('Max-drawdown distribution'));
});

test('renderHistogramSvg: escapes markup in the program label', () => {
  const svg = renderHistogramSvg(sampleResult(), { program: 'a<b>&c' });
  assert.ok(svg.includes('a&lt;b&gt;&amp;c'));
  assert.ok(!svg.includes('a<b>&c'));
});
