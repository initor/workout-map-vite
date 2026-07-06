import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection } from 'geojson'

const DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark'
const POSITRON_STYLE = 'https://tiles.openfreemap.org/styles/positron'
const PALO_ALTO: [number, number] = [-122.143, 37.4419]

interface Activity { year: number }
interface Place { name: string; kind: string; lat: number; lng: number }

// Load real per-year track shards (all of them) + the neighborhood Home marker.
async function loadData(map: maplibregl.Map): Promise<void> {
  if (map.getSource('tracks')) return

  const activities = (await (await fetch('/data/activities.json')).json()) as Activity[]
  const years = [...new Set(activities.map((a) => a.year))]
  const shards = await Promise.all(
    years.map((y) => fetch(`/data/tracks-${y}.geojson`).then((r) => r.json() as Promise<FeatureCollection>)),
  )
  const features: Feature[] = shards.flatMap((fc) => fc.features)
  map.addSource('tracks', { type: 'geojson', data: { type: 'FeatureCollection', features } })
  map.addLayer({
    id: 'tracks',
    type: 'line',
    source: 'tracks',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fb923c', 'line-width': 2, 'line-opacity': 0.6 },
  })

  const placesDoc = (await (await fetch('/data/places.json')).json()) as { places: Place[] }
  const placeFeatures: Feature[] = placesDoc.places.map((p) => ({
    type: 'Feature',
    properties: { name: p.name, kind: p.kind },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }))
  map.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: placeFeatures } })
  map.addLayer({
    id: 'places',
    type: 'circle',
    source: 'places',
    paint: {
      'circle-radius': 6,
      'circle-color': '#38bdf8',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  })
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mapContainer.current) return

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: DARK_STYLE,
      center: PALO_ALTO,
      zoom: 10,
    })

    // Fall back to positron only if the dark style never loads (AGENTS.md).
    let usedFallback = false
    map.on('error', () => {
      if (!usedFallback && !map.isStyleLoaded()) {
        usedFallback = true
        map.setStyle(POSITRON_STYLE)
        map.once('idle', () => void loadData(map))
      }
    })

    map.on('load', () => void loadData(map))

    return () => map.remove()
  }, [])

  return (
    <div className="relative h-screen w-full overflow-hidden">
      {/* Size by height/width, not absolute+inset-0: MapLibre adds an unlayered
          .maplibregl-map { position: relative } that overrides Tailwind's layered
          .absolute, which would collapse inset-0 to height 0. */}
      <div ref={mapContainer} className="h-full w-full" />
      <div className="absolute left-3 top-3 z-10 rounded bg-zinc-900/70 px-3 py-1.5 text-sm font-semibold text-zinc-100 shadow backdrop-blur">
        {"Wayne's Activity Map"}
      </div>
    </div>
  )
}
