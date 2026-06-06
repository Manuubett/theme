/**
 * CBE Resource Hub — Subscriptions / Payments Route
 * Mount: app.use('/api/subscriptions', require('./routes/subscriptions'))
 *
 * Required env vars:
 *   PAYNECTA_API_KEY      – your API key from Paynecta dashboard
 *   PAYNECTA_EMAIL        – your registered Paynecta email
 *   PAYNECTA_CODE         – your merchant code
 *   SERVER_URL            – your full backend URL (e.g. https://cbe-y1zb.onrender.com)
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

// ── Plan definitions ─────────────────────────────────────────────────────────
const PLAN_CONFIG = {
  resource_termly: { label: 'Termly Access',  amount: 99,    daysValid: 120 },
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

/** Extract a value from M-Pesa CallbackMetadata Item array */
function extractCallbackItem(items, name) {
  if (!Array.isArray(items)) return null;
  const item = items.find(i => i.Name === name);
  return item?.Value ?? null;
}


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 1 — Initiate Payment
// POST /api/subscriptions/initiate
// Body: { uid, planKey, phone, name }
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

    console.log('[Initiate] Paynecta payload:', JSON.stringify(paynectaPayload));

    const response = await axios.post(
      `${PAYNECTA_URL}/payment/initialize`,
      paynectaPayload,
      { headers: paynectaHeaders(), timeout: 15000 }
    );

    console.log('[Initiate] Paynecta response:', JSON.stringify(response.data));

    const txRef =
      response.data?.data?.transaction_reference ||
      response.data?.data?.CheckoutRequestID     ||
      response.data?.data?.txRef                 ||
      response.data?.data?.id                    ||
      response.data?.transaction_reference       ||
      response.data?.txRef                       ||
      `CBE-${Date.now()}`;

    // Save pending payment keyed by txRef
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
      paymentId: txRef,
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
// GET /api/subscriptions/status?uid=...&phone=254XXXXXXXXX  (fallback)
// GET /api/subscriptions/status?checkoutId=CBE-xxxxx
// ══════════════════════════════════════════════════════════════════════════════
router.get('/status', async (req, res) => {
  const { uid, checkoutId, phone: phoneParam } = req.query;

  if (!uid && !checkoutId)
    return res.status(400).json({ success: false, error: 'uid or checkoutId is required' });

  try {
    const db = getDb();

    // ── 1. Primary: check subscribers by uid ─────────────────────────────────
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

      // ── 2. Fallback: find payment record → phone → subscribersByPhone ────────
      try {
        const paySnap = await db.collection('subscriptionPayments')
          .where('uid', '==', uid)
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get();

        if (!paySnap.empty) {
          const pay   = paySnap.docs[0].data();
          const phone = (pay.phone || '').replace(/\D/g, '');

          if (phone) {
            const byPhone = await db.collection('subscribersByPhone').doc(phone).get();
            if (byPhone.exists) {
              const sub       = byPhone.data();
              const expiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
              const active    = expiresAt ? expiresAt > new Date() : !!sub.unlockedAt;

              if (active) {
                db.collection('subscribers').doc(uid)
                  .set(
                    { ...sub, uid, repairedAt: admin.firestore.FieldValue.serverTimestamp() },
                    { merge: true }
                  )
                  .catch(() => {});
              }

              return res.json({
                success:   true,
                active,
                expiresAt: sub.expiresAt || null,
                plan:      sub.planKey   || 'resource_termly',
                uid,
              });
            }
          }

          // ── 2b. NEW: completed payment record is enough to grant access ──────
          // Handles case where webhook wrote subscriptionPayments but missed
          // writing to subscribers (txRef mismatch or partial failure)
          if (pay.status === 'completed' || pay.status === 'confirmed') {
            const plan      = PLAN_CONFIG[pay.planKey] || PLAN_CONFIG['resource_termly'];
            const expiresAt = pay.expiresAt || calcExpiry(plan.daysValid);
            // Repair: write subscriber doc so future lookups skip this fallback
            db.collection('subscribers').doc(uid).set({
              uid,
              phone:      pay.phone || '',
              planKey:    pay.planKey || 'resource_termly',
              planLabel:  plan.label,
              txRef:      pay.txRef,
              expiresAt,
              unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
              repairedFromPayment: true,
            }, { merge: true }).catch(() => {});
            console.log(`[Status] ✅ Repaired from completed payment uid=${uid}`);
            return res.json({ success: true, active: true, expiresAt, plan: pay.planKey, uid });
          }
        }
      } catch (_) {} // non-fatal — fall through
    }

    // ── 3. Direct phone lookup ────────────────────────────────────────────────
    if (phoneParam) {
      const phone   = normalisePhone(phoneParam);
      const byPhone = await db.collection('subscribersByPhone').doc(phone).get();
      if (byPhone.exists) {
        const sub       = byPhone.data();
        const expiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
        const active    = expiresAt ? expiresAt > new Date() : !!sub.unlockedAt;
        if (active && uid) {
          // Repair uid→subscriber link
          db.collection('subscribers').doc(uid)
            .set({ ...sub, uid, repairedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
            .catch(() => {});
        }
        return res.json({
          success:   true,
          active,
          expiresAt: sub.expiresAt || null,
          plan:      sub.planKey   || 'resource_termly',
        });
      }

      // ── 3b. NEW: check for any completed payment by this phone ───────────────
      try {
        const completedPay = await db.collection('subscriptionPayments')
          .where('phone', '==', phone)
          .where('status', '==', 'completed')
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get();

        if (!completedPay.empty) {
          const pay       = completedPay.docs[0].data();
          const plan      = PLAN_CONFIG[pay.planKey] || PLAN_CONFIG['resource_termly'];
          const expiresAt = pay.expiresAt || calcExpiry(plan.daysValid);
          const targetUid = uid || pay.uid;

          // Write both indexes
          if (targetUid) {
            db.collection('subscribers').doc(targetUid).set({
              uid: targetUid, phone, planKey: pay.planKey,
              planLabel: plan.label, txRef: pay.txRef, expiresAt,
              unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
              repairedFromPayment: true,
            }, { merge: true }).catch(() => {});
          }
          db.collection('subscribersByPhone').doc(phone).set({
            uid: targetUid || null, phone, planKey: pay.planKey,
            txRef: pay.txRef, expiresAt,
            unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true }).catch(() => {});

          console.log(`[Status] ✅ Repaired from completed payment phone=${phone}`);
          return res.json({ success: true, active: true, expiresAt, plan: pay.planKey });
        }
      } catch (_) {}
    }

    // ── 4. checkoutId lookup ──────────────────────────────────────────────────
    if (checkoutId) {
      const payDoc = await db.collection('subscriptionPayments').doc(checkoutId).get();
      if (!payDoc.exists)
        return res.json({ success: true, status: 'pending', paid: false, active: false });
      const data   = payDoc.data();
      const isPaid = data.status === 'completed' || data.status === 'confirmed';
      return res.json({
        success:  true,
        status:   isPaid ? 'completed' : (data.status || 'pending'),
        paid:     isPaid,
        active:   isPaid,
        plan:     data.planKey || 'resource_termly',
        uid:      data.uid     || null,
      });
    }

    // ── 5. Nothing found ──────────────────────────────────────────────────────
    return res.json({ success: true, active: false, expiresAt: null });

  } catch (err) {
    console.error('[Status] Error:', err.message);
    res.status(500).json({ success: false, error: 'Could not check status' });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 3 — Paynecta Webhook
// POST /api/subscriptions/webhook
// express.raw() for this path is set in server.js BEFORE express.json()
// ══════════════════════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
  res.json({ received: true }); // fast 200 first

  try {
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString('utf8'));
    } else {
      payload = req.body;
    }

    // ── RAW LOG — tells us exactly what Paynecta sends ──────────────────────
    console.log('[Webhook] RAW:', JSON.stringify(payload));

    // ── Wide field extraction — covers multiple Paynecta payload shapes ──────
    const data      = payload.data       || payload.Body?.stkCallback || payload;
    const tx        = data.transaction   || data.CallbackMetadata     || {};
    const metaItems = tx.Item            || data.Item                 || null;

    const txRef =
      tx.reference                                    ||
      data.reference                                  ||
      payload.reference                               ||
      payload.txRef                                   ||
      payload.transaction_reference                   ||
      data.transaction_reference                      ||
      data.CheckoutRequestID                          ||
      payload.CheckoutRequestID                       ||
      data.id                                         ||
      payload.id                                      ||
      null;

    const rawStatus =
      tx.status       ||
      data.status     ||
      payload.status  ||
      (data.ResultCode === 0   ? 'completed' :
       data.ResultCode != null ? 'failed'    : null);

    const eventType =
      payload.event_type ||
      payload.event      ||
      (rawStatus === 'completed' || data.ResultCode === 0 ? 'payment.completed' :
       rawStatus === 'failed'                             ? 'payment.failed'    : null);

    const mpesaCode =
      data.MpesaReceiptNumber                          ||
      data.mpesa_receipt                               ||
      tx.mpesa_receipt                                 ||
      extractCallbackItem(metaItems, 'MpesaReceiptNumber') ||
      null;

    const mobile =
      data.customer?.mobile_number                     ||
      data.phone                                       ||
      payload.phone                                    ||
      extractCallbackItem(metaItems, 'PhoneNumber')    ||
      null;

    console.log('[Webhook] Parsed:', { eventType, txRef, rawStatus, mpesaCode, mobile });

    if (!txRef) {
      console.warn('[Webhook] ⚠️  txRef is null — cannot match payment. Full payload above.');
      // Still try phone-based recovery if we have a success signal + phone
      const isSuccessNoRef =
        eventType === 'payment.completed' ||
        ['completed', 'confirmed', 'success'].includes(rawStatus) ||
        data.ResultCode === 0;

      if (isSuccessNoRef && mobile) {
        const phone = normalisePhone(mobile);
        console.log('[Webhook] Attempting phone-based recovery for:', phone);
        const db = getDb();
        // Find the most recent pending payment for this phone
        const paySnap = await db.collection('subscriptionPayments')
          .where('phone', '==', phone)
          .where('status', '==', 'pending')
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get();

        if (!paySnap.empty) {
          const payData   = paySnap.docs[0].data();
          const payTxRef  = paySnap.docs[0].id;
          const uid       = payData.uid;
          const plan      = PLAN_CONFIG[payData.planKey] || PLAN_CONFIG['resource_termly'];
          const expiresAt = calcExpiry(plan.daysValid);

          await db.collection('subscriptionPayments').doc(payTxRef).update({
            status: 'completed', mpesaCode: mpesaCode || null,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          if (uid) {
            await db.collection('subscribers').doc(uid).set({
              uid, phone, planKey: payData.planKey || 'resource_termly',
              planLabel: plan.label, txRef: payTxRef, mpesaCode: mpesaCode || null,
              expiresAt, unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
              amount: payData.amount || plan.amount, recoveredByPhone: true,
            }, { merge: true });
            console.log(`[Webhook] ✅ Phone recovery: subscriber written uid=${uid}`);
          }

          await db.collection('subscribersByPhone').doc(phone).set({
            uid: uid || null, phone, planKey: payData.planKey || 'resource_termly',
            txRef: payTxRef, mpesaCode: mpesaCode || null, expiresAt,
            unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          console.log(`[Webhook] ✅ Phone recovery complete phone=${phone}`);
        } else {
          console.warn('[Webhook] ⚠️  Phone recovery: no pending payment found for', phone);
        }
      }
      return;
    }

    const db          = getDb();
    const isCompleted = eventType === 'payment.completed' ||
                        ['completed', 'confirmed', 'success'].includes(rawStatus) ||
                        data.ResultCode === 0;
    const isFailed    = eventType === 'payment.failed' ||
                        ['failed', 'cancelled', 'timeout'].includes(rawStatus) ||
                        (data.ResultCode != null && data.ResultCode !== 0);

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

      // 3. Write subscriber record keyed by Firebase uid
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

      // 4. Also index by phone for fallback lookups
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
        lastEvent:     eventType || null,
        lastRawStatus: rawStatus || null,
      }).catch(() => {}); // doc may not exist yet for intermediate events
    }

  } catch (err) {
    console.error('[Webhook] Error:', err.message, err.stack);
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
        plan:      sub.planKey   || 'resource_termly',
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
    res.json({ success: true, isPro: doc.exists, data: doc.exists ? doc.data() : null });
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
