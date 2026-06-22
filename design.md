# Wondering Location Design Rules

## Product Scope

- Android app is an administrator-owned location sharing app.
- Web app is an administrator dashboard for current position and movement trace.
- `wondering.kr` is the public read-only location viewer.
- `admin.wondering.kr` is the administrator surface for token entry, viewer settings, and upload-token rotation.
- Android keeps raw GPS upload explicit through the web sharing switch.
- Transport mode classification is out of scope for the first version.

## Battery Rules

- Do not increase GPS frequency only for prettier web rendering.
- Default upload interval is 60 seconds.
- Allowed upload intervals are 15 seconds, 60 seconds, and 5 minutes.
- Prefer balanced power accuracy for 60 seconds and longer intervals.
- Failed uploads must not retry in a tight loop.

## Data Rules

- Server stores raw Android records append-only in `web/data/locations.jsonl`.
- Display route geometry is derived at read/render time only.
- Do not write simplified, interpolated, or smoothed points back to storage.
- API responses may add `raw_status`; stored raw records remain unchanged.
- Public API reads may power the read-only viewer.
- `LOCATION_SHARE_TOKEN` or the rotated stored token must protect uploads and administrator mutations.
- Do not expose token entry, token rotation, or admin settings on the public viewer host.

## Route Rules

- `raw_status=valid` points define the main visible route.
- `low_accuracy`, `duplicate`, `jump_suspected`, and `time_reversed` points are excluded from the main route.
- Invalid points may be shown only as muted reference points.
- Route drawing uses a two-layer rounded polyline:
  - lower stroke: wide, low-opacity background line
  - upper stroke: narrower, darker route line
- Use Douglas-Peucker simplification to avoid drawing excessive points.
- Use screen-only interpolation and smoothing when useful.
- Break the visible route when valid points are too far apart.
- Web route rendering may use MapLibre GL GeoJSON sources and line/symbol layers.
- 3D building extrusion is display-only and must not alter stored location data.

## Web UI Rules

- The map is the primary work surface.
- Public viewer mode must show only the map, status, and location readings.
- Administrator controls must appear only on the admin host or local admin test mode.
- Last update time, current coordinate, distance, and valid/raw point count must be visible.
- Do not show a separate movement-history list in the dashboard.
- Keep raw point details in API data or developer tooling, not in the main UI.
- Use local Wanted Sans from `web/public/fonts/WantedSansVariable.woff2`.
- Prefer a single operational HUD over stacked cards.
- Keep the HUD shallow, horizontal on desktop, and bottom-sheet-like on mobile.
- Use a 3D navigation-map visual direction backed by MapLibre GL.
- The base palette must be warm off-white, black, restrained gray, and one functional blue route accent.
- Recolor the base map into a bright paper/ink operational style: light land, quiet water, white roads, clearly separated gray casings, restrained labels.
- Use restrained map color diversity for geographic readability: blue water, green parks/woodland, warm residential areas, subtle warm arterial roads, and muted transit lines.
- 3D buildings must support depth without becoming decorative; use light neutral gray extrusion, not saturated or heavy dark color.
- Use pitch, bearing, and building extrusion to create depth.
- Use strong operational typography for last received time, coordinate, and distance.
- Keep the map as the dominant operational surface.
- Do not add decorative glow, ornamental imagery, or unrelated color accents.
- The main route should read as an ink trace; reserve blue for directional/current-location signals and accuracy feedback.
- Map status, controls, labels, and dashboard text stay black/off-white/gray unless status clarity requires otherwise.
- Border radius is 8px or less.
- Do not use marketing sections, floating ornamentation, or decorative illustration layers.
- Current location and previous route must be visually distinct.
- Current marker is a blue circle with a white border, a subtle pulse, and an accuracy circle when available.
- If updates stop, show waiting or age-based status text.

## Android UI Rules

- Keep settings compact and administrator-oriented.
- Expose sharing enabled, server URL, token, and upload interval.
- Do not start sharing without explicit user action.
