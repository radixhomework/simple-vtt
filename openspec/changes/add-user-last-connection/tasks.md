# Tasks: add-user-last-connection

## 1. Backend

- [ ] 1.1 Migration in `db.ts`: add `last_connection TEXT` column to
      `users` (column-existence check pattern)
- [ ] 1.2 Login route: update `last_connection` on successful login
- [ ] 1.3 `GET /users`: include `last_connection` in the response

## 2. Frontend

- [ ] 2.1 Users admin panel: add "Last connection" column
      (formatted timestamp or "never")

## 3. Verification

- [ ] 3.1 Manual: log in as two users, check admin panel column updates
- [ ] 3.2 Regression: export/import roundtrip still passes (users table
      travels inside it)
