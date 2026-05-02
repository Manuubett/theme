/**
 * CBE Resource Hub — Subscription Routes
 * Handles M-Pesa payment webhook → subscription activation
 * Integrates with existing Paynecta webhook pipeline
 */

const express = require('express');
const admin   = require('firebase-admin');
const axios   = require('axios');
const router  = express.Router();

const db = admin.firestore();

// ── Plan config ──
const PLANS = {
  resource_termly: {
    name:      'Termly Access',
    months:    4,           // ~1 term
    amount:    300,
    label:     'termly',
  },
  resource_annual: {
    name:      'Annual Access',
    months:    12,
    amount:    800,
    label:     'annual',
  },
  resource_school: {
    name:      'School License',
    months:    4,
    amount:    2500,
    label:     'school',
    isSchool:  true,
  },
};

// ── Tolerance: allow Ksh 5 underpayment (M-Pesa rounding) ──
const TOLERANCE = 5;

// ════════════════════════════════════════════
// POST /api/subscriptions/initiate
// Called by frontend before STK Push
// Creates a pending subscription record so webhook can match it
// ════════════════════════════════════════════
router.post('/initiate', async (req, res) => {
  const { uid, planKey, phone, name, schoolId } = req.body;
  if (!uid || !planKey || !phone) {
    return res.status(400).json({ error: 'uid, planKey and phone required' });
  }

  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  try {
    // Verify uid exists in Firestore users
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

    // Create pending subscription record
    const ref = await db.collection('subscriptionPayments').add({
      uid,
      planKey,
      planName:  plan.name,
      amount:    plan.amount,
      phone:     phone.replace(/\s/g, ''),
      name:      name || userSnap.data().fullName || '',
      schoolId:  schoolId || userSnap.data().schoolId || '',
      status:    'pending',
      isSchool:  plan.isSchool || false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Trigger STK Push via Paynecta
    let stkRef = null;
    try {
      const stkRes = await axios.post(
        'https://api.paynecta.com/stk-push',
        {
          merchantCode: process.env.PAYNECTA_CODE,
          phone:        phone.replace(/\s/g, '').replace(/^0/, '254'),
          amount:       plan.amount,
          reference:    ref.id,                          // use our Firestore doc ID as ref
          description:  `CBE Resources - ${plan.name}`,
          callbackUrl:  `${process.env.BACKEND_URL}/api/subscriptions/webhook`,
        },
        {
          headers: { Authorization: `Bearer ${process.env.PAYNECTA_SECRET}` },
          timeout: 10000,
        }
      );
      stkRef = stkRes.data?.txRef || stkRes.data?.reference || null;

      // Store the Paynecta txRef for webhook matching
      if (stkRef) {
        await db.collection('subscriptionPayments').doc(ref.id).update({ txRef: stkRef });
      }
    } catch (stkErr) {
      console.error('[STK Push error]', stkErr.message);
      // Don't fail the whole request — let webhook handle it
    }

    res.json({
      success:   true,
      paymentId: ref.id,
      txRef:     stkRef,
      amount:    plan.amount,
      plan:      plan.name,
    });
  } catch (e) {
    console.error('[POST /subscriptions/initiate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// POST /api/subscriptions/webhook
// Paynecta webhook — activates subscription on confirmed payment
// ════════════════════════════════════════════
router.post('/webhook', express.json(), async (req, res) => {
  // Acknowledge immediately — process async
  res.status(200).json({ received: true });

  try {
    const body = req.body;
    console.log('[Resource Webhook]', JSON.stringify(body));

    // ── Parse Paynecta payload (same structure as your existing webhook) ──
    const tx     = body?.data?.transaction || body?.data || body;
    const status = (tx.status || '').toLowerCase();
    const txRef  = tx.txRef || tx.reference || tx.tx_ref || '';
    const amount = parseFloat(tx.amount || tx.charged_amount || 0);
    const phone  = (tx.customer?.phone_number || tx.phone || '').replace(/\s/g, '');

    if (!['completed', 'confirmed', 'successful', 'success'].includes(status)) {
      console.log(`[Resource Webhook] Ignoring status: ${status}`);
      await notifyTelegram(`ℹ️ Resource payment ${status}\nRef: ${txRef}\nAmount: ${amount}`);
      return;
    }

    // ── Find the pending payment record ──
    let payDoc = null;
    let payRef  = null;

    // Try by txRef first
    if (txRef) {
      const snap = await db.collection('subscriptionPayments')
        .where('txRef', '==', txRef)
        .where('status', '==', 'pending')
        .limit(1).get();
      if (!snap.empty) { payDoc = snap.docs[0].data(); payRef = snap.docs[0].ref; }
    }

    // Fallback: match by phone + pending + recent (last 30 min)
    if (!payDoc && phone) {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000);
      const snap = await db.collection('subscriptionPayments')
        .where('phone', 'in', [phone, phone.replace(/^254/, '0')])
        .where('status', '==', 'pending')
        .where('createdAt', '>=', cutoff)
        .orderBy('createdAt', 'desc')
        .limit(1).get();
      if (!snap.empty) { payDoc = snap.docs[0].data(); payRef = snap.docs[0].ref; }
    }

    if (!payDoc) {
      console.warn('[Resource Webhook] No matching pending payment for', txRef, phone);
      await notifyTelegram(`⚠️ Resource webhook — no match\nRef: ${txRef}\nPhone: ${phone}\nAmount: ${amount}`);
      return;
    }

    const plan     = PLANS[payDoc.planKey];
    const expected = plan?.amount || payDoc.amount;

    // ── Amount check ──
    if (amount < expected - TOLERANCE) {
      await payRef.update({ status: 'underpaid', paidAmount: amount, txRef });
      await notifyTelegram(
        `⚠️ Resource underpayment\n` +
        `Plan: ${payDoc.planName}\n` +
        `Expected: Ksh ${expected} | Paid: Ksh ${amount}\n` +
        `Phone: ${phone}`
      );
      return;
    }

    // ── Activate subscription ──
    const now     = new Date();
    const expires = new Date(now);
    expires.setMonth(expires.getMonth() + (plan?.months || 4));

    const subData = {
      uid:       payDoc.uid,
      planKey:   payDoc.planKey,
      plan:      plan?.label || payDoc.planKey,
      planName:  payDoc.planName,
      status:    'active',
      amount:    payDoc.amount,
      paidAmount: amount,
      phone:     payDoc.phone,
      name:      payDoc.name,
      schoolId:  payDoc.schoolId || '',
      isSchool:  payDoc.isSchool || false,
      txRef,
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.FieldValue.serverTimestamp(), // overridden below
      updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
    };

    // Use a batch to update both documents atomically
    const batch = db.batch();

    // Write/merge subscription doc keyed by uid
    const subRef = db.collection('subscriptions').doc(payDoc.uid);
    batch.set(subRef, {
      ...subData,
      expiresAt:   expires,
      activatedAt: now,
      updatedAt:   now,
    }, { merge: true });

    // If school plan — also write school-level subscription
    if (payDoc.isSchool && payDoc.schoolId) {
      const schoolSubRef = db.collection('schoolSubscriptions').doc(payDoc.schoolId);
      batch.set(schoolSubRef, {
        schoolId:    payDoc.schoolId,
        plan:        'school',
        status:      'active',
        activatedBy: payDoc.uid,
        expiresAt:   expires,
        activatedAt: now,
        updatedAt:   now,
      }, { merge: true });
    }

    // Mark payment as confirmed
    batch.update(payRef, {
      status:      'confirmed',
      paidAmount:  amount,
      txRef,
      confirmedAt: now,
    });

    await batch.commit();

    console.log(`[Resource Sub] Activated ${plan?.label} for ${payDoc.uid} until ${expires.toDateString()}`);

    await notifyTelegram(
      `✅ Resource subscription activated!\n` +
      `Plan: ${payDoc.planName}\n` +
      `Amount: Ksh ${amount}\n` +
      `Phone: ${phone}\n` +
      `Expires: ${expires.toDateString()}`
    );

  } catch (e) {
    console.error('[Resource Webhook error]', e.message);
    await notifyTelegram(`❌ Resource webhook error: ${e.message}`);
  }
});

// ════════════════════════════════════════════
// GET /api/subscriptions/status
// Check current user's subscription status
// Called by frontend after payment to confirm activation
// ════════════════════════════════════════════
router.get('/status', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  try {
    const snap = await db.collection('subscriptions').doc(uid).get();
    if (!snap.exists) return res.json({ active: false });

    const sub  = snap.data();
    const now  = new Date();
    const exp  = sub.expiresAt?.toDate?.() || new Date(sub.expiresAt);
    const active = sub.status === 'active' && exp > now;

    res.json({
      active,
      plan:      sub.plan || null,
      planName:  sub.planName || null,
      expiresAt: exp.toISOString(),
      isSchool:  sub.isSchool || false,
      daysLeft:  active ? Math.ceil((exp - now) / (1000 * 60 * 60 * 24)) : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// TELEGRAM NOTIFICATIONS
// ════════════════════════════════════════════
async function notifyTelegram(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id:    chatId,
      text:       `📚 [Resource Hub]\n${msg}`,
      parse_mode: 'HTML',
    }, { timeout: 5000 });
  } catch (_) {}
}

module.exports = router;
