# EXPORT-RECON — Strava bulk-export reconnaissance (M2)

Findings from running the M2 importer against Wayne's real export at
`data/raw/` (gitignored). No coordinates, names, or non-activity personal
data appear here (PRIVACY.md R3/T5).

## Archive shape

- `activities.csv`: 285 activities (logical records). The file has ~1800
  *physical* lines because descriptions contain embedded newlines inside
  quoted fields, so a naive line count is wrong; a real CSV parser is
  mandatory.
- `activities/`: **284 track files, all `.fit.gz`**. Zero `.gpx`, `.tcx.gz`,
  or other formats.
- CSV header language: **English** (not localized in this export).

## File counts by extension

| Extension | Count |
|-----------|------:|
| `.fit.gz` | 284   |
| `.gpx` / `.tcx.gz` / other | 0 |

## Include predicate: usable GPS track

Every activity with a decoded GPS track of >=2 points is imported; the rest
are dropped (nothing to render). `type` is carried through from Strava
verbatim — display metadata, never a filter.

| Activity Type | In CSV | Usable GPS track (>=2 pts) |
|---------------|-------:|---------------------------:|
| Ride          | 32     | 32 |
| Workout       | 248    | 0  |
| Hike          | 2      | 2  |
| Crossfit      | 2      | 0  |
| Walk          | 1      | 1  |

**35 imported** (Ride 32, Hike 2, Walk 1). The 248 "Workout" + 2 "Crossfit"
entries have FIT files but **no GPS points** — they are indoor (HR / power /
cadence only), so the GPS predicate drops them. (This happens to be the same
35 the earlier type-based list produced.)

- **Virtual activities: 0** — none by FIT `subSport` (`virtualActivity`) and
  none by CSV `Activity Type` (`/virtual/i`). No fictional-coordinate tracks.
- FIT `sport` values among the imported set: `cycling`, `hiking`, `walking`
  (all `subSport` undefined).

## Parse results

- Activities with a track file: 284. **Imported (usable GPS): 35. Dropped
  (no usable GPS / indoor): 249. FIT decode failures: 0 (0.0%).**

## Chosen parser plan

- **FIT only**, via `@garmin/fitsdk` (`Decoder` / `Stream`), gunzip first.
  `recordMesgs[].positionLat/positionLong` are **semicircles**; convert with
  `deg = semicircles * 180 / 2^31`. Records without a position are skipped.
- **No GPX/TCX parser is implemented** — this export contains none. Per
  DATA.md ("a decision made from M2 data, not from preference"), adding one
  is deferred until an export actually contains `.gpx`/`.tcx`.

## Field derivation

- `id` = CSV `Activity ID`; `stravaUrl` = `.../activities/<id>`.
  **Gotcha:** the track filename stem is not the Activity ID (the `Filename`
  column points at a different upload id), so tracks are located via
  `Filename`.
- `type` = CSV `Activity Type`, verbatim (source of truth; no mapping).
- `date`/`year`: parsed directly from `Activity Date` (`"Mon D, YYYY, ..."`)
  by Y/M/D, deterministic, no timezone math.
- `distanceMeters` = FIT `sessionMesgs.totalDistance` (meters).
  **Gotcha:** the CSV `Distance` column is **kilometers** in this export
  (cross-check: CSV `61.15` ~ FIT `61152 m` ~ GPS-haversine `61345 m`), so
  the CSV distance is not used for the artifact.
- `movingTimeSeconds` = FIT `sessionMesgs.totalTimerTime`.
- `elevationGainMeters`: **deferred** — a naive positive-altitude-delta sum
  is noisy; revisit in M3+ (smoothing or a trusted source).

## Determinism & output

- Two consecutive runs produce **byte-identical** staging (`diff -r` empty):
  stable numeric id-ascending sort, `Number(x.toFixed(5))` coords (<=5 dp, no
  float noise), fixed key order, trailing newline, no timestamps in output.
- Output: `data/intermediate/staging/activities.json` + `tracks-2025.geojson`
  + `tracks-2026.geojson` (2 year shards). Staging is unclipped and
  unsimplified (privacy clipping + Douglas-Peucker are M3).

## Resolved decisions

1. **Include by GPS presence, not type.** The 248 GPS-typed "Workout" entries
   were indoor (no GPS), not outdoor runs — confirmed by parsing all 284 FIT
   files. Type is now display-only; there is no type filter.
2. **All activities are publishable.** No per-activity visibility filter is
   needed (and `activities.csv` exposes no such flag anyway). Privacy comes
   entirely from M3 zone clipping.

## M5 field recon — calories & heart rate (session-level)

Coverage from parsing all 284 FIT session messages, with the CSV columns as
fallback candidates, by type (n = activities; no coordinates/names printed):

| Type | n | FIT total_calories | FIT avg/max HR | CSV Calories | CSV avg/max HR |
|------|--:|--:|--:|--:|--:|
| Workout | 248 | 100% | 0% | 100% | 92% |
| Ride | 32 | 13% | 81% | 100% | 94% |
| Hike | 2 | 100% | 0% | 100% | 100% |
| Crossfit | 2 | 50% | 0% | 50% | 50% |
| Walk | 1 | 100% | 0% | 100% | 100% |
| **All** | **285** | **90%** | **9%** | **100%** | **92%** |

Decisions (nothing dropped — both fields have real data):

- **`caloriesKcal` — KEPT.** FIT `total_calories` covers 90% overall but only
  13% of Rides; the CSV `Calories` column covers 100%. So `caloriesKcal` = FIT
  `total_calories` when present, else CSV `Calories` (100% reachable). The
  `stats.json` calorie aggregates use the CSV `Calories` column for all 285
  activities (consistent with moving time being CSV-sourced in stats).
- **`avgHeartRate` / `maxHeartRate` — KEPT, FIT session-only, Ride-scoped.** FIT
  session HR exists only on Rides (81% of them); non-Ride FIT sessions carry no
  HR at all. Per spec (session-level FIT, no per-point streams, no CSV fallback
  for HR), HR is emitted only where the FIT session has it — so in this export it
  appears on ~81% of Ride popups and on no Hike popups. Colour-by-HR (needs
  per-point streams) is deferred to BACKLOG.
