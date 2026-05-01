/**
 * CBE Resource Hub — Backend Server
 * Add these routes to your existing instasend-backend Express app
 *
 * USAGE: In your existing server.js, add:
 *   const resourceRoutes      = require('./routes/resources');
 *   const subscriptionRoutes  = require('./routes/subscriptions');
 *   app.use('/api/resources',      resourceRoutes);
 *   app.use('/api/subscriptions',  subscriptionRoutes);
 */

// ── This file is a STANDALONE demo server ──
// In production, merge into your existing server.js

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

// ── Firebase Admin init (skip if already initialized in your server.js) ──
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const app = express();

app.use(cors({ origin: '*' }));

// ── Raw body for webhook signature verification ──
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes ──
app.use('/api/resources',     require('./routes/resources'));
app.use('/api/subscriptions', require('./routes/subscriptions'));

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'cbe-resource-hub', ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CBE Resource backend running on :${PORT}`));
