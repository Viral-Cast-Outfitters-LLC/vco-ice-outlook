# vco-ice-outlook verification (0.1.0)

Run on the box, 14 Nov 2026, America/Denver (MST, UTC-7). Nothing was submitted to cursor.directory or any marketplace. No GitHub repository was created.

## Steps

| Step | Result | Notes |
| --- | --- | --- |
| Verify every preset against NWS `GET /points/{lat},{lon}` | PASS | All 13 candidate lakes returned HTTP 200 and resolved to a Colorado NWS office (BOU or GJT) with `relativeLocation` state `CO`. None were dropped. |
| `plugin.json` vs official schema | PASS | Fetched `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`. Valid with Python `jsonschema` Draft 2020-12 and `ajv-cli --spec=draft2020`. |
| `mcp.json` vs official schema | PASS | Fetched `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`. Valid with the same two validators. |
| Skill frontmatter | PASS | Single-line plain `description` in `skills/ice-outlook/SKILL.md`. No YAML folded `>-` scalars anywhere in the plugin. Description states ice thickness must come from on-site checks or official reports and never to call ice safe. |
| `node --check server.js` | PASS | Exit 0. |
| Unit tests (`node --test test/math.test.js`) | PASS | 9 tests, 0 failed. Covers °C→°F and speed conversions (no inventing a unit), NWS wind-chill formula and domain (0°F / 15 mph = −19°F; null above 50°F or at or below 3 mph), freezing-degree-hours math (including 2-hour period weighting and nulls), trend counts, and NOAA civil sunrise/sunset for Denver on 14 Nov 2026 within 2 minutes of the published 6:43 am / 4:44 pm MST times. |
| Live MCP `initialize` | PASS | NDJSON JSON-RPC. `serverInfo.name=vco-ice-outlook`, `version=0.1.0`. |
| Live MCP `tools/list` | PASS | `get_lake_outlook`, `get_lake_observation`, `compare_lakes`, `list_lakes` (4 tools, under the 5-tool cap). |
| Live MCP `tools/call` get_lake_outlook | PASS | Four presets (Granby, Eleven Mile, Dillon, Blue Mesa) returned `LakeOutlook` objects from the NWS API: 14 compact 12-hour periods with wind and wind chill, overnight lows, daytime highs, `freezingDegreeHoursNext7d`, trend, alerts (none active at prove time), locally computed sunrise/sunset, `outlookUrl`, and `updatedAt` with a −07:00 offset. Missing values are `null`. Disclaimer present. |
| Live MCP `tools/call` get_lake_observation | PASS | Granby resolved to station `KGNB` (Granby-Grand County Airport, 6.5 mi): 47.5°F, wind 0 mph, `windChillF` null (formula does not apply at or below 3 mph), description Clear, `observedAt` 2026-11-14T11:55:00-07:00. Temperature converted from NWS Celsius. |
| Live MCP `tools/call` list_lakes | PASS | 13 presets with coordinates, elevations, counties, and aliases. No live API call required. |
| Live MCP `tools/call` compare_lakes | PASS | Ranked the same four lakes by `freezingDegreeHoursNext7d` (Dillon 708, Eleven Mile 410, Blue Mesa 286, Granby 267). Output is compact and labeled as a weather-based indicator only; ice-safety disclaimer included. In-memory 8-minute cache made the follow-up compare a cache hit. |
| Copy to `~/.cursor/plugins/local/vco-ice-outlook` | PASS | Real directory (not a symlink) at `~/.cursor/plugins/local/vco-ice-outlook`. |
| `@anysphere/cursor-plugins loadUserLocalPlugins` | SKIPPED | Package is not on the public npm registry (same as vco-river-conditions). Grok Bot does not load local plugins. |

## Endpoints used

- `https://api.weather.gov/points/{lat},{lon}`
- `https://api.weather.gov/gridpoints/{office}/{x},{y}/forecast`
- `https://api.weather.gov/gridpoints/{office}/{x},{y}/forecast/hourly`
- `https://api.weather.gov/gridpoints/{office}/{x},{y}/stations`
- `https://api.weather.gov/stations/{id}/observations/latest`
- `https://api.weather.gov/alerts/active?point={lat},{lon}`

User-Agent sent: `vco-ice-outlook/0.1.0 (support@viralcastoutfitters.com)`. HTTP 500 and 503 are retried once. Successful GETs are cached in memory for 8 minutes. No API key was used.

## Presets dropped or changed

No presets were dropped. All 13 requested Colorado ice-fishing lakes resolved to a Colorado grid office:

| Preset | NWS office | Nearest named place |
| --- | --- | --- |
| granby | BOU | Granby |
| eleven-mile | BOU | Guffey |
| antero | BOU | Hartsel |
| spinney | BOU | Hartsel |
| dillon | BOU | Dillon |
| rifle-gap | GJT | Rifle |
| vega | GJT | Collbran |
| taylor-park | GJT | Pitkin |
| blue-mesa | GJT | Gunnison |
| island-lake | GJT | Cedaredge |
| stagecoach | GJT | Oak Creek |
| steamboat-lake | GJT | Steamboat Springs |
| harvey-gap | GJT | Silt |

Coordinates and elevations are from published sources documented in `presets.json` (USGS GNIS/EPQS or topo, Bureau of Reclamation RISE, Wikipedia/CPW for Stagecoach). Elevations are reference values, not a live water-surface reading. Harvey Gap uses the GNIS feature Grass Valley Reservoir (the official name of that impoundment). Island Lake is GNIS Island Reservoir on Grand Mesa.

## Sample outlook (live, 14 Nov 2026, America/Denver)

From `get_lake_outlook` against the NWS API, proved at 1:04 PM MT. Overnight lows are the next three forecast night-time periods. `freezingDegreeHoursNext7d` is a weather-based indicator only. Ice thickness must come from on-site checks or official reports; never call ice safe. NWS has no ice thickness data. Numbers were not invented.

| Lake | Next 3 overnight lows (°F) | freezingDegreeHoursNext7d | Forecast updated at |
| --- | --- | --- | --- |
| Lake Granby | 29, 26, 28 | 267 | 2026-11-14T11:46:17-07:00 (11:46 AM MT) |
| Eleven Mile Reservoir | 24, 21, 24 | 410 | 2026-11-14T11:46:17-07:00 (11:46 AM MT) |
| Dillon Reservoir | 25, 19, 23 | 708 | 2026-11-14T11:46:17-07:00 (11:46 AM MT) |
| Blue Mesa Reservoir | 28, 24, 26 | 286 | 2026-11-14T11:31:59-07:00 (11:31 AM MT) |

At prove time, Dillon’s 7-day trend was 7 consecutive sub-freezing nights and 7 daytime highs above 40°F (a warm spell that can degrade ice), with no days whose high stayed below 32°F. No active NWS alerts were in effect for these four points. Granby’s nearby station observation at 11:55 AM MT was 47.5°F and calm.

## Summary

All required prove steps **PASS**. `@anysphere/cursor-plugins loadUserLocalPlugins` remains **SKIPPED** because the package is not obtainable. Grok Bot does not load local plugins. The plugin was not published.
