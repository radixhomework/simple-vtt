## Why

Admins currently have no way to see whether — or when — an account was last
used. Stale or abandoned accounts are invisible, and there is no way to tell
an inactive account from one in daily use. Showing the last connection per
user in the Users admin panel makes account hygiene visible at a glance.

## What Changes

- Record a `last_connection` timestamp per user, set on every successful
  login (ISO 8601, stored in the `users` table; new column via migration so
  restored older backups keep working).
- Expose `last_connection` in the admin users list API.
- Display a "Last connection" column in the Users admin panel table
  (formatted date-time; "never" when the account has no connection yet).

## Non-goals

- Session tracking or WebSocket-level connection events — login time only.
- Per-map last-visit tracking.

## Capabilities

- `user-last-connection` (new spec, delta in this change)
