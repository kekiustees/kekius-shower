/**
 * Kekius Maximus – Drip Backend
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
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ============ CONFIG ============
const TOKEN_ADDRESS = "0xAE1EDabaC9a0DDa644B2F7Ec48759d37Ab257f78";
const CLAIM_AMOUNT = 50n;
const TOKEN_DECIMALS = 9;
const COOLDOWN_SEC = 24 * 60 * 60; // 24 hours in seconds (for Redis TTL)
const COOLDOWN_MS = COOLDOWN_SEC * 1000;
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const CLAIMS_FILE = path.join(__dirname, "claims.json");

const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim().replace(/^["']|["']$/g, "");
const RPC_URL = (process.env.RPC_URL || "https://eth.llamarpc.com").trim().replace(/^["']|["']$/g, "");
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "*").trim();
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim().replace(/^Bearer\s+/i, "");

const hasRedis = Boolean(
  UPSTASH_URL &&
  UPSTASH_TOKEN &&
  UPSTASH_URL.startsWith("https://")
);
const inflight = new Set();
let lastRedisError = null;

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
  return "drip:claim:" + address.toLowerCase();
}

// ============ BANNED WALLETS ============
// Permanently blocked from claiming (address + signer checked)
const BANNED_ADDRESSES = new Set([
  "0xe9ba2241261e843d550e47882e262c76e27db1f5",
  "0x81463a7d99933a2cebf8661e80fd17b7c6ec246d",
  "0xb60ae4eb3c0f4267ef61186aa3bd71f047202772",
  "0x914a81b744781c87adfc99b1dc366bc22bc81d50",
  "0x0095c6b81e98d84d6ae1d5559ec4cd9d5056319d",
  "0x0aeae5bb5eabe9aaedbd450dbef9e28fdb2a6b0a",
  "0xa862eb6262a78b7c77d38ea5181cddced9a612ef",
  "0x18387589ea66e7195be0d16784ead78a8b88611f",
  "0xc9eb6bfb0cea4f95d606583123cf6294601080ea",
  "0xb1d76699a11f961dec76444335ae8182d39d4821",
  "0xb6b81747fb69f5c08643f41722b85f0f0ac30f8a",
  "0xff91da76d3b5e51278c00b1c6ab259575c076532",
  "0x393f21e015a0f8dc341746eb49e54d84081b76ce"
].map((a) => a.toLowerCase()));

function isBanned(address) {
  try {
    return BANNED_ADDRESSES.has(String(address).toLowerCase());
  } catch {
    return false;
  }
}


// ============ REDIS (Upstash REST API) ============
async function redisCommand(parts) {
  if (!hasRedis) return null;

  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + UPSTASH_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(parts)
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    lastRedisError = "Bad Redis response (" + res.status + "): " + text.slice(0, 150);
    throw new Error(lastRedisError);
  }

  if (!res.ok || data.error) {
    lastRedisError = data.error || ("Redis HTTP " + res.status + ": " + text.slice(0, 150));
    throw new Error(lastRedisError);
  }

  lastRedisError = null;
  return data.result;
}

async function redisPing() {
  try {
    const result = await redisCommand(["PING"]);
    return { ok: true, result: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function redisHasClaimed(address) {
  const val = await redisCommand(["GET", claimKey(address)]);
  return val != null && val !== "";
}

async function redisReserveClaim(address) {
  const result = await redisCommand([
    "SET",
    claimKey(address),
    String(Date.now()),
    "NX",
    "EX",
    COOLDOWN_SEC
  ]);
  return result === "OK";
}

async function redisReleaseClaim(address) {
  try {
    await redisCommand(["DEL", claimKey(address)]);
  } catch (e) {
    console.error("Failed to release claim:", e.message);
  }
}

function fpKey(fp) {
  return "drip:fp:" + String(fp).slice(0, 80);
}
function ipKey(ip) {
  return "drip:ip:" + String(ip).slice(0, 64);
}

/** Max 1 claim per device fingerprint / 24h */
async function redisReserveFingerprint(fp) {
  if (!fp || typeof fp !== "string" || fp.length < 4) return true; // skip if missing
  const result = await redisCommand([
    "SET", fpKey(fp), String(Date.now()), "NX", "EX", COOLDOWN_SEC
  ]);
  return result === "OK";
}

async function redisReleaseFingerprint(fp) {
  if (!fp) return;
  try { await redisCommand(["DEL", fpKey(fp)]); } catch {}
}

/** Max claims per IP / 24h (default 2) */
const MAX_CLAIMS_PER_IP = 1;
async function redisCheckAndIncrIp(ip) {
  if (!ip || ip === "unknown") return true;
  const k = ipKey(ip);
  const count = await redisCommand(["GET", k]);
  const n = count ? parseInt(count, 10) : 0;
  if (n >= MAX_CLAIMS_PER_IP) return false;
  // INCR + set expiry on first claim
  const next = await redisCommand(["INCR", k]);
  if (Number(next) === 1) {
    await redisCommand(["EXPIRE", k, COOLDOWN_SEC]);
  }
  if (Number(next) > MAX_CLAIMS_PER_IP) {
    // roll back
    try { await redisCommand(["DECR", k]); } catch {}
    return false;
  }
  return true;
}

async function redisDecrIp(ip) {
  if (!ip || ip === "unknown") return;
  try {
    const n = await redisCommand(["DECR", ipKey(ip)]);
    if (Number(n) < 0) await redisCommand(["SET", ipKey(ip), "0", "EX", COOLDOWN_SEC]);
  } catch {}
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

function setClaimCookie(res) {
  // 24h browser cookie — easy to clear, but stops casual re-claims
  const maxAge = COOLDOWN_SEC;
  res.setHeader(
    "Set-Cookie",
    "drip_claimed=1; Path=/; Max-Age=" + maxAge + "; SameSite=Lax; Secure"
  );
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
let initPromise = null;
let initError = null;

async function initWallet() {
  if (isLive && wallet && token) return true;

  // Strip 0x and measure hex length
  const keyBody = (PRIVATE_KEY || "").replace(/^0x/i, "").trim();
  if (!keyBody || keyBody.length !== 64) {
    initError =
      "PRIVATE_KEY missing or wrong length on the server. " +
      "In Vercel → Settings → Environment Variables, add PRIVATE_KEY " +
      "(64 hex characters, with or without 0x), set it for Production, then Redeploy.";
    console.log("⚠  " + initError);
    return false;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(keyBody)) {
    initError =
      "PRIVATE_KEY has invalid characters. Use only 0-9 and a-f (64 chars). No spaces or quotes.";
    console.error(initError);
    return false;
  }

  try {
    const key = "0x" + keyBody;
    provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
      staticNetwork: true
    });
    wallet = new ethers.Wallet(key, provider);
    token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, wallet);

    // LIVE as soon as wallet is constructed with a valid key
    isLive = true;
    initError = null;
    console.log("✓ LIVE mode enabled");
    console.log("  Wallet :", wallet.address);
    console.log("  RPC    :", RPC_URL.slice(0, 40) + "...");

    // Best-effort balance log (RPC failure should NOT force DEMO)
    try {
      const bal = await Promise.race([
        token.balanceOf(wallet.address),
        new Promise((_, rej) => setTimeout(() => rej(new Error("balance timeout")), 8000))
      ]);
      console.log("  KEKIUS :", ethers.formatUnits(bal, TOKEN_DECIMALS));
    } catch (balErr) {
      console.warn("Balance check skipped:", balErr.message);
    }

    return true;
  } catch (err) {
    initError = "Wallet init failed: " + err.message;
    console.error(initError);
    isLive = false;
    wallet = null;
    token = null;
    provider = null;
    return false;
  }
}

function ensureWallet() {
  // Retry later if a previous attempt failed (cold start / flaky RPC)
  if (isLive && wallet && token) return Promise.resolve(true);
  if (initPromise) return initPromise;
  initPromise = initWallet().then((ok) => {
    if (!ok) initPromise = null; // allow next request to retry
    return ok;
  });
  return initPromise;
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
  await ensureWallet();
  let pool = "unknown";
  if (isLive && token && wallet) {
    try {
      const bal = await token.balanceOf(wallet.address);
      let decimals = TOKEN_DECIMALS;
      try {
        decimals = Number(await token.decimals());
        if (!Number.isFinite(decimals)) decimals = TOKEN_DECIMALS;
      } catch {}
      const formatted = ethers.formatUnits(bal, decimals);
      // Guard against bad format results
      pool = Number.isFinite(Number(formatted)) ? formatted : "unknown";
    } catch (e) {
      console.error("Status balance read failed:", e.message);
      pool = "unknown";
    }
  }
  let redis = { configured: hasRedis, ok: false, error: null };
  if (hasRedis) {
    redis = Object.assign({ configured: true }, await redisPing());
  } else if (UPSTASH_URL || UPSTASH_TOKEN) {
    redis.error = "Redis env vars present but invalid (URL must start with https://)";
  }
  const keyBody = (PRIVATE_KEY || "").replace(/^0x/i, "").trim();
  res.json({
    live: isLive,
    claimAmount: Number(CLAIM_AMOUNT),
    cooldownHours: 24,
    token: TOKEN_ADDRESS,
    pool,
    cooldownStore: redis.ok ? "redis" : (hasRedis ? "redis-error" : "file-only"),
    redis,
    initError: isLive ? null : initError,
    // Safe diagnostics (never returns the actual key)
    debug: {
      privateKeyPresent: keyBody.length > 0,
      privateKeyHexLength: keyBody.length,
      privateKeyLooksValid: keyBody.length === 64 && /^[0-9a-fA-F]+$/.test(keyBody),
      rpcUrlSet: Boolean(RPC_URL),
      rpcUrlPreview: RPC_URL ? (RPC_URL.slice(0, 32) + "…") : null,
      walletAddress: wallet ? wallet.address : null
    }
  });
});

app.post("/api/claim", claimLimiter, async (req, res) => {
  await ensureWallet();
  let reservedAddress = null;
  let usedRedis = false;

  try {
    const { address, signature, message, fingerprint } = req.body || {};

    if (!address || typeof address !== "string" || !ethers.isAddress(address)) {
      return res.status(400).json(safeError("Invalid Ethereum address"));
    }
    if (isBanned(address)) {
      return res.status(403).json(safeError("This wallet is banned from Drip."));
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
    if (isBanned(recovered)) {
      inflight.delete(key);
      return res.status(403).json(safeError("This wallet is banned from Drip."));
    }
    if (!message.includes(address) || !message.includes("Drip")) {
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

    // ---- Browser cookie check (soft barrier) ----
    if (readCookie(req, "drip_claimed") === "1") {
      inflight.delete(key);
      return res.status(429).json(
        safeError("This browser already claimed in the last 24 hours. One claim per person per day.")
      );
    }

    const ip = clientIp(req);
    let reservedFp = null;
    let reservedIp = false;

    // ---- COOLDOWN: Redis is REQUIRED for LIVE (cannot be bypassed on Vercel) ----
    if (isLive && !hasRedis) {
      inflight.delete(key);
      return res.status(503).json(
        safeError("Claim store not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.")
      );
    }

    if (hasRedis) {
      usedRedis = true;
      try {
        // 1) Per-address 24h
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

        // 2) Per-device fingerprint 24h (stops multi-wallet from same browser)
        if (fingerprint && typeof fingerprint === "string") {
          const fpOk = await redisReserveFingerprint(fingerprint);
          if (!fpOk) {
            await redisReleaseClaim(address);
            inflight.delete(key);
            return res.status(429).json(
              safeError("This device already claimed in the last 24 hours. One claim per person per day.")
            );
          }
          reservedFp = fingerprint;
        }

        // 3) Per-IP limit (default 2 / 24h)
        const ipOk = await redisCheckAndIncrIp(ip);
        if (!ipOk) {
          await redisReleaseClaim(address);
          if (reservedFp) await redisReleaseFingerprint(reservedFp);
          inflight.delete(key);
          return res.status(429).json(
            safeError("This network already claimed in the last 24 hours. One claim per IP per day.")
          );
        }
        reservedIp = true;
      } catch (e) {
        inflight.delete(key);
        console.error("Redis cooldown error:", e.message);
        return res.status(503).json(
          safeError("Redis claim store error. Check UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on Vercel (must be the REST URL that starts with https://, not rediss://).")
        );
      }
    } else {
      // DEMO / local only — file fallback
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
        if (usedRedis && reservedFp) await redisReleaseFingerprint(reservedFp);
        if (usedRedis && reservedIp) await redisDecrIp(ip);
        inflight.delete(key);
        return res.status(503).json(safeError("Drip is empty. Come back later."));
      }

      try {
        const tx = await token.transfer(address, amount);
        const receipt = await tx.wait(1);
        txHash = receipt.hash;
        console.log(`Claim OK → ${address.slice(0, 8)}… | ${txHash.slice(0, 12)}…`);
      } catch (sendErr) {
        if (usedRedis && reservedAddress) await redisReleaseClaim(reservedAddress);
        if (usedRedis && reservedFp) await redisReleaseFingerprint(reservedFp);
        if (usedRedis && reservedIp) await redisDecrIp(ip);
        inflight.delete(key);
        console.error("Transfer failed:", sendErr.message);
        return res.status(500).json(safeError("Token transfer failed. Please try again."));
      }
    } else {
      txHash = "0xDEMO" + crypto.randomBytes(16).toString("hex");
      console.log(`[DEMO] Claim for ${address.slice(0, 8)}…`);
    }

    inflight.delete(key);
    setClaimCookie(res);

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

// Kick off wallet init immediately (needed on Vercel serverless)
ensureWallet();

// Vercel uses the exported app; local uses listen()
module.exports = app;

if (require.main === module) {
  ensureWallet().then(() => {
    app.listen(PORT, () => {
      console.log("\n🐸 Drip on http://localhost:" + PORT);
      console.log("   Mode: " + (isLive ? "LIVE" : "DEMO"));
      console.log("   Cooldown store: " + (hasRedis ? "Upstash Redis ✓" : "FILE ONLY") + "\n");
    });
  });
}
