// Pump.fun Bot Sprint entry — hybrid paper-trading bot for agent-fun/replay/v2.
//
// Strategy (all decisions are pure functions of the hello + batch stream; no
// clock, no unseeded randomness, no I/O, no network — the two graded runs
// produce byte-identical action logs):
//
//   A. Sniper: buy a fresh launch (age <= 4 slots) only when the creator has
//      not sold, few distinct non-creator buyers have piled in (not a bundle
//      dump in waiting), real SOL is 0.3–30, and the creator's own buy is
//      small. Fast exit: +12% take-profit, -8% stop, 12-slot max hold.
//   B. Momentum: buy a mature curve (age >= 300 slots) on accelerating net
//      buy flow — net SOL in over 30 slots >= 1, >= 3 buys from >= 4 distinct
//      buyers, price up 5–50% and within 5% of its window high, newer-half
//      inflow beating the older half. Pyramid into strength up to 0.3 SOL.
//      Exit: -15% stop, 20% trailing stop armed at +5%, 1200-slot max hold.
//   C. Dip: buy a curve 25–45% below its 2500-slot high while buyers are
//      still stepping in (last trades mostly buys, real SOL >= 3).
//      Exit: +15% take-profit, -8% stop, 400-slot max hold.
//
// Every exit also fires at once when the creator sells while held. Fees are
// ~1.25% of trade value per round trip plus 105,000 lamports per order, so
// every stake is 0.1 SOL (tx fees ~0.1% of stake) and every exit target is
// sized well clear of the round-trip fee. At most 5 open positions, at most
// 2 new entries per batch, 150-slot cooldown per mint after an exit, at most
// 2 entries per mint per run.
//
// Wire: the harness speaks newline-delimited JSON on stdin — one `hello`
// (protocol agent-fun/replay/v2, seed, universe, capital 10 SOL, caps,
// latency_slots 2, fees), then `batch` messages (seq, slot, events, marks,
// fills, account), then `done`. This bot replies on stdout with exactly one
// `reply` per batch, echoing its seq and carrying `orders` (buy:
// side/client_id/mint/quote_lamports/max_slippage_bps; sell:
// side/client_id/mint/token_amount/max_slippage_bps). Orders decided on the
// batch for slot s fill at slot s + latency_slots, so every exit is computed
// from the marks/reserves of the current batch, not from a stale price.

import * as readline from "node:readline";

const LAMPORTS = 1_000_000_000;
const LAMPORTS_BIG = 1_000_000_000n;
const CURVE_FEE_BPS = 125; // protocol 95 + creator 30 bps per trade
const BPS = 10_000;

// ---------------------------------------------------------------- tunables
const P = {
  // stake
  stakeSol: 0.1,
  pyramidMaxSol: 0.3,
  addSol: 0.1,
  minBuySol: 0.02,
  // sniper
  sniperMaxAge: 4,
  sniperMinRqSol: 0.3,
  sniperMaxRqSol: 30,
  sniperMaxDevBuySol: 2.5,
  sniperMaxBuyers: 4,
  sniperTp: 0.12,
  sniperSl: 0.08,
  sniperMaxHold: 12,
  // momentum
  momMinAge: 300,
  momWindow: 30,
  momMinNetSol: 1,
  momMinBuys: 3,
  momMinBuyers: 4,
  momMinUp: 0.05,
  momMaxUp: 0.5,
  momNearHigh: 0.95,
  momMinRqSol: 2,
  momMaxRqSol: 60,
  momSl: 0.15,
  momTrail: 0.2,
  momTrailArm: 0.05,
  momMaxHold: 1200,
  // dip
  dipWindow: 2500,
  dipMin: 0.25,
  dipMax: 0.45,
  dipMinRqSol: 3,
  dipTp: 0.15,
  dipSl: 0.08,
  dipMaxHold: 400,
  // shared
  cooldown: 150,
  maxEntriesPerMint: 2,
  maxEntriesPerBatch: 2,
  buySlipBps: 1500,
  sellSlipBps: 10_000,
  maxOpen: 5,
};

type Pubkey = string;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  createdSlot: number | null;
  creator: string | null;
  vq0: number;
  vt0: number;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<string>;
  trades: Trade[];
  entries: number;
  lastExitSlot: number;
  complete: boolean;
  realSol: number;
  vq: number;
  vt: number;
}

interface Held {
  kind: "sniper" | "momentum" | "dip";
  openedSlot: number;
  investedSol: number;
  peakValueSol: number;
  lastAddPrice: number;
  exiting: boolean;
  filled: boolean;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const pending = new Map<string, { mint: Pubkey; side: string }>();
const positions = new Map<Pubkey, { tokens: bigint; costSol: number }>();
let cashSol = 10;
let nextClient = 1;
let txFeeSol = 0.000105;
let maxOpen = P.maxOpen;
let maxOrdersPerBatch = 16;
let maxBuyBps = 100;

function coinOf(mint: Pubkey): Coin {
  let c = coins.get(mint);
  if (!c) {
    c = {
      createdSlot: null, creator: null, vq0: 0, vt0: 1, devBuySol: 0,
      devSold: false, buyers: new Set(), trades: [], entries: 0,
      lastExitSlot: -1e12, complete: false, realSol: 0, vq: 0, vt: 1,
    };
    coins.set(mint, c);
  }
  return c;
}

function priceOf(c: Coin): number {
  return c.vt > 0 ? c.vq / c.vt : 0;
}

/** Net SOL a sale of `tokens` against (vq, vt) pays after curve fees, minus one tx fee. */
function sellValueSol(tokens: bigint, vq: number, vt: number): number {
  if (tokens <= 0n || vt <= 0) return 0;
  const t = Number(tokens);
  const gross = (t * vq) / (vt + t) / LAMPORTS;
  return gross * (1 - CURVE_FEE_BPS / BPS) - txFeeSol;
}

function flowNet(c: Coin, now: number, w: number): number {
  let net = 0;
  for (let i = c.trades.length - 1; i >= 0; i--) {
    const tr = c.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

function onBatch(batch: any): any[] {
  const now: number = batch.slot;
  const orders: any[] = [];
  const cap = maxOrdersPerBatch;

  // --- fold fills: drop pending, note harness closes (_complete/_flatten/_writeoff)
  for (const f of batch.fills ?? []) {
    pending.delete(f.client_id);
    if (typeof f.client_id === "string" && f.client_id.startsWith("_")) {
      const h = held.get(f.mint);
      if (h) { held.delete(f.mint); coinOf(f.mint).lastExitSlot = now; }
    }
  }
  // --- fold account
  cashSol = Number(batch.account?.cash_lamports ?? 0) / LAMPORTS;
  positions.clear();
  for (const p of batch.account?.positions ?? []) {
    const tokens = BigInt(p.token_amount);
    if (tokens > 0n) positions.set(p.mint, { tokens, costSol: Number(p.cost_lamports) / LAMPORTS });
  }
  // --- fold marks (latest reserves for held / pending mints)
  const marks = new Map<string, { vq: number; vt: number; rq: number }>();
  for (const m of batch.marks ?? []) {
    marks.set(m.mint, {
      vq: Number(m.virtual_quote_reserves), vt: Number(m.virtual_token_reserves),
      rq: Number(m.real_quote_reserves) / LAMPORTS,
    });
    const c = coinOf(m.mint);
    c.vq = Number(m.virtual_quote_reserves); c.vt = Number(m.virtual_token_reserves);
    c.realSol = Number(m.real_quote_reserves) / LAMPORTS;
  }
  // --- fold events
  const traded = new Set<Pubkey>();
  for (const e of batch.events ?? []) {
    if (e.event === "CreateEvent") {
      const c = coinOf(e.mint);
      c.createdSlot = e.slot;
      c.creator = e.creator;
      c.vq0 = Number(e.virtual_quote_reserves);
      c.vt0 = Number(e.virtual_token_reserves);
      c.vq = c.vq0; c.vt = c.vt0;
    } else if (e.event === "TradeEvent") {
      const c = coinOf(e.mint);
      const sol = Number(e.sol_amount) / LAMPORTS;
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
      c.vq = Number(e.virtual_quote_reserves); c.vt = Number(e.virtual_token_reserves);
      c.realSol = Number(e.real_quote_reserves) / LAMPORTS;
      if (e.is_buy) {
        if (c.creator !== null && e.user === c.creator && c.createdSlot !== null && e.slot === c.createdSlot) c.devBuySol += sol;
        else if (c.creator === null || e.user !== c.creator) c.buyers.add(e.user);
      } else if (c.creator !== null && e.user === c.creator) {
        c.devSold = true;
      }
      traded.add(e.mint);
    } else if (e.event === "CompleteEvent") {
      const c = coinOf(e.mint);
      c.complete = true;
      held.delete(e.mint);
    }
  }
  // prune old trades (keep dip window + margin)
  for (const mint of traded) {
    const c = coins.get(mint)!;
    let cut = 0;
    while (cut < c.trades.length && c.trades[cut]!.slot <= now - (P.dipWindow + 5)) cut++;
    if (cut > 0) c.trades.splice(0, cut);
  }

  const pendingByMint = new Map<Pubkey, number>();
  for (const po of pending.values()) pendingByMint.set(po.mint, (pendingByMint.get(po.mint) ?? 0) + 1);
  const pendingSell = new Set<Pubkey>();
  for (const po of pending.values()) if (po.side === "sell") pendingSell.add(po.mint);

  const reservesOf = (mint: Pubkey): { vq: number; vt: number } => {
    const m = marks.get(mint);
    if (m) return { vq: m.vq, vt: m.vt };
    const c = coins.get(mint);
    return c ? { vq: c.vq, vt: c.vt } : { vq: 0, vt: 1 };
  };

  // --- exits first
  for (const [mint, h] of held) {
    const pos = positions.get(mint);
    const c = coins.get(mint);
    if (!pos) {
      if (!pendingByMint.has(mint)) { held.delete(mint); if (h.filled && c) c.lastExitSlot = now; }
      continue;
    }
    h.filled = true;
    if (!c || c.complete) continue;
    const { vq, vt } = reservesOf(mint);
    const value = sellValueSol(pos.tokens, vq, vt);
    if (value > h.peakValueSol) h.peakValueSol = value;
    const cost = pos.costSol;
    let exit = h.exiting;
    if (!exit && c.devSold) exit = true;
    if (h.kind === "sniper") {
      if (!exit && value >= cost * (1 + P.sniperTp)) exit = true;
      if (!exit && value <= cost * (1 - P.sniperSl)) exit = true;
      if (!exit && now - h.openedSlot >= P.sniperMaxHold) exit = true;
    } else if (h.kind === "momentum") {
      if (!exit && value <= cost * (1 - P.momSl)) exit = true;
      if (!exit && h.peakValueSol >= cost * (1 + P.momTrailArm) && value <= h.peakValueSol * (1 - P.momTrail)) exit = true;
      if (!exit && now - h.openedSlot >= P.momMaxHold && value < cost * 1.05) exit = true;
    } else {
      if (!exit && value >= cost * (1 + P.dipTp)) exit = true;
      if (!exit && value <= cost * (1 - P.dipSl)) exit = true;
      if (!exit && now - h.openedSlot >= P.dipMaxHold) exit = true;
    }
    if (!exit) continue;
    h.exiting = true;
    if (pendingSell.has(mint)) continue;
    if (orders.length >= cap) break;
    const id = `o${nextClient++}`;
    orders.push({ side: "sell", client_id: id, mint, token_amount: pos.tokens.toString(), max_slippage_bps: P.sellSlipBps });
    pending.set(id, { mint, side: "sell" });
  }

  // --- entries
  let freeSol = cashSol;
  for (const po of pending.values()) {
    freeSol -= txFeeSol;
    // pending buys reserve their quote; pending sells free nothing yet (tokens still held)
    // (cash already reflects filled buys only, so subtract pending buy amounts via stored orders is
    // not possible here — approximate with the stake size per pending buy)
    if (po.side === "buy") freeSol -= P.stakeSol;
  }
  let openSlots = maxOpen - new Set([...positions.keys(), ...[...pending.values()].filter((p) => p.side === "buy").map((p) => p.mint)]).size;
  let entriesThisBatch = 0;

  const tryBuy = (mint: Pubkey, amountSol: number, kind: Held["kind"]): boolean => {
    if (entriesThisBatch >= P.maxEntriesPerBatch || orders.length >= cap) return false;
    const isNew = !held.has(mint);
    if (isNew && openSlots <= 0) return false;
    const c = coins.get(mint)!;
    const capSol = Math.floor((c.realSol * maxBuyBps) / BPS * LAMPORTS) / LAMPORTS;
    let amount = Math.min(amountSol, capSol);
    if (amount > freeSol - txFeeSol) amount = freeSol - txFeeSol;
    if (amount < P.minBuySol) return false;
    const lamports = BigInt(Math.floor(amount * LAMPORTS));
    if (lamports <= 0n) return false;
    const id = `o${nextClient++}`;
    orders.push({ side: "buy", client_id: id, mint, quote_lamports: lamports.toString(), max_slippage_bps: P.buySlipBps });
    pending.set(id, { mint, side: "buy" });
    freeSol -= amount + txFeeSol;
    entriesThisBatch++;
    const h = held.get(mint);
    if (!h) {
      held.set(mint, { kind, openedSlot: now, investedSol: amount, peakValueSol: 0, lastAddPrice: priceOf(c), exiting: false, filled: false });
      c.entries++;
      openSlots--;
    } else {
      h.investedSol += amount;
      h.lastAddPrice = priceOf(c);
    }
    return true;
  };

  // momentum pyramids first (add to winners before opening new coins)
  for (const [mint, h] of held) {
    if (h.kind !== "momentum" || h.exiting || !h.filled) continue;
    if (h.investedSol >= P.pyramidMaxSol - P.minBuySol) continue;
    if (pendingByMint.has(mint)) continue;
    const c = coins.get(mint);
    const pos = positions.get(mint);
    if (!c || !pos || c.complete) continue;
    if (c.realSol > P.momMaxRqSol) continue;
    const price = priceOf(c);
    if (price < h.lastAddPrice) continue;
    const { vq, vt } = reservesOf(mint);
    const value = sellValueSol(pos.tokens, vq, vt);
    if (value < pos.costSol) continue;
    if (flowNet(c, now, P.momWindow) < P.momMinNetSol) continue;
    tryBuy(mint, Math.min(P.addSol, P.pyramidMaxSol - h.investedSol), "momentum");
  }

  // new entries, in first-seen coin order (deterministic)
  for (const mint of traded) {
    if (entriesThisBatch >= P.maxEntriesPerBatch || orders.length >= cap) break;
    if (held.has(mint) || pendingByMint.has(mint)) continue;
    const c = coins.get(mint)!;
    if (c.complete) continue;
    if (c.entries >= P.maxEntriesPerMint || now - c.lastExitSlot < P.cooldown) continue;
    const age = c.createdSlot === null ? 1e9 : now - c.createdSlot;
    const price = priceOf(c);

    // A. sniper — fresh launch, clean creator, uncrowded
    if (age <= P.sniperMaxAge && age >= 0) {
      if (
        !c.devSold && c.devBuySol <= P.sniperMaxDevBuySol &&
        c.buyers.size <= P.sniperMaxBuyers &&
        c.realSol >= P.sniperMinRqSol && c.realSol <= P.sniperMaxRqSol
      ) {
        if (tryBuy(mint, P.stakeSol, "sniper")) continue;
      }
      continue;
    }

    // B. momentum — mature curve, accelerating inflow near its high
    if (age >= P.momMinAge && c.realSol >= P.momMinRqSol && c.realSol <= P.momMaxRqSol) {
      const from = now - P.momWindow;
      const mid = now - P.momWindow / 2;
      let buySol = 0, sellSol = 0, buys = 0, netOld = 0, netNew = 0;
      let startPrice = -1, high = 0, last = 0;
      const byUser = new Set<string>();
      for (const tr of c.trades) {
        if (tr.slot <= from) { startPrice = tr.price; continue; }
        if (startPrice < 0) startPrice = tr.price;
        const signed = tr.buy ? tr.sol : -tr.sol;
        if (tr.slot <= mid) netOld += signed; else netNew += signed;
        if (tr.buy) { buySol += tr.sol; buys++; byUser.add(tr.user); } else sellSol += tr.sol;
        if (tr.price > high) high = tr.price;
        last = tr.price;
      }
      const net = buySol - sellSol;
      if (
        buys >= P.momMinBuys && byUser.size >= P.momMinBuyers && net >= P.momMinNetSol &&
        startPrice > 0 && last / startPrice - 1 >= P.momMinUp && last / startPrice - 1 <= P.momMaxUp &&
        last >= high * P.momNearHigh && netNew > 0 && netNew >= netOld
      ) {
        if (tryBuy(mint, P.stakeSol, "momentum")) continue;
      }
    }

    // C. dip — sharp drawdown from a 2500-slot high, buyers stepping back in
    if (age >= P.momMinAge && c.realSol >= P.dipMinRqSol) {
      let high = 0;
      for (const tr of c.trades) if (tr.slot > now - P.dipWindow && tr.price > high) high = tr.price;
      if (high > 0) {
        const dd = 1 - price / high;
        if (dd >= P.dipMin && dd <= P.dipMax) {
          let buys = 0, n = 0;
          for (let i = c.trades.length - 1; i >= 0 && n < 6; i--, n++) if (c.trades[i]!.buy) buys++;
          if (n >= 4 && buys >= 3) {
            if (tryBuy(mint, P.stakeSol, "dip")) continue;
          }
        }
      }
    }
  }

  return orders;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { process.exitCode = 1; throw new Error("bad JSON line from harness"); }
    if (msg.type === "hello") {
      if (msg.protocol !== "agent-fun/replay/v2") throw new Error("unsupported protocol");
      cashSol = Number(msg.capital?.lamports ?? 10_000_000_000) / LAMPORTS;
      maxOpen = msg.caps?.max_open_positions ?? P.maxOpen;
      maxOrdersPerBatch = msg.caps?.max_orders_per_batch ?? 16;
      maxBuyBps = msg.caps?.max_order_bps_of_real_reserve ?? 100;
      txFeeSol = (Number(msg.fees?.base_fee_lamports ?? 5000) + Number(msg.fees?.priority_fee_lamports ?? 100000)) / LAMPORTS;
      // hello.seed is the only sanctioned randomness source; this bot is fully
      // deterministic and needs none of it.
    } else if (msg.type === "batch") {
      const orders = onBatch(msg);
      process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
    } else if (msg.type === "done") {
      break;
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
