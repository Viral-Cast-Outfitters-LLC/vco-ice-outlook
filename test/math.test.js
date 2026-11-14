"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("../server.js");

test("cToF converts known points", () => {
  assert.equal(cToF(0), 32);
  assert.equal(cToF(100), 212);
  assert.equal(cToF(-40), -40);
  assert.equal(cToF(10), 50);
  assert.equal(cToF(8.6), 47.5);
});

test("toTemperatureF respects unit and does not invent", () => {
  assert.equal(toTemperatureF(8.6, "wmoUnit:degC"), 47.5);
  assert.equal(toTemperatureF(45, "F"), 45);
  assert.equal(toTemperatureF(45, "degF"), 45);
  assert.equal(toTemperatureF(273.15, "K"), 32);
  assert.equal(toTemperatureF(null, "degC"), null);
  assert.equal(toTemperatureF(10, null), null);
  assert.equal(toTemperatureF(10, ""), null);
});

test("speed conversions to mph", () => {
  assert.equal(kmhToMph(16.09344), 10);
  assert.equal(msToMph(4.4704), 10);
  assert.equal(toSpeedMph(16.09344, "wmoUnit:km_h-1"), 10);
  assert.equal(toSpeedMph(10, "wmoUnit:mi_h-1"), 10);
  assert.equal(toSpeedMph(10, "mph"), 10);
  assert.equal(toSpeedMph(null, "km_h-1"), null);
  assert.equal(toSpeedMph(10, null), null);
});

test("parseWindMph reads NWS forecast strings", () => {
  assert.equal(parseWindMph("5 mph"), 5);
  assert.equal(parseWindMph("3 mph"), 3);
  assert.equal(parseWindMph("5 to 15 mph"), 10);
  assert.equal(parseWindMph("calm"), 0);
  assert.equal(parseWindMph(12), 12);
  assert.equal(parseWindMph(null), null);
  assert.equal(parseWindMph(""), null);
  assert.equal(parseWindMph("variable"), null);
});

test("windChillF uses the official NWS formula and domain", () => {
  // NWS: 0°F and 15 mph is -19°F. https://www.weather.gov/safety/cold-wind-chill-chart
  assert.equal(windChillF(0, 15), -19);
  assert.equal(windChillF(32, 10), 24);
  assert.equal(windChillF(51, 20), null);
  assert.equal(windChillF(20, 3), null);
  assert.equal(windChillF(20, 0), null);
  assert.equal(windChillF(null, 15), null);
  assert.equal(windChillF(0, null), null);
});

test("freezingDegreeHours sums only hours below 32°F", () => {
  assert.equal(freezingDegreeHours([30, 30, 30]), 6);
  assert.equal(freezingDegreeHours([32, 33, 20]), 12);
  assert.equal(freezingDegreeHours([32, 40, 45]), 0);
  assert.equal(freezingDegreeHours([null, 20]), 12);
  assert.equal(freezingDegreeHours([]), null);
  assert.equal(freezingDegreeHours([null, null]), null);
  assert.equal(
    freezingDegreeHours([
      { tempF: 20, start: "2026-11-14T00:00:00-07:00", end: "2026-11-14T02:00:00-07:00" },
    ]),
    24
  );
  assert.equal(
    freezingDegreeHours([{ tempF: 28 }, { tempF: 30 }, { tempF: 33 }]),
    6
  );
});

test("computeTrend counts freeze days, streaks, and warm spells", () => {
  const trend = computeTrend([28, 25, 31, 33, 20, 18], [35, 30, 28, 45, 22, 41]);
  assert.equal(trend.daysWithHighsBelow32F, 3);
  assert.equal(trend.warmSpellHighsAbove40F, 2);
  assert.equal(trend.subFreezingNights, 5);
  assert.equal(trend.consecutiveSubFreezingNights, 3);
  assert.match(trend.note, /never call ice safe/i);
  const broken = computeTrend([20, null, 20, 20], [30]);
  assert.equal(broken.consecutiveSubFreezingNights, 2);
  assert.equal(broken.subFreezingNights, 3);
});

test("sunTimesForLocalDate matches published Denver civil times on 14 Nov 2026", () => {
  // timeanddate.com Denver (39.7392 N, 104.9847 W): sunrise 6:43 am, sunset 4:44 pm MST.
  const r = sunTimesForLocalDate(39.7392, -104.9847, 2026, 11, 14);
  assert.equal(r.date, "2026-11-14");
  assert.ok(r.sunrise && r.sunrise.startsWith("2026-11-14T06:"));
  assert.ok(r.sunset && r.sunset.startsWith("2026-11-14T16:"));
  assert.ok(r.sunrise.endsWith("-07:00"));
  assert.ok(r.sunset.endsWith("-07:00"));
  const mins = (iso) => {
    const t = iso.slice(11, 19).split(":").map(Number);
    return t[0] * 60 + t[1] + t[2] / 60;
  };
  // Allow 2 minutes versus the published clock times (6:43 and 16:44).
  assert.ok(Math.abs(mins(r.sunrise) - (6 * 60 + 43)) <= 2, r.sunrise);
  assert.ok(Math.abs(mins(r.sunset) - (16 * 60 + 44)) <= 2, r.sunset);
  assert.ok(mins(r.sunset) > mins(r.sunrise));
});

test("June days are longer than mid-November at the same Denver point", () => {
  const nov = sunTimesForLocalDate(39.7392, -104.9847, 2026, 11, 14);
  const jun = sunTimesForLocalDate(39.7392, -104.9847, 2026, 6, 21);
  const span = (r) => Date.parse(r.sunset) - Date.parse(r.sunrise);
  assert.ok(span(jun) > span(nov));
});
