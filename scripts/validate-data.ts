// scripts/validate-data.ts
//
// Validates public artifacts against docs/DATA.md + the PRIVACY.md verifier
// (V1-V7). Reads data/private/privacy-zones.json for V1 but NEVER embeds or
// prints zone coordinates (T5): failures report an activity id + a distance
// only.
//
// Usage: bun run validate:data -- public/data

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { haversineMeters } from "./clip.ts";
import type { Coord, Zone } from "./clip.ts";

const SUMMARY_KEYS = new Set(["id", "name", "type", "date", "year", "distanceMeters", "movingTimeSeconds", "elevationGainMeters", "caloriesKcal", "avgHeartRate", "maxHeartRate", "stravaUrl"]);
const GEO_PROP_KEYS = new Set(["id", "name", "type", "date", "year", "distanceMeters", "movingTimeSeconds", "elevationGainMeters", "caloriesKcal", "avgHeartRate", "maxHeartRate", "stravaUrl"]);
const PLACE_KEYS = new Set(["name", "kind", "lat", "lng"]);
const STATS_TOP_KEYS = new Set(["totals", "byType", "byYear"]);
const LEAF_BUCKET_KEYS = new Set(["count", "movingTimeSeconds", "caloriesKcal", "avgHeartRateBpm"]);
const TYPE_BUCKET_KEYS = new Set(["count", "movingTimeSeconds", "caloriesKcal", "avgHeartRateBpm", "byYear"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ANYWHERE_RE = /\d{4}-\d{2}-\d{2}/; // stats.json must contain no date-shaped string
const YEAR_RE = /^\d{4}$/;
const ZONES_PATH = "data/private/privacy-zones.json";
const RAW_EXT_RE = /\.(gpx|tcx|fit|zip|gz)$/i;
// V1: clip keeps points >= clipDistance (>= 500 m); the final 5-decimal rounding
// can nudge a boundary point by up to ~1.6 m, so allow 2 m. A real leak sits
// hundreds of metres inside and is still caught.
const MIN_CLIP_M = 500, V1_TOLERANCE_M = 2;
const DIST_RATIO_MAX = 1.5; // clipped geometry must not exceed stored distance x1.5 (unit-error guard)
// V8: the clip seed now derives from the activity start time (epoch seconds).
// No day-precision field approaches 1e9, but a Unix epoch does (seconds ~1.7e9,
// millis ~1.7e12) — so any numeric value that large is a timestamp/epoch leak (T3).
const EPOCH_LIKE_MIN = 1e9;

const errors: string[] = [];
const fail = (m: string) => errors.push(m);

// V8: recursively assert no numeric value looks like a timestamp/epoch. Only
// JSON numbers are scanned; activity ids and Strava URLs are strings, unaffected.
function assertNoEpochLike(value: unknown, where: string): void {
  if (typeof value === "number") {
    if (Number.isFinite(value) && Math.abs(value) >= EPOCH_LIKE_MIN) fail(`V8: ${where} = ${value} is epoch-like (>= ${EPOCH_LIKE_MIN}); a start time / timestamp must never leak (T3)`);
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoEpochLike(value[i], `${where}[${i}]`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertNoEpochLike(v, `${where}.${k}`);
  }
}

function decimals(n: number): number {
  const s = String(n);
  if (s.includes("e") || s.includes("E")) return 99;
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}
function lineSegments(geom: { type: string; coordinates: unknown }): number[][][] {
  if (geom.type === "LineString") return [geom.coordinates as number[][]];
  if (geom.type === "MultiLineString") return geom.coordinates as number[][][];
  return [];
}
function checkSortedById(ids: string[], where: string): void {
  for (let i = 1; i < ids.length; i++) {
    if (Number(ids[i - 1]) > Number(ids[i])) { fail(`${where}: not sorted by id asc`); return; }
  }
}
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function main(): void {
  const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "public/data";
  if (!existsSync(dir)) { console.error(`validate:data: dir not found: ${dir}`); process.exit(1); }

  // V1 needs the zones file; refuse to certify without it.
  if (!existsSync(ZONES_PATH)) { console.error(`validate:data: ${ZONES_PATH} missing; cannot verify V1 (zone proximity).`); process.exit(1); }
  const zones = (JSON.parse(readFileSync(ZONES_PATH, "utf8")).zones as Zone[]).map((z) => ({ name: z.name, center: [z.lng, z.lat] as Coord }));

  // --- activities.json ---
  const actPath = join(dir, "activities.json");
  if (!existsSync(actPath)) { console.error(`validate:data: missing ${actPath}`); process.exit(1); }
  const actRaw = readFileSync(actPath, "utf8");
  if (!actRaw.endsWith("\n")) fail("activities.json: missing trailing newline");
  const summaries = JSON.parse(actRaw) as Record<string, unknown>[];
  assertNoEpochLike(summaries, "activities.json"); // V8
  const distanceById = new Map<string, number>();
  for (const s of summaries) {
    const id = String(s.id ?? "");
    for (const k of Object.keys(s)) if (!SUMMARY_KEYS.has(k)) fail(`activities.json[${id}]: unexpected key "${k}"`); // V3
    if (typeof s.id !== "string" || !s.id) fail(`activities.json[${id}]: id must be a non-empty string`);
    if (typeof s.name !== "string") fail(`activities.json[${id}]: name must be a string`);
    if (typeof s.type !== "string" || !s.type) fail(`activities.json[${id}]: type must be a non-empty string`);
    if (typeof s.date !== "string" || !DATE_RE.test(s.date)) fail(`activities.json[${id}]: date not YYYY-MM-DD`); // V4
    if (typeof s.year !== "number" || (typeof s.date === "string" && Number(s.date.slice(0, 4)) !== s.year)) fail(`activities.json[${id}]: year mismatch`);
    for (const k of ["distanceMeters", "movingTimeSeconds", "elevationGainMeters", "caloriesKcal", "avgHeartRate", "maxHeartRate"] as const) {
      if (s[k] !== undefined && (typeof s[k] !== "number" || !Number.isFinite(s[k] as number))) fail(`activities.json[${id}]: ${k} must be a finite number`);
    }
    if (s.stravaUrl !== undefined && (typeof s.stravaUrl !== "string" || !(s.stravaUrl as string).startsWith("https://www.strava.com/activities/"))) fail(`activities.json[${id}]: bad stravaUrl`);
    if (typeof s.distanceMeters === "number") distanceById.set(id, s.distanceMeters);
  }
  checkSortedById(summaries.map((s) => String(s.id)), "activities.json");
  const summaryIds = new Set(summaries.map((s) => String(s.id)));

  // --- tracks-<year>.geojson (schema, V4, V5, V7, distance sanity, V1) ---
  const geoIds = new Set<string>();
  let worstRatio = 0, v1MinMeters = Infinity;
  for (const file of readdirSync(dir).filter((f) => /^tracks-\d{4}\.geojson$/.test(f)).sort()) {
    const yearFromName = Number(file.slice(7, 11));
    const raw = readFileSync(join(dir, file), "utf8");
    if (!raw.endsWith("\n")) fail(`${file}: missing trailing newline`);
    const fc = JSON.parse(raw) as { type: string; features: Record<string, unknown>[] };
    assertNoEpochLike(fc, file); // V8
    if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) { fail(`${file}: not a FeatureCollection`); continue; }
    const ids: string[] = [];
    for (const feat of fc.features) {
      const props = (feat.properties ?? {}) as Record<string, unknown>;
      const id = String(props.id ?? "");
      ids.push(id); geoIds.add(id);
      if (feat.type !== "Feature") fail(`${file}[${id}]: not a Feature`);
      for (const k of Object.keys(props)) if (!GEO_PROP_KEYS.has(k)) fail(`${file}[${id}]: unexpected property key "${k}"`); // V3
      if (typeof props.date !== "string" || !DATE_RE.test(props.date)) fail(`${file}[${id}]: date not YYYY-MM-DD`); // V4
      if (props.year !== yearFromName) fail(`${file}[${id}]: year != shard ${yearFromName}`);
      if (!summaryIds.has(id)) fail(`${file}[${id}]: id absent from activities.json`);
      const segs = lineSegments(feat.geometry as { type: string; coordinates: unknown });
      if (segs.length === 0) { fail(`${file}[${id}]: geometry must be LineString/MultiLineString`); continue; }
      let pts = 0, length = 0;
      for (const seg of segs) {
        let prev: Coord | null = null;
        for (const pt of seg) {
          pts++;
          if (!Array.isArray(pt) || pt.length !== 2) { fail(`${file}[${id}]: bad coordinate`); continue; }
          const [lng, lat] = pt as Coord;
          if (decimals(lng) > 5 || decimals(lat) > 5) fail(`${file}[${id}]: coordinate exceeds 5 decimals`); // V5
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) fail(`${file}[${id}]: coordinate out of range`);
          for (const z of zones) { // V1
            const d = haversineMeters([lng, lat], z.center);
            if (d < v1MinMeters) v1MinMeters = d;
            if (d < MIN_CLIP_M - V1_TOLERANCE_M) fail(`V1: ${file}[${id}] has a point ${d.toFixed(1)} m from a zone (< ${MIN_CLIP_M} m)`);
          }
          if (prev) length += haversineMeters(prev, [lng, lat]);
          prev = [lng, lat];
        }
      }
      if (pts < 2) fail(`${file}[${id}]: fewer than 2 points`);
      const stored = distanceById.get(id);
      if (stored && stored > 0 && length > 0) {
        const ratio = length / stored;
        worstRatio = Math.max(worstRatio, ratio);
        if (ratio > DIST_RATIO_MAX) fail(`${file}[${id}]: geometry ${length.toFixed(0)} m exceeds stored ${stored} m x${DIST_RATIO_MAX}`);
      }
    }
    checkSortedById(ids, file);
  }

  // --- places.json (schema + V5 extension: <=2 decimals; V1-exempt by design) ---
  let placeCount = 0;
  const placesPath = join(dir, "places.json");
  if (existsSync(placesPath)) {
    const praw = readFileSync(placesPath, "utf8");
    if (!praw.endsWith("\n")) fail("places.json: missing trailing newline");
    const pj = JSON.parse(praw) as { places?: Record<string, unknown>[] };
    assertNoEpochLike(pj, "places.json"); // V8
    if (!Array.isArray(pj.places)) fail("places.json: missing places array");
    for (const p of pj.places ?? []) {
      placeCount++;
      const nm = String(p.name ?? "");
      for (const k of Object.keys(p)) if (!PLACE_KEYS.has(k)) fail(`places.json[${nm}]: unexpected key "${k}"`);
      if (typeof p.name !== "string" || !p.name) fail(`places.json[${nm}]: name must be a non-empty string`);
      if (typeof p.kind !== "string" || !p.kind) fail(`places.json[${nm}]: kind must be a non-empty string`);
      for (const k of ["lat", "lng"] as const) {
        if (typeof p[k] !== "number") { fail(`places.json[${nm}]: ${k} must be a number`); continue; }
        if (decimals(p[k] as number) > 2) fail(`places.json[${nm}]: ${k} exceeds 2 decimals (neighborhood precision)`); // V5 extension
      }
      const lat = p.lat as number, lng = p.lng as number;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) fail(`places.json[${nm}]: coordinate out of range`);
    }
  }

  // --- stats.json (aggregate-only: no dates, no keys outside the schema) ---
  let statsActivities: number | null = null;
  const statsPath = join(dir, "stats.json");
  if (existsSync(statsPath)) {
    const sraw = readFileSync(statsPath, "utf8");
    if (!sraw.endsWith("\n")) fail("stats.json: missing trailing newline");
    if (DATE_ANYWHERE_RE.test(sraw)) fail("stats.json: contains a YYYY-MM-DD date-shaped string (aggregates only, no dates)"); // T3/T4
    const st = JSON.parse(sraw) as Record<string, unknown>;
    assertNoEpochLike(st, "stats.json"); // V8
    for (const k of Object.keys(st)) if (!STATS_TOP_KEYS.has(k)) fail(`stats.json: unexpected top-level key "${k}"`);
    const checkLeaf = (where: string, b: unknown): Record<string, unknown> | null => {
      if (typeof b !== "object" || b === null) { fail(`stats.json: ${where} must be an object`); return null; }
      const rec = b as Record<string, unknown>;
      if (typeof rec.count !== "number" || !Number.isInteger(rec.count) || rec.count < 0) fail(`stats.json: ${where}.count must be a non-negative integer`);
      if (typeof rec.movingTimeSeconds !== "number" || !Number.isFinite(rec.movingTimeSeconds) || rec.movingTimeSeconds < 0) fail(`stats.json: ${where}.movingTimeSeconds must be a non-negative number`);
      if (typeof rec.caloriesKcal !== "number" || !Number.isFinite(rec.caloriesKcal) || rec.caloriesKcal < 0) fail(`stats.json: ${where}.caloriesKcal must be a non-negative number`);
      if (rec.avgHeartRateBpm !== undefined && (typeof rec.avgHeartRateBpm !== "number" || !Number.isFinite(rec.avgHeartRateBpm) || rec.avgHeartRateBpm <= 0 || rec.avgHeartRateBpm > 300)) fail(`stats.json: ${where}.avgHeartRateBpm must be a plausible bpm (0-300)`);
      return rec;
    };
    const checkYearMap = (where: string, g: unknown): void => {
      if (typeof g !== "object" || g === null) { fail(`stats.json: ${where} must be an object`); return; }
      for (const [k, v] of Object.entries(g as Record<string, unknown>)) {
        if (!YEAR_RE.test(k)) fail(`stats.json: ${where} has invalid year key "${k}"`);
        const leaf = checkLeaf(`${where}["${k}"]`, v);
        if (leaf) for (const kk of Object.keys(leaf)) if (!LEAF_BUCKET_KEYS.has(kk)) fail(`stats.json: ${where}["${k}"] has unexpected key "${kk}"`);
      }
    };
    // totals: leaf bucket
    if (st.totals === undefined) fail("stats.json: missing totals");
    else {
      const leaf = checkLeaf("totals", st.totals);
      if (leaf) { for (const kk of Object.keys(leaf)) if (!LEAF_BUCKET_KEYS.has(kk)) fail(`stats.json: totals has unexpected key "${kk}"`); statsActivities = (leaf.count as number) ?? null; }
    }
    // byType: type buckets (count + movingTimeSeconds + nested byYear)
    const bt = st.byType;
    if (typeof bt !== "object" || bt === null) fail("stats.json: byType must be an object");
    else for (const [t, v] of Object.entries(bt as Record<string, unknown>)) {
      if (!t.length) fail("stats.json: byType has an empty type key");
      const rec = checkLeaf(`byType["${t}"]`, v);
      if (rec) {
        for (const kk of Object.keys(rec)) if (!TYPE_BUCKET_KEYS.has(kk)) fail(`stats.json: byType["${t}"] has unexpected key "${kk}"`);
        if (rec.byYear === undefined) fail(`stats.json: byType["${t}"] missing byYear`);
        else checkYearMap(`byType["${t}"].byYear`, rec.byYear);
      }
    }
    // byYear: leaf buckets keyed by year
    checkYearMap("byYear", st.byYear);
  }

  // --- V6: no raw track files anywhere under public/ ---
  for (const f of walk("public")) if (RAW_EXT_RE.test(f)) fail(`V6: raw track file under public/: ${f}`);

  // --- V7: id-set consistency ---
  for (const id of summaryIds) if (!geoIds.has(id)) fail(`V7: id ${id} in activities.json but no track feature`);
  for (const id of geoIds) if (!summaryIds.has(id)) fail(`V7: id ${id} in a track shard but not activities.json`);

  console.log(`[validate] dir: ${dir}  |  zones loaded: ${zones.length}`);
  console.log(`[validate] activities: ${summaries.length}  |  track features: ${geoIds.size}  |  places: ${placeCount}  |  stats activities: ${statsActivities ?? "n/a"}`);
  console.log(`[validate] V1 closest published track point to any zone: ${v1MinMeters === Infinity ? "n/a" : v1MinMeters.toFixed(1) + " m"} (>= ${MIN_CLIP_M})`);
  console.log(`[validate] worst geometry/stored distance ratio: ${worstRatio.toFixed(2)} (<= ${DIST_RATIO_MAX})`);
  if (errors.length) {
    console.error(`\n[validate] FAILED with ${errors.length} error(s):`);
    for (const e of errors.slice(0, 40)) console.error(`  - ${e}`);
    if (errors.length > 40) console.error(`  ... and ${errors.length - 40} more`);
    process.exit(1);
  }
  console.log(`[validate] OK — DATA.md schema + PRIVACY.md V1-V8 all pass`);
}

main();
