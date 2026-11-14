# vco-ice-outlook

Agent Plugin that wraps the free, no-auth [National Weather Service API](https://www.weather.gov/documentation/services-web-api) (`api.weather.gov`) for Viral Cast Outfitters. It returns typed `LakeOutlook` and `LakeObservation` objects for Colorado ice-fishing lakes — not raw NWS JSON.

## Ice safety

**This plugin does not claim ice is safe and does not provide ice thickness.** The National Weather Service has no ice thickness data. `freezingDegreeHoursNext7d` (the sum of `32 - tempF` for each hourly forecast hour below 32°F over the next 7 days) is a weather-based indicator only. Ice thickness must come from on-site checks or official reports; never call ice safe. Viral Cast Outfitters reports ice conditions from real on-site or official reports, not from this model.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_lake_outlook` | 12-hour forecast periods with temperature, wind, wind chill, and precipitation chance; overnight lows; daytime highs; 7-day freezing-degree-hours; trend summary; active NWS alerts; sunrise/sunset. `lake` preset or `lat`/`lon`. `days` is 1–7 and trims periods and trend. |
| `get_lake_observation` | Latest nearby station observation: temperature, wind, wind chill, description. |
| `compare_lakes` | Rank presets by `freezingDegreeHoursNext7d` (weather indicator only). |
| `list_lakes` | Verified Colorado preset list. |

Missing values are returned as `null`. Values are never invented. Celsius observations are converted to Fahrenheit, and wind speeds to mph. Timestamps are ISO 8601 with an America/Denver offset. Wind chill uses the official NWS formula and is omitted (`null`) when it is not defined (temperature above 50°F or wind 3 mph or less).

The trend summary counts days with daytime highs below 32°F, the longest run of consecutive sub-freezing nights in the forecast window, and days with highs above 40°F (a warm spell that can degrade ice). Those counts are weather indicators, not a safety rating.

## Data source

All live weather comes from the National Weather Service API at `https://api.weather.gov`. Typical flow:

1. `GET /points/{lat},{lon}` — forecast office, grid, and linked URLs
2. `GET` the returned `forecast` and `forecastHourly` URLs
3. `GET` the returned `observationStations` URL, then `/stations/{id}/observations/latest`
4. `GET /alerts/active?point={lat},{lon}`

NWS requires a `User-Agent` identifying the application and a contact. This server sends `vco-ice-outlook/0.1.0 (support@viralcastoutfitters.com)`. HTTP 500 and 503 responses are retried once. Successful GETs are cached in memory for 8 minutes to respect NWS rate limits.

Sunrise and sunset are computed locally from the NOAA solar calculator equations (no extra HTTP call, no dependency). They are civil sunrise/sunset (50′ refraction) at the lake coordinates, not an NWS product.

### Attribution

Forecasts, observations, and alerts are from the [U.S. National Weather Service](https://www.weather.gov/), a public service of the United States Government. This information is in the public domain. The NWS, NOAA, and the United States Government may not be held liable for damages resulting from its use. Official forecasts and warnings: [weather.gov](https://www.weather.gov/).

## Configuration

No API key is required. The plugin is zero-dependency Node (18+, `global fetch`) and ships no secrets.

## Run locally

```bash
node server.js
```

`mcp.json` launches that stdio server with `cwd` set to `${PLUGIN_ROOT}`.

Unit tests (conversions, wind chill, freezing-degree-hours, trend, sunrise/sunset):

```bash
node --test test/math.test.js
```

## Presets

Every preset coordinate was verified live against `GET /points/{lat},{lon}` and resolved to a Colorado NWS Weather Forecast Office (Boulder or Grand Junction). See `presets.json` for coordinates, elevations, and sources. Elevations are included only from a verifiable published source (USGS GNIS/EPQS or topo, Bureau of Reclamation, or Colorado Parks and Wildlife). They are reference elevations, not a live water-surface reading.

## License

MIT © Viral Cast Outfitters
