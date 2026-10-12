import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { UPLOADS_DIR, DERIVED_DIR } from './paths.js';

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DERIVED_DIR, { recursive: true });

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.heic', '.heif', '.avif', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}

// ffmpeg is optional: used to create poster frames for videos.
export const hasFfmpeg = (() => {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
})();

export const SIZES = {
  thumb: 720,  // clean, used in grids when unlocked and in admin
  large: 2400, // clean, lightbox when unlocked / public showcase (originals are only served as downloads)
  wm: 1400,    // watermarked, the only thing a locked gallery ever serves
};

export const derivedPath = (id, size) => path.join(DERIVED_DIR, `${id}_${size}.webp`);
export const posterPath = (id) => path.join(DERIVED_DIR, `${id}_poster.jpg`);
export const uploadPath = (filename) => path.join(UPLOADS_DIR, filename);

function watermarkSvg(w, h, text) {
  const safe = String(text || 'PREVIEW').replace(/[<>&"']/g, '');
  const step = Math.max(260, Math.round(Math.min(w, h) / 3));
  const fontSize = Math.max(22, Math.round(step / 9));
  let marks = '';
  for (let y = -h; y < h * 2; y += step) {
    for (let x = -w; x < w * 2; x += step * 1.6) {
      marks += `<text x="${x}" y="${y}" font-size="${fontSize}" fill="white" fill-opacity="0.28" font-family="Helvetica, Arial, sans-serif" font-weight="700" letter-spacing="3" transform="rotate(-30 ${x} ${y})">${safe.toUpperCase()}</text>`;
    }
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${marks}</svg>`
  );
}

async function renderImage(inputBuffer, outPath, maxSize, watermarkText) {
  let img = sharp(inputBuffer, { failOn: 'none' }).rotate().resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true });
  if (watermarkText) {
    const meta = await img.toBuffer({ resolveWithObject: true });
    img = sharp(meta.data).composite([{ input: watermarkSvg(meta.info.width, meta.info.height, watermarkText) }]);
  }
  await img.webp({ quality: maxSize >= 2000 ? 88 : 82 }).toFile(outPath);
}

/** Create a poster frame from a video with ffmpeg. Resolves to true if created. */
function extractPoster(videoPath, outPath) {
  return new Promise((resolve) => {
    if (!hasFfmpeg) return resolve(false);
    const p = spawn('ffmpeg', ['-y', '-ss', '00:00:01', '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-vf', 'scale=1800:-2', outPath], {
      stdio: 'ignore', windowsHide: true,
    });
    p.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath)));
    p.on('error', () => resolve(false));
  });
}

/**
 * Build thumb / large / wm variants for an uploaded file.
 * Returns { width, height, has_preview }.
 */
export async function processUpload({ id, filename, kind, watermarkText }) {
  const src = uploadPath(filename);
  let sourceBuffer = null;

  if (kind === 'image') {
    sourceBuffer = await fs.promises.readFile(src);
  } else if (kind === 'video') {
    const poster = posterPath(id);
    const ok = await extractPoster(src, poster);
    if (ok) sourceBuffer = await fs.promises.readFile(poster);
  }

  if (!sourceBuffer) return { width: null, height: null, has_preview: false };

  try {
    const meta = await sharp(sourceBuffer, { failOn: 'none' }).rotate().metadata();
    await Promise.all([
      renderImage(sourceBuffer, derivedPath(id, 'thumb'), SIZES.thumb, null),
      renderImage(sourceBuffer, derivedPath(id, 'large'), SIZES.large, null),
      renderImage(sourceBuffer, derivedPath(id, 'wm'), SIZES.wm, watermarkText),
    ]);
    return { width: meta.width ?? null, height: meta.height ?? null, has_preview: true };
  } catch (err) {
    console.error('preview failed for', filename, err.message);
    return { width: null, height: null, has_preview: false };
  }
}

export function removeFileArtifacts(id, filename) {
  const targets = [uploadPath(filename), posterPath(id), ...Object.keys(SIZES).map((s) => derivedPath(id, s))];
  for (const t of targets) fs.promises.unlink(t).catch(() => {});
}

export function parseEmbed(url) {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return { provider: 'youtube', id: u.pathname.slice(1) };
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (u.pathname.startsWith('/shorts/')) return { provider: 'youtube', id: u.pathname.split('/')[2] };
      if (u.pathname.startsWith('/embed/')) return { provider: 'youtube', id: u.pathname.split('/')[2] };
      const v = u.searchParams.get('v');
      if (v) return { provider: 'youtube', id: v };
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const m = u.pathname.match(/(\d+)/);
      if (m) return { provider: 'vimeo', id: m[1] };
    }
  } catch { /* ignore */ }
  return null;
}

export function embedSrc(url) {
  const e = parseEmbed(url);
  if (!e) return null;
  if (e.provider === 'youtube') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(e.id)}?rel=0`;
  if (e.provider === 'vimeo') return `https://player.vimeo.com/video/${encodeURIComponent(e.id)}`;
  return null;
}

export function embedThumb(url) {
  const e = parseEmbed(url);
  if (e?.provider === 'youtube') return `https://i.ytimg.com/vi/${encodeURIComponent(e.id)}/hqdefault.jpg`;
  return null;
}
