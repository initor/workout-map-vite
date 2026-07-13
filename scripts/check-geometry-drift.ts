// scripts/check-geometry-drift.ts
//
// Compares the working-tree public/data/tracks-*.geojson against the committed
// (git HEAD) shards and reports whether any TRACK GEOMETRY changed: new tracks,
// removed tracks, or changed coordinates. Feature PROPERTIES (name, elevation,
// stravaUrl, ...) are intentionally ignored — they carry no new location surface.
//
// This is the gate for the data-update runbook (README): it decides whether
// Wayne's PRIVACY.md inspection is required for an update.
//   - ADDITIVE ("NO geometry change" / only new tracks) -> inspection OPTIONAL.
//   - MUTATING (changed or removed geometry)            -> run the inspection FIRST.
// The ADDITIVE/MUTATING classifier is shared with sync-rides.ts (geometry-diff.ts).
//
// PRIVACY: prints only activity ids and counts, never coordinates (T5).
//
// Usage: bun scripts/check-geometry-drift.ts

import { execSync } from "node:child_process";
import { basename } from "node:path";
import { geomById, shardGeomFromDir, classify } from "./geometry-diff.ts";

const DIR = "public/data";
const SHARD_RE = /^tracks-\d{4}\.geojson$/;

function headFile(path: string): string | null {
  try {
    return execSync(`git show HEAD:${path}`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; } // absent in HEAD (a brand-new shard)
}
function headShards(): string[] {
  try {
    return execSync(`git ls-tree --name-only -r HEAD ${DIR}`, { encoding: "utf8" })
      .split("\n").map((s) => basename(s.trim())).filter((f) => SHARD_RE.test(f));
  } catch { return []; }
}

function main(): void {
  // before = committed (HEAD) geometry; after = working-tree geometry.
  const before = new Map<string, string>();
  for (const shard of headShards()) { const raw = headFile(`${DIR}/${shard}`); if (raw) geomById(raw, before); }
  const after = shardGeomFromDir(DIR);
  const { added, removed, changed, mutating } = classify(before, after);

  console.log(`[geometry-drift] new tracks: ${added.length}  removed: ${removed.length}  changed geometry: ${changed.length}`);
  if (added.length) console.log(`  new ids:     ${added.join(", ")}`);
  if (removed.length) console.log(`  removed ids: ${removed.join(", ")}`);
  if (changed.length) console.log(`  changed ids: ${changed.join(", ")}`);
  if (!mutating && added.length === 0) {
    console.log(`\n[geometry-drift] NO track geometry changed vs HEAD (properties/stats only).`);
    console.log(`  => No new privacy surface. Wayne's PRIVACY.md inspection is OPTIONAL for this update.`);
  } else if (!mutating) {
    console.log(`\n[geometry-drift] ADDITIVE vs HEAD: ${added.length} new track(s), nothing previously published changed.`);
    console.log(`  => Inspect the new tracks per PRIVACY.md before committing.`);
  } else {
    console.log(`\n[geometry-drift] MUTATING vs HEAD: ${changed.length} changed, ${removed.length} removed.`);
    console.log(`  => Previously published geometry moved. Run Wayne's PRIVACY.md inspection BEFORE committing.`);
  }
}

main();
