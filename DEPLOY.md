# Putting the site online

The site keeps every original photo and video on disk, so it needs a small server with storage, not a static host. A basic VPS is enough: 2 GB RAM, 40–80 GB disk, around 5 USD / month (Hetzner CX22, DigitalOcean Basic, Contabo, etc.). You also need a domain name (for example from Namecheap or Cloudflare, about 10 USD / year).

Everything below is copy-paste. Only three things are yours to do by hand: create the server, point the domain at it, and run the commands.

## 1. Create the server

1. Sign up with a VPS provider and create a server with **Ubuntu 24.04**. Choose the region closest to Israel (Hetzner Falkenstein/Helsinki or DigitalOcean Frankfurt are fine).
2. Add your SSH key when the provider asks (or use the password they email you).
3. Note the server's public IP address.

## 2. Point the domain at the server

In your domain's DNS settings add an **A record**:

| Type | Name | Value |
|------|------|-------|
| A | `@` (or `revx`) | the server IP |

Wait a few minutes until `ping yourdomain.com` answers with that IP.

## 3. Prepare the server (one time)

From PowerShell on your PC (replace the IP and domain):

```powershell
scp .\deploy\server-setup.sh root@YOUR.SERVER.IP:/root/
ssh root@YOUR.SERVER.IP "bash /root/server-setup.sh yourdomain.com"
```

This installs Docker, opens only the web + SSH ports in the firewall, creates `/srv/revx` with an `.env` file, and schedules a nightly backup.

## 4. Upload the site and start it

From the project folder on your PC:

```powershell
.\deploy\push.ps1 -Server root@YOUR.SERVER.IP -WithData
```

`-WithData` copies the current settings, packages, the demo album and the rotating-car frames so the site comes up exactly as you saw it locally. Use it the first time only; afterwards run the same command **without** `-WithData` so you never overwrite the live uploads.

The first start builds the app (2–3 minutes). Then open `https://yourdomain.com`. HTTPS is automatic (Let's Encrypt via Caddy).

## 5. Hand over to the photographer

- Admin: `https://yourdomain.com/admin` with the password in `HANDOVER.txt` (not stored in the project). He should change it right away in Admin → Settings → Change password.
- Give him `ADMIN-GUIDE.md`, it walks through everything he can do.

## Later: updating the site

Edit locally, then:

```powershell
.\deploy\push.ps1 -Server root@YOUR.SERVER.IP
```

## Useful server commands

```bash
cd /srv/revx
docker compose logs -f app        # live log
docker compose restart app        # restart the site
docker compose up -d --build      # rebuild after code changes
bash deploy/backup.sh             # manual backup to /srv/revx-backups
df -h                             # disk space (originals live in /srv/revx/data/uploads)
```

## Stripe card payments (optional)

Put the keys in `/srv/revx/.env` (`STRIPE_SECRET_KEY=sk_live_...`) and run `docker compose up -d`, or paste them in Admin → Settings. Add a webhook in Stripe pointing to `https://yourdomain.com/webhooks/stripe` for `checkout.session.completed`.

## Growing out of the server

When the disk fills up, VPS providers let you attach a bigger volume; mount it at `/srv/revx/data` and restart. Nothing in the app needs to change.
