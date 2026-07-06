// scripts/validate-data.ts
//
// Validates staging (or public) data artifacts against docs/DATA.md:
// schema shape, key-tightness, date format, <=5-decimal coords, id-set
// consistency, stable id-ascending sort, and a distance sanity cross-check
// (stored distance vs GPS-recomputed length).
//
// PRIVACY.md's zone-based assertions (V1 clip radius, V2 endpoint drop, V6
// no raw files under public/) arrive with the privacy layer in M3.
//
// Usage: bun run validate:data -- data/intermediate/staging
//        bun scripts/validate-data.ts data/intermediate/staging

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SUMMARY_KEYS = new Set(["id", "name", "type", "date", "year", "distanceMeters", "movingTimeSeconds", "elevationGainMeters", "stravaUrl"]);
const GEO_PROP_KEYS = new Set(["id", "name", "type", "date", "year", "distanceMeters", "stravaUrl"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIST_RATIO_TOLERANCE = 3; // stored vs GPS length must agree within 3x (catches unit errors)

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

function decimals(n: number): number {
  const s = String(n);
  if (s.includes("e") || s.includes("E")) return 99; // exponential => reject
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

function haversineMeters(a: number[], b: number[]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function lineSegments(geom: { type: string; coordinates: unknown }): number[][][] {
  if (geom.type === "LineString") return [geom.coordinates as number[][]];
  if (geom.type === "MultiLineString") return geom.coordinates as number[][][];
  return [];
}

function checkSortedById(ids: string[], where: string): void {
  for (let i = 1; i < ids.length; i++) {
    if (Number(ids[i - 1]) > Number(ids[i])) { fail(`${where}: not sorted by id asc (…${ids[i - 1]} before ${ids[i]})`); return; }
  }
}

function main(): void {
  const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "data/intermediate/staging";
  if (!existsSync(dir)) { console.error(`validate:data: dir not found: ${dir}`); process.exit(1); }

  // --- activities.json ---
  const actPath = join(dir, "activities.json");
  if (!existsSync(actPath)) { console.error(`validate:data: missing ${actPath}`); process.exit(1); }
  const actRaw = readFileSync(actPath, "utf8");
  if (!actRaw.endsWith("\n")) fail("activities.json: missing trailing newline");
  const summaries = JSON.parse(actRaw) as Record<string, unknown>[];
  if (!Array.isArray(summaries)) { console.error("validate:data: activities.json is not an array"); process.exit(1); }

  const distanceById = new Map<string, number>();
  for (const s of summaries) {
    const id = String(s.id ?? "");
    for (const k of Object.keys(s)) if (!SUMMARY_KEYS.has(k)) fail(`activities.json[${id}]: unexpected key "${k}"`);
    if (typeof s.id !== "string" || !s.id) fail(`activities.json[${id}]: id must be a non-empty string`);
    if (typeof s.name !== "string") fail(`activities.json[${id}]: name must be a string`);
    if (typeof s.type !== "string" || !s.type) fail(`activities.json[${id}]: type must be a non-empty string`);
    if (typeof s.date !== "string" || !DATE_RE.test(s.date)) fail(`activities.json[${id}]: date "${String(s.date)}" not YYYY-MM-DD`);
    if (typeof s.year !== "number" || (typeof s.date === "string" && Number(s.date.slice(0, 4)) !== s.year)) fail(`activities.json[${id}]: year mismatch`);
    for (const k of ["distanceMeters", "movingTimeSeconds", "elevationGainMeters"] as const) {
      if (s[k] !== undefined && (typeof s[k] !== "number" || !Number.isFinite(s[k] as number))) fail(`activities.json[${id}]: ${k} must be a finite number`);
    }
    if (s.stravaUrl !== undefined && (typeof s.stravaUrl !== "string" || !(s.stravaUrl as string).startsWith("https://www.strava.com/activities/"))) fail(`activities.json[${id}]: bad stravaUrl`);
    if (typeof s.distanceMeters === "number") distanceById.set(id, s.distanceMeters);
  }
  checkSortedById(summaries.map((s) => String(s.id)), "activities.json");
  const summaryIds = new Set(summaries.map((s) => String(s.id)));

  // --- tracks-<year>.geojson shards ---
  const shardFiles = readdirSync(dir).filter((f) => /^tracks-\d{4}\.geojson$/.test(f)).sort();
  const geoIds = new Set<string>();
  let worstRatio = 1;
  for (const file of shardFiles) {
    const yearFromName = Number(file.slice("tracks-".length, "tracks-".length + 4));
    const raw = readFileSync(join(dir, file), "utf8");
    if (!raw.endsWith("\n")) fail(`${file}: missing trailing newline`);
    const fc = JSON.parse(raw) as { type: string; features: Record<string, unknown>[] };
    if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) { fail(`${file}: not a FeatureCollection`); continue; }
    const ids: string[] = [];
    for (const feat of fc.features) {
      const props = (feat.properties ?? {}) as Record<string, unknown>;
      const id = String(props.id ?? "");
      ids.push(id);
      geoIds.add(id);
      if (feat.type !== "Feature") fail(`${file}[${id}]: not a Feature`);
      for (const k of Object.keys(props)) if (!GEO_PROP_KEYS.has(k)) fail(`${file}[${id}]: unexpected property key "${k}"`);
      if (typeof props.date !== "string" || !DATE_RE.test(props.date)) fail(`${file}[${id}]: date not YYYY-MM-DD`);
      if (props.year !== yearFromName) fail(`${file}[${id}]: year ${String(props.year)} != shard ${yearFromName}`);
      if (!summaryIds.has(id)) fail(`${file}[${id}]: id absent from activities.json`);

      const geom = feat.geometry as { type: string; coordinates: unknown };
      const segs = lineSegments(geom);
      if (segs.length === 0) { fail(`${file}[${id}]: geometry must be LineString/MultiLineString`); continue; }
      let pts = 0, length = 0;
      let prev: number[] | null = null;
      for (const seg of segs) {
        for (const pt of seg) {
          pts++;
          if (!Array.isArray(pt) || pt.length !== 2) { fail(`${file}[${id}]: bad coordinate`); continue; }
          const [lng, lat] = pt;
          if (decimals(lng) > 5 || decimals(lat) > 5) fail(`${file}[${id}]: coordinate exceeds 5 decimals`);
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) fail(`${file}[${id}]: coordinate out of range`);
          if (prev) length += haversineMeters(prev, pt);
          prev = pt;
        }
        prev = null; // don't bridge across MultiLineString segments
      }
      if (pts < 2) fail(`${file}[${id}]: fewer than 2 points`);
      const stored = distanceById.get(id);
      if (stored && stored > 0 && length > 0) {
        const ratio = length / stored;
        worstRatio = Math.abs(Math.log(ratio)) > Math.abs(Math.log(worstRatio)) ? ratio : worstRatio;
        if (ratio > DIST_RATIO_TOLERANCE || ratio < 1 / DIST_RATIO_TOLERANCE) {
          fail(`${file}[${id}]: distance sanity — stored ${stored}m vs GPS ${length.toFixed(0)}m (ratio ${ratio.toFixed(2)})`);
        }
      }
    }
    checkSortedById(ids, file);
  }

  // --- V7-style id-set consistency ---
  for (const id of summaryIds) if (!geoIds.has(id)) fail(`id ${id} in activities.json but no track feature`);
  for (const id of geoIds) if (!summaryIds.has(id)) fail(`id ${id} in a track shard but not activities.json`);

  console.log(`[validate] dir: ${dir}`);
  console.log(`[validate] activities.json: ${summaries.length} summaries`);
  console.log(`[validate] track shards: ${shardFiles.length} (${shardFiles.join(", ") || "none"}); ${geoIds.size} features`);
  console.log(`[validate] worst distance ratio (GPS/stored): ${worstRatio.toFixed(2)}`);
  if (errors.length) {
    console.error(`\n[validate] FAILED with ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`[validate] OK — all DATA.md schema + determinism checks passed`);
}

main();
