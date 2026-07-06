// scripts/clip.ts
//
// Privacy clipping per docs/PRIVACY.md "Clipping algorithm". Pure functions
// (no I/O, no logging) shared by import-strava.ts and clip.test.ts.
//
// PRIVACY: this module never logs; callers must never log coordinates or the
// zones it operates on (T5).

import { createHash } from "node:crypto";

export type Coord = [number, number]; // [lng, lat]
export interface Zone { name: string; lat: number; lng: number }

const R_EARTH = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(a: Coord, b: Coord): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

export function round(n: number, dp: number): number {
  return Number(n.toFixed(dp));
}

// Deterministic uniform value in [0,1) from the salted per-(activity,zone) seed.
// 52 bits keeps the integer within a safe double.
export function uniform01(seedSalt: string, activityId: string, zoneName: string): number {
  const hex = createHash("sha256").update(`${seedSalt}:${activityId}:${zoneName}`).digest("hex");
  return parseInt(hex.slice(0, 13), 16) / 2 ** 52;
}

// clipDistance in [500, 1200) m, deterministic per (activity, zone).
export function clipDistanceMeters(seedSalt: string, activityId: string, zoneName: string): number {
  return 500 + 700 * uniform01(seedSalt, activityId, zoneName);
}

export interface ClipResult {
  segments: Coord[][]; // >=1 segment, each >=2 points; coords rounded to 5dp
  totalPoints: number;
  totalMeters: number;
}

// Apply the full clipping algorithm to one activity's ordered [lng,lat] points.
// Returns null when the activity must be dropped (<20 pts or <500 m remain).
export function clipTrack(
  coords: Coord[],
  zones: Zone[],
  seedSalt: string,
  activityId: string,
): ClipResult | null {
  const n = coords.length;
  const removed = new Array<boolean>(n).fill(false);

  // Steps 1-2: remove points within the jittered clipDistance of any zone.
  for (const zone of zones) {
    const cd = clipDistanceMeters(seedSalt, activityId, zone.name);
    const center: Coord = [zone.lng, zone.lat];
    for (let i = 0; i < n; i++) {
      if (!removed[i] && haversineMeters(coords[i], center) < cd) removed[i] = true;
    }
  }

  // Step 3: unconditionally drop the first and last 5 points of the track.
  for (let i = 0; i < Math.min(5, n); i++) removed[i] = true;
  for (let i = Math.max(0, n - 5); i < n; i++) removed[i] = true;

  // Step 4: contiguous runs of kept points become segments (>=2 pts each);
  // more than one run => the track was split (MultiLineString upstream).
  const rawSegments: Coord[][] = [];
  let run: Coord[] = [];
  for (let i = 0; i < n; i++) {
    if (removed[i]) {
      if (run.length >= 2) rawSegments.push(run);
      run = [];
    } else {
      run.push(coords[i]);
    }
  }
  if (run.length >= 2) rawSegments.push(run);

  // Step 5: drop the activity if too little remains (measured pre-round).
  let totalPoints = 0, totalMeters = 0;
  for (const seg of rawSegments) {
    totalPoints += seg.length;
    for (let i = 1; i < seg.length; i++) totalMeters += haversineMeters(seg[i - 1], seg[i]);
  }
  if (totalPoints < 20 || totalMeters < 500) return null;

  // Step 6: round to 5 decimals as the LAST step.
  const segments = rawSegments.map((seg) => seg.map((c) => [round(c[0], 5), round(c[1], 5)] as Coord));
  return { segments, totalPoints, totalMeters };
}
