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

## M2 — Importer v0 against the real export (staging only)  [BLOCKED: needs archive zip from Wayne]

Question: can Wayne's actual Strava archive be turned into artifacts matching
`docs/DATA.md`, deterministically?

Work:
- Extend `.gitignore`: `data/raw/`, `data/private/`, `data/intermediate/`,
  `*.gpx`, `*.tcx`, `*.fit`, `*.fit.gz`, `*.tcx.gz`, `*.zip`.
- `scripts/import-strava.ts` (`bun run import:strava -- --zip <path>`):
  unzip into `data/raw/` → read `activities.csv` (gotchas in DATA.md
  §export-format) → decompress `.gz` → parse GPX/TCX (fast-xml-parser) and
  FIT (@garmin/fitsdk) → normalize → apply include list → write artifacts to
  `data/intermediate/staging/` (NOT `public/`).
- `scripts/validate-data.ts` (`bun run validate:data -- <dir>`): at this
  stage, schema + determinism checks from DATA.md; PRIVACY.md assertions are
  added in M3.
- Write `docs/EXPORT-RECON.md`: file counts by extension, CSV header
  language, count and reasons for unparseable files, chosen parser plan.

Exit:
- [ ] Importer runs clean on the real zip; parse-failure rate recorded in
      EXPORT-RECON.md
- [ ] Determinism: two consecutive runs → `diff -r` of the two staging
      outputs is empty
- [ ] `bun run validate:data -- data/intermediate/staging` green
- [ ] `git status` shows nothing raw staged; nothing under `public/data/`
      changed

---

## M3 — Privacy layer, then first real publish

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
- [ ] validate:data green on the full real dataset
- [ ] Wayne signs off the inspection checklist
- [ ] First commit of `public/data/activities.json` + `tracks-*.geojson`;
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

Exit:
- [ ] Toggling type/year adds/removes lines without a reload
- [ ] Popups render correct metadata; Strava links open in a new tab
- [ ] Usable on a phone-sized viewport

---

## M5 — Polish + runbook

Work:
- Stats panel aggregated from `activities.json` (counts, total distance, by
  type/year).
- Loading and empty states.
- README runbook for the update loop: request export → import → validate →
  inspect → commit → CD deploys.

Exit:
- [ ] A future session can update the data using only the README
- [ ] Wayne is willing to link the site from www.waynewen.com

---

## M6 — Gate: Strava API sync  [v2 — do not start unprompted]

This is a decision point, not a task. Open only if manual updates become
annoying in practice.

Preconditions before any implementation:
- Re-read the then-current Strava API agreement; confirm displaying derived
  data on a public personal site complies.
- Server-side only: GitHub Actions cron → refresh-token flow → fetch delta →
  run the SAME import + validate pipeline → open a PR. Tokens live only in
  Actions secrets. The browser never talks to Strava.
