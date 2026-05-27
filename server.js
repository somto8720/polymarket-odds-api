/**
 * polymarket-odds-api
 *
 * A pay-per-call API returning real-time Polymarket prediction market odds.
 * Protected by Circle's x402 nanopayment protocol — callers pay $0.001 USDC per request.
 *
 * Flow:
 *   1. Agent calls GET /odds?q=<search term>
 *   2. Server returns HTTP 402 with payment details (price, wallet, network)
 *   3. x402-capable client pays $0.001 USDC automatically via Circle Gateway
 *   4. Client retries with payment proof header
 *   5. Server validates payment, fetches Polymarket data, returns odds
 */

import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// ── Config ──────────────────────────────────────────────────────────────────
const PORT             = process.env.PORT || 4021;
const SELLER_ADDRESS   = process.env.SELLER_WALLET_ADDRESS || "0x3007e7f816469c0c2555f91973f0c2a785c93757";
const PRICE_PER_CALL   = "$0.001";

// Network: eip155:84532 = Base Sepolia (testnet), eip155:8453 = Base (mainnet)
const NETWORK = process.env.NETWORK === "base" ? "eip155:8453" : "eip155:84532";

// x402 facilitator — verifies and settles payments
// Coinbase-hosted public facilitator (verifies & settles payments)
const FACILITATOR_URL = "https://x402.org/facilitator";

// ── Polymarket helpers ───────────────────────────────────────────────────────
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
  if (!res.ok) throw new Error(`Gamma API ${res.status}: ${res.statusText}`);
  return res.json();
}

async function fetchMidpoint(tokenId) {
  try {
    const res = await fetch(
      `${CLOB_API}/midpoint?token_id=${encodeURIComponent(tokenId)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return parseFloat(data.mid) || null;
  } catch {
    return null;
  }
}

async function buildOddsPayload(market) {
  let tokens = [];
  try { tokens = JSON.parse(market.clobTokenIds || "[]"); } catch { tokens = []; }

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
      { name: "Yes", probability: yesMid !== null ? `${(yesMid * 100).toFixed(1)}%` : "N/A", tokenId: tokens[0] || null },
      { name: "No",  probability: noMid  !== null ? `${(noMid  * 100).toFixed(1)}%` : "N/A", tokenId: tokens[1] || null },
    ],
    url: `https://polymarket.com/event/${market.slug || market.id}`,
  };
}

// ── x402 setup ───────────────────────────────────────────────────────────────
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer    = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme());

const routeConfig = {
  "GET /odds": {
    accepts: {
      scheme:  "exact",
      price:   PRICE_PER_CALL,
      network: NETWORK,
      payTo:   SELLER_ADDRESS,
    },
    description: "Real-time Polymarket prediction market odds — $0.001 USDC per call",
  },
  "GET /markets": {
    accepts: {
      scheme:  "exact",
      price:   PRICE_PER_CALL,
      network: NETWORK,
      payTo:   SELLER_ADDRESS,
    },
    description: "Polymarket market discovery — $0.001 USDC per call",
  },
};

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();

// Apply x402 payment gate — unprotected calls get HTTP 402
// syncFacilitatorOnStart=false: server boots without blocking on facilitator network call
app.use(paymentMiddleware(routeConfig, resourceServer, undefined, undefined, false));

// ── Routes ───────────────────────────────────────────────────────────────────

/** GET / — free info page */
app.get("/", (_req, res) => {
  res.json({
    name:        "Polymarket Odds API",
    description: "Real-time prediction market odds. Pay $0.001 USDC per call via x402.",
    version:     "1.0.0",
    seller:      SELLER_ADDRESS,
    network:     NETWORK,
    pricing:     PRICE_PER_CALL + " USDC per call",
    facilitator: FACILITATOR_URL,
    endpoints: {
      "GET /odds?q=<query>":           "Live Yes/No odds   — $0.001 USDC",
      "GET /markets?q=<query>&limit=n":"Market discovery   — $0.001 USDC",
    },
    powered_by: "Circle x402 Nanopayments on Arc",
  });
});

/** GET /odds?q=<query> — PROTECTED: costs $0.001 USDC */
app.get("/odds", async (req, res) => {
  const query = (req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit || "5", 10), 10);

  if (!query) {
    return res.status(400).json({ error: "Missing ?q=<query>", example: "/odds?q=bitcoin" });
  }

  try {
    const markets = await searchMarkets(query, limit);
    if (!markets?.length) {
      return res.json({ query, count: 0, markets: [], paid: PRICE_PER_CALL });
    }
    const odds = await Promise.all(markets.map(buildOddsPayload));
    res.json({
      query,
      count:      odds.length,
      fetched_at: new Date().toISOString(),
      paid:       PRICE_PER_CALL,
      powered_by: "Polymarket CLOB + Circle x402",
      markets:    odds,
    });
  } catch (err) {
    console.error("[/odds]", err.message);
    res.status(502).json({ error: "Failed to fetch Polymarket data", detail: err.message });
  }
});

/** GET /markets?q=<query> — PROTECTED: costs $0.001 USDC */
app.get("/markets", async (req, res) => {
  const query = (req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 20);

  if (!query) {
    return res.status(400).json({ error: "Missing ?q=<query>", example: "/markets?q=election" });
  }

  try {
    const markets = await searchMarkets(query, limit);
    res.json({
      query,
      count:      markets.length,
      fetched_at: new Date().toISOString(),
      paid:       PRICE_PER_CALL,
      markets:    markets.map((m) => ({
        id:        m.id,
        question:  m.question,
        category:  m.category,
        volume24h: m.volume24hr ? parseFloat(m.volume24hr).toFixed(2) : null,
        liquidity: m.liquidity  ? parseFloat(m.liquidity).toFixed(2)  : null,
        endDate:   m.endDate   || null,
        url:       `https://polymarket.com/event/${m.slug || m.id}`,
      })),
    });
  } catch (err) {
    console.error("[/markets]", err.message);
    res.status(502).json({ error: "Failed to fetch markets", detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  // Initialize x402 resource server — fetches supported payment kinds from facilitator
  console.log(`[x402] Connecting to facilitator at ${FACILITATOR_URL} ...`);
  try {
    await resourceServer.initialize();
    console.log(`[x402] Facilitator ready. Payment gate active on ${NETWORK}.`);
  } catch (err) {
    console.warn(`[x402] WARNING: Facilitator init failed (${err.message}). 402 responses may not work until resolved.`);
  }

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║            Polymarket Odds API — x402 Edition                ║
╠══════════════════════════════════════════════════════════════╣
║  Server:      http://localhost:${PORT}                           ║
║  Seller:      ${SELLER_ADDRESS.slice(0, 22)}...      ║
║  Network:     ${NETWORK.padEnd(46)} ║
║  Price:       ${PRICE_PER_CALL.padEnd(46)} ║
║  Facilitator: ${FACILITATOR_URL.padEnd(46)} ║
╠══════════════════════════════════════════════════════════════╣
║  GET /              — free info (no payment)                 ║
║  GET /odds?q=       — live odds     [$0.001 USDC]            ║
║  GET /markets?q=    — discovery     [$0.001 USDC]            ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });
}

start();
