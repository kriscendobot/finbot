/**
 * Historical price-history ingestion.
 *
 * The instruments and the rebalancer are driven by a `series` (a price path)
 * or by `frames` (a per-tick multi-asset price book). Those can be synthetic
 * (the fixtures), or *real*: a user supplies a CSV of observed prices and we
 * ingest it. This module is the loader for that real input, complementing
 * `price-feed.js`'s `parseCsvFrames` (multi-asset) with single-asset series
 * parsing, validation, and a thin file loader.
 *
 * Parsing is pure over a string; only `loadPriceSeries` / `loadPriceFrames`
 * touch the filesystem (read-only, via `node:fs`). A parsed real series can
 * then drive an instrument directly, or seed a `blockBootstrapSeries`
 * ensemble for the risk/reward sweep (per the parent job's
 * historical-or-speculated input requirement).
 */

import { readFileSync } from 'node:fs';
import { parseCsvFrames } from './price-feed.js';

/**
 * Validate a price series: at least two finite, positive points (positivity
 * is required so log-returns and ratios downstream are well-defined).
 *
 * @param {number[]} series
 * @param {object} [opts]
 * @param {boolean} [opts.allowZero]   permit zero prices (default false)
 * @returns {true}
 */
export function validateSeries(series, opts = {}) {
  if (!Array.isArray(series) || series.length < 2) {
    throw new Error('validateSeries: need at least two price points');
  }
  for (let i = 0; i < series.length; i += 1) {
    const p = series[i];
    if (!Number.isFinite(p)) throw new Error(`validateSeries: non-finite price at index ${i}`);
    if (p < 0 || (p === 0 && !opts.allowZero)) {
      throw new Error(`validateSeries: non-positive price ${p} at index ${i}`);
    }
  }
  return true;
}

/**
 * Parse a CSV body into a single-asset price series.
 *
 * Accepts three shapes:
 *   - one price per line, no header:        100\n101\n102
 *   - a `t,price` (or `date,price`) table:  t,price\n0,100\n1,101  (last column used)
 *   - a wide table with a named column:     t,BTC,ETH\n0,...   (pass `{column:'ETH'}`)
 *
 * Blank lines and lines beginning with `#` are ignored.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.column]   column name to extract (requires a header)
 * @returns {{series: number[], meta: {rows: number, column: string|null, hadHeader: boolean}}}
 */
export function parsePriceSeriesCsv(text, opts = {}) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length < 1) throw new Error('parsePriceSeriesCsv: empty input');

  const firstCells = lines[0].split(',').map((s) => s.trim());
  const hadHeader = firstCells.some((c) => Number.isNaN(Number(c)));
  const header = hadHeader ? firstCells : null;
  const dataLines = hadHeader ? lines.slice(1) : lines;
  if (dataLines.length < 1) throw new Error('parsePriceSeriesCsv: header but no data rows');

  let column = opts.column != null ? opts.column : null;
  let colIdx;
  if (header) {
    if (column != null) {
      colIdx = header.indexOf(column);
      if (colIdx < 0) {
        throw new Error(`parsePriceSeriesCsv: column "${column}" not in header [${header.join(', ')}]`);
      }
    } else {
      colIdx = header.findIndex((h) => h.toLowerCase() !== 't' && h.toLowerCase() !== 'date');
      if (colIdx < 0) colIdx = header.length - 1;
      column = header[colIdx];
    }
  } else {
    // No header: a single column is the price; a wider row is `t,...,price`.
    colIdx = firstCells.length >= 2 ? firstCells.length - 1 : 0;
  }

  const series = [];
  for (let i = 0; i < dataLines.length; i += 1) {
    const cells = dataLines[i].split(',').map((s) => s.trim());
    const v = Number(cells[colIdx]);
    if (!Number.isFinite(v)) {
      throw new Error(`parsePriceSeriesCsv: non-finite value at data row ${i + 1}, column ${colIdx + 1}`);
    }
    series.push(v);
  }
  validateSeries(series);
  return { series, meta: { rows: series.length, column: column || null, hadHeader } };
}

/**
 * Extract a single asset's price series from multi-asset frames (e.g. the
 * output of `parseCsvFrames`).
 *
 * @param {Array<Record<string, number>>} frames
 * @param {string} asset
 * @returns {number[]}
 */
export function seriesFromFrames(frames, asset) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('seriesFromFrames: frames must be a non-empty array');
  }
  return frames.map((f, i) => {
    const v = f[asset];
    if (v == null) throw new Error(`seriesFromFrames: asset "${asset}" missing in frame ${i}`);
    return v;
  });
}

/**
 * Read a CSV file and parse it into a single-asset price series.
 *
 * @param {string} path
 * @param {object} [opts]   forwarded to `parsePriceSeriesCsv`
 * @returns {{series: number[], meta: object}}
 */
export function loadPriceSeries(path, opts = {}) {
  return parsePriceSeriesCsv(readFileSync(path, 'utf8'), opts);
}

/**
 * Read a CSV file and parse it into multi-asset frames for a ReplayPriceFeed.
 *
 * @param {string} path
 * @returns {Array<Record<string, number>>}
 */
export function loadPriceFrames(path) {
  return parseCsvFrames(readFileSync(path, 'utf8'));
}

export { parseCsvFrames };
