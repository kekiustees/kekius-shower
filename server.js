/**
 * Kekius Maximus – Shower Backend
 * --------------------------------
 * ONE claim per address every 24 hours.
 *
 * Primary cooldown store (required for reliable production on Vercel):
 *   Upstash Redis (free) via REST API
 *   Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *
 * Without Redis, cooldown is best-effort only and double claims can happen
 * on serverless hosts.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ============ CONFIG ============
const TOKEN_ADDRESS = "0xAE1EDabaC9a0DDa644B2F7Ec48759d37Ab257f78";
const CLAIM_AMOUNT = 50n;
const TOKEN_DECIMALS = 9;
const COOLDOWN_SEC = 24 * 60 * 60; // 24 hours in seconds (for Redis TTL)
const COOLDOWN_MS = COOLDOWN_SEC * 1000;
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const CLAIMS_FILE = path.join(__dirname, "claims.json");

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const hasRedis = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const inflight = new Set();

let provider = null;
let wallet = null;
let token = null;
let isLive = false;

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

function safeError(msg) {
  return { error: msg };
}

function claimKey(address) {
  return `shower:claim:${address.toLowerCase()}`;
}

// ============ REDIS (Upstash REST) ============
async function redisCommand(...args) {
  if (!hasRedis) return null;
  const res = await fetch(`${UPSTASH_URL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.result;
}

/** Returns true if this address already claimed within 24h */
async function redisHasClaimed(address) {
  const val = await redisCommand("GET", claimKey(address));
  return val != null && val !== "";
}

/**
 * Reserve a claim slot (SET if Not eXists + 24h expiry).
 * Returns true if reservation succeeded (first claim).
 * Returns false if already reserved / claimed.
 */
async function redisReserveClaim(address) {
  // SET key value NX EX 86400
  const result = await redisCommand(
    "SET",
    claimKey(address),
    String(Date.now()),
    "NX",
    "EX",
    String(COOLDOWN_SEC)
  );
  // Upstash returns "OK" if set, null if key already existed
  return result === "OK";
}

async function redisReleaseClaim(address) {
  try {
    await redisCommand("DEL", claimKey(address));
  } catch (e) {
    console.error("Failed to release claim reservation:", e.message);
  }
}

// ============ FILE FALLBACK (local/demo only) ============
function loadClaims() {
  try {
    if (fs.existsSync(CLAIMS_FILE)) {
      return JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveClaims(claims) {
  try {
    const tmp = CLAIMS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(claims, null, 2));
    fs.renameSync(tmp, CLAIMS_FILE);
  } catch {}
}

function fileHasClaimed(address) {
  const claims = loadClaims();
  const row = claims[address.toLowerCase()];
  if (!row) return false;
  return Date.now() - row.time < COOLDOWN_MS;
}

function fileReserveClaim(address) {
  const claims = loadClaims();
  const key = address.toLowerCase();
  if (claims[key] && Date.now() - claims[key].time < COOLDOWN_MS) {
    return false;
  }
  claims[key] = { time: Date.now(), amount: Number(CLAIM_AMOUNT) };
  saveClaims(claims);
  return true;
}

// ============ INIT WALLET ============
async function initWallet() {
  if (!PRIVATE_KEY || PRIVATE_KEY.length < 64) {
    console.log("⚠  No PRIVATE_KEY → DEMO mode");
    return;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY) && !/^[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
    console.error("PRIVATE_KEY format invalid");
    return;
  }
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, wallet);
    const bal = await token.balanceOf(wallet.address);
    const ethBal = await provider.getBalance(wallet.address);
    console.log("✓ LIVE mode");
    console.log("  Wallet :", wallet.address);
    console.log("  KEKIUS :", ethers.formatUnits(bal, TOKEN_DECIMALS));
    console.log("  ETH    :", ethers.formatEther(ethBal));
    isLive = true;
  } catch (err) {
    console.error("Wallet init failed:", err.message);
  }
}

// ============ MIDDLEWARE ============
app.use(cors({
  origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN,
  methods: ["GET", "POST"],
  maxAge: 86400
}));
app.use(express.json({ limit: "8kb" }));
app.use(express.static(__dirname, {
  maxAge: "1d",
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) {
      res.setHeader("Content-Type", "image/jpeg");
    }
  }
}));
app.get("/logo.jpg", (req, res) => {
  res.sendFile(path.join(__dirname, "logo.jpg"));
});

app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: safeError("Too many requests. Slow down.")
}));

const claimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  message: safeError("Too many claim attempts from this IP.")
});

// ============ ROUTES ============
app.get("/api/status", async (req, res) => {
  let pool = "unknown";
  if (isLive && token && wallet) {
    try {
      const bal = await token.balanceOf(wallet.address);
      pool = ethers.formatUnits(bal, TOKEN_DECIMALS);
    } catch {}
  }
  res.json({
    live: isLive,
    claimAmount: Number(CLAIM_AMOUNT),
    cooldownHours: 24,
    token: TOKEN_ADDRESS,
    pool,
    cooldownStore: hasRedis ? "redis" : "file-only (not reliable on Vercel)",
    redisConfigured: hasRedis
  });
});

app.post("/api/claim", claimLimiter, async (req, res) => {
  let reservedAddress = null;
  let usedRedis = false;

  try {
    const { address, signature, message, fingerprint } = req.body || {};

    if (!address || typeof address !== "string" || !ethers.isAddress(address)) {
      return res.status(400).json(safeError("Invalid Ethereum address"));
    }
    if (!signature || typeof signature !== "string" || signature.length > 200) {
      return res.status(400).json(safeError("Invalid signature"));
    }
    if (!message || typeof message !== "string" || message.length > 500) {
      return res.status(400).json(safeError("Invalid message"));
    }

    const key = address.toLowerCase();

    if (inflight.has(key)) {
      return res.status(429).json(safeError("Claim already in progress. Wait a moment."));
    }
    inflight.add(key);

    // Signature checks
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch {
      inflight.delete(key);
      return res.status(400).json(safeError("Signature verification failed"));
    }
    if (recovered.toLowerCase() !== key) {
      inflight.delete(key);
      return res.status(400).json(safeError("Signature does not match address"));
    }
    if (!message.includes(address) || !message.includes("Shower")) {
      inflight.delete(key);
      return res.status(400).json(safeError("Invalid claim message"));
    }
    const tsMatch = message.match(/Timestamp:\s*(\d+)/);
    if (!tsMatch) {
      inflight.delete(key);
      return res.status(400).json(safeError("Missing timestamp in message"));
    }
    const msgTime = parseInt(tsMatch[1], 10);
    if (isNaN(msgTime) || Math.abs(Date.now() - msgTime) > SIGNATURE_MAX_AGE_MS) {
      inflight.delete(key);
      return res.status(400).json(safeError("Signature expired. Please try again."));
    }

    // ---- COOLDOWN: reserve slot BEFORE sending tokens ----
    if (hasRedis) {
      usedRedis = true;
      try {
        const already = await redisHasClaimed(address);
        if (already) {
          inflight.delete(key);
          return res.status(429).json(
            safeError("Already claimed in the last 24 hours. One claim per address per day.")
          );
        }
        const reserved = await redisReserveClaim(address);
        if (!reserved) {
          inflight.delete(key);
          return res.status(429).json(
            safeError("Already claimed in the last 24 hours. One claim per address per day.")
          );
        }
        reservedAddress = address;
      } catch (e) {
        inflight.delete(key);
        console.error("Redis cooldown error:", e.message);
        return res.status(503).json(
          safeError("Claim service temporarily unavailable. Try again in a minute.")
        );
      }
    } else {
      // File fallback — NOT reliable on Vercel
      console.warn("No Redis configured — cooldown may not work on serverless");
      if (fileHasClaimed(address) || !fileReserveClaim(address)) {
        inflight.delete(key);
        return res.status(429).json(
          safeError("Already claimed in the last 24 hours. One claim per address per day.")
        );
      }
      reservedAddress = address;
    }

    // ---- Send tokens ----
    let txHash = null;
    if (isLive && token && wallet) {
      const amount = CLAIM_AMOUNT * 10n ** BigInt(TOKEN_DECIMALS);
      const bal = await token.balanceOf(wallet.address);
      if (bal < amount) {
        if (usedRedis && reservedAddress) await redisReleaseClaim(reservedAddress);
        inflight.delete(key);
        return res.status(503).json(safeError("Shower is empty. Come back later."));
      }

      try {
        const tx = await token.transfer(address, amount);
        const receipt = await tx.wait(1);
        txHash = receipt.hash;
        console.log(`Claim OK → ${address.slice(0, 8)}… | ${txHash.slice(0, 12)}…`);
      } catch (sendErr) {
        // Transfer failed — release reservation so user can retry
        if (usedRedis && reservedAddress) await redisReleaseClaim(reservedAddress);
        inflight.delete(key);
        console.error("Transfer failed:", sendErr.message);
        return res.status(500).json(safeError("Token transfer failed. Please try again."));
      }
    } else {
      txHash = "0xDEMO" + crypto.randomBytes(16).toString("hex");
      console.log(`[DEMO] Claim for ${address.slice(0, 8)}…`);
    }

    inflight.delete(key);

    res.json({
      success: true,
      amount: Number(CLAIM_AMOUNT),
      txHash,
      live: isLive,
      message: isLive
        ? `${CLAIM_AMOUNT} KEKIUS sent! One claim per address every 24 hours.`
        : `${CLAIM_AMOUNT} KEKIUS recorded (DEMO – no real tokens moved)`
    });
  } catch (err) {
    if (usedRedis && reservedAddress) {
      try { await redisReleaseClaim(reservedAddress); } catch {}
    }
    if (req.body && req.body.address) {
      inflight.delete(String(req.body.address).toLowerCase());
    }
    console.error("Claim error:", err.message);
    res.status(500).json(safeError("Server error. Please try again later."));
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

initWallet().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🐸 Shower on http://localhost:${PORT}`);
    console.log(`   Mode: ${isLive ? "LIVE" : "DEMO"}`);
    console.log(`   Cooldown store: ${hasRedis ? "Upstash Redis ✓" : "FILE ONLY (set Upstash for Vercel)"}\n`);
  });
});
