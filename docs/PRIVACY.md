# PRIVACY — threat model and invariants

Public artifacts can reveal where Wayne lives and works, and when he is away,
unless constrained. These rules are hard. When in doubt, publish less.

Every exported activity is treated as publishable: there is no per-activity
visibility filter. Privacy comes entirely from the zone clipping below; an
activity dropped for lack of GPS is simply absent (T4), never flagged.

## Threats

- **T1 Endpoint inference** — tracks that start/end at home reveal home.
- **T2 Radius inversion** — clipping at a FIXED radius R makes every clipped
  track terminate on a circle of radius R around the zone center; three
  endpoints recover the center by intersection. This is the documented
  weakness of Strava's own privacy zones. Randomizing the clip distance per
  activity breaks the inversion.
- **T3 Schedule leakage** — start times reveal daily patterns. Public data is
  date-only, never datetime; no per-point timestamps anywhere.
- **T4 Hidden-activity metadata leakage** — an excluded activity must be
  absent from all artifacts; a `visible: false` flag is itself a leak.
- **T5 Zone-coordinate leakage** — the zones file IS the secret. Its
  coordinates must never appear in code, logs, tests, docs, error messages,
  or commits.

## Zones config (gitignored)

```
data/private/privacy-zones.json
{ "seedSalt": <string>, "zones": [ { "name": "home", "lat": <num>, "lng": <num> } ] }
```

Names are opaque labels. No radius field — the radius is computed per
activity (below), never configured, so a leaked config shape reveals nothing
about clip geometry. `seedSalt` is a high-entropy random string: the
clipping algorithm below is fully public, so its unpredictability comes
entirely from this gitignored salt.

## Clipping algorithm

For each activity, for each zone:

1. `clipDistance = 500 + 700 * u`, where
   `u = uniform01(seed = sha256(seedSalt + ":" + startEpochSeconds + ":" + zone.name))`
   and `startEpochSeconds` is the activity's start time as UTC epoch seconds,
   taken from the source recording (the first GPS sample's timestamp).
   Deterministic per (activity, zone); unpredictable across activities;
   range [500, 1200) meters.
2. Remove every point within `clipDistance` of the zone center (haversine).
3. Unconditionally drop the first and last 5 points of every track —
   belt-and-braces against T1 for stops at unconfigured locations.
4. If removal splits a track, keep it as a MultiLineString.
5. Drop the activity entirely if fewer than 20 points or less than 500 m of
   track remain.
6. Round all coordinates to 5 decimals (~1.1 m) as the LAST step.

The jitter does the privacy work; the rounding does the size work; the seed
preserves byte-determinism (DATA.md).

### Seed basis: start time, not activity id (M7, 2026-07-06)

The seed keys on the activity's start time rather than the Strava activity id.
The id coupled clip geometry to one platform's identifier scheme; the start time
is intrinsic to the ride and identical across a Strava export, the same ride
from Hammerhead, and the same ride from Ride with GPS. Keying the jitter on it
makes a future source migration geometry-invariant and independently verifiable,
and re-deriving a ride's clip needs only the salt plus a value every export
already carries.

`startEpochSeconds` is a SEED INPUT ONLY. It must never appear in any public
artifact: published dates stay day-precision (T3), and no epoch- or
datetime-shaped value may leak through any field. validate:data asserts this (V8).

## Home exposure decision

Home exposure level: neighborhood-precision marker approved by Wayne,
2026-07-05. Home is publishable at neighborhood precision only; the exact
coordinates stay protected by the zone clipping above, which is unchanged.

`public/data/places.json` carries a single Home marker at the zone center
rounded to EXACTLY 2 decimals (~1 km cell). This coexists deliberately with
the clipping: the 2-decimal marker and the [500,1200) m jitter operate at
different scales, and the marker (V1-exempt) may sit inside the clip radius by
design. The marker's ~1 km cell must NOT be tightened to more decimals without
revisiting the clip range: a finer marker combined with the jitter could
together narrow the home location.

## Verifier — validate:data MUST assert all of these

- **V1** No published track coordinate lies within 500 m (the minimum clip
  distance) of any zone center. (The places.json Home marker is a deliberate
  exception, see Home exposure decision.)
- **V2** Endpoint-drop behavior is covered by importer unit tests (it is not
  observable from public data alone).
- **V3** Public JSON contains no keys outside the DATA.md schemas — catches
  `visible`/`source`/debug leakage structurally.
- **V4** Every `date` matches `YYYY-MM-DD`; no time component anywhere.
- **V5** Every coordinate has at most 5 decimal places.
- **V6** No `*.gpx`, `*.tcx`, `*.fit`, `*.zip` (or `.gz` variants) anywhere
  under `public/`.
- **V7** The id set of `activities.json` equals the union of ids across
  `tracks-*.geojson` — no orphans in either direction.
- **V8** No numeric value in any public artifact is epoch-like (magnitude
  >= 1e9). The clip seed derives from the activity start time (epoch seconds);
  this catches that value — or any timestamp — leaking into output (T3).
  Activity ids and Strava URLs are strings, so they are unaffected.

V1 requires reading `data/private/privacy-zones.json` locally. The validator
never embeds or prints zone coordinates (T5): failures report the offending
activity id and the violating distance only, never the zone location.

## Operational rules

- **R1** `import:strava` hard-fails if the zones file is missing, unless
  `--allow-no-privacy-zones` is passed explicitly — and that flag refuses to
  write into `public/data/` (staging only). Absence of a gitignored file must
  be loud, never silently permissive.
- **R2** Changes to `public/data/` land only together with a green
  `validate:data` run.
- **R3** Raw export handling: raw exports live only under `data/raw/`
  (gitignored, however they arrive); read only `activities.csv` and
  `activities/`.

## Inspection checklist (Wayne, at M3, before the first publish)

- [ ] Zoom to each zone: no line enters the clip area; track termini scatter
      at varied distances — no clean circle (that would be T2)
- [ ] Skim 3 random activities end to end for anything odd
- [ ] Search public artifacts for any coordinate with 6+ decimals: none
- [ ] `git status` shows nothing from `data/raw|private|intermediate`
