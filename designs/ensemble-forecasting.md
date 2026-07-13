---
created: 2026-06-17
updated: 2026-06-17
author: architect
status: stub
---

# Design: ensemble forecasting

How the forecaster runs Monte Carlo ensemble simulations and renders histogram projections.

## Problem

The maintainer's directive: "Ensemble Forecasting, automation that we will need to grow that is capable of both executing and producing compelling visual projections through iterative Monte Carlo simulation of the histogram distributions of likely outcomes for particular financial programs on a fixed time horizon."

The forecaster is the orient phase of finbot's OODA loop. Its output (histogram + path statistics) feeds the analyzer (which scores opportunities against the distributions) and the planner (which bounds risk against the tails).

## Shape

A forecaster dispatch takes:

- A *program*: a function from (chain state, time, stochastic inputs) to (chain state, P&L). Programs range from "hold a fixed USDC balance and accrue interest" to "rebalance every block according to this strategy".
- A *time horizon*: a duration over which to simulate.
- An *ensemble size*: N independent trajectories.
- A *seed*: for reproducibility.
- *Input distributions*: parameterized stochastic sources (price feed model, volatility surface, gas cost distribution, slippage distribution).

It produces:

- A *histogram*: terminal value distribution.
- *Path statistics*: max drawdown distribution, time-to-recovery distribution.
- *Quantile summary*: p05 / p25 / p50 / p75 / p95.
- *Bootstrap confidence bands* on the quantile estimates.
- A *visual projection*: SVG / PNG rendered deterministically.

## Determinism contract

Same program + horizon + ensemble + seed + input_distributions_hash -> identical bytes. This matters because the auditor verifies the planner's cited forecast by recomputing the hash; without byte determinism the audit chain breaks.

## Stochastic-process choices

Open. Three obvious axes:

- **Price feed model.** Geometric Brownian Motion (the textbook default), mean-reverting (Ornstein-Uhlenbeck), empirical bootstrap (resample from historical returns). The empirical bootstrap has the advantage of not assuming a distributional family but the disadvantage of being limited by the historical window.
- **Volatility surface.** Constant, time-varying (GARCH-like), implied (from options market data). For instruments where options markets are not deep, this is empirical bootstrap of realized volatility.
- **Correlation handling.** Per-instrument independent simulation is wrong; correlated sampling via a Cholesky factorization of the historical correlation matrix is the standard fix.

The bootstrap state of finbot does not commit to any of these; the first forecaster engagement chooses and the choice goes here as a Notes from the field.

## Rendering choices

Open. Three obvious choices:

- **Plain SVG via a deterministic builder.** No DOM dependency; output is byte-deterministic; embeds in markdown directly. Good for the journalist's digests.
- **Matplotlib in deterministic mode.** Python dependency; well-understood; backend-pinned. Good for rich multi-panel projections.
- **D3 in headless mode.** JavaScript; works with the rest of finbot's stack; renders to SVG.

The choice should be deferred until a concrete visual style is settled; the contract is "deterministic given inputs", the implementation can swap.

## Long-running dispatches

A 10,000-simulation ensemble on a non-trivial program takes minutes. The orchestrator's prompt should set expectations. The forecaster journals a `tick` entry partway through if the run is long (say, every 1000 simulations, with progress percent and elapsed time). The journalist consolidates the ticks into a single narrative entry for the maintainer.

## Open questions

- What is the right N for routine forecasts vs. high-confidence pre-rebalance forecasts? N=10,000 is the default; tail risk at p01 / p99 is noisy there.
- How does the forecaster handle programs whose horizon exceeds the historical window? (A 30-day forecast of a 3-month-old instrument has thin data.) Probably name the data scarcity in the result and let the planner downweight.
- Does the forecaster vend its output as a Far ref to the analyzer (per `skills/far-exo-vending`) or as a journal-entry path the analyzer reads? The latter is simpler at bootstrap; the former is the right shape if forecasts get large enough that we want to lazy-load.

## Implementation pointers

- The ensemble runner lives in `skills/monte-carlo-ensemble`; the renderer lives in `skills/histogram-projection-render`. Both are stubs.
- The forecaster role file names the inputs and outputs; the implementation lands when the first concrete program is chosen for forecasting.

## Notes from the field (2026-06-26 — richer-forecasting build)

The first richer build chose concrete implementations for the open axes. All
live in `@finbot/simulator`; the pipeline `forecaster.project()` consumes them.

- **Correlation handling.** Implemented. `packages/simulator/correlation.js` factors
  a correlation matrix via Cholesky (`L · Lᵀ = R`); `GBMPriceFeed` draws one
  standard-normal shock per asset per tick and runs the shock vector through `L`
  when a `correlations` spec is supplied. The draw count per tick is unchanged, so
  an uncorrelated feed stays byte-for-byte identical to the prior independent walk
  — the determinism contract is preserved across the upgrade. Spec accepts a sparse
  pair map (`{ "ATOM:OSMO": 0.6 }`), a nested map, or a full matrix; a
  non-positive-definite (inconsistent) request throws.
- **Volatility surface.** Implemented as *empirical bootstrap of realized vol*
  (`packages/simulator/vol-surface.js`). `surfaceFromPriceHistory()` derives a
  rolling-window realized-vol sample set per asset from a price history;
  `VolatilitySurface.sample()` draws a sigma per tick from a *separate* seeded RNG
  stream so the price-shock schedule is undisturbed. This widens the terminal
  distribution's tails toward what the record actually showed without assuming a
  distributional family. GARCH / implied surfaces remain open for a later cut.
- **Execution-cost noise.** `packages/simulator/costs.js` adds size-aware slippage
  (`slippageFill`) and jittered per-trade gas (`gasCost`), both seeded.
- **Bootstrap confidence bands.** `packages/simulator/bootstrap.js` resamples the
  ensemble B times under a seeded RNG and reports `{point, lo, hi, stderr}` per
  quantile. `forecast()` bands the tails (p01/p05/p50/p95/p99) by default — the
  report can now name how much to trust the noisy tails.
- **Path statistics.** `packages/simulator/path-stats.js` computes max-drawdown and
  time-to-recovery per trajectory; `forecast()` aggregates them into the
  `pathStats` distributions (drawdown quantiles + histogram, recovery-time
  distribution over recovered paths, and the recovery rate).
- **Renderer.** Chose **plain SVG via a deterministic builder**
  (`packages/simulator/histogram-svg.js`) — no DOM, no dependency, byte-diffable,
  embeds in markdown. `report` style draws the terminal-equity histogram with the
  p05–p95 / p25–p75 quantile bands shaded and the p50 line, plus a max-drawdown
  panel; `compact` is the single-panel form. Same forecast result → byte-identical
  SVG; the renderer never reads system time or `Math.random`. PNG rasterization
  remains the deferred fallback.
- **Output shape.** `forecaster.writeForecastArtifacts()` honors the role brief's
  `histogram_path` + `projection_path`: it writes `<id>.json` (the canonical
  artifact) and `<id>.svg` under a forecasts directory, where `<id>` is a SHA-256
  over the canonical artifact JSON — so the auditor can recompute the id and
  confirm a cited projection. The fs surface is injected, never hard-imported.

Status: implemented (richer build). Open axes still deferred: GARCH/implied vol
surfaces, PNG rasterization, far-ref vending of large forecasts to the analyzer.

## Notes from the field (2026-07-11 — GARCH conditional-vol surface)

The GARCH volatility-surface axis is now closed. `packages/simulator/garch.js`
adds `Garch11Surface`, a *stateful* conditional-volatility surface that models
**volatility clustering** — the property the empirical iid surface structurally
cannot reproduce. The conditional variance evolves

    sigma^2_{t+1} = omega + alpha * r_t^2 + beta * sigma^2_t
                  = omega + (alpha * z_t^2 + beta) * sigma^2_t

with persistence `alpha + beta < 1` (enforced at construction — a non-stationary
request throws). It slots into `GBMPriceFeed` behind the same `cfg.volSurface`
plug as the empirical surface, distinguished by an `isGarch` flag:

- **State placement.** The surface holds only the immutable per-asset params; the
  *evolving* variance lives in the feed instance (`feed.garchVar`), exactly as the
  fixed `volatilities` config does. So one `Garch11Surface` is shared safely across
  every child of a forecast ensemble — each `fork(seed)` starts a fresh variance
  path from `initialVariance()` and drives it with that child's own price shocks.
- **Zero extra RNG.** The recursion reuses the feed's *existing* per-asset price
  shock (the same post-correlation `z_t` that moved the price), so GARCH draws no
  numbers of its own. The determinism contract holds byte-for-byte, and a same-seed
  `clone()` carries the evolved variance forward while a reseeded fork resets it.
- **Fitting.** `garchFromPriceHistory()` fits by **variance targeting**: pin the
  model's unconditional variance to the sample variance of log returns
  (`omega = s^2 * (1 - alpha - beta)`) and take the ARCH/GARCH split from config
  (defaults alpha=0.08, beta=0.90 — typical daily-series persistence). Deterministic,
  no optimizer. Full per-asset MLE of (omega, alpha, beta) remains deferred.

Still open on this axis: implied-vol surfaces (needs options-market data), leverage
/ asymmetric variants (GJR-GARCH, EGARCH), and full MLE fitting. PNG rasterization
and far-ref vending of large forecasts remain deferred as before.

## Notes from the field (2026-07-11 — GJR-GARCH leverage effect)

The asymmetric branch of the GARCH axis is now closed. `packages/simulator/gjr-garch.js`
adds `GjrGarch11Surface`, which extends the symmetric surface with the
**leverage effect** — a large *drop* raises next-tick variance more than an
equal-magnitude *rise*, the stylized fact symmetric GARCH(1,1) structurally
cannot express (it keys off shock magnitude, blind to sign). The
Glosten–Jagannathan–Runkle recursion adds one sign-gated ARCH term:

    sigma^2_{t+1} = omega + (alpha + gamma * I[r_t < 0]) * r_t^2 + beta * sigma^2_t

- **Drop-in, no feed change.** The surface exposes the identical
  `isGarch`/`has`/`initialVariance`/`nextVariance(asset, varNow, shock)` interface
  as `Garch11Surface`, and the leverage indicator keys off the sign of the very
  standardized shock the feed already passes (`r_t = sigma_t * z_t`, sigma > 0, so
  `sign(r_t) = sign(z_t)`). `GBMPriceFeed` drives it with zero new code; all the
  clustering/clone/fork determinism guarantees carry over unchanged, and it draws
  no RNG of its own.
- **Collapse property.** `gamma = 0` reproduces symmetric GARCH byte-for-byte
  (an asserted test), so GJR is a strict superset — the symmetric surface is the
  no-leverage corner of the same family.
- **Stationarity.** With a symmetric innovation the expected ARCH weight is
  `alpha + gamma/2`, so persistence is `alpha + beta + gamma/2 < 1` and the
  unconditional variance is `omega / (1 - alpha - beta - gamma/2)`; a
  non-stationary request throws. Construction also rejects `alpha + gamma < 0`
  (a down-move must never *reduce* variance).
- **Fitting.** `gjrGarchFromPriceHistory()` fits by the same variance targeting as
  the symmetric model (`omega = s^2 * (1 - alpha - beta - gamma/2)`), taking the
  asymmetry gamma from config (defaults alpha=0.03, gamma=0.09, beta=0.90 — daily
  equity/crypto shape). The unconditional variance is fit; gamma is supplied, not
  estimated — deferred: estimating gamma from the realized down/up variance ratio,
  EGARCH (log-variance asymmetry), and full per-asset MLE.

The leverage signature is verified end-to-end: in a 6000-tick run the GJR feed's
return-sign vs. next-tick squared-return correlation is clearly negative while the
symmetric GARCH feed's sits near zero (test in `test/gjr-garch.test.js`).

Still open on this axis: EGARCH, gamma estimation / full MLE, implied-vol surfaces.
PNG rasterization and far-ref vending remain deferred as before.

## Notes from the field (2026-07-12 — conditional-vol surfaces reach the pipeline)

The last two cycles built GARCH and GJR-GARCH volatility-clustering surfaces in
`@finbot/simulator`, but the *pipeline* could not use them: `makePriceFeed`
accepted only an already-constructed `volSurface` object, and the OODA world
builder (`packages/pipeline/driver-compute.js`) always built a plain
constant-sigma GBM feed. So the richer forecasting engine sat one wire short of
the decision layer — the forecaster's Monte Carlo ensemble never saw clustering.

This cycle closes that gap with a **descriptor-driven surface factory** rather
than a fourth surface variant:

- **`makeVolSurface(descriptor)`** (`packages/simulator/world.js`) builds an
  empirical / GARCH / GJR-GARCH surface from a plain config descriptor, so a
  caller that only holds config can request clustering without importing the
  surface constructors. It passes an already-built surface through untouched, so
  every `volSurface` value can route through it uniformly. Descriptor forms:
  `{ kind: 'garch'|'gjr-garch', params }` (explicit per-asset params),
  `{ ..., history }` (variance-target fit from price frames, delegating to the
  existing `*FromPriceHistory` fitters), or `{ ..., volatilities }` (the
  ergonomic form — variance-target from a per-asset base sigma, pinning the
  unconditional variance to sigma² with the ARCH/GARCH/leverage split taken from
  the descriptor or the module defaults). `{ kind: 'empirical', history }` builds
  the realized-vol bootstrap surface.
- **`makePriceFeed`** now routes `cfg.volSurface` through `makeVolSurface`, and
  **`driver-compute.js`** forwards an optional `opts.volSurface` descriptor into
  the world's price-feed config. A driver run can now ask for a GARCH-clustered
  forecast ensemble with `makeDryRunCompute({ volSurface: { kind: 'garch',
  volatilities: { ATOM: 0.03 } } })`.
- **Determinism / back-compat preserved.** `makeVolSurface(undefined) === null`,
  and the GBM feed already collapsed `undefined`/`null` volSurface to plain GBM,
  so the default path is byte-for-byte the prior constant-sigma walk (asserted:
  a factory-built world's ticks equal a raw `GBMPriceFeed`'s, and two default
  computes replay an identical forecast histogram). A GARCH descriptor reshapes
  the ensemble (different histogram at the same seed/tick) yet stays reproducible
  (identical histogram across two runs of the same tick). The surfaces draw no
  RNG of their own and each ensemble fork starts a fresh variance path, so the
  determinism contract the auditor's recompute relies on is intact.

Proven by `packages/simulator/test/vol-surface-factory.test.js` (factory forms,
passthrough, variance targeting, byte-identical default walk, clustering-widens-
the-tail signature) and `packages/pipeline/test/driver-vol-surface.test.js`
(the descriptor flows end to end through the OODA cycle, reshapes the forecast,
stays reproducible, and the default path is unchanged). Full suite 478 pass;
`finbot-ooda --seed=7` still green with WALLET TOUCHED: false.

Still open on this axis: EGARCH, gamma estimation / full MLE, implied-vol
surfaces, PNG rasterization, far-ref vending. And a natural follow-on now that
clustering is reachable: let the analyzer/planner *choose* a surface per
instrument from the observed price window (fit a GARCH surface from the oracle
history) rather than the driver naming it as static config.

### Adaptive vol — fitting the surface from the observed window (2026-07-12)

The follow-on above has landed. The forecaster can now **fit** a conditional-vol
surface from the cycle's own observed oracle window instead of relying on a
statically-named driver descriptor, so the Monte Carlo ensemble tracks the
volatility regime the cycle *actually saw*, per instrument.

- **`GBMPriceFeed.withVolSurface(surface)`** (`price-feed.js`) returns a copy of
  the feed at its current state (prices + tick counter + seed) with a different
  vol surface installed and a fresh GARCH variance path (a new surface must not
  inherit the old one's evolved variance). `null` clears the surface back to
  constant-sigma GBM. It is the non-mutating swap the forecaster forks under —
  the outer walk keeps whatever surface produced the history; each forecast
  child forks off the freshly-fit surface.
- **`project()`** now accepts `input.readings` (the observed window) and
  `config.adaptiveVol` (a volSurface descriptor **without data**, e.g.
  `{ kind: 'garch' }` or `{ kind: 'gjr-garch', alpha, beta }`). When present,
  `fitForecastWorld()` fills the descriptor's `history` from
  `priceFramesFromReadings(readings)`, builds the surface via `makeVolSurface`,
  and projects the ensemble from a forecast-world carrying it. The **current
  snapshot** (currentNav + cited actionSteps) is still read from the original
  world, so the fit reshapes only the projected distribution, never the present.
- **`ooda-cycle.js`** threads the oracle `readings` into `project()`, and
  **`driver-compute.js`** forwards `opts.adaptiveVol` into `config.forecaster`,
  so `makeDryRunCompute({ adaptiveVol: { kind: 'garch' } })` fits per tick.
- **Citation trail.** A fit populates `projection.volFit` — `{ kind, source:
  'observed-window', frames, assets: { <asset>: { unconditionalVol, sigma0,
  persistence } } }` — and, **only when a fit ran**, that summary is folded into
  the canonical `projectionArtifact` (and thus the projection id). A non-adaptive
  projection's artifact carries no `volFit` key, so its content hash and the
  auditor's recompute-and-compare stay byte-identical to before.
- **Robust + deterministic.** The fit is variance-targeting over the observed
  returns (no RNG), so the whole forecast stays reproducible. A too-short
  (< 2 frames) or degenerate (constant-price → non-stationary params) window
  falls back to the unadapted world rather than sinking the cycle.

Proven by `packages/pipeline/test/forecaster-adaptive-vol.test.js` (fit reshapes
the ensemble and widens the tail, deterministic, gjr-garch accepted, default path
inert with an unchanged artifact hash, degenerate windows fall back), the two new
`driver-vol-surface.test.js` cases (adaptiveVol fits end to end through the OODA
cycle, reshapes vs the plain feed, stays reproducible), and two
`price-feed.test.js` cases (the swap preserves state and re-inits GARCH; `null`
clears back to constant-sigma). Full suite 488 pass; `finbot-ooda --seed=7` still
green with all six invariants PASS and WALLET TOUCHED: false.

Next on this axis: let the fit adapt per-instrument *parameters* (α/β via a light
MLE or a rolling estimator) rather than variance-targeting fixed defaults, and
let the analyzer weigh the fitted regime (a persistence/vol read) into its score.

### Adaptive vol — estimating (alpha, beta) per instrument by light MLE (2026-07-12)

The adaptive fit above pinned each instrument's *unconditional* variance to the
observed sample variance but still took the ARCH/GARCH split (alpha, beta) from a
single fixed config default (0.08 / 0.90) — so a bursty, highly-persistent asset
and a calm, quickly mean-reverting one were stamped with the same clustering
shape. This cycle reads that shape out of the data too.

- **`garchMleFromPriceHistory(priceFrames, opts)`** (`packages/simulator/garch.js`)
  fits like `garchFromPriceHistory` — variance targeting pins the unconditional
  variance to the sample variance, `omega = s^2 (1 - alpha - beta)` — but
  **estimates (alpha, beta) per asset** by maximizing the Gaussian likelihood of
  the variance-targeting GARCH(1,1) recursion over the demeaned returns. The
  search is a **deterministic nested grid refinement** (a coarse grid over the
  (alpha, beta) box, then successively finer grids around the incumbent) — no
  optimizer library, no RNG, byte-identical params for identical input. It is a
  *light* MLE on purpose: variance targeting removes omega from the search, so
  only the two persistence coefficients are fit, which is cheaper and far more
  stable on the short windows the OODA cycle observes than a joint (omega, alpha,
  beta) MLE would be.
- **Descriptor wiring.** `makeVolSurface` routes
  `{ kind: 'garch', history, estimate: 'mle' }` to the estimator; without
  `estimate` it stays on the fixed-split fitter, so every existing path is
  byte-identical. Because the forecaster's adaptive fit spreads its descriptor,
  `config.adaptiveVol = { kind: 'garch', estimate: 'mle' }` (and thus
  `makeDryRunCompute({ adaptiveVol: { kind: 'garch', estimate: 'mle' } })`) fits
  per instrument from the live window end to end. `gjr-garch` + `estimate: 'mle'`
  throws for now (asymmetric-MLE is deferred).
- **What it recovers.** On a genuinely clustered GARCH process the estimator
  recovers the ARCH reaction closely (true alpha 0.12 → fitted ~0.15) while iid
  noise fits alpha ~0.02 — the ARCH coefficient is the well-identified signal.
  Beta (the memory term) is only weakly identified on *near-iid* windows because
  the variance-targeting likelihood is flat in persistence there; that is an
  inherent limitation of a light variance-targeting MLE, not a bug, and alpha
  carries the discriminating information the analyzer will eventually weigh.
- **Robust + deterministic.** A window with fewer than 12 returns (too short for a
  per-window fit to mean anything) or a degenerate constant-price asset falls back
  to the fixed default split, exactly as `garchFromPriceHistory` would —
  `opts.alpha` / `opts.beta` set that fallback. The whole fit draws no RNG, so the
  forecast stays reproducible and the auditor's recompute-and-compare is intact.
  Observed in the field: the current OODA oracle window is ~10 frames (9 returns),
  so the live cycle *falls back today* and the MLE engages once the window is
  longer — a natural next lever (accumulate a rolling window, or lengthen the
  observation, so the live cycle fits rather than defaults).

Proven by `packages/simulator/test/garch-mle.test.js` (deterministic params,
variance targeting preserved, ARCH-reaction recovery clustered-vs-iid, short-window
and custom-fallback behaviour, factory routing, gjr rejection) and a new
`forecaster-adaptive-vol.test.js` case (the `estimate: 'mle'` descriptor flows
through `project()` end to end, changes the fitted persistence vs the fixed split,
preserves the variance target, and stays byte-identical across runs). Full suite
497 pass; `finbot-ooda --seed=7` green with all six invariants PASS and
WALLET TOUCHED: false.

Next on this axis: **weigh the fitted regime into the analyzer's score** (a
persistence / conditional-vol read shifting risk appetite), and lengthen or roll
the OODA observation window so the live cycle actually engages the MLE instead of
falling back. Deferred as before: gamma/asymmetric MLE, EGARCH, implied-vol
surfaces, PNG rasterization, far-ref vending.

## Notes from the field (2026-07-13 — regime-aware tail floor)

The prior cuts *measured* the per-instrument regime (adaptive GARCH vol surface,
light per-asset MLE of α/β, a separable vol-fit window that engages the MLE on a
live cycle, and an analyzer that scores under the current regime). This cut closes
the loop: **the regime now changes what the auditor decides.**

- **Regime-aware tail-risk floor** (`packages/pipeline/auditor.js`). The forecast's
  per-instrument GARCH persistence (α+β, carried in `forecast.volFit.assets`)
  tightens the auditor's tail floor. A highly persistent regime holds an elevated
  conditional variance for many ticks, so a shock this cycle compounds into a
  deeper drawdown than an equal-variance-but-mean-reverting regime — and a
  single-window persistence estimate is itself noisy, so a point p05 gives no
  margin for that estimation error. The gate therefore demands extra downside
  headroom: `effectiveFloorPct = min(cap, tailFloorPct + regimeTailBump · stress)`,
  where `stress` is a deterministic linear ramp of the **worst** asset's
  persistence from `regimePersistenceLo` (0.70, no bump) to `regimePersistenceHi`
  (0.98, full bump). Bounded by `regimeTailFloorCap` (0.98).
- **Off by default, byte-identical when inert.** `regimeTailBump` defaults to 0, so
  a plain (non-adaptive) audit — and every existing gate — is unchanged. The
  `ooda-cycle` defaults the bump to 0.1 **only when `forecaster.adaptiveVol` is
  set**, mirroring how it already threads the analyzer's `regimeVol`; a caller can
  pin or disable it with `config.auditor.regimeTailBump`. The CLI exposes
  `--regime-tail-bump=F`.
- **Proven end to end.** New `packages/pipeline/test/regime-tail-floor.test.js`
  (plain-GARCH fit carries persistence 0.98 into the floor; the ooda-cycle defaults
  the 0.1 bump when adaptive vol is on and leaves it untightened when off) plus six
  auditor unit cases in `roles.test.js` (off-by-default, tightens-and-rejects,
  calm-regime-no-tighten, worst-asset keying, inert-without-volFit, cap-bounded).
  Full suite **520 pass / 0 fail**; `finbot-ooda --seed=7` across every mode green
  with **WALLET TOUCHED: false**. Demonstrated flip: an adaptive cycle at
  `--tail-floor=0.7` tightens to 80% and still approves (p05 clears), while
  `--regime-tail-bump=0.5` caps the floor at 98% and **rejects** the same proposal —
  the regime measurably moved the pre-execution decision, wallet untouched.

Next on this axis: feed regime persistence into the **forecaster horizon** (a
high-persistence regime argues for a longer projection, so a transient shock is not
amortized away), or into the **analyzer's risk appetite** more directly. Deferred as
before: gamma/asymmetric MLE, EGARCH, implied-vol surfaces, PNG rasterization,
far-ref vending.

## Notes from the field (2026-07-13 — regime-aware forecaster horizon)

The prior cut let a persistent regime change what the *auditor* decides (the
regime-tail-floor). This cut applies the same measure-then-decide loop to the
*forecaster's projection depth*: **a persistent vol regime projects longer.**

- **Regime-aware horizon** (`packages/pipeline/forecaster.js`, `regimeHorizon`).
  The adaptive fit's **worst-asset** GARCH persistence (α+β, the same worst-asset
  the tail floor keys off) stretches the Monte-Carlo horizon:
  `horizon = min(cap, round(baseHorizon · (1 + regimeHorizonStretch · stress)))`,
  where `stress` is the shared deterministic ramp of persistence from
  `regimePersistenceLo` (0.70, no stretch) to `regimePersistenceHi` (0.98, full
  stretch), bounded by `regimeHorizonCap` (60 ticks). Rationale: a highly
  persistent regime holds its elevated conditional variance for many ticks, so a
  shock *this* cycle compounds rather than mean-reverting away inside a short
  window — a horizon that truncates mid-shock understates the drawdown-and-recovery
  dynamics the auditor's `pathStats` read out. Projecting longer resolves them.
- **A shared worst-asset/stress helper.** The worst-asset-persistence scan and the
  persistence→stress ramp, previously inline in the auditor's `regimeTailFloor`,
  are now `worstAssetPersistence()` + `persistenceStress()` in `forecaster.js`,
  imported by both levers — so the horizon and the tail floor key off the SAME
  worst instrument the SAME way, by construction rather than by coincidence.
- **Off by default, byte-identical when inert.** `regimeHorizonStretch` defaults to
  0, so a plain (non-adaptive) or explicitly-pinned projection keeps its base
  horizon and carries no `horizonRegime`, leaving its artifact JSON — and thus its
  content hash and the auditor's recompute-and-compare — byte-identical. The
  `ooda-cycle` defaults the stretch to **0.5 only when `forecaster.adaptiveVol` is
  set**, mirroring how it already defaults the audit gate's `regimeTailBump`; a
  caller can pin or disable it with `config.forecaster.regimeHorizonStretch`. The
  CLI exposes `--regime-horizon-stretch=F`.
- **Proven end to end.** New `packages/pipeline/test/regime-horizon.test.js`: the
  two shared helpers (worst-asset keying, inert cases, the clamped ramp, degenerate
  span), the `regimeHorizon` unit (off / inert / calm / persistent / cap-bounded /
  too-small-to-round), a `project()` integration on the DIP window (persistence
  0.98 → horizon 10→15, a genuinely different terminal distribution, `horizonRegime`
  cited, byte-identical when off, deterministic across runs), and the ooda-cycle
  default-on/off. Full suite **528 pass / 0 fail**; `finbot-ooda --seed=7` across
  every mode green with **WALLET TOUCHED: false**, including
  `--regime-horizon-stretch=0.8`.

Next on this axis: the live GBM world fits worst-asset persistence ~0.68 (just shy
of the 0.70 `lo`), so the live cycle is inert **today** — the stretch engages once
a genuinely clustered regime is observed (a longer/rolling fit window, or a
non-GBM feed). The paired lever left is feeding persistence into the analyzer's
**risk appetite** more directly (position sizing, not just the gate and horizon).
Deferred as before: gamma/asymmetric MLE, EGARCH, implied-vol surfaces, PNG
rasterization, far-ref vending.
