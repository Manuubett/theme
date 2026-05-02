/**
 * CBE Resource Hub — R2 Resource Routes
 * Handles upload, download (presigned URL), list, and delete
 * All premium downloads gated behind Firestore subscription check
 */

const express  = require('express');
const multer   = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const admin    = require('firebase-admin');
const router   = express.Router();

// ── R2 Client (S3-compatible) ──
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'cbe-resources';

// ── Multer — memory storage (pipe straight to R2, no disk) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF and DOCX files are allowed'));
  },
});

// ── Firestore ref ──
const db = admin.firestore();

// ════════════════════════════════════════════
// MIDDLEWARE — verify Firebase ID token
// ════════════════════════════════════════════
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
    req.uid      = decoded.uid;
    req.schoolId = decoded.schoolId || null;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Verify owner/admin role ──
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
// Returns { active, plan, expiresAt } or { active: false }
// ════════════════════════════════════════════
async function checkSubscription(uid) {
  try {
    const snap = await db.collection('subscriptions').doc(uid).get();
    if (!snap.exists) return { active: false };

    const sub = snap.data();

    // Check status and expiry
    if (sub.status !== 'active') return { active: false, reason: sub.status };

    const now     = new Date();
    const expires = sub.expiresAt?.toDate?.() || new Date(sub.expiresAt);
    if (expires < now) {
      // Auto-expire — update Firestore
      await db.collection('subscriptions').doc(uid).update({ status: 'expired' });
      return { active: false, reason: 'expired' };
    }

    return { active: true, plan: sub.plan, expiresAt: expires };
  } catch (e) {
    console.error('[Subscription check error]', e.message);
    return { active: false, reason: 'error' };
  }
}

// ════════════════════════════════════════════
// GET /api/resources
// List all resources (metadata only, no URLs)
// Public — no auth required, free flag visible to all
// ════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { grade, type, search } = req.query;

    let query = db.collection('resources').orderBy('createdAt', 'desc');

    // Firestore doesn't support full-text search — filter in memory
    const snap   = await query.get();
    let resources = [];

    snap.forEach(doc => {
      const d = doc.data();
      resources.push({
        id:          doc.id,
        title:       d.title,
        desc:        d.desc,
        type:        d.type,
        grades:      d.grades,
        free:        d.free,
        pages:       d.pages,
        size:        d.size,
        format:      d.format,
        icon:        d.icon,
        subject:     d.subject || '',
        downloads:   d.downloads || 0,
        createdAt:   d.createdAt,
        // Never expose storagePath to client
      });
    });

    // Filter in memory
    if (grade && grade !== 'all') {
      resources = resources.filter(r => r.grades === grade || r.grades === '1-9');
    }
    if (type && type !== 'all') {
      resources = resources.filter(r => r.type === type);
    }
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
// POST /api/resources/download
// Returns a short-lived presigned R2 URL
// Auth required — subscription checked for premium files
// ════════════════════════════════════════════
router.post('/download', requireAuth, async (req, res) => {
  const { resourceId } = req.body;
  if (!resourceId) return res.status(400).json({ error: 'resourceId required' });

  try {
    // 1. Fetch resource metadata from Firestore
    const docSnap = await db.collection('resources').doc(resourceId).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Resource not found' });

    const resource = docSnap.data();

    // 2. Check access
    if (!resource.free) {
      const sub = await checkSubscription(req.uid);
      if (!sub.active) {
        return res.status(403).json({
          error:  'Subscription required',
          reason: sub.reason || 'none',
          code:   'SUBSCRIPTION_REQUIRED',
        });
      }
    }

    // 3. Generate presigned URL — expires in 60 seconds
    //    Short expiry prevents URL sharing
    const command = new GetObjectCommand({
      Bucket:                     BUCKET,
      Key:                        resource.storagePath,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(resource.title)}.${resource.format.toLowerCase()}"`,
      ResponseContentType:        resource.format === 'PDF'
                                    ? 'application/pdf'
                                    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const url = await getSignedUrl(r2, command, { expiresIn: 60 });

    // 4. Increment download counter (non-blocking)
    db.collection('resources').doc(resourceId).update({
      downloads: admin.firestore.FieldValue.increment(1),
    }).catch(() => {});

    // 5. Log download event
    db.collection('downloadLogs').add({
      resourceId,
      resourceTitle: resource.title,
      uid:           req.uid,
      plan:          resource.free ? 'free' : 'premium',
      downloadedAt:  admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    res.json({ url, expiresIn: 60 });
  } catch (e) {
    console.error('[POST /resources/download]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// POST /api/resources/upload
// Upload a resource file to R2 + write metadata to Firestore
// Owner/admin only
// ════════════════════════════════════════════
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { title, desc, type, grades, free, pages, subject, icon } = req.body;
  if (!title || !type || !grades) {
    return res.status(400).json({ error: 'title, type and grades are required' });
  }

  try {
    // 1. Build storage key
    const ext      = req.file.mimetype === 'application/pdf' ? 'pdf' : 'docx';
    const format   = ext.toUpperCase();
    const slug     = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60);
    const key      = `resources/${Date.now()}-${slug}.${ext}`;
    const sizeKB   = Math.round(req.file.size / 1024);
    const sizeStr  = sizeKB >= 1024
                       ? `${(sizeKB / 1024).toFixed(1)}MB`
                       : `${sizeKB}KB`;

    // 2. Upload to R2
    await r2.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        req.file.buffer,
      ContentType: req.file.mimetype,
      Metadata: {
        title,
        uploadedBy: req.uid,
      },
    }));

    // 3. Write metadata to Firestore
    const docRef = await db.collection('resources').add({
      title,
      desc:        desc || '',
      type,
      grades,
      subject:     subject || '',
      free:        free === 'true' || free === true,
      pages:       parseInt(pages) || 0,
      size:        sizeStr,
      format,
      icon:        icon || (format === 'PDF' ? '📄' : '📝'),
      storagePath: key,           // stored server-side only — never sent to client
      downloads:   0,
      uploadedBy:  req.uid,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[Upload] ${title} → ${key} (${sizeStr})`);

    res.json({
      success:    true,
      resourceId: docRef.id,
      size:       sizeStr,
      format,
      key,
    });
  } catch (e) {
    console.error('[POST /resources/upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// DELETE /api/resources/:id
// Delete from R2 + Firestore
// Owner only
// ════════════════════════════════════════════
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  // Only owner can delete
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

    // 1. Delete from R2
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storagePath }));

    // 2. Delete from Firestore
    await db.collection('resources').doc(req.params.id).delete();

    console.log(`[Delete] ${title} → ${storagePath}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[DELETE /resources/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// PATCH /api/resources/:id
// Update resource metadata (not the file itself)
// Owner/admin only
// ════════════════════════════════════════════
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const allowed = ['title', 'desc', 'type', 'grades', 'free', 'pages', 'subject', 'icon'];
  const updates = {};
  allowed.forEach(k => {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  });
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  try {
    await db.collection('resources').doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// GET /api/resources/stats
// Download stats for owner dashboard
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

    let totalDownloads = 0;
    let freeCount = 0, premiumCount = 0;
    resourcesSnap.forEach(d => {
      totalDownloads += d.data().downloads || 0;
      d.data().free ? freeCount++ : premiumCount++;
    });

    // Top 5 most downloaded
    const all = [];
    resourcesSnap.forEach(d => all.push({ id: d.id, ...d.data() }));
    const top5 = all.sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).slice(0, 5).map(r => ({
      id: r.id, title: r.title, downloads: r.downloads || 0, type: r.type,
    }));

    res.json({
      totalResources:   resourcesSnap.size,
      freeResources:    freeCount,
      premiumResources: premiumCount,
      totalDownloads,
      downloadsLast30d: logsSnap.size,
      activeSubscribers: subsSnap.size,
      top5Downloaded:   top5,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
