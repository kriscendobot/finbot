/**
 * Substrate signing adapters (ymax Path A / Path C).
 *
 * `rebalance.js` mirrors the ymax *protocol* (target balances -> funds-flow
 * steps) and, until now, stamped every step with `route: 'sim:single-venue'`
 * as a placeholder for real venue detail. This module fills that placeholder.
 * It is the per-substrate layer that:
 *
 *   1. resolves each step's `route` to a *real* place / route identifier
 *      drawn from the PUBLIC ymax portfolio-contract / portfolio-api shape
 *      (Agoric pool places, EVM chain+protocol pools, Solana programs), not
 *      the `sim:single-venue` placeholder; and
 *   2. builds the would-be transaction for that substrate from the planner's
 *      steps (a `rebalanceTx`-shaped offer for Agoric, an EVM call batch for
 *      Path C EVM, an instruction batch for Path C Solana) WITHOUT signing; and
 *   3. (LIVE ONLY, gated) signs and submits that transaction through the wallet
 *      capability the executor alone is vended in `--live` mode.
 *
 * Hard safety bound (per `designs/ymax-integration.md` § Safety, and the
 * `finbot-substrate-adapters` job): this is design + dry-run-proven adapters,
 * NOT a live-enable. `buildTransaction` is pure and never touches a wallet;
 * `signAndSubmit` is reachable only with a live wallet capability in hand,
 * which `cap-attenuation.js` vends solely to a `--live`-authorized executor.
 * No adapter here constructs a real signer, RPC client, or key.
 *
 * Provenance discipline: every identifier below is drawn from the PUBLIC
 * portfolio-contract / portfolio-api / agoric-to-axelar-local design surface.
 * Where a concrete value (a pool contract address, an Axelar GMP channel id,
 * a Solana program id, the exact offer-spec field names) lives only in the
 * internal ymax-web / deployment config, the route carries it in
 * `needs_internal_detail` (flagged, not fabricated) so a later live-enable job
 * fills it from the real config rather than trusting a guess made here.
 */

import { CapabilityError } from './cap-attenuation.js';

/**
 * @typedef {object} Route
 * @property {string} substrate       'agoric' | 'evm' | 'solana' | 'sim'
 * @property {string} place           the substrate's canonical place identifier for this leg
 * @property {string} [chain]         settlement chain (EVM chain name / Cosmos chain / Solana cluster)
 * @property {string} [protocol]      the venue protocol (Aave, Compound, USDN, ...)
 * @property {string} [transport]     how the instruction reaches the venue (direct, axelar-gmp, ...)
 * @property {string[]} needs_internal_detail   concrete values that must come from internal/deploy config
 */

/**
 * Public Agoric pool places (portfolio-contract / portfolio-api shape). These
 * are the `PoolKey`-style identifiers the on-chain contract and the off-chain
 * planner both name; the contract reaches the EVM ones over Axelar GMP. The
 * pool *contract addresses* and GMP channel ids are deployment config, so they
 * are flagged per-route, never hard-coded here.
 */
const AGORIC_POOL_PLACES = {
  USDN: { protocol: 'USDN', chain: 'noble', transport: 'ica-noble' },
  Aave_Arbitrum: { protocol: 'Aave', chain: 'Arbitrum', transport: 'axelar-gmp' },
  Aave_Avalanche: { protocol: 'Aave', chain: 'Avalanche', transport: 'axelar-gmp' },
  Aave_Optimism: { protocol: 'Aave', chain: 'Optimism', transport: 'axelar-gmp' },
  Aave_Base: { protocol: 'Aave', chain: 'Base', transport: 'axelar-gmp' },
  Compound_Arbitrum: { protocol: 'Compound', chain: 'Arbitrum', transport: 'axelar-gmp' },
  Compound_Optimism: { protocol: 'Compound', chain: 'Optimism', transport: 'axelar-gmp' },
};

/** The Agoric-local cash account place: the quote currency lives here at rest. */
const AGORIC_CASH_PLACE = '@agoric';

/**
 * EVM venue catalog (Path C, direct-to-chain, no Agoric contract in the loop).
 * Protocol + chain are public; the market/pool address is per-deployment.
 */
const EVM_VENUES = {
  'Aave_Arbitrum': { protocol: 'Aave-v3', chain: 'Arbitrum' },
  'Aave_Base': { protocol: 'Aave-v3', chain: 'Base' },
  'Compound_Base': { protocol: 'Compound-v3', chain: 'Base' },
};

/** Solana venue catalog (Path C). Program ids are per-cluster deployment config. */
const SOLANA_VENUES = {
  'Kamino_Mainnet': { protocol: 'Kamino', cluster: 'mainnet-beta' },
  'Solend_Mainnet': { protocol: 'Solend', cluster: 'mainnet-beta' },
};

/**
 * A venue map keys an asset symbol to the venue identifier the substrate should
 * route it through. The planner supplies one per rebalance; an asset with no
 * mapping yields a route flagged `unmapped-asset` rather than a fabricated one.
 *
 * @typedef {Record<string, string>} VenueMap   asset symbol -> venue/place id
 */

function unmappedRoute(substrate, asset) {
  return {
    substrate,
    place: `${substrate}:unmapped:${asset}`,
    needs_internal_detail: ['venue-mapping'],
    note: `no venue mapped for ${asset} on ${substrate}; planner must supply venueMap[${asset}]`,
  };
}

/**
 * Path A: Agoric. finbot is a second off-chain planner submitting against the
 * SAME portfolio-contract instance Agoric runs; the executor's live job is to
 * submit a `rebalanceTx` (a continuing-offer "Rebalance" invitation) via a
 * signing smart wallet (`makeSigningSmartWalletKit` shape).
 */
const agoricAdapter = {
  id: 'agoric',
  path: 'A',
  liveGated: true,

  /** @param {{asset:string, side:string}} step @param {VenueMap} venueMap @returns {Route} */
  resolveRoute(step, venueMap = {}) {
    const place = venueMap[step.asset];
    if (!place) return unmappedRoute('agoric', step.asset);
    const pool = AGORIC_POOL_PLACES[place];
    if (!pool) {
      return {
        substrate: 'agoric', place,
        needs_internal_detail: ['pool-place-unknown'],
        note: `place ${place} not in the public portfolio-contract pool set`,
      };
    }
    return {
      substrate: 'agoric',
      place,
      chain: pool.chain,
      protocol: pool.protocol,
      transport: pool.transport,
      // The continuing-offer handle, pool contract address, and (for EVM pools)
      // the Axelar GMP channel are deployment/runtime config, not public shape.
      needs_internal_detail: [
        'portfolio-offer-id',
        'pool-contract-address',
        ...(pool.transport === 'axelar-gmp' ? ['axelar-gmp-channel'] : []),
      ],
    };
  },

  /**
   * Build the would-be `rebalanceTx` offer (public continuing-offer shape).
   * Pure: no wallet, no network. Each step becomes a flow leg between the
   * Agoric-local cash place and the step's pool place.
   *
   * @param {{steps: Array<object>, account?: object}} input
   * @returns {object} the unsigned rebalance offer
   */
  buildTransaction(input) {
    const flows = input.steps.map((s) => ({
      // A buy moves cash -> pool; a sell moves pool -> cash.
      src: s.side === 'buy' ? AGORIC_CASH_PLACE : s.route.place,
      dest: s.side === 'buy' ? s.route.place : AGORIC_CASH_PLACE,
      asset: s.asset,
      amount: s.notional,
      transport: s.route.transport,
    }));
    return {
      kind: 'agoric.rebalanceTx',
      // Mirrors the portfolio-contract continuing-offer "Rebalance" invitation.
      invitationSpec: {
        source: 'continuing',
        invitationMakerName: 'Rebalance',
        // previousOffer (the portfolio open offer id) is per-account runtime state.
        previousOffer: (input.account && input.account.portfolioOfferId) || null,
      },
      offerArgs: { flows },
      signed: false,
      needs_internal_detail: ['previousOffer', 'brand-scaled-amounts'],
    };
  },

  /**
   * LIVE ONLY. Sign and submit through the smart-wallet capability. Reachable
   * only when the executor is vended `walletCap` (live + authorized). The
   * walletCap interface (`address`, `sign`, `submit`) matches the
   * interface-guarded cap in `cap-attenuation.js`.
   */
  async signAndSubmit(tx, walletCap) {
    requireLiveWallet(walletCap, 'agoric');
    const signed = await walletCap.sign(tx);
    return walletCap.submit(signed);
  },
};

/**
 * Path C: EVM. finbot targets a portfolio on an EVM chain directly, using
 * ymax's *protocol* (the solver, the plan shape) but not Agoric's contract.
 * Each step is an approve+action call pair against the venue's pool.
 */
const evmAdapter = {
  id: 'evm',
  path: 'C',
  liveGated: true,

  resolveRoute(step, venueMap = {}) {
    const venue = venueMap[step.asset];
    if (!venue) return unmappedRoute('evm', step.asset);
    const v = EVM_VENUES[venue];
    if (!v) {
      return { substrate: 'evm', place: venue, needs_internal_detail: ['venue-unknown'] };
    }
    return {
      substrate: 'evm',
      place: `evm:${v.chain}:${v.protocol}`,
      chain: v.chain,
      protocol: v.protocol,
      transport: 'direct-evm',
      needs_internal_detail: ['pool-market-address', 'token-erc20-address', 'chain-rpc-url'],
    };
  },

  buildTransaction(input) {
    const calls = [];
    for (const s of input.steps) {
      if (s.side === 'buy') {
        calls.push({ method: 'approve', venue: s.route.place, asset: s.asset, amount: s.notional });
        calls.push({ method: 'supply', venue: s.route.place, asset: s.asset, amount: s.notional });
      } else {
        calls.push({ method: 'withdraw', venue: s.route.place, asset: s.asset, amount: s.notional });
      }
    }
    return {
      kind: 'evm.callBatch',
      chain: input.steps[0] && input.steps[0].route.chain,
      calls,
      signed: false,
      needs_internal_detail: ['pool-market-address', 'token-erc20-address', 'gas-estimate'],
    };
  },

  async signAndSubmit(tx, walletCap) {
    requireLiveWallet(walletCap, 'evm');
    const signed = await walletCap.sign(tx);
    return walletCap.submit(signed);
  },
};

/** Path C: Solana. Same protocol, instruction-batch transaction. */
const solanaAdapter = {
  id: 'solana',
  path: 'C',
  liveGated: true,

  resolveRoute(step, venueMap = {}) {
    const venue = venueMap[step.asset];
    if (!venue) return unmappedRoute('solana', step.asset);
    const v = SOLANA_VENUES[venue];
    if (!v) {
      return { substrate: 'solana', place: venue, needs_internal_detail: ['venue-unknown'] };
    }
    return {
      substrate: 'solana',
      place: `solana:${v.cluster}:${v.protocol}`,
      chain: v.cluster,
      protocol: v.protocol,
      transport: 'direct-solana',
      needs_internal_detail: ['program-id', 'reserve-pubkey', 'cluster-rpc-url'],
    };
  },

  buildTransaction(input) {
    const instructions = input.steps.map((s) => ({
      program: s.route.protocol,
      action: s.side === 'buy' ? 'deposit' : 'withdraw',
      asset: s.asset,
      amount: s.notional,
      venue: s.route.place,
    }));
    return {
      kind: 'solana.instructionBatch',
      cluster: input.steps[0] && input.steps[0].route.chain,
      instructions,
      signed: false,
      needs_internal_detail: ['program-id', 'reserve-pubkey', 'recent-blockhash'],
    };
  },

  async signAndSubmit(tx, walletCap) {
    requireLiveWallet(walletCap, 'solana');
    const signed = await walletCap.sign(tx);
    return walletCap.submit(signed);
  },
};

/**
 * The baseline simulator substrate. Preserves the original
 * `route: 'sim:single-venue'` behavior for the dry-run paper portfolio, which
 * has a single in-memory venue and no real place. It is the default so every
 * pre-existing planner/executor call is unchanged.
 */
const simAdapter = {
  id: 'sim',
  path: 'B',
  liveGated: false,
  resolveRoute() { return 'sim:single-venue'; },
  buildTransaction(input) {
    return { kind: 'sim.paperTrades', trades: input.steps.map((s) => ({ side: s.side, asset: s.asset, amount: s.notional })), signed: false };
  },
  async signAndSubmit() {
    throw new CapabilityError('sim substrate has no live path: it is the paper-portfolio dry-run venue');
  },
};

/** @type {Record<string, object>} */
export const SUBSTRATES = {
  sim: simAdapter,
  agoric: agoricAdapter,
  evm: evmAdapter,
  solana: solanaAdapter,
};

/**
 * Resolve a substrate id (or an already-resolved adapter) to its adapter.
 * @param {string|object} [substrate] default 'sim'
 * @returns {object}
 */
export function selectSubstrate(substrate = 'sim') {
  if (substrate && typeof substrate === 'object' && substrate.id) return substrate;
  const adapter = SUBSTRATES[substrate];
  if (!adapter) throw new CapabilityError(`unknown substrate: ${substrate}`);
  return adapter;
}

/**
 * Build a route resolver `(stepInfo) => Route` for a substrate + venue map.
 * `deriveSteps` calls this per step so each emitted step carries a real route.
 *
 * @param {string|object} [substrate]
 * @param {VenueMap} [venueMap]
 * @returns {(step: {asset:string, side:string, source:string, dest:string}) => (Route|string)}
 */
export function routeResolverFor(substrate = 'sim', venueMap = {}) {
  const adapter = selectSubstrate(substrate);
  return (step) => adapter.resolveRoute(step, venueMap);
}

/**
 * True when a step's route is a real substrate route (not the sim placeholder
 * and not an unmapped/unknown flag). The auditor uses this for the place/route
 * reachability invariant.
 *
 * @param {object} step
 * @returns {boolean}
 */
export function stepHasRealRoute(step) {
  const r = step && step.route;
  if (!r || typeof r !== 'object') return false;
  if (!r.place || !r.substrate) return false;
  const flags = r.needs_internal_detail || [];
  // A route still needing its *venue mapping* or with an unknown place is not
  // reachable; one needing only deploy-config detail (addresses, channels) is a
  // real route whose live-enable is a later, separately authorized step.
  return !flags.includes('venue-mapping')
    && !flags.includes('venue-unknown')
    && !flags.includes('pool-place-unknown');
}

function requireLiveWallet(walletCap, substrate) {
  if (!walletCap || typeof walletCap.sign !== 'function' || typeof walletCap.submit !== 'function') {
    throw new CapabilityError(
      `${substrate} live submit requires a wallet capability with sign+submit; `
      + 'none vended (dry-run, or live not authorized)',
    );
  }
}
