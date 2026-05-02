/**
 * CBE Resource Hub — R2 Resource Routes
 * Handles upload, download (presigned URL), list, and delete
 * All premium downloads gated behind Firestore subscription check
 *
 * Watermarking: pdf-lib stamps each downloaded PDF in memory
 *   - Diagonal brand text across every page
 *   - Footer strip with brand + personalised licence info
 *   - Original file in R2 is NEVER modified
 *
 * npm install pdf-lib axios
 */

const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { GetObjectCommand }  = require('@aws-sdk/client-s3');
const { getSignedUrl }      = require('@aws-sdk/s3-request-presigner');
const admin  = require('firebase-admin');
const router = express.Router();

// ── R2 Client ──────────────────────────────
const r2 = new S3Client({
  region:   'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'cbe-resources';
const db     = admin.firestore();

// ── Multer — memory storage ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only PDF and DOCX files are allowed'));
  },
});

// ════════════════════════════════════════════
// WATERMARK UTILITY
//
// Stamps every page of a PDF Buffer with:
//   1. Diagonal semi-transparent brand text (centre of page, tiled)
//   2. Bottom footer bar: brand name | licence info | website
//
// @param {Buffer}  pdfBuffer
// @param {object}  opts
//   licenseeName  {string}  e.g. "Jane Wanjiku"
//   licenseeId    {string}  e.g. "0712 345 678"
// @returns {Buffer} stamped PDF
// ════════════════════════════════════════════
async function stampWatermark(pdfBuffer, { licenseeName = '', licenseeId = '' } = {}) {
  const pdfDoc  = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages   = pdfDoc.getPages();

  // ── Colour palette ──
  const brandBlue  = rgb(0.23, 0.51, 0.96);  // #3b82f6
  const brandGold  = rgb(0.96, 0.62, 0.04);  // #f59e0b
  const navyBg     = rgb(0.06, 0.09, 0.20);  // dark footer
  const white      = rgb(1,    1,    1);
  const diagColour = rgb(0.23, 0.51, 0.96);  // same blue, low opacity

  const BRAND   = 'Smart Resource Hub';
  const WEBSITE = 'bett.website';
  const now     = new Date().toLocaleDateString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  // Build personalised licence string
  const licText = licenseeName
    ? `Licensed to: ${licenseeName}${licenseeId ? '  ·  ' + licenseeId : ''}  ·  ${now}`
    : `Downloaded: ${now}  ·  ${WEBSITE}`;

  for (const page of pages) {
    const { width, height } = page.getSize();
    const cx = width  / 2;
    const cy = height / 2;

    // ────────────────────────────────────────
    // 1. DIAGONAL WATERMARK
    // ────────────────────────────────────────
    const diagSize = Math.max(18, Math.min(width, height) * 0.065);
    const diagW    = bold.widthOfTextAtSize(BRAND, diagSize);

    // Centre — main stamp
    page.drawText(BRAND, {
      x:       cx - diagW / 2,
      y:       cy,
      size:    diagSize,
      font:    bold,
      color:   diagColour,
      opacity: 0.10,
      rotate:  degrees(45),
    });

    // Upper-left tile
    page.drawText(BRAND, {
      x:       cx - diagW / 2 - width  * 0.30,
      y:       cy + height * 0.28,
      size:    diagSize * 0.80,
      font:    bold,
      color:   diagColour,
      opacity: 0.07,
      rotate:  degrees(45),
    });

    // Lower-right tile
    page.drawText(BRAND, {
      x:       cx - diagW / 2 + width  * 0.28,
      y:       cy - height * 0.26,
      size:    diagSize * 0.80,
      font:    bold,
      color:   diagColour,
      opacity: 0.07,
      rotate:  degrees(45),
    });

    // ────────────────────────────────────────
    // 2. FOOTER STRIP
    // ────────────────────────────────────────
    const FH  = 28;   // footer height in pts
    const PAD = 10;   // horizontal padding

    // Dark navy bar
    page.drawRectangle({
      x: 0, y: 0,
      width, height: FH,
      color:   navyBg,
      opacity: 0.93,
    });

    // Gold left accent
    page.drawRectangle({
      x: 0, y: 0,
      width: 3, height: FH,
      color:   brandGold,
      opacity: 1,
    });

    const bSize = 9;
    const bW    = bold.widthOfTextAtSize(BRAND, bSize);
    const midY  = FH / 2 - bSize / 2 + 0.5;

    // Brand name — left, bold blue
    page.drawText(BRAND, {
      x: PAD + 6, y: midY,
      size: bSize, font: bold,
      color: brandBlue, opacity: 1,
    });

    // Separator
    page.drawText('|', {
      x: PAD + 6 + bW + 7, y: midY + 0.5,
      size: bSize, font: regular,
      color: white, opacity: 0.25,
    });

    // Licence text — centre
    const lSize = 7.5;
    const lW    = regular.widthOfTextAtSize(licText, lSize);
    const lX    = Math.min(
      PAD + 6 + bW + 20,
      width / 2 - lW / 2,
    );
    page.drawText(licText, {
      x: lX, y: FH / 2 - lSize / 2 + 0.5,
      size: lSize, font: regular,
      color: white, opacity: 0.80,
    });

    // Website — right, gold
    const wSize = 7.5;
    const wW    = regular.widthOfTextAtSize(WEBSITE, wSize);
    page.drawText(WEBSITE, {
      x: width - PAD - wW, y: FH / 2 - wSize / 2 + 0.5,
      size: wSize, font: regular,
      color: brandGold, opacity: 0.90,
    });
  }

  return Buffer.from(await pdfDoc.save());
}

// ════════════════════════════════════════════
// HELPER — fetch raw file bytes from R2
// ════════════════════════════════════════════
async function fetchFromR2(storagePath) {
  const signedUrl = await getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: BUCKET, Key: storagePath }),
    { expiresIn: 60 }
  );
  const { data } = await axios.get(signedUrl, { responseType: 'arraybuffer' });
  return Buffer.from(data);
}

// ════════════════════════════════════════════
// HELPER — send stamped PDF to client
// ════════════════════════════════════════════
function sendPDF(res, buffer, title) {
  const safe = encodeURIComponent((title || 'resource').replace(/\.[^.]+$/, '')) + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${safe}`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.setHeader('X-Watermarked', 'Smart-Resource-Hub');
  res.end(buffer);
}

// ════════════════════════════════════════════
// MIDDLEWARE — verify Firebase ID token
// ════════════════════════════════════════════
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
    req.uid     = decoded.uid;
    req.schoolId = decoded.schoolId || null;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const snap = await db.collection('users').doc(req.uid).get();
    if (!snap.exists) return res.status(403).json({ error: 'User not found' });
    const { role } = snap.data();
    if (!['owner', 'admin', 'secretary'].includes(role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.userRole = role;
    next();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ════════════════════════════════════════════
// SUBSCRIPTION CHECK
// ════════════════════════════════════════════
async function checkSubscription(uid) {
  try {
    const snap = await db.collection('subscriptions').doc(uid).get();
    if (!snap.exists) return { active: false };
    const sub  = snap.data();
    if (sub.status !== 'active') return { active: false, reason: sub.status };
    const expires = sub.expiresAt?.toDate?.() || new Date(sub.expiresAt);
    if (expires < new Date()) {
      await db.collection('subscriptions').doc(uid).update({ status: 'expired' });
      return { active: false, reason: 'expired' };
    }
    return { active: true, plan: sub.plan, expiresAt: expires };
  } catch (e) {
    console.error('[checkSubscription]', e.message);
    return { active: false, reason: 'error' };
  }
}

// ════════════════════════════════════════════
// GET /api/resources
// Public list — no URLs exposed
// ════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { grade, type, search } = req.query;
    const snap = await db.collection('resources').orderBy('createdAt', 'desc').get();
    let resources = [];
    snap.forEach(doc => {
      const d = doc.data();
      resources.push({
        id: doc.id, title: d.title, desc: d.desc, type: d.type,
        grades: d.grades, free: d.free, pages: d.pages, size: d.size,
        format: d.format, icon: d.icon, subject: d.subject || '',
        downloads: d.downloads || 0, createdAt: d.createdAt,
        // storagePath never sent to client
      });
    });
    if (grade && grade !== 'all') resources = resources.filter(r => r.grades === grade || r.grades === '1-9');
    if (type  && type  !== 'all') resources = resources.filter(r => r.type === type);
    if (search) {
      const q = search.toLowerCase();
      resources = resources.filter(r =>
        r.title.toLowerCase().includes(q) ||
        r.desc.toLowerCase().includes(q)  ||
        (r.subject || '').toLowerCase().includes(q)
      );
    }
    res.json({ resources, total: resources.length });
  } catch (e) {
    console.error('[GET /resources]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// POST /api/resources/download-free
// FREE resources — NO auth required
// Fetches from R2 → stamps watermark → streams PDF
// Security: resource.free === true is the hard gate
// ════════════════════════════════════════════
router.post('/download-free', async (req, res) => {
  const { resourceId, downloaderName = '', downloaderPhone = '' } = req.body;
  if (!resourceId) return res.status(400).json({ error: 'resourceId required' });

  try {
    const docSnap = await db.collection('resources').doc(resourceId).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Resource not found' });
    const resource = docSnap.data();

    if (!resource.free) {
      return res.status(403).json({ error: 'Subscription required', code: 'SUBSCRIPTION_REQUIRED' });
    }
    if (!resource.storagePath) {
      return res.status(404).json({ error: 'File not attached yet — check back soon' });
    }

    const rawBuffer = await fetchFromR2(resource.storagePath);
    const stamped   = await stampWatermark(rawBuffer, {
      licenseeName: downloaderName  || 'Free Download',
      licenseeId:   downloaderPhone || '',
    });

    // Async side effects
    db.collection('resources').doc(resourceId)
      .update({ downloads: admin.firestore.FieldValue.increment(1) })
      .catch(() => {});
    db.collection('downloadLogs').add({
      resourceId, resourceTitle: resource.title,
      uid: 'anonymous', phone: downloaderPhone || null,
      plan: 'free', watermarked: true,
      downloadedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    sendPDF(res, stamped, resource.title);

  } catch (e) {
    console.error('[download-free]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed — please try again' });
  }
});

// ════════════════════════════════════════════
// POST /api/resources/download
// PREMIUM resources — auth + subscription required
// Fetches from R2 → stamps personalised watermark → streams PDF
// ════════════════════════════════════════════
router.post('/download', requireAuth, async (req, res) => {
  const { resourceId } = req.body;
  if (!resourceId) return res.status(400).json({ error: 'resourceId required' });

  try {
    const docSnap = await db.collection('resources').doc(resourceId).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Resource not found' });
    const resource = docSnap.data();

    if (!resource.free) {
      const sub = await checkSubscription(req.uid);
      if (!sub.active) {
        return res.status(403).json({
          error: 'Subscription required', reason: sub.reason, code: 'SUBSCRIPTION_REQUIRED',
        });
      }
    }
    if (!resource.storagePath) return res.status(404).json({ error: 'File not attached yet' });

    // Resolve personalised watermark info
    let licenseeName = '', licenseeId = '';
    try {
      const userRecord = await admin.auth().getUser(req.uid);
      licenseeName = userRecord.displayName || userRecord.email || '';
      const userDoc = await db.collection('users').doc(req.uid).get();
      if (userDoc.exists) {
        const u = userDoc.data();
        licenseeName = u.name  || licenseeName;
        licenseeId   = u.phone || userRecord.email || req.uid.substring(0, 10);
      } else {
        licenseeId = userRecord.email || req.uid.substring(0, 10);
      }
    } catch (_) {
      licenseeName = 'Subscriber';
      licenseeId   = req.uid.substring(0, 10);
    }

    const rawBuffer = await fetchFromR2(resource.storagePath);
    const stamped   = await stampWatermark(rawBuffer, { licenseeName, licenseeId });

    // Async side effects
    db.collection('resources').doc(resourceId)
      .update({ downloads: admin.firestore.FieldValue.increment(1) })
      .catch(() => {});
    db.collection('downloadLogs').add({
      resourceId, resourceTitle: resource.title,
      uid: req.uid, licenseeName, licenseeId,
      plan: resource.free ? 'free' : 'premium',
      watermarked: true,
      downloadedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    sendPDF(res, stamped, resource.title);

  } catch (e) {
    console.error('[download]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed — please try again' });
  }
});

// ════════════════════════════════════════════
// POST /api/resources/upload — owner/admin only
// ════════════════════════════════════════════
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { title, desc, type, grades, free, pages, subject, icon } = req.body;
  if (!title || !type || !grades) return res.status(400).json({ error: 'title, type and grades are required' });
  try {
    const ext     = req.file.mimetype === 'application/pdf' ? 'pdf' : 'docx';
    const format  = ext.toUpperCase();
    const slug    = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60);
    const key     = `resources/${Date.now()}-${slug}.${ext}`;
    const sizeKB  = Math.round(req.file.size / 1024);
    const sizeStr = sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)}MB` : `${sizeKB}KB`;
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key,
      Body: req.file.buffer, ContentType: req.file.mimetype,
      Metadata: { title, uploadedBy: req.uid },
    }));
    const docRef = await db.collection('resources').add({
      title, desc: desc || '', type, grades, subject: subject || '',
      free: free === 'true' || free === true,
      pages: parseInt(pages) || 0, size: sizeStr, format,
      icon: icon || (format === 'PDF' ? '📄' : '📝'),
      storagePath: key, downloads: 0, uploadedBy: req.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[Upload] ${title} → ${key} (${sizeStr})`);
    res.json({ success: true, resourceId: docRef.id, size: sizeStr, format, key });
  } catch (e) {
    console.error('[upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// DELETE /api/resources/:id — owner only
// ════════════════════════════════════════════
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.uid).get();
    if (snap.data()?.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
  try {
    const docSnap = await db.collection('resources').doc(req.params.id).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Resource not found' });
    const { storagePath, title } = docSnap.data();
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storagePath }));
    await db.collection('resources').doc(req.params.id).delete();
    console.log(`[Delete] ${title}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[delete]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// PATCH /api/resources/:id — update metadata
// ════════════════════════════════════════════
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const allowed = ['title','desc','type','grades','free','pages','subject','icon'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  try {
    await db.collection('resources').doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// GET /api/resources/stats/summary — dashboard
// ════════════════════════════════════════════
router.get('/stats/summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [resourcesSnap, logsSnap, subsSnap] = await Promise.all([
      db.collection('resources').get(),
      db.collection('downloadLogs')
        .where('downloadedAt', '>=', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)).get(),
      db.collection('subscriptions').where('status', '==', 'active').get(),
    ]);
    let totalDownloads = 0, freeCount = 0, premiumCount = 0;
    const all = [];
    resourcesSnap.forEach(d => {
      totalDownloads += d.data().downloads || 0;
      d.data().free ? freeCount++ : premiumCount++;
      all.push({ id: d.id, ...d.data() });
    });
    const top5 = all.sort((a,b)=>(b.downloads||0)-(a.downloads||0)).slice(0,5)
      .map(r=>({ id:r.id, title:r.title, downloads:r.downloads||0, type:r.type }));
    res.json({
      totalResources: resourcesSnap.size, freeResources: freeCount,
      premiumResources: premiumCount, totalDownloads,
      downloadsLast30d: logsSnap.size, activeSubscribers: subsSnap.size,
      top5Downloaded: top5,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
