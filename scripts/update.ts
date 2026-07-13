// scripts/update.ts
//
// `bun run update -- --from <dir>` — the quarterly Strava-export refresh.
//
// Replaces the export corpus (data/raw/export/) with a freshly downloaded,
// unzipped Strava bulk export, then rebuilds public/data and verifies. The
// append-only API corpus (data/raw/hammerhead/, owned by sync:rides) is NEVER
// touched — that separation is precisely why a new export cannot delete synced
// rides.
//
// Reads only activities.csv + activities/ from the source (PRIVACY.md R3).
//
// Usage: bun run update -- --from ~/Downloads/strava_export_1234567

import { existsSync, rmSync, cpSync, mkdirSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const EXPORT_DIR = "data/raw/export";

function parseArgs(argv: string[]): { from?: string } {
  let from: string | undefined;
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--from") { from = argv[i + 1]; i++; }
  return { from };
}

function main(): void {
  const { from } = parseArgs(process.argv.slice(2));
  if (!from) { console.error("[update] usage: bun run update -- --from <unzipped-strava-export-dir>"); process.exit(1); }
  if (!existsSync(join(from, "activities.csv")) || !existsSync(join(from, "activities"))) {
    console.error(`[update] ${from} is not a Strava export (needs activities.csv + activities/).`);
    process.exit(1);
  }

  // Surgical replace of the EXPORT corpus only: copy just the two artifacts we
  // read (activities.csv + activities/, PRIVACY.md R3) into a fresh export/,
  // leaving data/raw/hammerhead/ (the append-only API corpus) entirely alone.
  console.log(`[update] replacing ${EXPORT_DIR}/ from ${from}  (hammerhead corpus untouched)`);
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  cpSync(join(from, "activities.csv"), join(EXPORT_DIR, "activities.csv"));
  cpSync(join(from, "activities"), join(EXPORT_DIR, "activities"), { recursive: true });
  console.log(`[update] export/: activities.csv + ${readdirSync(join(EXPORT_DIR, "activities")).length} track file(s)`);

  // Rebuild from the whole corpus (export + hammerhead), validate, and surface
  // whether track geometry moved (=> PRIVACY.md inspection is due before commit).
  const run = (cmd: string) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: "inherit" }); };
  run("bun scripts/import-strava.ts");
  run("bun scripts/validate-data.ts public/data");
  run("bun scripts/check-geometry-drift.ts");
  console.log(`\n[update] done. If geometry changed above, run the PRIVACY.md inspection before committing public/data/.`);
}

main();
