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
// Permanently blocked from claiming (address + signer checked).
// When a banned wallet hits the API, its IP + device fingerprint are
// also permanently banned in Redis so the same entity cannot return.
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
  "0x393f21e015a0f8dc341746eb49e54d84081b76ce",
  "0x39bdab45e5c7543e63160f26ca25b8654a606c30",
  "0x1f802274b715f1fb54a7c3bcb649d8ef65324933",
  "0x6bb7fb783cba068f4a11238df6ff144cdc1fea5a",
  "0xcf9e5a6ba9726c5b61bfd99f0280c7454c1cf532",
  "0x73b3f274ea79257e85fdcc3bff59febd3c9ae23b",
  "0xf163d5a9451997fab2e918c999262f4a350e5777",
  "0x517ef0a07300cbc3a8937af5d4461bbc5f389057",
  "0x1ef5a2738f0894b8ee28e625a4e5dba9f22543b5",
  "0x0ebd029292e972e682e6eb0aacc3f302bf2a68f9",
  "0x9549e44d0acb2769711104b05fabed36241155f2",
  "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
  "0x263329bb61380345129c3404fdb1cc6573dc14c4",
  "0xb23b9e7847b8c185762f5388ac6f4630a0d974b0",
  "0x8520d47791def9601d380a341ce744f5d59f8628",
  "0xf2909a2f661430856823af23a5b2980096210710",
  "0xc0f1a3880148de92953fd3455f4e44be94deae79",
  "0xb15808daec77413236d863e9a66dd5bc7570bc55",
  "0x1b15a565f846990377e4cd962d8b4880672ac830",
  "0x45a6d6f6331922355ab54a7847a703b5e90b95e2",
  "0x3d486a14dda6fdb2d673280a575b56dd93e24711",
  "0xc4f45ad39ee01f451f91ce4a68747780b919d585",
  "0xc708846adbdb28edb373e6469e0e376fd1185d7c",
  "0x33f955354a529958a3efd7c1e482719c872da6f0",
  "0xf07f1020d01a4aa05c0e99a64c8a14699f870fc3",
  "0x56b3f4a63b172fa8872ca86bf61639b918f938b1",
  "0xf3a0a45755a18f5bf17c2761d5724a16a7dfa97d",
  "0x0c30855a82d98d2ff22ad3426877a60ebf518f1a",
  "0x6e7b89b04989149fb4dc38de5602ce39fcb261ae",
  "0xf5008e2bff1265a5108f90bbea093483e47381cb",
  "0x82513c3e20015fdcf5fdccdc19e573b4f11cd172",
  "0xdf4daf9ccb26819239c1212cf44919ab56a4c746",
  "0x6efae299d8ea9194b8237e3be8438c711ecd608e",
  "0x0336acd16e8fe6f9781404f2a828dcd01df08aca",
  "0xdabd5d4398b3ae4fdb48070eb2471389a30ef2f1",
  "0x4781f620f1e7144dfbb8c46d262340e512dd6daa",
  "0x5383d603ae968eff3931ce5812d5e0c11e85b1ad",
  "0x555653ba1a8a843c4dcbf6ae7e10a43ef13f84b2",
  "0x3a9a56b55628d617a2a3788ff384f09ee57eb450",
  "0xbf6cc145625dd2b5937b2ddbdffbc25320e91c28",
  "0xab0ff21c84985413de8562ffb9e1c03554ed7467",
  "0x4296339b4ff8e67f07de40d97a49a680f2598e0f",
  "0xe62059287fdb0b0471c4da2016b0e4835a3d45a8",
  "0x44a818901fac46d34e8ab7a9741477a772ac9af3",
  "0x491093289b4acdd09616fc7117648c806e7864d1",
  "0x8b65cd8b77ef42c6a09e0ba025f300cf1c02653b",
  "0x5be55e41331f02422d1fbce84f767f13cc66ad79",
  "0x515846dda9a63d78d5983d34d4e1833da6311f78",
  "0xeb4db34f278b0ea6a91b0b7469700ed4f0df861a",
  "0x21bb1b5fa4e7ac7f0d1d14b8e2457561c8349cf7",
  "0x188a6279cb05cc11abb16180201abd31bcfeb560",
  "0xb924bbb3b70e88d9c8ff6e08b302312110f28a69",
  "0xd981411c8cd875e216d93902ad591e4757aa98b3",
  "0x177879d15e9d2ea23ca488c3313a06632258849d",
  "0x52fcdf090996a310f5034fec86d014ca1c43dab7",
  "0x3668ea6e219ea830f602557ff5250658b7991e27",
  "0x07509f11acf37a3bf27536417f061a9f6546b011",
  "0x3762f1e202e28cb0bab580af9b5c93bc1ea1dd9d",
  "0xd83193b6eea74f795c6910c79f20a095ed6cbffd",
  "0x73b07550a631021c76664faa671358880fea0f86"
]);

function isBanned(address) {
  try {
    return BANNED_ADDRESSES.has(String(address).toLowerCase());
  } catch {
    return false;
  }
}

// Permanent ban keys (no expiry) for IP / fingerprint linked to banned wallets
function banFpKey(fp) {
  return "drip:ban:fp:" + String(fp).slice(0, 80);
}
function banIpKey(ip) {
  return "drip:ban:ip:" + String(ip).slice(0, 64);
}

async function redisIsBannedFp(fp) {
  if (!hasRedis || !fp) return false;
  try {
    const v = await redisCommand(["GET", banFpKey(fp)]);
    return v != null && v !== "";
  } catch {
    return false;
  }
}

async function redisIsBannedIp(ip) {
  if (!hasRedis || !ip || ip === "unknown") return false;
  try {
    const v = await redisCommand(["GET", banIpKey(ip)]);
    return v != null && v !== "";
  } catch {
    return false;
  }
}

/** Permanently ban this device + IP (used when a known-bad wallet appears) */
async function redisPermanentBanIdentity(fp, ip, reason) {
  if (!hasRedis) return;
  const payload = String(reason || "banned") + "|" + Date.now();
  try {
    if (fp && typeof fp === "string" && fp.length >= 4) {
      await redisCommand(["SET", banFpKey(fp), payload]);
    }
    if (ip && ip !== "unknown") {
      await redisCommand(["SET", banIpKey(ip), payload]);
    }
  } catch (e) {
    console.error("Failed to permanent-ban identity:", e.message);
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
    if (!signature || typeof signature !== "string" || signature.length > 200) {
      return res.status(400).json(safeError("Invalid signature"));
    }
    if (!message || typeof message !== "string" || message.length > 500) {
      return res.status(400).json(safeError("Invalid message"));
    }

    const key = address.toLowerCase();
    const ip = clientIp(req);
    const fp = typeof fingerprint === "string" ? fingerprint : "";

    // Permanent identity bans (IP / device linked to known abusers)
    if (await redisIsBannedIp(ip) || await redisIsBannedFp(fp)) {
      return res.status(403).json(
        safeError("Access denied. This device or network is banned from Drip.")
      );
    }

    // Known bad wallets — also permanently ban this IP + device
    if (isBanned(address)) {
      await redisPermanentBanIdentity(fp, ip, "wallet:" + key);
      return res.status(403).json(safeError("This wallet is banned from Drip."));
    }

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
      await redisPermanentBanIdentity(fp, ip, "signer:" + recovered.toLowerCase());
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
