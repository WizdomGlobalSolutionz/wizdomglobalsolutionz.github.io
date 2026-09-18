// ============================================================================
// Records & Subpoena Tracker — Payment Worker
// Deploy this on Cloudflare Workers (free tier). It handles:
//   - Creating a Stripe Checkout session (subscription + 3-day trial)
//   - Verifying Stripe webhook events and recording entitlement in KV
//   - Checking whether a given email currently has access
//   - Creating a Stripe Billing Portal session (so users can manage/cancel)
//
// This file is meant to be pasted directly into the Cloudflare Workers
// dashboard's "Quick Edit" — no build step, no bundler required.
//
// Required setup (see DEPLOY.md for full steps):
//   1. A KV namespace bound to this Worker as TRACKER_KV
//   2. Worker secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID
//   3. ALLOWED_ORIGIN below updated to your actual site's origin
// ============================================================================

const ALLOWED_ORIGIN = 'https://wizdomglobalsolutionz.github.io';
const TRIAL_DAYS = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight for all routes.
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === '/create-checkout-session' && request.method === 'POST') {
        return corsResponse(await createCheckoutSession(request, env));
      }
      if (url.pathname === '/webhook' && request.method === 'POST') {
        // Webhook responses don't need CORS headers — Stripe calls this directly.
        return await handleWebhook(request, env);
      }
      if (url.pathname === '/status' && request.method === 'GET') {
        return corsResponse(await getStatus(url, env));
      }
      if (url.pathname === '/verify-session' && request.method === 'GET') {
        return corsResponse(await verifySession(url, env));
      }
      if (url.pathname === '/create-portal-session' && request.method === 'POST') {
        return corsResponse(await createPortalSession(request, env));
      }

      return corsResponse(new Response('Not found', { status: 404 }));
    } catch (err) {
      return corsResponse(jsonResponse({ error: err.message || 'Server error' }, 500));
    }
  },
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function createCheckoutSession(request, env) {
  const { email } = await request.json();
  if (!email || !email.includes('@')) {
    return jsonResponse({ error: 'A valid email is required.' }, 400);
  }

  const origin = request.headers.get('Origin') || ALLOWED_ORIGIN;

  const params = new URLSearchParams({
    mode: 'subscription',
    customer_email: email,
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': String(TRIAL_DAYS),
    success_url: `${origin}/tracker.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/tracker.html`,
  });

  const resp = await stripeFetch('/v1/checkout/sessions', env, {
    method: 'POST',
    body: params,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return jsonResponse({ error: 'Stripe error creating session', detail: errText }, 500);
  }

  const session = await resp.json();
  return jsonResponse({ url: session.url });
}

async function verifySession(url, env) {
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) return jsonResponse({ error: 'session_id is required' }, 400);

  const resp = await stripeFetch(`/v1/checkout/sessions/${sessionId}`, env, { method: 'GET' });
  if (!resp.ok) return jsonResponse({ error: 'Could not verify session' }, 400);

  const session = await resp.json();
  const email = session.customer_details && session.customer_details.email;
  if (!email) return jsonResponse({ error: 'No email on session' }, 400);

  return jsonResponse({ email });
}

async function getStatus(url, env) {
  const email = (url.searchParams.get('email') || '').toLowerCase().trim();
  if (!email) return jsonResponse({ status: 'none' });

  const raw = await env.TRACKER_KV.get(`entitlement:${email}`);
  if (!raw) return jsonResponse({ status: 'none' });

  const data = JSON.parse(raw);
  return jsonResponse(data);
}

async function createPortalSession(request, env) {
  const { email } = await request.json();
  if (!email) return jsonResponse({ error: 'Email is required' }, 400);

  const raw = await env.TRACKER_KV.get(`entitlement:${email.toLowerCase().trim()}`);
  if (!raw) return jsonResponse({ error: 'No subscription found for this email' }, 404);

  const { customerId } = JSON.parse(raw);
  const origin = request.headers.get('Origin') || ALLOWED_ORIGIN;

  const params = new URLSearchParams({
    customer: customerId,
    return_url: `${origin}/tracker.html`,
  });

  const resp = await stripeFetch('/v1/billing_portal/sessions', env, {
    method: 'POST',
    body: params,
  });

  if (!resp.ok) return jsonResponse({ error: 'Could not create portal session' }, 500);
  const portalSession = await resp.json();
  return jsonResponse({ url: portalSession.url });
}

// ---------------------------------------------------------------------------
// Webhook handling
// ---------------------------------------------------------------------------

async function handleWebhook(request, env) {
  const signature = request.headers.get('Stripe-Signature');
  const rawBody = await request.text();

  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response('Invalid signature', { status: 400 });
  }

  const event = JSON.parse(rawBody);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details && session.customer_details.email;
    if (email && session.subscription) {
      await refreshEntitlementFromSubscription(session.subscription, email, session.customer, env);
    }
  } else if (
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const subscription = event.data.object;
    const email = await getCustomerEmail(subscription.customer, env);
    if (email) {
      await refreshEntitlementFromSubscription(subscription.id, email, subscription.customer, env, subscription);
    }
  }

  return new Response('ok', { status: 200 });
}

async function refreshEntitlementFromSubscription(subscriptionId, email, customerId, env, subscriptionObj) {
  let subscription = subscriptionObj;
  if (!subscription) {
    const resp = await stripeFetch(`/v1/subscriptions/${subscriptionId}`, env, { method: 'GET' });
    subscription = await resp.json();
  }

  const status = subscription.status; // trialing | active | past_due | canceled | ...
  const data = {
    status,
    customerId,
    subscriptionId: subscription.id,
    currentPeriodEnd: subscription.current_period_end,
    updated: Date.now(),
  };

  await env.TRACKER_KV.put(`entitlement:${email.toLowerCase().trim()}`, JSON.stringify(data));
}

async function getCustomerEmail(customerId, env) {
  const resp = await stripeFetch(`/v1/customers/${customerId}`, env, { method: 'GET' });
  if (!resp.ok) return null;
  const customer = await resp.json();
  return customer.email || null;
}

/**
 * Verifies a Stripe webhook signature using the Web Crypto API
 * (no Stripe SDK needed, keeping this a single dependency-free file).
 */
async function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(p => p.split('='))
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return computedSig === expectedSig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function stripeFetch(path, env, options) {
  return fetch(`https://api.stripe.com${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: options.body,
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsResponse(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  newHeaders.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers: newHeaders });
}
