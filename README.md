# Kekius Maximus — Drip

A simple claim tool in the spirit of the original 2010 Bitcoin faucet.

**50 KEKIUS every 24 hours. No signup. Just connect + sign.**

## Features

- Clean green + gold theme with the provided Pepe logo
- **Cinzel** serif font for “Kekius Maximus”
- Contract: `0xAE1EDabaC9a0DDa644B2F7Ec48759d37Ab257f78`
- 50 tokens per address per 24 hours
- Wallet signature required (strong protection against IP rotation + address spam)
- 5-minute signature expiry (anti-replay)
- Device fingerprint soft limit
- CAPTCHA + IP rate limiting
- Real backend that can send actual ERC-20 transfers

## Quick start (Demo mode)

```bash
cd kekius-faucet
npm install
npm start
```

Open http://localhost:3000

In demo mode the server records claims but does **not** send real tokens.

## Go LIVE (real transfers)

1. Create a **brand new wallet** and put only a small amount of KEKIUS + a little ETH in it.
2. Copy `.env.example` → `.env`
3. Set:

```
PRIVATE_KEY=0x...
RPC_URL=https://your-alchemy-or-infura-url
```

4. Restart the server.

The status badge will switch from **DEMO** to **LIVE**.

## Hosting on GitHub + Vercel

See the full beginner-friendly guide:

**[HOSTING.md](./HOSTING.md)**

It walks you through:
- Uploading the code to GitHub
- Deploying on Vercel
- Safely adding your private key as an environment variable
- Testing the live site

## Security summary

| Protection | What it does |
|------------|--------------|
| Private key only in env vars | Never in code or GitHub |
| Wallet signature required | Stops people from claiming to addresses they don’t control |
| 5-minute signature expiry | Stops replaying old signatures |
| 24h cooldown per address | One claim per wallet per day |
| Device fingerprint limit | Limits how many addresses one browser can claim |
| IP rate limiting | Stops rapid-fire requests |
| Dedicated low-balance hot wallet | Limits damage if something goes wrong |

**Golden rule:** Never put your private key in the frontend or commit it to GitHub.

## Token

- **Name**: Kekius Maximus  
- **Symbol**: KEKIUS  
- **Contract**: `0xAE1EDabaC9a0DDa644B2F7Ec48759d37Ab257f78`  
- **Decimals**: 9  

## Files

| File | Purpose |
|------|---------|
| `index.html` | Frontend |
| `server.js` | Backend + claim logic |
| `logo.jpg` | Pepe logo |
| `HOSTING.md` | Step-by-step GitHub + Vercel guide |
| `.env.example` | Environment template |
| `.gitignore` | Blocks secrets from being uploaded |

Inspired by Gavin Andresen’s original Bitcoin faucet.
