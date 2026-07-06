# workout-map-vite — Claude Code context

Static, single-page activity map for Wayne Wen. Renders sanitized GPS tracks
derived from Strava bulk exports on an interactive MapLibre map. Deployed on
Vercel at https://map.waynewen.com via push-to-main CD (already verified, M0).

## Stack

- Bun — package manager AND script runner. Run TS scripts directly:
  `bun scripts/foo.ts`. No tsx / ts-node.
- Vite 8 + React 19 + TypeScript
- Tailwind CSS v4 via `@tailwindcss/vite` plugin. No postcss config;
  `src/index.css` is a single `@import "tailwindcss";`
- MapLibre GL JS. Basemap: OpenFreeMap `https://tiles.openfreemap.org/styles/dark`
  (no API key; fall back to `/styles/positron` if dark is unavailable)
- Lint: oxlint (`bun run lint`)

## Commands

- `bun run dev` — dev server
- `bun run build` — `tsc -b && vite build`; must pass before every commit
- `bun run lint`
- Data scripts (exist from M2 on):
  - `bun run import:strava -- --zip <path>`
  - `bun run validate:data [-- <dir>]`

## Repository layout

- `src/` — app code
- `scripts/` — importer pipeline (TS, run with bun)
- `public/data/` — ONLY sanitized generated artifacts (committed);
  `public/data/fixtures/` is the one hand-written exception
- `data/raw/`, `data/private/`, `data/intermediate/` — gitignored, never committed
- `docs/PLAN.md` — milestones + exit criteria (the work queue)
- `docs/DATA.md` — public artifact schemas + determinism rules
- `docs/PRIVACY.md` — threat model + hard invariants

## Working agreement

1. Work milestone by milestone per `docs/PLAN.md`. Do not start milestone
   N+1 before N's exit criteria pass.
2. A milestone's Exit block is the definition of done. Where a command is
   given, run it — do not close by inspection.
3. Read `docs/PRIVACY.md` before touching anything in `scripts/` or
   `public/data/`. Its invariants are hard rules, not guidelines.
4. Prefer the smallest change that turns the verifier green. Anything under
   "Not building yet" is off-limits without explicit instruction from Wayne.
5. When a task appears to require breaking a hard rule, stop and leave a
   question for Wayne instead of working around it.

## Hard rules (privacy-critical)

- NEVER commit anything under `data/raw/`, `data/private/`,
  `data/intermediate/`, or any `*.gpx`, `*.tcx`, `*.fit`, `*.zip`
  (including `.gz` variants).
- NEVER print, echo, copy, or embed coordinates from
  `data/private/privacy-zones.json` into code, logs, tests, docs, error
  messages, or commit messages.
- `public/data/` (fixtures excepted) changes only via
  `bun run import:strava` followed by a green `bun run validate:data`.
  Never hand-edit generated artifacts.

## Not building yet (each has a trigger; do not pre-build)

- deck.gl — only if MapLibre line layers measurably drop frames on the full
  dataset
- heat.geojson / HeatmapLayer — the heat look comes from translucent
  overlapping lines; a separate artifact is redundant
- PMTiles — only if gzipped total of `tracks-*.geojson` exceeds ~10 MB
- Strava API sync / OAuth — v2 gate, see PLAN.md M6; browser never talks to
  Strava under any design
- Multi-user, auth, analytics dashboards
