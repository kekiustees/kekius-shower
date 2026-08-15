/**
 * Kekius Maximus – Shower Backend
 * --------------------------------
 * Security-focused claim server.
 *
 * LIVE mode requires:
 *   PRIVATE_KEY  = dedicated hot-wallet private key (never commit this)
 *   RPC_URL      = Ethereum RPC endpoint
 *
 * Without PRIVATE_KEY the server runs in safe DEMO mode.
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
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000; // signatures older than 5 min rejected
const CLAIMS_FILE = path.join(__dirname, "claims.json");

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // set to your domain in production

// ============ STATE ============
let provider = null;
let wallet = null;
let token = null;
let isLive = false;

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ============ HELPERS ============
function loadClaims() {
  try {
    if (fs.existsSync(CLAIMS_FILE)) {
      return JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load claims");
  }
  return {};
}

function saveClaims(claims) {
  // Atomic-ish write
  const tmp = CLAIMS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(claims, null, 2));
  fs.renameSync(tmp, CLAIMS_FILE);
}

function safeError(msg) {
  // Never leak internal details to clients
  return { error: msg };
}

// ============ INIT WALLET ============
async function initWallet() {
  if (!PRIVATE_KEY || PRIVATE_KEY.length < 64) {
    console.log("⚠  No PRIVATE_KEY → DEMO mode (no real transfers)");
    return;
  }

  // Basic sanity: private key should look like hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY) && !/^[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
    console.error("PRIVATE_KEY format looks invalid. Refusing to start live mode.");
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

app.use(express.json({ limit: "8kb" })); // small payload only

// Serve static assets (logo, etc.) reliably
app.use(express.static(__dirname, {
  maxAge: "1d",
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) {
      res.setHeader("Content-Type", "image/jpeg");
    }
  }
}));

// Explicit logo route (helps on some hosts)
app.get("/logo.jpg", (req, res) => {
  res.sendFile(path.join(__dirname, "logo.jpg"));
});

// Global rate limit
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: safeError("Too many requests. Slow down.")
});
app.use("/api/", globalLimiter);

// Stricter limit on the claim endpoint
const claimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 8,
  message: safeError("Too many claim attempts from this IP.")
});

// ============ ROUTES ============

app.get("/api/status", async (req, res) => {
  const claims = loadClaims();
  let pool = "unknown";

  if (isLive && token) {
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
    totalClaims: Object.keys(claims).length
  });
});

app.post("/api/claim", claimLimiter, async (req, res) => {
  try {
    const { address, signature, message, fingerprint } = req.body || {};

    // ---- 1. Basic input validation ----
    if (!address || typeof address !== "string" || !ethers.isAddress(address)) {
      return res.status(400).json(safeError("Invalid Ethereum address"));
    }
    if (!signature || typeof signature !== "string" || signature.length > 200) {
      return res.status(400).json(safeError("Invalid signature"));
    }
    if (!message || typeof message !== "string" || message.length > 500) {
      return res.status(400).json(safeError("Invalid message"));
    }

    // ---- 2. Verify signature matches address ----
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch {
      return res.status(400).json(safeError("Signature verification failed"));
    }

    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(400).json(safeError("Signature does not match address"));
    }

    // ---- 3. Message content + anti-replay (timestamp window) ----
    if (!message.includes(address) || !message.includes("Shower")) {
      return res.status(400).json(safeError("Invalid claim message"));
    }

    // Extract timestamp from message
    const tsMatch = message.match(/Timestamp:\s*(\d+)/);
    if (!tsMatch) {
      return res.status(400).json(safeError("Missing timestamp in message"));
    }
    const msgTime = parseInt(tsMatch[1], 10);
    const now = Date.now();

    if (isNaN(msgTime) || Math.abs(now - msgTime) > SIGNATURE_MAX_AGE_MS) {
      return res.status(400).json(safeError("Signature expired. Please try again."));
    }

    // ---- 4. Per-address cooldown ----
    const claims = loadClaims();
    const key = address.toLowerCase();

    if (claims[key] && now - claims[key].time < COOLDOWN_MS) {
      const hoursLeft = Math.ceil((COOLDOWN_MS - (now - claims[key].time)) / 3600000);
      return res.status(429).json(safeError(`Already claimed. Try again in ~${hoursLeft} hour(s).`));
    }

    // ---- 5. Soft device fingerprint limit ----
    if (fingerprint && typeof fingerprint === "string") {
      const recent = Object.values(claims).filter(
        (c) => c.fp === fingerprint && now - c.time < COOLDOWN_MS
      );
      if (recent.length >= 4) {
        return res.status(429).json(safeError("Too many claims from this device."));
      }
    }

    // ---- 6. Send tokens (only if live) ----
    let txHash = null;

    if (isLive && token && wallet) {
      const amount = CLAIM_AMOUNT * 10n ** BigInt(TOKEN_DECIMALS);
      const bal = await token.balanceOf(wallet.address);

      if (bal < amount) {
        return res.status(503).json(safeError("Shower is empty. Come back later."));
      }

      // Extra safety: never send more than the configured amount
      const tx = await token.transfer(address, amount);
      const receipt = await tx.wait(1);
      txHash = receipt.hash;

      // Log only non-sensitive info
      console.log(`Claim OK → ${address.slice(0, 8)}… | ${txHash.slice(0, 12)}…`);
    } else {
      // DEMO mode
      txHash = "0xDEMO" + crypto.randomBytes(16).toString("hex");
      console.log(`[DEMO] Claim recorded for ${address.slice(0, 8)}…`);
    }

    // ---- 7. Record claim ----
    claims[key] = {
      time: now,
      amount: Number(CLAIM_AMOUNT),
      fp: fingerprint ? String(fingerprint).slice(0, 64) : null,
      tx: txHash,
      live: isLive
    };
    saveClaims(claims);

    res.json({
      success: true,
      amount: Number(CLAIM_AMOUNT),
      txHash,
      live: isLive,
      message: isLive
        ? `${CLAIM_AMOUNT} KEKIUS sent!`
        : `${CLAIM_AMOUNT} KEKIUS recorded (DEMO – no real tokens moved)`
    });
  } catch (err) {
    // Never expose internal error details
    console.error("Claim error:", err.message);
    res.status(500).json(safeError("Server error. Please try again later."));
  }
});

// Catch-all for frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ============ START ============
initWallet().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🐸 Shower running on http://localhost:${PORT}`);
    console.log(`   Mode: ${isLive ? "LIVE" : "DEMO"}\n`);
  });
});
