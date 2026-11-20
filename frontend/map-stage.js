/**
 * The map on the Map tab (map.js): a street map from OpenFreeMap drawn by
 * MapLibre GL, with deck.gl on top for the parts MapLibre has no layer for.
 * Both libraries are vendored (frontend/vendor/maplibre, frontend/vendor/deck)
 * and load only when the Map tab first opens.
 *
 * Four ways to draw the same courts (MODES):
 *   clusters  MapLibre's own clustering; numbered circles split into courts
 *   lights    one point of light per game played, scattered around its court
 *   ridges    rows of lines lifted into hills by a density grid (deck.gl)
 *   spikes    MapLibre's heat map with a 3D needle per court (deck.gl)
 *
 * The stage owns no data of its own: map.js hands it the venues
 * (setData), and the stage reports back the court tapped (onSelect) and
 * the venues inside the view after every move (onView). Colours come
 * from the --map-heat-* tokens in styles.css. Map tiles and fonts come
 * from tiles.openfreemap.org, which therefore sees the area being viewed.
 */

import { currentTheme } from "./shared.js";

export const MODES = [
  ["clusters", "Clusters"],
  ["lights", "Night lights"],
  ["ridges", "Ridgelines"],
  ["spikes", "Glow + Spikes"],
];

const STYLE = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};
const FONT = ["Noto Sans Regular"];
const PITCH = { clusters: 0, lights: 0, ridges: 58, spikes: 52 };
/** No more lights than this, however long the range. */
const MAX_LIGHTS = 25_000;

// ── libraries, loaded once per page session ───────────────────────────

let libs = null;
function loadLibs() {
  libs ??= Promise.all([
    addOnce("link", "/vendor/maplibre/maplibre-gl.css"),
    addOnce("script", "/vendor/maplibre/maplibre-gl.js"),
    addOnce("script", "/vendor/deck/deck.min.js"),
  ]).then(() => ({ maplibregl: window.maplibregl, deck: window.deck }))
    .catch((err) => { libs = null; throw err; });
  return libs;
}
function addOnce(tag, url) {
  const attr = tag === "link" ? "href" : "src";
  if (document.querySelector(`${tag}[${attr}="${url}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    if (tag === "link") el.rel = "stylesheet";
    el[attr] = url;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Could not load ${url}`));
    document.head.appendChild(el);
  });
}

// ── colours from the tokens ───────────────────────────────────────────

function palette() {
  const css = getComputedStyle(document.documentElement);
  const hex = (name) => css.getPropertyValue(name).trim();
  const rgb = (value) => {
    const m = value.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    const n = value.match(/[\d.]+/g);
    return n ? n.slice(0, 3).map(Number) : [128, 128, 128];
  };
  const heat = [1, 2, 3, 4, 5].map((i) => hex(`--map-heat-${i}`));
  return {
    heat, heatRgb: heat.map(rgb),
    text: hex("--text"), textRgb: rgb(hex("--text")),
    card: hex("--bg-card"),
    accent: hex("--accent"), accentRgb: rgb(hex("--accent")),
    light: rgb(hex("--map-light")),
    dark: currentTheme() === "dark",
  };
}
const ramp = (stops, t) => {
  t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(Math.floor(t), stops.length - 2), f = t - i;
  return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
};

// ── derived shapes ────────────────────────────────────────────────────

/** A small seeded random source, so a court's lights stay put between draws. */
function seeded(text) {
  let a = 0;
  for (let i = 0; i < text.length; i++) a = (a * 31 + text.charCodeAt(i)) | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One light per game, scattered within a few hundred metres of its court. */
function buildLights(venues) {
  const total = venues.reduce((s, v) => s + v.games, 0);
  const keep = total > MAX_LIGHTS ? MAX_LIGHTS / total : 1;
  const out = [];
  for (const v of venues) {
    const r = seeded(v.id), n = Math.round(v.games * keep);
    const kx = 111.3 * Math.cos((v.lat * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(-2 * Math.log(r() || 1e-9)) * 0.16, th = r() * Math.PI * 2;
      out.push({ v, position: [v.lng + (d * Math.cos(th)) / kx, v.lat + (d * Math.sin(th)) / 110.6], b: 0.5 + r() * 0.5 });
    }
  }
  return out;
}

/**
 * Rows of a blurred activity surface over the courts' extent, for the
 * ridgelines: each row is a line whose height is the density beneath it.
 */
function buildRidges(venues) {
  const live = venues.filter((v) => v.games > 0);
  if (live.length === 0) return { rows: [], peaks: [], height: 0 };
  const lats = live.map((v) => v.lat), lngs = live.map((v) => v.lng);
  const pad = 0.12;
  const s = Math.min(...lats) - pad, n = Math.max(...lats) + pad, w = Math.min(...lngs) - pad, e = Math.max(...lngs) + pad;
  const kx = 111.3 * Math.cos((((s + n) / 2) * Math.PI) / 180), ky = 110.6;
  const extentKm = Math.max((e - w) * kx, (n - s) * ky);
  const sigma = Math.max(1.5, Math.min(6, extentKm / 55));
  const rowStep = (n - s) / Math.min(140, Math.max(40, Math.round(((n - s) * ky) / 1.1)));
  const colStep = rowStep / 2.5;
  const reach = 16 * sigma * sigma;
  const rows = [];
  let max = 0;
  for (let lat = n; lat >= s; lat -= rowStep) {
    const path = [];
    for (let lng = w; lng <= e; lng += colStep) {
      let d = 0;
      for (const v of live) {
        const dx = (lng - v.lng) * kx, dy = (lat - v.lat) * ky, d2 = dx * dx + dy * dy;
        if (d2 < reach) d += v.games * Math.exp(-d2 / (2 * sigma * sigma));
      }
      max = Math.max(max, d);
      path.push([lng, lat, d]);
    }
    rows.push(path);
  }
  // Peaks stay low against the map: about 3 km over a 100 km spread of courts.
  const height = Math.min(4500, Math.max(1200, extentKm * 28));
  const lift = (p) => [p[0], p[1], Math.sqrt(p[2] / max) * height];
  const peaks = [];
  for (const path of rows) {
    let run = [];
    const flush = () => {
      if (run.length > 2) peaks.push({ path: run.map(lift), peak: Math.max(...run.map((p) => p[2])) / max });
      run = [];
    };
    for (const p of path) { if (p[2] > max * 0.02) run.push(p); else flush(); }
    flush();
  }
  return { rows: rows.map((path) => ({ path: path.map(lift) })), peaks, height };
}

// ── the stage ─────────────────────────────────────────────────────────

/**
 * Mount the map into `el`. Resolves to the stage's handle, or rejects when
 * the libraries or WebGL are unavailable (map.js then says so in place).
 * `topInset()` is the height of the controls floating over the map's top,
 * kept clear when the map first fits the courts.
 */
export async function mountStage(el, { mode, onSelect, onView, topInset = () => 140 }) {
  const { maplibregl, deck } = await loadLibs();
  const st = { mode, venues: [], selId: null, lights: [], ridges: { rows: [], peaks: [], height: 0 }, fitted: false, pal: palette() };

  const map = new maplibregl.Map({
    container: el,
    style: STYLE[currentTheme()],
    center: [-98.15, 29.85],
    zoom: 7.4,
    pitch: PITCH[mode] ?? 0,
    maxPitch: 70,
    attributionControl: { compact: true },
    cooperativeGestures: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

  const overlay = new deck.MapboxOverlay({
    interleaved: false,
    layers: [],
    getTooltip: ({ object, layer }) => tooltip(object, layer),
  });
  map.addControl(overlay);

  const tooltip = (object, layer) => {
    if (!object || !layer) return null;
    const v = object.v ?? object;
    if (!v?.name) return null;
    return { text: `${v.name}\n${v.games} game${v.games === 1 ? "" : "s"} played${v.upcoming ? ` · ${v.upcoming} coming up` : ""}` };
  };

  // ── MapLibre's own layers ──
  const geo = () => ({
    type: "FeatureCollection",
    features: st.venues.map((v) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [v.lng, v.lat] },
      properties: { id: v.id, name: v.name, games: v.games, upcoming: v.upcoming },
    })),
  });
  const maxGames = () => Math.max(1, ...st.venues.map((v) => v.games));

  function addNative() {
    const p = st.pal;
    const heatStops = (top) => p.heat.flatMap((c, i) => [(top * i) / (p.heat.length - 1), c]);
    map.addSource("courts", { type: "geojson", data: geo(), cluster: true, clusterRadius: 46, clusterMaxZoom: 13, clusterProperties: { games: ["+", ["get", "games"]] } });
    map.addSource("courts-flat", { type: "geojson", data: geo() });

    map.addLayer({ id: "glow", type: "heatmap", source: "courts-flat", paint: {
      "heatmap-weight": ["/", ["get", "games"], maxGames()],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 7, 1, 13, 2.2],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 7, 18, 12, 46],
      "heatmap-opacity": 0.85,
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.08, p.heat[0], 0.3, p.heat[1], 0.55, p.heat[2], 0.8, p.heat[3], 1, p.heat[4]],
    } });
    map.addLayer({ id: "clusters", type: "circle", source: "courts", filter: ["has", "point_count"], paint: {
      "circle-color": p.card,
      "circle-radius": ["step", ["get", "point_count"], 15, 5, 19, 15, 24, 40, 30],
      "circle-stroke-width": 3.5,
      "circle-stroke-color": ["interpolate", ["linear"], ["get", "games"], ...heatStops(maxGames() * 4)],
    } });
    map.addLayer({ id: "cluster-count", type: "symbol", source: "courts", filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT, "text-size": 13, "text-allow-overlap": true },
      paint: { "text-color": p.text } });
    map.addLayer({ id: "court", type: "circle", source: "courts", filter: ["!", ["has", "point_count"]], paint: {
      "circle-color": ["interpolate", ["linear"], ["get", "games"], ...heatStops(maxGames())],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 14, 9],
      "circle-stroke-width": 2, "circle-stroke-color": p.card,
    } });
    map.addLayer({ id: "court-flat", type: "circle", source: "courts-flat", paint: {
      "circle-color": p.text, "circle-opacity": 0.55, "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 14, 4],
      "circle-stroke-width": 1, "circle-stroke-color": p.card,
    } });
    map.addLayer({ id: "court-sel", type: "circle", source: "courts-flat", filter: ["==", ["get", "id"], st.selId ?? ""], paint: {
      "circle-color": "rgba(0,0,0,0)", "circle-radius": 12, "circle-stroke-width": 3, "circle-stroke-color": p.accent,
    } });
    scaleNative();
    showNative();
  }

  /** The colour and weight scales follow the busiest court in the data. */
  function scaleNative() {
    const p = st.pal, top = maxGames();
    const stops = (max) => p.heat.flatMap((c, i) => [(max * i) / (p.heat.length - 1), c]);
    map.setPaintProperty("glow", "heatmap-weight", ["/", ["get", "games"], top]);
    map.setPaintProperty("clusters", "circle-stroke-color", ["interpolate", ["linear"], ["get", "games"], ...stops(top * 4)]);
    map.setPaintProperty("court", "circle-color", ["interpolate", ["linear"], ["get", "games"], ...stops(top)]);
  }

  const NATIVE = { clusters: ["clusters", "cluster-count", "court"], lights: ["court-flat"], ridges: ["court-flat"], spikes: ["glow"] };
  function showNative() {
    if (!map.getLayer("clusters")) return;
    for (const id of ["glow", "clusters", "cluster-count", "court", "court-flat"]) {
      map.setLayoutProperty(id, "visibility", NATIVE[st.mode].includes(id) ? "visible" : "none");
    }
    map.setFilter("court-sel", ["==", ["get", "id"], st.selId ?? ""]);
  }

  // ── deck.gl's layers ──
  function deckLayers() {
    const p = st.pal;
    const pick = { pickable: true, onClick: ({ object }) => { const v = object?.v ?? object; if (v?.id) onSelect(v.id); return true; } };
    if (st.mode === "lights") {
      return [new deck.ScatterplotLayer({
        id: "lights", data: st.lights, getPosition: (d) => d.position, radiusUnits: "pixels",
        getRadius: (d) => (p.dark ? 1.4 : 1.8) + d.b * (p.dark ? 2 : 2.2),
        getFillColor: (d) => [...p.light, Math.round((p.dark ? 130 : 80) * d.b)],
        parameters: p.dark ? { blend: true, blendFunc: [0x0302, 1, 1, 1], depthTest: false } : { depthTest: false },
        ...pick,
      })];
    }
    if (st.mode === "ridges") {
      return [
        new deck.PathLayer({ id: "ridges", data: st.ridges.rows, getPath: (r) => r.path, getColor: [...p.textRgb, p.dark ? 40 : 55], widthUnits: "pixels", getWidth: 1, jointRounded: true }),
        new deck.PathLayer({ id: "peaks", data: st.ridges.peaks, getPath: (r) => r.path, getColor: (r) => [...ramp(p.heatRgb, 0.25 + 0.75 * Math.pow(r.peak, 0.6)), 255],
          widthUnits: "pixels", getWidth: (r) => 1.2 + r.peak * 1.4, jointRounded: true, capRounded: true }),
      ];
    }
    if (st.mode === "spikes") {
      const top = maxGames(), tall = 1.6 * (st.ridges.height || 3000);
      const h = (v) => tall * 0.06 + (v.games / top) * tall;
      const color = (v) => (v.id === st.selId ? [...p.accentRgb, 255] : [...ramp(p.heatRgb, Math.pow(v.games / top, 0.7)), 255]);
      const live = st.venues.filter((v) => v.games > 0);
      return [
        new deck.LineLayer({ id: "spikes", data: live, getSourcePosition: (v) => [v.lng, v.lat, 0], getTargetPosition: (v) => [v.lng, v.lat, h(v)],
          getColor: color, getWidth: (v) => 2 + (v.games / top) * 3, widthUnits: "pixels", updateTriggers: { getColor: st.selId }, ...pick }),
        new deck.ScatterplotLayer({ id: "spike-tips", data: live, getPosition: (v) => [v.lng, v.lat, h(v)], radiusUnits: "pixels",
          getRadius: (v) => 2 + (v.games / top) * 2.5, getFillColor: color, updateTriggers: { getFillColor: st.selId }, ...pick }),
      ];
    }
    return [];
  }
  const paintDeck = () => overlay.setProps({ layers: deckLayers() });

  // ── events ──
  function reportView() {
    const b = map.getBounds();
    onView(st.venues.filter((v) => b.contains([v.lng, v.lat])));
  }
  map.on("style.load", () => { st.pal = palette(); addNative(); paintDeck(); });
  map.on("moveend", reportView);
  map.on("click", "clusters", async (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const zoom = await map.getSource("courts").getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  map.on("click", "court", (e) => { const id = e.features?.[0]?.properties.id; if (id) onSelect(id); });
  map.on("click", "court-flat", (e) => { const id = e.features?.[0]?.properties.id; if (id) onSelect(id); });
  for (const id of ["clusters", "court", "court-flat"]) {
    map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
  }

  // The app's theme switch swaps the street map; MapLibre drops our layers
  // with the old style, and style.load above puts them back.
  const themeWatch = new MutationObserver(() => {
    const want = STYLE[currentTheme()];
    if (st.styleUrl !== want) { st.styleUrl = want; map.setStyle(want); }
  });
  st.styleUrl = STYLE[currentTheme()];
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    setData: (venues) => {
      st.venues = venues;
      st.lights = buildLights(venues);
      st.ridges = buildRidges(venues);
      if (map.getSource("courts")) {
        map.getSource("courts").setData(geo());
        map.getSource("courts-flat").setData(geo());
        scaleNative();
      }
      paintDeck();
      if (!st.fitted && venues.length) {
        st.fitted = true;
        const b = new maplibregl.LngLatBounds();
        for (const v of venues) b.extend([v.lng, v.lat]);
        map.fitBounds(b, { padding: { top: topInset(), bottom: 50, left: 50, right: 50 }, maxZoom: 12, pitch: PITCH[st.mode], duration: 0 });
      }
      reportView();
    },
    setMode: (next) => {
      st.mode = next;
      showNative();
      paintDeck();
      map.easeTo({ pitch: PITCH[next] ?? 0, bearing: PITCH[next] ? -12 : 0, duration: 700 });
    },
    select: (id, { fly = false } = {}) => {
      st.selId = id;
      if (map.getLayer("court-sel")) map.setFilter("court-sel", ["==", ["get", "id"], id ?? ""]);
      paintDeck();
      const v = st.venues.find((x) => x.id === id);
      if (fly && v) map.easeTo({ center: [v.lng, v.lat], zoom: Math.max(map.getZoom(), 12), duration: 700 });
    },
    destroy: () => {
      themeWatch.disconnect();
      map.remove();
    },
  };
}
