---
name: ice-outlook
description: Use for NWS temperature, wind, wind chill, alerts, and a weather-based freezing-degree-hours indicator at Colorado ice-fishing lakes. Ice thickness must come from on-site checks or official reports; never call ice safe.
---

# Ice outlook (VCO)

Call these tools for weather around Colorado ice-fishing lakes: forecasts, nearby station observations, active NWS alerts, and a computed freezing-degree-hours indicator. Do not estimate, interpolate, or invent temperatures, wind, or alerts.

This plugin has **no ice thickness data**. The National Weather Service does not report ice thickness. `freezingDegreeHoursNext7d` and the trend summary are weather-based indicators only. Ice thickness must come from on-site checks or official reports; never call ice safe. Viral Cast Outfitters publishes ice conditions from real reports, not from this model.

## When to call which tool

- **get_lake_outlook** — 12-hour forecast periods (temp, wind, wind chill, precipitation chance), overnight lows, daytime highs, 7-day freezing-degree-hours, trend (days with highs below freezing, consecutive sub-freezing nights, warm spells with highs above 40°F that can degrade ice), active NWS alerts, and locally computed sunrise/sunset. Pass `lake` (a preset key or name such as `granby` or `Eleven Mile`) or `lat` and `lon`. `days` is 1–7 and trims the periods and trend; freezing-degree-hours stays a 7-day total when the hourly forecast covers it.
- **get_lake_observation** — the latest reading from a nearby NWS observation station (temperature, wind, wind chill, text description). Same `lake` or `lat`/`lon` input.
- **compare_lakes** — rank preset lakes by `freezingDegreeHoursNext7d` (highest first). Weather-based indicator only; never treat the ranking as ice safety.
- **list_lakes** — the verified Colorado preset list (coordinates and elevations). No live API call.

## Rules

- Missing values are `null`. Never invent a number, a station reading, or an alert.
- Prefer these tools over recalling “typical” November weather or last year’s ice.
- Temperatures are already in Fahrenheit; wind is in mph; wind chill uses the official NWS formula and is `null` when it does not apply (air temp above 50°F or wind 3 mph or less).
- A warm-spell count (daytime highs above 40°F) means weather that can degrade ice, not that ice is unsafe or safe.
- When you publish numbers, quote `updatedAt` or `observedAt` and say the data are from NWS. Mention the ice-thickness disclaimer whenever freezing-degree-hours or lake ranking could be read as a safety claim.
