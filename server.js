/**
 * CBE Resource Hub — Backend Server
 * Deployed at: https://cbe-y1zb.onrender.com
 * Copyright © 2026 Bett Emanuel — https://bett.website
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

// ── Firebase Admin ──
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

// ── CORS ──
app.use(cors({ origin: '*' }));

// ── Raw body MUST come before express.json() ──
// Webhook needs raw body for signature verification
app.use('/api/subscriptions/webhook', express.raw({ type: '*/*' }));

// ── JSON + form body ──
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════
app.use('/api/resources',     require('./routes/resources'));
app.use('/api/subscriptions', require('./routes/subscriptions'));

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    ok:      true,
    service: 'cbe-resource-hub',
    version: '1.0.0',
    ts:      new Date().toISOString(),
  });
});

// ── 404 fallback ──
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large — maximum 20MB' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ CBE Resource Hub running on port ${PORT}`);
  console.log(`   Health: https://cbe-y1zb.onrender.com/api/health`);
});
