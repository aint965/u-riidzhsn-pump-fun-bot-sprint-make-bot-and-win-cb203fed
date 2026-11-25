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

- **Sniper** — disabled in the final build: on its own it loses −0.40 SOL,
  and combined with the dip signal it drags the total to −0.65 SOL (the two
  signals compete for the same 5 position slots). Code path kept for research.
- **Momentum** — disabled: ablation showed it loses −3.00 SOL on the dev
  window (13% win rate), so it is not traded. The code path stays for research.
- **Dip** — established curve (real SOL ≥ 10) 8–20% below its 500-slot high
  while buyers step back in (≥ 4 of the last 6 trades are buys, latest print a
  buy, price already recovering ≥ 2% off its 50-slot low). Exit: +8%
  take-profit, −6% stop, 10% trailing stop armed at +5%, 300-slot max hold.

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
