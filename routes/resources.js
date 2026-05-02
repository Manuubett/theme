/**
 * CBE Resource Hub — R2 Resource Routes
 * Handles upload, download (presigned URL + watermark), list, delete
 * Premium downloads gated behind Firestore subscription check
 * PDFs are watermarked on-the-fly with downloader's phone/name before delivery
 */

const express  = require('express');
const multer   = require('multer');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl }  = require('@aws-sdk/s3-request-presigner');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const admin  = require('firebase-admin');
const router = express.Router();

// ── R2 Client ──
const r2 = new S3Client({
  region:   'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'cbe-resources';

// ── Multer — memory storage ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF and DOCX files are allowed'));
  },
});

const db = admin.firestore();

// ════════════════════════════════════════════
// WATERMARK HELPER
// Downloads PDF from R2, stamps watermark on every page, returns buffer
// ════════════════════════════════════════════
async function applyWatermark(storagePath, downloaderLabel) {
  // 1. Fetch raw PDF bytes from R2
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: storagePath });
  const s3Res = await r2.send(cmd);

  // Convert stream to Buffer
  const chunks = [];
  for await (const chunk of s3Res.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const pdfBytes = Buffer.concat(chunks);

  // 2. Load with pdf-lib
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages  = pdfDoc.getPages();
  const font   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // ── Watermark text lines ──
  const line1 = 'CBE Resource Hub';
  const line2 = `Licensed to ${downloaderLabel}`;
  const line3 = 'bett.website · Unauthorized sharing prohibited';

  for (const page of pages) {
    const { width, height } = page.getSize();

    // ── DIAGONAL watermark (centre, 45°) ──
    const diagSize  = Math.min(width, height) * 0.048;
    const diagColor = rgb(0.75, 0.75, 0.75); // light grey
    const diagOpts  = {
      font,
      size:    diagSize,
      color:   diagColor,
      opacity: 0.22,
      rotate:  degrees(45),
    };

    // Centre of page
    const cx = width  / 2;
    const cy = height / 2;

    // Three diagonal lines, stacked
    page.drawText(line1, {
      ...diagOpts,
      x: cx - font.widthOfTextAtSize(line1, diagSize) / 2,
      y: cy + diagSize * 3,
    });
    page.drawText(line2, {
      ...diagOpts,
      x: cx - font.widthOfTextAtSize(line2, diagSize) / 2,
      y: cy,
    });
    page.drawText(line3, {
      ...diagOpts,
      size:    diagSize * 0.75,
      x: cx - font.widthOfTextAtSize(line3, diagSize * 0.75) / 2,
      y: cy - diagSize * 3,
    });

    // ── FOOTER watermark (bottom strip) ──
    const footerH   = 22;
    const footerY   = 6;
    const footerSize = 7.5;

    // Footer background strip
    page.drawRectangle({
      x:      0,
      y:      footerY - 2,
      width,
      height: footerH,
      color:  rgb(0.95, 0.95, 0.95),
      opacity: 0.7,
    });

    // Footer left — branding
    page.drawText('© CBE Resource Hub — bett.website', {
      font,
      size:    footerSize,
      color:   rgb(0.4, 0.4, 0.4),
      opacity: 0.9,
      x:       8,
      y:       footerY + 5,
    });

    // Footer right — licence tag
    const licText  = `Licensed to ${downloaderLabel}`;
    const licWidth = font.widthOfTextAtSize(licText, footerSize);
    page.drawText(licText, {
      font,
      size:    footerSize,
      color:   rgb(0.2, 0.4, 0.7),
      opacity: 0.9,
      x:       width - licWidth - 8,
      y:       footerY + 5,
    });
  }

  // 3. Save and return watermarked bytes
  const watermarked = await pdfDoc.save();
  return Buffer.from(watermarked);
}

// ════════════════════════════════════════════
// UPLOAD WATERMARKED PDF TO R2 TEMP KEY
// Returns a signed URL to the temp file
// Temp files are prefixed watermarked/ and keyed by uid+resourceId
// ════════════════════════════════════════════
async function uploadWatermarked(watermarkedBuf, uid, resourceId, filename) {
  const tempKey = `watermarked/${uid}_${resourceId}_${Date.now()}.pdf`;

  await r2.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         tempKey,
    Body:        watermarkedBuf,
    ContentType: 'application/pdf',
    Metadata:    { generatedFor: uid, resourceId },
  }));

  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key:    tempKey,
    ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}.pdf"`,
    ResponseContentType: 'application/pdf',
  });

  // 5-minute expiry — enough time to download
  const url = await getSignedUrl(r2, cmd, { expiresIn: 300 });
  return { url, tempKey };
}

// ════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    req.uid      = decoded.uid;
    req.schoolId = decoded.schoolId || null;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const snap = await db.collection('users').doc(req.uid).get();
    if (!snap.exists) return res.status(403).json({ error: 'User not found' });
    const role = snap.data().role;
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

    const sub = snap.data();
    if (sub.status !== 'active') return { active: false, reason: sub.status };

    const now     = new Date();
    const expires = sub.expiresAt?.toDate?.() || new Date(sub.expiresAt);
    if (expires < now) {
      await db.collection('subscriptions').doc(uid).update({ status: 'expired' });
      return { active: false, reason: 'expired' };
    }
    return { active: true, plan: sub.plan, expiresAt: expires, phone: sub.phone, name: sub.name };
  } catch (e) {
    console.error('[Subscription check error]', e.message);
    return { active: false, reason: 'error' };
  }
}

// ════════════════════════════════════════════
// GET /api/resources
// List all resources — public, no auth
// ════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { grade, type, search } = req.query;
    const snap = await db.collection('resources').orderBy('createdAt', 'desc').get();
    let resources = [];

    snap.forEach(doc => {
      const d = doc.data();
      resources.push({
        id:        doc.id,
        title:     d.title,
        desc:      d.desc,
        type:      d.type,
        grades:    d.grades,
        free:      d.free,
        pages:     d.pages,
        size:      d.size,
        format:    d.format,
        icon:      d.icon,
        subject:   d.subject || '',
        downloads: d.downloads || 0,
        createdAt: d.createdAt,
        // storagePath NEVER sent to client
      });
    });

    if (grade && grade !== 'all') {
      resources = resources.filter(r => r.grades === grade || r.grades === '1-9');
    }
    if (type && type !== 'all') {
      resources = resources.filter(r => r.type === type);
    }
    if (search) {
      const q = search.toLowerCase();
      resources = resources.filter(r =>
        (r.title  ||'').toLowerCase().includes(q) ||
        (r.desc   ||'').toLowerCase().includes(q) ||
        (r.subject||'').toLowerCase().includes(q)
      );
    }

    res.json({ resources, total: resources.length });
  } catch (e) {
    console.error('[GET /resources]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// POST /api/resources/download
// Auth required — watermarks PDF before delivery
// Free resources: anonymous token accepted
// Premium resources: active subscription required
// ════════════════════════════════════════════
router.post('/download', requireAuth, async (req, res) => {
  const { resourceId } = req.body;
  if (!resourceId) return res.status(400).json({ error: 'resourceId required' });

  try {
    const docSnap = await db.collection('resources').doc(resourceId).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Resource not found' });

    const resource = docSnap.data();

    if (!resource.storagePath) {
      return res.status(404).json({ error: 'File not yet attached to this resource' });
    }

    // ── Determine downloader label for watermark ──
    let downloaderLabel = 'User';
    let subPhone = null;
    let subName  = null;

    if (!resource.free) {
      // Premium — check subscription
      const sub = await checkSubscription(req.uid);
      if (!sub.active) {
        return res.status(403).json({
          error:  'Subscription required',
          reason: sub.reason || 'none',
          code:   'SUBSCRIPTION_REQUIRED',
        });
      }
      subPhone = sub.phone || null;
      subName  = sub.name  || null;
    } else {
      // Free — try to get phone from subscriptions doc (may not exist)
      try {
        const subSnap = await db.collection('subscriptions').doc(req.uid).get();
        if (subSnap.exists) {
          subPhone = subSnap.data().phone || null;
          subName  = subSnap.data().name  || null;
        }
      } catch(_) {}
    }

    // Build the watermark label — phone preferred, fallback to name, fallback to uid prefix
    if (subPhone) {
      // Format: 0712 345 678
      const p = subPhone.replace(/\D/g,'').replace(/^254/, '0');
      downloaderLabel = p.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3');
    } else if (subName) {
      downloaderLabel = subName;
    } else {
      downloaderLabel = req.uid.substring(0, 8).toUpperCase();
    }

    // ── Apply watermark if PDF ──
    let url;
    if (resource.format === 'PDF' || resource.storagePath.endsWith('.pdf')) {
      const wBuf = await applyWatermark(resource.storagePath, downloaderLabel);
      const result = await uploadWatermarked(
        wBuf,
        req.uid,
        resourceId,
        resource.title || 'resource'
      );
      url = result.url;
    } else {
      // DOCX — serve directly via presigned URL (no watermark for Word docs)
      const cmd = new GetObjectCommand({
        Bucket: BUCKET,
        Key:    resource.storagePath,
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(resource.title || 'resource')}.docx"`,
        ResponseContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      url = await getSignedUrl(r2, cmd, { expiresIn: 120 });
    }

    // ── Increment download counter (non-blocking) ──
    db.collection('resources').doc(resourceId).update({
      downloads: admin.firestore.FieldValue.increment(1),
    }).catch(() => {});

    // ── Log download ──
    db.collection('downloadLogs').add({
      resourceId,
      resourceTitle: resource.title,
      uid:           req.uid,
      downloaderLabel,
      plan:          resource.free ? 'free' : 'premium',
      downloadedAt:  admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    res.json({ url, expiresIn: resource.format === 'PDF' ? 300 : 120 });

  } catch (e) {
    console.error('[POST /resources/download]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// POST /api/resources/upload
// Owner/admin only — upload file to R2 + write Firestore metadata
// ════════════════════════════════════════════
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { title, desc, type, grades, free, pages, subject, icon } = req.body;
  if (!title || !type || !grades) {
    return res.status(400).json({ error: 'title, type and grades are required' });
  }

  try {
    const ext     = req.file.mimetype === 'application/pdf' ? 'pdf' : 'docx';
    const format  = ext.toUpperCase();
    const slug    = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60);
    const key     = `resources/${Date.now()}-${slug}.${ext}`;
    const sizeKB  = Math.round(req.file.size / 1024);
    const sizeStr = sizeKB >= 1024
                      ? `${(sizeKB / 1024).toFixed(1)}MB`
                      : `${sizeKB}KB`;

    await r2.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        req.file.buffer,
      ContentType: req.file.mimetype,
      Metadata:    { title, uploadedBy: req.uid },
    }));

    const docRef = await db.collection('resources').add({
      title,
      desc:        desc    || '',
      type,
      grades,
      subject:     subject || '',
      free:        free === 'true' || free === true,
      pages:       parseInt(pages) || 0,
      size:        sizeStr,
      format,
      icon:        icon || (format === 'PDF' ? '📄' : '📝'),
      storagePath: key,
      downloads:   0,
      uploadedBy:  req.uid,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[Upload] ${title} → ${key} (${sizeStr})`);
    res.json({ success: true, resourceId: docRef.id, size: sizeStr, format, key });
  } catch (e) {
    console.error('[POST /resources/upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// DELETE /api/resources/:id — owner only
// ════════════════════════════════════════════
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.uid).get();
    if (snap.data()?.role !== 'owner') {
      return res.status(403).json({ error: 'Owner access required to delete' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  try {
    const docSnap = await db.collection('resources').doc(req.params.id).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Resource not found' });

    const { storagePath, title } = docSnap.data();
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storagePath }));
    await db.collection('resources').doc(req.params.id).delete();

    console.log(`[Delete] ${title} → ${storagePath}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[DELETE /resources/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// PATCH /api/resources/:id — update metadata
// ════════════════════════════════════════════
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const allowed = ['title', 'desc', 'type', 'grades', 'free', 'pages', 'subject', 'icon'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  try {
    await db.collection('resources').doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// GET /api/resources/stats/summary — admin dashboard
// ════════════════════════════════════════════
router.get('/stats/summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [resourcesSnap, logsSnap, subsSnap] = await Promise.all([
      db.collection('resources').get(),
      db.collection('downloadLogs')
        .where('downloadedAt', '>=', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
        .get(),
      db.collection('subscriptions').where('status', '==', 'active').get(),
    ]);

    let totalDownloads = 0, freeCount = 0, premiumCount = 0;
    resourcesSnap.forEach(d => {
      totalDownloads += d.data().downloads || 0;
      d.data().free ? freeCount++ : premiumCount++;
    });

    const all = [];
    resourcesSnap.forEach(d => all.push({ id: d.id, ...d.data() }));
    const top5 = all
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
      .slice(0, 5)
      .map(r => ({ id: r.id, title: r.title, downloads: r.downloads || 0, type: r.type }));

    res.json({
      totalResources:    resourcesSnap.size,
      freeResources:     freeCount,
      premiumResources:  premiumCount,
      totalDownloads,
      downloadsLast30d:  logsSnap.size,
      activeSubscribers: subsSnap.size,
      top5Downloaded:    top5,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
