// scripts/geometry-diff.ts
//
// Shared track-geometry diff + ADDITIVE/MUTATING classification, used by
// check-geometry-drift.ts (working tree vs git HEAD) and sync-rides.ts (post-sync
// public/data vs a pre-sync snapshot). One definition so both gates agree.
//
// Compares FEATURE GEOMETRY by activity id; feature properties are intentionally
// ignored (they carry no new location surface).
//
// PRIVACY: operates on already-clipped public geometry only; prints nothing here
// (callers report ids + counts, never coordinates — T5).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SHARD_RE = /^tracks-\d{4}\.geojson$/;

interface Feature { properties?: { id?: string }; geometry?: unknown }
interface FC { features?: Feature[] }

// id -> serialized geometry, from one FeatureCollection's raw JSON.
export function geomById(raw: string, into: Map<string, string> = new Map()): Map<string, string> {
  const fc = JSON.parse(raw) as FC;
  for (const f of fc.features ?? []) {
    const id = String(f.properties?.id ?? "");
    if (id) into.set(id, JSON.stringify(f.geometry));
  }
  return into;
}

// id -> serialized geometry, merged across every tracks-*.geojson shard in a dir.
export function shardGeomFromDir(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).filter((n) => SHARD_RE.test(n)).sort()) {
    geomById(readFileSync(join(dir, f), "utf8"), m);
  }
  return m;
}

export interface Drift {
  added: string[];    // ids present only in `after`  (new tracks)
  removed: string[];  // ids present only in `before` (a published track vanished)
  changed: string[];  // ids in both whose geometry differs
  mutating: boolean;  // true iff any previously-published geometry changed or vanished
}

// ADDITIVE  = every `before` id survives with byte-identical geometry (new ids ok).
// MUTATING  = any previously-published feature changed geometry or disappeared.
export function classify(before: Map<string, string>, after: Map<string, string>): Drift {
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const [id, g] of after) if (!before.has(id)) added.push(id);
  for (const [id, g] of before) {
    if (!after.has(id)) removed.push(id);
    else if (after.get(id) !== g) changed.push(id);
  }
  return { added, removed, changed, mutating: changed.length > 0 || removed.length > 0 };
}
