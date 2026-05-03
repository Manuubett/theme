/**
 * CBE Resource Hub — Subscriptions / Payments Route
 * Mount: app.use('/api/subscriptions', require('./routes/subscriptions'))
 *
 * Required env vars:
 *   PAYNECTA_API_KEY      – your API key from Paynecta dashboard
 *   PAYNECTA_EMAIL        – your registered Paynecta email
 *   PAYNECTA_CODE         – your merchant code
 *   SERVER_URL            – your full backend URL (e.g. https://cbe-y1zb.onrender.com)
 *
 * Firebase (Firestore) is already initialised in server.js via admin.initializeApp()
 */

const express = require('express');
const axios   = require('axios');
const admin   = require('firebase-admin');

const router = express.Router();

// ── Paynecta config ───────────────────────────────────────────────────────────
const API_KEY       = process.env.PAYNECTA_API_KEY;
const USER_EMAIL    = process.env.PAYNECTA_EMAIL;
const MERCHANT_CODE = process.env.PAYNECTA_CODE;
const SERVER_BASE   = process.env.SERVER_URL || 'https://cbe-y1zb.onrender.com';
const PAYNECTA_URL  = 'https://paynecta.co.ke/api/v1';

if (!API_KEY)       console.error('❌ [Subscriptions] PAYNECTA_API_KEY not set');
if (!USER_EMAIL)    console.warn('⚠️  [Subscriptions] PAYNECTA_EMAIL not set');
if (!MERCHANT_CODE) console.warn('⚠️  [Subscriptions] PAYNECTA_CODE not set');

// ── Plan definitions — must match frontend PLANS object keys ─────────────────
const PLAN_CONFIG = {
  resource_termly: { label: 'Termly Access',  amount: 99,   daysValid: 120 },
  resource_annual: { label: 'Annual Access',  amount: 270,  daysValid: 365 },
  resource_school: { label: 'School License', amount: 2500, daysValid: 120 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const paynectaHeaders = () => ({
  'X-API-Key':    API_KEY,
  'X-User-Email': USER_EMAIL,
  'Content-Type': 'application/json',
});

/** Normalise any Kenyan phone number to 2547XXXXXXXX */
function normalisePhone(phone) {
  let p = phone.toString().replace(/\D/g, '');
  if (p.startsWith('0'))                      p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (!p.startsWith('254'))                   p = '254' + p;
  return p;
}

const getDb = () => admin.firestore();

/** Calculate ISO expiry string from now + N days */
function calcExpiry(daysValid) {
  const d = new Date();
  d.setDate(d.getDate() + (daysValid || 120));
  return d.toISOString();
}


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 1 — Initiate Payment
// POST /api/subscriptions/initiate
// Body: { uid, planKey, phone, name }
// Frontend expects back: { success, paymentId }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/initiate', async (req, res) => {
  const { uid, planKey, phone, name } = req.body;

  if (!phone)
    return res.status(400).json({ success: false, error: 'Phone number is required' });
  if (!uid)
    return res.status(400).json({ success: false, error: 'uid is required' });
  if (!API_KEY || !USER_EMAIL || !MERCHANT_CODE)
    return res.status(500).json({ success: false, error: 'Server misconfigured — missing Paynecta credentials' });

  const plan   = PLAN_CONFIG[planKey] || PLAN_CONFIG['resource_termly'];
  const mobile = normalisePhone(phone);

  console.log(`[Initiate] uid=${uid} plan=${planKey} phone=${mobile}`);

  try {
    const paynectaPayload = {
      code:          MERCHANT_CODE,
      mobile_number: mobile,
      amount:        plan.amount,
      description:   `CBE Resource Hub — ${plan.label}`,
      callback_url:  `${SERVER_BASE}/api/subscriptions/webhook`,
    };

    const response = await axios.post(
      `${PAYNECTA_URL}/payment/initialize`,
      paynectaPayload,
      { headers: paynectaHeaders(), timeout: 15000 }
    );

    const txRef =
      response.data?.data?.transaction_reference ||
      response.data?.data?.CheckoutRequestID     ||
      response.data?.transaction_reference       ||
      `CBE-${Date.now()}`;

    // Save pending payment — keyed by txRef
    await getDb().collection('subscriptionPayments').doc(txRef).set({
      txRef,
      uid,
      phone:     mobile,
      name:      name      || '',
      planKey:   planKey   || 'resource_termly',
      planLabel: plan.label,
      amount:    plan.amount,
      daysValid: plan.daysValid,
      status:    'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[Initiate] ✅ STK sent txRef=${txRef}`);

    res.json({
      success:   true,
      paymentId: txRef,  // frontend stores this (not used for polling but good to have)
      txRef,
      message:   'STK push sent. Check your phone.',
    });

  } catch (err) {
    console.error('[Initiate] Error:', err.response?.data || err.message);
    res.status(400).json({ success: false, error: 'Failed to initiate payment. Please try again.' });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 2 — Subscription Status
// GET /api/subscriptions/status?uid=FIREBASE_UID
// GET /api/subscriptions/status?checkoutId=CBE-xxxxx  (fallback)
// Frontend polls with ?uid= and checks: data.active === true
// ══════════════════════════════════════════════════════════════════════════════
router.get('/status', async (req, res) => {
  const { uid, checkoutId } = req.query;

  if (!uid && !checkoutId)
    return res.status(400).json({ success: false, error: 'uid or checkoutId is required' });

  try {
    const db = getDb();

    // ── Poll by uid (primary — what the frontend uses) ────────────────────────
    if (uid) {
      const subDoc = await db.collection('subscribers').doc(uid).get();

      if (subDoc.exists) {
        const sub       = subDoc.data();
        const expiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
        const active    = expiresAt ? expiresAt > new Date() : !!sub.unlockedAt;

        return res.json({
          success:   true,
          active,
          expiresAt: sub.expiresAt || null,
          plan:      sub.planKey   || 'resource_termly',
          uid,
        });
      }

      // Not a subscriber yet — return inactive so frontend keeps polling
      return res.json({ success: true, active: false, expiresAt: null });
    }

    // ── Lookup by checkoutId (secondary) ─────────────────────────────────────
    const payDoc = await db.collection('subscriptionPayments').doc(checkoutId).get();

    if (!payDoc.exists)
      return res.json({ success: true, status: 'pending', paid: false, active: false });

    const data   = payDoc.data();
    const isPaid = data.status === 'completed' || data.status === 'confirmed';

    return res.json({
      success:   true,
      status:    isPaid ? 'completed' : (data.status || 'pending'),
      paid:      isPaid,
      active:    isPaid,
      plan:      data.planKey || 'resource_termly',
      uid:       data.uid     || null,
    });

  } catch (err) {
    console.error('[Status] Error:', err.message);
    res.status(500).json({ success: false, error: 'Could not check status' });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 3 — Paynecta Webhook
// POST /api/subscriptions/webhook
// express.raw() for this path is already set in server.js BEFORE express.json()
// ══════════════════════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
  res.json({ received: true }); // fast 200 first

  try {
    // Body arrives as raw Buffer when express.raw() is active
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString('utf8'));
    } else {
      payload = req.body;
    }

    const data      = payload.data || {};
    const tx        = data.transaction || {};
    const txRef     = tx.reference || data.reference || payload.reference || null;
    const rawStatus = tx.status    || data.status    || payload.status;
    const eventType = payload.event_type || payload.event;
    const mpesaCode = data.MpesaReceiptNumber || data.mpesa_receipt || null;
    const mobile    = data.customer?.mobile_number || data.phone || null;

    console.log('[Webhook]', { eventType, txRef, rawStatus, mpesaCode });

    if (!txRef) return;

    const db          = getDb();
    const isCompleted = eventType === 'payment.completed' ||
                        ['completed', 'confirmed', 'success'].includes(rawStatus);
    const isFailed    = eventType === 'payment.failed'    ||
                        ['failed', 'cancelled', 'timeout'].includes(rawStatus);

    if (isCompleted) {
      // 1. Mark payment completed
      await db.collection('subscriptionPayments').doc(txRef).update({
        status:      'completed',
        mpesaCode:   mpesaCode || null,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Get payment record to find uid + plan
      const payDoc  = await db.collection('subscriptionPayments').doc(txRef).get();
      const payData = payDoc.exists ? payDoc.data() : {};
      const uid     = payData.uid || null;
      const phone   = (payData.phone || mobile || '').replace(/\D/g, '');
      const plan    = PLAN_CONFIG[payData.planKey] || PLAN_CONFIG['resource_termly'];
      const expiresAt = calcExpiry(plan.daysValid);

      // 3. Write subscriber record keyed by Firebase uid (what frontend polls via /status?uid=)
      if (uid) {
        await db.collection('subscribers').doc(uid).set({
          uid,
          phone:      payData.phone || mobile,
          planKey:    payData.planKey || 'resource_termly',
          planLabel:  plan.label,
          txRef,
          mpesaCode:  mpesaCode || null,
          expiresAt,
          unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
          amount:     payData.amount || plan.amount,
        }, { merge: true });

        console.log(`[Webhook] ✅ Subscriber written uid=${uid} expires=${expiresAt}`);
      }

      // 4. Also index by phone for manual lookups
      if (phone) {
        await db.collection('subscribersByPhone').doc(phone).set({
          uid,
          phone:      payData.phone || mobile,
          planKey:    payData.planKey || 'resource_termly',
          txRef,
          mpesaCode:  mpesaCode || null,
          expiresAt,
          unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      console.log(`[Webhook] ✅ Confirmed txRef=${txRef} mpesa=${mpesaCode}`);

    } else if (isFailed) {
      await db.collection('subscriptionPayments').doc(txRef).update({
        status:   'failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[Webhook] ❌ Failed txRef=${txRef}`);

    } else {
      await db.collection('subscriptionPayments').doc(txRef).update({
        lastEvent:     eventType  || null,
        lastRawStatus: rawStatus  || null,
      });
    }

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 4 — Manual M-Pesa Code Bypass
// POST /api/subscriptions/verify-bypass
// Body: { code, uid? }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/verify-bypass', async (req, res) => {
  const { code, uid } = req.body;

  if (!code)
    return res.status(400).json({ success: false, error: 'M-Pesa code is required' });

  const cleanCode = code.trim().toUpperCase();
  const db        = getDb();

  try {
    // 1. Find payment by mpesaCode
    const paySnap = await db.collection('subscriptionPayments')
      .where('mpesaCode', '==', cleanCode)
      .limit(1)
      .get();

    if (!paySnap.empty) {
      const record = paySnap.docs[0].data();

      if (record.status !== 'completed' && record.status !== 'confirmed') {
        return res.json({
          success: false,
          error:   'Payment found but not yet confirmed. Wait a moment and try again.',
        });
      }

      const plan      = PLAN_CONFIG[record.planKey] || PLAN_CONFIG['resource_termly'];
      const expiresAt = calcExpiry(plan.daysValid);

      // Grant access if uid supplied and webhook was missed
      if (uid) {
        await db.collection('subscribers').doc(uid).set({
          uid,
          phone:      record.phone,
          planKey:    record.planKey || 'resource_termly',
          planLabel:  plan.label,
          txRef:      record.txRef,
          mpesaCode:  cleanCode,
          expiresAt,
          unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
          amount:     record.amount,
          bypassUsed: true,
        }, { merge: true });
        console.log(`[Bypass] ✅ Access granted uid=${uid} code=${cleanCode}`);
      }

      return res.json({
        success:   true,
        active:    true,
        message:   'Payment verified',
        plan:      record.planKey || 'resource_termly',
        expiresAt,
      });
    }

    // 2. Fallback — check subscribersByPhone
    const subSnap = await db.collection('subscribersByPhone')
      .where('mpesaCode', '==', cleanCode)
      .limit(1)
      .get();

    if (!subSnap.empty) {
      const sub = subSnap.docs[0].data();
      console.log(`[Bypass] ✅ Found via subscribersByPhone code=${cleanCode}`);
      return res.json({
        success:   true,
        active:    true,
        message:   'Verified via subscriber record',
        plan:      sub.planKey  || 'resource_termly',
        expiresAt: sub.expiresAt || null,
      });
    }

    return res.json({
      success: false,
      error:   'Code not found. If you just paid, wait 30 seconds and try again.',
    });

  } catch (err) {
    console.error('[Bypass] Error:', err.message);
    res.status(500).json({ success: false, error: 'Verification failed. Please try again.' });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 5 — Check Subscriber by Phone (admin / debug)
// GET /api/subscriptions/check/:phone
// ══════════════════════════════════════════════════════════════════════════════
router.get('/check/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');

  if (!phone)
    return res.status(400).json({ success: false, error: 'Invalid phone number' });

  try {
    const doc = await getDb().collection('subscribersByPhone').doc(phone).get();
    res.json({
      success: true,
      isPro:   doc.exists,
      data:    doc.exists ? doc.data() : null,
    });
  } catch (err) {
    console.error('[Check] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 6 — Test Paynecta Credentials
// GET /api/subscriptions/test-paynecta
// ══════════════════════════════════════════════════════════════════════════════
router.get('/test-paynecta', async (req, res) => {
  if (!API_KEY)
    return res.status(500).json({ success: false, message: 'PAYNECTA_API_KEY not set' });

  try {
    const response = await axios.get(`${PAYNECTA_URL}/me`, {
      headers:        paynectaHeaders(),
      validateStatus: () => true,
      timeout:        10000,
    });
    const ok = response.status < 400;
    res.status(ok ? 200 : 400).json({
      success: ok,
      status:  response.status,
      message: ok ? 'Paynecta API key valid ✅' : 'Paynecta API key rejected ❌',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


module.exports = router;
