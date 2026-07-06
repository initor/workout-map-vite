# BACKLOG — post-v1 polish

Not scheduled work. v1 closes at M5 (see `docs/PLAN.md`). These are rough edges
noticed along the way; Wayne curates this list. **Do not implement any item here
without Wayne's explicit pick** — it is a parking lot, not a queue.

## Performance

- **Single 1.2 MB JS chunk.** `vite build` warns (>500 kB); `maplibre-gl`
  dominates the bundle (~335 kB gzip). Consider `import()`-splitting MapLibre so
  the shell + panels paint before the map engine loads. Noticed: every build.
- **No PMTiles trigger yet.** Gzipped `tracks-*.geojson` is well under the ~10 MB
  budget (DATA.md), so this stays deferred; revisit only if the total crosses it.

## Data / importer

- **Two different "moving time" sources.** Per-activity `movingTimeSeconds`
  (activities.json) comes from the FIT `totalTimerTime`; stats.json moving time
  comes from the CSV `Moving Time` column. They differ slightly (e.g. 8802 vs
  8824 s on one ride) because they are different Strava metrics. Not a bug, but a
  future pass could pick one source of truth and document the choice.
- **Elevation has no unit cross-check.** `elevationGainMeters` is read from the
  CSV `Elevation Gain` column (metres for this export; verified against FIT
  `totalAscent` where both exist). Distance has a geometry-vs-stored ratio guard
  in validate:data; elevation does not. If a future export is in imperial units,
  elevation would silently be wrong. Consider a sanity assertion.
- **FIT `totalAscent` only present on Rides.** That is why elevation is sourced
  from the CSV (covers Rides + Hikes). If more activity types gain GPS later,
  re-confirm the CSV column still covers them.
- **Colour-by-HR (per-point heart-rate streams).** Only session-level
  `avgHeartRate`/`maxHeartRate` are emitted (and only Rides carry FIT HR — see
  EXPORT-RECON.md). Colouring a track by its HR trace would need per-point
  `recordMesgs[].heartRate` streams, which the importer deliberately drops today
  (schedule/effort granularity, size). Deferred: decide the privacy/size trade
  before adding per-point anything.

## UI / UX

- **All year shards load up front.** Year filtering was removed, so the app
  fetches every `tracks-<year>.geojson` on load. Fine at current size (2 shards,
  ~3 MB); if the archive grows to many years, reintroduce lazy/bounded loading
  (the per-year sharding already supports it).
- **Collapse is manual, not responsive.** The single control panel collapses to
  a pill, defaulting collapsed under 640px at load; it does not re-collapse/expand
  as the window crosses the breakpoint after load. A resize listener (or a pure-CSS
  breakpoint) would make it fully responsive.
- **Indoor vs GPS types are a hardcoded set.** `INDOOR_TYPES = {Workout, Crossfit}`
  in `App.tsx` decides which legend rows toggle the Home marker vs the tracks;
  everything else is treated as GPS (so Walk is a GPS row even though its single
  34-second activity has no track, and it's excluded from the Home "workouts"
  total, now 250). A new indoor type (WeightTraining, Yoga, ...) would default to
  GPS until added to the set. Fine for one user; a data-driven signal (e.g. "type
  ever produced a track") would generalize it.
- **Map has no keyboard/AX affordance for tracks.** Legend rows are keyboard-
  toggleable, but tracks and the Home marker popup are reachable only by click.

## Testing

- **Importer aggregation is untested.** Only `clip.ts` has unit tests. The
  stats.json aggregation, CSV column resolution (duplicate headers like
  `Distance`/`Elapsed Time`), and elevation parsing have no coverage. Add
  importer-level tests with a tiny synthetic `activities.csv`.

## Docs hygiene

- **M4 exit boxes never ticked.** `docs/PLAN.md` M4 exit checkboxes are all
  unchecked, though M4 shipped (PR #8) and its criteria were re-verified in a
  browser during M5 (filters add/remove without reload, popups + Strava links,
  mobile viewport, theme toggle). Tick them to match reality.
