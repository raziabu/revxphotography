// Client (customer) accounts: sign in / create account, booking requests, "my account".
import express from 'express';
import bcrypt from 'bcryptjs';
import { Clients, Bookings, Packages, getSetting } from './db.js';
import { signInClient, signOutClient, clientIdFrom, loginLimiter } from './auth.js';

export const SERVICES = [
  'Static photoshoot',
  'Rolling shots',
  'Cinematic reel',
  'Night session',
  'Photos + reel package',
  'Event / meet coverage',
  'Other',
];

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//')) ? n : '/account';
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Attaches req.client / res.locals.client for every request. */
export function loadClient(req, res, next) {
  const id = clientIdFrom(req);
  req.client = id ? Clients.byId(id) : null;
  res.locals.client = req.client;
  next();
}

function requireClient(req, res, next) {
  if (req.client) return next();
  res.redirect('/account/signin?next=' + encodeURIComponent(req.originalUrl));
}

export const clientRouter = express.Router();

// ---------- sign in / create account ----------
clientRouter.get('/account/signin', (req, res) => {
  if (req.client) return res.redirect(safeNext(req.query.next));
  res.render('account/signin', {
    title: 'Sign in', noindex: true,
    mode: req.query.mode === 'signup' ? 'signup' : 'signin',
    next: safeNext(req.query.next), error: null, form: {},
  });
});

clientRouter.post('/account/signin', loginLimiter, (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const client = Clients.byEmail(email);
  const ok = client && bcrypt.compareSync(req.body.password || '', client.password_hash);
  if (!ok) {
    return res.status(401).render('account/signin', {
      title: 'Sign in', noindex: true, mode: 'signin', next: safeNext(req.body.next),
      error: 'Wrong email or password.', form: { email },
    });
  }
  signInClient(res, client.id);
  res.redirect(safeNext(req.body.next));
});

clientRouter.post('/account/signup', loginLimiter, (req, res) => {
  const form = { name: clean(req.body.name, 80), email: clean(req.body.email, 120).toLowerCase(), phone: clean(req.body.phone, 40) };
  const fail = (error) => res.status(400).render('account/signin', { title: 'Create account', noindex: true, mode: 'signup', next: safeNext(req.body.next), error, form });
  if (!form.name) return fail('Please enter your name.');
  if (!validEmail(form.email)) return fail('Please enter a valid email address.');
  if (!req.body.password || req.body.password.length < 8) return fail('Password must be at least 8 characters.');
  if (Clients.byEmail(form.email)) return fail('There is already an account with that email. Sign in instead.');
  const id = Clients.create({ ...form, password_hash: bcrypt.hashSync(req.body.password, 10) });
  signInClient(res, id);
  res.redirect(safeNext(req.body.next));
});

clientRouter.post('/account/signout', (req, res) => {
  signOutClient(res);
  res.redirect('/');
});

// ---------- booking ----------
const bookPage = (res, extra) => res.render('account/book', {
  title: 'Book a shoot', noindex: true, services: SERVICES, packages: Packages.active(), calc: Packages.calculator(), error: null, form: {}, ...extra,
});

clientRouter.get('/book', requireClient, (req, res) => {
  // prefill from a package card: /book?package=slug  or  /book?package=custom&photos=30&video=1
  // prefill from a package card: /book?package=slug  or  /book?package=custom&base=slug&photos=5&videos=1
  const form = {
    package: clean(req.query.package, 60) || '',
    base: clean(req.query.base, 60) || '',
    extra_photos: Math.max(0, parseInt(req.query.photos, 10) || 0),
    extra_videos: Math.max(0, parseInt(req.query.videos, 10) || 0),
  };
  bookPage(res, { form });
});

clientRouter.post('/book', requireClient, (req, res) => {
  const pkgSlug = clean(req.body.package, 60);
  const form = {
    package: pkgSlug,
    base: clean(req.body.base, 60),
    extra_photos: Math.max(0, parseInt(req.body.extra_photos, 10) || 0),
    extra_videos: Math.max(0, parseInt(req.body.extra_videos, 10) || 0),
    service: SERVICES.includes(req.body.service) ? req.body.service : 'Other',
    car: clean(req.body.car, 120),
    preferred_date: clean(req.body.preferred_date, 40),
    location: clean(req.body.location, 120),
    message: clean(req.body.message, 2000),
  };
  if (!form.car) return bookPage(res, { error: 'Tell me which car we are shooting.', form });

  // resolve the chosen package into a name + estimate
  let package_name = '', estimate_cents = 0, photos = 0, video = 0;
  if (pkgSlug === 'custom') {
    const est = Packages.estimate(form.base, form.extra_photos, form.extra_videos);
    if (!est) return bookPage(res, { error: 'Pick a base package for your custom deal.', form });
    if (!est.photos && !est.videos) return bookPage(res, { error: 'Add at least one extra photo or video, or just pick the base package itself.', form });
    estimate_cents = est.total;
    photos = est.base.included_photos + est.photos;
    video = (est.base.includes_video ? 1 : 0) + est.videos;
    const extras = [est.photos ? `+${est.photos} photos` : '', est.videos ? `+${est.videos} video${est.videos > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ');
    package_name = `${est.base.name} ${extras}`;
  } else if (pkgSlug) {
    const pkg = Packages.bySlug(pkgSlug);
    if (pkg) { package_name = pkg.name; estimate_cents = pkg.price_cents; photos = pkg.included_photos; video = pkg.includes_video ? 1 : 0; }
  }
  Bookings.create({ client_id: req.client.id, ...form, package_name, estimate_cents, photos, video });
  res.redirect('/account?msg=' + encodeURIComponent(`Booking request sent! ${getSetting('studio_name', 'The studio')} will confirm with you soon.`));
});

// ---------- my account ----------
clientRouter.get('/account', requireClient, (req, res) => {
  res.render('account/index', {
    title: 'My account', noindex: true,
    bookings: Bookings.forClient(req.client.id),
    galleries: Clients.galleriesFor(req.client.email),
    error: null,
  });
});

clientRouter.post('/account/profile', requireClient, (req, res) => {
  const name = clean(req.body.name, 80) || req.client.name;
  const phone = clean(req.body.phone, 40);
  Clients.update(req.client.id, { name, phone });
  if (req.body.new_password) {
    if (req.body.new_password.length < 8 || !bcrypt.compareSync(req.body.current_password || '', req.client.password_hash)) {
      return res.status(400).render('account/index', {
        title: 'My account', noindex: true, bookings: Bookings.forClient(req.client.id), galleries: Clients.galleriesFor(req.client.email),
        error: 'Password not changed: check your current password and use at least 8 characters.',
      });
    }
    Clients.setPassword(req.client.id, bcrypt.hashSync(req.body.new_password, 10));
  }
  res.redirect('/account?msg=Profile saved');
});
