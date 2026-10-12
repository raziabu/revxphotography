# RevX Photography — admin guide

Sign in at **yourdomain.com/admin** with your admin password. Change it first thing: Admin → Settings → Change password.

Everything on the site is managed from the admin bar: **Client galleries · Portfolio · Packages · Bookings · Settings**.

## Your work on the website (Portfolio)

- **Albums** are one shoot each: a cover photo, a category (BMW, Mercedes, Night…), and its own page. Create one with *+ New album*, then drag photos and videos into it. The first upload becomes the cover; change it with *Set as cover*.
- **Single shots** are one-off highlights shown in the loose grid under the albums.
- Films that live on YouTube or Vimeo: paste the link, the site embeds it.
- Order albums and photos with the arrows. Category names become the filter chips on the homepage.
- Upload the real exports (full size, best quality). The site makes its own small previews for the pages and keeps your original untouched. Visitors only ever see previews; originals are never downloadable from the portfolio.

## Clients and their files (Client galleries)

1. *+ New gallery*: client name, email (use the same email they sign up with, then the gallery shows in their account), title, price.
2. Drop their photos/videos in. Until you unlock it, the client only sees watermarked previews.
3. *Copy link* and send it (WhatsApp / email buttons are there). The link is secret; anyone with it can view, nobody can download.
4. Paid? Press **Mark as paid & unlock** (cash, bank transfer, Bit…). With Stripe keys in Settings, clients can also pay by card on the page and it unlocks itself.
5. After unlocking, the client downloads the originals, one by one or everything as a zip, exactly the files you uploaded.
6. **Show on the website?** → *Make public* lists that shoot on the homepage under the client's name in "People I've shot for". Visitors get a view-only page: no downloads, ever. Locked galleries show watermarked previews publicly, unlocked ones show clean previews. Make private again any time.
7. *New link* kills the old link. *Lock again* turns downloads off. *Delete gallery* removes the files from the server.

## Packages

Admin → Packages. Change names, prices, what's included (one line each), the badge ("Best value"), and the order. Untick *Shown on the website* to hide one. The **Build your own** card on the homepage lets a client start from any package and add extra photos or videos; set those add-on prices in the right-hand box.

## Bookings

Every "Book a shoot" button asks the visitor to sign in or create an account, then sends you a request with the package they chose, the car, date and notes. They appear under Admin → Bookings (the number in the menu is how many are new). Confirm, decline, or add a note like "Saturday 17:00, 650 ILS", the client sees it in their account. Their phone number links straight to WhatsApp.

## Settings

- **Look**: upload your logo (PNG with transparent background) and pick an accent colour, the gold turns into your colour everywhere.
- **Studio / Contact**: name, tagline, the small line above your name, the about text, contact section text, phone, WhatsApp, Instagram, location.
- **Payments**: currency, the instructions shown on locked galleries (how to pay you), an optional payment link, optional Stripe keys.
- **Change password**.

## Tips

- Phone uploads work too, but originals from the computer are best.
- Videos: files up to several GB are fine. Thumbnails for uploaded videos are generated automatically on the server.
- The rotating car on the homepage is a frame sequence; it can be replaced with your own car later (see README).
- Backups of the database and all originals run every night on the server.
