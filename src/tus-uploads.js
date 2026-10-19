import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Files, Galleries, getSetting, newId } from './db.js';
import { DATA_DIR, UPLOADS_DIR } from './paths.js';
import { kindOf, processUpload } from './media.js';
import { requireAdmin } from './auth.js';

const MAX_UPLOAD_BYTES = 200_000_000_000;
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TUS_DIR = path.join(DATA_DIR, 'tus');
const TUS_VERSION = '1.0.0';
const ALLOWED_METHODS = 'OPTIONS, POST, HEAD, PATCH, DELETE';
const ALLOWED_HEADERS = 'Tus-Resumable, Upload-Length, Upload-Metadata, Upload-Offset, Upload-Defer-Length, Content-Type, Authorization';
const EXPOSED_HEADERS = 'Tus-Resumable, Tus-Version, Tus-Extension, Tus-Max-Size, Upload-Offset, Upload-Length, Upload-Metadata, Upload-Expires, Location';
const locks = new Map();

fs.mkdirSync(TUS_DIR, { recursive: true });

const statePath = (id) => path.join(TUS_DIR, `${id}.json`);
const partPath = (id) => path.join(TUS_DIR, `${id}.part`);
const validId = (id) => /^[a-f0-9]{32}$/.test(id);

function withLock(id, action) {
  const previous = locks.get(id) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(id, current);
  return previous.then(action).finally(() => {
    release();
    if (locks.get(id) === current) locks.delete(id);
  });
}

async function saveState(state) {
  const temporaryPath = `${statePath(state.id)}.tmp`;
  await fs.promises.writeFile(temporaryPath, JSON.stringify(state));
  await fs.promises.rename(temporaryPath, statePath(state.id));
}

async function readState(id) {
  try {
    const state = JSON.parse(await fs.promises.readFile(statePath(id), 'utf8'));
    if (
      state.id !== id ||
      !Number.isSafeInteger(state.length) ||
      !Number.isSafeInteger(state.offset) ||
      state.offset < 0 ||
      state.offset > state.length ||
      typeof state.galleryId !== 'string' ||
      typeof state.originalName !== 'string' ||
      !/^[a-f0-9]+$/.test(state.fileId) ||
      !/^[a-f0-9]+(?:\.[a-z0-9]{1,12})?$/.test(state.filename) ||
      !Number.isSafeInteger(state.expiresAt) ||
      typeof state.finalized !== 'boolean'
    ) {
      throw new Error(`Invalid Tus upload state: ${id}`);
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function setTusHeaders(res) {
  res.set({
    'Tus-Resumable': TUS_VERSION,
    'Tus-Version': TUS_VERSION,
    'Tus-Extension': 'creation,termination,expiration',
    'Tus-Max-Size': String(MAX_UPLOAD_BYTES),
    'Cache-Control': 'no-store',
  });
}

function sendTusError(res, status, message) {
  return res.status(status).type('text/plain').send(message);
}

function parseMetadata(header) {
  const metadata = {};
  if (!header) return metadata;
  for (const part of header.split(',')) {
    const [key, encoded = ''] = part.trim().split(/\s+/, 2);
    if (!/^[a-z0-9_-]+$/i.test(key) || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) {
      throw new Error('Invalid Upload-Metadata header');
    }
    metadata[key] = Buffer.from(encoded, 'base64').toString('utf8');
  }
  return metadata;
}

function safeOriginalName(name) {
  const basename = path.basename(String(name || 'upload').replaceAll('\\', '/'));
  return basename.replace(/[\u0000-\u001f\u007f]/g, '_').trim().slice(0, 255) || 'upload';
}

function safeExtension(name) {
  const extension = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '';
}

function uploadExpires(state) {
  return new Date(state.expiresAt).toUTCString();
}

function setUploadHeaders(res, state) {
  res.set({
    'Upload-Offset': String(state.offset),
    'Upload-Length': String(state.length),
    'Upload-Expires': uploadExpires(state),
  });
}

async function finalizeUpload(state) {
  if (state.finalized) return state;

  const destination = path.join(UPLOADS_DIR, state.filename);
  if (Files.byId(state.fileId)) {
    state.finalized = true;
    state.expiresAt = Date.now() + UPLOAD_TTL_MS;
    await saveState(state);
    return state;
  }

  try {
    await fs.promises.rename(partPath(state.id), destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.promises.access(destination);
  }

  const gallery = Galleries.byId(state.galleryId);
  if (!gallery) throw new Error(`Gallery ${state.galleryId} no longer exists`);
  const kind = kindOf(state.originalName);
  const info = await processUpload({
    id: state.fileId,
    filename: state.filename,
    kind,
    watermarkText: getSetting('studio_name', 'PREVIEW'),
  });
  Files.create({
    id: state.fileId,
    gallery_id: gallery.id,
    kind,
    original_name: state.originalName,
    filename: state.filename,
    size: state.length,
    ...info,
  });
  if (!gallery.cover_file_id && info.has_preview) Galleries.setCover(gallery.id, state.fileId);

  state.finalized = true;
  state.expiresAt = Date.now() + UPLOAD_TTL_MS;
  await saveState(state);
  return state;
}

async function cleanupExpiredUploads() {
  const entries = await fs.promises.readdir(TUS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    if (!validId(id)) continue;
    const state = await readState(id);
    if (state && state.expiresAt <= Date.now()) {
      if (!state.finalized) await fs.promises.rm(partPath(id), { force: true });
      await fs.promises.rm(statePath(id), { force: true });
    }
  }
}

void cleanupExpiredUploads().catch((error) => {
  console.error('Unable to clean expired Tus uploads:', error);
});

const router = express.Router();
const basePath = '/admin/galleries/:galleryId/uploads';

router.use(basePath, (req, res, next) => {
  setTusHeaders(res);
  res.vary('Origin');
  const origin = req.get('Origin');
  if (origin) {
    const configuredOrigins = (process.env.TUS_CORS_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
    if (!sameOrigin && !configuredOrigins.includes(origin)) {
      return sendTusError(res, 403, 'Origin is not allowed');
    }
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Headers': ALLOWED_HEADERS,
      'Access-Control-Expose-Headers': EXPOSED_HEADERS,
      'Access-Control-Max-Age': '86400',
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.post(basePath, requireAdmin, async (req, res) => {
  if (req.get('Tus-Resumable') !== TUS_VERSION) {
    res.set('Tus-Version', TUS_VERSION);
    return sendTusError(res, 412, 'Tus-Resumable must be 1.0.0');
  }
  const gallery = Galleries.byId(req.params.galleryId);
  if (!gallery) return sendTusError(res, 404, 'Gallery not found');
  const contentLength = req.get('Content-Length');
  if ((contentLength !== undefined && contentLength !== '0') || req.get('Transfer-Encoding')) {
    return sendTusError(res, 400, 'Tus creation requests must have an empty body');
  }
  const lengthHeader = req.get('Upload-Length');
  if (!/^(0|[1-9]\d*)$/.test(lengthHeader || '')) {
    return sendTusError(res, 400, 'A valid Upload-Length is required');
  }
  const length = Number(lengthHeader);
  if (!Number.isSafeInteger(length) || length > MAX_UPLOAD_BYTES) {
    return sendTusError(res, 413, `Upload length exceeds the ${MAX_UPLOAD_BYTES}-byte limit`);
  }

  let metadata;
  try {
    metadata = parseMetadata(req.get('Upload-Metadata'));
  } catch (error) {
    return sendTusError(res, 400, error.message);
  }

  const id = crypto.randomBytes(16).toString('hex');
  const originalName = safeOriginalName(metadata.filename);
  const state = {
    id,
    galleryId: gallery.id,
    originalName,
    length,
    offset: 0,
    fileId: newId(),
    filename: `${newId()}${safeExtension(originalName)}`,
    expiresAt: Date.now() + UPLOAD_TTL_MS,
    finalized: false,
  };
  try {
    const handle = await fs.promises.open(partPath(id), 'wx');
    await handle.close();
    await saveState(state);
    if (length === 0) await finalizeUpload(state);
  } catch (error) {
    await Promise.all([
      fs.promises.rm(partPath(id), { force: true }),
      fs.promises.rm(statePath(id), { force: true }),
      fs.promises.rm(`${statePath(id)}.tmp`, { force: true }),
    ]);
    console.error('Unable to create Tus upload:', error);
    return sendTusError(res, 500, 'Unable to create upload');
  }

  setUploadHeaders(res, state);
  return res.status(201).set('Location', `${req.baseUrl}${req.path}/${id}`).end();
});

router.head(`${basePath}/:uploadId`, requireAdmin, async (req, res) => {
  const { uploadId, galleryId } = req.params;
  if (!validId(uploadId)) return sendTusError(res, 404, 'Upload not found');
  if (req.get('Tus-Resumable') !== TUS_VERSION) {
    res.set('Tus-Version', TUS_VERSION);
    return sendTusError(res, 412, 'Tus-Resumable must be 1.0.0');
  }
  try {
    const state = await withLock(uploadId, async () => {
      const current = await readState(uploadId);
      if (!current || current.galleryId !== galleryId) return null;
      if (current.expiresAt <= Date.now()) {
        if (!current.finalized) await fs.promises.rm(partPath(uploadId), { force: true });
        await fs.promises.rm(statePath(uploadId), { force: true });
        return null;
      }
      if (current.offset === current.length && !current.finalized) await finalizeUpload(current);
      return current;
    });
    if (!state) return sendTusError(res, 404, 'Upload not found or expired');
    setUploadHeaders(res, state);
    return res.status(200).end();
  } catch (error) {
    console.error('Unable to read Tus upload:', error);
    return sendTusError(res, 500, 'Unable to read upload');
  }
});

router.patch(`${basePath}/:uploadId`, requireAdmin, async (req, res) => {
  const { uploadId, galleryId } = req.params;
  if (!validId(uploadId)) return sendTusError(res, 404, 'Upload not found');
  if (req.get('Tus-Resumable') !== TUS_VERSION) {
    res.set('Tus-Version', TUS_VERSION);
    return sendTusError(res, 412, 'Tus-Resumable must be 1.0.0');
  }
  if (req.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/offset+octet-stream') {
    return sendTusError(res, 415, 'Content-Type must be application/offset+octet-stream');
  }
  const offsetHeader = req.get('Upload-Offset');
  if (!/^(0|[1-9]\d*)$/.test(offsetHeader || '')) {
    return sendTusError(res, 400, 'A valid Upload-Offset is required');
  }

  try {
    const state = await withLock(uploadId, async () => {
      const current = await readState(uploadId);
      if (!current || current.galleryId !== galleryId) return { status: 404, message: 'Upload not found' };
      if (current.expiresAt <= Date.now()) {
        if (!current.finalized) await fs.promises.rm(partPath(uploadId), { force: true });
        await fs.promises.rm(statePath(uploadId), { force: true });
        return { status: 404, message: 'Upload expired' };
      }
      const offset = Number(offsetHeader);
      if (offset !== current.offset) return { status: 409, message: 'Upload-Offset does not match' };
      if (current.offset === current.length) return { status: 409, message: 'Upload is already complete' };

      const contentLengthHeader = req.get('Content-Length');
      const contentLength = contentLengthHeader === undefined ? null : Number(contentLengthHeader);
      if (
        contentLengthHeader !== undefined &&
        (!/^(0|[1-9]\d*)$/.test(contentLengthHeader) || !Number.isSafeInteger(contentLength) || contentLength > current.length - current.offset)
      ) {
        return { status: 413, message: 'PATCH body exceeds the remaining upload length' };
      }

      let received = 0;
      const countBytes = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > current.length - current.offset) {
            callback(new Error('PATCH body exceeds the remaining upload length'));
          } else {
            callback(null, chunk);
          }
        },
      });
      await pipeline(
        req,
        countBytes,
        fs.createWriteStream(partPath(uploadId), { flags: 'r+', start: current.offset }),
      );
      if (contentLength !== null && received !== contentLength) {
        return { status: 400, message: 'PATCH body length does not match Content-Length' };
      }
      current.offset += received;
      current.expiresAt = Date.now() + UPLOAD_TTL_MS;
      await fs.promises.truncate(partPath(uploadId), current.offset);
      if (current.offset === current.length) {
        current.finalized = false;
      }
      await saveState(current);
      if (current.offset === current.length) await finalizeUpload(current);
      return { state: current };
    });

    if (!state.state) return sendTusError(res, state.status, state.message);
    setUploadHeaders(res, state.state);
    return res.status(204).end();
  } catch (error) {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !req.aborted) {
      console.error('Unable to write Tus upload:', error);
    }
    if (!res.headersSent && !res.destroyed) return sendTusError(res, 500, 'Unable to write upload');
  }
});

router.delete(`${basePath}/:uploadId`, requireAdmin, async (req, res) => {
  const { uploadId, galleryId } = req.params;
  if (!validId(uploadId)) return sendTusError(res, 404, 'Upload not found');
  if (req.get('Tus-Resumable') !== TUS_VERSION) {
    res.set('Tus-Version', TUS_VERSION);
    return sendTusError(res, 412, 'Tus-Resumable must be 1.0.0');
  }
  try {
    const deleted = await withLock(uploadId, async () => {
      const state = await readState(uploadId);
      if (!state || state.galleryId !== galleryId) return false;
      if (!state.finalized) await fs.promises.rm(partPath(uploadId), { force: true });
      await fs.promises.rm(statePath(uploadId), { force: true });
      return true;
    });
    if (!deleted) return sendTusError(res, 404, 'Upload not found');
    return res.status(204).end();
  } catch (error) {
    console.error('Unable to terminate Tus upload:', error);
    return sendTusError(res, 500, 'Unable to terminate upload');
  }
});

export default router;
