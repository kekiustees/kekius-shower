/**
 * Kekius Maximus – Shower Backend
 * --------------------------------
 * ONE claim per address every 24 hours.
 *
 * Cooldown source of truth when LIVE:
 *   On-chain Transfer events from the faucet wallet → user
 *   (works on Vercel; cannot be bypassed by clearing files/storage)
 *
 * File-based claims.json is only a secondary cache for local/DEMO.
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
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const COOLDOWN_BLOCKS = 7500; // ~24h of Ethereum blocks (with buffer)
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const CLAIMS_FILE = path.join(__dirname, "claims.json");

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// In-memory lock to prevent double-claim races on the same instance
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

// ============ HELPERS ============
function loadClaims() {
  try {
    if (fs.existsSync(CLAIMS_FILE)) {
      return JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load claims file");
  }
  return {};
}

function saveClaims(claims) {
  try {
    const tmp = CLAIMS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(claims, null, 2));
    fs.renameSync(tmp, CLAIMS_FILE);
  } catch (e) {
    // On Vercel this often fails (read-only FS) — that is OK because
    // on-chain check is the real source of truth.
    console.error("Could not persist claims.json (expected on serverless)");
  }
}

function safeError(msg) {
  return { error: msg };
}

/**
 * On-chain cooldown: has the faucet wallet sent KEKIUS to this address
 * in the last ~24 hours?
 */
async function hasClaimedOnChain(toAddress) {
  if (!isLive || !token || !wallet || !provider) return false;

  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - COOLDOWN_BLOCKS);

    const filter = token.filters.Transfer(wallet.address, toAddress);
    const events = await token.queryFilter(filter, fromBlock, currentBlock);

    if (events.length === 0) return false;

    // Optional: check the most recent event timestamp more precisely
    const last = events[events.length - 1];
    const block = await provider.getBlock(last.blockNumber);
    if (!block || !block.timestamp) return true; // fail closed if we can't read time

    const ageMs = Date.now() - block.timestamp * 1000;
    return ageMs < COOLDOWN_MS;
  } catch (err) {
    console.error("On-chain cooldown check failed:", err.message);
    // Fail CLOSED: if we cannot verify, do not allow another claim
    return true;
  }
}

// ============ INIT WALLET ============
async function initWallet() {
  if (!PRIVATE_KEY || PRIVATE_KEY.length < 64) {
    console.log("⚠  No PRIVATE_KEY → DEMO mode (no real transfers)");
    return;
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY) && !/^[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
    console.error("PRIVATE_KEY format looks invalid. Refusing live mode.");
    return;
  }

  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, wallet);

    const bal = await token.balanceOf(wallet.address);
    const ethBal = await provider.getBalance(wallet.address);

    console.log("✓ LIVE mode enabled");
    console.log("  Hot wallet :", wallet.address);
    console.log("  KEKIUS     :", ethers.formatUnits(bal, TOKEN_DECIMALS));
    console.log("  ETH        :", ethers.formatEther(ethBal));
    isLive = true;
  } catch (err) {
    console.error("Wallet init failed:", err.message);
    console.log("Falling back to DEMO mode");
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

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: safeError("Too many requests. Slow down.")
});
app.use("/api/", globalLimiter);

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
    cooldownSource: isLive ? "on-chain" : "file"
  });
});

app.post("/api/claim", claimLimiter, async (req, res) => {
  const lockKey = (req.body && req.body.address)
    ? String(req.body.address).toLowerCase()
    : null;

  try {
    const { address, signature, message, fingerprint } = req.body || {};

    // ---- 1. Input validation ----
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

    // Prevent concurrent double-clicks / parallel requests for same address
    if (inflight.has(key)) {
      return res.status(429).json(safeError("Claim already in progress for this address. Wait a moment."));
    }
    inflight.add(key);

    // ---- 2. Verify signature ----
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

    // ---- 3. Message + timestamp anti-replay ----
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
    const now = Date.now();

    if (isNaN(msgTime) || Math.abs(now - msgTime) > SIGNATURE_MAX_AGE_MS) {
      inflight.delete(key);
      return res.status(400).json(safeError("Signature expired. Please try again."));
    }

    // ---- 4. COOLDOWN (source of truth) ----
    // LIVE → on-chain Transfer events (cannot be bypassed)
    // DEMO → local claims file
    if (isLive) {
      const already = await hasClaimedOnChain(address);
      if (already) {
        inflight.delete(key);
        return res.status(429).json(
          safeError("Already claimed in the last 24 hours. One claim per address per day.")
        );
      }
    } else {
      const claims = loadClaims();
      if (claims[key] && now - claims[key].time < COOLDOWN_MS) {
        const hoursLeft = Math.ceil((COOLDOWN_MS - (now - claims[key].time)) / 3600000);
        inflight.delete(key);
        return res.status(429).json(
          safeError(`Already claimed. Try again in ~${hoursLeft} hour(s).`)
        );
      }
    }

    // Soft fingerprint limit (best-effort, file may not persist on Vercel)
    try {
      const claims = loadClaims();
      if (fingerprint && typeof fingerprint === "string") {
        const recent = Object.values(claims).filter(
          (c) => c.fp === fingerprint && now - c.time < COOLDOWN_MS
        );
        if (recent.length >= 4) {
          inflight.delete(key);
          return res.status(429).json(safeError("Too many claims from this device."));
        }
      }
    } catch {}

    // ---- 5. Send tokens ----
    let txHash = null;

    if (isLive && token && wallet) {
      const amount = CLAIM_AMOUNT * 10n ** BigInt(TOKEN_DECIMALS);
      const bal = await token.balanceOf(wallet.address);

      if (bal < amount) {
        inflight.delete(key);
        return res.status(503).json(safeError("Shower is empty. Come back later."));
      }

      // Re-check on-chain right before send (race protection)
      const already2 = await hasClaimedOnChain(address);
      if (already2) {
        inflight.delete(key);
        return res.status(429).json(
          safeError("Already claimed in the last 24 hours. One claim per address per day.")
        );
      }

      const tx = await token.transfer(address, amount);
      const receipt = await tx.wait(1);
      txHash = receipt.hash;

      console.log(`Claim OK → ${address.slice(0, 8)}… | ${txHash.slice(0, 12)}…`);
    } else {
      txHash = "0xDEMO" + crypto.randomBytes(16).toString("hex");
      console.log(`[DEMO] Claim recorded for ${address.slice(0, 8)}…`);
    }

    // ---- 6. Record claim (best-effort file cache) ----
    try {
      const claims = loadClaims();
      claims[key] = {
        time: now,
        amount: Number(CLAIM_AMOUNT),
        fp: fingerprint ? String(fingerprint).slice(0, 64) : null,
        tx: txHash,
        live: isLive
      };
      saveClaims(claims);
    } catch {}

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
    if (lockKey) inflight.delete(lockKey);
    console.error("Claim error:", err.message);
    res.status(500).json(safeError("Server error. Please try again later."));
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ============ START ============
initWallet().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🐸 Shower running on http://localhost:${PORT}`);
    console.log(`   Mode: ${isLive ? "LIVE (on-chain 24h cooldown)" : "DEMO"}\n`);
  });
});
