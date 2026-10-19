import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';

import { newId, getSetting, setSetting, allSettings, Galleries, Files, Portfolio, Albums, Payments } from './db.js';
import { UPLOADS_DIR, VIEWS_DIR, PUBLIC_DIR } from './paths.js';
import { kindOf, processUpload, removeFileArtifacts, derivedPath, uploadPath, embedSrc, embedThumb, hasFfmpeg, SIZES } from './media.js';
import { requireAdmin, signIn, signOut, isAdmin, loginLimiter } from './auth.js';
import { Bookings, Packages } from './db.js';
import { clientRouter, loadClient } from './clients.js';
import tusUploads from './tus-uploads.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);
// cache-buster for style.css / app.js: changes whenever those files change
const ASSET_VERSION = ['style.css', 'app.js']
  .map((f) => { try { return Math.floor(fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch { return 0; } })
  .reduce((a, b) => a + b, 0).toString(36);

app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);
app.set('trust proxy', true);
app.disable('x-powered-by');

// ---------- helpers ----------
const money = (cents, cur) => {
  try {
    const whole = (cents || 0) % 100 === 0;
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format((cents || 0) / 100);
  } catch {
    return `${((cents || 0) / 100).toFixed(2)} ${cur || ''}`;
  }
};
const baseUrl = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const stripeKey = () => process.env.STRIPE_SECRET_KEY || getSetting('stripe_secret_key') || '';
const stripeClient = () => (stripeKey() ? new Stripe(stripeKey()) : null);
const safeFilename = (s) => String(s || 'download').replace(/[^\p{L}\p{N}\p{Pd}_ .()]+/gu, '_').replace(/^\.+/, '').slice(0, 120);
const toCents = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};
const wantsJson = (req) => req.headers.accept?.includes('application/json') || req.xhr;

function markPaid(gallery, method, ref = null) {
  if (gallery.status === 'paid') return;
  Galleries.setStatus(gallery.id, 'paid', method);
  Payments.record(gallery.id, method, ref, gallery.price_cents, gallery.currency);
}

// ---------- Stripe webhook (needs the raw body, so it goes before parsers) ----------
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const stripe = stripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET || getSetting('stripe_webhook_secret');
  if (!stripe || !secret) return res.status(400).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const gallery = Galleries.byId(session.metadata?.gallery_id);
    if (gallery && session.payment_status === 'paid') markPaid(gallery, 'stripe', session.id);
  }
  res.json({ received: true });
});

// ---------- middleware ----------
app.use(cookieParser());
app.use(tusUploads);
app.use(express.urlencoded({ limit: '2000mb', extended: true }));
app.use(express.json({ limit: '2000mb' }));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));
app.use((req, res, next) => {
  res.locals.settings = allSettings();
  res.locals.isAdmin = isAdmin(req);
  res.locals.money = money;
  res.locals.hasStripe = Boolean(stripeKey());
  res.locals.embedSrc = embedSrc;
  res.locals.embedThumb = embedThumb;
  res.locals.path = req.path;
  res.locals.flash = req.query.msg || null;
  res.locals.assetV = ASSET_VERSION;
  res.locals.newBookings = res.locals.isAdmin ? Bookings.countNew() : 0;
  next();
});
app.use(loadClient);
app.use(clientRouter);

// ---------- uploads ----------
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => cb(null, `${newId(12)}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES, files: 300 } });

// ---------- first-run setup ----------
app.get('/setup', (req, res) => {
  if (getSetting('admin_password_hash')) return res.redirect('/admin/login');
  res.render('admin/setup', { title: 'Set up your studio', error: null });
});
app.post('/setup', (req, res) => {
  if (getSetting('admin_password_hash')) return res.redirect('/admin/login');
  const { studio_name, password, confirm } = req.body;
  if (!password || password.length < 8) return res.render('admin/setup', { title: 'Set up', error: 'Password must be at least 8 characters.' });
  if (password !== confirm) return res.render('admin/setup', { title: 'Set up', error: 'Passwords do not match.' });
  setSetting('studio_name', (studio_name || 'My Studio').trim());
  setSetting('currency', 'USD');
  setSetting('admin_password_hash', bcrypt.hashSync(password, 11));
  signIn(res);
  res.redirect('/admin/settings?msg=Welcome! Fill in your studio details below.');
});

// ---------- public: portfolio ----------
function albumsWithCovers() {
  return Albums.all().map((a) => {
    const items = Portfolio.forAlbum(a.id);
    const cover = items.find((i) => i.id === a.cover_item_id) || items.find((i) => i.kind !== 'embed') || items[0] || null;
    return { ...a, cover, items };
  });
}

app.get('/', (req, res) => {
  if (!getSetting('admin_password_hash')) return res.redirect('/setup');
  const albums = albumsWithCovers().filter((a) => a.items.length);
  const items = Portfolio.loose();
  const categories = [...new Set([...albums.map((a) => a.category), ...items.map((i) => i.category)].filter(Boolean))];
  const hasHero = fs.existsSync(path.join(PUBLIC_DIR, 'car', 'frames.json'));
  // public client galleries, grouped by client name
  const clients = [];
  for (const g of Galleries.public()) {
    const files = Files.forGallery(g.id);
    if (!files.length) continue;
    const cover = files.find((f) => f.id === g.cover_file_id && f.has_preview) || files.find((f) => f.has_preview) || null;
    const entry = { ...g, cover, file_count: files.length };
    const group = clients.find((c) => c.name.toLowerCase() === g.client_name.toLowerCase());
    if (group) group.galleries.push(entry); else clients.push({ name: g.client_name, galleries: [entry] });
  }
  res.render('home', { title: getSetting('studio_name', 'Studio'), albums, items, categories, hasHero, clients, packages: Packages.active(), calc: Packages.calculator() });
});

// Public, view-only version of a client gallery (no downloads; that stays on the private link)
app.get('/clients/:slug', (req, res) => {
  const gallery = Galleries.byPublicSlug(req.params.slug);
  if (!gallery) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'That gallery is not public.' });
  const files = Files.forGallery(gallery.id);
  res.render('gallery', {
    title: gallery.title, gallery, files, unlocked: gallery.status === 'paid', showcase: true,
    totalBytes: files.reduce((a, f) => a + (f.size || 0), 0), canPay: false, paidJustNow: false,
  });
});
app.get('/clients/:slug/img/:fid/:size', (req, res) => {
  const gallery = Galleries.byPublicSlug(req.params.slug);
  const f = gallery && Files.byId(req.params.fid);
  if (!gallery || !f || f.gallery_id !== gallery.id || !f.has_preview) return res.sendStatus(404);
  let size = req.params.size;
  if (!(size in SIZES)) return res.sendStatus(404);
  if (gallery.status !== 'paid') size = 'wm';
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(derivedPath(f.id, size));
});

app.get('/albums/:slug', (req, res) => {
  const album = Albums.bySlug(req.params.slug);
  if (!album) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'That album does not exist.' });
  const items = Portfolio.forAlbum(album.id);
  res.render('album', { title: album.title, album, items });
});

app.get('/p/:id/:size', (req, res) => {
  const item = Portfolio.byId(req.params.id);
  if (!item) return res.sendStatus(404);
  if (req.params.size === 'video') {
    if (item.kind !== 'video') return res.sendStatus(404);
    return res.sendFile(uploadPath(item.filename));
  }
  if (!(req.params.size in SIZES)) return res.sendStatus(404);
  const p = derivedPath(item.id, req.params.size);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(p);
});

// ---------- public: client gallery ----------
function loadGallery(req, res, next) {
  const gallery = Galleries.byToken(req.params.token);
  if (!gallery) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'This gallery link is not valid. Ask the photographer for a fresh link.' });
  req.gallery = gallery;
  req.unlocked = gallery.status === 'paid';
  next();
}

app.get('/g/:token', loadGallery, (req, res) => {
  const files = Files.forGallery(req.gallery.id);
  res.render('gallery', {
    title: req.gallery.title || 'Your gallery',
    gallery: req.gallery,
    files,
    unlocked: req.unlocked,
    showcase: false,
    totalBytes: files.reduce((a, f) => a + (f.size || 0), 0),
    canPay: res.locals.hasStripe && req.gallery.price_cents > 0 && !req.unlocked,
    paidJustNow: req.query.paid === '1',
  });
});

// images: locked galleries only ever get the watermarked variant
app.get('/g/:token/img/:fid/:size', loadGallery, (req, res) => {
  const f = Files.byId(req.params.fid);
  if (!f || f.gallery_id !== req.gallery.id || !f.has_preview) return res.sendStatus(404);
  let size = req.params.size;
  if (!(size in SIZES)) return res.sendStatus(404);
  if (!req.unlocked) size = 'wm';
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(derivedPath(f.id, size));
});

app.get('/g/:token/stream/:fid', loadGallery, (req, res) => {
  if (!req.unlocked) return res.sendStatus(403);
  const f = Files.byId(req.params.fid);
  if (!f || f.gallery_id !== req.gallery.id) return res.sendStatus(404);
  res.sendFile(uploadPath(f.filename));
});

app.get('/g/:token/download/:fid', loadGallery, (req, res) => {
  if (!req.unlocked) return res.status(403).render('error', { title: 'Locked', code: 403, message: 'This gallery is locked until payment is confirmed.' });
  const f = Files.byId(req.params.fid);
  if (!f || f.gallery_id !== req.gallery.id) return res.sendStatus(404);
  res.download(uploadPath(f.filename), safeFilename(f.original_name));
});

app.get('/g/:token/download-all', loadGallery, (req, res) => {
  if (!req.unlocked) return res.status(403).render('error', { title: 'Locked', code: 403, message: 'This gallery is locked until payment is confirmed.' });
  const files = Files.forGallery(req.gallery.id);
  res.attachment(`${safeFilename(req.gallery.title || 'gallery')}.zip`);
  const archive = new ZipArchive({ zlib: { level: 0 } });
  archive.on('error', (err) => { console.error(err); res.end(); });
  archive.pipe(res);
  const seen = new Map();
  for (const f of files) {
    let name = safeFilename(f.original_name);
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    if (n) name = name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
    archive.file(uploadPath(f.filename), { name });
  }
  archive.finalize();
});

// Stripe checkout
app.post('/g/:token/pay', loadGallery, async (req, res) => {
  const stripe = stripeClient();
  if (!stripe || req.unlocked || req.gallery.price_cents <= 0) return res.redirect(`/g/${req.gallery.token}`);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: req.gallery.currency.toLowerCase(),
          unit_amount: req.gallery.price_cents,
          product_data: { name: `${req.gallery.title || 'Gallery'} — ${getSetting('studio_name', 'Studio')}` },
        },
      }],
      customer_email: req.gallery.client_email || undefined,
      metadata: { gallery_id: req.gallery.id },
      success_url: `${baseUrl(req)}/g/${req.gallery.token}/paid?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl(req)}/g/${req.gallery.token}`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('stripe error', err.message);
    res.status(500).render('error', { title: 'Payment error', code: 500, message: 'Could not start the payment. Please try again or contact the photographer.' });
  }
});

app.get('/g/:token/paid', loadGallery, async (req, res) => {
  const stripe = stripeClient();
  if (stripe && !req.unlocked && req.query.session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(String(req.query.session_id));
      if (session.payment_status === 'paid' && session.metadata?.gallery_id === req.gallery.id) {
        markPaid(req.gallery, 'stripe', session.id);
      }
    } catch (err) {
      console.error('stripe verify error', err.message);
    }
  }
  res.redirect(`/g/${req.gallery.token}?paid=1`);
});

// ---------- admin: auth ----------
app.get('/admin/login', (req, res) => {
  if (!getSetting('admin_password_hash')) return res.redirect('/setup');
  if (isAdmin(req)) return res.redirect('/admin');
  res.render('admin/login', { title: 'Sign in', error: null, next: req.query.next || '/admin' });
});
app.post('/admin/login', loginLimiter, (req, res) => {
  const ok = bcrypt.compareSync(req.body.password || '', getSetting('admin_password_hash', ''));
  if (!ok) return res.status(401).render('admin/login', { title: 'Sign in', error: 'Wrong password.', next: req.body.next || '/admin' });
  signIn(res);
  const next = String(req.body.next || '/admin');
  res.redirect(next.startsWith('/') ? next : '/admin');
});
app.post('/admin/logout', (req, res) => { signOut(res); res.redirect('/'); });

const admin = express.Router();
admin.use(requireAdmin);

// ---------- admin: dashboard & galleries ----------
admin.get('/', (req, res) => {
  const galleries = Galleries.all();
  res.render('admin/dashboard', {
    title: 'Galleries',
    galleries,
    base: baseUrl(req),
    stats: {
      total: galleries.length,
      paid: galleries.filter((g) => g.status === 'paid').length,
      locked: galleries.filter((g) => g.status !== 'paid').length,
      revenue: galleries.filter((g) => g.status === 'paid').reduce((a, g) => a + g.price_cents, 0),
    },
  });
});

admin.post('/galleries', (req, res) => {
  const id = Galleries.create({
    client_name: (req.body.client_name || '').trim(),
    client_email: (req.body.client_email || '').trim(),
    title: (req.body.title || '').trim() || `${(req.body.client_name || 'Client').trim()} — gallery`,
    description: (req.body.description || '').trim(),
    price_cents: toCents(req.body.price),
    currency: (req.body.currency || getSetting('currency', 'USD')).toUpperCase().slice(0, 3),
  });
  res.redirect(`/admin/galleries/${id}`);
});

admin.get('/galleries/:id', (req, res) => {
  const gallery = Galleries.byId(req.params.id);
  if (!gallery) return res.redirect('/admin');
  res.render('admin/gallery', {
    title: gallery.title,
    gallery,
    files: Files.forGallery(gallery.id),
    payments: Payments.forGallery(gallery.id),
    link: `${baseUrl(req)}/g/${gallery.token}`,
    hasFfmpeg,
  });
});

admin.post('/galleries/:id', (req, res) => {
  const gallery = Galleries.byId(req.params.id);
  if (!gallery) return res.redirect('/admin');
  Galleries.update(gallery.id, {
    client_name: (req.body.client_name || '').trim(),
    client_email: (req.body.client_email || '').trim(),
    title: (req.body.title || '').trim(),
    description: (req.body.description || '').trim(),
    price_cents: toCents(req.body.price),
    currency: (req.body.currency || 'USD').toUpperCase().slice(0, 3),
  });
  res.redirect(`/admin/galleries/${gallery.id}?msg=Saved`);
});

admin.post('/galleries/:id/status', (req, res) => {
  const gallery = Galleries.byId(req.params.id);
  if (!gallery) return res.redirect('/admin');
  if (req.body.status === 'paid') markPaid(gallery, req.body.method || 'manual');
  else Galleries.setStatus(gallery.id, 'locked');
  res.redirect(`/admin/galleries/${gallery.id}?msg=${req.body.status === 'paid' ? 'Gallery unlocked — the client can download now' : 'Gallery locked'}`);
});

admin.post('/galleries/:id/visibility', (req, res) => {
  const v = req.body.visibility === 'public' ? 'public' : 'private';
  Galleries.setVisibility(req.params.id, v);
  res.redirect(`/admin/galleries/${req.params.id}?msg=${v === 'public' ? 'Gallery is now listed on the website' : 'Gallery is private again (link only)'}`);
});

admin.post('/galleries/:id/token', (req, res) => {
  Galleries.regenerateToken(req.params.id);
  res.redirect(`/admin/galleries/${req.params.id}?msg=New private link generated. The old link no longer works.`);
});

admin.post('/galleries/:id/cover/:fid', (req, res) => {
  Galleries.setCover(req.params.id, req.params.fid);
  res.redirect(`/admin/galleries/${req.params.id}`);
});

admin.post('/galleries/:id/delete', (req, res) => {
  const gallery = Galleries.byId(req.params.id);
  if (gallery) {
    for (const f of Files.forGallery(gallery.id)) removeFileArtifacts(f.id, f.filename);
    Galleries.delete(gallery.id);
  }
  res.redirect('/admin?msg=Gallery deleted');
});

admin.post('/galleries/:id/files', upload.array('files'), async (req, res) => {
  const gallery = Galleries.byId(req.params.id);
  if (!gallery) return res.status(404).json({ error: 'Gallery not found' });
  const studio = getSetting('studio_name', 'PREVIEW');
  const added = [];
  for (const file of req.files || []) {
    const id = newId();
    const kind = kindOf(file.originalname);
    const info = await processUpload({ id, filename: file.filename, kind, watermarkText: studio });
    Files.create({ id, gallery_id: gallery.id, kind, original_name: file.originalname, filename: file.filename, size: file.size, ...info });
    added.push({ id, kind, name: file.originalname, has_preview: info.has_preview });
  }
  if (!gallery.cover_file_id) {
    const first = added.find((a) => a.has_preview);
    if (first) Galleries.setCover(gallery.id, first.id);
  }
  if (wantsJson(req)) return res.json({ added });
  res.redirect(`/admin/galleries/${gallery.id}`);
});

admin.post('/galleries/:id/files/:fid/delete', (req, res) => {
  const f = Files.byId(req.params.fid);
  if (f && f.gallery_id === req.params.id) {
    removeFileArtifacts(f.id, f.filename);
    Files.delete(f.id);
    const g = Galleries.byId(req.params.id);
    if (g?.cover_file_id === f.id) Galleries.setCover(g.id, Files.forGallery(g.id).find((x) => x.has_preview)?.id || null);
  }
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(`/admin/galleries/${req.params.id}`);
});

admin.get('/img/:fid/:size', (req, res) => {
  const f = Files.byId(req.params.fid);
  if (!f || !f.has_preview || !(req.params.size in SIZES)) return res.sendStatus(404);
  res.sendFile(derivedPath(f.id, req.params.size));
});

// ---------- admin: portfolio ----------
admin.get('/portfolio', (req, res) => {
  res.render('admin/portfolio', { title: 'Portfolio', albums: albumsWithCovers(), items: Portfolio.loose(), hasFfmpeg });
});

// Adds uploaded files / an embed link to the portfolio, optionally inside an album.
async function addPortfolioItems(req, albumId) {
  const title = (req.body.title || '').trim();
  const album = albumId ? Albums.byId(albumId) : null;
  const category = (req.body.category || album?.category || '').trim();
  const embed = (req.body.embed_url || '').trim();
  const added = [];

  if (embed) {
    if (!embedSrc(embed)) throw new Error('That link is not a YouTube or Vimeo URL');
    const id = newId();
    Portfolio.create({ id, title, category, kind: 'embed', filename: null, embed_url: embed, width: null, height: null, album_id: albumId });
    added.push(id);
  }
  for (const file of req.files || []) {
    const id = newId();
    const kind = kindOf(file.originalname);
    if (kind === 'other') { fs.promises.unlink(file.path).catch(() => {}); continue; }
    const info = await processUpload({ id, filename: file.filename, kind, watermarkText: null });
    Portfolio.create({ id, title: title || path.parse(file.originalname).name, category, kind, filename: file.filename, embed_url: null, width: info.width, height: info.height, album_id: albumId });
    added.push(id);
  }
  if (album && !album.cover_item_id && added.length) Albums.setCover(album.id, added[0]);
  return added;
}

admin.post('/portfolio', upload.array('files'), async (req, res) => {
  const albumId = (req.body.album_id || '').trim() || null;
  const back = albumId ? `/admin/albums/${albumId}` : '/admin/portfolio';
  try {
    await addPortfolioItems(req, albumId);
  } catch (err) {
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    return res.redirect(`${back}?msg=${encodeURIComponent(err.message)}`);
  }
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(`${back}?msg=Added to portfolio`);
});

admin.post('/portfolio/:id', (req, res) => {
  const item = Portfolio.byId(req.params.id);
  if (!item) return res.redirect('/admin/portfolio');
  Portfolio.update(item.id, { title: (req.body.title || '').trim(), category: (req.body.category || '').trim() });
  if ('album_id' in req.body) Portfolio.setAlbum(item.id, (req.body.album_id || '').trim() || null);
  res.redirect(item.album_id ? `/admin/albums/${item.album_id}` : '/admin/portfolio');
});
admin.post('/portfolio/:id/move', (req, res) => {
  const item = Portfolio.byId(req.params.id);
  Portfolio.move(req.params.id, req.body.dir === 'up' ? 'up' : 'down');
  res.redirect(item?.album_id ? `/admin/albums/${item.album_id}` : '/admin/portfolio');
});
admin.post('/portfolio/:id/delete', (req, res) => {
  const item = Portfolio.byId(req.params.id);
  if (item) {
    if (item.filename) removeFileArtifacts(item.id, item.filename);
    Portfolio.delete(item.id);
    if (item.album_id) {
      const a = Albums.byId(item.album_id);
      if (a?.cover_item_id === item.id) Albums.setCover(a.id, Portfolio.forAlbum(a.id)[0]?.id || null);
    }
  }
  res.redirect(item?.album_id ? `/admin/albums/${item.album_id}` : '/admin/portfolio');
});

// ---------- admin: albums ----------
admin.post('/albums', (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/admin/portfolio?msg=Give the album a title');
  const id = Albums.create({ title, category: (req.body.category || '').trim(), description: (req.body.description || '').trim() });
  res.redirect(`/admin/albums/${id}`);
});
admin.get('/albums/:id', (req, res) => {
  const album = Albums.byId(req.params.id);
  if (!album) return res.redirect('/admin/portfolio');
  res.render('admin/album', { title: album.title, album, items: Portfolio.forAlbum(album.id), albums: Albums.all(), hasFfmpeg, base: baseUrl(req) });
});
admin.post('/albums/:id', (req, res) => {
  Albums.update(req.params.id, { title: (req.body.title || '').trim(), category: (req.body.category || '').trim(), description: (req.body.description || '').trim() });
  res.redirect(`/admin/albums/${req.params.id}?msg=Saved`);
});
admin.post('/albums/:id/items', upload.array('files'), async (req, res) => {
  const album = Albums.byId(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  try {
    await addPortfolioItems(req, album.id);
  } catch (err) {
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    return res.redirect(`/admin/albums/${album.id}?msg=${encodeURIComponent(err.message)}`);
  }
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(`/admin/albums/${album.id}?msg=Added to album`);
});
admin.post('/albums/:id/cover/:itemId', (req, res) => {
  Albums.setCover(req.params.id, req.params.itemId);
  res.redirect(`/admin/albums/${req.params.id}`);
});
admin.post('/albums/:id/move', (req, res) => {
  Albums.move(req.params.id, req.body.dir === 'up' ? 'up' : 'down');
  res.redirect('/admin/portfolio');
});
admin.post('/albums/:id/delete', (req, res) => {
  const album = Albums.byId(req.params.id);
  if (album) {
    for (const item of Portfolio.forAlbum(album.id)) {
      if (item.filename) removeFileArtifacts(item.id, item.filename);
      Portfolio.delete(item.id);
    }
    Albums.delete(album.id);
  }
  res.redirect('/admin/portfolio?msg=Album deleted');
});

// ---------- admin: packages ----------
const packageFromBody = (b) => ({
  name: String(b.name || '').trim().slice(0, 80),
  price_cents: toCents(b.price),
  currency: String(b.currency || 'ILS').toUpperCase().slice(0, 3),
  features: String(b.features || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('\n'),
  badge: String(b.badge || '').trim().slice(0, 30),
  included_photos: Math.max(0, parseInt(b.included_photos, 10) || 0),
  includes_video: b.includes_video === 'on' || b.includes_video === '1',
  active: b.active === 'on' || b.active === '1',
});

admin.get('/packages', (req, res) => {
  res.render('admin/packages', { title: 'Packages', packages: Packages.all(), calc: Packages.calculator(), error: null });
});
admin.post('/packages', (req, res) => {
  const p = packageFromBody(req.body);
  if (!p.name) return res.redirect('/admin/packages?msg=Give the package a name');
  Packages.create({ ...p, active: true });
  res.redirect('/admin/packages?msg=Package added');
});
admin.post('/packages/calculator', (req, res) => {
  setSetting('pkg_extra_photo_cents', String(toCents(req.body.extra_photo)));
  setSetting('pkg_extra_video_cents', String(toCents(req.body.extra_video)));
  setSetting('pkg_max_extra_photos', String(Math.min(200, Math.max(1, parseInt(req.body.max_extra_photos, 10) || 40))));
  setSetting('pkg_max_extra_videos', String(Math.min(10, Math.max(1, parseInt(req.body.max_extra_videos, 10) || 3))));
  res.redirect('/admin/packages?msg=Add-on prices saved');
});
admin.post('/packages/:id', (req, res) => {
  const p = packageFromBody(req.body);
  if (!p.name) return res.redirect('/admin/packages?msg=Package name cannot be empty');
  Packages.update(req.params.id, p);
  res.redirect('/admin/packages?msg=Package saved');
});
admin.post('/packages/:id/move', (req, res) => {
  Packages.move(req.params.id, req.body.dir === 'up' ? 'up' : 'down');
  res.redirect('/admin/packages');
});
admin.post('/packages/:id/delete', (req, res) => {
  Packages.delete(req.params.id);
  res.redirect('/admin/packages?msg=Package deleted');
});

// ---------- admin: bookings ----------
admin.get('/bookings', (req, res) => {
  res.render('admin/bookings', { title: 'Bookings', bookings: Bookings.all() });
});
admin.post('/bookings/:id/status', (req, res) => {
  const status = ['new', 'confirmed', 'declined', 'done'].includes(req.body.status) ? req.body.status : 'new';
  Bookings.setStatus(req.params.id, status, String(req.body.note || '').trim().slice(0, 500));
  res.redirect('/admin/bookings?msg=Booking updated');
});
admin.post('/bookings/:id/delete', (req, res) => {
  Bookings.delete(req.params.id);
  res.redirect('/admin/bookings?msg=Booking deleted');
});

// ---------- admin: settings ----------
const SETTING_KEYS = ['studio_name', 'tagline', 'hero_eyebrow', 'contact_blurb', 'about', 'email', 'phone', 'whatsapp', 'instagram', 'location', 'currency', 'payment_instructions', 'payment_link', 'stripe_secret_key', 'stripe_webhook_secret', 'accent_color'];

// studio logo (uploaded in Settings)
app.get('/brand/logo', (req, res) => {
  const f = getSetting('logo_file');
  if (!f || !fs.existsSync(uploadPath(f))) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(uploadPath(f));
});

admin.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'Settings', error: null, envStripe: Boolean(process.env.STRIPE_SECRET_KEY) });
});
admin.post('/settings', upload.single('logo'), (req, res) => {
  for (const k of SETTING_KEYS) {
    if (k in req.body) setSetting(k, String(req.body[k]).trim());
  }
  if (!/^#[0-9a-f]{6}$/i.test(getSetting('accent_color', ''))) setSetting('accent_color', '');
  if (req.file) {
    if (kindOf(req.file.originalname) !== 'image') fs.promises.unlink(req.file.path).catch(() => {});
    else {
      const old = getSetting('logo_file');
      if (old) fs.promises.unlink(uploadPath(old)).catch(() => {});
      setSetting('logo_file', req.file.filename);
    }
  }
  if (req.body.remove_logo === 'on') {
    const old = getSetting('logo_file');
    if (old) fs.promises.unlink(uploadPath(old)).catch(() => {});
    setSetting('logo_file', '');
  }
  if (req.body.new_password) {
    if (req.body.new_password.length < 8) return res.render('admin/settings', { title: 'Settings', error: 'New password must be at least 8 characters.', envStripe: Boolean(process.env.STRIPE_SECRET_KEY) });
    if (!bcrypt.compareSync(req.body.current_password || '', getSetting('admin_password_hash', ''))) {
      return res.render('admin/settings', { title: 'Settings', error: 'Current password is wrong.', envStripe: Boolean(process.env.STRIPE_SECRET_KEY) });
    }
    setSetting('admin_password_hash', bcrypt.hashSync(req.body.new_password, 11));
  }
  res.redirect('/admin/settings?msg=Settings saved');
});

app.use('/admin', admin);

// ---------- errors ----------
app.use((req, res) => res.status(404).render('error', { title: 'Not found', code: 404, message: 'That page does not exist.' }));
app.use((err, req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.too.large') {
    const msg = 'Request too large (limit 2000 MB)';
    return wantsJson(req) ? res.status(413).json({ error: msg }) : res.status(413).render('error', { title: 'Request too large', code: 413, message: msg });
  }
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (limit ${MAX_UPLOAD_MB} MB)` : err.message;
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return wantsJson(req) ? res.status(status).json({ error: msg }) : res.status(status).render('error', { title: 'Upload error', code: status, message: msg });
  }
  if (wantsJson(req)) return res.status(500).json({ error: 'Server error' });
  res.status(500).render('error', { title: 'Error', code: 500, message: 'Something went wrong.' });
});

const server = app.listen(PORT, () => {
  console.log(`Studio site running at http://localhost:${PORT}`);
  console.log(`ffmpeg ${hasFfmpeg ? 'found: video posters enabled' : 'not found: videos will show a generic tile until ffmpeg is installed'}`);
  if (!getSetting('admin_password_hash')) console.log('First run: open the site to create the admin password.');
});
// Multi-gigabyte uploads over slow connections must not be cut off by Node's default 5-minute request timeout.
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.timeout = 0;
server.keepAliveTimeout = 65000;
