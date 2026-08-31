# UVTT Props Extension

**Status:** extension to the Universal VTT (`.uvtt` / `.dd2vtt`) format
**Implemented by:** Simple VTT (import + export)

The standard UVTT format carries a map image, grid resolution, walls
(`line_of_sight`) and portals (doors/windows). It has **no concept of
independent placeable objects** — trees, furniture, pillars, rubble — that
sit on top of the map and stay editable after import. This extension adds
them.

## Design rationale

- **Grid units, not pixels.** Everything in UVTT is in grid cells
  (`x: 25.5` = 25.5 squares). Props follow the same convention; the
  importer multiplies by `resolution.pixels_per_grid`.
- **Center anchor.** A prop's `x`/`y` is its *center*, so rotation and
  scaling don't move the anchor. (Tokens also use centers here.)
- **Square scaling.** `size` is the side of a square in grid units; the
  source image is stretched to that square regardless of its native
  resolution or aspect ratio. Simple, predictable, and good enough for
  scenery. (Non-uniform scaling can be added later without breaking this.)
- **Purely visual.** Props never block line of sight or movement — those
  are walls/portals. Tools that ignore unknown keys keep working.
- **Two asset carriage variants** (below): sidecar files in a zip bundle
  (preferred, binary-safe) or inline base64 (single-file).

## The `props` key

Optional top-level array. Unknown keys inside each entry are ignored.

```json
{
  "resolution": { "map_size": { "x": 120, "y": 120 }, "pixels_per_grid": 70 },
  "line_of_sight": [ ... ],
  "portals": [ ... ],
  "props": [
    {
      "asset": "assets/prop-0.png",
      "name": "Old oak",
      "x": 25.5,
      "y": 40.25,
      "size": 2,
      "rotation": 45,
      "z": 0,
      "opacity": 1
    }
  ]
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `asset` | string | — | Path of the sidecar image inside the zip bundle (e.g. `"assets/prop-0.png"`). |
| `assetData` | string | — | Alternative to `asset`: the image as a data-URL or raw base64 string, for single-file exports. |
| `name` | string | `"prop"` | Human label (≤ 60 chars). |
| `x`, `y` | number | required | Center of the prop, in **grid units**. |
| `size` | number | `1` | Side of the prop's square, in grid units. |
| `rotation` | number | `0` | Degrees clockwise around the center. |
| `z` | integer | `0` | Draw order; higher paints above lower (ties: file order). |
| `opacity` | number | `1` | 0.05–1. |

Exactly one of `asset` / `assetData` must resolve, or the prop is skipped
at import (with a server log); the rest of the file imports normally.

## The `stairs` key (companion extension)

Level links, exported alongside props for multi-level bundles:

```json
"stairs": [
  {
    "from": { "x": 30, "y": 30 },
    "to_floor_level": 2,
    "to": { "x": 12, "y": 60 },
    "radius": 1
  }
]
```

`from`/`to` are grid-unit centers; `to_floor_level` refers to the level
number (1-based) of the target floor within the same table. A stair whose
`to_floor_level` equals its own floor's level is a **same-floor
teleporter**. On import into a table that lacks the target level, the row
is skipped.

## Bundle layout (zip export)

Exports are zips so images stay binary-safe:

```
my-map-floor1.zip
├── map.uvtt          ← standard fields + props/stairs extensions
├── map.png           ← the floor image ("image" names this file)
└── assets/
    ├── prop-0.png    ← referenced by props[].asset
    └── prop-1.png
```

## Import behavior

- `.zip` bundles: `props[].asset` resolves against `assets/<name>` entries;
  the images are written into the server's shared uploads dir and the prop
  rows reference them by `/uploads/...` path.
- Plain `.uvtt` / `.dd2vtt` with `assetData`: decoded and written the same
  way.
- Plain `.uvtt` referencing sidecar `asset` paths (no zip): those props are
  skipped with a warning — the file alone cannot carry the pixels.
- Portals and walls import exactly as before; a file without `props`/
  `stairs` keys is a perfectly valid classic UVTT map.

## Compatibility

Unknown top-level keys are ignored by other UVTT consumers (the format is
JSON and tools are advised to skip what they don't know), so a bundle
exported here still imports in UniversalVTT-compatible tools — the props
are simply not shown there.
