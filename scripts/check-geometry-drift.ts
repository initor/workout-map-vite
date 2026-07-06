// scripts/check-geometry-drift.ts
//
// Compares the working-tree public/data/tracks-*.geojson against the committed
// (git HEAD) shards and reports whether any TRACK GEOMETRY changed: new tracks,
// removed tracks, or changed coordinates. Feature PROPERTIES (name, elevation,
// stravaUrl, ...) are intentionally ignored — they carry no new location surface.
//
// This is the gate for the data-update runbook (README): it decides whether
// Wayne's PRIVACY.md inspection is required for an update.
//   - "NO geometry change" -> only properties/stats moved; inspection OPTIONAL.
//   - "GEOMETRY CHANGED"    -> new/changed tracks; run the inspection FIRST.
//
// PRIVACY: prints only activity ids and counts, never coordinates (T5).
//
// Usage: bun scripts/check-geometry-drift.ts

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const DIR = "public/data";
const SHARD_RE = /^tracks-\d{4}\.geojson$/;

interface Feature { properties?: { id?: string }; geometry?: unknown }
interface FC { features?: Feature[] }

// id -> serialized geometry (properties deliberately excluded).
function geomById(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  const fc = JSON.parse(raw) as FC;
  for (const f of fc.features ?? []) {
    const id = String(f.properties?.id ?? "");
    if (id) m.set(id, JSON.stringify(f.geometry));
  }
  return m;
}

function headFile(path: string): string | null {
  try {
    return execSync(`git show HEAD:${path}`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; } // absent in HEAD (a brand-new shard)
}

function headShards(): string[] {
  try {
    return execSync(`git ls-tree --name-only HEAD ${DIR}`, { encoding: "utf8" })
      .split("\n").map((s) => basename(s.trim())).filter((f) => SHARD_RE.test(f));
  } catch { return []; }
}

function main(): void {
  const wtShards = existsSync(DIR) ? readdirSync(DIR).filter((f) => SHARD_RE.test(f)) : [];
  const shards = [...new Set([...wtShards, ...headShards()])].sort();

  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const shard of shards) {
    const path = join(DIR, shard);
    const headRaw = headFile(path);
    const wtRaw = existsSync(path) ? readFileSync(path, "utf8") : null;
    const oldG = headRaw ? geomById(headRaw) : new Map<string, string>();
    const newG = wtRaw ? geomById(wtRaw) : new Map<string, string>();
    for (const [id, g] of newG) {
      if (!oldG.has(id)) added.push(id);
      else if (oldG.get(id) !== g) changed.push(id);
    }
    for (const id of oldG.keys()) if (!newG.has(id)) removed.push(id);
  }

  const drift = added.length + removed.length + changed.length;
  console.log(`[geometry-drift] shards: ${shards.join(", ") || "none"}`);
  console.log(`[geometry-drift] new tracks: ${added.length}  removed: ${removed.length}  changed geometry: ${changed.length}`);
  if (added.length) console.log(`  new ids:     ${added.join(", ")}`);
  if (removed.length) console.log(`  removed ids: ${removed.join(", ")}`);
  if (changed.length) console.log(`  changed ids: ${changed.join(", ")}`);
  if (drift === 0) {
    console.log(`\n[geometry-drift] NO track geometry changed vs HEAD (properties/stats only).`);
    console.log(`  => No new privacy surface. Wayne's PRIVACY.md inspection is OPTIONAL for this update.`);
  } else {
    console.log(`\n[geometry-drift] TRACK GEOMETRY CHANGED vs HEAD.`);
    console.log(`  => Run Wayne's PRIVACY.md inspection checklist BEFORE committing.`);
  }
}

main();
