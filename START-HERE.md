# RevX Photography website — start here

This folder is your complete website: the code, your settings, the packages, and the rotating-car animation. Nothing else is needed except a computer or server with Node.js.

## Try it on your own computer (5 minutes)

1. Install Node.js from https://nodejs.org (choose the LTS version, click through the installer).
2. Open this folder and double-click **start-windows.bat** (on Mac: open Terminal, drag `start-mac.command` into it, press Enter).
3. The site opens at http://localhost:3000. Sign in at http://localhost:3000/admin with the password in **HANDOVER.txt**, then change it in Settings.

Everything you upload while running locally is saved in the `data` folder. That folder *is* your site's content: keep it, back it up, and copy it along whenever you move the site.

## Put it online

The site needs a small server that keeps your original photos and videos on disk (they can be gigabytes, so free static hosts don't work). Three ways, from easiest to most hands-on:

**A. Pay a managed Node host.** Railway, Render or Fly.io can run this with a persistent disk, roughly 7–15 USD/month. In their dashboard: create a service from this folder (they detect the Dockerfile), attach a volume mounted at `/data`, set the environment variable `BASE_URL` to your site address and `COOKIE_SECURE=1`. Upload the `data` folder's contents to the volume once.

**B. Your own small server (cheapest, ~4 USD/month).** Follow **DEPLOY.md**. It is copy-paste: one script prepares the server, one command uploads and starts the site with automatic HTTPS and nightly backups.

**C. Hand it to any web developer.** Give them this folder and DEPLOY.md. It is a standard Node.js + Docker project; any freelancer can host it in an hour.

For all three you want a domain name (about 10 USD/year from Namecheap, Cloudflare or GoDaddy) pointed at the server.

## Day to day

Read **ADMIN-GUIDE.md**. In short: Admin → Portfolio for your work (albums + single shots), Admin → Client galleries for paid jobs (private links, unlock after payment, public/private switch with the client's name), Admin → Packages for prices, Admin → Bookings for requests, Admin → Settings for your logo, colour, contact details and payment instructions.

The Mercedes album currently on the site is a placeholder made with AI renders so you can see how albums look. Delete it from Admin → Portfolio and upload your own shoots.

## If something breaks

- The site won't start: make sure Node.js 22.13 or newer is installed (`node --version`).
- Uploads fail on a server: check disk space and the proxy's per-request body limit. The resumable Tus endpoint supports files up to 200 GB as long as each chunk fits within that limit.
- Lost the admin password: stop the site, delete the line `admin_password_hash` from the settings table in `data/studio.sqlite` (any SQLite tool), start it, and the setup page asks for a new password.
