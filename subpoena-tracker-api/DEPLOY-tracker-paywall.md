# Deploying the Subpoena Tracker's Paywall

Three pieces: a Stripe subscription price, a Cloudflare Worker (free), and the
tracker page itself (goes on GitHub Pages, same as your landing page).

## 1. Create a Stripe subscription price

1. Go to your Stripe Dashboard → Product catalog → **+ Add product**.
2. Name it (e.g. "Records & Subpoena Tracker — Premium").
3. Set a recurring price (e.g. $15/month) — pick whatever amount you want.
   The 3-day trial is applied by the Worker's code, not by anything you
   configure here, so any recurring price works.
4. Save, then copy the **Price ID** (starts with `price_...`) — you'll need
   it in step 3.

## 2. Create a Cloudflare Worker (free tier)

1. Go to https://dash.cloudflare.com, sign up if you don't have an account.
2. Go to **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name (e.g. `subpoena-tracker-api`) and deploy the default
   template — you'll replace the code next.
4. Click **Edit code** (Quick Edit), delete the placeholder code, and paste
   in the entire contents of `tracker-worker.js` (provided separately).
5. Before saving, update the line near the top:
   ```js
   const ALLOWED_ORIGIN = 'https://wizdomglobalsolutionz.github.io';
   ```
   to exactly match the origin your tracker page will be hosted at (no
   trailing slash, no path).
6. Click **Save and deploy**. Note the Worker's URL — it'll look like
   `https://subpoena-tracker-api.YOUR-SUBDOMAIN.workers.dev`.

## 3. Add a KV namespace (this is the "database")

1. In the Cloudflare dashboard, go to **Workers & Pages** → **KV**.
2. Click **Create namespace**, name it `TRACKER_KV`.
3. Go back to your Worker → **Settings** → **Variables** → **KV Namespace
   Bindings** → **Add binding**.
4. Variable name: `TRACKER_KV`. Select the namespace you just created. Save.

## 4. Add your Stripe secrets to the Worker

Still in your Worker's **Settings** → **Variables**:

1. Add an **environment variable** (encrypt it) named `STRIPE_SECRET_KEY` —
   paste your Stripe **secret key** (starts with `sk_live_...` or
   `sk_test_...` while testing). Find this in Stripe Dashboard → Developers
   → API keys.
2. Add another encrypted variable named `STRIPE_PRICE_ID` — the Price ID
   from step 1.
3. You'll add `STRIPE_WEBHOOK_SECRET` in step 5, after Stripe gives it to you.

**Never share your Stripe secret key with anyone, including me — it stays
only in the Cloudflare dashboard.**

## 5. Point a Stripe webhook at your Worker

1. In Stripe Dashboard → Developers → Webhooks → **+ Add endpoint**.
2. Endpoint URL: `https://YOUR-WORKER-URL.workers.dev/webhook`
3. Select these events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Save. Stripe will show you a **Signing secret** (starts with `whsec_...`)
   — copy it.
5. Back in Cloudflare, add it as an encrypted variable named
   `STRIPE_WEBHOOK_SECRET` on your Worker. Save.

## 6. Update the tracker page with your Worker's URL

In `subpoena-tracker.html`, find this line near the bottom:
```js
const WORKER_URL = 'https://YOUR-WORKER-SUBDOMAIN.workers.dev';
```
Replace it with your actual Worker URL from step 2 (no trailing slash).

## 7. Deploy the tracker page

Upload `subpoena-tracker.html` to your `wizdomglobalsolutionz.github.io`
repo (same process as the landing page), but name it `tracker.html` so it
doesn't overwrite your homepage.

## 8. Test end to end with Stripe test mode

1. Make sure your Stripe **secret key** in the Worker is the **test mode**
   key (`sk_test_...`) for now, not live.
2. Visit `https://wizdomglobalsolutionz.github.io/tracker.html`, enter a
   test email, click "Start free trial."
3. On the Stripe Checkout page, use test card `4242 4242 4242 4242`, any
   future expiry, any CVC.
4. You should land back on the tracker, unlocked, with a trial banner
   showing "3 days left."
5. Check the Cloudflare Worker's **Logs** (Real-time Logs) to confirm the
   webhook fired and the KV entry was written — click into the
   `TRACKER_KV` namespace in the dashboard to see the stored entitlement.
6. Once confirmed working, swap `STRIPE_SECRET_KEY` for your **live** key
   to accept real payments.

## What this does and doesn't handle yet

- ✅ Real Stripe Checkout, real 3-day trial, real recurring billing
- ✅ Entitlement check on every page load (via the Worker + KV)
- ✅ A "Manage subscription" link (Stripe's own hosted portal — lets users
  cancel or update their card without you building anything extra)
- ⚠️ **No password/account system** — access is tied to typing in the same
  email, not a real login. Fine for an early product; someone who knows a
  paying customer's email could theoretically also unlock it (a real login
  system would be a sensible next step if this grows).
- ⚠️ Data is still stored per-browser (localStorage), not synced across
  devices or shared between team members — the paywall is solved, but the
  tracker's actual data isn't in the cloud yet.
