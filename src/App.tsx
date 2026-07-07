import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection } from 'geojson'
import { STRAVA_ATHLETE_URL } from './config'

type Theme = 'dark' | 'light'
type Phase = 'loading' | 'ready' | 'error'

// Color encodes activity TYPE (hue), frequency (opacity accumulation). Theme-aware
// tokens defined in ONE place; per-theme lightness adjusted. Hues chosen to be
// distinct from each other, from the liberty basemap (parks green, water blue), and
// legible on both themes: Ride orange, Hike violet, Walk teal, Workout rose,
// Crossfit amber. The white-ish light casing sits under all of them.
const TYPE_COLORS: Record<Theme, Record<string, string>> = {
  light: { Ride: '#FC4C02', Hike: '#7c3aed', Walk: '#0d9488', Workout: '#e11d48', Crossfit: '#d97706' },
  dark: { Ride: '#fb923c', Hike: '#a78bfa', Walk: '#2dd4bf', Workout: '#fb7185', Crossfit: '#fbbf24' },
}
const DEFAULT_TYPE_COLOR: Record<Theme, string> = { light: '#64748b', dark: '#94a3b8' }
const STRAVA_ORANGE = '#FC4C02'
const typeColor = (theme: Theme, t: string): string => TYPE_COLORS[theme][t] ?? DEFAULT_TYPE_COLOR[theme]

interface ThemeSpec {
  style: string; styleFallback: string
  trackWidth: number; trackOpacity: number; trackHoverWidth: number
  casingColor: string; casingWidth: number; casingHoverWidth: number; casingOpacity: number
}
const THEMES: Record<Theme, ThemeSpec> = {
  dark: {
    style: 'https://tiles.openfreemap.org/styles/dark',
    styleFallback: 'https://tiles.openfreemap.org/styles/positron',
    trackWidth: 2, trackOpacity: 0.5, trackHoverWidth: 4,
    casingColor: '#ffffff', casingWidth: 0, casingHoverWidth: 0, casingOpacity: 0,
  },
  light: {
    style: 'https://tiles.openfreemap.org/styles/liberty',
    styleFallback: 'https://tiles.openfreemap.org/styles/bright',
    trackWidth: 2.5, trackOpacity: 0.55, trackHoverWidth: 4,
    casingColor: '#ffffff', casingWidth: 4, casingHoverWidth: 6, casingOpacity: 0.35,
  },
}
const PALO_ALTO: [number, number] = [-122.143, 37.4419]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Indoor (gym) types: their legend rows toggle the Home marker+disc; every other
// type is a GPS type whose row toggles tracks.
const INDOOR_TYPES = new Set(['Workout', 'Crossfit'])

interface Bucket { count: number; movingTimeSeconds: number; caloriesKcal: number; avgHeartRateBpm?: number }
interface TypeBucket extends Bucket { byYear: Record<string, Bucket> }
interface Stats { totals: Bucket; byType: Record<string, TypeBucket>; byYear: Record<string, Bucket> }
interface ActivitySummary { type: string; year: number }
interface Place { name: string; kind: string; lat: number; lng: number }
interface TrackProps { name?: string; type?: string; date?: string; distanceMeters?: number; movingTimeSeconds?: number; elevationGainMeters?: number; caloriesKcal?: number; avgHeartRate?: number; maxHeartRate?: number; stravaUrl?: string }

const X_ICON = '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke-linecap="round"/></svg>'
// Metric glyphs (clock, route, mountain, flame, heart) + external-link. Small,
// stroke=currentColor so they inherit the muted label colour. No icon dependency.
const gsvg = (body: string): string => `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const GLYPH_CLOCK = gsvg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>')
const GLYPH_ROUTE = gsvg('<circle cx="4" cy="12.5" r="1.4"/><circle cx="12" cy="3.5" r="1.4"/><path d="M4 11.1V8a2.5 2.5 0 012.5-2.5h3A2.5 2.5 0 0012 3"/>')
const GLYPH_MOUNTAIN = gsvg('<path d="M2 13l3.6-6.2 2.4 3.3L10.8 5 14 13z"/>')
const GLYPH_FLAME = gsvg('<path d="M8.2 2.2c.4 2-1.7 2.7-1.7 4.6 0 .9.6 1.6 1.5 1.6M8 14a4 4 0 01-4-4c0-2.4 1.8-3.4 2.1-5.3.7 1.1 4.9 2.2 4.9 5.6A4 4 0 018 14z"/>')
const GLYPH_HEART = gsvg('<path d="M8 13.2S2.6 9.4 2.6 5.9A2.6 2.6 0 018 5.1a2.6 2.6 0 015.4.8c0 3.5-5.4 7.3-5.4 7.3z"/>')
const EXT_LINK = '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5h5v5M10 4L5.5 8.5"/><path d="M8.5 8.5V10a1 1 0 01-1 1H4a1 1 0 01-1-1V6.5a1 1 0 011-1h1.5"/></svg>'

function initialTheme(): Theme {
  // Light is the default for a first-time visitor; a saved choice always wins.
  return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c))
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return r.json() as Promise<T>
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  const name = MONTHS[Number(m) - 1]
  return name ? `${name} ${Number(d)}, ${y}` : iso
}

// Panel/totals duration: one unit. >=1 h -> "89 h" / "1.5 h"; <1 h -> "40 m".
function formatDuration(secs: number): string {
  if (secs < 3600) return `${Math.round(secs / 60)} m`
  const h = secs / 3600
  return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`
}

// Popup moving time: hours + minutes, e.g. "2 h 58 m" (or "40 m" under an hour).
function formatHm(secs: number): string {
  const m = Math.round(secs / 60)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h} h ${m % 60} m` : `${m} m`
}

const formatKcal = (n: number): string => `${Math.round(n).toLocaleString()} kcal`

// One popup design: closeButton:false + our own themed card (panel tokens,
// theme-aware, custom close). Closes on map click (closeOnClick) and Esc.
function cardPopup(content: string, offset: number, maxWidth = 260): maplibregl.Popup {
  const card = document.createElement('div')
  card.className = 'relative rounded-lg bg-white/95 p-4 pr-9 text-zinc-900 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/95 dark:text-zinc-100 dark:ring-white/10'
  card.innerHTML = `<button type="button" aria-label="Close" class="absolute right-2.5 top-2.5 rounded p-0.5 text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200">${X_ICON}</button>${content}`
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, maxWidth: `${maxWidth}px`, offset })
  popup.setDOMContent(card)
  card.querySelector('button')?.addEventListener('click', () => popup.remove())
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') popup.remove() }
  popup.on('open', () => document.addEventListener('keydown', onKey))
  popup.on('close', () => document.removeEventListener('keydown', onKey))
  return popup
}

// Activity popup: header (name + meta) then a 2-column metric grid. Each metric
// renders only when present; the grid reflows (no per-type layouts). Value in the
// card's default colour at weight 500 + tabular-nums; label/unit muted. Card chrome
// (radius, close, theme-awareness) comes from cardPopup.
function trackPopupContent(p: TrackProps, theme: Theme): string {
  const muted = 'text-zinc-500 dark:text-zinc-400'
  const header = `<div class="text-[15px] font-medium leading-snug">${escapeHtml(p.name || 'Activity')}</div>`
  const metaBits: string[] = []
  if (p.date) metaBits.push(`<span>${escapeHtml(formatDate(p.date))}</span>`)
  if (p.type) metaBits.push(`<span class="inline-block h-2 w-2 shrink-0 rounded-full" style="background:${typeColor(theme, p.type)}"></span><span>${escapeHtml(p.type)}</span>`)
  const meta = metaBits.length ? `<div class="mt-1 flex items-center gap-1.5 text-xs ${muted}">${metaBits.join('<span class="opacity-60">&middot;</span>')}</div>` : ''

  const cells: string[] = []
  const cell = (glyph: string, label: string, value: string, unit?: string, sub?: string) => cells.push(
    `<div><div class="flex items-center gap-1.5 ${muted}">${glyph}<span class="text-[11px] font-medium uppercase tracking-wider">${label}</span></div>` +
    `<div class="mt-1 flex items-baseline gap-1"><span class="text-[19px] font-medium leading-none tabular-nums">${value}</span>${unit ? `<span class="text-xs ${muted}">${unit}</span>` : ''}</div>` +
    `${sub ? `<div class="mt-1 text-xs tabular-nums ${muted}">${sub}</div>` : ''}</div>`,
  )
  if (typeof p.movingTimeSeconds === 'number') cell(GLYPH_CLOCK, 'Moving time', formatHm(p.movingTimeSeconds))
  if (typeof p.distanceMeters === 'number') cell(GLYPH_ROUTE, 'Distance', (p.distanceMeters / 1000).toFixed(1), 'km')
  if (typeof p.elevationGainMeters === 'number') cell(GLYPH_MOUNTAIN, 'Elevation', String(Math.round(p.elevationGainMeters)), 'm')
  if (typeof p.caloriesKcal === 'number') cell(GLYPH_FLAME, 'Calories', Math.round(p.caloriesKcal).toLocaleString(), 'kcal')
  if (typeof p.avgHeartRate === 'number' || typeof p.maxHeartRate === 'number') {
    const hasAvg = typeof p.avgHeartRate === 'number'
    cell(GLYPH_HEART, 'Heart rate', String(hasAvg ? p.avgHeartRate : p.maxHeartRate), hasAvg ? 'bpm avg' : 'bpm max',
      hasAvg && typeof p.maxHeartRate === 'number' ? `${p.maxHeartRate} max` : undefined)
  }
  const grid = cells.length ? `<div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">${cells.join('')}</div>` : ''

  const footer = p.stravaUrl
    ? `<div class="mt-3 border-t border-zinc-200 pt-2.5 dark:border-zinc-700"><a class="inline-flex items-center gap-1 text-xs font-medium hover:underline" style="color:${STRAVA_ORANGE}" href="${escapeHtml(p.stravaUrl)}" target="_blank" rel="noopener noreferrer">Open on Strava ${EXT_LINK}</a></div>`
    : ''
  return `<div>${header}${meta}${grid}${footer}</div>`
}

function buildTypeFilter(types: string[]): maplibregl.FilterSpecification {
  return ['in', ['get', 'type'], ['literal', types]] as maplibregl.FilterSpecification
}
function trackColorExpr(theme: Theme): maplibregl.ExpressionSpecification {
  const c = TYPE_COLORS[theme]
  return ['match', ['get', 'type'], 'Ride', c.Ride, 'Hike', c.Hike, 'Walk', c.Walk, DEFAULT_TYPE_COLOR[theme]] as maplibregl.ExpressionSpecification
}

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set)
  if (next.has(v)) next.delete(v)
  else next.add(v)
  return next
}

// Decorative "hottest spot" heat disc under the Home marker: dominant enabled
// indoor hue at the deepest heat step (a saturated radial glow). pointer-events
// off so clicks reach the marker/map.
function makeHomeDisc(map: maplibregl.Map, home: Place, color: string): maplibregl.Marker {
  const el = document.createElement('div')
  el.style.width = '40px'; el.style.height = '40px'; el.style.borderRadius = '9999px'
  el.style.background = `radial-gradient(circle, ${color} 0%, ${color}00 70%)`
  el.style.pointerEvents = 'none'
  return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([home.lng, home.lat]).addTo(map)
}

// Home marker + card popup, reflecting only the ENABLED indoor types. `entries` is
// the enabled [type, TypeBucket][]; caller guarantees a non-zero total. `color` is
// the dominant indoor hue (shared with the heat disc) used to fill the dot.
function makeHomeMarker(map: maplibregl.Map, home: Place, entries: [string, TypeBucket][], color: string): { marker: maplibregl.Marker; popup: maplibregl.Popup } {
  const count = entries.reduce((s, [, b]) => s + b.count, 0)
  const secs = entries.reduce((s, [, b]) => s + b.movingTimeSeconds, 0)
  const cal = entries.reduce((s, [, b]) => s + b.caloriesKcal, 0)
  const years = new Set<string>()
  for (const [, b] of entries) for (const y of Object.keys(b.byYear)) years.add(y)
  const byYear = [...years].sort().map((y) => [y, entries.reduce((s, [, b]) => s + (b.byYear[y]?.count ?? 0), 0)] as const)

  // Location-agnostic dot: a small hued point (the dominant indoor hue) with a
  // white halo + shadow so it reads on either basemap. No always-on label; the
  // click opens the indoor-aggregates popup. A <button> keeps pointer cursor + AX.
  const el = document.createElement('button')
  el.type = 'button'
  el.title = home.name
  el.setAttribute('aria-label', `${home.name}, indoor workout details`)
  el.style.cursor = 'pointer'
  el.style.width = '14px'
  el.style.height = '14px'
  el.style.padding = '0'
  el.style.border = '0'
  el.style.borderRadius = '9999px'
  el.style.background = color
  el.style.boxShadow = '0 0 0 2px #fff, 0 1px 4px rgba(0, 0, 0, 0.4)'

  const row = (label: string, value: string) => `<div class="flex items-baseline justify-between gap-6 text-xs"><span class="text-zinc-500 dark:text-zinc-400">${label}</span><span class="tabular-nums font-semibold">${value}</span></div>`
  const byYearHtml = byYear.map(([y, c]) => `<span>${y}: ${c}</span>`).join('')
  const content =
    `<div class="space-y-2">` +
    `<div class="text-sm font-semibold">${escapeHtml(home.name)}</div>` +
    `<div class="text-xs text-zinc-500 dark:text-zinc-400">Indoor &amp; off-map training. No GPS track, so it lives here.</div>` +
    `<div class="space-y-1 pt-0.5">${row('Indoor workouts', String(count))}${row('Total time', formatDuration(secs))}${row('Calories', formatKcal(cal))}</div>` +
    `<div class="border-t border-zinc-200 pt-1.5 dark:border-zinc-700"><div class="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">By year</div>` +
    `<div class="flex flex-wrap gap-x-4 gap-y-0.5 pt-1 text-xs tabular-nums">${byYearHtml}</div></div>` +
    `</div>` +
    `<div class="mt-3 border-t border-zinc-200 pt-2.5 dark:border-zinc-700"><a class="inline-flex items-center gap-1 text-xs font-medium hover:underline" style="color:${STRAVA_ORANGE}" href="${STRAVA_ATHLETE_URL}" target="_blank" rel="noopener noreferrer">View profile on Strava ${EXT_LINK}</a></div>`
  const popup = cardPopup(content, 18)
  el.addEventListener('click', (ev) => { ev.stopPropagation(); popup.setLngLat([home.lng, home.lat]).addTo(map) })
  const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([home.lng, home.lat]).addTo(map)
  return { marker, popup }
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)

  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [phase, setPhase] = useState<Phase>('loading')
  const [acts, setActs] = useState<ActivitySummary[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [onTypes, setOnTypes] = useState<Set<string>>(new Set())
  const [onIndoor, setOnIndoor] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<boolean>(() => typeof window !== 'undefined' && window.innerWidth < 640)

  const allFeatures = useRef<Feature[]>([])
  const homeLocRef = useRef<Place | null>(null)
  const hoveredIdRef = useRef<string | number | null>(null)
  const styleReadyRef = useRef(false)
  const didInitialFrame = useRef(false)
  const statsRef = useRef<Stats | null>(null)
  statsRef.current = stats
  const view = useRef({ theme, onTypes, onIndoor })
  view.current = { theme, onTypes, onIndoor }

  // Idempotent (re)install of the track source (promoteId for feature-state hover)
  // + three line layers: casing (bottom), per-type-colored line (middle,
  // hover-highlighted), and an invisible fat hit layer (top) owning pointer events.
  const applyToMap = (): void => {
    const map = mapRef.current
    if (!map) return
    const th = THEMES[view.current.theme]
    const hover = ['boolean', ['feature-state', 'hover'], false]
    const casingW = ['case', hover, th.casingHoverWidth, th.casingWidth]
    const lineW = ['case', hover, th.trackHoverWidth, th.trackWidth]
    const lineO = ['case', hover, 1, th.trackOpacity]
    const color = trackColorExpr(view.current.theme)

    const data: FeatureCollection = { type: 'FeatureCollection', features: allFeatures.current }
    const src = map.getSource('tracks') as maplibregl.GeoJSONSource | undefined
    if (src) src.setData(data)
    else map.addSource('tracks', { type: 'geojson', data, promoteId: 'id' })

    if (!map.getLayer('tracks-casing')) {
      map.addLayer({ id: 'tracks-casing', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': th.casingColor, 'line-width': casingW as unknown as number, 'line-opacity': th.casingOpacity } })
    } else {
      map.setPaintProperty('tracks-casing', 'line-color', th.casingColor)
      map.setPaintProperty('tracks-casing', 'line-width', casingW as unknown as number)
      map.setPaintProperty('tracks-casing', 'line-opacity', th.casingOpacity)
    }
    if (!map.getLayer('tracks-line')) {
      map.addLayer({ id: 'tracks-line', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color as unknown as string, 'line-width': lineW as unknown as number, 'line-opacity': lineO as unknown as number } })
    } else {
      map.setPaintProperty('tracks-line', 'line-color', color as unknown as string)
      map.setPaintProperty('tracks-line', 'line-width', lineW as unknown as number)
      map.setPaintProperty('tracks-line', 'line-opacity', lineO as unknown as number)
    }
    if (!map.getLayer('tracks-hit')) {
      map.addLayer({ id: 'tracks-hit', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-width': 14, 'line-opacity': 0 } })
    }
    const filter = buildTypeFilter([...view.current.onTypes])
    for (const id of ['tracks-casing', 'tracks-line', 'tracks-hit']) map.setFilter(id, filter)
  }

  // Bounding box of what is currently on the map: enabled GPS tracks, plus the
  // Home point when any enabled indoor type has activity. null when nothing shows.
  const computeVisibleBounds = (): maplibregl.LngLatBounds | null => {
    const on = view.current.onTypes
    const bounds = new maplibregl.LngLatBounds()
    let has = false
    const extend = (c: number[]): void => { bounds.extend(c as [number, number]); has = true }
    for (const f of allFeatures.current) {
      const t = (f.properties as TrackProps | null)?.type
      if (!t || !on.has(t)) continue
      const g = f.geometry
      if (g.type === 'LineString') for (const c of g.coordinates) extend(c)
      else if (g.type === 'MultiLineString') for (const line of g.coordinates) for (const c of line) extend(c)
    }
    const home = homeLocRef.current
    const st = statsRef.current
    if (home && st) {
      const indoorTotal = [...view.current.onIndoor].reduce((s, t) => s + (st.byType[t]?.count ?? 0), 0)
      if (indoorTotal > 0) extend([home.lng, home.lat])
    }
    return has ? bounds : null
  }

  // Frame the visible set with even padding. The SAME function drives the panel
  // button and initial-load framing, so first paint and the button are identical.
  const frameVisible = (animate: boolean): void => {
    const map = mapRef.current
    if (!map) return
    const bounds = computeVisibleBounds()
    if (!bounds) return
    map.fitBounds(bounds, { padding: 48, maxZoom: 14, animate })
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

    map.on('load', () => { styleReadyRef.current = true; applyToMap() })
    map.on('style.load', () => { styleReadyRef.current = true; applyToMap() })

    const triedFallback: Record<Theme, boolean> = { dark: false, light: false }
    map.on('error', () => {
      const th = view.current.theme
      if (triedFallback[th] || map.isStyleLoaded()) return
      triedFallback[th] = true
      map.setStyle(THEMES[th].styleFallback)
    })

    const setHover = (id: string | number | null, on: boolean): void => {
      if (id !== null) map.setFeatureState({ source: 'tracks', id }, { hover: on })
    }
    map.on('mousemove', 'tracks-hit', (e) => {
      const f = e.features?.[0]
      if (!f || f.id == null) return
      map.getCanvas().style.cursor = 'pointer'
      if (hoveredIdRef.current !== null && hoveredIdRef.current !== f.id) setHover(hoveredIdRef.current, false)
      hoveredIdRef.current = f.id
      setHover(f.id, true)
    })
    map.on('mouseleave', 'tracks-hit', () => {
      map.getCanvas().style.cursor = ''
      setHover(hoveredIdRef.current, false)
      hoveredIdRef.current = null
    })
    map.on('click', 'tracks-hit', (e) => {
      const f = e.features?.[0]
      if (!f) return
      cardPopup(trackPopupContent(f.properties as TrackProps, view.current.theme), 8, 320).setLngLat(e.lngLat).addTo(map)
    })

    void (async () => {
      try {
        const [actList, placesDoc, statsDoc] = await Promise.all([
          fetchJson<ActivitySummary[]>('/data/activities.json'),
          fetchJson<{ places: Place[] }>('/data/places.json'),
          fetchJson<Stats>('/data/stats.json'),
        ])
        const years = [...new Set(actList.map((a) => a.year))]
        const shards = await Promise.all(
          years.map((y) => fetchJson<FeatureCollection>(`/data/tracks-${y}.geojson`).catch(() => ({ type: 'FeatureCollection', features: [] } as FeatureCollection))),
        )
        allFeatures.current = shards.flatMap((fc) => fc.features)
        homeLocRef.current = placesDoc.places[0] ?? null

        const gps = Object.keys(statsDoc.byType).filter((t) => !INDOOR_TYPES.has(t))
        const indoor = Object.keys(statsDoc.byType).filter((t) => INDOOR_TYPES.has(t))
        setActs(actList)
        setStats(statsDoc)
        setOnTypes(new Set(gps))
        setOnIndoor(new Set(indoor))
        setPhase('ready')
        if (styleReadyRef.current) applyToMap()
      } catch {
        setPhase('error')
      }
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
    map.setStyle(THEMES[theme].style)
  }, [theme])

  // GPS type filter: lightweight setFilter only (keeps feature-state + data intact).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReadyRef.current) return
    const filter = buildTypeFilter([...onTypes])
    for (const id of ['tracks-casing', 'tracks-line', 'tracks-hit']) if (map.getLayer(id)) map.setFilter(id, filter)
  }, [onTypes])

  // Home marker + heat disc reflect the ENABLED indoor types; hidden when none on.
  useEffect(() => {
    const map = mapRef.current
    if (!map || phase !== 'ready' || !stats) return
    const home = homeLocRef.current
    if (!home) return
    const entries = [...onIndoor].filter((t) => stats.byType[t]).map((t) => [t, stats.byType[t]] as [string, TypeBucket])
    const total = entries.reduce((s, [, b]) => s + b.count, 0)
    if (total === 0) return
    const dominant = entries.reduce((a, b) => (b[1].count > a[1].count ? b : a))[0]
    const color = typeColor(theme, dominant)
    const disc = makeHomeDisc(map, home, color)
    const { marker, popup } = makeHomeMarker(map, home, entries, color)
    return () => { disc.remove(); popup.remove(); marker.remove() }
  }, [onIndoor, stats, phase, theme])

  // Frame everything once, on first ready paint, via the same function as the
  // button, so the initial view and a button press produce identical framing.
  useEffect(() => {
    if (didInitialFrame.current || phase !== 'ready' || !mapRef.current) return
    didInitialFrame.current = true
    frameVisible(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const typeRows = stats ? Object.entries(stats.byType).sort((a, b) => b[1].count - a[1].count) : []
  const visibleCount = acts.reduce((n, a) => n + (onTypes.has(a.type) ? 1 : 0), 0)
  // The panel's "frame visible" button is live only when something is on the map
  // (enabled tracks, or the Home point when an indoor type is on). No camera move
  // happens on filter toggle — framing is button- or initial-load-driven only.
  const canFrame = phase === 'ready' && computeVisibleBounds() !== null

  const themeButton = (
    <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      title="Toggle light/dark" aria-label="Toggle light/dark"
      className="rounded-lg bg-zinc-500/10 p-1.5 text-zinc-600 ring-1 ring-inset ring-zinc-500/20 transition hover:bg-zinc-500/20 hover:text-zinc-900 dark:text-zinc-300 dark:ring-white/10 dark:hover:text-zinc-100">
      {theme === 'dark' ? (
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="3.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4" strokeLinecap="round" /></svg>
      ) : (
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M16 11.5A6 6 0 118.5 4a4.8 4.8 0 007.5 7.5z" strokeLinecap="round" strokeLinejoin="round" /></svg>
      )}
    </button>
  )

  return (
    <div className="relative h-screen w-full overflow-hidden">
      {/* Size by height/width, not absolute+inset-0: MapLibre adds an unlayered
          .maplibregl-map { position: relative } that overrides Tailwind's layered
          .absolute, which would collapse inset-0 to height 0. */}
      <div ref={containerRef} className="h-full w-full" />

      {/* The single control surface, top-left. Collapses to a pill on small screens. */}
      {/* Top-left overlay: the control panel, with the "frame visible" button
          attached right below it (kept next to the filters that drive framing). */}
      <div className="absolute left-3 top-3 z-10 flex flex-col items-start gap-2">
        <div className="max-w-[calc(100vw-1.5rem)]">
        {collapsed ? (
          <button type="button" onClick={() => setCollapsed(false)} aria-label="Show stats and filters"
            className="flex items-center gap-1.5 rounded-lg bg-white/90 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/85 dark:text-zinc-100 dark:ring-white/10">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true"><rect x="2" y="9" width="3" height="5" rx="1" /><rect x="6.5" y="5" width="3" height="9" rx="1" /><rect x="11" y="2" width="3" height="12" rx="1" /></svg>
            {stats ? stats.totals.count : 'Stats'}
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg bg-white/90 p-4 text-zinc-900 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/85 dark:text-zinc-100 dark:ring-white/10">
            <div className="flex items-center justify-between gap-3">
              <a href={STRAVA_ATHLETE_URL} target="_blank" rel="noopener noreferrer"
                aria-label="Wayne Wen on Strava"
                className="group inline-flex items-center gap-2">
                <span className="text-sm font-medium group-hover:underline">Wayne Wen</span>
                <span style={{ color: STRAVA_ORANGE }}
                  className="inline-flex items-center gap-1 rounded-md bg-[#FC4C02]/10 px-2 py-0.5 text-xs font-bold ring-1 ring-inset ring-[#FC4C02]/30 transition group-hover:bg-[#FC4C02]/20">
                  Strava
                  <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3.5 8.5l5-5M4.5 3.5h4v4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
              </a>
              <div className="flex items-center gap-1">
                {themeButton}
                <button type="button" onClick={() => setCollapsed(true)} aria-label="Collapse panel"
                  className="rounded-lg bg-zinc-500/10 p-1.5 text-zinc-600 ring-1 ring-inset ring-zinc-500/20 transition hover:bg-zinc-500/20 hover:text-zinc-900 dark:text-zinc-300 dark:ring-white/10 dark:hover:text-zinc-100">
                  <svg viewBox="0 0 12 12" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7.5l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </div>

            {phase === 'loading' && (
              <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-zinc-400" />Loading activities...
              </div>
            )}
            {phase === 'error' && (
              <div className="text-xs font-medium text-red-600 dark:text-red-400">Couldn&apos;t load activity data. Try refreshing.</div>
            )}
            {phase === 'ready' && stats && (
              <>
                <div>
                  <div className="text-[19px] font-medium leading-tight">{stats.totals.count} activities</div>
                  <div className="mt-1 text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {[
                      `${formatDuration(stats.totals.movingTimeSeconds)} moving`,
                      formatKcal(stats.totals.caloriesKcal),
                      stats.totals.avgHeartRateBpm != null ? `${stats.totals.avgHeartRateBpm} bpm avg` : null,
                    ].filter(Boolean).join(' \u00B7 ')}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Includes indoor workouts</div>
                </div>
                <div className="flex flex-col">
                  {typeRows.map(([t, b]) => {
                    const indoor = INDOOR_TYPES.has(t)
                    const active = indoor ? onIndoor.has(t) : onTypes.has(t)
                    const toggleRow = () => (indoor ? setOnIndoor((s) => toggle(s, t)) : setOnTypes((s) => toggle(s, t)))
                    return (
                      <div key={t}
                        role="button" tabIndex={0} aria-pressed={active}
                        onClick={toggleRow}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow() } }}
                        className={`-mx-2 grid cursor-pointer grid-cols-[1fr_2.5rem_3.25rem] items-center gap-x-2 rounded-lg px-2 py-1 text-sm transition hover:bg-zinc-500/10 ${active ? 'opacity-100' : 'opacity-40'}`}>
                        <span className="flex items-center gap-2 truncate">
                          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: typeColor(theme, t) }} />
                          {t}
                        </span>
                        <span className="text-right font-medium tabular-nums">{`${b.count}\u00D7`}</span>
                        <span className="text-right tabular-nums text-zinc-500 dark:text-zinc-400">{formatDuration(b.movingTimeSeconds)}</span>
                      </div>
                    )
                  })}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">Showing {visibleCount} of {acts.length} tracks</div>
              </>
            )}
          </div>
        )}
        </div>
        {/* All map controls live here, next to the panel (not spread to another
            corner): a zoom pair + "frame visible" (driven by the filters above). */}
        <div className="flex items-center gap-2">
          <div className="flex items-stretch overflow-hidden rounded-lg bg-white/90 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/85 dark:ring-white/10">
            <button type="button" onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out" title="Zoom out"
              className="px-2.5 py-1.5 text-zinc-600 transition hover:bg-zinc-500/10 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 10h10" strokeLinecap="round" /></svg>
            </button>
            <div className="w-px self-stretch bg-black/10 dark:bg-white/10" />
            <button type="button" onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in" title="Zoom in"
              className="px-2.5 py-1.5 text-zinc-600 transition hover:bg-zinc-500/10 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M10 5v10M5 10h10" strokeLinecap="round" /></svg>
            </button>
          </div>
          <button type="button" onClick={() => frameVisible(true)} disabled={!canFrame}
            aria-label="Frame visible activities" title="Frame visible activities"
            className="flex items-center gap-1.5 rounded-lg bg-white/90 px-2.5 py-1.5 text-xs font-medium text-zinc-600 shadow-lg ring-1 ring-black/5 backdrop-blur transition hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-zinc-600 dark:bg-zinc-900/85 dark:text-zinc-300 dark:ring-white/10 dark:hover:text-zinc-100 dark:disabled:hover:text-zinc-300">
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="3.25" /><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3" strokeLinecap="round" /></svg>
            Frame
          </button>
        </div>
      </div>
    </div>
  )
}
