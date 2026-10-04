# Tasks: add-user-last-connection

## 1. Backend

- [x] 1.1 Migration in `db.ts`: add `last_connection TEXT` column to
      `users` (column-existence check pattern)
- [x] 1.2 Login route: update `last_connection` on successful login
- [x] 1.3 `GET /users`: include `last_connection` in the response

## 2. Frontend

- [x] 2.1 Users admin panel: add "Last connection" column
      (formatted timestamp or "never")

## 3. Verification

- [x] 3.1 Manual: log in as two users, check admin panel column updates — verified live (first/re-login/failed-login scenarios at API level + Users table in browser: "never" for never-connected, formatted date otherwise)
- [x] 3.2 Regression: export/import roundtrip still passes (users table
      travels inside it)
