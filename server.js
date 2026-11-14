#!/usr/bin/env node
"use strict";

/**
 * Zero-dependency stdio MCP server for vco-ice-outlook.
 * JSON-RPC 2.0 over newline-delimited stdin/stdout, with Content-Length
 * (MCP stdio) framing also supported. Logs go to stderr only.
 *
 * Data source: National Weather Service API (api.weather.gov), no auth.
 * User-Agent is required by NWS. This plugin never reports ice thickness
 * and must never be used to call ice safe.
 */

const fs = require("fs");
const path = require("path");

const VERSION = "0.1.0";
const SERVER_NAME = "vco-ice-outlook";
const PROTOCOL_VERSION = "2024-11-05";
const UA = `vco-ice-outlook/${VERSION} (support@viralcastoutfitters.com)`;
const NWS_BASE = "https://api.weather.gov";
const DENVER_TZ = "America/Denver";
const CACHE_TTL_MS = 8 * 60 * 1000;
const ICE_DISCLAIMER =
  "Ice thickness must come from on-site checks or official reports; never call ice safe. freezingDegreeHoursNext7d is a weather-based indicator only. NWS has no ice thickness data.";
const COLORADO_OFFICES = new Set(["BOU", "GJT", "PUB", "CYS", "GLD"]);

const PRESETS = loadPresets();

const responseCache = new Map();
let framing = "ndjson";

function loadPresets() {
  const file = path.join(__dirname, "presets.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function log(...args) {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

function userError(message) {
  const err = new Error(message);
  err.user = true;
  return err;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseIso(t) {
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function unitNorm(unit) {
  return String(unit || "")
    .replace(/wmoUnit:/gi, "")
    .replace(/[_-\s]+/g, "")
    .toLowerCase();
}

function cToF(c) {
  return Math.round((Number(c) * 9 / 5 + 32) * 10) / 10;
}

function kmhToMph(kmh) {
  return Math.round(Number(kmh) * 0.621371192 * 10) / 10;
}

function msToMph(ms) {
  return Math.round(Number(ms) * 2.23693629 * 10) / 10;
}

function knotsToMph(kt) {
  return Math.round(Number(kt) * 1.15077945 * 10) / 10;
}

function toTemperatureF(value, unit) {
  const v = parseNumber(value);
  if (v == null) return null;
  const u = unitNorm(unit);
  if (!u || u === "degf" || u === "f" || u === "fahrenheit" || u.includes("fahrenheit")) {
    if (!u) return null;
    return Math.round(v * 10) / 10;
  }
  if (u === "degc" || u === "c" || u === "celsius" || u.includes("celsius")) return cToF(v);
  if (u === "k" || u === "kelvin") return cToF(v - 273.15);
  return null;
}

function toSpeedMph(value, unit) {
  const v = parseNumber(value);
  if (v == null) return null;
  const u = unitNorm(unit);
  if (!u || u === "mih1" || u === "mph" || u === "mih" || u.includes("miles")) {
    if (!u) return null;
    return Math.round(v * 10) / 10;
  }
  if (u === "kmh1" || u === "kmh" || u === "kph" || u.includes("kilomet")) return kmhToMph(v);
  if (u === "ms1" || u === "ms" || u === "mps" || u.includes("meter")) return msToMph(v);
  if (u === "kt" || u === "kn" || u === "knot" || u === "knots") return knotsToMph(v);
  return null;
}

function parseWindMph(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 10) / 10 : null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;
  if (s === "calm") return 0;
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;
  let mph = nums.length === 1 ? nums[0] : (nums[0] + nums[1]) / 2;
  if (/\bkt\b|\bkts\b|\bknot/.test(s)) mph = knotsToMph(mph);
  else if (/\bkm/.test(s)) mph = kmhToMph(mph);
  else if (/\bm\/s\b|\bmps\b/.test(s)) mph = msToMph(mph);
  else mph = Math.round(mph * 10) / 10;
  return Number.isFinite(mph) ? mph : null;
}

/**
 * Official NWS Wind Chill Temperature, °F.
 * Defined only for air temperature at or below 50°F and wind speed above 3 mph.
 * https://www.weather.gov/safety/cold-wind-chill-chart
 */
function windChillF(tempF, windMph) {
  const t = parseNumber(tempF);
  const w = parseNumber(windMph);
  if (t == null || w == null) return null;
  if (t > 50 || w <= 3) return null;
  const v = Math.pow(w, 0.16);
  const wc = 35.74 + 0.6215 * t - 35.75 * v + 0.4275 * t * v;
  if (!Number.isFinite(wc)) return null;
  return Math.round(wc);
}

/**
 * Sum of (32 - tempF) for each hourly period below 32°F, weighted by period
 * length in hours when start/end are present. Missing temps are skipped, not
 * invented. Returns null when no numeric hourly temperatures exist; 0 when
 * temperatures exist but none are below freezing.
 */
function freezingDegreeHours(hourly) {
  let any = false;
  let sum = 0;
  for (const row of hourly || []) {
    const t = parseNumber(row && Object.prototype.hasOwnProperty.call(row, "tempF") ? row.tempF : row);
    if (t == null) continue;
    any = true;
    if (t >= 32) continue;
    let hours = 1;
    if (row && row.start && row.end) {
      const a = parseIso(row.start);
      const b = parseIso(row.end);
      if (a != null && b != null && b > a) hours = (b - a) / 3600000;
    }
    sum += (32 - t) * hours;
  }
  if (!any) return null;
  return Math.round(sum * 10) / 10;
}

function computeTrend(overnightLowsF, daytimeHighsF) {
  const lows = (overnightLowsF || []).map(parseNumber);
  const highs = (daytimeHighsF || []).map(parseNumber);
  let daysWithHighsBelow32F = 0;
  let warmSpellHighsAbove40F = 0;
  for (const h of highs) {
    if (h == null) continue;
    if (h < 32) daysWithHighsBelow32F += 1;
    if (h > 40) warmSpellHighsAbove40F += 1;
  }
  let subFreezingNights = 0;
  let consecutiveSubFreezingNights = 0;
  let run = 0;
  for (const low of lows) {
    if (low == null) {
      run = 0;
      continue;
    }
    if (low < 32) {
      subFreezingNights += 1;
      run += 1;
      if (run > consecutiveSubFreezingNights) consecutiveSubFreezingNights = run;
    } else {
      run = 0;
    }
  }
  return {
    daysWithHighsBelow32F,
    consecutiveSubFreezingNights,
    subFreezingNights,
    warmSpellHighsAbove40F,
    note: "Highs above 40°F can degrade ice. These figures are weather-based indicators only. Ice thickness must come from on-site checks or official reports; never call ice safe.",
  };
}

function toDenverIso(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second
  );
  const offsetMin = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${oh}:${om}`;
}

function denverOffsetMinutes(date) {
  const iso = toDenverIso(date);
  if (!iso) return null;
  const m = iso.match(/([+-])(\d{2}):(\d{2})$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function localDateParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day };
}

function formatLocalDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function sinDeg(d) {
  return Math.sin((d * Math.PI) / 180);
}
function cosDeg(d) {
  return Math.cos((d * Math.PI) / 180);
}
function tanDeg(d) {
  return Math.tan((d * Math.PI) / 180);
}

/**
 * Civil sunrise/sunset from the NOAA Solar Calculator equations
 * (https://gml.noaa.gov/grad/solcalc/). Longitude is east-positive.
 * Times are returned as America/Denver ISO strings, or null if the sun
 * does not rise or set. Official zenith is 90°50′ (refraction).
 */
function sunTimesForLocalDate(lat, lon, year, month, day) {
  const latN = parseNumber(lat);
  const lonN = parseNumber(lon);
  if (latN == null || lonN == null) return { date: formatLocalDate(year, month, day), sunrise: null, sunset: null };
  const noonGuess = new Date(Date.UTC(year, month - 1, day, 19, 0, 0));
  const offMin = denverOffsetMinutes(noonGuess);
  const tzHours = (offMin == null ? -7 * 60 : offMin) / 60;

  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const localNoonUtcHours = 12 - tzHours;
  const jd =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    B -
    1524.5 +
    localNoonUtcHours / 24;
  const t = (jd - 2451545.0) / 36525;
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const C =
    sinDeg(M) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    sinDeg(2 * M) * (0.019993 - 0.000101 * t) +
    sinDeg(3 * M) * 0.000289;
  const sunTrueLong = L0 + C;
  const omega = 125.04 - 1934.136 * t;
  const sunApparentLong = sunTrueLong - 0.00569 - 0.00478 * sinDeg(omega);
  const obliqSec = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const obliq = 23 + (26 + obliqSec / 60) / 60;
  const obliqCorr = obliq + 0.00256 * cosDeg(omega);
  const decl = (Math.asin(sinDeg(obliqCorr) * sinDeg(sunApparentLong)) * 180) / Math.PI;
  const y2 = Math.pow(tanDeg(obliqCorr / 2), 2);
  const eqTime =
    4 *
    ((y2 * sinDeg(2 * L0) -
      2 * e * sinDeg(M) +
      4 * e * y2 * sinDeg(M) * cosDeg(2 * L0) -
      0.5 * y2 * y2 * sinDeg(4 * L0) -
      1.25 * e * e * sinDeg(2 * M)) *
      (180 / Math.PI));

  const zenith = 90.833;
  const arg = cosDeg(zenith) / (cosDeg(latN) * cosDeg(decl)) - tanDeg(latN) * tanDeg(decl);
  const date = formatLocalDate(year, month, day);
  if (arg < -1 || arg > 1 || !Number.isFinite(arg)) {
    return { date, sunrise: null, sunset: null };
  }
  const ha = (Math.acos(Math.min(1, Math.max(-1, arg))) * 180) / Math.PI;
  const solarNoonMin = 720 - 4 * lonN - eqTime + tzHours * 60;
  const sunriseMin = solarNoonMin - 4 * ha;
  const sunsetMin = solarNoonMin + 4 * ha;

  function minutesToIso(mins) {
    if (!Number.isFinite(mins)) return null;
    const utcMin = mins - tzHours * 60;
    const ms = Date.UTC(year, month - 1, day, 0, 0, 0) + utcMin * 60000;
    return toDenverIso(ms);
  }

  return { date, sunrise: minutesToIso(sunriseMin), sunset: minutesToIso(sunsetMin) };
}

function sunWindow(lat, lon, startDate, days) {
  const parts = localDateParts(startDate);
  const out = [];
  const start = Date.UTC(parts.year, parts.month - 1, parts.day);
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86400000);
    out.push(sunTimesForLocalDate(lat, lon, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  }
  return out;
}

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findPreset(token) {
  if (!token) return null;
  const raw = String(token).trim();
  if (PRESETS[raw]) return { key: raw, ...PRESETS[raw] };
  const q = normText(raw);
  if (!q) return null;
  const hits = [];
  for (const [key, p] of Object.entries(PRESETS)) {
    const bag = [key, p.lakeId, p.lakeName, p.county, ...(p.aliases || [])].map(normText);
    if (bag.includes(q) || bag.some((b) => b === q || b.includes(q) || q.includes(b))) {
      hits.push({ key, ...p });
    }
  }
  return hits;
}

function parseLatLon(args) {
  const lat = parseNumber(args && args.lat);
  const lon = parseNumber(args && args.lon);
  if (lat == null && lon == null) return null;
  if (lat == null || lon == null) throw userError("Provide both lat and lon");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw userError("lat must be -90..90 and lon -180..180");
  }
  return { lat, lon };
}

function resolveLake(args) {
  args = args || {};
  const coords = parseLatLon(args);
  const token = args.lake != null ? args.lake : args.preset != null ? args.preset : args.lakeId;
  if (token != null && String(token).trim() !== "") {
    const raw = String(token).trim();
    if (normText(raw) === "all") {
      throw userError('Use compare_lakes or list_lakes for multiple lakes, or pass a single lake preset.');
    }
    const found = findPreset(raw);
    const list = Array.isArray(found) ? found : found ? [found] : [];
    if (!list.length) throw userError(`Unknown lake preset: ${raw}. Call list_lakes for the verified Colorado set, or pass lat and lon.`);
    if (list.length > 1) {
      throw userError(
        `Ambiguous lake "${raw}". Use a preset key: ${list.map((p) => `${p.key} (${p.lakeName})`).join(", ")}`
      );
    }
    const p = list[0];
    return {
      lakeId: p.lakeId,
      lakeName: p.lakeName,
      lat: p.lat,
      lon: p.lon,
      elevationFt: p.elevationFt == null ? null : p.elevationFt,
      preset: p.key,
    };
  }
  if (coords) {
    return {
      lakeId: "custom",
      lakeName: args.name ? String(args.name) : "Custom location",
      lat: coords.lat,
      lon: coords.lon,
      elevationFt: args.elevationFt == null ? null : parseNumber(args.elevationFt),
      preset: null,
    };
  }
  throw userError("Provide lake (a preset key or name) or lat and lon");
}

function clampDays(raw) {
  if (raw == null || raw === "") return 7;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw userError("days must be a number");
  return Math.min(7, Math.max(1, Math.round(n)));
}

function pointUrl(lat, lon) {
  return `${NWS_BASE}/points/${lat},${lon}`;
}

function outlookUrl(lat, lon) {
  return `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`;
}

function alertsUrl(lat, lon) {
  return `${NWS_BASE}/alerts/active?point=${lat},${lon}`;
}

async function nwsFetch(url) {
  const now = Date.now();
  const hit = responseCache.get(url);
  if (hit && now < hit.expires) return hit.body;

  const headers = {
    "User-Agent": UA,
    Accept: "application/geo+json, application/ld+json, application/json",
  };

  async function once() {
    const res = await fetch(url, { headers });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { res, text, body };
  }

  let { res, text, body } = await once();
  if (res.status === 500 || res.status === 503) {
    await delay(500);
    ({ res, text, body } = await once());
  }
  if (!res.ok) {
    const desc = body && (body.detail || body.title || body.description);
    throw userError(
      `NWS request failed (${res.status})${desc ? `: ${desc}` : ""}${!body && text ? `: ${text.slice(0, 200)}` : ""}`
    );
  }
  responseCache.set(url, { expires: Date.now() + CACHE_TTL_MS, body });
  return body;
}

function qv(obj) {
  if (obj == null) return { value: null, unit: null };
  if (typeof obj === "number") return { value: Number.isFinite(obj) ? obj : null, unit: null };
  if (typeof obj !== "object") return { value: parseNumber(obj), unit: null };
  const value = parseNumber(obj.value);
  return { value, unit: obj.unitCode || obj.unit || null };
}

async function getPoint(lat, lon) {
  const body = await nwsFetch(pointUrl(lat, lon));
  const p = (body && body.properties) || {};
  if (!p.forecast || !p.forecastHourly) {
    throw userError(`NWS has no forecast grid for ${lat},${lon}`);
  }
  const cwa = p.cwa || p.gridId || null;
  const rel = ((p.relativeLocation || {}).properties) || {};
  return {
    cwa,
    gridId: p.gridId || null,
    gridX: p.gridX,
    gridY: p.gridY,
    forecast: p.forecast,
    forecastHourly: p.forecastHourly,
    observationStations: p.observationStations || null,
    relativeCity: rel.city || null,
    relativeState: rel.state || null,
    forecastOffice: p.forecastOffice || null,
  };
}

function assertColoradoGrid(point, lake) {
  if (lake && lake.preset) {
    const office = point.cwa || point.gridId;
    const state = point.relativeState;
    if (state && state !== "CO") {
      throw userError(`Preset ${lake.lakeId} did not resolve to a Colorado location (state ${state})`);
    }
    if (office && !COLORADO_OFFICES.has(office)) {
      throw userError(`Preset ${lake.lakeId} did not resolve to a Colorado NWS office (got ${office})`);
    }
  }
}

function periodTempF(period) {
  if (!period) return null;
  if (period.temperature != null && period.temperatureUnit) {
    return toTemperatureF(period.temperature, period.temperatureUnit);
  }
  const q = qv(period.temperature);
  if (q.value != null) return toTemperatureF(q.value, q.unit || period.temperatureUnit || "F");
  return parseNumber(period.temperature);
}

function periodWindMph(period) {
  if (!period) return null;
  if (typeof period.windSpeed === "string" || typeof period.windSpeed === "number") {
    return parseWindMph(period.windSpeed);
  }
  const q = qv(period.windSpeed);
  if (q.value != null) return toSpeedMph(q.value, q.unit) ?? parseWindMph(q.value);
  return null;
}

function periodPrecipPct(period) {
  const q = qv(period && period.probabilityOfPrecipitation);
  if (q.value == null) return null;
  return Math.round(q.value);
}

function compactPeriod(period) {
  const tempF = periodTempF(period);
  const windMph = periodWindMph(period);
  return {
    name: period.name || null,
    start: period.startTime ? toDenverIso(period.startTime) : null,
    end: period.endTime ? toDenverIso(period.endTime) : null,
    tempF,
    isDaytime: typeof period.isDaytime === "boolean" ? period.isDaytime : null,
    windMph,
    windChillF: windChillF(tempF, windMph),
    shortForecast: period.shortForecast || null,
    precipPct: periodPrecipPct(period),
  };
}

function trimPeriodsByDays(periods, days, nowMs) {
  const endMs = nowMs + days * 24 * 60 * 60 * 1000;
  return (periods || []).filter((p) => {
    const start = parseIso(p.startTime || p.start);
    if (start == null) return true;
    return start < endMs;
  });
}

function compactAlert(feature) {
  const p = (feature && feature.properties) || {};
  return {
    event: p.event || null,
    severity: p.severity || null,
    urgency: p.urgency || null,
    headline: p.headline || null,
    onset: p.onset ? toDenverIso(p.onset) : null,
    ends: p.ends ? toDenverIso(p.ends) : p.expires ? toDenverIso(p.expires) : null,
  };
}

async function getLakeOutlook(args) {
  const lake = resolveLake(args || {});
  const days = clampDays(args && args.days);
  const point = await getPoint(lake.lat, lake.lon);
  assertColoradoGrid(point, lake);

  const [forecastBody, hourlyBody, alertsBody] = await Promise.all([
    nwsFetch(point.forecast),
    nwsFetch(point.forecastHourly),
    nwsFetch(alertsUrl(lake.lat, lake.lon)).catch((err) => {
      log("alerts fetch failed", err && err.message ? err.message : err);
      return { _error: err && err.message ? err.message : String(err), features: [] };
    }),
  ]);

  const forecastProps = (forecastBody && forecastBody.properties) || {};
  const hourlyProps = (hourlyBody && hourlyBody.properties) || {};
  const now = Date.now();

  const rawPeriods = trimPeriodsByDays(forecastProps.periods || [], days, now);
  const periods = rawPeriods.map(compactPeriod);
  const overnightLowsF = periods.filter((p) => p.isDaytime === false).map((p) => p.tempF);
  const daytimeHighsF = periods.filter((p) => p.isDaytime === true).map((p) => p.tempF);
  const trend = computeTrend(overnightLowsF, daytimeHighsF);

  const hourlyEnd = now + 7 * 24 * 60 * 60 * 1000;
  const hourlyRows = (hourlyProps.periods || [])
    .filter((p) => {
      const start = parseIso(p.startTime);
      return start == null || (start >= now - 60 * 60 * 1000 && start < hourlyEnd);
    })
    .map((p) => ({
      tempF: periodTempF(p),
      start: p.startTime || null,
      end: p.endTime || null,
    }));
  const fdh = freezingDegreeHours(hourlyRows);

  const alerts = Array.isArray(alertsBody && alertsBody.features)
    ? alertsBody.features.map(compactAlert)
    : [];

  const updatedSource = forecastProps.updateTime || forecastProps.generatedAt || hourlyProps.updateTime;
  const startForSun = new Date();

  return {
    lakeId: lake.lakeId,
    lakeName: lake.lakeName,
    lat: lake.lat,
    lon: lake.lon,
    elevationFt: lake.elevationFt,
    periods,
    overnightLowsF,
    daytimeHighsF,
    freezingDegreeHoursNext7d: fdh,
    trend,
    alerts,
    sun: sunWindow(lake.lat, lake.lon, startForSun, days),
    outlookUrl: outlookUrl(lake.lat, lake.lon),
    updatedAt: updatedSource ? toDenverIso(updatedSource) : toDenverIso(new Date()),
    disclaimer: ICE_DISCLAIMER,
  };
}

function metersToMiles(m) {
  const n = parseNumber(m);
  if (n == null) return null;
  return Math.round((n / 1609.344) * 10) / 10;
}

async function getLakeObservation(args) {
  const lake = resolveLake(args || {});
  const point = await getPoint(lake.lat, lake.lon);
  assertColoradoGrid(point, lake);
  if (!point.observationStations) {
    return {
      lakeId: lake.lakeId,
      stationId: null,
      stationName: null,
      observedAt: null,
      tempF: null,
      windMph: null,
      windChillF: null,
      description: null,
    };
  }
  const stationsBody = await nwsFetch(point.observationStations);
  const features = stationsBody && stationsBody.features ? stationsBody.features : [];
  const tried = [];
  for (const f of features.slice(0, 8)) {
    const props = f.properties || {};
    const stationId = props.stationIdentifier || (f.id && String(f.id).split("/").pop()) || null;
    if (!stationId) continue;
    tried.push(stationId);
    let obsBody = null;
    try {
      obsBody = await nwsFetch(`${NWS_BASE}/stations/${stationId}/observations/latest`);
    } catch (err) {
      log("observation miss", stationId, err && err.message ? err.message : err);
      continue;
    }
    const op = (obsBody && obsBody.properties) || {};
    const tempQ = qv(op.temperature);
    const windQ = qv(op.windSpeed);
    const chillQ = qv(op.windChill);
    const tempF = toTemperatureF(tempQ.value, tempQ.unit);
    const windMph = toSpeedMph(windQ.value, windQ.unit);
    const reportedChill = toTemperatureF(chillQ.value, chillQ.unit);
    const description = op.textDescription || null;
    const observedAt = op.timestamp ? toDenverIso(op.timestamp) : null;
    if (tempF == null && windMph == null && description == null && observedAt == null) continue;
    const dist = qv(props.distance);
    return {
      lakeId: lake.lakeId,
      stationId,
      stationName: props.name || null,
      observedAt,
      tempF,
      windMph,
      windChillF: reportedChill != null ? reportedChill : windChillF(tempF, windMph),
      description,
      stationDistanceMi: dist.value != null ? metersToMiles(toMeters(dist.value, dist.unit)) : null,
    };
  }
  return {
    lakeId: lake.lakeId,
    stationId: null,
    stationName: null,
    observedAt: null,
    tempF: null,
    windMph: null,
    windChillF: null,
    description: null,
  };
}

function toMeters(value, unit) {
  const v = parseNumber(value);
  if (v == null) return null;
  const u = unitNorm(unit);
  if (!u || u === "m" || u === "meter" || u === "meters") return v;
  if (u === "km" || u === "kilometer" || u === "kilometers") return v * 1000;
  if (u === "mi" || u === "mile" || u === "miles") return v * 1609.344;
  if (u === "ft" || u === "foot" || u === "feet") return v * 0.3048;
  return v;
}

function listLakes() {
  return Object.values(PRESETS).map((p) => ({
    lakeId: p.lakeId,
    lakeName: p.lakeName,
    lat: p.lat,
    lon: p.lon,
    elevationFt: p.elevationFt == null ? null : p.elevationFt,
    county: p.county || null,
    aliases: p.aliases || [],
  }));
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

async function compareLakes(args) {
  args = args || {};
  let keys;
  if (Array.isArray(args.lakes) && args.lakes.length) {
    keys = [];
    const seen = new Set();
    for (const token of args.lakes) {
      const found = findPreset(token);
      const list = Array.isArray(found) ? found : found ? [found] : [];
      if (!list.length) throw userError(`Unknown lake preset: ${token}`);
      if (list.length > 1) {
        throw userError(`Ambiguous lake "${token}". Use a preset key: ${list.map((p) => p.key).join(", ")}`);
      }
      if (!seen.has(list[0].key)) {
        seen.add(list[0].key);
        keys.push(list[0].key);
      }
    }
  } else {
    keys = Object.keys(PRESETS);
  }

  const rows = await mapPool(keys, 3, async (key) => {
    try {
      const outlook = await getLakeOutlook({ lake: key, days: 7 });
      return {
        lakeId: outlook.lakeId,
        lakeName: outlook.lakeName,
        elevationFt: outlook.elevationFt,
        freezingDegreeHoursNext7d: outlook.freezingDegreeHoursNext7d,
        nextOvernightLowF: outlook.overnightLowsF.length ? outlook.overnightLowsF[0] : null,
        nextDaytimeHighF: outlook.daytimeHighsF.length ? outlook.daytimeHighsF[0] : null,
        daysWithHighsBelow32F: outlook.trend.daysWithHighsBelow32F,
        consecutiveSubFreezingNights: outlook.trend.consecutiveSubFreezingNights,
        warmSpellHighsAbove40F: outlook.trend.warmSpellHighsAbove40F,
        alertCount: Array.isArray(outlook.alerts) ? outlook.alerts.length : 0,
        updatedAt: outlook.updatedAt,
      };
    } catch (err) {
      return {
        lakeId: PRESETS[key].lakeId,
        lakeName: PRESETS[key].lakeName,
        elevationFt: PRESETS[key].elevationFt,
        freezingDegreeHoursNext7d: null,
        nextOvernightLowF: null,
        nextDaytimeHighF: null,
        daysWithHighsBelow32F: null,
        consecutiveSubFreezingNights: null,
        warmSpellHighsAbove40F: null,
        alertCount: null,
        updatedAt: null,
        error: err && err.message ? err.message : String(err),
      };
    }
  });

  rows.sort((a, b) => {
    const av = a.freezingDegreeHoursNext7d;
    const bv = b.freezingDegreeHoursNext7d;
    if (av == null && bv == null) return (a.lakeName || "").localeCompare(b.lakeName || "");
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  return {
    rankedBy: "freezingDegreeHoursNext7d",
    disclaimer: ICE_DISCLAIMER,
    count: rows.length,
    lakes: rows,
  };
}

const TOOLS = [
  {
    name: "get_lake_outlook",
    description:
      "Forecast outlook for one Colorado ice-fishing lake as a LakeOutlook: lakeId, lakeName, lat, lon, elevationFt, periods [{name,start,end,tempF,isDaytime,windMph,windChillF,shortForecast,precipPct}], overnightLowsF, daytimeHighsF, freezingDegreeHoursNext7d, trend (days with highs below 32°F, consecutive sub-freezing nights, warm-spell highs above 40°F that can degrade ice), alerts, sun (locally computed sunrise/sunset), outlookUrl, updatedAt (ISO with America/Denver offset). Pass lake (preset key or name) or lat and lon. days is 1–7 and trims periods and trend; freezing-degree-hours is a 7-day total. freezingDegreeHoursNext7d is a weather-based indicator only. Ice thickness must come from on-site checks or official reports; never call ice safe. NWS has no ice thickness data. Missing values are null; values are never invented. Data from the National Weather Service API.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lake: {
          type: "string",
          description: "Preset key or name (e.g. granby, Eleven Mile, Rifle Gap)",
        },
        lat: { type: "number", description: "Latitude (use with lon when the lake is not a preset)" },
        lon: { type: "number", description: "Longitude (use with lat when the lake is not a preset)" },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 7,
          description: "Forecast window for periods and trend, 1–7 days. Default 7. Freezing-degree-hours stays a 7-day total.",
        },
      },
    },
  },
  {
    name: "get_lake_observation",
    description:
      "Latest nearby station observation as a LakeObservation: lakeId, stationId, stationName, observedAt, tempF, windMph, windChillF, description. Pass lake (preset key or name) or lat and lon. Uses the closest NWS stations that have a current reading. Missing values are null; never invented. Not ice thickness and not an ice-safety rating. Ice thickness must come from on-site checks or official reports; never call ice safe. Data from the National Weather Service API.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lake: {
          type: "string",
          description: "Preset key or name (e.g. granby, Eleven Mile)",
        },
        lat: { type: "number", description: "Latitude (use with lon when the lake is not a preset)" },
        lon: { type: "number", description: "Longitude (use with lat when the lake is not a preset)" },
      },
    },
  },
  {
    name: "compare_lakes",
    description:
      "Rank Colorado preset lakes by freezingDegreeHoursNext7d (highest first), with compact fields: next overnight low, next daytime high, days with highs below 32°F, consecutive sub-freezing nights, warm-spell highs above 40°F, and active alert count. Optional lakes[] of preset keys or names; default is all verified presets. freezingDegreeHoursNext7d is a weather-based indicator only. Ice thickness must come from on-site checks or official reports; never call ice safe. NWS has no ice thickness data. Data from the National Weather Service API.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lakes: {
          type: "array",
          items: { type: "string" },
          description: "Optional preset keys or names to include. Default is all verified Colorado presets.",
        },
      },
    },
  },
  {
    name: "list_lakes",
    description:
      "List the verified Colorado ice-fishing lake presets (lakeId, lakeName, lat, lon, elevationFt, county, aliases). Coordinates were checked live against the NWS /points API and resolved to a Colorado forecast office. Elevations are from published sources, not a live water-surface reading. This tool does not report ice thickness or ice safety. Ice thickness must come from on-site checks or official reports; never call ice safe.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

const handlers = {
  get_lake_outlook: getLakeOutlook,
  get_lake_observation: getLakeObservation,
  compare_lakes: compareLakes,
  list_lakes: async () => listLakes(),
};

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, code, message, data) {
  const err = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") {
    return fail(msg && "id" in msg ? msg.id : null, -32600, "Invalid Request");
  }
  if (msg.method && String(msg.method).startsWith("notifications/")) {
    return null;
  }
  if (msg.id === undefined || msg.id === null) return null;
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions:
          "Colorado ice-fishing lake weather from the National Weather Service API. Use get_lake_outlook, get_lake_observation, compare_lakes, and list_lakes. freezingDegreeHoursNext7d is a weather-based indicator only. Ice thickness must come from on-site checks or official reports; never call ice safe. Never invent missing values.",
      });
    }
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") return ok(id, { tools: TOOLS });
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      const fn = handlers[name];
      if (!fn) {
        return ok(id, {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        });
      }
      const result = await fn(args);
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    }
    return fail(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (err && err.user) {
      return ok(id, {
        isError: true,
        content: [{ type: "text", text: message }],
      });
    }
    log("internal error", message);
    if (method === "tools/call") {
      return ok(id, {
        isError: true,
        content: [{ type: "text", text: `Tool failed: ${message}` }],
      });
    }
    return fail(id, -32603, message);
  }
}

function writeMessage(obj) {
  if (obj == null) return;
  const body = JSON.stringify(obj);
  if (framing === "lsp") {
    const payload = Buffer.from(body, "utf8");
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    process.stdout.write(payload);
  } else {
    process.stdout.write(body + "\n");
  }
}

function extractLsp(buffer) {
  const messages = [];
  let rest = buffer;
  while (true) {
    const split = rest.search(/\r?\n\r?\n/);
    if (split < 0) break;
    const header = rest.slice(0, split);
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) break;
    const len = Number(m[1]);
    const nl = rest[split] === "\r" ? 4 : 2;
    const start = split + nl;
    const raw = rest.slice(start);
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes < len) break;
    const all = Buffer.from(rest, "utf8");
    const headerBytes = Buffer.byteLength(rest.slice(0, start), "utf8");
    const body = all.subarray(headerBytes, headerBytes + len).toString("utf8");
    rest = all.subarray(headerBytes + len).toString("utf8");
    if (body.trim()) {
      try {
        messages.push(JSON.parse(body));
      } catch (err) {
        messages.push({ _parseError: err.message });
      }
    }
  }
  return { messages, rest };
}

function extractNdjson(buffer) {
  const messages = [];
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch (err) {
      messages.push({ _parseError: err.message, _raw: line });
    }
  }
  return { messages, rest };
}

function detectFraming(buffer) {
  const start = buffer.replace(/^\uFEFF/, "").trimStart();
  if (/^Content-Length:/i.test(start)) return "lsp";
  if (start.startsWith("{")) return "ndjson";
  return null;
}

async function main() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  let detected = false;
  const queue = [];
  let busy = false;
  let ended = false;

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const msg = queue.shift();
        if (msg && msg._parseError) {
          writeMessage(fail(null, -32700, `Parse error: ${msg._parseError}`));
          continue;
        }
        const response = await handleMessage(msg);
        writeMessage(response);
      }
    } finally {
      busy = false;
      if (ended) process.exit(0);
    }
  }

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (!detected) {
      const mode = detectFraming(buffer);
      if (!mode) return;
      framing = mode;
      detected = true;
    }
    const extracted = framing === "lsp" ? extractLsp(buffer) : extractNdjson(buffer);
    buffer = extracted.rest;
    for (const msg of extracted.messages) queue.push(msg);
    drain().catch((err) => log("drain failed", err && err.stack ? err.stack : err));
  });

  process.stdin.on("end", () => {
    if (buffer.trim()) {
      if (!detected) {
        const mode = detectFraming(buffer);
        if (mode) framing = mode;
      }
      try {
        queue.push(JSON.parse(buffer));
      } catch {
        // trailing partial input; ignore on shutdown
      }
      buffer = "";
    }
    ended = true;
    drain().catch((err) => {
      log("drain failed", err && err.stack ? err.stack : err);
      process.exit(1);
    });
  });
}

if (require.main === module) {
  main().catch((err) => {
    log(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  cToF,
  toTemperatureF,
  toSpeedMph,
  kmhToMph,
  msToMph,
  parseWindMph,
  windChillF,
  freezingDegreeHours,
  computeTrend,
  sunTimesForLocalDate,
  toDenverIso,
  parseNumber,
  getLakeOutlook,
  getLakeObservation,
  compareLakes,
  listLakes,
  PRESETS,
  CACHE_TTL_MS,
  ICE_DISCLAIMER,
};
