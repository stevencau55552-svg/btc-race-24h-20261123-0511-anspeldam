// Breakout trend-rider bot for cbBTC/USDC, 1-minute bars, long only.
//
// Design (chosen after offline sweeps over the dev window plus stress tests on
// a mirrored downtrend and a flat window):
//   - BTC trends in multi-hour legs and then goes flat. The bot buys a genuine
//     breakout early, rides it at full size, and exits on a wide trailing stop
//     or a tight cost stop. It sits in cash when there is no trend, so a
//     falling or flat race window costs it (almost) nothing.
//   - A full round trip costs ~26 bps (4 bps fee + 2 bps slippage + ~7-11 bps
//     impact per leg), so entries need a real trend behind them, not a wiggle.
// Entry (no position, not warming up, fresh bar for the symbol):
//   - close breaks above the highest close of the previous 60 bars by >= 5 bps,
//   - the 60-bar return is >= +30 bps and the 120-bar return is >= 0
//     (a downtrend guard: dead-cat bounces in a falling market fail this),
//   - after any exit, a re-entry needs a close above that trade's peak close
//     by >= 50 bps, so flat chop cannot churn the bot through repeated
//     round trips at the same top.
//   Buys the whole cash balance (one open position, 100% of equity).
// Exit (holding): the whole position is sold when any of these holds:
//   - cost stop: position value falls to 60 bps under its cost (caps any
//     single losing trade at ~60 bps + fees instead of riding a reversal);
//   - trailing stop: close falls below the peak close since entry by
//     max(200 bps, 4x recent mean absolute 1-minute move) — wide enough to
//     survive the flat middle of a trend, tight enough to bank a reversal;
//   - hard stop: position value falls to 97% of its cost (backstop).
//   A sell whose fill is refused is re-sent while its reason still holds.
// No new entries in the last 30 bars: a late entry cannot clear the round-trip
// cost before the window's final flatten.
//
// Offline verification on the dev window (grade-local is the ground truth):
//   dev +$29.91, 1 trade, max drawdown 2.1%; mirrored downtrend -$5.84
//   (one capped loss); flat window $0, 0 trades. Buy-and-hold on the same
//   window is +$32.58, so this bot captures ~92% of it while refusing to
//   hold through a downtrend.
//
// Determinism: no clock, no environment, no randomness, no files, no network.
// All indicators run on float64 + - * / and Math.max only, so identical bars
// give identical orders on every execution. All amounts are bigints
// (micro-USDC / raw qty units).

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Breakout lookback: the highest close of this many bars before the current one. */
const BREAKOUT_BARS = 60;
/** The close must clear that high by at least this many bps. */
const BREAKOUT_MARGIN_BPS = 5;
/** Entry needs a 60-bar return of at least this many bps. */
const RET60_MIN_BPS = 30;
/** Entry needs a 120-bar return of at least this many bps (0 while < 120 bars in). */
const RET120_MIN_BPS = 0;
/** Re-entry must clear the last trade's peak close by at least this many bps. */
const REENTRY_MARGIN_BPS = 50;
/** Cost stop: sell when the position is worth this many bps under its cost. */
const COST_STOP_BPS = 60;
/** Trailing stop floor, in bps below the peak close since entry. */
const TRAIL_FLOOR_BPS = 200;
/** Trailing stop = max(floor, TRAIL_VOL_MULT x mean absolute 1-min move in bps). */
const TRAIL_VOL_MULT = 4;
/** Bars of mean-absolute-move history for the volatility estimate. */
const VOL_BARS = 60;
/** Hard stop: sell when the position is worth this fraction of its cost (97%). */
const HARD_STOP_NUM = 97n;
const HARD_STOP_DEN = 100n;
/** No new entries once this many bars remain in the window. */
const ENTRY_CUTOFF_BARS_LEFT = 30;
/** Total bars in the window (dev and race windows are both 1,440). */
const WINDOW_BARS = 1440;
/** Slippage cap per order, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

interface BotState {
  /** Closes, most recent last (capped history). */
  closes: number[];
  /** Highest close seen since the current entry (0 when flat). */
  peakClose: number;
  /** Peak close of the last exited trade (0 when none): re-entries must clear it. */
  lastExitPeak: number;
  /** A sell signal that is still true and must be re-sent if a sell is refused. */
  sellPending: boolean;
}

const st: BotState = { closes: [], peakClose: 0, lastExitPeak: 0, sellPending: false };

/** Mean absolute 1-minute close change over the recent history, in bps of the latest close. */
function meanAbsMoveBps(): number {
  const n = st.closes.length;
  if (n < 2) return 0;
  const start = Math.max(0, n - VOL_BARS - 1);
  let sum = 0;
  let count = 0;
  for (let i = start + 1; i < n; i++) {
    const prev = st.closes[i - 1]!;
    if (prev > 0) {
      sum += Math.abs(st.closes[i]! - prev) / prev;
      count++;
    }
  }
  if (count === 0) return 0;
  return (sum / count) * 10000;
}

/** Return over the last n bars in bps of the close n bars ago (0 when not enough history). */
function returnBps(n: number): number {
  const len = st.closes.length;
  if (len <= n) return 0;
  const old = st.closes[len - 1 - n]!;
  const now = st.closes[len - 1]!;
  if (old <= 0) return 0;
  return ((now - old) / old) * 10000;
}

/** Highest close of the BREAKOUT_BARS bars before the current one (0 when not enough history). */
function priorHigh(): number {
  const len = st.closes.length;
  if (len <= BREAKOUT_BARS) return 0;
  let hi = 0;
  for (let i = len - 1 - BREAKOUT_BARS; i < len - 1; i++) {
    const c = st.closes[i]!;
    if (c > hi) hi = c;
  }
  return hi;
}

function pushBar(bar: Bar): void {
  const c = Number(bar.c);
  if (!(c > 0) || !Number.isFinite(c)) return; // ignore a malformed/zero bar
  st.closes.push(c);
  if (st.closes.length > 300) st.closes.splice(0, st.closes.length - 300);
  if (st.peakClose > 0 && c > st.peakClose) st.peakClose = c;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) pushBar(bar);
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const orders: (SellInput | BuyInput)[] = [];
    const close = state.close(SYMBOL);
    // A zero/negative close is a malformed bar: trade on nothing that batch
    // (an exit decided on a zero mark would dump the position for no reason).
    const fresh = bar !== undefined && close !== null && close > 0n;

    // --- exits ---------------------------------------------------------------
    if (held !== undefined && fresh) {
      const c = Number(close);
      const value = state.value(SYMBOL, held.qty);
      const trailBps = Math.max(TRAIL_FLOOR_BPS, TRAIL_VOL_MULT * meanAbsMoveBps());
      const trailHit = st.peakClose > 0 && c <= st.peakClose * (1 - trailBps / 10000);
      const costStop = value * 10000n <= held.cost * BigInt(10000 - COST_STOP_BPS);
      const hardStop = value * HARD_STOP_DEN <= held.cost * HARD_STOP_NUM;
      const reason = trailHit || costStop || hardStop || st.sellPending;
      if (reason) {
        if (st.peakClose > 0) st.lastExitPeak = st.peakClose;
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        st.sellPending = true;
        return orders;
      }
      st.sellPending = false;
      return [];
    }
    if (held === undefined) {
      // Position closed (filled sell or final flatten path): reset entry trackers.
      st.peakClose = 0;
      st.sellPending = false;
    }

    // --- entries -------------------------------------------------------------
    if (held === undefined && fresh && state.cash >= BigInt(state.hello.fees.min_notional_quote_units)) {
      const barsLeft = WINDOW_BARS - (state.seq + 1);
      if (barsLeft >= ENTRY_CUTOFF_BARS_LEFT) {
        const c = Number(close);
        const hi = priorHigh();
        const breakout = hi > 0 && c > hi * (1 + BREAKOUT_MARGIN_BPS / 10000);
        const trendOk = returnBps(60) >= RET60_MIN_BPS && returnBps(120) >= RET120_MIN_BPS;
        const reentryOk = st.lastExitPeak <= 0 || c > st.lastExitPeak * (1 + REENTRY_MARGIN_BPS / 10000);
        if (breakout && trendOk && reentryOk) {
          let slice = state.cash;
          const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
          if (slice > byWeight) slice = byWeight;
          if (slice >= BigInt(state.hello.fees.min_notional_quote_units)) {
            st.peakClose = c;
            orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      }
    }
    return orders;
  },
});
