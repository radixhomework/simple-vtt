# RHW Simple VTT

**RHW Simple VTT** is a simple, lightweight, self-hosted virtual tabletop
for pen-and-paper role-playing games. A Dungeon Master prepares maps
imported from Universal VTT files — with walls, doors, windows and
multiple floors — while players connect from any modern browser, desktop
or tablet (including Apple Pencil support).

## What it does

- **Multi-level maps** — import UVTT/DD2VTT files (or zip bundles) with
  line of sight, doors, windows and stairs between floors; fog of war
  remembers what each level's explorers have seen
- **Tokens** — drag-and-drop miniatures with per-token vision, owners,
  and DM-only hiding; movement is blocked by walls and closed portals
- **Doors & windows** — doors block sight and movement until opened;
  windows let players peek through glass; the DM decides who may open
  what, down to individual portals
- **Music** — a shared, content-deduplicated audio library diffused in
  sync to every connected browser
- **Shared assets** — token images and music organized in folders,
  stored once thanks to content hashing
- **Zero client install** — everything runs in the browser against a
  single small Docker container (Node.js + SQLite)

## Documentation

- [Deployment guide](DEPLOY.md) — Docker, configuration, Apache reverse
  proxy (HTTPS + WebSocket)
- [Admin (DM) guide](docs/ADMIN_GUIDE.md)
- [Player guide](docs/PLAYER_GUIDE.md)
