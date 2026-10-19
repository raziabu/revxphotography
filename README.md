# Studio Site

New here? Read **START-HERE.md** first.

A self-hosted website for a photographer / videographer:

- **Public portfolio** — albums (one shoot = one album with a cover and its own page) plus single shots. Upload photos and clips, or paste YouTube / Vimeo links. Category filters, lightbox, scroll-reveal animations, contact section.
- **Scroll-driven hero** — a car that rotates through 360° as the visitor scrolls (frame sequence in `public/car/`, see below).
- **Private client galleries** — each gallery gets a secret link. The client sees watermarked previews until payment is confirmed, then can download every original file (individually or as one zip). Admin uploads support files up to 2 GiB with the standard form, or up to 200 GB using the resumable Tus endpoint.
- **Public or private galleries** — a client gallery is private (link only) by default. Mark it public and it appears on the homepage under the client's name as a view-only page (no downloads).
- **Packages** — deals shown on the homepage (seeded with REV X SIGNATURE / CINEMATIC / ULTIMATE) and editable under Admin → Packages. A "Build your own" card lets a client start from any package and add extra photos or videos at per-unit prices you set; the estimate is attached to their booking request.
- **Client accounts & bookings** — every "Book a shoot" button leads to a sign-in / create-account page, then a booking form (service, car, date, location, notes). Clients get a "My account" page with their booking status, the photographer's notes, and any galleries made for their email. The admin sees requests under Admin → Bookings and can confirm, decline, or add a note.
- **Payment two ways** — mark a gallery paid by hand (cash, bank transfer, PayPal…) or add a Stripe key so clients pay by card and the gallery unlocks itself.
- **Admin area** — one password, no database server to install. Everything lives in a single `data/` folder.

## Run it

Requirements: Node.js 22.13 or newer (uses the built-in SQLite). `ffmpeg` is optional, it adds poster frames for uploaded videos.

```bash
npm install
npm start
```

Open http://localhost:3000. The first visit asks you to choose a studio name and admin password.
Then go to **Admin → Settings** to fill in contact details, currency and payment instructions.

## Daily use

1. **Portfolio**: Admin → Portfolio → add files or a YouTube link.
2. **Client job**: Admin → Client galleries → *New gallery* → set client name and price → drop the photos/videos in.
3. Click **Copy link** and send it to the client (WhatsApp / email buttons are there too).
4. When they pay: click **Mark as paid & unlock**. With Stripe configured, card payments unlock automatically.
5. **Packages**: Admin → Packages to change names, prices, included items, badge (e.g. Best value), order, and the add-on prices for the custom builder.
6. **Bookings**: Admin → Bookings shows new requests (with a count in the nav). Confirm with a note like "Saturday 17:00, 650 ILS"; the client sees it in their account. Link galleries to a client by using the same email in the gallery's *Client email* field.
7. Need to revoke access? **New link** invalidates the old one; **Lock again** turns downloads off.

### Resumable large uploads

For files larger than 2 GiB, use the Tus 1.0 endpoint
`POST /admin/galleries/:galleryId/uploads`. It is scoped to an existing gallery and
requires an authenticated admin session. The endpoint supports Tus creation,
`HEAD` offset checks, resumable `PATCH` requests, termination with `DELETE`, and
uploads up to 200,000,000,000 bytes. Completed files are added to the gallery
automatically. Incomplete uploads are stored under `data/tus/` and expire seven
days after creation or their latest `PATCH`, whichever is later; completed media
stays in `data/uploads/`.

For example, a browser client using `tus-js-client` can upload in 64 MiB chunks
and resume after a network interruption:

```js
import * as tus from 'tus-js-client';

const upload = new tus.Upload(file, {
  endpoint: `/admin/galleries/${galleryId}/uploads`,
  chunkSize: 64 * 1024 * 1024,
  withCredentials: true,
  metadata: { filename: file.name },
  onError: (error) => console.error(error),
  onProgress: (sent, total) => console.log(sent, total),
  onSuccess: () => console.log('Upload complete'),
});
upload.start();
```

Same-origin requests work by default. For a separate but same-site browser
origin, set `TUS_CORS_ORIGINS` to a comma-separated allowlist of exact origins
(including scheme and port if present), and enable credentials in the Tus
client. The reverse-proxy body-size limit applies to each `PATCH` chunk, not the
total Tus upload; use chunks smaller than that limit. The app disables Node
request and socket timeouts for long transfers. Ensure the data volume has enough
free space for both the completed files and any in-progress uploads.

## The rotating car hero

The homepage hero is a frame sequence: `public/car/frame_001.webp … frame_100.webp` plus `public/car/frames.json` (`{ "count": 100, "pattern": "frame_{i}.webp" }`). The current frames were generated with AI (Mercedes-AMG C63 orbit). To use a real car: film or render a smooth 360° orbit, extract about 100 frames with

```bash
ffmpeg -i orbit.mp4 -vf "fps=10,scale=1600:-2" -c:v libwebp -quality 80 public/car/frame_%03d.webp
```

and update `count` in `frames.json`. Delete `frames.json` to fall back to a static hero.

## Deploying on a server

Any Linux VPS (Hetzner, DigitalOcean, etc.) or a Node host with persistent disk works. Example with pm2 and Caddy:

```bash
# on the server
git clone <your repo> studio-site && cd studio-site
npm install --omit=dev
cp .env.example .env     # set BASE_URL=https://yourdomain.com and COOKIE_SECURE=1
npm i -g pm2 && pm2 start src/server.js --name studio && pm2 save
```

Caddyfile (automatic HTTPS):

```
yourdomain.com {
    reverse_proxy localhost:3000
    request_body { max_size 4GB }
}
```

The proxy's `max_size` limits an individual Tus `PATCH` request; it does not
limit the full resumable upload. The app's Docker Caddy configuration allows
8 GB per request.

Back up the `data/` folder — it holds the database, originals and previews.

### Stripe

1. Create an account at stripe.com and copy the **secret key** (`sk_live_…`) into Admin → Settings (or `.env`).
2. Optional but recommended: add a webhook in the Stripe dashboard pointing at `https://yourdomain.com/webhooks/stripe` for the event `checkout.session.completed`, and paste its signing secret into Settings. The site also verifies the payment on the client's return, so the webhook is a safety net.

## Folder layout

```
src/server.js   routes (public, client galleries, admin, Stripe)
src/tus-uploads.js   Tus 1.0 resumable uploads for admin galleries
src/db.js       SQLite schema and queries
src/media.js    thumbnails, watermarked previews, video posters, embed parsing
src/auth.js     admin cookie session
views/          EJS templates
public/         CSS and front-end JS
data/           database + uploads (created on first run)
```
