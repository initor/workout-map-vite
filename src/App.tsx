import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark'
const POSITRON_STYLE = 'https://tiles.openfreemap.org/styles/positron'
const PALO_ALTO: [number, number] = [-122.143, 37.4419]
const TRACKS_ID = 'tracks'
const TRACKS_URL = '/data/fixtures/tracks-fixture.geojson'

function addTracksLayer(map: maplibregl.Map) {
  if (map.getSource(TRACKS_ID)) return
  map.addSource(TRACKS_ID, { type: 'geojson', data: TRACKS_URL })
  map.addLayer({
    id: TRACKS_ID,
    type: 'line',
    source: TRACKS_ID,
    paint: {
      'line-color': '#fb923c',
      'line-width': 2,
      'line-opacity': 0.6,
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
        map.once('idle', () => addTracksLayer(map))
      }
    })

    map.on('load', () => addTracksLayer(map))

    return () => map.remove()
  }, [])

  return (
    <div className="relative h-screen w-full overflow-hidden">
      <div ref={mapContainer} className="absolute inset-0" />
      <div className="absolute left-3 top-3 z-10 rounded bg-zinc-900/70 px-3 py-1.5 text-sm font-semibold text-zinc-100 shadow backdrop-blur">
        {"Wayne's Activity Map"}
      </div>
    </div>
  )
}
