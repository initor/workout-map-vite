# Wayne's Activity Map

Static, single-page activity map: sanitized GPS tracks derived from Strava bulk
exports, rendered on an interactive MapLibre map. Live at
**https://map.waynewen.com** (Vercel, push-to-`main` CD).

The browser never talks to Strava. Everything it loads is a pre-generated,
privacy-sanitized artifact under `public/data/`. All location privacy comes from
the importer's clipping algorithm, not from anything at runtime.

## Stack

- **Bun** — package manager and script runner. Run TS scripts directly:
  `bun scripts/foo.ts` (no tsx / ts-node).
- Vite 8 + React 19 + TypeScript, Tailwind CSS v4, MapLibre GL JS.
- Lint: oxlint.

## Everyday commands

| Command | What it does |
| --- | --- |
| `bun run dev` | dev server |
| `bun run build` | `tsc -b && vite build` — must pass before every commit |
| `bun run lint` | oxlint |
| `bun run import:strava -- --dir <dir>` | regenerate `public/data/` from a raw export |
| `bun run validate:data [-- <dir>]` | schema + PRIVACY.md verifier (defaults to `public/data`) |
| `bun run check:geometry` | did any track geometry change vs the committed shards? |
| `bun run test` | importer/clip unit tests |

## Docs

- `docs/PLAN.md` — milestones + exit criteria (the work queue).
- `docs/DATA.md` — public artifact schemas + determinism rules.
- `docs/PRIVACY.md` — threat model + hard invariants (**read before touching
  `scripts/` or `public/data/`**).
- `docs/BACKLOG.md` — post-v1 polish ideas (not scheduled work).

---

# Data-update runbook

This is the whole loop for refreshing the map with a new Strava export. A future
session should need nothing but this section. It is safe to repeat: the importer
is deterministic, so re-running on identical input rewrites byte-identical files.

### Prerequisites (one-time)

- **Bun** installed, repo cloned, `bun install` run.
- **`data/private/privacy-zones.json`** present. This gitignored file is the
  secret that powers all clipping; without it the importer refuses to write to
  `public/data/`. Shape (see `docs/PRIVACY.md`):

  ```json
  { "seedSalt": "<high-entropy random string>",
    "zones": [ { "name": "home", "lat": <num>, "lng": <num> } ] }
  ```

  Keep the **same `seedSalt`** across updates. The salt makes the privacy jitter
  reproducible; changing it re-jitters every track and produces an unreviewable
  full-file diff (and `check:geometry` will flag every track as changed).

### Step 1 — Get the export

Request a bulk export from Strava (Settings -> My Account -> Download or Delete
Your Account -> Request Your Archive). Strava emails a `.zip` within a few hours.

### Step 2 — Place it in `data/raw/`

Unzip so that `data/raw/activities.csv` and `data/raw/activities/` exist:

```
data/raw/
  activities.csv          # metadata; the Filename column keys each row to a track
  activities/             # .fit.gz / .gpx / .tcx.gz track files
```

`data/raw/` is gitignored and must **stay** so. The importer reads ONLY
`activities.csv` and `activities/` and ignores the rest of the archive
(messages, profile, etc.). Never copy anything else, even into `data/`.

### Step 3 — Import

```
bun run import:strava -- --dir data/raw
```

Writes `activities.json`, `tracks-<year>.geojson`, `places.json`, and
`stats.json` into `public/data/`. It prints a summary (imported count by type,
drops, MultiLineString splits, stats totals). Zone coordinates are never logged.

### Step 4 — Validate (must be green)

```
bun run validate:data
```

Asserts the DATA.md schemas and the PRIVACY.md verifier V1-V7 (no track point
within 500 m of a zone, date-only, <=5-decimal coords, id-set consistency, no
raw files under `public/`, ...) plus the stats.json checks (no date-shaped
strings, no keys outside the schema). If it fails, **stop and fix** — do not
commit red data. `public/data/` changes land only with a green run (PRIVACY R2).

### Step 5 — Did the track geometry change?

```
bun run check:geometry
```

This compares the regenerated `tracks-*.geojson` **geometry** against the
committed shards, ignoring properties:

- **"NO track geometry changed"** — only properties/stats moved (e.g. this run
  only refreshed totals or added an elevation field). No new location surface,
  so **Step 6 (inspection) is optional**. Skip to Step 7.
- **"TRACK GEOMETRY CHANGED"** — new tracks, removed tracks, or changed
  coordinates (the normal case when you add activities). **Do Step 6 before
  committing.**

  > If it reports geometry changed for an activity you did *not* expect to change
  > (e.g. an old ride you didn't re-record), suspect a `seedSalt` change or an
  > importer/algorithm edit — investigate before trusting the output.

### Step 6 — Wayne's privacy inspection (only if geometry changed)

Run the map locally against the new data and walk the `docs/PRIVACY.md`
inspection checklist:

```
bun run build && bun run preview      # then open the printed localhost URL
```

- [ ] Zoom to each zone: no line enters the clip area; track termini scatter at
      varied distances — no clean circle (that would be threat T2).
- [ ] Skim ~3 random activities end to end for anything odd.
- [ ] Search the artifacts for any coordinate with 6+ decimals: there should be
      none (`bun run validate:data` also enforces this).
- [ ] `git status` shows nothing from `data/raw|private|intermediate`.

### Step 7 — Commit and deploy

```
git checkout -b wayne/data-update-<yyyy-mm-dd>   # never commit data on main
git add public/data
git status                                        # confirm ONLY public/data/ is staged
git commit -m "chore(data): refresh from Strava export <yyyy-mm-dd>"
git push -u origin HEAD                            # open a PR, or push main if you prefer
```

Merging to `main` triggers Vercel CD; the site redeploys automatically. Keep the
diff reviewable: per-year sharding means a typical update only rewrites the
current-year shard plus `stats.json`.

### Privacy stop-signs (hard rules)

- Never commit anything under `data/raw/`, `data/private/`,
  `data/intermediate/`, or any `*.gpx` / `*.tcx` / `*.fit` / `*.zip` (incl.
  `.gz`). `.gitignore` guards this; don't defeat it.
- Never print, copy, or embed coordinates from `privacy-zones.json` anywhere.
- Never hand-edit generated artifacts in `public/data/` (fixtures excepted).
  The importer is the only writer; changes land only with a green
  `validate:data`.
