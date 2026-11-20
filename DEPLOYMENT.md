# Oracle VPS test deployment

- Browser: http://192.168.0.68:8088/finance-dashboard/
- Health: http://192.168.0.68:8088/health
- Snapshot: http://192.168.0.68:8088/api/v1/market/snapshot

The Steam Deck must be awake and on the same LAN as the browser device.
The browser connects to the Steam Deck, which forwards requests over SSH to Oracle.
Oracle nginx listens on 127.0.0.1:8080 for this tunnel.
The API listens on 127.0.0.1:3000 and runs as finance-dashboard-api.service.
API runtime: /opt/finance-dashboard/vps-api
Original deployment copies: /home/rocky/apps/finance-dashboard/
Web files: /var/www/finance-dashboard/
Nginx configuration: /etc/nginx/conf.d/finance-dashboard.conf

## Reconnect

On the Steam Deck, launch the desktop shortcut "Finance Dashboard", or run:

    ~/.local/bin/finance-dashboard-connect --no-open

Inside codex-dev Ubuntu, run:

    distrobox-host-exec /home/deck/.local/bin/finance-dashboard-connect --no-open

If the prior SSH session has ended, the Oracle SSH key passphrase is requested.
The LAN IP can change when Wi-Fi or DHCP changes.

## Current limitations

The Vite development server can proxy snapshot and index history requests through the SSH tunnel. Run `VITE_DATA_MODE=api npm run dev` from the frontend project.
GitHub Pages builds in API mode and sends browser requests to `https://winow.duckdns.org`. The public API must allow the `https://winow23v.github.io` origin for both snapshot and history. See [README.md](README.md) for the build settings.
All financial data is DEMO. Supabase login/sync is not implemented.
