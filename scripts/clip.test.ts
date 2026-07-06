// scripts/clip.test.ts — unit coverage for the PRIVACY.md clipping algorithm.
// Satisfies verifier V2 (endpoint drop is not observable from public data).
// Uses synthetic tracks + a zone at [0,0]; no real coordinates.

import { test, expect } from "bun:test";
import { clipTrack, clipDistanceMeters, round } from "./clip.ts";
import type { Coord, Zone } from "./clip.ts";

const FAR_ZONE: Zone[] = [{ name: "home", lat: 0, lng: 0 }]; // ~13000 km from the tracks below

function line(n: number, stepDeg: number): Coord[] {
  const out: Coord[] = [];
  for (let i = 0; i < n; i++) out.push([-122 + i * stepDeg, 37]);
  return out;
}

test("V2: unconditionally drops the first and last 5 points", () => {
  const coords = line(30, 0.001); // ~89 m spacing => plenty of length
  const res = clipTrack(coords, FAR_ZONE, "salt", "1001");
  expect(res).not.toBeNull();
  expect(res!.segments.length).toBe(1);
  expect(res!.totalPoints).toBe(20); // 30 - first5 - last5
  // remaining track is exactly original indices 5..24, rounded to 5dp
  expect(res!.segments[0][0]).toEqual([round(coords[5][0], 5), 37]);
  expect(res!.segments[0].at(-1)).toEqual([round(coords[24][0], 5), 37]);
});

test("clipDistance is jittered within [500,1200) and deterministic", () => {
  for (let i = 0; i < 200; i++) {
    const cd = clipDistanceMeters("salt", `id${i}`, "home");
    expect(cd).toBeGreaterThanOrEqual(500);
    expect(cd).toBeLessThan(1200);
  }
  expect(clipDistanceMeters("salt", "1001", "home")).toBe(clipDistanceMeters("salt", "1001", "home"));
  expect(clipDistanceMeters("saltA", "1001", "home")).not.toBe(clipDistanceMeters("saltB", "1001", "home"));
});

test("drops activity when <20 points or <500 m remain", () => {
  expect(clipTrack(line(10, 0.001), FAR_ZONE, "salt", "1")).toBeNull(); // 0 remain after endpoint drop
  expect(clipTrack(line(40, 0.00001), FAR_ZONE, "salt", "1")).toBeNull(); // ~30 pts but <500 m
});

test("a mid-track zone clip splits into a MultiLineString", () => {
  const coords = line(60, 0.001); // ~5.2 km straight line
  const midZone: Zone[] = [{ name: "home", lat: 37, lng: -122 + 30 * 0.001 }]; // zone at the midpoint
  const res = clipTrack(coords, midZone, "salt", "splittest");
  expect(res).not.toBeNull();
  expect(res!.segments.length).toBeGreaterThanOrEqual(2); // split => MultiLineString upstream
});

test("output coordinates carry at most 5 decimals", () => {
  const res = clipTrack(line(30, 0.001), FAR_ZONE, "salt", "1001");
  for (const seg of res!.segments) {
    for (const [lng, lat] of seg) {
      expect(String(lng).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(5);
      expect(String(lat).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(5);
    }
  }
});
