import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Portfolio } from '../portfolio.js';

test('portfolio: starts with declared cash and balances', () => {
  const p = new Portfolio({ cash: 1000, balances: { ATOM: 5 } });
  assert.equal(p.cash, 1000);
  assert.equal(p.balances.ATOM, 5);
  assert.equal(p.trades.length, 0);
});

test('portfolio: defaults', () => {
  const p = new Portfolio();
  assert.equal(p.cash, 10000);
  assert.deepEqual(p.balances, {});
  assert.equal(p.quoteCurrency, 'USDC');
});

test('portfolio: buy decrements cash and increments balance', () => {
  const p = new Portfolio({ cash: 1000 });
  const trade = p.applyTrade({ t: 0, side: 'buy', asset: 'ATOM', qty: 10, price: 9 });
  assert.equal(p.cash, 910);
  assert.equal(p.balances.ATOM, 10);
  assert.equal(trade.notional, 90);
  assert.equal(p.trades.length, 1);
});

test('portfolio: sell increments cash and decrements balance', () => {
  const p = new Portfolio({ cash: 1000 });
  p.applyTrade({ t: 0, side: 'buy', asset: 'ATOM', qty: 10, price: 9 });
  p.applyTrade({ t: 1, side: 'sell', asset: 'ATOM', qty: 5, price: 10 });
  assert.equal(p.balances.ATOM, 5);
  assert.equal(p.cash, 910 + 50);
});

test('portfolio: FIFO sell records realized P&L', () => {
  const p = new Portfolio({ cash: 1000 });
  p.applyTrade({ t: 0, side: 'buy', asset: 'ATOM', qty: 10, price: 9 });
  p.applyTrade({ t: 1, side: 'sell', asset: 'ATOM', qty: 5, price: 11 });
  // Sold 5 @ 11, bought 5 of those @ 9 -> P&L = 5 * (11 - 9) = 10
  assert.equal(p.realizedPnL, 10);
});

test('portfolio: buy throws on insufficient cash', () => {
  const p = new Portfolio({ cash: 50 });
  assert.throws(() => p.applyTrade({ t: 0, side: 'buy', asset: 'ATOM', qty: 10, price: 9 }));
});

test('portfolio: sell throws on insufficient balance', () => {
  const p = new Portfolio({ cash: 1000 });
  assert.throws(() => p.applyTrade({ t: 0, side: 'sell', asset: 'ATOM', qty: 10, price: 9 }));
});

test('portfolio: applyTrade rejects negative qty or price', () => {
  const p = new Portfolio({ cash: 1000 });
  assert.throws(() => p.applyTrade({ t: 0, side: 'buy', asset: 'ATOM', qty: -1, price: 9 }));
  assert.throws(() => p.applyTrade({ t: 0, side: 'buy', asset: 'ATOM', qty: 1, price: -9 }));
});

test('portfolio: applyTrade rejects unknown side', () => {
  const p = new Portfolio({ cash: 1000 });
  assert.throws(() => p.applyTrade({ t: 0, side: 'hold', asset: 'ATOM', qty: 1, price: 9 }));
});

test('portfolio: markToMarket computes equity and unrealized P&L', () => {
  const p = new Portfolio({ cash: 1000 });
  p.applyTrade({ t: 0, side: 'buy', asset: 'ATOM', qty: 10, price: 9 });
  const snap = p.markToMarket({ ATOM: 11 });
  assert.equal(snap.cash, 910);
  assert.equal(snap.equity, 910 + 110);
  assert.equal(snap.unrealizedPnL, 110 - 90);
  assert.equal(snap.totalPnL, 20);
  assert.equal(snap.tradeCount, 1);
});

test('portfolio: clone is independent', () => {
  const p = new Portfolio({ cash: 1000 });
  p.applyTrade({ t: 0, side: 'buy', asset: 'ATOM', qty: 10, price: 9 });
  const copy = p.clone();
  copy.applyTrade({ t: 1, side: 'sell', asset: 'ATOM', qty: 5, price: 11 });
  // original unaffected
  assert.equal(p.balances.ATOM, 10);
  assert.equal(p.cash, 910);
  assert.equal(p.realizedPnL, 0);
  // copy mutated
  assert.equal(copy.balances.ATOM, 5);
  assert.equal(copy.realizedPnL, 10);
});
