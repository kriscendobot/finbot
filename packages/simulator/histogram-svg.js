/**
 * Deterministic SVG histogram-projection renderer.
 *
 * Turns a forecast result (terminal-value histogram + quantile bands +
 * path-statistic distributions) into a compelling, text-diffable SVG the
 * maintainer can read at a glance. Pure string assembly: no DOM, no
 * external dependency, no Date, no Math.random. Same forecast result +
 * same style → byte-identical SVG, which is the determinism contract the
 * auditor relies on when it recomputes a cited projection.
 *
 * Layout (`report` style): two stacked panels —
 *   1. Terminal-equity histogram with the p05–p95 band shaded, the
 *      p25–p75 band darker, and the p50 line marked.
 *   2. Max-drawdown distribution histogram.
 * Plus a header citing the program, horizon, ensemble size, and seed.
 *
 * `compact` style renders panel 1 only.
 */

/**
 * Fixed-precision number format (locale-independent, deterministic).
 *
 * @param {number} x
 * @param {number} [dp]
 * @returns {string}
 */
function fmt(x, dp = 2) {
  if (!Number.isFinite(x)) return '0';
  // Normalize -0 to 0 and round to fixed decimals for stable bytes.
  const r = Number(x.toFixed(dp));
  return (Object.is(r, -0) ? 0 : r).toFixed(dp);
}

/**
 * Escape text for inclusion in SVG markup.
 *
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Draw one histogram panel: bars over [binEdges], with optional quantile
 * overlays. Returns an SVG fragment positioned at (ox, oy).
 *
 * @param {object} args
 * @returns {string}
 */
function panel({
  ox, oy, w, h, title, histogram, quantiles = null, barFill = '#444', subtitle = '',
}) {
  const { binEdges, counts } = histogram;
  const parts = [];
  parts.push(`<g transform="translate(${fmt(ox)},${fmt(oy)})">`);
  parts.push(`<text x="0" y="-8" font-family="monospace" font-size="13" fill="#111">${esc(title)}</text>`);
  if (subtitle) {
    parts.push(`<text x="${fmt(w)}" y="-8" text-anchor="end" font-family="monospace" font-size="10" fill="#666">${esc(subtitle)}</text>`);
  }
  // Plot frame.
  parts.push(`<rect x="0" y="0" width="${fmt(w)}" height="${fmt(h)}" fill="#fafafa" stroke="#ccc" stroke-width="1"/>`);

  if (!counts || counts.length === 0 || binEdges.length < 2) {
    parts.push(`<text x="${fmt(w / 2)}" y="${fmt(h / 2)}" text-anchor="middle" font-family="monospace" font-size="11" fill="#999">no data</text>`);
    parts.push('</g>');
    return parts.join('\n');
  }

  const lo = binEdges[0];
  const hi = binEdges[binEdges.length - 1];
  const span = hi - lo || 1;
  const maxCount = Math.max(...counts, 1);
  const xOf = (val) => ((val - lo) / span) * w;
  const nBins = counts.length;
  const barW = w / nBins;

  // Quantile band shading (drawn under the bars).
  if (quantiles) {
    const { p05, p25, p50, p75, p95 } = quantiles;
    if (p05 != null && p95 != null) {
      parts.push(`<rect x="${fmt(xOf(p05))}" y="0" width="${fmt(xOf(p95) - xOf(p05))}" height="${fmt(h)}" fill="#3b82f6" opacity="0.12"/>`);
    }
    if (p25 != null && p75 != null) {
      parts.push(`<rect x="${fmt(xOf(p25))}" y="0" width="${fmt(xOf(p75) - xOf(p25))}" height="${fmt(h)}" fill="#3b82f6" opacity="0.20"/>`);
    }
  }

  // Bars.
  for (let i = 0; i < nBins; i += 1) {
    const bh = (counts[i] / maxCount) * (h - 4);
    const x = i * barW;
    const y = h - bh;
    parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(Math.max(0, barW - 1))}" height="${fmt(bh)}" fill="${barFill}"/>`);
  }

  // p50 line.
  if (quantiles && quantiles.p50 != null) {
    const x = xOf(quantiles.p50);
    parts.push(`<line x1="${fmt(x)}" y1="0" x2="${fmt(x)}" y2="${fmt(h)}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,2"/>`);
    parts.push(`<text x="${fmt(x + 3)}" y="12" font-family="monospace" font-size="9" fill="#ef4444">p50 ${esc(fmt(quantiles.p50))}</text>`);
  }

  // Axis labels (min / max).
  parts.push(`<text x="0" y="${fmt(h + 12)}" font-family="monospace" font-size="9" fill="#666">${esc(fmt(lo))}</text>`);
  parts.push(`<text x="${fmt(w)}" y="${fmt(h + 12)}" text-anchor="end" font-family="monospace" font-size="9" fill="#666">${esc(fmt(hi))}</text>`);
  parts.push('</g>');
  return parts.join('\n');
}

/**
 * Render a forecast result as an SVG projection.
 *
 * @param {object} result          a forecast() result: { summary, histogram, pathStats? }
 * @param {object} [opts]
 * @param {string} [opts.style]    'report' (default) | 'compact'
 * @param {string} [opts.program]  program label for the header
 * @param {number} [opts.seed]     seed to cite (default result.summary.baseSeed)
 * @returns {string}               SVG document text
 */
export function renderHistogramSvg(result, opts = {}) {
  const style = opts.style || 'report';
  const summary = result.summary || {};
  const program = opts.program || 'forecast';
  const seed = opts.seed != null ? opts.seed : (summary.baseSeed != null ? summary.baseSeed : 0);
  const horizon = summary.horizon != null ? summary.horizon : 0;
  const ensembleSize = summary.ensembleSize != null ? summary.ensembleSize : 0;

  const quantiles = {
    p05: summary.p05, p25: summary.p25, p50: summary.p50, p75: summary.p75, p95: summary.p95,
  };

  const width = 640;
  const margin = 24;
  const headerH = 56;
  const panelW = width - margin * 2;
  const panel1H = 180;
  const compact = style === 'compact';
  const drawdownHist = result.pathStats && result.pathStats.maxDrawdownPct
    ? result.pathStats.maxDrawdownPct.histogram
    : null;
  const panel2H = compact || !drawdownHist ? 0 : 150;
  const gap = panel2H ? 48 : 0;
  const height = headerH + panel1H + gap + panel2H + margin;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fmt(height)}" viewBox="0 0 ${width} ${fmt(height)}" font-family="monospace">`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${fmt(height)}" fill="#ffffff"/>`);

  // Header.
  parts.push(`<text x="${margin}" y="24" font-family="monospace" font-size="16" fill="#111">Ensemble forecast — ${esc(program)}</text>`);
  const cite = `horizon=${horizon}  N=${ensembleSize}  seed=${seed}  mean=${fmt(summary.meanEquity)}  P(profit)=${fmt(summary.pProfit, 3)}`;
  parts.push(`<text x="${margin}" y="44" font-family="monospace" font-size="11" fill="#555">${esc(cite)}</text>`);

  // Panel 1: terminal equity histogram.
  parts.push(panel({
    ox: margin,
    oy: headerH + 8,
    w: panelW,
    h: panel1H,
    title: 'Terminal equity distribution',
    subtitle: 'p05–p95 shaded · p25–p75 darker · p50 dashed',
    histogram: result.histogram,
    quantiles,
    barFill: '#475569',
  }));

  // Panel 2: max-drawdown distribution.
  if (panel2H) {
    parts.push(panel({
      ox: margin,
      oy: headerH + 8 + panel1H + gap,
      w: panelW,
      h: panel2H,
      title: 'Max-drawdown distribution (fraction of peak)',
      subtitle: `recovery rate ${fmt(result.pathStats.recoveryRate, 3)}`,
      histogram: drawdownHist,
      quantiles: null,
      barFill: '#b45309',
    }));
  }

  parts.push('</svg>');
  return parts.join('\n') + '\n';
}
