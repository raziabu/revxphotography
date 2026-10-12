#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Please install it from https://nodejs.org (LTS version) and run this again."
  read -r -p "Press Enter to close"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing (first time only, about a minute)..."
  npm install --no-audit --no-fund
fi
echo
echo "Starting the website at http://localhost:3000"
echo "Admin: http://localhost:3000/admin   (password: see HANDOVER.txt)"
echo "Keep this window open while you use the site. Press Ctrl+C to stop."
echo
(sleep 2 && open http://localhost:3000) &
node src/server.js
