# Deploying Simple VTT

Simple VTT ships as a single Docker image containing the Node.js backend
(REST + WebSocket) and the compiled frontend. State (SQLite database and
uploaded files) lives in a Docker volume.

## 1. Quick start (Docker)

```bash
git clone <your-repo> simple-vtt && cd simple-vtt
docker compose up --build -d
```

The app listens on **http://localhost:8080**. Sign in with the initial admin
account (`admin` / `admin` by default) and change the password right away.

## 2. Configuration

All deployment configuration lives in the **`.env`** file next to
`docker-compose.yml`. The file is not versioned — start from the committed
template and adjust:

```bash
cp .env.example .env
```

Values fall back to sane defaults if the file is missing:

| Variable         | Default                     | Purpose                                |
|------------------|-----------------------------|----------------------------------------|
| `HTTP_PORT`      | `8080`                      | Port published on the host             |
| `JWT_SECRET`     | `change-me-in-production`   | Secret used to sign auth tokens        |
| `ADMIN_USERNAME` | `admin`                     | Bootstrap admin account name           |
| `ADMIN_PASSWORD` | `admin`                     | Bootstrap admin password               |

Notes:

- **Change `JWT_SECRET` for any deployment beyond local testing.** Changing
  it invalidates existing sessions (users simply log in again).
- The admin password can be changed from the UI (Users page → 🔑 or the
  per-user *Reset password* action). The `ADMIN_PASSWORD` env value keeps
  working as a recovery backdoor for the admin account.
- JWT tokens are valid for **12 hours**; clients must re-login afterwards.

## 3. Reverse proxy (Apache)

An example VirtualHost is provided in
[`deploy/apache-simple-vtt.conf`](deploy/apache-simple-vtt.conf). It
terminates **TLS on :443**, **redirects :80 to HTTPS** (leaving ACME
challenges through for certbot) and proxies plain HTTP (SPA, REST API,
uploaded files) **and** the WebSocket endpoint (`/ws`) used for live table
updates:

```bash
sudo cp deploy/apache-simple-vtt.conf /etc/apache2/sites-available/simple-vtt.conf
sudo a2enmod ssl proxy proxy_http proxy_wstunnel rewrite headers
sudo a2ensite simple-vtt
sudo apachectl configtest && sudo systemctl reload apache2
```

Point `SSLCertificateFile`/`SSLCertificateKeyFile` at your certificates —
`sudo certbot --apache -d vtt.example.com` issues them for you. WebSocket
upgrade handling is the part most configurations get wrong; the provided
file shows the required `RewriteCond %{HTTP:Upgrade}` + `ProxyPass /ws
ws://…` pattern.

## 4. Updates

```bash
git pull
docker compose up --build -d
```

Database schema changes are applied automatically on startup (SQLite
migrations). Data lives in the `vtt-data` volume and survives rebuilds.

## 5. Backups

Everything persistent is in the `vtt-data` volume:

```bash
docker run --rm -v simple-vtt_vtt-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/vtt-backup-$(date +%F).tar.gz -C /data .
```

Restore by extracting the archive back into a fresh `vtt-data` volume (stop
the app first).

## 6. Running without Docker (development)

```bash
cd backend && npm install && npm run dev        # API on :8080
cd frontend && npm install && npm run dev       # Vite dev server on :5173
```

The Vite dev server proxies `/api`, `/ws` and `/uploads` to the backend.
Environment variables for the backend: `PORT`, `DB_PATH`, `UPLOADS_DIR`,
`STATIC_DIR`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`.
