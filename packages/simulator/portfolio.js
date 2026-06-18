/**
 * Simulated portfolio.
 *
 * Deterministic in-memory book: a map of asset -> balance, a trade
 * history, and a cash account denominated in the quote currency. The
 * portfolio is fed by a simulated price feed; nothing touches the
 * chain.
 *
 * Trades go through `applyTrade(side, asset, qty, price)`. The
 * portfolio records the trade, adjusts asset balance and cash, and
 * derives P&L on `markToMarket(prices)`.
 */

/**
 * @typedef {object} Trade
 * @property {number} t              tick at which the trade landed
 * @property {'buy' | 'sell'} side
 * @property {string} asset
 * @property {number} qty            positive quantity
 * @property {number} price          execution price in quote currency
 * @property {number} notional       qty * price
 */

/**
 * @typedef {object} PortfolioSnapshot
 * @property {number} cash
 * @property {Record<string, number>} balances
 * @property {number} equity         cash + sum(balance_i * price_i)
 * @property {number} realizedPnL
 * @property {number} unrealizedPnL
 * @property {number} totalPnL       realized + unrealized
 * @property {number} costBasis      cumulative cost of currently held positions
 * @property {number} tradeCount
 */

export class Portfolio {
  /**
   * @param {object} init
   * @param {number} [init.cash]                       starting cash, default 10000
   * @param {Record<string, number>} [init.balances]   starting asset balances
   * @param {string} [init.quoteCurrency]              default 'USDC'
   */
  constructor(init = {}) {
    this.cash = init.cash != null ? init.cash : 10000;
    this.initialEquity = this.cash;
    this.balances = { ...(init.balances || {}) };
    this.quoteCurrency = init.quoteCurrency || 'USDC';
    /** @type {Trade[]} */
    this.trades = [];
    this.realizedPnL = 0;
    // Track lot-level cost basis per asset (FIFO). { asset: [{qty, price}, ...] }
    /** @type {Record<string, Array<{qty: number, price: number}>>} */
    this.lots = {};
    for (const [asset, qty] of Object.entries(this.balances)) {
      // assume initial balances were acquired at "price 0" baseline. The
      // user can pass `costBasis` if they want a non-trivial start.
      this.lots[asset] = qty > 0 ? [{ qty, price: init.initialPrice || 0 }] : [];
    }
  }

  /**
   * Apply a trade and update balances + cash + lots.
   *
   * @param {object} trade
   * @param {number} trade.t                              tick
   * @param {'buy' | 'sell'} trade.side
   * @param {string} trade.asset
   * @param {number} trade.qty                            positive
   * @param {number} trade.price                          execution price
   * @returns {Trade}
   */
  applyTrade({ t, side, asset, qty, price }) {
    if (qty <= 0) throw new Error(`Portfolio.applyTrade: qty must be > 0 (got ${qty})`);
    if (price < 0) throw new Error(`Portfolio.applyTrade: price must be >= 0 (got ${price})`);
    const notional = qty * price;
    if (side === 'buy') {
      if (notional > this.cash + 1e-9) {
        throw new Error(`Portfolio.applyTrade: insufficient cash (need ${notional}, have ${this.cash})`);
      }
      this.cash -= notional;
      this.balances[asset] = (this.balances[asset] || 0) + qty;
      if (!this.lots[asset]) this.lots[asset] = [];
      this.lots[asset].push({ qty, price });
    } else if (side === 'sell') {
      const have = this.balances[asset] || 0;
      if (qty > have + 1e-9) {
        throw new Error(`Portfolio.applyTrade: insufficient ${asset} (need ${qty}, have ${have})`);
      }
      this.cash += notional;
      this.balances[asset] = have - qty;
      // Drain FIFO lots to compute realized P&L.
      let remaining = qty;
      const lots = this.lots[asset] || [];
      while (remaining > 1e-12 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(lot.qty, remaining);
        this.realizedPnL += take * (price - lot.price);
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-12) lots.shift();
      }
    } else {
      throw new Error(`Portfolio.applyTrade: unknown side ${side}`);
    }
    const trade = { t, side, asset, qty, price, notional };
    this.trades.push(trade);
    return trade;
  }

  /**
   * Mark to market against the supplied price book.
   *
   * @param {Record<string, number>} prices
   * @returns {PortfolioSnapshot}
   */
  markToMarket(prices = {}) {
    let assetValue = 0;
    let costBasis = 0;
    for (const [asset, qty] of Object.entries(this.balances)) {
      const p = prices[asset];
      if (p != null) assetValue += qty * p;
      const lots = this.lots[asset] || [];
      for (const lot of lots) costBasis += lot.qty * lot.price;
    }
    const equity = this.cash + assetValue;
    const unrealizedPnL = assetValue - costBasis;
    return {
      cash: this.cash,
      balances: { ...this.balances },
      equity,
      realizedPnL: this.realizedPnL,
      unrealizedPnL,
      totalPnL: this.realizedPnL + unrealizedPnL,
      costBasis,
      tradeCount: this.trades.length,
    };
  }

  /**
   * Deep clone (for fork()-style copies in the simulator).
   *
   * @returns {Portfolio}
   */
  clone() {
    const copy = new Portfolio({
      cash: this.cash,
      balances: { ...this.balances },
      quoteCurrency: this.quoteCurrency,
    });
    copy.initialEquity = this.initialEquity;
    copy.realizedPnL = this.realizedPnL;
    copy.trades = this.trades.map((t) => ({ ...t }));
    copy.lots = {};
    for (const [asset, lots] of Object.entries(this.lots)) {
      copy.lots[asset] = lots.map((l) => ({ ...l }));
    }
    return copy;
  }
}
