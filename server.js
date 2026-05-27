/**
 * polymarket-odds-api — Arc Edition
 *
 * Pay-per-call Polymarket odds API using Circle's x402 nanopayments on Arc.
 * Callers pay $0.001 USDC on Arc (eip155:5042002). No gas fees.
 *
 * Stack:
 *   - @circle-fin/x402-batching/server  → BatchFacilitatorClient (Circle Gateway)
 *   - Arc Testnet (eip155:5042002)      → Circle's own L1
 *   - USDC on Arc                       → 0x3600...0000
 */

import express from "express";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";

// ── Arc Testnet constants (from Circle's arc-nanopayments SDK) ───────────────
const ARC_NETWORK          = "eip155:5042002";
const ARC_USDC_CONTRACT    = "0x3600000000000000000000000000000000000000";
const ARC_GATEWAY_WALLET   = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

// ── Config ───────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 4021;
const SELLER_ADDRESS = (process.env.SELLER_ADDRESS || "0x3007e7f816469c0c2555f91973f0c2a785c93757");
const PRICE          = "$0.001";

// Parse "$0.001" → USDC atomic units (6 decimals) → "1000"
function toUSDCAtoms(dollarStr) {
  return Math.round(parseFloat(dollarStr.replace("$", "")) * 1_000_000).toString();
}

// ── Circle Gateway facilitator (settles on Arc, zero gas) ────────────────────
const facilitator = new BatchFacilitatorClient();

// ── Payment requirements for a protected route ───────────────────────────────
function buildPaymentRequirements(price = PRICE) {
  return {
    scheme:            "exact",
    network:           ARC_NETWORK,
    asset:             ARC_USDC_CONTRACT,
    amount:            toUSDCAtoms(price),
    payTo:             SELLER_ADDRESS,
    maxTimeoutSeconds: 345600,           // 4 days — Circle Gateway batches within this
    extra: {
      name:              "GatewayWalletBatched",
      version:           "1",
      verifyingContract: ARC_GATEWAY_WALLET,
    },
  };
}

// ── x402 middleware ───────────────────────────────────────────────────────────
// Implements the full x402 handshake:
//   1. No payment header → return HTTP 402 with payment requirements
//   2. Payment header present → verify with Circle Gateway → allow or reject
async function x402Gate(req, res, next) {
  const paymentHeader = req.headers["x-payment"];

  if (!paymentHeader) {
    // Step 1: Return 402 with payment details
    const requirements = buildPaymentRequirements();
    return res.status(402).json({
      x402Version: 1,
      accepts:     [requirements],
      error:       "Payment required",
    });
  }

  // Step 2: Verify payment with Circle Gateway
  try {
    let paymentPayload;
    try {
      paymentPayload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf-8")
      );
    } catch {
      paymentPayload = JSON.parse(paymentHeader);
    }

    const requirements = buildPaymentRequirements();
    const result = await facilitator.verify(paymentPayload, requirements);

    if (!result.isValid) {
      return res.status(402).json({
        x402Version: 1,
        error:       "Payment verification failed",
        detail:      result.invalidReason || "Unknown",
      });
    }

    // Settle (batch on-chain via Circle Gateway)
    await facilitator.settle(paymentPayload, requirements);

    next();
  } catch (err) {
    console.error("[x402] Verification error:", err.message);
    return res.status(402).json({
      x402Version: 1,
      error:       "Payment processing error",
      detail:      err.message,
    });
  }
}

// ── Polymarket helpers ────────────────────────────────────────────────────────
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API  = "https://clob.polymarket.com";

async function searchMarkets(query, limit = 5) {
  const url = new URL(`${GAMMA_API}/markets`);
  url.searchParams.set("_c", query);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  return res.json();
}

async function fetchMidpoint(tokenId) {
  try {
    const res = await fetch(`${CLOB_API}/midpoint?token_id=${encodeURIComponent(tokenId)}`,
      { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const d = await res.json();
    return parseFloat(d.mid) || null;
  } catch { return null; }
}

async function buildOddsPayload(market) {
  let tokens = [];
  try { tokens = JSON.parse(market.clobTokenIds || "[]"); } catch {}
  const yesMid = tokens[0] ? await fetchMidpoint(tokens[0]) : null;
  const noMid  = tokens[1] ? await fetchMidpoint(tokens[1]) : null;
  return {
    id:        market.id,
    question:  market.question,
    category:  market.category || "General",
    endDate:   market.endDate  || null,
    liquidity: market.liquidity  ? parseFloat(market.liquidity).toFixed(2)   : null,
    volume24h: market.volume24hr ? parseFloat(market.volume24hr).toFixed(2) : null,
    outcomes: [
      { name: "Yes", probability: yesMid !== null ? `${(yesMid*100).toFixed(1)}%` : "N/A", tokenId: tokens[0] || null },
      { name: "No",  probability: noMid  !== null ? `${(noMid *100).toFixed(1)}%` : "N/A", tokenId: tokens[1] || null },
    ],
    url: `https://polymarket.com/event/${market.slug || market.id}`,
  };
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

/** GET / — free, describes the API */
app.get("/", (_req, res) => {
  res.json({
    name:        "Polymarket Odds API",
    description: "Real-time Polymarket prediction market odds. Pay $0.001 USDC on Arc.",
    version:     "2.0.0",
    seller:      SELLER_ADDRESS,
    network:     ARC_NETWORK,
    network_name:"Arc Testnet",
    usdc:        ARC_USDC_CONTRACT,
    pricing:     PRICE + " USDC per call (gasless on Arc)",
    gateway:     "Circle Gateway — batched settlement on Arc",
    endpoints: {
      "GET /odds?q=<query>":             "Live Yes/No odds   — $0.001 USDC",
      "GET /markets?q=<query>&limit=n":  "Market discovery   — $0.001 USDC",
    },
    how_to_pay:  "Include X-Payment header with base64-encoded Circle x402 payment payload",
    powered_by:  "Circle Arc Nanopayments + @circle-fin/x402-batching",
  });
});

/** GET /odds?q= — PROTECTED: $0.001 USDC on Arc */
app.get("/odds", x402Gate, async (req, res) => {
  const query = (req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit || "5", 10), 10);
  if (!query) return res.status(400).json({ error: "Missing ?q=", example: "/odds?q=bitcoin" });
  try {
    const markets = await searchMarkets(query, limit);
    if (!markets?.length) return res.json({ query, count: 0, markets: [], paid: PRICE });
    const odds = await Promise.all(markets.map(buildOddsPayload));
    res.json({ query, count: odds.length, fetched_at: new Date().toISOString(),
               network: ARC_NETWORK, paid: PRICE, markets: odds });
  } catch (err) {
    console.error("[/odds]", err.message);
    res.status(502).json({ error: "Failed to fetch Polymarket data", detail: err.message });
  }
});

/** GET /markets?q= — PROTECTED: $0.001 USDC on Arc */
app.get("/markets", x402Gate, async (req, res) => {
  const query = (req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 20);
  if (!query) return res.status(400).json({ error: "Missing ?q=", example: "/markets?q=election" });
  try {
    const markets = await searchMarkets(query, limit);
    res.json({
      query, count: markets.length, fetched_at: new Date().toISOString(),
      network: ARC_NETWORK, paid: PRICE,
      markets: markets.map(m => ({
        id: m.id, question: m.question, category: m.category,
        volume24h: m.volume24hr ? parseFloat(m.volume24hr).toFixed(2) : null,
        liquidity:  m.liquidity  ? parseFloat(m.liquidity).toFixed(2)  : null,
        endDate: m.endDate || null, url: `https://polymarket.com/event/${m.slug || m.id}`,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch markets", detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║       Polymarket Odds API — Arc Edition  v2.0.0              ║
╠══════════════════════════════════════════════════════════════╣
║  Server:   http://localhost:${PORT}                              ║
║  Seller:   ${SELLER_ADDRESS.slice(0,22)}...        ║
║  Network:  Arc Testnet  (${ARC_NETWORK})          ║
║  USDC:     ${ARC_USDC_CONTRACT.slice(0,22)}...        ║
║  Price:    ${PRICE} USDC per call (gasless)            ║
║  Gateway:  Circle Gateway (batched Arc settlement)           ║
╠══════════════════════════════════════════════════════════════╣
║  GET /              — free info                              ║
║  GET /odds?q=       — live odds     [$0.001 Arc USDC]        ║
║  GET /markets?q=    — discovery     [$0.001 Arc USDC]        ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
