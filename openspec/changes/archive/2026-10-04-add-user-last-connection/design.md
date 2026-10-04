# Design: add-user-last-connection

## Context

The `users` table (SQLite) currently holds username, password hash and role.
Logins flow through `routes/auth.ts` (POST /auth/login); the admin Users
panel is rendered by `pages/vtt.ts` from `GET /users`.

## Approach

- **Storage**: one new column `last_connection TEXT` (ISO 8601 UTC string)
  via the standard column-existence migration in `db.ts` — restored older
  backups (pre-column) get the column added automatically on startup.
- **Recording point**: only in the login route handler, after successful
  verification, with an `UPDATE users SET last_connection=? WHERE username=?`.
  Failed attempts and WebSocket connections deliberately do not touch it
  (login-time only, per the spec).
- **API**: `GET /users` (admin) returns `last_connection` alongside the
  existing fields; the model select list is extended.
- **UI**: one new column in the Users table — formatted `YYYY-MM-DD HH:mm`
  (server-local time as stored), `never` for null.
- **Backup compatibility**: `map_members`/users travel inside the asset
  package work already on `main`; a restored pre-column database is covered
  by the migration. No other services read the users table.

## Risks / trade-offs

- Timestamp is server-local (not timezone-aware per client) — consistent
  with the rest of the app; revisit if per-client timezone display is ever
  wanted.
- Multi-instance deployments would race on the UPDATE — single-instance is
  the current and planned deployment shape.
