# Wondering Location Design Rules

## Product Scope

- Android app is an administrator-owned location sharing app.
- Web app is an administrator dashboard for current position and movement trace.
- `wondering.kr` is the public read-only location viewer.
- `admin.wondering.kr` is the administrator surface for PIN login, viewer settings, and upload-token rotation.
- Android keeps raw GPS upload explicit through the web sharing switch.
- Transport mode classification is out of scope for the first version.

## Battery Rules

- Do not increase GPS frequency only for prettier web rendering.
- Default upload interval is 60 seconds.
- Allowed upload intervals are 5 seconds, 10 seconds, 15 seconds, 60 seconds, 5 minutes, and a clamped custom value.
- Prefer balanced power accuracy for 60 seconds and longer intervals.
- Failed uploads must not retry in a tight loop.

## Data Rules

- Server stores raw Android records append-only in `web/data/locations.jsonl`.
- Android must send a `sharing_off` event when location sharing is intentionally disabled.
- `sharing_off` is a route break marker and must not be stored as a GPS coordinate.
- Display route geometry is derived at read/render time only.
- Do not write simplified, interpolated, or smoothed points back to storage.
- API responses may add `raw_status`; stored raw records remain unchanged.
- Public API reads may power the read-only viewer.
- `LOCATION_SHARE_TOKEN` or the rotated stored token must protect uploads and administrator mutations.
- Do not expose token entry, token rotation, or admin settings on the public viewer host.
- The authenticated admin page may show the active upload token so the administrator can copy it into the Android app.
- Admin controls must use short helper text when a section name is ambiguous.
- Administrator access uses a server-side PIN session; do not use the Android upload token as the admin login credential.
- Administrator token generation must use browser cryptographic randomness and must not activate until the admin rotates the token.

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
- Public viewer mode must not show the floating map status card.
- Public viewer mode may show one compact current-location map control.
- Mobile public viewer HUD must stay compact and should not consume more vertical space than needed for key readings.
- Administrator controls must appear only on the admin host or local admin test mode after PIN login.
- Admin controls should be a large separated workspace; keep the live viewer smaller in admin mode.
- Last updated time, current coordinate, distance, and total public viewer watch time must be visible.
- Do not show a separate movement-history list in the dashboard.
- Keep raw point details in API data or developer tooling, not in the main UI.
- Use local Wanted Sans from `web/public/fonts/WantedSansVariable.woff2`.
- Prefer a single operational HUD over stacked cards.
- Keep the HUD shallow, horizontal on desktop, and bottom-sheet-like on mobile.
- Use a 3D navigation-map visual direction backed by MapLibre GL.
- The base palette must be warm off-white, black, restrained gray, and one functional blue route accent.
- Recolor the base map into a bright miniature-map operational style: off-white land, cyan water, white roads, pale gray-green road casings, and restrained labels.
- Use restrained map color diversity for geographic readability: cyan water, green parks/woodland, warm residential areas, warm arterial roads, and muted rail/transit lines.
- 3D buildings must support depth without becoming decorative; use light building faces with subtle gray-green shadows and no heavy base outlines.
- Use pitch, bearing, and building extrusion to create depth.
- Use strong operational typography for last updated time, coordinate, distance, and viewer watch time.
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
- Default server URL is `https://wondering.kr`.
- Do not start sharing without explicit user action.
