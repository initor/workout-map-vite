# DATA — public artifact spec

Everything under `public/data/` except `fixtures/` is generated. Hand-editing
generated artifacts is forbidden; the importer is the only writer.

## Artifacts

```
public/data/
  activities.json          array<ActivitySummary>, sorted by id asc
  tracks-<year>.geojson    FeatureCollection, one Feature per activity, sorted by id asc
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
  stravaUrl?: string    // https://www.strava.com/activities/<id>
}
```

Deliberately absent: `visible`, `source`, debug fields, per-point timestamps,
start times. An excluded activity is ABSENT from every artifact, never
flagged (PRIVACY.md T4).

## GeoJSON

One Feature per activity.
`properties` = `{ id, name, type, date, year, distanceMeters?, stravaUrl? }`.
`geometry` = `LineString`, or `MultiLineString` when privacy clipping splits
a track. Coordinates `[lng, lat]`, exactly 5 decimal places.

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
- privacy jitter seeded from salted hash of activity id (PRIVACY.md) —
  random-looking, fully reproducible

Verify: run the importer twice, `diff -r` the two staging dirs → empty.

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
