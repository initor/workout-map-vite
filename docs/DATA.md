# DATA — public artifact spec

Everything under `public/data/` except `fixtures/` is generated. Hand-editing
generated artifacts is forbidden; the importer is the only writer.

## Artifacts

```
public/data/
  activities.json          array<ActivitySummary>, sorted by id asc
  tracks-<year>.geojson    FeatureCollection, one Feature per activity, sorted by id asc
  places.json              { places: Place[] }: neighborhood markers (e.g. Home)
  stats.json               { totals, byType, byYear }: aggregate counts + moving time
  fixtures/                hand-written dev fixtures (committed; exempt from "generated only")
```

Per-year sharding is deliberate: a data update rewrites only the current-year
shard (bounded git churn per update), and the UI lazy-loads shards per the
year filter (bounded first-paint payload).

## ActivitySummary — the public projection, minimal by design

```ts
interface ActivitySummary {
  id: string            // Strava activity id
  name: string
  type: string          // Strava activity type, verbatim (source of truth)
  date: string          // "YYYY-MM-DD" — date ONLY, never a datetime (PRIVACY.md T3)
  year: number
  distanceMeters?: number
  movingTimeSeconds?: number
  elevationGainMeters?: number
  caloriesKcal?: number     // FIT session total_calories, else CSV Calories
  avgHeartRate?: number     // bpm, FIT session avg (session-level only; no streams)
  maxHeartRate?: number     // bpm, FIT session max
  stravaUrl?: string    // https://www.strava.com/activities/<id>
}
```

Deliberately absent: `visible`, `source`, debug fields, per-point timestamps,
start times, and per-point HR streams. An excluded activity is ABSENT from every
artifact, never flagged (PRIVACY.md T4).

## GeoJSON

One Feature per activity.
`properties` = `{ id, name, type, date, year, distanceMeters?, movingTimeSeconds?, elevationGainMeters?, caloriesKcal?, avgHeartRate?, maxHeartRate?, stravaUrl? }`.
`geometry` = `LineString`, or `MultiLineString` when privacy clipping splits
a track. Coordinates `[lng, lat]`, exactly 5 decimal places.

## Places

`places.json` = `{ "places": Place[] }`: neighborhood-precision markers, not
tracks.

```ts
interface Place {
  name: string   // display label, e.g. "Home"
  kind: string   // "home"
  lat: number    // zone center rounded to EXACTLY 2 decimals (~1 km cell)
  lng: number
}
```

Coordinates are rounded to 2 decimals inside the importer from the gitignored
zones file; the precise values never appear in code, logs, or output
(PRIVACY.md T5). validate:data asserts every Place coordinate has at most 2
decimals (extends V5).

## Stats

`stats.json` is the ONLY artifact aggregated from the FULL `activities.csv` —
every row, INCLUDING indoor activities (e.g. GPS-less CrossFit) that never reach
the map. It exists to tell the whole-activity story (indoor + outdoor) that the
track artifacts, by construction, cannot.

```ts
interface Bucket {
  count: number; movingTimeSeconds: number; caloriesKcal: number
  avgHeartRateBpm?: number             // totals + byType only (not byYear)
}
interface Stats {
  totals: Bucket                       // across every activity in activities.csv
  byType: Record<string, Bucket & {    // key = Strava activity type, verbatim
    byYear: Record<string, Bucket>     //   that type, split by 4-digit year
  }>
  byYear: Record<string, Bucket>       // key = 4-digit year string, e.g. "2025"
}
```

`count` is the number of activities; `movingTimeSeconds` is the sum of the CSV
"Moving Time" column (seconds); `caloriesKcal` is the sum of the CSV "Calories"
column (kcal; 100% coverage per EXPORT-RECON.md). `avgHeartRateBpm` (on `totals`
and each `byType` entry only, omitted where a bucket has no HR) is the
moving-time-weighted mean of the CSV "Average Heart Rate" over activities that
have it. Each `byType` entry also carries a `byYear` split (so the UI can show,
e.g., indoor activity per year without a separate cross-tab). `byType` keys are
sorted alphabetically, all `byYear` keys ascending, for byte-determinism.

Aggregates ONLY — deliberately no ids, no per-activity records, and no dates.
This is what keeps it privacy-safe (PRIVACY.md): no coordinates (T1/T2/T5), no
datetime or schedule (T3 — a year is a bare 4-digit number, never a date), and no
per-activity flag (T4 — an aggregate count, unlike a `visible:false` marker,
never reveals which activity was excluded, or where/when). validate:data asserts
`stats.json` carries no `YYYY-MM-DD` string and no key outside this schema.

## Include list

Include every activity that has a usable GPS track (a decoded track of at
least 2 points). Drop only activities without GPS: there is nothing to
render. `type` is Strava's own value, carried through verbatim (source of
truth) for display and later UI filtering; it is never used as a filter.

## Determinism — load-bearing, not cosmetic

Re-running the importer on identical input MUST be byte-identical, or the
PR-based update flow produces unreviewable full-file diffs:

- stable sort by activity id everywhere
- fixed 5-decimal coordinate formatting (no float noise)
- stable JSON key order; trailing newline; no generation timestamps in output
- privacy jitter seeded from a salted hash of the activity's start time (UTC
  epoch seconds; PRIVACY.md §algorithm) — random-looking, fully reproducible.
  The start time is a SEED INPUT ONLY and never appears in output (V8).

Verify: run the importer twice, `diff -r` the two staging dirs → empty.

Changing the seed *basis* (as in the M7 start-time decoupling) is the one
sanctioned cause of a full-geometry re-jitter: every track's clip distance
changes at once, so that single regeneration is intentionally NOT byte-identical
to the prior committed shards (day-precision dates and all other fields are
unchanged). The rule above still holds afterward — two consecutive runs of the
new importer are byte-identical to each other.

## Simplification

Douglas-Peucker, ~15 m tolerance, tuned visually at M3.

GOTCHA: turf/simplify's `tolerance` is in DEGREES, not meters.
`meters / 111320 ≈ degrees` (latitude-dependent for longitude), or simplify
in a projected space. A naive `tolerance: 15` meant as meters collapses
nearly every track to a straight line.

## Strava export format (verify at M2; record findings in EXPORT-RECON.md)

- The archive contains `activities.csv` + an `activities/` folder of track
  files — a mix of `.gpx`, `.tcx.gz`, `.fit.gz` depending on recording-device
  era — plus unrelated personal data (messages, comments, profile). Read ONLY
  `activities.csv` and `activities/`; never copy anything else, even into
  `data/intermediate/`.
- `activities.csv` headers are LOCALIZED to the account's language setting.
  The `Filename` column keys each metadata row to its track file.
- `.gz` decompression is step zero for tcx/fit entries.
- Parsers: fast-xml-parser for GPX/TCX; `@garmin/fitsdk` for FIT. If the FIT
  parse-failure rate on the real export is material, isolate a Python
  `fitdecode` shim for FIT→GeoJSON only — a decision made from M2 data, not
  from preference.
- Distances/units in the CSV may be localized as well; cross-check one
  activity's CSV distance against its GPS-computed distance as a sanity
  assertion in validate:data.

## Size budget

Gzipped total of `tracks-*.geojson` ≤ ~10 MB. Beyond that, PMTiles becomes a
live option (CLAUDE.md "Not building yet"). Measure compressed — Vercel
serves brotli/gzip for static JSON automatically.
