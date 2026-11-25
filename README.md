# Pump.fun Bot Sprint — Hybrid Paper-Trading Bot

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/aint965/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/aint965/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) — a Solana paper-trading bot for the `agent-fun/replay/v2` pump.fun replay harness.

## Strategy

`main.ts` (Node 22, standard library only, no network, no dependencies) speaks
newline-delimited JSON on stdin/stdout: it reads the `hello` (protocol, seed,
universe, 10 SOL capital, caps, `latency_slots` 2, fees), answers every `batch`
(seq, slot, events, marks, fills, account) with exactly one `reply` echoing
its seq and carrying `orders`, and stops on `done`. Orders decided on the
batch for slot `s` fill at slot `s + latency_slots`, so exits are priced off
the current batch's marks/reserves.

Three signals, one bot:

- **Sniper** — fresh launch (age ≤ 4 slots), creator hasn't sold, creator's own
  buy small, few distinct buyers (no bundle dump), real SOL 0.3–30. Fast exit:
  +12% take-profit, −8% stop, 12-slot max hold.
- **Momentum** — mature curve (age ≥ 300 slots) with accelerating net buy flow
  (≥ 1 SOL net in over 30 slots, ≥ 3 buys from ≥ 4 distinct buyers, price up
  5–50% and within 5% of its window high). Pyramids into strength up to
  0.3 SOL. Exit: −15% stop, 20% trailing stop armed at +5%, 1200-slot max hold.
- **Dip** — curve 25–45% below its 2500-slot high while buyers step back in
  (≥ 3 of the last 6 trades are buys, real SOL ≥ 3). Exit: +15% take-profit,
  −8% stop, 400-slot max hold.

Every held position also exits at once when the creator sells. Round-trip
fees are ~1.25% of trade value plus 105,000 lamports per order, so every stake
is 0.1 SOL and every exit target sits well clear of the fee floor. At most 5
open positions, 2 new entries per batch, 150-slot cooldown per mint, at most 2
entries per mint.

Fully deterministic: no clock, no unseeded randomness (the `hello` seed is
read but the strategy needs none of it), iteration only over insertion-ordered
maps fed by the batch stream — the two graded executions produce
byte-identical action logs.

## Grade locally

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo path> --driver process --worktree
node cli/makefun.mjs grade-local --kit . --bot <repo path> --driver process --worktree --stress --stress-jobs 2
```
