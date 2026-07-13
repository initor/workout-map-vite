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
import { join } from "node:path";
import { clipTrack, round } from "./clip.ts";
import type { Coord, Zone } from "./clip.ts";
import { parseFit } from "./fit.ts";

const ZONES_PATH = "data/private/privacy-zones.json";
const PUBLIC_DIR = "public/data";
const STAGING_DIR = "data/intermediate/staging";
const EXPORT_SUBDIR = "export";       // data/raw/export/     — the Strava bulk export (activities.csv + activities/); replaced wholesale by `bun run update`
const HAMMERHEAD_SUBDIR = "hammerhead"; // data/raw/hammerhead/ — API-fetched ride FITs, append-only by sync:rides
const DEDUP_TOLERANCE_S = 60;         // two records within +-60 s of start are the same ride (M8)
// FIT session `sport` -> our display type, for Hammerhead-only rides (no CSV row).
const SPORT_TYPE: Record<string, string> = { cycling: "Ride", hiking: "Hike", walking: "Walk", running: "Run" };
const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

interface Summary {
  id: string; name: string; type: string; date: string; year: number;
  distanceMeters?: number; movingTimeSeconds?: number; elevationGainMeters?: number;
  caloriesKcal?: number; avgHeartRate?: number; maxHeartRate?: number; stravaUrl?: string;
}
// One ride before clipping, from either corpus. `startEpochSeconds` (M7 clip seed
// + M8 cross-source identity) is a SEED INPUT ONLY — never emitted to an artifact.
export interface Ride {
  id: string; startEpochSeconds: number; coords: Coord[]; source: "export" | "hammerhead";
  name: string; type: string; date: string; year: number;
  distanceMeters?: number; movingTimeSeconds?: number; elevationGainMeters?: number;
  caloriesKcal?: number; avgHeartRate?: number; maxHeartRate?: number; stravaUrl?: string;
}
interface Bucket { count: number; movingTimeSeconds: number; caloriesKcal: number; avgHeartRateBpm?: number }
interface TypeBucket extends Bucket { byYear: Record<string, Bucket> }
interface Stats { totals: Bucket; byType: Record<string, TypeBucket>; byYear: Record<string, Bucket> }
type Geometry =
  | { type: "LineString"; coordinates: Coord[] }
  | { type: "MultiLineString"; coordinates: Coord[][] };
interface Feature { type: "Feature"; properties: Record<string, string | number>; geometry: Geometry }

// Sort by activity id ascending. Numeric Strava ids sort numerically (unchanged
// from before); opaque Hammerhead-only ids (non-numeric, pre-backfill) sort after
// them, lexically — a total, deterministic order for a mixed corpus.
function byId(a: { id: string }, b: { id: string }): number {
  const na = Number(a.id), nb = Number(b.id);
  const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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

// Day-precision UTC date from epoch seconds, for Hammerhead-only rides (no CSV
// row). Day only — never a time (PRIVACY.md T3).
function dateFromEpoch(epochSeconds: number): { date: string; year: number } {
  const d = new Date(epochSeconds * 1000);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { date, year: d.getUTCFullYear() };
}

// Merge the two corpora, deduped on startEpochSeconds within `toleranceS`.
// A ride in both is a collision: prefer the Hammerhead geometry (+ its seed),
// keep the export's labelled metadata (id/name/stravaUrl/...). A Hammerhead-only
// ride is a new addition. Pure: inputs are not mutated.
export function dedupeRides(exportRides: Ride[], hammerheadRides: Ride[], toleranceS: number): Ride[] {
  const rides: Ride[] = exportRides.map((r) => ({ ...r }));
  for (const hr of hammerheadRides) {
    const match = rides.find((r) => Math.abs(r.startEpochSeconds - hr.startEpochSeconds) <= toleranceS);
    if (match) { match.coords = hr.coords; match.startEpochSeconds = hr.startEpochSeconds; match.source = "hammerhead"; }
    else rides.push({ ...hr });
  }
  return rides;
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
    if (f === "activities.json" || f === "places.json" || f === "stats.json" || /^tracks-\d{4}\.geojson$/.test(f)) rmSync(join(dir, f));
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

  const EXPORT_DIR = join(dir, EXPORT_SUBDIR);
  const HAMMERHEAD_DIR = join(dir, HAMMERHEAD_SUBDIR);

  const rows = parseCSV(readFileSync(join(EXPORT_DIR, "activities.csv"), "utf8"));
  const header = rows[0];
  const col = (name: string) => header.indexOf(name);
  const iId = col("Activity ID"), iDate = col("Activity Date"), iName = col("Activity Name");
  const iType = col("Activity Type"), iFile = col("Filename");
  // Optional (degrade gracefully if a future export renames them): "Moving Time"
  // (seconds) feeds stats.json; "Elevation Gain" (metres) feeds the per-activity
  // elevation. Both are single, unambiguous columns (unlike the duplicated
  // Distance/Elapsed Time/Commute pairs), so indexOf resolves them correctly.
  const iMoving = col("Moving Time"), iElev = col("Elevation Gain"), iCalories = col("Calories"), iAvgHr = col("Average Heart Rate");
  for (const [label, i] of [["Activity ID", iId], ["Activity Date", iDate], ["Activity Name", iName], ["Activity Type", iType], ["Filename", iFile]] as const) {
    if (i < 0) throw new Error(`activities.csv missing required column: ${label}`);
  }
  const data = rows.slice(1).filter((r) => r.length > iFile);

  const failures: string[] = [];
  let withTrack = 0, droppedNoGps = 0, droppedByClip = 0, multiCount = 0;

  // --- collect EXPORT rides (CSV-driven; metadata from CSV + FIT session) ---
  const exportRides: Ride[] = [];
  for (const r of data) {
    const type = (r[iType] ?? "").trim();
    const file = (r[iFile] ?? "").trim();
    if (!file) continue;
    withTrack++;
    const id = (r[iId] ?? "").trim();
    const parsedDate = parseDate((r[iDate] ?? "").trim());
    if (!parsedDate) { failures.push(`${id}: unparseable Activity Date`); continue; }
    let track;
    try { track = parseFit(readFileSync(join(EXPORT_DIR, file))); }
    catch { failures.push(`${id}: FIT decode failed`); continue; }
    if (track.coords.length < 2) { droppedNoGps++; continue; }
    // startEpochSeconds is the M7 clip seed AND the M8 cross-source dedup key.
    if (track.startEpochSeconds === undefined) { failures.push(`${id}: no start timestamp (clip seed / dedup key)`); continue; }
    // Metadata (derivation unchanged): distance/HR from FIT session; elevation from
    // the CSV; calories FIT-then-CSV; name/type/date from CSV; stravaUrl from id.
    const elevRaw = iElev >= 0 ? Number((r[iElev] ?? "").trim()) : NaN;
    const csvCal = iCalories >= 0 ? Number((r[iCalories] ?? "").trim()) : NaN;
    exportRides.push({
      id, startEpochSeconds: track.startEpochSeconds, coords: track.coords, source: "export",
      name: (r[iName] ?? "").trim(), type, date: parsedDate.date, year: parsedDate.year,
      distanceMeters: track.totalDistance != null ? Math.round(track.totalDistance) : undefined,
      movingTimeSeconds: track.totalTimerTime != null ? Math.round(track.totalTimerTime) : undefined,
      elevationGainMeters: Number.isFinite(elevRaw) ? Math.round(elevRaw) : undefined,
      caloriesKcal: track.totalCalories != null ? Math.round(track.totalCalories) : (Number.isFinite(csvCal) ? Math.round(csvCal) : undefined),
      avgHeartRate: track.avgHeartRate != null ? Math.round(track.avgHeartRate) : undefined,
      maxHeartRate: track.maxHeartRate != null ? Math.round(track.maxHeartRate) : undefined,
      stravaUrl: `https://www.strava.com/activities/${id}`,
    });
  }

  // --- collect HAMMERHEAD rides (FIT-only; metadata from the FIT session) ---
  // Append-only corpus keyed by startEpochSeconds. No CSV row -> no name / Strava
  // id / stravaUrl until the export backfills them (matched on start time). Clipping
  // only (zones present): the staging escape hatch stays export-only.
  const hammerheadRides: Ride[] = [];
  if (zones && existsSync(HAMMERHEAD_DIR)) {
    for (const f of readdirSync(HAMMERHEAD_DIR).filter((n) => n.endsWith(".fit")).sort()) {
      const hid = f.replace(/\.fit$/, "");
      let track;
      try { track = parseFit(readFileSync(join(HAMMERHEAD_DIR, f))); }
      catch { failures.push(`${hid}: Hammerhead FIT decode failed`); continue; }
      if (track.coords.length < 2 || track.startEpochSeconds === undefined) { droppedNoGps++; continue; }
      const { date, year } = dateFromEpoch(track.startEpochSeconds);
      hammerheadRides.push({
        id: hid, startEpochSeconds: track.startEpochSeconds, coords: track.coords, source: "hammerhead",
        name: "", type: SPORT_TYPE[track.sport ?? ""] ?? "Ride", date, year,
        distanceMeters: track.totalDistance != null ? Math.round(track.totalDistance) : undefined,
        movingTimeSeconds: track.totalTimerTime != null ? Math.round(track.totalTimerTime) : undefined,
        elevationGainMeters: track.totalAscent != null ? Math.round(track.totalAscent) : undefined,
        caloriesKcal: track.totalCalories != null ? Math.round(track.totalCalories) : undefined,
        avgHeartRate: track.avgHeartRate != null ? Math.round(track.avgHeartRate) : undefined,
        maxHeartRate: track.maxHeartRate != null ? Math.round(track.maxHeartRate) : undefined,
      });
    }
  }

  // --- dedup on startEpochSeconds (+-60 s): export + hammerhead -> one corpus ---
  // Collision prefers Hammerhead geometry (see dedupeRides). With FIT passthrough
  // the two clips are byte-identical, so previously published geometry is
  // unchanged; a real sync confirms that additively via the sync guard.
  const rides = dedupeRides(exportRides, hammerheadRides, DEDUP_TOLERANCE_S);

  // --- clip (public) or 5dp passthrough (staging) + build artifacts ---
  const summaries: Summary[] = [];
  const featuresByYear = new Map<number, { id: string; feature: Feature }[]>();
  const importedTypes: Record<string, number> = {};
  let imported = 0;
  for (const ride of rides) {
    let geometry: Geometry;
    if (zones) {
      const clipped = clipTrack(ride.coords, zones, seedSalt, ride.startEpochSeconds);
      if (!clipped) { droppedByClip++; continue; }
      geometry = clipped.segments.length === 1
        ? { type: "LineString", coordinates: clipped.segments[0] }
        : { type: "MultiLineString", coordinates: clipped.segments };
      if (clipped.segments.length > 1) multiCount++;
    } else {
      geometry = { type: "LineString", coordinates: ride.coords.map((c) => [round(c[0], 5), round(c[1], 5)] as Coord) };
    }
    imported++;
    importedTypes[ride.type] = (importedTypes[ride.type] || 0) + 1;

    // Single properties object, shared by the summary (activities.json) and the
    // feature (tracks-*.geojson) so they stay identical; omit absent fields.
    const props: Record<string, string | number> = { id: ride.id, name: ride.name, type: ride.type, date: ride.date, year: ride.year };
    if (ride.distanceMeters != null) props.distanceMeters = ride.distanceMeters;
    if (ride.movingTimeSeconds != null) props.movingTimeSeconds = ride.movingTimeSeconds;
    if (ride.elevationGainMeters != null) props.elevationGainMeters = ride.elevationGainMeters;
    if (ride.caloriesKcal != null) props.caloriesKcal = ride.caloriesKcal;
    if (ride.avgHeartRate != null) props.avgHeartRate = ride.avgHeartRate;
    if (ride.maxHeartRate != null) props.maxHeartRate = ride.maxHeartRate;
    if (ride.stravaUrl != null) props.stravaUrl = ride.stravaUrl;

    summaries.push(props as unknown as Summary);
    const bucket = featuresByYear.get(ride.year) ?? [];
    bucket.push({ id: ride.id, feature: { type: "Feature", properties: props, geometry } });
    featuresByYear.set(ride.year, bucket);
  }

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

  // stats.json — aggregates over the FULL activities.csv (every row, INCLUDING
  // indoor activities that never reach the map, e.g. GPS-less CrossFit). Counts
  // and total moving time (CSV "Moving Time", seconds) by type and by year, plus
  // grand totals. Aggregates ONLY: no ids, no per-activity records, no dates.
  // Privacy: no coordinates (T1/T2/T5 n/a), no datetime/schedule (T3 — year is a
  // 4-digit number, never a date), and no per-activity flag (T4 — an aggregate
  // count reveals nothing about which activity was excluded, or where/when).
  const addLeaf = (m: Map<string, Bucket>, key: string, secs: number, cal: number) => {
    const b = m.get(key) ?? { count: 0, movingTimeSeconds: 0, caloriesKcal: 0 };
    b.count++; b.movingTimeSeconds += secs; b.caloriesKcal += cal; m.set(key, b);
  };
  // byType carries a nested per-year split (byYear inside each type) so the UI can
  // show, e.g., indoor activity per year without a separate cross-tab artifact.
  // Calories: CSV Calories column (recon: 100% coverage, all types).
  // avgHeartRateBpm (totals + byType only): moving-time-weighted mean of the CSV
  // "Average Heart Rate" over activities that have HR (weight = moving time),
  // omitted where a bucket has no HR data. Per-type is captured; rendering is BACKLOG.
  const byTypeYear = new Map<string, { count: number; movingTimeSeconds: number; caloriesKcal: number; byYear: Map<string, Bucket> }>();
  const byYear = new Map<string, Bucket>();
  const totals: Bucket = { count: 0, movingTimeSeconds: 0, caloriesKcal: 0 };
  let hrSum = 0, hrWeight = 0; // [sum(hr*movingTime), sum(movingTime)] over HR-having activities
  const hrByType = new Map<string, [number, number]>();
  for (const r of data) {
    const type = (r[iType] ?? "").trim();
    const parsed = parseDate((r[iDate] ?? "").trim());
    if (!type || !parsed) continue;
    const y = String(parsed.year);
    const mt = iMoving >= 0 ? Number((r[iMoving] ?? "").trim()) : NaN;
    const secs = Number.isFinite(mt) ? mt : 0;
    const cv = iCalories >= 0 ? Number((r[iCalories] ?? "").trim()) : NaN;
    const cal = Number.isFinite(cv) ? cv : 0;
    const hv = iAvgHr >= 0 ? Number((r[iAvgHr] ?? "").trim()) : NaN;
    let tb = byTypeYear.get(type);
    if (!tb) { tb = { count: 0, movingTimeSeconds: 0, caloriesKcal: 0, byYear: new Map() }; byTypeYear.set(type, tb); }
    tb.count++; tb.movingTimeSeconds += secs; tb.caloriesKcal += cal;
    addLeaf(tb.byYear, y, secs, cal);
    addLeaf(byYear, y, secs, cal);
    totals.count++; totals.movingTimeSeconds += secs; totals.caloriesKcal += cal;
    if (Number.isFinite(hv) && hv > 0 && secs > 0) {
      hrSum += hv * secs; hrWeight += secs;
      const w = hrByType.get(type) ?? [0, 0]; w[0] += hv * secs; w[1] += secs; hrByType.set(type, w);
    }
  }
  const strCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const yearCmp = (a: string, b: string) => Number(a) - Number(b);
  const roundLeaf = (b: Bucket): Bucket => ({ count: b.count, movingTimeSeconds: Math.round(b.movingTimeSeconds), caloriesKcal: Math.round(b.caloriesKcal) });
  const weightedHr = (sum: number, weight: number): number | undefined => (weight > 0 ? Math.round(sum / weight) : undefined);
  // Stable key order for byte-determinism: types alphabetical (matches the UI sort);
  // years ascending (JS also serializes integer-like year keys ascending regardless).
  const sortedLeaves = (m: Map<string, Bucket>): Record<string, Bucket> =>
    Object.fromEntries([...m.keys()].sort(yearCmp).map((k) => [k, roundLeaf(m.get(k)!)]));
  const byType: Record<string, TypeBucket> = {};
  for (const t of [...byTypeYear.keys()].sort(strCmp)) {
    const tb = byTypeYear.get(t)!;
    const [hs, hw] = hrByType.get(t) ?? [0, 0];
    const bpm = weightedHr(hs, hw);
    const o: Record<string, unknown> = { count: tb.count, movingTimeSeconds: Math.round(tb.movingTimeSeconds), caloriesKcal: Math.round(tb.caloriesKcal) };
    if (bpm != null) o.avgHeartRateBpm = bpm;
    o.byYear = sortedLeaves(tb.byYear);
    byType[t] = o as unknown as TypeBucket;
  }
  const totalsOut = roundLeaf(totals);
  const totalBpm = weightedHr(hrSum, hrWeight);
  if (totalBpm != null) totalsOut.avgHeartRateBpm = totalBpm;
  const stats: Stats = { totals: totalsOut, byType, byYear: sortedLeaves(byYear) };
  writeFileSync(join(outDir, "stats.json"), JSON.stringify(stats, null, 2) + "\n");

  console.log(`[import] source dir: ${dir}  ->  output: ${outDir}  (clipping: ${zones ? "ON" : "OFF"})`);
  console.log(`[import] activities with a track file: ${withTrack}`);
  console.log(`[import] imported: ${imported}  types: ${JSON.stringify(importedTypes)}`);
  console.log(`[import] MultiLineString (split by clipping): ${multiCount}`);
  console.log(`[import] dropped: no-GPS/indoor=${droppedNoGps}, by-clip(<20pts/<500m)=${droppedByClip}`);
  console.log(`[import] FIT decode failures: ${failures.length}`);
  if (failures.length) console.log(`[import] failure reasons:\n  ${failures.join("\n  ")}`);
  console.log(`[import] year shards: ${years.join(", ") || "none"}  |  places: ${placeCount}`);
  console.log(`[import] stats.json: ${totals.count} activities across ${byTypeYear.size} type(s), ${byYear.size} year(s)`);
}

// Run only as a script, not when imported by tests (which use dedupeRides / Ride).
if (import.meta.main) main();
