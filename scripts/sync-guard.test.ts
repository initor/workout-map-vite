// scripts/sync-guard.test.ts — the additive-invariant guard (M8).
// A Hammerhead corpus FIT that collides (same start time) with an already-
// published export ride but carries DIFFERENT geometry must classify MUTATING,
// so a real `sync:rides` aborts and restores. A non-colliding ride is ADDITIVE.
// Synthetic tracks + a zone far away; no real coordinates.

import { test, expect } from "bun:test";
import { dedupeRides, type Ride } from "./import-strava.ts";
import { classify } from "./geometry-diff.ts";
import { clipTrack } from "./clip.ts";
import type { Coord, Zone } from "./clip.ts";

const ZONES: Zone[] = [{ name: "home", lat: 0, lng: 0 }]; // ~13000 km from the tracks
const SALT = "salt";
const T = 1_700_000_000;

function line(n: number, stepDeg: number): Coord[] {
  const out: Coord[] = [];
  for (let i = 0; i < n; i++) out.push([-122 + i * stepDeg, 37]);
  return out;
}
// Serialize a ride's clipped geometry exactly as the importer / geomById would.
function geom(coords: Coord[], startEpoch: number): string {
  const c = clipTrack(coords, ZONES, SALT, startEpoch);
  if (!c) return "null";
  const g = c.segments.length === 1
    ? { type: "LineString", coordinates: c.segments[0] }
    : { type: "MultiLineString", coordinates: c.segments };
  return JSON.stringify(g);
}
function ride(id: string, source: "export" | "hammerhead", coords: Coord[], startEpoch: number): Ride {
  return { id, startEpochSeconds: startEpoch, coords, source, name: "", type: "Ride", date: "2023-11-14", year: 2023 };
}

test("colliding Hammerhead FIT with different geometry => dedup prefers HH => MUTATING (sync aborts)", () => {
  const exportCoords = line(30, 0.001);
  const hammerheadCoords = line(30, 0.0012); // same ride (start time), different track
  const published = new Map([["1001", geom(exportCoords, T)]]);
  expect(published.get("1001")).not.toBe("null"); // sanity: survives clipping

  const merged = dedupeRides([ride("1001", "export", exportCoords, T)], [ride("hh.1", "hammerhead", hammerheadCoords, T)], 60);
  const collided = merged.find((r) => r.id === "1001")!;
  expect(merged.length).toBe(1);                     // deduped, not duplicated
  expect(collided.coords).toEqual(hammerheadCoords); // geometry re-sourced to Hammerhead

  const after = new Map([["1001", geom(collided.coords, collided.startEpochSeconds)]]);
  const cls = classify(published, after);
  expect(cls.mutating).toBe(true);
  expect(cls.changed).toContain("1001");
});

test("Hammerhead-only ride (no collision) => ADDITIVE (sync proceeds)", () => {
  const exportCoords = line(30, 0.001);
  const newRideCoords = line(30, 0.0012);
  const published = new Map([["1001", geom(exportCoords, T)]]);

  const merged = dedupeRides([ride("1001", "export", exportCoords, T)], [ride("hh.9", "hammerhead", newRideCoords, T + 10_000)], 60);
  expect(merged.length).toBe(2); // new ride added, not merged

  const after = new Map(merged.map((r) => [r.id, geom(r.coords, r.startEpochSeconds)] as const));
  const cls = classify(published, after);
  expect(cls.mutating).toBe(false);
  expect(cls.added).toContain("hh.9");
  expect(cls.changed.length).toBe(0);
});
