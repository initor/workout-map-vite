import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection } from 'geojson'
import { STRAVA_ATHLETE_URL } from './config'

type Theme = 'dark' | 'light'

const THEMES: Record<Theme, { style: string; track: string; markerStroke: string }> = {
  dark: { style: 'https://tiles.openfreemap.org/styles/dark', track: '#fb923c', markerStroke: '#ffffff' },
  light: { style: 'https://tiles.openfreemap.org/styles/positron', track: '#c2410c', markerStroke: '#1f2937' },
}
const PALO_ALTO: [number, number] = [-122.143, 37.4419]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface ActivitySummary { type: string; year: number }
interface Place { name: string; kind: string; lat: number; lng: number }
interface TrackProps { name?: string; type?: string; date?: string; distanceMeters?: number; elevationGainMeters?: number; stravaUrl?: string }

function initialTheme(): Theme {
  return localStorage.getItem('theme') === 'light' ? 'light' : 'dark'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c))
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  const name = MONTHS[Number(m) - 1]
  return name ? `${name} ${Number(d)}, ${y}` : iso
}

// Popup HTML from GeoJSON feature properties. Missing fields (e.g. elevation,
// which the importer does not emit yet) simply degrade away.
function popupHtml(p: TrackProps): string {
  const rows = [`<div class="font-semibold text-sm">${escapeHtml(p.name || 'Activity')}</div>`]
  if (p.date && p.type) rows.push(`<div class="text-xs">${escapeHtml(formatDate(p.date))} &middot; ${escapeHtml(p.type)}</div>`)
  if (typeof p.distanceMeters === 'number') rows.push(`<div class="text-xs">${(p.distanceMeters / 1000).toFixed(1)} km</div>`)
  if (typeof p.elevationGainMeters === 'number') rows.push(`<div class="text-xs">${Math.round(p.elevationGainMeters)} m elevation</div>`)
  if (p.stravaUrl) rows.push(`<a class="text-xs font-medium text-orange-600 underline" href="${escapeHtml(p.stravaUrl)}" target="_blank" rel="noopener noreferrer">Open on Strava</a>`)
  return `<div class="space-y-0.5">${rows.join('')}</div>`
}

function buildFilter(types: string[], years: number[]): maplibregl.FilterSpecification {
  return ['all',
    ['in', ['get', 'type'], ['literal', types]],
    ['in', ['get', 'year'], ['literal', years]],
  ] as maplibregl.FilterSpecification
}

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set)
  if (next.has(v)) next.delete(v)
  else next.add(v)
  return next
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)

  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [types, setTypes] = useState<string[]>([])
  const [years, setYears] = useState<number[]>([])
  const [onTypes, setOnTypes] = useState<Set<string>>(new Set())
  const [onYears, setOnYears] = useState<Set<number>>(new Set())

  // Latest view state the imperative map callbacks read (refs stay fresh).
  const featuresByYear = useRef<Map<number, Feature[]>>(new Map())
  const fetchedYears = useRef<Set<number>>(new Set())
  const placeFeatures = useRef<Feature[]>([])
  const styleReadyRef = useRef(false)
  const view = useRef({ theme, onTypes, onYears })
  view.current = { theme, onTypes, onYears }

  // Idempotent (re)install of sources + layers for the CURRENT style. Registered
  // on style.load, so tracks + the Home marker survive every theme switch
  // (setStyle wipes custom sources/layers). Also used to push data/filter updates.
  const applyToMap = (): void => {
    const map = mapRef.current
    if (!map) return
    const th = THEMES[view.current.theme]

    const trackData: FeatureCollection = { type: 'FeatureCollection', features: [...featuresByYear.current.values()].flat() }
    const tracks = map.getSource('tracks') as maplibregl.GeoJSONSource | undefined
    if (tracks) tracks.setData(trackData)
    else map.addSource('tracks', { type: 'geojson', data: trackData })
    if (!map.getLayer('tracks')) {
      map.addLayer({ id: 'tracks', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': th.track, 'line-width': 2, 'line-opacity': 0.65 } })
    } else map.setPaintProperty('tracks', 'line-color', th.track)
    map.setFilter('tracks', buildFilter([...view.current.onTypes], [...view.current.onYears]))

    const placeData: FeatureCollection = { type: 'FeatureCollection', features: placeFeatures.current }
    const places = map.getSource('places') as maplibregl.GeoJSONSource | undefined
    if (places) places.setData(placeData)
    else map.addSource('places', { type: 'geojson', data: placeData })
    if (!map.getLayer('places')) {
      map.addLayer({ id: 'places', type: 'circle', source: 'places', paint: { 'circle-radius': 6, 'circle-color': '#38bdf8', 'circle-stroke-width': 2, 'circle-stroke-color': th.markerStroke } })
    } else map.setPaintProperty('places', 'circle-stroke-color', th.markerStroke)
  }

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: THEMES[view.current.theme].style,
      center: PALO_ALTO,
      zoom: 10,
      attributionControl: { compact: true },
    })
    mapRef.current = map

    // Install once when the map first loads, and re-install after every style
    // switch (setStyle wipes custom sources/layers) so tracks + marker persist.
    map.on('load', () => { styleReadyRef.current = true; applyToMap() })
    map.on('style.load', () => { styleReadyRef.current = true; applyToMap() })

    // Fallback (AGENTS.md): if the dark style can't load, drop to the light theme.
    let fellBack = false
    map.on('error', () => {
      if (!fellBack && !map.isStyleLoaded() && view.current.theme === 'dark') {
        fellBack = true
        setTheme('light')
      }
    })

    map.on('click', 'tracks', (e) => {
      const f = e.features?.[0]
      if (!f) return
      new maplibregl.Popup({ closeButton: true, maxWidth: '240px' })
        .setLngLat(e.lngLat)
        .setHTML(popupHtml(f.properties as TrackProps))
        .addTo(map)
    })
    map.on('mouseenter', 'tracks', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'tracks', () => { map.getCanvas().style.cursor = '' })

    // Manifest: available types + years (activities.json) and the Home marker.
    void (async () => {
      const [acts, placesDoc] = await Promise.all([
        fetch('/data/activities.json').then((r) => r.json() as Promise<ActivitySummary[]>),
        fetch('/data/places.json').then((r) => r.json() as Promise<{ places: Place[] }>),
      ])
      placeFeatures.current = placesDoc.places.map((p) => ({
        type: 'Feature', properties: { name: p.name, kind: p.kind }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      }))
      setTypes([...new Set(acts.map((a) => a.type))].sort())
      const uniqYears = [...new Set(acts.map((a) => a.year))].sort((a, b) => b - a)
      setYears(uniqYears)
      setOnTypes(new Set(acts.map((a) => a.type)))
      setOnYears(new Set(uniqYears))
    })()

    return () => { map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Theme: sync <html>.dark + localStorage, and (after mount) restyle the map.
  const firstThemeRun = useRef(true)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('theme', theme)
    const map = mapRef.current
    if (!map) return
    if (firstThemeRun.current) { firstThemeRun.current = false; return }
    map.setStyle(THEMES[theme].style) // style.load -> applyToMap re-installs everything
  }, [theme])

  // Toggles: lazily fetch newly-enabled year shards, then refresh data + filter.
  useEffect(() => {
    if (!mapRef.current) return
    void (async () => {
      const missing = [...onYears].filter((y) => !fetchedYears.current.has(y))
      await Promise.all(missing.map(async (y) => {
        const fc = await fetch(`/data/tracks-${y}.geojson`).then((r) => r.json() as Promise<FeatureCollection>)
        featuresByYear.current.set(y, fc.features)
        fetchedYears.current.add(y)
      }))
      if (styleReadyRef.current) applyToMap()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTypes, onYears])

  return (
    <div className="relative h-screen w-full overflow-hidden">
      {/* Size by height/width, not absolute+inset-0: MapLibre adds an unlayered
          .maplibregl-map { position: relative } that overrides Tailwind's layered
          .absolute, which would collapse inset-0 to height 0. */}
      <div ref={containerRef} className="h-full w-full" />

      <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100vw-1.5rem)] flex-col gap-2 rounded-lg bg-white/85 p-3 text-zinc-900 shadow-lg backdrop-blur dark:bg-zinc-900/80 dark:text-zinc-100">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">{"Wayne's Activity Map"}</span>
          <div className="flex items-center gap-2">
            <a href={STRAVA_ATHLETE_URL} target="_blank" rel="noopener noreferrer" className="rounded bg-orange-500 px-2 py-0.5 text-xs font-medium text-white hover:bg-orange-600">Strava</a>
            <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle light/dark" className="rounded border border-zinc-400/40 px-2 py-0.5 text-xs hover:bg-zinc-500/10">
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </div>

        {types.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs opacity-70">Type</span>
            {types.map((t) => (
              <button key={t} type="button" onClick={() => setOnTypes((s) => toggle(s, t))}
                className={`rounded-full px-2 py-0.5 text-xs ${onTypes.has(t) ? 'bg-orange-500 text-white' : 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400'}`}>
                {t}
              </button>
            ))}
          </div>
        )}

        {years.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs opacity-70">Year</span>
            {years.map((y) => (
              <button key={y} type="button" onClick={() => setOnYears((s) => toggle(s, y))}
                className={`rounded-full px-2 py-0.5 text-xs ${onYears.has(y) ? 'bg-sky-500 text-white' : 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400'}`}>
                {y}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
