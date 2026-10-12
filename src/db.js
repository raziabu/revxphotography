import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'studio.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS portfolio (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  filename TEXT,
  embed_url TEXT,
  width INTEGER, height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS galleries (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  client_email TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'locked',
  paid_at TEXT,
  payment_method TEXT,
  cover_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  width INTEGER, height INTEGER,
  has_preview INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover_item_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service TEXT NOT NULL DEFAULT '',
  car TEXT NOT NULL DEFAULT '',
  preferred_date TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'ILS',
  features TEXT NOT NULL DEFAULT '',
  badge TEXT NOT NULL DEFAULT '',
  included_photos INTEGER NOT NULL DEFAULT 0,
  includes_video INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_files_gallery ON files(gallery_id, sort_order);
`);
const bookingCols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
if (bookingCols.length && !bookingCols.includes('package_name')) {
  db.exec("ALTER TABLE bookings ADD COLUMN package_name TEXT NOT NULL DEFAULT ''");
  db.exec('ALTER TABLE bookings ADD COLUMN estimate_cents INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE bookings ADD COLUMN photos INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE bookings ADD COLUMN video INTEGER NOT NULL DEFAULT 0');
}

// migrations for existing databases
const portfolioCols = db.prepare('PRAGMA table_info(portfolio)').all().map((c) => c.name);
if (!portfolioCols.includes('album_id')) db.exec('ALTER TABLE portfolio ADD COLUMN album_id TEXT');
const galleryCols = db.prepare('PRAGMA table_info(galleries)').all().map((c) => c.name);
if (!galleryCols.includes('visibility')) db.exec("ALTER TABLE galleries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
if (!galleryCols.includes('public_slug')) db.exec('ALTER TABLE galleries ADD COLUMN public_slug TEXT');

export const newId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
export const newToken = () => crypto.randomBytes(18).toString('base64url');

// ---- settings ----
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
export const getSetting = (key, fallback = null) => {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
};
export const setSetting = (key, value) => setSettingStmt.run(key, value ?? '');

export function allSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

if (!getSetting('session_secret')) setSetting('session_secret', crypto.randomBytes(32).toString('hex'));

// ---- galleries ----
export const Galleries = {
  all: () => db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM files f WHERE f.gallery_id = g.id) AS file_count
    FROM galleries g ORDER BY g.created_at DESC`).all(),
  byId: (id) => db.prepare('SELECT * FROM galleries WHERE id = ?').get(id),
  byToken: (token) => db.prepare('SELECT * FROM galleries WHERE token = ?').get(token),
  create: (d) => {
    const id = newId();
    db.prepare(`INSERT INTO galleries(id, token, client_name, client_email, title, description, price_cents, currency)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, newToken(), d.client_name, d.client_email, d.title, d.description, d.price_cents, d.currency);
    return id;
  },
  update: (id, d) => db.prepare(`UPDATE galleries SET client_name=?, client_email=?, title=?, description=?, price_cents=?, currency=? WHERE id=?`)
    .run(d.client_name, d.client_email, d.title, d.description, d.price_cents, d.currency, id),
  setStatus: (id, status, method = null) => db.prepare(
    `UPDATE galleries SET status=?, paid_at = CASE WHEN ?='paid' THEN datetime('now') ELSE NULL END, payment_method=? WHERE id=?`
  ).run(status, status, method, id),
  setCover: (id, fileId) => db.prepare('UPDATE galleries SET cover_file_id=? WHERE id=?').run(fileId, id),
  regenerateToken: (id) => db.prepare('UPDATE galleries SET token=? WHERE id=?').run(newToken(), id),
  delete: (id) => db.prepare('DELETE FROM galleries WHERE id=?').run(id),
  public: () => db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM files f WHERE f.gallery_id = g.id) AS file_count
    FROM galleries g WHERE g.visibility = 'public' ORDER BY g.client_name, g.created_at DESC`).all(),
  byPublicSlug: (slug) => db.prepare("SELECT * FROM galleries WHERE public_slug = ? AND visibility = 'public'").get(slug),
  setVisibility: (id, visibility) => {
    const g = Galleries.byId(id);
    if (!g) return;
    let slug = g.public_slug;
    if (visibility === 'public' && !slug) {
      const base = slugify(`${g.client_name} ${g.title}`);
      slug = base;
      let n = 1;
      while (db.prepare('SELECT 1 FROM galleries WHERE public_slug = ? AND id <> ?').get(slug, id)) slug = `${base}-${++n}`;
    }
    db.prepare('UPDATE galleries SET visibility=?, public_slug=? WHERE id=?').run(visibility, slug, id);
  },
};

export const Files = {
  forGallery: (gid) => db.prepare('SELECT * FROM files WHERE gallery_id=? ORDER BY sort_order, created_at').all(gid),
  byId: (id) => db.prepare('SELECT * FROM files WHERE id=?').get(id),
  create: (f) => db.prepare(`INSERT INTO files(id, gallery_id, kind, original_name, filename, size, width, height, has_preview, sort_order)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM files WHERE gallery_id=?))`)
    .run(f.id, f.gallery_id, f.kind, f.original_name, f.filename, f.size, f.width, f.height, f.has_preview ? 1 : 0, f.gallery_id),
  delete: (id) => db.prepare('DELETE FROM files WHERE id=?').run(id),
};

export const Portfolio = {
  all: () => db.prepare('SELECT * FROM portfolio ORDER BY sort_order, created_at DESC').all(),
  loose: () => db.prepare('SELECT * FROM portfolio WHERE album_id IS NULL ORDER BY sort_order, created_at DESC').all(),
  forAlbum: (albumId) => db.prepare('SELECT * FROM portfolio WHERE album_id=? ORDER BY sort_order, created_at DESC').all(albumId),
  byId: (id) => db.prepare('SELECT * FROM portfolio WHERE id=?').get(id),
  create: (p) => db.prepare(`INSERT INTO portfolio(id, title, category, kind, filename, embed_url, width, height, album_id, sort_order)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM portfolio))`)
    .run(p.id, p.title, p.category, p.kind, p.filename, p.embed_url, p.width, p.height, p.album_id || null),
  update: (id, p) => db.prepare('UPDATE portfolio SET title=?, category=? WHERE id=?').run(p.title, p.category, id),
  setAlbum: (id, albumId) => db.prepare('UPDATE portfolio SET album_id=? WHERE id=?').run(albumId || null, id),
  delete: (id) => db.prepare('DELETE FROM portfolio WHERE id=?').run(id),
  move: (id, dir) => {
    const item = Portfolio.byId(id);
    if (!item) return;
    const items = item.album_id ? Portfolio.forAlbum(item.album_id) : Portfolio.loose();
    swapOrder(items, id, dir, 'portfolio');
  },
};

function swapOrder(items, id, dir, table) {
  const i = items.findIndex((x) => x.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= items.length) return;
  const upd = db.prepare(`UPDATE ${table} SET sort_order=? WHERE id=?`);
  items.forEach((x, k) => upd.run(k + 1, x.id));
  upd.run(j + 1, items[i].id);
  upd.run(i + 1, items[j].id);
}

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'album';

export const Albums = {
  all: () => db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM portfolio p WHERE p.album_id = a.id) AS item_count
    FROM albums a ORDER BY a.sort_order, a.created_at DESC`).all(),
  byId: (id) => db.prepare('SELECT * FROM albums WHERE id=?').get(id),
  bySlug: (slug) => db.prepare('SELECT * FROM albums WHERE slug=?').get(slug),
  create: (a) => {
    const id = newId();
    let slug = slugify(a.title);
    let n = 1;
    while (Albums.bySlug(slug)) slug = `${slugify(a.title)}-${++n}`;
    db.prepare(`INSERT INTO albums(id, slug, title, category, description, sort_order)
      VALUES(?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM albums))`)
      .run(id, slug, a.title, a.category, a.description);
    return id;
  },
  update: (id, a) => db.prepare('UPDATE albums SET title=?, category=?, description=? WHERE id=?').run(a.title, a.category, a.description, id),
  setCover: (id, itemId) => db.prepare('UPDATE albums SET cover_item_id=? WHERE id=?').run(itemId, id),
  move: (id, dir) => swapOrder(Albums.all(), id, dir, 'albums'),
  delete: (id) => db.prepare('DELETE FROM albums WHERE id=?').run(id),
};

export const Packages = {
  all: () => db.prepare('SELECT * FROM packages ORDER BY sort_order, created_at').all(),
  active: () => db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY sort_order, created_at').all(),
  byId: (id) => db.prepare('SELECT * FROM packages WHERE id=?').get(id),
  bySlug: (slug) => db.prepare('SELECT * FROM packages WHERE slug=?').get(slug),
  create: (p) => {
    const id = newId();
    const base = slugify(p.name) || 'package';
    let slug = base;
    let n = 1;
    while (Packages.bySlug(slug)) slug = `${base}-${++n}`;
    db.prepare(`INSERT INTO packages(id, slug, name, price_cents, currency, features, badge, included_photos, includes_video, active, sort_order)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM packages))`)
      .run(id, slug, p.name, p.price_cents, p.currency || 'ILS', p.features || '', p.badge || '', p.included_photos || 0, p.includes_video ? 1 : 0, p.active === false ? 0 : 1);
    return id;
  },
  update: (id, p) => db.prepare(`UPDATE packages SET name=?, price_cents=?, currency=?, features=?, badge=?, included_photos=?, includes_video=?, active=? WHERE id=?`)
    .run(p.name, p.price_cents, p.currency || 'ILS', p.features || '', p.badge || '', p.included_photos || 0, p.includes_video ? 1 : 0, p.active ? 1 : 0, id),
  move: (id, dir) => swapOrder(Packages.all(), id, dir, 'packages'),
  delete: (id) => db.prepare('DELETE FROM packages WHERE id=?').run(id),
  /**
   * "Build your own" = one of the normal packages as the base, plus add-ons
   * (extra edited photos, extra cinematic videos) priced per unit.
   */
  calculator: () => {
    const list = Packages.active();
    const videoPkg = list.filter((p) => p.includes_video).sort((a, b) => a.price_cents - b.price_cents)[0];
    const extraVideoDefault = videoPkg ? videoPkg.price_cents : 0;
    return {
      currency: (list[0] || { currency: 'ILS' }).currency,
      packages: list.map((p) => ({ slug: p.slug, name: p.name, price_cents: p.price_cents, included_photos: p.included_photos, includes_video: Boolean(p.includes_video) })),
      extraPhotoCents: Number(getSetting('pkg_extra_photo_cents', 3000)),
      extraVideoCents: Number(getSetting('pkg_extra_video_cents', extraVideoDefault)),
      maxExtraPhotos: Number(getSetting('pkg_max_extra_photos', 40)),
      maxExtraVideos: Number(getSetting('pkg_max_extra_videos', 3)),
    };
  },
  estimate: (baseSlug, extraPhotos, extraVideos) => {
    const c = Packages.calculator();
    const base = c.packages.find((p) => p.slug === baseSlug);
    if (!base) return null;
    const photos = Math.min(Math.max(0, extraPhotos | 0), c.maxExtraPhotos);
    const videos = Math.min(Math.max(0, extraVideos | 0), c.maxExtraVideos);
    return { base, photos, videos, total: base.price_cents + photos * c.extraPhotoCents + videos * c.extraVideoCents };
  },
};

// Seed the three starting packages on an empty table
if (!Packages.all().length) {
  Packages.create({ name: 'REV X SIGNATURE', price_cents: 65000, currency: 'ILS', features: 'Car photography\n20 edited photos', badge: '', included_photos: 20, includes_video: false });
  Packages.create({ name: 'REV X CINEMATIC', price_cents: 85000, currency: 'ILS', features: 'One cinematic car video\nProfessional color grading and sound design', badge: '', included_photos: 0, includes_video: true });
  Packages.create({ name: 'REV X ULTIMATE', price_cents: 150000, currency: 'ILS', features: '25 edited photos\nOne cinematic video\nColor grading and sound design', badge: 'Best value', included_photos: 25, includes_video: true });
}

export const Clients = {
  byId: (id) => db.prepare('SELECT * FROM clients WHERE id=?').get(id),
  byEmail: (email) => db.prepare('SELECT * FROM clients WHERE email=?').get(String(email || '').trim().toLowerCase()),
  create: (c) => {
    const id = newId();
    db.prepare('INSERT INTO clients(id, name, email, phone, password_hash) VALUES(?, ?, ?, ?, ?)')
      .run(id, c.name, c.email.trim().toLowerCase(), c.phone, c.password_hash);
    return id;
  },
  update: (id, c) => db.prepare('UPDATE clients SET name=?, phone=? WHERE id=?').run(c.name, c.phone, id),
  setPassword: (id, hash) => db.prepare('UPDATE clients SET password_hash=? WHERE id=?').run(hash, id),
  galleriesFor: (email) => db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM files f WHERE f.gallery_id = g.id) AS file_count
    FROM galleries g WHERE lower(g.client_email) = ? ORDER BY g.created_at DESC`).all(String(email || '').toLowerCase()),
};

export const Bookings = {
  all: () => db.prepare(`
    SELECT b.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
    FROM bookings b JOIN clients c ON c.id = b.client_id
    ORDER BY CASE b.status WHEN 'new' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, b.created_at DESC`).all(),
  forClient: (clientId) => db.prepare('SELECT * FROM bookings WHERE client_id=? ORDER BY created_at DESC').all(clientId),
  byId: (id) => db.prepare('SELECT * FROM bookings WHERE id=?').get(id),
  countNew: () => db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='new'").get().n,
  create: (b) => {
    const id = newId();
    db.prepare(`INSERT INTO bookings(id, client_id, service, car, preferred_date, location, message, package_name, estimate_cents, photos, video)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, b.client_id, b.service, b.car, b.preferred_date, b.location, b.message, b.package_name || '', b.estimate_cents || 0, b.photos || 0, b.video ? 1 : 0);
    return id;
  },
  setStatus: (id, status, note) => db.prepare('UPDATE bookings SET status=?, admin_note=? WHERE id=?').run(status, note ?? '', id),
  delete: (id) => db.prepare('DELETE FROM bookings WHERE id=?').run(id),
};

export const Payments = {
  record: (gid, provider, ref, amount_cents, currency) => db.prepare(
    'INSERT INTO payments(id, gallery_id, provider, provider_ref, amount_cents, currency) VALUES(?, ?, ?, ?, ?, ?)'
  ).run(newId(), gid, provider, ref, amount_cents, currency),
  forGallery: (gid) => db.prepare('SELECT * FROM payments WHERE gallery_id=? ORDER BY created_at DESC').all(gid),
};
