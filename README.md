# Polymarket Odds API — Pay-Per-Call via Circle x402

> Real-time Polymarket prediction market odds. **Any AI agent pays $0.001 USDC per call — no API keys, no sign-ups, no subscriptions.**

Built on [Circle's Arc nanopayments](https://developers.circle.com/gateway/nanopayments/overview) using the x402 protocol.

---

## What This Is

A Node.js/Express API that:
1. Returns **live Yes/No probabilities** from Polymarket's CLOB
2. Is **protected by HTTP 402** — callers must pay $0.001 USDC before receiving data
3. Payments are settled **gaslessly** via Circle Gateway on Arc/Base

This is payment-as-authentication in practice. No auth tokens. No rate limit keys. Just money.

---

## Quickstart

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — set your SELLER_WALLET_ADDRESS and NETWORK
```

### 3. Start the server
```bash
npm start
```

Server runs at **http://localhost:4021**

---

## Endpoints

### `GET /` — Free info page
Returns API metadata, pricing, and endpoint documentation.

```bash
curl http://localhost:4021/
```

### `GET /odds?q=<query>` — Live odds (costs $0.001)
Search for markets and get live Yes/No probabilities.

```bash
# Without payment → HTTP 402
curl http://localhost:4021/odds?q=bitcoin

# With an x402-capable client → pays $0.001, gets data
```

**Response:**
```json
{
  "query": "bitcoin",
  "count": 3,
  "fetched_at": "2026-05-27T13:00:00.000Z",
  "paid": "$0.001",
  "markets": [
    {
      "question": "Will Bitcoin exceed $200K in 2026?",
      "outcomes": [
        { "name": "Yes", "probability": "34.2%" },
        { "name": "No",  "probability": "65.8%" }
      ],
      "volume24h": "128450.00",
      "url": "https://polymarket.com/event/..."
    }
  ]
}
```

### `GET /markets?q=<query>&limit=<n>` — Market discovery (costs $0.001)
Returns raw market list — faster than /odds (no CLOB price lookups).

---

## How x402 Works

```
Agent                    Your API             Circle Gateway
  │                         │                      │
  ├─ GET /odds?q=bitcoin ──►│                      │
  │                         │◄── HTTP 402 ─────────┤
  │                         │    (price, wallet)   │
  │◄── HTTP 402 ────────────┤                      │
  │                         │                      │
  ├─ Pay $0.001 USDC ───────┼─────────────────────►│
  │◄── Payment token ───────┼──────────────────────┤
  │                         │                      │
  ├─ GET /odds (+ token) ──►│                      │
  │                         ├─ Verify token ──────►│
  │                         │◄── Valid ────────────┤
  │◄── 200 + odds data ─────┤                      │
```

---

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 18+ (ESM) |
| Server | Express 4 |
| Payment gate | `x402-express` |
| Data source | Polymarket Gamma API + CLOB API |
| Payment network | Circle Arc (Base Sepolia testnet / Base mainnet) |

---

## Deployment (Railway)

```bash
# Install Railway CLI
npm i -g @railway/cli
railway login
railway init
railway up
```

Then set env vars in Railway dashboard and your API is live globally.

---

## The One-Liner Pitch

> "A Polymarket odds API where any AI agent pays $0.001 USDC to query — zero friction, settled on Arc via Circle's x402 nanopayments."
