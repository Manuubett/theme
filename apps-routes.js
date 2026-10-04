// apps-routes.js  -  add to your existing Express server on Render
//
// 1. Install:  npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
// 2. In server.js:
//      const appsRouter = require('./apps-routes')(admin);   // admin = your firebase-admin instance
//      app.use('/api/apps', appsRouter);
// 3. Render environment variables:
//      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//      ADMIN_UIDS   (optional fallback: comma-separated UIDs that are always admins)
// 3b. Admins are managed in Firestore: collection "admins", document ID = the user's UID
//     (add one field, e.g. role: "owner"). No redeploy needed to add or remove admins.
// 4. Firebase Console > Authentication > enable "Anonymous" sign-in (used for ratings)
//
// New in this version:
//   ogImage field on apps (https link, used for WhatsApp/social preview)
//   POST /update            (admin)  set or clear an app's ogImage
//   GET  /reviews/:id       (public) written reviews for an app
//   GET  /share/:id         (public) tiny page with Open Graph tags, then redirects to the store

const express = require('express');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

module.exports = (admin) => {
  const router = express.Router();
  const db = admin.firestore();
  const BUCKET = process.env.R2_BUCKET;
  const ADMINS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const MAX_SIZE = 500 * 1024 * 1024;
  const SITE = 'https://dehemanuelssolutions.co.ke/appstore.html';
  const DEFAULT_OG = 'https://dehemanuelssolutions.co.ke/og-image.jpg';

  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });

  // Admin if listed in Firestore admins/{uid}, or in the ADMIN_UIDS env fallback
  const isAdmin = async (uid) => ADMINS.includes(uid) || (await db.collection('admins').doc(uid).get()).exists;

  const verify = (req) => admin.auth().verifyIdToken((req.headers.authorization || '').replace('Bearer ', ''));

  const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Accept only https links (empty string = no image)
  const cleanImg = (v) => { const s = String(v || '').trim().slice(0, 500); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : ''; };

  async function requireAdmin(req, res, next) {
    try {
      const d = await verify(req);
      if (!(await isAdmin(d.uid))) return res.status(403).json({ error: 'Admins only' });
      next();
    } catch (e) { res.status(401).json({ error: 'Sign in required' }); }
  }

  router.get('/me', async (req, res) => {
    try { res.json({ admin: await isAdmin((await verify(req)).uid) }); }
    catch (e) { res.json({ admin: false }); }
  });

  // Signed URL so the browser uploads straight to R2
  router.post('/upload-url', requireAdmin, async (req, res) => {
    try {
      const { filename, size } = req.body;
      if (!filename || !/\.apk$/i.test(filename)) return res.status(400).json({ error: 'Only .apk files allowed' });
      if (!size || size > MAX_SIZE) return res.status(400).json({ error: 'File too large (max 500 MB)' });
      const key = `apks/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${filename.replace(/[^\w.\-]/g, '_')}`;
      const uploadUrl = await getSignedUrl(r2,
        new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'application/vnd.android.package-archive' }),
        { expiresIn: 900 });
      res.json({ uploadUrl, key });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/create', requireAdmin, async (req, res) => {
    try {
      const { key, name, version, size, icon, desc, changelog, ogImage } = req.body;
      if (!key || !key.startsWith('apks/') || !name || !version) return res.status(400).json({ error: 'Missing fields' });
      if (ogImage && !cleanImg(ogImage)) return res.status(400).json({ error: 'Preview image must be an https link' });
      const ref = await db.collection('apps').add({
        key, name, version, size: Number(size) || 0, icon: icon || '', desc: desc || '', changelog: changelog || '',
        ogImage: cleanImg(ogImage),
        downloads: 0, ratingSum: 0, ratingCount: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.json({ id: ref.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Admin: set or clear the preview image of an existing app
  router.post('/update', requireAdmin, async (req, res) => {
    try {
      const { appId, ogImage } = req.body;
      if (ogImage && !cleanImg(ogImage)) return res.status(400).json({ error: 'Preview image must be an https link' });
      const ref = db.collection('apps').doc(String(appId || ''));
      if (!(await ref.get()).exists) return res.status(404).json({ error: 'App not found' });
      await ref.update({ ogImage: cleanImg(ogImage) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Public: short-lived download link + download counter
  router.post('/download', async (req, res) => {
    try {
      const snap = await db.collection('apps').doc(String(req.body.appId || '')).get();
      if (!snap.exists) return res.status(404).json({ error: 'App not found' });
      const a = snap.data();
      const fname = `${a.name}-v${a.version}.apk`.replace(/[^\w.\-]/g, '_');
      const url = await getSignedUrl(r2, new GetObjectCommand({
        Bucket: BUCKET, Key: a.key,
        ResponseContentDisposition: `attachment; filename="${fname}"`,
        ResponseContentType: 'application/vnd.android.package-archive',
      }), { expiresIn: 300 });
      snap.ref.update({ downloads: admin.firestore.FieldValue.increment(1) }).catch(() => {});
      res.json({ url });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Public ratings: one per user (anonymous is fine) per app; rating again replaces the old one
  router.post('/rate', async (req, res) => {
    let decoded;
    try { decoded = await verify(req); } catch (e) { return res.status(401).json({ error: 'Please try again' }); }
    try {
      const stars = Number(req.body.stars);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'Stars must be 1 to 5' });
      const appRef = db.collection('apps').doc(String(req.body.appId || ''));
      const rateRef = appRef.collection('ratings').doc(decoded.uid);
      await db.runTransaction(async (t) => {
        const [appSnap, rateSnap] = await Promise.all([t.get(appRef), t.get(rateRef)]);
        if (!appSnap.exists) throw new Error('App not found');
        let sum = appSnap.data().ratingSum || 0, count = appSnap.data().ratingCount || 0;
        if (rateSnap.exists) sum -= rateSnap.data().stars; else count += 1;
        t.set(rateRef, { stars, comment: String(req.body.comment || '').slice(0, 300), createdAt: admin.firestore.FieldValue.serverTimestamp() });
        t.update(appRef, { ratingSum: sum + stars, ratingCount: count });
      });
      res.json({ ok: true });
    } catch (e) { res.status(e.message === 'App not found' ? 404 : 500).json({ error: e.message }); }
  });

  // Public: written reviews (no user IDs are exposed)
  router.get('/reviews/:id', async (req, res) => {
    try {
      const snap = await db.collection('apps').doc(String(req.params.id)).collection('ratings')
        .orderBy('createdAt', 'desc').limit(100).get();
      const reviews = snap.docs.map(d => d.data()).filter(r => r.comment).slice(0, 50)
        .map(r => ({ stars: r.stars, comment: r.comment, createdAt: r.createdAt && r.createdAt.toMillis ? r.createdAt.toMillis() : null }));
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ reviews });
    } catch (e) { res.status(500).json({ error: 'Could not load reviews' }); }
  });

  // Public: link to share. WhatsApp/Facebook read the tags; people are sent on to the store.
  router.get('/share/:id', async (req, res) => {
    try {
      const snap = await db.collection('apps').doc(String(req.params.id)).get();
      if (!snap.exists) return res.redirect(SITE);
      const a = snap.data(), url = `${SITE}?app=${snap.id}`;
      const rating = a.ratingCount ? ` ★ ${(a.ratingSum / a.ratingCount).toFixed(1)}/5` : '';
      const title = `${a.name} v${a.version} | Free Android app`;
      const desc = ((a.desc || 'Free Android app built in Kenya.').slice(0, 150) + rating).trim();
      const img = cleanImg(a.ogImage) || DEFAULT_OG;
      res.set('Cache-Control', 'public, max-age=300');
      res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="DEH EMANUELS SOLUTIONS">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0;url=${esc(url)}">
</head><body><p><a href="${esc(url)}">Open ${esc(a.name)} in the App Store</a></p></body></html>`);
    } catch (e) { res.redirect(SITE); }
  });

  router.post('/delete', requireAdmin, async (req, res) => {
    try {
      const ref = db.collection('apps').doc(String(req.body.appId || ''));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'App not found' });
      await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: snap.data().key }));
      await ref.delete();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};

/* ---------- Firestore rules (unchanged) ----------
match /apps/{id} {
  allow read: if true;
  allow write: if false;        // only the backend (Admin SDK) writes
  match /ratings/{uid} { allow read, write: if false; }
}
match /admins/{uid} { allow read, write: if false; }   // managed in the console only

---------- R2 bucket CORS (R2 > bucket > Settings > CORS policy) ----------
[{ "AllowedOrigins": ["https://apps.yourdomain.com"],
   "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
Use the domain where you host admin.html (uploads come from there).
*/
