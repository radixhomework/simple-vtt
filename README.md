# RHW Simple VTT

Simple and lightweight VTT project.

- [Deployment guide](DEPLOY.md) — Docker, configuration, Apache reverse proxy (HTTPS + WebSocket)
- [Admin guide](docs/ADMIN_GUIDE.md) · [Player guide](docs/PLAYER_GUIDE.md)

## Issues

### Applicative issues

**🐛 Bugs:**
- [x] Map not always loaded while opening a game, settings and tokens either
- [x] Block tokens before walking through a wall or close door or window
- [x] While changing settings, buttons are not updated (enabled/disabled)
- [x] Rename routes :
    - lobby → vtt
    - game → map 

**⭐ Features:**
- [x] Remind what players have seen but is no more in sight (for example with greyscales instead of original colors)
- [x] Allow admin measurement to be shown on players browsers
- [x] Global default settings:
    - Snap to grid
    - Enable/disable chat
    - Player move own tokens
    - Grid square size for measurements conversion (1 grid square equals 5 feet or 1,5 meters)
- Enable/disable lights
- [x] Applicative full screen (hide all the menus, `Esc` for exiting)
- [x] Add apple pencil support
- [x] Add mobile devices support in general
- [x] Support music playing (managed by admin, and diffused in all browsers)
- [x] Shared asset library for token images and music (content-deduplicated)
- [x] Users can change their own password

### ⚙️ Infrastructure issues

- [x] Reverse proxy (Apache) configuration (supporting websocket) — see `deploy/apache-simple-vtt.conf`
- Add Postgres DB (and container in docker compose)
- Add S3 storage (and container in docker compose)
- [x] Add Docker .env file with default values
- [x] Deployment documentation — see `DEPLOY.md`
