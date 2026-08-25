# Admin Guide — RHW Simple VTT

This guide covers the **admin** role: the admin console, map-side GM tools
and operational notes. Deployment instructions live in
[`DEPLOY.md`](../DEPLOY.md); the player's view is described in
[`PLAYER_GUIDE.md`](PLAYER_GUIDE.md).

## Signing in

The initial admin account comes from the environment
(`ADMIN_USERNAME` / `ADMIN_PASSWORD`, default `admin`/`admin`). Change the
password from the UI right after the first login. The environment password
always remains valid for the admin account as a recovery backdoor.
Sessions last **12 hours**.

## Admin console (home page)

The console has three pages, plus a version line showing the frontend and
backend versions.

### 🗺 Maps & Tables

- **Create Table** — name + grid size (pixels per square).
- **Import Universal VTT** — drop a `.uvtt` / `.dd2vtt` / `.zip` file: the
  map image, grid, line-of-sight walls and portals (doors/windows) are
  imported automatically.
- **Maps inventory** — every table with its grid size, token and portal
  counts, whether a map image is attached, and Join/Delete actions.

### 👥 Users

- **Add User** — username, initial password, role (`player` or `admin`).
- **Role dropdown** — promote/demote a user (you cannot change your own
  role or delete yourself).
- **Reset password** — set a new password for any user, including other
  admins.
- Players change their own passwords via the 🔑 button (top-right).

### 📦 Assets

A shared, content-deduplicated library: uploading the same file twice
stores it once.

- **Upload Asset** — choose the kind (image for token icons, audio for
  music) and an optional folder; new music joins every table's queue.
- **Folders** — organise assets; move any asset with its Folder dropdown
  (root = no folder). Folders are purely organisational.
- **Delete** — images still used by a token are refused (409); deleting a
  music track removes it from every queue and stops it if playing.

## GM tools on the map

Everything players can do (see the player guide), plus:

### Tokens

- **+ Token** — click the map position where the token appears; then use
  the editor (right sidebar) for name, size, colour, owner, vision.
- **Token editor** — *Has Vision* (punches fog), vision radius, icon
  (choose from the shared image library, upload, or a custom URL), owner.
- **Hide a token** — the 👁/🚫 button in the token list (or the *Hidden
  from players* checkbox) removes the token **and its sight** from every
  player's browser — position included. You keep seeing it, ghosted at 50 %.
- Tokens never cross walls or closed doors, for players and admins alike.

### Fog of war

- **👁 Reveal / 🌑 Erase** tools paint permanent fog holes.
- **Clear Fog** — wipes all manual reveals (the explored greyscale memory
  is per browser session and resets on reload).
- **Fog ✓/✗** — toggles fog on your own screen only.

### Doors & walls

Click a portal (door/window) with the select tool to toggle it open or
closed — closed portals block sight and movement. Static walls come from
the imported UVTT file.

### Measurements

Same tools as players, plus **Share ✓/✗**: when enabled, your measurements
appear live on every browser and stay after you release, until you draw a
new one or press `Esc`.

### Music

Same panel as players (transport, queue, volume), plus clicking a track in
the queue starts it immediately (players can only reorder/transport).

### Doors and windows

- **Door** (copper): closed blocks movement *and* sight; open blocks neither.
- **Window** (rose, with glass ticks): closed blocks movement but players
  still see through it; open blocks neither. Tokens can never cross a closed
  window even when players may open doors.
- Click a portal to open/close it (players too, when allowed).
- **Right-click** a portal for its menu: open/close, convert door ↔ window,
  and **Lock for players** — a locked portal stays admin-only even when the
  global permission is on. Locked portals show 🔒 in their label.
- **Right-click** stairs to change their destination floor or delete them
  (left-click does nothing on stairs). Stairs markers carry no label in the
  players' view.
- UVTT imports mark portals as doors unless the file explicitly declares
  windows.
- In the admin console, each floor has a **Default floor** button in the
  Floors manager — that level is shown when anyone loads the map.

### Full screen

**⛶** hides all menus and takes the browser fullscreen; **Esc** exits.

## Maps and access control

- **Anyone can upload a map** (UVTT import) — the uploader becomes its
  **dm**. Global admins additionally manage every map from the console.
- A map is reached only by its dm and the users they invite (as **player**
  or **dm**) through the map's **👥 Share** button. The map owner cannot
  be removed.
- The map role wins over the global one: an admin invited as player is a
  player on that map; an uninvited admin joining still acts as dm.
- Players move their own tokens and open doors/windows per the map's
  settings and per-portal locks. Dms manage everything (floors, settings,
  fog, stairs, focus).
- Deleting a user removes their memberships; maps they owned are handed
  to another dm, or to the first admin.

## Admin console — ⚙ Settings tab

Installation-wide settings:

- **Uploads**: maximum size per asset file (1–500 MB, map images are not
  concerned)

## Admin console — per-map Settings

Every map in **Maps & Tables** has a **Settings** button opening its own
gameplay and display configuration (applied live to everyone viewing that
map):

- **Gameplay**: chat enabled, players move own tokens only, snap to grid,
  players can open **doors** and **windows** by themselves (two separate
  permissions, on by default)
- **Display**: fog of war, grid, **grid square size + unit (ft/m)** used
  by every measurement tool (e.g. 5 ft or 1.5 m per square)

## Security notes

- Set a strong `JWT_SECRET` in `.env` (see `DEPLOY.md`); rotating it
  invalidates all sessions.
- Hidden tokens are withheld from players at the API level — positions
  cannot be sniffed from devtools.
- Uploads are limited per asset by the admin setting (default 50 MB,
  see **⚙ Settings** in the admin console) and to 150 MB per map import.
- The API is rate-limited (300 req/min; 10 login attempts per 15 min per IP).
