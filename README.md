# Simple VTT

Simple and lightweight VTT project.

## Issues

### Applicative issues

**🐛 Bugs:**
- Map not always loaded while opening a game, settings and tokens either
- Block tokens before walking through a wall or close door or window
- While changing settings, buttons are not updated (enabled/disabled)
- Rename routes :
    - lobby → vtt
    - game → map 

**⭐ Features:**
- Remind what players have seen but is no more in sight (for example with greyscales instead of original colors)
- Allow admin measurement to be shown on players browsers
- Global default settings:
    - Snap to grid
    - Enable/disable chat
    - Player move own tokens
    - Grid square size for measurements conversion (1 grid square equals 5 feet or 1,5 meters)
- Enable/disable lights
- Applicative full screen (hide all the menus, `Esc` for exiting)

### ⚙️ Infrastructure issues

- Reverse proxy (Apache) configuration (supporting websocket)
- Add Postgres DB (and container in docker compose)
- Add S3 storage (and container in docker compose)
- Add Docker .env file with default values
