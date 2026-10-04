## Purpose

Make account activity visible to administrators: record when each
account last successfully logged in and show it in the admin Users
panel, so stale or abandoned accounts are identifiable at a glance.

## Requirements

### Requirement: Last connection recording
The system SHALL record a `last_connection` timestamp for every user account,
updated on each successful login, stored in the `users` table as an ISO 8601
string, and reported in the admin users list API.

#### Scenario: First successful login
- **WHEN** a user account that has never logged in completes a successful
  login
- **THEN** the account's `last_connection` is set to the login time

#### Scenario: Subsequent successful login
- **WHEN** a user logs in again after a previous connection
- **THEN** `last_connection` is updated to the new login time

#### Scenario: Failed login does not update
- **WHEN** a login attempt with an existing username fails authentication
- **THEN** that account's `last_connection` is left unchanged

### Requirement: Last connection visibility in the admin panel
The admin users list SHALL display a "Last connection" column for every
account, showing the recorded timestamp (formatted for the locale) or
"never" for accounts without any recorded connection.

#### Scenario: Admin views the users table
- **WHEN** an admin opens the Users admin panel
- **THEN** each account row shows the account's last connection time, or
  "never" for accounts that have never logged in
