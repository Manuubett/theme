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
      // ✅ FIXED: must be \\n not \n to correctly unescape Render env var
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const app = express();

// ── CORS ──
app.use(cors({ origin: '*' }));

// ── Raw body MUST come before express.json() ──
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

// ── Env vars check — confirms which variables are set (no secrets exposed) ──
app.get('/api/test-env', (req, res) => {
  res.json({
    FIREBASE_PROJECT_ID:   !!process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY:  !!process.env.FIREBASE_PRIVATE_KEY,
    PRIVATE_KEY_LENGTH:    (process.env.FIREBASE_PRIVATE_KEY || '').length,
    PRIVATE_KEY_STARTS:    (process.env.FIREBASE_PRIVATE_KEY || '').substring(0, 30),
    CF_ACCOUNT_ID:         !!process.env.CF_ACCOUNT_ID,
    R2_ACCESS_KEY_ID:      !!process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY:  !!process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME:        process.env.R2_BUCKET_NAME || 'NOT SET',
    BACKEND_URL:           process.env.BACKEND_URL    || 'NOT SET',
  });
});

// ── Firestore connection test ──
app.get('/api/test-db', async (req, res) => {
  try {
    const snap = await admin.firestore().collection('resources').limit(1).get();
    res.json({ ok: true, docs: snap.size, message: 'Firestore connected' });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, code: e.code });
  }
});

// ── R2 connection test ──
app.get('/api/test-r2', async (req, res) => {
  try {
    const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const r2 = new S3Client({
      region:   'auto',
      endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    const data = await r2.send(new ListObjectsV2Command({
      Bucket:  process.env.R2_BUCKET_NAME || 'cbe-resources',
      MaxKeys: 5,
    }));
    res.json({
      ok:    true,
      files: (data.Contents || []).map(f => f.Key),
      count: data.KeyCount || 0,
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ── Start ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ CBE Resource Hub running on port ${PORT}`);
  console.log(`   Health:  https://cbe-y1zb.onrender.com/api/health`);
  console.log(`   Env:     https://cbe-y1zb.onrender.com/api/test-env`);
  console.log(`   DB:      https://cbe-y1zb.onrender.com/api/test-db`);
  console.log(`   R2:      https://cbe-y1zb.onrender.com/api/test-r2`);
});
