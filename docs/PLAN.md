# PLAN — milestones and exit criteria

One question per milestone. A milestone closes only when every line of its
Exit block is verified — by running the command where one is given, not by
inspection. Update Status tags in place as work proceeds.

---

## M0 — Pipeline proof  [DONE 2026-07-05]

Question: does repo → Vercel CD → DNS → TLS work end to end?

Exit (met): `https://map.waynewen.com` serves the placeholder over TLS; a
one-line change pushed to main auto-deploys.

---

## M1 — Base map + fixture tracks  [DONE 2026-07-05]

Question: does the full rendering chain — static GeoJSON → MapLibre source →
line layer — work in production?

Work:
- `bun add maplibre-gl`
- Full-screen MapLibre map: style
  `https://tiles.openfreemap.org/styles/dark` (fallback `/styles/positron`),
  center on Palo Alto, zoom ~10. Import `maplibre-gl/dist/maplibre-gl.css`.
- Title "Wayne's Activity Map" as a small overlay, top-left.
- Create `public/data/fixtures/tracks-fixture.geojson`: a FeatureCollection
  of 3 hand-written LineStrings near Palo Alto (~20 points each), properties
  per DATA.md GeoJSON schema with invented values. Fixtures are the only
  hand-edited files permitted under `public/data/`.
- Load the fixture as a geojson source; one line layer:
  `line-color #fb923c`, `line-width 2`, `line-opacity 0.6`.

Exit:
- [x] `bun run build` passes
- [x] Production `map.waynewen.com`: draggable dark map with 3 orange lines
- [x] Basemap attribution is visible (OpenFreeMap styles include it; do not
      remove or obscure it)

---

## M2 — Importer v0 against the real export (staging only)  [DONE 2026-07-05]

Question: can Wayne's actual Strava archive be turned into artifacts matching
`docs/DATA.md`, deterministically?

Work:
- Extend `.gitignore`: `data/raw/`, `data/private/`, `data/intermediate/`,
  `*.gpx`, `*.tcx`, `*.fit`, `*.fit.gz`, `*.tcx.gz`, `*.zip`.
- `scripts/import-strava.ts` (`bun run import:strava -- --dir <dir>`):
  read `activities.csv` and the FIT tracks it references from `data/raw/`
  (gotchas in DATA.md's export-format section), decompress `.fit.gz`, parse
  FIT (@garmin/fitsdk; the export is 100% FIT, so GPX/TCX are deferred),
  keep every activity with a usable GPS track, and write artifacts to
  `data/intermediate/staging/` (NOT `public/`).
- `scripts/validate-data.ts` (`bun run validate:data -- <dir>`): at this
  stage, schema + determinism checks from DATA.md; PRIVACY.md assertions are
  added in M3.
- Write `docs/EXPORT-RECON.md`: file counts by extension, CSV header
  language, count and reasons for unparseable files, chosen parser plan.

Exit:
- [x] Importer runs clean on the real zip; parse-failure rate recorded in
      EXPORT-RECON.md
- [x] Determinism: two consecutive runs → `diff -r` of the two staging
      outputs is empty
- [x] `bun run validate:data -- data/intermediate/staging` green
- [x] `git status` shows nothing raw staged; nothing under `public/data/`
      changed

---

## M3 — Privacy layer, then first real publish  [DONE 2026-07-05]

Question: is the published data safe against every threat in
`docs/PRIVACY.md`?

Work:
- Implement clipping exactly per PRIVACY.md §algorithm (seeded jitter,
  endpoint drop, min-remainder drop, 5-decimal rounding last).
- Extend validate:data with every assertion in PRIVACY.md §verifier.
- import:strava hard-fails when `data/private/privacy-zones.json` is absent
  unless `--allow-no-privacy-zones` is passed (which refuses to write to
  `public/data/`).
- Switch the app's data source from fixtures to real per-year shards.
- Wayne performs PRIVACY.md §inspection locally before anything is committed.

Exit:
- [x] validate:data green on the full real dataset
- [x] Wayne signs off the inspection checklist
- [x] First commit of `public/data/activities.json` + `tracks-*.geojson`;
      production renders real tracks

---

## M4 — Filters, popups, Strava links

Question: is it usable as an actual map site?

Work:
- Activity-type toggles; year toggles that lazy-load year shards.
- Click popup: name, date, type, distance, elevation where present; "Open on
  Strava" when `stravaUrl` exists; missing fields degrade gracefully.
- Header link to Wayne's Strava athlete page (URL from a small
  `src/config.ts`; Wayne supplies the athlete id).
- Mobile viewport sanity pass.
- Attribution control compact by default: `attributionControl: { compact: true }`
  on the Map constructor (collapsed to the info button, expandable on click;
  never removed or hidden). [Wayne, 2026-07-05]
- Light/dark theme toggle (dark default; light = positron). `setStyle()` destroys
  custom sources/layers, so wrap source+layer setup in one idempotent function
  and re-run it on `style.load` after every switch. Sync the Tailwind `dark`
  class + a per-theme track color with the map; persist in localStorage. [Wayne, 2026-07-05]

Exit:
- [ ] Toggling type/year adds/removes lines without a reload
- [ ] Popups render correct metadata; Strava links open in a new tab
- [ ] Usable on a phone-sized viewport

---

## M5 — Polish + runbook  [CODE COMPLETE 2026-07-06]

Work:
- Importer (one rerun): added `elevationGainMeters` (CSV Elevation Gain),
  `caloriesKcal` (FIT session total_calories, else CSV Calories), and
  `avgHeartRate`/`maxHeartRate` (FIT session, Ride-scoped — see EXPORT-RECON.md
  recon) to ActivitySummary + GeoJSON properties (`movingTimeSeconds` also carried
  into GeoJSON properties for the popup). New `public/data/stats.json` aggregates
  the FULL `activities.csv` — count + moving time + calories by type and by year
  (each type also split by year), plus `avgHeartRateBpm` (moving-time-weighted
  mean of the CSV Average Heart Rate) on totals + per type, INCLUDING indoor
  activities. Regenerated `public/data/`; track geometry stayed byte-identical to
  the committed shards (properties-only diff). validate:data extended: new fields
  in the V3 allowlist; stats.json carries no date-shaped string and no key outside
  its schema.
- Design pass (per Wayne's approved mockups in `docs/mocks/`): the activity popup
  is a 2-column metric grid (glyph + label over a tabular value; moving time /
  distance / elevation / calories / heart rate, each shown only when present); the
  stats panel is a typographic redesign (headline + summary strip incl. bpm avg +
  caption; a 3-column `dot+name | count× | duration` grid). Two weights, tabular
  figures, color reserved for type. Light theme is the default for a first-time
  visitor (a saved choice still wins).
- UI (color encodes activity type; one control surface):
  - Per-type theme-aware color tokens (Ride orange, Hike violet, Walk teal,
    Workout rose, Crossfit amber), defined once and used consistently in tracks,
    legend dots, hover highlight, and the Home disc. Opacity accumulation encodes
    repeat-frequency per hue. White casing (light theme) sits under all hues.
  - ONE control surface, top-left (identity block + on-page title deleted;
    document `<title>` keeps the name). Header: Strava-orange "Strava" link with
    external-link icon (left), sun/moon theme button (right). Below: totals
    (incl. calories), per-type legend-filter rows with type-color dots, "Showing
    n of m tracks". Collapses to a pill (with the activity count) on small
    viewports. Only other on-map UI is the attribution control, bottom-right.
  - Legend-as-filter, uniform: GPS rows (Ride/Hike/Walk) toggle tracks; indoor
    rows (Workout/Crossfit) toggle the Home marker + disc (count/popup reflect
    enabled types; hidden when all off). Toggled-off = dimmed row; Totals never
    change. All year filtering gone; all shards load up front.
  - Track ergonomics: an invisible fat hit layer (width 14) owns all pointer
    events; hover highlights via feature-state (width 4, full opacity, keeps hue);
    click opens the popup.
  - Basemaps: dark (fallback positron); light = liberty (fallback bright).
    Overlaps accumulate toward "hot" (light casing 0.35 / line 0.55; dark line
    0.5, no casing).
  - One popup design system: `closeButton:false` + our own themed card (panel
    tokens, dark/light aware, custom close; closes on map click and Esc). Activity
    popups show distance/elevation/calories/HR; the Home popup shows the indoor
    total, hours, calories, and by-year split.
  - Home marker: labeled ("Home . <n> workouts") over a saturated heat disc (the
    dominant enabled indoor hue, deepest heat step, theme-aware). Neighborhood-
    precision coordinate unchanged; PRIVACY.md invariants untouched.
  - Favicon replicated from the blog repo. Loading and error states retained.
- README runbook for the update loop: export -> `data/raw` -> import -> validate
  -> geometry-drift check -> inspection ONLY if geometry changed -> commit -> CD.
  New `bun run check:geometry` gates the inspection step.
- `docs/BACKLOG.md` seeded with post-v1 polish (parking lot, not a queue).

Exit:
- [x] A future session can update the data using only the README
      (self-contained runbook + `check:geometry` gate; ready for a dry run)
- [ ] Wayne is willing to link the site from www.waynewen.com  (Wayne's call)

---

## M6 — Gate: Strava API sync  [SUPERSEDED 2026-07-06 — see M7-M9]

This is a decision point, not a task. It was a "revisit when manual updates get
annoying" gate; that revisit happened 2026-07-06.

Reviewed 2026-07-06 (outcome — SUPERSEDED): the Strava API agreement remains
non-compliant for public display of derived data, so the Strava-API path below
stays closed. The same review cleared two alternatives — the Hammerhead API
License (2025-05-22) and the Ride with GPS API (site ToS only) — which carry no
display restrictions, retention mirrors, or AI clauses. Automated sync therefore
migrates OFF Strava, along a new track: M7 seed decoupling -> M8 source recon +
local sync -> M9 CI automation. The original Strava-cron design below is retained
for historical context only.

Preconditions (Strava path — retained for history):
- Re-read the then-current Strava API agreement; confirm displaying derived
  data on a public personal site complies.
- Server-side only: GitHub Actions cron → refresh-token flow → fetch delta →
  run the SAME import + validate pipeline → open a PR. Tokens live only in
  Actions secrets. The browser never talks to Strava.

---

## M7 — Privacy seed decoupling  [DONE 2026-07-06]

Question: can clip geometry be made source-agnostic, so a later migration off
Strava is geometry-invariant?

Work:
- Clip seed keys on the activity start time (UTC epoch seconds, from the source
  recording's first GPS sample) instead of the Strava activity id:
  `u = uniform01(sha256(seedSalt + ":" + startEpochSeconds + ":" + zone.name))`.
  See PRIVACY.md §algorithm and its "Seed basis" note for the rationale.
- `startEpochSeconds` is a seed input ONLY; it never enters any artifact.
  validate:data gains V8 (no epoch-like numeric value in public output).
- PRIVACY.md §algorithm + DATA.md determinism updated in the same PR.
- Regenerate `public/data/` locally. This re-jitters every track once — the one
  sanctioned exception to byte-identity (DATA.md): geometry changes wholesale
  while day-precision dates and every other field stay put.

Exit:
- [x] validate:data green on the full regenerated dataset (incl. V8)
- [x] Determinism holds under the new seed: two consecutive importer runs are
      byte-identical to each other
- [x] Wayne signs off the PRIVACY.md inspection checklist for the re-jittered
      geometry before anything is committed  (ship authorization, 2026-07-06)

---

## M8 — Source recon + local sync  [v2 — not started]

Question: do Hammerhead and Ride with GPS exports carry the same start time and
usable tracks, so the importer can read them instead of Strava?

Work (sketch): confirm each source's export/API exposes a start timestamp equal
to the Strava-derived `startEpochSeconds` (this makes M7's invariance claim
verifiable, not just asserted); add source parsers behind the SAME clip +
validate pipeline; run locally and confirm geometry matches the M7 baseline for
the same rides (geometry-drift = 0).

---

## M9 — CI automation  [v2 — not started]

Question: can the update loop run unattended, without touching Strava?

Work (sketch): GitHub Actions cron → pull the delta from the M8 source(s) → run
the SAME import + validate + geometry-drift pipeline → open a PR for review.
Credentials live only in Actions secrets. Mirrors the retired M6 design, minus
Strava.
