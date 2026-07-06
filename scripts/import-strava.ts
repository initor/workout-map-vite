// scripts/import-strava.ts
//
// Strava bulk-export importer (Milestone M3: privacy clipping + first publish).
//
// Reads ONLY `<dir>/activities.csv` and the FIT tracks it references (PRIVACY.md
// R3), keeps every activity with a usable GPS track, applies the PRIVACY.md
// clipping algorithm against the gitignored zones file, and writes the sanitized
// public artifacts to `public/data/`. `type` is carried through from Strava
// verbatim.
//
// PRIVACY: zone coordinates (precise or rounded) are NEVER logged (T5). Without
// the zones file the importer hard-fails (R1) unless --allow-no-privacy-zones is
// passed, which skips clipping and writes UNCLIPPED output to staging only.
//
// Usage: bun run import:strava -- --dir data/raw
//        bun run import:strava -- --dir data/raw --allow-no-privacy-zones

import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { Decoder, Stream } from "@garmin/fitsdk";
import { clipTrack, round } from "./clip.ts";
import type { Coord, Zone } from "./clip.ts";

const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;
const ZONES_PATH = "data/private/privacy-zones.json";
const PUBLIC_DIR = "public/data";
const STAGING_DIR = "data/intermediate/staging";
const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

interface FitRecord { positionLat?: number; positionLong?: number }
interface FitSession { totalDistance?: number; totalTimerTime?: number }

interface Summary {
  id: string; name: string; type: string; date: string; year: number;
  distanceMeters?: number; movingTimeSeconds?: number; stravaUrl: string;
}
type Geometry =
  | { type: "LineString"; coordinates: Coord[] }
  | { type: "MultiLineString"; coordinates: Coord[][] };
interface Feature { type: "Feature"; properties: Record<string, string | number>; geometry: Geometry }

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function parseArgs(argv: string[]): { dir: string; allowNoZones: boolean } {
  let dir = "data/raw", allowNoZones = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") { dir = argv[i + 1] ?? dir; i++; }
    else if (argv[i] === "--allow-no-privacy-zones") allowNoZones = true;
  }
  return { dir, allowNoZones };
}

function parseDate(s: string): { date: string; year: number } | null {
  const m = s.match(/^(\w{3}) (\d{1,2}), (\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[1]];
  if (!mm) return null;
  return { date: `${m[3]}-${mm}-${m[2].padStart(2, "0")}`, year: Number(m[3]) };
}

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

function serializeFeatureCollection(features: Feature[]): string {
  const body = features.map((f) => "    " + JSON.stringify(f)).join(",\n");
  return `{\n  "type": "FeatureCollection",\n  "features": [\n${body}\n  ]\n}\n`;
}

// Remove only generated artifacts (never public/data/fixtures/).
function resetOutput(dir: string, isPublic: boolean): void {
  if (!isPublic) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); return; }
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (f === "activities.json" || f === "places.json" || /^tracks-\d{4}\.geojson$/.test(f)) rmSync(join(dir, f));
  }
}

function main(): void {
  const { dir, allowNoZones } = parseArgs(process.argv.slice(2));

  // R1: resolve zones + output target. Unclipped output never reaches public/.
  let zones: Zone[] | null = null, seedSalt = "";
  let outDir: string, isPublic: boolean;
  if (allowNoZones) {
    outDir = STAGING_DIR; isPublic = false;
    console.log("[import] --allow-no-privacy-zones: NO clipping; writing UNCLIPPED to staging only.");
  } else if (existsSync(ZONES_PATH)) {
    const z = JSON.parse(readFileSync(ZONES_PATH, "utf8")) as { seedSalt: string; zones: Zone[] };
    seedSalt = z.seedSalt; zones = z.zones;
    outDir = PUBLIC_DIR; isPublic = true;
  } else {
    console.error(`[import] FATAL: ${ZONES_PATH} is missing. Refusing to publish unclipped data.\n` +
      `  Pass --allow-no-privacy-zones to run WITHOUT clipping (staging only, never public/data/).`);
    process.exit(1);
  }

  const rows = parseCSV(readFileSync(join(dir, "activities.csv"), "utf8"));
  const header = rows[0];
  const col = (name: string) => header.indexOf(name);
  const iId = col("Activity ID"), iDate = col("Activity Date"), iName = col("Activity Name");
  const iType = col("Activity Type"), iFile = col("Filename");
  for (const [label, i] of [["Activity ID", iId], ["Activity Date", iDate], ["Activity Name", iName], ["Activity Type", iType], ["Filename", iFile]] as const) {
    if (i < 0) throw new Error(`activities.csv missing required column: ${label}`);
  }
  const data = rows.slice(1).filter((r) => r.length > iFile);

  const summaries: Summary[] = [];
  const featuresByYear = new Map<number, { id: string; feature: Feature }[]>();
  const importedTypes: Record<string, number> = {};
  const failures: string[] = [];
  let withTrack = 0, droppedNoGps = 0, droppedByClip = 0, imported = 0, multiCount = 0;

  for (const r of data) {
    const type = (r[iType] ?? "").trim();
    const file = (r[iFile] ?? "").trim();
    if (!file) continue;
    withTrack++;

    const id = (r[iId] ?? "").trim();
    const parsedDate = parseDate((r[iDate] ?? "").trim());
    if (!parsedDate) { failures.push(`${id}: unparseable Activity Date`); continue; }

    let track;
    try { track = parseFit(join(dir, file)); }
    catch { failures.push(`${id}: FIT decode failed`); continue; }
    if (track.coords.length < 2) { droppedNoGps++; continue; }

    // Geometry: clipped (public) or full 5dp (staging escape hatch).
    let geometry: Geometry;
    if (zones) {
      const clipped = clipTrack(track.coords, zones, seedSalt, id);
      if (!clipped) { droppedByClip++; continue; }
      geometry = clipped.segments.length === 1
        ? { type: "LineString", coordinates: clipped.segments[0] }
        : { type: "MultiLineString", coordinates: clipped.segments };
      if (clipped.segments.length > 1) multiCount++;
    } else {
      geometry = { type: "LineString", coordinates: track.coords.map((c) => [round(c[0], 5), round(c[1], 5)] as Coord) };
    }
    imported++;
    importedTypes[type] = (importedTypes[type] || 0) + 1;

    const distanceMeters = track.totalDistance != null ? Math.round(track.totalDistance) : undefined;
    const movingTimeSeconds = track.totalTimerTime != null ? Math.round(track.totalTimerTime) : undefined;
    const name = (r[iName] ?? "").trim();
    const stravaUrl = `https://www.strava.com/activities/${id}`;

    const summary: Summary = { id, name, type, date: parsedDate.date, year: parsedDate.year };
    if (distanceMeters != null) summary.distanceMeters = distanceMeters;
    if (movingTimeSeconds != null) summary.movingTimeSeconds = movingTimeSeconds;
    summary.stravaUrl = stravaUrl;
    summaries.push(summary);

    const properties: Record<string, string | number> = { id, name, type, date: parsedDate.date, year: parsedDate.year };
    if (distanceMeters != null) properties.distanceMeters = distanceMeters;
    properties.stravaUrl = stravaUrl;
    const feature: Feature = { type: "Feature", properties, geometry };
    const bucket = featuresByYear.get(parsedDate.year) ?? [];
    bucket.push({ id, feature });
    featuresByYear.set(parsedDate.year, bucket);
  }

  const byId = (a: { id: string }, b: { id: string }) => Number(a.id) - Number(b.id);
  summaries.sort(byId);

  resetOutput(outDir, isPublic);
  writeFileSync(join(outDir, "activities.json"), JSON.stringify(summaries, null, 2) + "\n");
  const years = [...featuresByYear.keys()].sort((a, b) => a - b);
  for (const year of years) {
    const bucket = featuresByYear.get(year)!;
    bucket.sort(byId);
    writeFileSync(join(outDir, `tracks-${year}.geojson`), serializeFeatureCollection(bucket.map((x) => x.feature)));
  }

  // Neighborhood-precision Home marker (2 decimals ~1km). Precise value never logged.
  let placeCount = 0;
  if (zones) {
    const places = zones
      .filter((z) => z.name.toLowerCase() === "home")
      .map((z) => ({ name: "Home", kind: "home", lat: round(z.lat, 2), lng: round(z.lng, 2) }));
    placeCount = places.length;
    writeFileSync(join(outDir, "places.json"), JSON.stringify({ places }, null, 2) + "\n");
  }

  console.log(`[import] source dir: ${dir}  ->  output: ${outDir}  (clipping: ${zones ? "ON" : "OFF"})`);
  console.log(`[import] activities with a track file: ${withTrack}`);
  console.log(`[import] imported: ${imported}  types: ${JSON.stringify(importedTypes)}`);
  console.log(`[import] MultiLineString (split by clipping): ${multiCount}`);
  console.log(`[import] dropped: no-GPS/indoor=${droppedNoGps}, by-clip(<20pts/<500m)=${droppedByClip}`);
  console.log(`[import] FIT decode failures: ${failures.length}`);
  if (failures.length) console.log(`[import] failure reasons:\n  ${failures.join("\n  ")}`);
  console.log(`[import] year shards: ${years.join(", ") || "none"}  |  places: ${placeCount}`);
}

main();
