// scripts/sync-rides.ts
//
//   bun run sync:rides             fetch NEW ride FITs from Hammerhead into the
//                                  append-only corpus data/raw/hammerhead/. Does
//                                  NOT rebuild public/data (run `bun run update`-
//                                  style import + validate + geometry check after,
//                                  gated on the PRIVACY.md inspection).
//   bun run sync:rides -- --probe  M8 exit proof (test-only): fetch ONE recent
//                                  ride to a scratch dir, clip it, and compare its
//                                  geometry to the export-derived version of the
//                                  SAME ride. Writes NOTHING to the corpus or
//                                  public/data.
//
// SECRETS (the whole surface, for review):
//   - Client id/secret read from data/private/hammerhead.env (gitignored).
//   - Tokens persisted to      data/private/hammerhead-token.json (gitignored),
//     0600. Rotating refresh: the latest refresh token is written back each time.
//   - Requests ONLY the `activity:read` scope. Redirect http://localhost:3001.
//   - NEVER logs the secret, any token, coordinates, or startEpochSeconds.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync, cpSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { clipTrack } from "./clip.ts";
import type { Zone } from "./clip.ts";
import { parseFit } from "./fit.ts";
import { classify, shardGeomFromDir } from "./geometry-diff.ts";
import { hammerheadRideFromFit, clipRideToArtifacts, byId, serializeFeatureCollection, type Feature, type Summary } from "./import-strava.ts";

const ENV_PATH = "data/private/hammerhead.env";
const TOKEN_PATH = "data/private/hammerhead-token.json";
const ZONES_PATH = "data/private/privacy-zones.json";
const HAMMERHEAD_DIR = "data/raw/hammerhead";
const EXPORT_ACTIVITIES = "data/raw/export/activities";
const PROBE_DIR = "data/intermediate/probe";
const PUBLIC_DIR = "public/data";
const SNAPSHOT_DIR = "data/intermediate/sync-snapshot";
const PUBLIC_ACTIVITIES = "public/data/activities.json";
// generated (non-fixture) artifacts, for snapshot/restore in the additive guard.
const GEN_RE = /^(activities|places|stats)\.json$|^tracks-\d{4}\.geojson$/;

const AUTH_BASE = "https://api.hammerhead.io/v1/auth";
const API_BASE = "https://api.hammerhead.io/v1/api";
const REDIRECT_URI = "http://localhost:3001";
const CALLBACK_PORT = 3001;
const SCOPE = "activity:read";
const EXPIRY_SKEW_MS = 60_000;

interface Token { access_token: string; refresh_token: string; expires_at: number; user_id: string }
interface ApiActivity { id: string; name?: string; createdAt?: string }

// --- secrets: read, never echo ---------------------------------------------
function loadCreds(): { clientId: string; clientSecret: string } {
  if (!existsSync(ENV_PATH)) throw new Error(`[sync] ${ENV_PATH} missing (HAMMERHEAD_CLIENT_ID / HAMMERHEAD_CLIENT_SECRET).`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq > 0) env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  const clientId = env.HAMMERHEAD_CLIENT_ID, clientSecret = env.HAMMERHEAD_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error(`[sync] ${ENV_PATH} must define HAMMERHEAD_CLIENT_ID and HAMMERHEAD_CLIENT_SECRET.`);
  return { clientId, clientSecret };
}

function loadToken(): Token | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as Token; } catch { return null; }
}
function saveToken(t: Token): void {
  mkdirSync("data/private", { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2) + "\n");
  try { chmodSync(TOKEN_PATH, 0o600); } catch { /* best effort */ }
  console.log(`[sync] token saved to ${TOKEN_PATH} (expires ${new Date(t.expires_at).toISOString()})`);
}

// --- OAuth ------------------------------------------------------------------
async function postToken(body: Record<string, string>): Promise<Token> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`[sync] token endpoint HTTP ${res.status}`); // body may contain secrets; not logged
  const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; user_id: string };
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + j.expires_in * 1000, user_id: j.user_id };
}

// One-time consent via a localhost:3001 listener. Prints the authorize URL for
// the user to open; captures the ?code once Hammerhead redirects back.
async function authorizeInteractive(clientId: string): Promise<Token> {
  const state = randomUUID();
  const authUrl = `${AUTH_BASE}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPE)}&state=${state}`;

  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port: CALLBACK_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/") return new Response("Not found", { status: 404 });
        const err = url.searchParams.get("error");
        const gotState = url.searchParams.get("state");
        const gotCode = url.searchParams.get("code");
        if (err) { server.stop(); reject(new Error(`[sync] authorization denied: ${err}`)); return new Response("Authorization denied. You can close this tab.", { status: 400 }); }
        if (gotState !== state) { return new Response("State mismatch — ignoring.", { status: 400 }); }
        if (!gotCode) { return new Response("Waiting for authorization…", { status: 400 }); }
        setTimeout(() => server.stop(), 100);
        resolve(gotCode);
        return new Response("Hammerhead authorization received. You can close this tab and return to the terminal.", { headers: { "content-type": "text/plain" } });
      },
    });
    console.log(`\n[sync] Open this URL, sign in to Hammerhead, and grant ONLY "activity:read":\n\n  ${authUrl}\n\n[sync] waiting for the redirect to ${REDIRECT_URI} …`);
  });

  const { clientSecret } = loadCreds();
  return postToken({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
}

async function ensureToken(): Promise<Token> {
  const { clientId, clientSecret } = loadCreds();
  const existing = loadToken();
  if (existing && Date.now() < existing.expires_at - EXPIRY_SKEW_MS) return existing;
  if (existing?.refresh_token) {
    try {
      console.log("[sync] access token expired; refreshing…");
      const t = await postToken({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: existing.refresh_token });
      saveToken(t); // rotation: persist the new refresh token
      return t;
    } catch { console.log("[sync] refresh failed; falling back to full authorization."); }
  }
  const t = await authorizeInteractive(clientId);
  saveToken(t);
  return t;
}

// --- API --------------------------------------------------------------------
async function apiGet(token: Token, path: string): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${token.access_token}` } });
  if (!res.ok) throw new Error(`[sync] GET ${path} HTTP ${res.status}`);
  return res;
}
async function listActivities(token: Token, startDate: string): Promise<ApiActivity[]> {
  const out: ApiActivity[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await apiGet(token, `/activities?perPage=100&page=${page}&startDate=${startDate}`);
    const j = (await res.json()) as { data?: ApiActivity[]; totalPages?: number };
    out.push(...(j.data ?? []));
    if (!j.totalPages || page >= j.totalPages) break;
  }
  return out;
}
async function fetchFitBytes(token: Token, activityId: string): Promise<Uint8Array> {
  const res = await apiGet(token, `/activities/${encodeURIComponent(activityId)}/file`);
  return new Uint8Array(await res.arrayBuffer());
}

// --- helpers ----------------------------------------------------------------
function loadZones(): { seedSalt: string; zones: Zone[] } {
  if (!existsSync(ZONES_PATH)) throw new Error(`[sync] ${ZONES_PATH} missing; cannot clip.`);
  return JSON.parse(readFileSync(ZONES_PATH, "utf8")) as { seedSalt: string; zones: Zone[] };
}
function newestPublishedDate(): string {
  if (!existsSync(PUBLIC_ACTIVITIES)) return "2000-01-01";
  const acts = JSON.parse(readFileSync(PUBLIC_ACTIVITIES, "utf8")) as { date?: string }[];
  return acts.reduce((mx, a) => (a.date && a.date > mx ? a.date : mx), "2000-01-01");
}
function existingHammerheadIds(): Set<string> {
  if (!existsSync(HAMMERHEAD_DIR)) return new Set();
  return new Set(readdirSync(HAMMERHEAD_DIR).filter((f) => f.endsWith(".fit")).map((f) => f.replace(/\.fit$/, "")));
}

// --- additive-invariant guard (snapshot / restore) --------------------------
function snapshotPublicData(): void {
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const f of readdirSync(PUBLIC_DIR).filter((n) => GEN_RE.test(n))) cpSync(join(PUBLIC_DIR, f), join(SNAPSHOT_DIR, f));
}
function restorePublicData(): void {
  for (const f of readdirSync(PUBLIC_DIR).filter((n) => GEN_RE.test(n))) rmSync(join(PUBLIC_DIR, f), { force: true });
  for (const f of readdirSync(SNAPSHOT_DIR)) cpSync(join(SNAPSHOT_DIR, f), join(PUBLIC_DIR, f));
}

// --- modes ------------------------------------------------------------------
async function syncNew(): Promise<void> {
  const token = await ensureToken();
  // Boundary: rides on/after the newest published day are candidates; dedup on
  // startEpochSeconds happens inside the importer across the whole corpus.
  const since = newestPublishedDate();
  const already = existingHammerheadIds();
  const acts = await listActivities(token, since);
  const candidates = acts.filter((a) => !already.has(a.id));
  console.log(`[sync] Hammerhead activities since ${since}: ${acts.length}  |  already in corpus: ${acts.length - candidates.length}  |  new: ${candidates.length}`);
  if (candidates.length === 0) { console.log("[sync] nothing new; public/data unchanged."); return; }

  // Additive-invariant guard: snapshot public/data, apply the merge, and refuse
  // to keep a result that changed any previously published geometry.
  const before = shardGeomFromDir(PUBLIC_DIR);
  snapshotPublicData();
  const fetched: string[] = [];
  mkdirSync(HAMMERHEAD_DIR, { recursive: true });
  for (const a of candidates) {
    const path = join(HAMMERHEAD_DIR, `${a.id}.fit`);
    writeFileSync(path, await fetchFitBytes(token, a.id));
    fetched.push(path);
  }
  console.log(`[sync] fetched ${fetched.length} new FIT(s); rebuilding + validating the whole corpus...`);
  execSync("bun scripts/import-strava.ts", { stdio: "inherit" });
  execSync("bun scripts/validate-data.ts public/data", { stdio: "inherit" });

  const cls = classify(before, shardGeomFromDir(PUBLIC_DIR));
  if (cls.mutating) {
    restorePublicData();
    for (const p of fetched) rmSync(p, { force: true });
    rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    console.error(`\n[sync] ABORT — MUTATING diff: ${cls.changed.length} published ride(s) changed geometry, ${cls.removed.length} removed.`);
    console.error(`[sync] FIT passthrough does not hold for: ${[...cls.changed, ...cls.removed].join(", ") || "(n/a)"}`);
    console.error(`[sync] restored public/data and removed the ${fetched.length} just-fetched FIT(s). Investigate before retrying.`);
    process.exit(2);
  }
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  console.log(`\n[sync] ADDITIVE — ${cls.added.length} new ride(s); no previously published geometry changed.`);
  console.log(`[sync] public/data updated (uncommitted). New ids: ${cls.added.join(", ") || "(none)"}`);
  console.log(`[sync] run the PRIVACY.md inspection on the new tracks, then commit.`);
}

// Exit-criterion-2 proof: fetch a recent ride that is ALSO in the export, clip
// both through the SAME pipeline, and compare. Writes only to PROBE_DIR (scratch).
async function probe(): Promise<void> {
  const token = await ensureToken();
  const { seedSalt, zones } = loadZones();
  mkdirSync(PROBE_DIR, { recursive: true });

  // Index the export corpus by startEpochSeconds (parse is cheap for ~300 FITs).
  const exportByStart = new Map<number, string>(); // startEpochSeconds -> filename
  for (const f of readdirSync(EXPORT_ACTIVITIES)) {
    try {
      const p = parseFit(readFileSync(join(EXPORT_ACTIVITIES, f)));
      if (p.startEpochSeconds !== undefined && p.coords.length >= 2) exportByStart.set(p.startEpochSeconds, f);
    } catch { /* skip undecodable */ }
  }

  const acts = await listActivities(token, "2000-01-01");
  acts.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")); // newest first
  for (const a of acts) {
    const apiFit = parseFit(await fetchFitBytes(token, a.id));
    if (apiFit.startEpochSeconds === undefined || apiFit.coords.length < 2) continue;
    // find export ride within +-60 s
    let exportFile: string | undefined, exportStart: number | undefined;
    for (const [se, file] of exportByStart) if (Math.abs(se - apiFit.startEpochSeconds) <= 60) { exportFile = file; exportStart = se; break; }
    if (!exportFile || exportStart === undefined) continue; // this API ride isn't in the export; try the next

    const exportFit = parseFit(readFileSync(join(EXPORT_ACTIVITIES, exportFile)));
    const gApi = clipTrack(apiFit.coords, zones, seedSalt, apiFit.startEpochSeconds);
    const gExport = clipTrack(exportFit.coords, zones, seedSalt, exportStart);
    const sApi = JSON.stringify(gApi?.segments ?? null), sExport = JSON.stringify(gExport?.segments ?? null);
    writeFileSync(join(PROBE_DIR, "api-clipped.json"), sApi + "\n");
    writeFileSync(join(PROBE_DIR, "export-clipped.json"), sExport + "\n");
    const identical = sApi === sExport;
    console.log(`\n[probe] matched a recent ride present in both sources (start epochs within 60 s).`);
    console.log(`[probe] API points: ${apiFit.coords.length}  export points: ${exportFit.coords.length}  seed delta: ${apiFit.startEpochSeconds - exportStart} s`);
    console.log(`[probe] clipped geometry byte-identical: ${identical ? "YES — FIT passthrough confirmed" : "NO — Strava re-encodes on export; see " + PROBE_DIR}`);
    console.log(`[probe] wrote ${PROBE_DIR}/{api,export}-clipped.json  (scratch; nothing merged)`);
    return;
  }
  console.log("[probe] no recent API ride found that is also in the export corpus; sync an older window or widen the export.");
}

// CI / incremental sync (M9): CI has no local corpus, so instead of a full
// rebuild it fetches rides since the newest published day, clips each, dedups by
// clipped-geometry against committed public/data (FIT passthrough => an already-
// published ride clips byte-identical and is skipped), and APPENDS the genuinely-
// new ones. Append-only => ADDITIVE by construction; validated + guarded anyway.
// A CI-appended track is byte-identical to a later local rebuild (shared builders).
// `--dry-run` reports what it would append without writing.
async function ciSync(dryRun: boolean): Promise<void> {
  const { seedSalt, zones } = loadZones();
  const since = newestPublishedDate();
  const publishedGeom = shardGeomFromDir(PUBLIC_DIR);      // id -> geometry string (baseline)
  const publishedIds = new Set(publishedGeom.keys());
  const publishedGeomSet = new Set(publishedGeom.values());

  const token = await ensureToken();
  const acts = await listActivities(token, since);

  const newSummaries: Summary[] = [], newFeatures: Feature[] = [], newIds: string[] = [];
  let skipped = 0, droppedClip = 0;
  for (const a of acts) {
    if (publishedIds.has(a.id)) { skipped++; continue; }                     // already synced (same id)
    const ride = hammerheadRideFromFit(a.id, parseFit(await fetchFitBytes(token, a.id)));
    if (!ride) continue;
    const art = clipRideToArtifacts(ride, zones, seedSalt);
    if (!art) { droppedClip++; continue; }
    if (publishedGeomSet.has(JSON.stringify(art.feature.geometry))) { skipped++; continue; } // already published (other id; passthrough)
    newSummaries.push(art.summary); newFeatures.push(art.feature); newIds.push(a.id);
  }

  console.log(`[ci] since ${since}: ${acts.length} activities | already published: ${skipped} | clip-dropped: ${droppedClip} | NEW: ${newIds.length}`);
  if (newIds.length === 0) { console.log("[ci] nothing new; public/data unchanged."); return; }
  if (dryRun) { console.log(`[ci] --dry-run: would append ${newIds.length}: ${newIds.join(", ")}`); return; }

  // Append additively to activities.json + the per-year shards, re-sorted by id.
  const acts2 = JSON.parse(readFileSync(PUBLIC_ACTIVITIES, "utf8")) as Summary[];
  writeFileSync(PUBLIC_ACTIVITIES, JSON.stringify([...acts2, ...newSummaries].sort(byId), null, 2) + "\n");
  const byYear = new Map<number, Feature[]>();
  for (const f of newFeatures) { const y = f.properties.year as number; const arr = byYear.get(y) ?? []; arr.push(f); byYear.set(y, arr); }
  for (const [year, feats] of byYear) {
    const shard = join(PUBLIC_DIR, `tracks-${year}.geojson`);
    const existing = existsSync(shard) ? (JSON.parse(readFileSync(shard, "utf8")).features as Feature[]) : [];
    const merged = [...existing, ...feats].sort((a, b) => byId({ id: String(a.properties.id) }, { id: String(b.properties.id) }));
    writeFileSync(shard, serializeFeatureCollection(merged));
  }

  execSync("bun scripts/validate-data.ts public/data", { stdio: "inherit" });
  const cls = classify(publishedGeom, shardGeomFromDir(PUBLIC_DIR));
  if (cls.mutating) {
    console.error(`[ci] FATAL — MUTATING (${cls.changed.length} changed, ${cls.removed.length} removed): ${[...cls.changed, ...cls.removed].join(", ")}`);
    process.exit(2);
  }
  console.log(`[ci] ADDITIVE — appended ${cls.added.length} new track(s): ${cls.added.join(", ")}`);
  console.log(`SYNC_NEW_IDS=${newIds.join(",")}`); // consumed by the workflow for the PR body
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--probe")) await probe();
  else if (args.includes("--ci")) await ciSync(args.includes("--dry-run"));
  else await syncNew();
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
