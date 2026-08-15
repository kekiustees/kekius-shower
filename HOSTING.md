# How to Host Shower on GitHub + Vercel

Follow these steps carefully. This keeps your private key safe.

---

## Part 1 — Put the code on GitHub

### 1. Create a new GitHub repository
1. Go to [github.com](https://github.com) and log in.
2. Click the **+** button (top right) → **New repository**.
3. Name it something like `kekius-shower`.
4. Make it **Public** or **Private** (your choice).
5. **Do NOT** check “Add a README” (we already have files).
6. Click **Create repository**.

### 2. Upload your project
On your computer, open a terminal in the `kekius-faucet` folder and run:

```bash
git init
git add .
git commit -m "Initial Shower claim tool"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/kekius-shower.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

**Important:** The `.gitignore` file already blocks `.env` and `claims.json`.  
Never put your private key in any file that gets uploaded.

---

## Part 2 — Deploy on Vercel

### 1. Create a Vercel account
1. Go to [vercel.com](https://vercel.com).
2. Click **Sign Up**.
3. Choose **Continue with GitHub** and authorize Vercel.

### 2. Import the project
1. In Vercel, click **Add New…** → **Project**.
2. Find your `kekius-shower` repository and click **Import**.
3. Leave the settings as they are (Framework Preset can stay “Other”).
4. Click **Deploy**.

Wait until the first deploy finishes (it will be in DEMO mode for now).

### 3. Add your secret environment variables
1. In Vercel, open your project.
2. Go to **Settings** → **Environment Variables**.
3. Add these two variables:

| Name         | Value                                      | Notes |
|--------------|--------------------------------------------|-------|
| `PRIVATE_KEY`| `0x...` your hot wallet private key        | Keep this secret |
| `RPC_URL`    | `https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY` | Or any reliable Ethereum RPC |

4. Make sure they are available for **Production**, **Preview**, and **Development**.
5. Click **Save**.

### 4. Redeploy
1. Go to the **Deployments** tab.
2. Click the three dots on the latest deployment → **Redeploy**.
3. Confirm.

After redeploy, the site will switch to **LIVE** mode if the key and RPC are correct.

---

## Part 3 — Security checklist (very important)

### Protect the private key
- Use a **brand new wallet** only for the Shower.
- Put only a small amount of KEKIUS + a little ETH (for gas) in it.
- Never put the private key in the frontend or in any GitHub file.
- Only store it in Vercel Environment Variables.

### Recommended settings
- Set `ALLOWED_ORIGIN` in Vercel env vars to your real domain  
  (example: `https://kekius-shower.vercel.app`) so only your site can call the API.
- Keep the claim amount low (currently 50 KEKIUS).
- Check the Vercel logs occasionally for unusual activity.

### What the code already protects against
- IP rotation (requires wallet signature)
- Replaying old signatures (5-minute expiry)
- Claiming with someone else’s address (signature must match)
- Too many requests from one IP
- One claim per address every 24 hours

---

## Part 4 — Test it

1. Visit your Vercel URL (example: `https://kekius-shower.vercel.app`).
2. Connect MetaMask.
3. Solve the CAPTCHA.
4. Click **Claim 50 KEKIUS**.
5. Approve the signature in your wallet.
6. You should see a success message and a real transaction on Etherscan (if LIVE).

---

## Common problems

| Problem | Solution |
|---------|----------|
| Badge still says DEMO | Check that `PRIVATE_KEY` and `RPC_URL` are set and you redeployed |
| “Signature expired” | Sign and submit quickly (within 5 minutes) |
| “Already claimed” | Wait 24 hours or use a different address |
| Transaction fails | Hot wallet needs more ETH for gas or more KEKIUS |

---

## Final tips

- Start with a very small amount of KEKIUS in the hot wallet.
- You can always withdraw leftover tokens later.
- For higher security later you can move the backend to Railway or a small VPS, but Vercel is fine for starting.

That’s it. Your Shower is now live and reasonably protected.
