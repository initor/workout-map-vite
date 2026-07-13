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

## M8 recon — Hammerhead API (rides source)

Read from the live OpenAPI 3.1 spec (`https://api.hammerhead.io/v1/docs`, ReDoc;
spec at `/v1/docs/openapi.yml`) on 2026-07-06 with the dev app's credentials in
hand. No user data was fetched during recon — the spec is public; authenticated
calls await Wayne's OAuth consent. Base URLs: auth `.../v1/auth`, API
`.../v1/api/`.

### FIT or processed points? -> ORIGINAL FIT.

`GET /activities/{activityId}/file` -> "Get the FIT file of a single activity by
ID", `Content-Type: application/vnd.ant.fit` (binary). The Karoo's original FIT
is retrievable, so the SAME `@garmin/fitsdk` parse + clip pipeline applies with
no new parser. (`GET /activities/{activityId}` also returns a Google-encoded
`polyline` + metadata; we take the FIT for byte-level parity.)

Passthrough caveat (drives exit criterion 2): "byte-identical to the export-
derived same ride" holds only if Strava's *exported* FIT preserved the Karoo's
original record positions. If Strava re-encoded/smoothed on export, the two FITs
differ and so will the clip. The one-ride comparison tests exactly this.

**Result (2026-07-06, `sync:rides --probe`): CONFIRMED byte-identical.** A recent
ride present in both sources clipped identically — 8785 GPS points on each side,
start epochs equal (seed delta 0 s), clipped geometry byte-for-byte the same.
Strava's export preserves the Karoo positions, so FIT passthrough holds: the
Hammerhead migration is geometry-invariant and the additive invariant holds by
construction (with the sync guard catching any ride where it ever would not).

### Auth -> OAuth 2.0 authorization code + rotating refresh.

- Grant types (`POST /oauth/token`, form-urlencoded): `authorization_code`
  (initial) and `refresh_token` (renewal).
- Authorize: `GET /oauth/authorize?response_type=code&client_id&redirect_uri&
  scope&state` -> consent page (user may narrow scopes) -> callback
  `{redirect_uri}?code&state` (deny -> `?error=access_denied&state`).
- Token response: `{ token_type:"Bearer", access_token, refresh_token,
  expires_in, user_id }`. `expires_in` is per-token; schema example 52000 s
  (~14.4 h).
- Refresh rotation: the refresh grant returns a NEW `refresh_token` each time ->
  persist the latest. `POST /oauth/deauthorize` invalidates current refresh
  tokens (and unlinks the account).
- Scope needed: `activity:read` ("read activities and be notified of new ones");
  space-delimited. Redirect URI must match a configured endpoint — Wayne
  registered `http://localhost:3001` for the local sync's one-time callback.

### Identity -> ride start comes from the FIT, not the list.

`ActivitySummary` = `{ id (e.g. "1000.activity.abcd"), name, createdAt (ISO,
e.g. "2025-01-25T12:10:09.409Z"), duration (s), distance }`; `Activity` adds
`{ activityType (RIDE/EBIKE/MOUNTAIN_BIKE/GRAVEL/EMOUNTAIN_BIKE/VELOMOBILE),
description, polyline, updatedAt }`. `createdAt` is the upload/creation time,
NOT the ride start, so our identity `startEpochSeconds` (PRIVACY.md, M7) is read
from the fetched FIT exactly as the importer does. The Hammerhead `id` is opaque
and platform-specific (unrelated to the Strava activity id), so it is NOT a
cross-source key; `startEpochSeconds` is.

List: `GET /activities?page&perPage(<=100)&startDate=YYYY-MM-DD` -> Pagination
`{ totalItems, totalPages, perPage, currentPage }` + `data:[ActivitySummary]`.
`startDate` bounds the candidate set for "newer than the newest published ride".

### Webhooks -> one event, HMAC-signed.

A single webhook, "Activity sync" (`POST` to your registered URL, body
`ActivityWebhook { activityId, userId }`), signed `X-Hmac-Signature` =
HMAC-SHA256(body, webhook secret). A new-activity nudge only (no payload beyond
the ids) — a poll trigger, not a data feed. Relevant to M9 (a webhook receiver
could replace/augment the cron); out of scope for M8's local sync.

### Rate limits -> not documented.

The v1 spec declares no rate limits, `429`, or throttling headers. Treat as
unknown: page with `perPage=100`, bound by `startDate`, fetch each candidate FIT
once, no tight loops. Revisit for M9 if the cron trips a limit.

### Consequence for M8

FIT passthrough => no new parser, and (pending the passthrough caveat) the
existing clip/validate pipeline reproduces geometry exactly. The sync keys
identity on `startEpochSeconds` read from each fetched FIT; because that value is
absent from public artifacts by design (M7/V8), the sync maintains a gitignored
`data/private/rides-index.json` (startEpochSeconds -> id/date/source) as the
dedup / "newest ride" oracle, and persists tokens to a gitignored
`data/private/hammerhead-token.json`. Neither leaves the machine.
