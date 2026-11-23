# btc-race-24h-20261123-0511 — breakout trend-rider (anspeldam)

Long-only cbBTC/USDC bot for the make.fun 24h BTC race, account @anspeldam.

## Strategy

- **Entry:** close breaks above the highest close of the previous 60 bars by
  ≥ 5 bps, with the 60-bar return ≥ +30 bps and the 120-bar return ≥ 0
  (downtrend guard). After any exit, a re-entry needs a close above that
  trade's peak by ≥ 50 bps, so flat chop cannot churn round trips.
  Buys 100% of cash.
- **Exit:** cost stop at −60 bps under cost; trailing stop of
  max(200 bps, 4× mean absolute 1-min move) under the peak close since
  entry; hard stop at 97% of cost. A refused sell is re-sent while its
  reason holds. No new entries in the last 30 bars.
- **Costs:** a full round trip pays ~26 bps (4 bps fee + 2 bps slippage +
  ~7–11 bps impact per leg), so entries need a real trend.

## Verified (kit `grade-local`, process driver)

| Check | Result |
|---|---|
| Dev net PnL | **+$29.501082** (1 trade, fees $0.811966) |
| Max drawdown | 1.98% (limit 25%) |
| Determinism | two runs byte-identical (`l1.reproduced: true`) |
| Stress: mirrored downtrend | −$5.84 (one cost-stop-capped loss) |
| Stress: flat window | $0.00, 0 trades |
| Buy-and-hold on same window | +$32.58 (this bot keeps ~90% of it while refusing to hold a downtrend) |

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib via the vendored shim only)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim
- `.makefun/owner.json` — payout wallet `DJbbkgXtmpWzodf8piLKtaqTiWT9j9UMMvUqdee4hWX1`
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`)
