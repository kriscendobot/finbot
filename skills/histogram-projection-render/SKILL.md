---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: histogram-projection-render

Render a forecaster's histogram + path-statistic distributions as a compelling visual projection. Outputs SVG by default (vector, text-diffable, embeddable in markdown) with a PNG fallback. Deterministic given the same input.

## Purpose

Turn a JSON histogram artifact (from `skills/monte-carlo-ensemble`) into a visual the maintainer can absorb at a glance: the terminal-value histogram with quantile bands, the fan-chart of trajectories over time, the max-drawdown distribution.

## Inputs

- **Histogram JSON.** The artifact path emitted by `monte-carlo-ensemble`.
- **Render style.** One of `report` (full multi-panel layout for a journal digest), `compact` (single-panel for an inbox message body), `comparison` (overlay two histograms for before / after comparison).
- **Output format.** `svg` (default) or `png`.

## Output

A file written next to the JSON artifact (same `<short-id>` prefix, different extension). Returned to the caller as the path.

## Procedure

```pseudo
1. Read the JSON histogram.
2. Choose a layout (single panel, multi panel grid) by render style.
3. For each panel:
   a. Compute axis ranges from the histogram bin edges and the quantile band.
   b. Draw the histogram bars (or a smoothed density curve at high N).
   c. Overlay the quantile band (p05 - p95 shaded, p25 - p75 darker, p50 line).
   d. Annotate with the program name, the horizon, the ensemble size, and the seed.
4. Emit SVG (or rasterize to PNG via a deterministic rasterizer).
```

## Determinism contract

Same JSON input + same render style + same output format -> byte-identical output. The renderer cannot call any system-time-dependent source; the seed for any visual stochasticity (e.g. jittered scatter points) is derived from the histogram's `input_distributions_hash`.

## Visual choices

- **Color.** A monochrome palette by default (the bot does not assume the maintainer's display preferences). Two-color overlays for comparison style.
- **Axis units.** Minor-unit absolute on the y-axis; percent-of-NAV on a secondary y-axis where applicable. Time on the x-axis for fan charts; bin value on the x-axis for histograms.
- **Annotations.** Always cite the input artifact's path so the maintainer can re-render or re-run with different parameters.

## Notes

This is a stub. The renderer can be implemented in plain JavaScript with a deterministic SVG-builder library (no DOM dependency), or in Python with matplotlib in a deterministic mode (seed and backend pinned). The choice is for the first dispatched forecaster engagement to make; the contract above is what the planner and journalist consume.
