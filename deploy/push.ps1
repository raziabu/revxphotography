# Uploads the site from this PC to the server and (re)starts it.
# Usage (PowerShell, from the project folder):
#   .\deploy\push.ps1 -Server root@YOUR.SERVER.IP
# First time: also copies the data folder (settings, packages, the demo album and the car frames).
param(
  [Parameter(Mandatory = $true)] [string] $Server,
  [switch] $WithData
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$items = @("src", "views", "public", "deploy", "package.json", "package-lock.json", "Dockerfile", "docker-compose.yml", "Caddyfile", ".dockerignore", "README.md", "ADMIN-GUIDE.md")
if ($WithData) { $items += "data" }

Write-Host "Uploading to ${Server}:/srv/revx ..."
ssh $Server "mkdir -p /srv/revx"
scp -r $items "${Server}:/srv/revx/"

Write-Host "Building and starting the site on the server (first run takes a few minutes) ..."
ssh $Server "cd /srv/revx && chmod +x deploy/*.sh && docker compose up -d --build && docker compose ps"

Write-Host "Done. Open https://<your domain> in a minute (Caddy fetches the HTTPS certificate on first visit)."
