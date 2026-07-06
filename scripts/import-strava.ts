// scripts/import-strava.ts
//
// Strava bulk-export importer, v0 (Milestone M2 — staging only).
//
// Reads ONLY `<dir>/activities.csv` and the track files it references under
// `<dir>/activities/` (PRIVACY.md R3), keeps every activity with a usable GPS
// track (DATA.md include list), and writes deterministic staging artifacts to
// `data/intermediate/staging/`. `type` is carried through from Strava verbatim.
//
// This stage does NO privacy clipping/jitter (that is M3) and does NOT touch
// `public/`. Staging lives under the gitignored `data/` tree.
//
// Usage: bun run import:strava -- --dir data/raw
//        bun scripts/import-strava.ts --dir data/raw

import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { Decoder, Stream } from "@garmin/fitsdk";

const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;
const OUT_DIR = "data/intermediate/staging";
const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

type Coord = [number, number]; // [lng, lat]

interface FitRecord { positionLat?: number; positionLong?: number }
interface FitSession { totalDistance?: number; totalTimerTime?: number }

interface Summary {
  id: string;
  name: string;
  type: string;
  date: string;
  year: number;
  distanceMeters?: number;
  movingTimeSeconds?: number;
  stravaUrl: string;
}

interface Feature {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: { type: "LineString"; coordinates: Coord[] };
}

// --- RFC4180-ish CSV parser: handles quoted fields with commas, embedded
// newlines, and "" escapes (Strava descriptions contain all three). ---
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function parseArgs(argv: string[]): { dir: string } {
  let dir = "data/raw";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") { dir = argv[i + 1] ?? dir; i++; }
  }
  return { dir };
}

// "Jul 4, 2026, 5:47:50 PM" -> { date: "2026-07-04", year: 2026 }.
// Uses the CSV's date components directly (deterministic; no timezone math).
function parseDate(s: string): { date: string; year: number } | null {
  const m = s.match(/^(\w{3}) (\d{1,2}), (\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[1]];
  if (!mm) return null;
  return { date: `${m[3]}-${mm}-${m[2].padStart(2, "0")}`, year: Number(m[3]) };
}

// Round to <=5 decimals with no float noise (Number(toFixed) yields the
// shortest round-trippable value, so JSON.stringify emits <=5 places).
function r5(n: number): number { return Number(n.toFixed(5)); }

function haversineMeters(a: Coord, b: Coord): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function trackLengthMeters(coords: Coord[]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversineMeters(coords[i - 1], coords[i]);
  return d;
}

// Decompress + decode a .fit.gz into a [lng,lat] sequence + session summary.
function parseFit(path: string): { coords: Coord[]; totalDistance?: number; totalTimerTime?: number } {
  const buf = gunzipSync(readFileSync(path));
  const decoder = new Decoder(Stream.fromByteArray(new Uint8Array(buf)));
  const { messages } = decoder.read() as {
    messages: { recordMesgs?: FitRecord[]; sessionMesgs?: FitSession[] };
  };
  const coords: Coord[] = [];
  for (const rec of messages.recordMesgs ?? []) {
    if (rec.positionLat == null || rec.positionLong == null) continue;
    const lat = rec.positionLat * SEMICIRCLE_TO_DEG;
    const lng = rec.positionLong * SEMICIRCLE_TO_DEG;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    coords.push([lng, lat]);
  }
  const session = (messages.sessionMesgs ?? [])[0];
  return { coords, totalDistance: session?.totalDistance, totalTimerTime: session?.totalTimerTime };
}

// One feature per line: compact + git-diff-friendly at the activity grain.
function serializeFeatureCollection(features: Feature[]): string {
  const body = features.map((f) => "    " + JSON.stringify(f)).join(",\n");
  return `{\n  "type": "FeatureCollection",\n  "features": [\n${body}\n  ]\n}\n`;
}

function main(): void {
  const { dir } = parseArgs(process.argv.slice(2));
  const rows = parseCSV(readFileSync(join(dir, "activities.csv"), "utf8"));
  const header = rows[0];
  const col = (name: string) => header.indexOf(name);
  const iId = col("Activity ID"), iDate = col("Activity Date"), iName = col("Activity Name");
  const iType = col("Activity Type"), iFile = col("Filename"), iDist = col("Distance");
  for (const [label, i] of [["Activity ID", iId], ["Activity Date", iDate], ["Activity Name", iName], ["Activity Type", iType], ["Filename", iFile]] as const) {
    if (i < 0) throw new Error(`activities.csv missing required column: ${label}`);
  }
  const data = rows.slice(1).filter((r) => r.length > iFile);

  const summaries: Summary[] = [];
  const featuresByYear = new Map<number, { id: string; feature: Feature }[]>();
  const importedTypes: Record<string, number> = {};
  const failures: string[] = [];
  let candidates = 0, imported = 0, droppedNoGps = 0;
  let distanceProbe = "";

  for (const r of data) {
    const type = (r[iType] ?? "").trim();
    const file = (r[iFile] ?? "").trim();
    if (!file) continue; // no track file => no GPS to render
    candidates++;

    const id = (r[iId] ?? "").trim();
    const parsedDate = parseDate((r[iDate] ?? "").trim());
    if (!parsedDate) { failures.push(`${id}: unparseable Activity Date`); continue; }

    let track;
    try { track = parseFit(join(dir, file)); }
    catch { failures.push(`${id}: FIT decode failed`); continue; }

    const coords = track.coords.map((c) => [r5(c[0]), r5(c[1])] as Coord);
    if (coords.length < 2) { droppedNoGps++; continue; } // indoor / no usable GPS track
    imported++;
    importedTypes[type] = (importedTypes[type] || 0) + 1;

    const distanceMeters = track.totalDistance != null
      ? Math.round(track.totalDistance)
      : Math.round(trackLengthMeters(coords));
    const movingTimeSeconds = track.totalTimerTime != null ? Math.round(track.totalTimerTime) : undefined;
    const name = (r[iName] ?? "").trim();
    const stravaUrl = `https://www.strava.com/activities/${id}`;

    const summary: Summary = { id, name, type, date: parsedDate.date, year: parsedDate.year };
    if (distanceMeters != null) summary.distanceMeters = distanceMeters;
    if (movingTimeSeconds != null) summary.movingTimeSeconds = movingTimeSeconds;
    summary.stravaUrl = stravaUrl;
    summaries.push(summary);

    const properties: Record<string, string | number> = {
      id, name, type, date: parsedDate.date, year: parsedDate.year,
    };
    if (distanceMeters != null) properties.distanceMeters = distanceMeters;
    properties.stravaUrl = stravaUrl;
    const feature: Feature = { type: "Feature", properties, geometry: { type: "LineString", coordinates: coords } };
    const bucket = featuresByYear.get(parsedDate.year) ?? [];
    bucket.push({ id, feature });
    featuresByYear.set(parsedDate.year, bucket);

    if (!distanceProbe && iDist >= 0) {
      distanceProbe = `id ${id}: FIT=${track.totalDistance?.toFixed(0)}m, ` +
        `GPS-haversine=${trackLengthMeters(coords).toFixed(0)}m, CSV Distance col="${r[iDist]}"`;
    }
  }

  const byId = (a: { id: string }, b: { id: string }) => Number(a.id) - Number(b.id);
  summaries.sort(byId);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "activities.json"), JSON.stringify(summaries, null, 2) + "\n");
  const years = [...featuresByYear.keys()].sort((a, b) => a - b);
  for (const year of years) {
    const bucket = featuresByYear.get(year)!;
    bucket.sort(byId);
    writeFileSync(join(OUT_DIR, `tracks-${year}.geojson`), serializeFeatureCollection(bucket.map((x) => x.feature)));
  }

  console.log(`[import] source dir: ${dir}`);
  console.log(`[import] activities in CSV: ${data.length}`);
  console.log(`[import] with a track file: ${candidates}`);
  console.log(`[import] imported (usable GPS >=2 pts): ${imported}  types: ${JSON.stringify(importedTypes)}`);
  console.log(`[import] dropped (no usable GPS / indoor): ${droppedNoGps}`);
  console.log(`[import] FIT decode failures: ${failures.length}`);
  if (failures.length) console.log(`[import] failure reasons:\n  ${failures.join("\n  ")}`);
  console.log(`[import] parse-failure rate: ${candidates ? ((failures.length / candidates) * 100).toFixed(1) : "0"}%`);
  console.log(`[import] distance cross-check (${distanceProbe || "n/a"})`);
  console.log(`[import] years: ${years.join(", ") || "none"}`);
  console.log(`[import] wrote ${OUT_DIR}/activities.json + tracks-<year>.geojson (${years.length} shard(s))`);
}

main();
