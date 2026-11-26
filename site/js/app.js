import {
  COLOR_THEMES,
  createDefaultMapSpec,
  decodeSpecFromHash,
  encodeSpecToHash,
  getPixelDimensions,
  normalizeMapSpec,
  sanitizeFilename,
} from './schema.js?v=15';
import {
  ensureDatasets,
  fetchCustomGeoJson,
  fetchGeoBoundariesLayer,
  getAdmin1Catalog,
  getCitiesInBounds,
  getCountryCatalog,
  getMarineLabelsInBounds,
  loadAdmin1Polygons,
  resolveAdmin1Scale,
  resolveIso3FromNumericId,
  resolveResolution,
} from './data-loader.js?v=15';
import {
  buildProjection,
  hitTestCountry,
  hitTestGeoJsonPoint,
  renderMapToCanvas,
  screenToLonLat,
} from './cartography.js?v=15';
import {
  checkPythonProHealth,
  exportBrowserPairWithWithoutBorders,
  exportBrowserRaster,
  exportBrowserSvg,
  inspectGeoJsonViaPythonPro,
  renderBatchViaPythonPro,
  renderViaPythonPro,
} from './exporter.js?v=15';
import { REGION_PRESETS } from './presets.js?v=15';
import { pickTopCitiesInExtent, searchPlaces } from './search.js?v=15';
import {
  populateCountryCatalog,
  populateShadowRegionCatalog,
  renderControls,
  renderSearchResults,
  setLoadingProgress,
  showToast,
  syncControlsFromSpec,
  updateCursorCoordinates,
} from './controls.js?v=15';
import {
  computeRegionAreaKm2,
  findUnderlyingCountryAt,
  hitTestShadow,
  resolveShadowSourceFeature,
} from './shadow.js?v=15';

const IS_PREVIEW_PATH = /(?:^|\/)preview(?:\/|$)/.test(window.location.pathname || '');
const STORAGE_KEY = IS_PREVIEW_PATH
  ? 'dusty_mapmaker_last_spec:preview'
  : 'dusty_mapmaker_last_spec';
const MAX_HISTORY = 40;

const SHADOW_PALETTE = [
  { fill: '#dc2626', stroke: '#7f1d1d' },
  { fill: '#2563eb', stroke: '#1e3a8a' },
  { fill: '#d97706', stroke: '#78350f' },
  { fill: '#059669', stroke: '#064e3b' },
  { fill: '#7c3aed', stroke: '#4c1d95' },
];

const VALID_GEOJSON_TYPES = new Set([
  'FeatureCollection',
  'Feature',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

const state = {
  spec: null,
  history: [],
  historyIndex: -1,
  datasets: null,
  fastDatasets: null,
  admin1Polygons: null,
  countryCatalog: [],
  admin1Catalog: [],
  lastProjection: null,
  renderedShadows: [],
  hoveredFeature: null,
  selectedFeature: null,
  mode: 'pan', // 'pan' | 'country' | 'pin' | 'shadow'
  refPeek: false,
  proAvailable: false,
  proStatusText: '',
  activePresetId: '',
  loadRequestToken: 0,
  searchAbortController: null,
  wheelCommitTimer: null,
  rafRenderPending: false,
  isInteracting: false,
  pendingCoordsEvent: null,
  coordsRafId: 0,
};

function loadInitialSpec() {
  const fromHash = decodeSpecFromHash(window.location.hash);
  if (fromHash) {
    return { spec: fromHash, source: 'link' };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { spec: normalizeMapSpec(JSON.parse(raw)), source: 'draft' };
    }
  } catch {
    // Ignore invalid localStorage draft
  }

  return { spec: createDefaultMapSpec(), source: 'default' };
}

function saveDraftToStorage(spec) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(spec));
  } catch {
    // If large inline GeoJSON exceeds quota, store stripped copy
    try {
      const compact = {
        ...spec,
        customGeoJsonLayers: (spec.customGeoJsonLayers || []).map((l) =>
          l.url ? { ...l, data: null } : l,
        ),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
    } catch {
      // Ignore storage errors
    }
  }
}

function deepMergeSpec(base, patch) {
  const next = structuredClone(base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object' && !Array.isArray(next[k])) {
      next[k] = deepMergeSpec(next[k], v);
    } else {
      next[k] = v;
    }
  }
  return next;
}

function commitSpec(nextSpecRaw, { commitHistory = true, keepPreset = false, skipDynamicLists = false } = {}) {
  const normalized = normalizeMapSpec(nextSpecRaw);
  state.spec = normalized;
  if (!keepPreset) {
    state.activePresetId = '';
  }

  if (commitHistory) {
    const serialized = JSON.stringify(normalized);
    const currentSerialized =
      state.historyIndex >= 0 ? JSON.stringify(state.history[state.historyIndex]) : null;
    if (serialized !== currentSerialized) {
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(structuredClone(normalized));
      if (state.history.length > MAX_HISTORY) {
        state.history.shift();
      }
      state.historyIndex = state.history.length - 1;
    }
  }

  saveDraftToStorage(normalized);
  syncAllUi({ skipDynamicLists });
  layoutCanvasSize();
  scheduleRender();
  void ensureDatasetsForSpec();
}

function patchSpec(patch, { commitHistory = true, keepPreset = false, skipDynamicLists = false } = {}) {
  const prevColors = state.spec?.colors || {};
  let effectivePatch = patch;
  if (
    patch?.colors &&
    !patch.customGeoJsonLayers &&
    Array.isArray(state.spec?.customGeoJsonLayers) &&
    state.spec.customGeoJsonLayers.some((l) => l?.role === 'land')
  ) {
    let changed = false;
    const syncedLayers = state.spec.customGeoJsonLayers.map((layer) => {
      if (layer?.role !== 'land') return layer;
      const next = { ...layer };
      if (
        typeof patch.colors.land === 'string' &&
        String(layer.color || '').toLowerCase() === String(prevColors.land || '').toLowerCase()
      ) {
        next.color = patch.colors.land;
        changed = true;
      }
      if (layer.strokeColor && layer.strokeColor !== 'none') {
        const prevStroke = String(layer.strokeColor).toLowerCase();
        if (typeof patch.colors.admin1 === 'string' && prevStroke === String(prevColors.admin1 || '').toLowerCase()) {
          next.strokeColor = patch.colors.admin1;
          changed = true;
        } else if (typeof patch.colors.borders === 'string' && prevStroke === String(prevColors.borders || '').toLowerCase()) {
          next.strokeColor = patch.colors.borders;
          changed = true;
        } else if (typeof patch.colors.coastline === 'string' && prevStroke === String(prevColors.coastline || '').toLowerCase()) {
          next.strokeColor = patch.colors.coastline;
          changed = true;
        }
      }
      return next;
    });
    if (changed) {
      effectivePatch = { ...patch, customGeoJsonLayers: syncedLayers };
    }
  }
  const merged = deepMergeSpec(state.spec, effectivePatch);
  commitSpec(merged, { commitHistory, keepPreset, skipDynamicLists });
}

function computeShadowMetrics() {
  const shadows = state.spec?.regionShadows || [];
  const datasets = state.datasets;
  if (!shadows.length || !datasets) return null;

  const map = new Map();
  const activeDs = {
    ...datasets,
    admin1Polygons: datasets.admin1Polygons || state.admin1Polygons || null,
  };

  for (let i = 0; i < shadows.length; i += 1) {
    const sh = shadows[i];
    const srcFeat = resolveShadowSourceFeature(sh, activeDs);
    if (!srcFeat) continue;
    const areaKm2 = computeRegionAreaKm2(srcFeat);
    let compareName = '';
    let compareAreaKm2 = 0;

    // First compare against the country directly beneath the shadow anchor
    const under = findUnderlyingCountryAt(activeDs, sh.targetLon, sh.targetLat);
    if (
      under &&
      under.areaKm2 > 0 &&
      under.name.toLowerCase() !== String(sh.sourceName || '').toLowerCase()
    ) {
      compareName = under.name;
      compareAreaKm2 = under.areaKm2;
    } else if (Array.isArray(state.spec?.highlightedCountries) && state.spec.highlightedCountries.length > 0) {
      // Otherwise fall back to the first highlighted country if different
      const hc = state.spec.highlightedCountries[0];
      const hcFeat = resolveShadowSourceFeature(
        { sourceType: 'country', sourceId: hc.id, sourceName: hc.name },
        activeDs,
      );
      if (hcFeat && String(hc.name || '').toLowerCase() !== String(sh.sourceName || '').toLowerCase()) {
        compareName = hc.name || hc.id;
        compareAreaKm2 = computeRegionAreaKm2(hcFeat);
      }
    }

    map.set(sh.id, { areaKm2, compareName, compareAreaKm2 });
  }
  return map;
}

function syncAllUi({ skipDynamicLists = false } = {}) {
  syncControlsFromSpec(state.spec, {
    canUndo: state.historyIndex > 0,
    canRedo: state.historyIndex < state.history.length - 1,
    proAvailable: state.proAvailable,
    proStatusText: state.proStatusText,
    mode: state.mode,
    refPeek: state.refPeek,
    activePresetId: state.activePresetId,
    skipDynamicLists,
    shadowMetrics: skipDynamicLists ? null : computeShadowMetrics(),
  });
}

function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1;
  state.spec = normalizeMapSpec(structuredClone(state.history[state.historyIndex]));
  state.activePresetId = '';
  saveDraftToStorage(state.spec);
  syncAllUi();
  layoutCanvasSize();
  scheduleRender();
  void ensureDatasetsForSpec();
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex += 1;
  state.spec = normalizeMapSpec(structuredClone(state.history[state.historyIndex]));
  state.activePresetId = '';
  saveDraftToStorage(state.spec);
  syncAllUi();
  layoutCanvasSize();
  scheduleRender();
  void ensureDatasetsForSpec();
}

function layoutCanvasSize() {
  const viewport = document.getElementById('stage-viewport');
  const canvas = document.getElementById('map-canvas');
  if (!viewport || !canvas || !state.spec) return;

  const availW = Math.max(240, viewport.clientWidth - 60);
  const availH = Math.max(240, viewport.clientHeight - 116);
  const widthIn = Number(state.spec.page?.widthIn) || 4.6;
  const heightIn = Number(state.spec.page?.heightIn) || 7.0;
  const aspect = Math.max(0.2, Math.min(5, widthIn / heightIn));

  let cssW = availW;
  let cssH = cssW / aspect;
  if (cssH > availH) {
    cssH = availH;
    cssW = cssH * aspect;
  }

  const roundedCssW = Math.max(200, Math.round(cssW));
  const roundedCssH = Math.max(200, Math.round(cssH));
  canvas.style.width = `${roundedCssW}px`;
  canvas.style.height = `${roundedCssH}px`;

  // Keep logical canvas width >= 800 while capping preview max dimension at 1380px (preserving exact aspect)
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let targetW = Math.max(800, Math.round(roundedCssW * dpr));
  let targetH = Math.max(200, Math.round(targetW / aspect));

  const maxDim = Math.max(targetW, targetH);
  if (maxDim > 1380) {
    const scale = 1380 / maxDim;
    targetW = Math.max(200, Math.round(targetW * scale));
    targetH = Math.max(200, Math.round(targetH * scale));
  }

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
}

function syncCountryCatalog(dataset) {
  if (!dataset?.countries) return;
  const nextCatalog = getCountryCatalog(dataset);
  if (!state.countryCatalog.length || nextCatalog.length >= state.countryCatalog.length) {
    state.countryCatalog = nextCatalog;
    const filterText = document.getElementById('country-filter-input')?.value || '';
    populateCountryCatalog(state.countryCatalog, filterText);
  }
  if (dataset.admin1Polygons && !state.admin1Polygons) {
    state.admin1Polygons = dataset.admin1Polygons;
    syncAdmin1Catalog(dataset.admin1Polygons);
  }
}

function syncAdmin1Catalog(admin1Polygons) {
  if (!admin1Polygons) return;
  const next = getAdmin1Catalog({ admin1Polygons });
  if (next.length) {
    state.admin1Catalog = next;
    const filterText = document.getElementById('shadow-filter-input')?.value || '';
    populateShadowRegionCatalog(state.admin1Catalog, 'admin1', filterText);
  }
}

function updateFastDatasetsCache(loaded) {
  if (loaded?.resolution !== '50m') return;
  const prev = state.fastDatasets;
  state.fastDatasets = {
    ...(prev || {}),
    ...loaded,
    lakes: loaded.lakes || prev?.lakes || null,
    rivers: loaded.rivers || prev?.rivers || null,
    bathymetry200: loaded.bathymetry200 || prev?.bathymetry200 || null,
    bathymetry1000: loaded.bathymetry1000 || prev?.bathymetry1000 || null,
    urbanAreas: loaded.urbanAreas || prev?.urbanAreas || null,
    admin1: loaded.admin1 || prev?.admin1 || null,
    admin1Resolution: loaded.admin1 ? loaded.admin1Resolution : (prev?.admin1Resolution || null),
    admin1Polygons: loaded.admin1Polygons || state.admin1Polygons || prev?.admin1Polygons || null,
    populatedPlaces: loaded.populatedPlaces || prev?.populatedPlaces || null,
  };
}

function drawReferencePeekOverlay(canvas, projection, datasets = state.datasets) {
  if (!state.refPeek || (!datasets?.populatedPlaces && !datasets?.marinePolys) || !projection) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const scaleFactor = canvas.width / 900;
  const clampScale = (v) => Math.min(3.0, Math.max(0.5, Number(v) || 1.0));
  const labelScale = clampScale(state.spec.layers?.cityLabelScale);
  const iconScale = clampScale(state.spec.layers?.cityIconScale);

  const candidates = datasets?.populatedPlaces
    ? pickTopCitiesInExtent(datasets, state.spec.center, state.spec.span, 24)
    : [];

  const existingNames = new Set(
    (state.spec.cities || []).map((c) => String(c.name || '').trim().toLowerCase()),
  );

  ctx.save();
  const fontSize = Math.max(6, Math.round(11.5 * scaleFactor * labelScale));
  ctx.textBaseline = 'middle';

  const placedBoxes = [];

  // 1. Inland seas, bays, gulfs, straits & oceans (italic ocean-blue reference labels)
  if (datasets?.marinePolys) {
    const cLon = Number(state.spec.center?.lon) || 0;
    const cLat = Number(state.spec.center?.lat) || 0;
    const hLon = Math.max(2, (Number(state.spec.span?.lonDeg) || 24) * 0.75);
    const hLat = Math.max(2, (Number(state.spec.span?.latDeg) || 14) * 0.75);
    const marines = getMarineLabelsInBounds(datasets, [
      cLon - hLon,
      cLon + hLon,
      Math.max(-85, cLat - hLat),
      Math.min(85, cLat + hLat),
    ]);
    const seaFontSize = Math.max(7, Math.round(11.0 * scaleFactor * labelScale));
    ctx.font = `italic 700 ${seaFontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';

    for (const sea of marines.slice(0, 18)) {
      const pt = projection([sea.lon, sea.lat]);
      if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
      const [x, y] = pt;
      if (x < 24 || x > canvas.width - 24 || y < 18 || y > canvas.height - 18) continue;

      const textW = ctx.measureText(sea.name).width;
      const box = {
        x1: x - textW * 0.5 - 4 * scaleFactor,
        y1: y - seaFontSize * 0.7,
        x2: x + textW * 0.5 + 4 * scaleFactor,
        y2: y + seaFontSize * 0.7,
      };
      if (placedBoxes.some((b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2))) {
        continue;
      }
      placedBoxes.push(box);
      ctx.lineWidth = Math.max(1.8, 3.0 * scaleFactor);
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.82)';
      ctx.strokeText(sea.name, x, y);
      ctx.fillStyle = '#7dd3fc';
      ctx.fillText(sea.name, x, y);
    }
  }

  // 2. Populated places reference labels
  ctx.font = `italic 600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'left';
  const dotRadius = Math.max(1.1, 2.8 * scaleFactor * iconScale);
  const lxOffset = Math.max(3, (2.8 * iconScale + 3.2 * labelScale) * scaleFactor);

  for (const city of candidates) {
    if (existingNames.has(city.name.toLowerCase())) continue;
    const pt = projection([city.lon, city.lat]);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const [x, y] = pt;
    if (x < 12 || x > canvas.width - 12 || y < 12 || y > canvas.height - 12) continue;

    const textW = ctx.measureText(city.name).width;
    const box = {
      x1: x + lxOffset,
      y1: y - fontSize * 0.7,
      x2: x + lxOffset + 6 * scaleFactor + textW,
      y2: y + fontSize * 0.7,
    };
    const overlaps = placedBoxes.some(
      (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2),
    );
    if (overlaps) continue;
    placedBoxes.push(box);

    // Subtle amber reference dot + readable translucent tag (preview only)
    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
    ctx.fill();
    ctx.lineWidth = Math.max(0.6, 1.0 * scaleFactor * Math.min(2.0, iconScale));
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.stroke();

    const lx = x + lxOffset;
    const ly = y;
    ctx.lineWidth = Math.max(1.8, 3.2 * scaleFactor * Math.min(2.0, labelScale));
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeText(city.name, lx, ly);
    ctx.fillStyle = '#fde68a';
    ctx.fillText(city.name, lx, ly);
  }
  ctx.restore();
}

function getActiveRenderDatasets() {
  const admin1Polygons = state.datasets?.admin1Polygons || state.admin1Polygons || null;
  if (state.isInteracting && state.fastDatasets) {
    const res = state.datasets?.resolution;
    const spanLon = Number(state.spec?.span?.lonDeg || 24);
    if (res === '10m' || res === 'ultra' || (res === '110m' && spanLon <= 95)) {
      return {
        ...state.fastDatasets,
        rivers: state.fastDatasets.rivers || null,
        bathymetry200: state.fastDatasets.bathymetry200 || state.datasets?.bathymetry200 || null,
        bathymetry1000: state.fastDatasets.bathymetry1000 || state.datasets?.bathymetry1000 || null,
        urbanAreas: state.fastDatasets.urbanAreas || state.datasets?.urbanAreas || null,
        marinePolys: state.fastDatasets.marinePolys || state.datasets?.marinePolys || null,
        admin1: state.fastDatasets.admin1 || state.datasets?.admin1 || null,
        admin1Resolution: state.fastDatasets.admin1
          ? state.fastDatasets.admin1Resolution
          : (state.datasets?.admin1Resolution || null),
        admin1Polygons,
        populatedPlaces: state.fastDatasets.populatedPlaces || state.datasets?.populatedPlaces || null,
      };
    }
  }
  if (!state.datasets) return null;
  return admin1Polygons && !state.datasets.admin1Polygons
    ? { ...state.datasets, admin1Polygons }
    : state.datasets;
}

function renderNow() {
  state.rafRenderPending = false;
  const canvas = document.getElementById('map-canvas');
  if (!canvas || !state.spec) return;

  if (!state.datasets) {
    // Draw subtle placeholder background while initial TopoJSON loads
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = state.spec.colors?.water || '#d1cfcf';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    state.lastProjection = buildProjection(state.spec, canvas.width, canvas.height);
    state.renderedShadows = [];
    return;
  }

  const activeDatasets = getActiveRenderDatasets();
  const result = renderMapToCanvas(canvas, state.spec, activeDatasets, {
    interactive: state.isInteracting,
  });
  state.lastProjection = result?.projection || buildProjection(state.spec, canvas.width, canvas.height);
  state.renderedShadows = Array.isArray(result?.renderedShadows) ? result.renderedShadows : [];

  if (state.refPeek) {
    drawReferencePeekOverlay(canvas, state.lastProjection, activeDatasets);
  }
}

function scheduleRender() {
  if (state.rafRenderPending) return;
  state.rafRenderPending = true;
  requestAnimationFrame(renderNow);
}

function datasetSatisfiesSpec(datasets, spec, needPlaces) {
  if (!datasets) return false;
  const neededRes = resolveResolution(spec);
  if (datasets.resolution !== neededRes) return false;
  const maxSpan = Math.max(Number(spec.span?.lonDeg) || 24, Number(spec.span?.latDeg) || 14);
  const needFineHydro = neededRes === 'ultra' || (spec.detailLevel === '10m' && maxSpan <= 4);
  if (needFineHydro && !datasets.fineHydrology) return false;
  if (spec.layers?.showMinorIslands !== false && (neededRes === '10m' || neededRes === 'ultra') && !datasets.minorIslands) {
    return false;
  }
  if (spec.layers?.showLakes !== false && !datasets.lakes) return false;
  if (spec.layers?.showRivers && !datasets.rivers) return false;
  if (spec.layers?.showBathymetry && !datasets.bathymetry200) return false;
  if (spec.layers?.showUrbanAreas && !datasets.urbanAreas) return false;
  if (spec.layers?.showAdmin1) {
    if (!datasets.admin1) return false;
    if (datasets.admin1Resolution !== resolveAdmin1Scale(spec)) return false;
  }
  const needAdmin1Polygons = Array.isArray(spec.regionShadows)
    && spec.regionShadows.some((s) => s && s.sourceType === 'admin1');
  if (needAdmin1Polygons && !datasets.admin1Polygons && !state.admin1Polygons) return false;
  if (needPlaces) {
    if (!datasets.populatedPlaces) return false;
    const want10mPlaces = neededRes === 'ultra' || (neededRes === '10m' && maxSpan <= 12);
    if (want10mPlaces && datasets.placesResolution !== '10m') return false;
  }
  return true;
}

async function ensureDatasetsForSpec({ forcePlaces = false } = {}) {
  const spec = state.spec;
  if (!spec) return;

  const neededRes = resolveResolution(spec);
  const maxSpan = Math.max(Number(spec.span?.lonDeg) || 24, Number(spec.span?.latDeg) || 14);
  const needMinorIslands = spec.layers?.showMinorIslands !== false && (neededRes === '10m' || neededRes === 'ultra');
  const needLakes = spec.layers?.showLakes !== false;
  const needRivers = Boolean(spec.layers?.showRivers);
  const needBathymetry = Boolean(spec.layers?.showBathymetry);
  const needUrbanAreas = Boolean(spec.layers?.showUrbanAreas);
  const needAdmin1 = Boolean(spec.layers?.showAdmin1);
  const needAdmin1Polygons = Array.isArray(spec.regionShadows)
    && spec.regionShadows.some((s) => s && s.sourceType === 'admin1')
    && !state.admin1Polygons;
  const admin1Scale = resolveAdmin1Scale(spec);
  const needPlaces = Boolean(forcePlaces || state.refPeek || state.datasets?.populatedPlaces);
  const fineHydrology = neededRes === 'ultra' || (spec.detailLevel === '10m' && maxSpan <= 4);
  const finePlaces = neededRes === 'ultra' || (neededRes === '10m' && maxSpan <= 12);

  if (datasetSatisfiesSpec(state.datasets, spec, needPlaces)) {
    state.loadRequestToken += 1;
    setLoadingProgress(false);
    return;
  }

  if (datasetSatisfiesSpec(state.fastDatasets, spec, needPlaces)) {
    state.loadRequestToken += 1;
    state.datasets = state.fastDatasets;
    syncCountryCatalog(state.fastDatasets);
    setLoadingProgress(false);
    syncAllUi();
    scheduleRender();
    return;
  }

  const token = ++state.loadRequestToken;

  try {
    setLoadingProgress(true, `Loading ${neededRes === 'ultra' ? 'Ultra 10m+' : neededRes} map data...`);
    const loaded = await ensureDatasets(neededRes, {
      needMinorIslands,
      needLakes,
      needRivers,
      needBathymetry,
      needUrbanAreas,
      needAdmin1,
      needAdmin1Polygons,
      needPlaces,
      fineHydrology,
      finePlaces,
      admin1Scale,
      onProgress: ({ label, completed, total }) => {
        if (token !== state.loadRequestToken) return;
        setLoadingProgress(true, `${label} (${completed}/${total})`);
      },
    });

    if (token !== state.loadRequestToken) return;
    if (loaded.admin1Polygons) {
      state.admin1Polygons = loaded.admin1Polygons;
    } else if (state.admin1Polygons) {
      loaded.admin1Polygons = state.admin1Polygons;
    }
    state.datasets = loaded;
    updateFastDatasetsCache(loaded);
    syncCountryCatalog(loaded);

    setLoadingProgress(false);
    syncAllUi();
    scheduleRender();
  } catch (err) {
    if (token !== state.loadRequestToken) return;
    setLoadingProgress(false);
    showToast(`Map data error: ${err.message}`, 'error', 5000);
  }
}

async function boot() {
  if (IS_PREVIEW_PATH) {
    document.title = "Dusty's Map Studio (Preview)";
    const engineEl = document.getElementById('engine-status');
    if (engineEl && !document.getElementById('preview-env-badge')) {
      const badge = document.createElement('a');
      badge.id = 'preview-env-badge';
      badge.className = 'preview-env-badge';
      badge.href = '../';
      badge.title = 'Viewing preview build — click to open the main live site';
      badge.textContent = 'Preview Build \u2197 Main';
      engineEl.insertAdjacentElement('afterend', badge);
    }
  }
  const bootToken = state.loadRequestToken;
  setLoadingProgress(true, 'Loading fast 110m map...');

  // Stage 1: tiny 110m world dataset so first map + country catalog render immediately
  try {
    const fast110m = await ensureDatasets('110m', { needLakes: false });
    if (!state.datasets) {
      state.datasets = fast110m;
      syncCountryCatalog(fast110m);
      scheduleRender();
    }
  } catch {
    // Continue to 50m / spec dataset load if 110m preview stage fails
  }

  // Stage 2: preload 50m (with lakes) into fastDatasets for crisp default & 60fps interaction
  try {
    if (bootToken === state.loadRequestToken) {
      setLoadingProgress(true, 'Loading 50m map data...');
    }
    const fast50m = await ensureDatasets('50m', { needLakes: true });
    updateFastDatasetsCache(fast50m);

    const spec = state.spec;
    const needPlaces = Boolean(state.refPeek || state.datasets?.populatedPlaces);
    const needsExtra = Boolean(
      spec?.layers?.showRivers ||
      spec?.layers?.showAdmin1 ||
      spec?.layers?.showBathymetry ||
      spec?.layers?.showUrbanAreas ||
      (Array.isArray(spec?.regionShadows) && spec.regionShadows.some((s) => s?.sourceType === 'admin1')) ||
      needPlaces,
    );

    if (
      bootToken === state.loadRequestToken &&
      spec &&
      resolveResolution(spec) === '50m' &&
      !needsExtra &&
      !datasetSatisfiesSpec(state.datasets, spec, needPlaces)
    ) {
      state.datasets = state.fastDatasets;
      syncCountryCatalog(state.fastDatasets);
      syncAllUi();
      scheduleRender();
    }
  } catch {
    // Fall through to ensureDatasetsForSpec() which handles error reporting
  }

  if (bootToken === state.loadRequestToken) {
    await ensureDatasetsForSpec();
    if (bootToken === state.loadRequestToken) {
      setLoadingProgress(false);
    }
  }
}

function getCanvasPointerCoords(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 0, y: 0 };
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function wrapLon(lon) {
  let x = (((lon + 180) % 360) + 360) % 360 - 180;
  if (x === -180 && lon > 0) x = 180;
  return x;
}

function shortestLonDelta(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function setNumericInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = Number(value).toFixed(2);
}

function clearActivePresetDirect() {
  if (!state.activePresetId) return;
  state.activePresetId = '';
  const presetSelect = document.getElementById('preset-select');
  if (presetSelect) presetSelect.value = '';
}

function setupCanvasInteractions() {
  const canvas = document.getElementById('map-canvas');
  if (!canvas) return;

  let pointerDown = false;
  let dragging = false;
  let startClientX = 0;
  let startClientY = 0;
  let startCanvasX = 0;
  let startCanvasY = 0;
  let startCenter = null;
  let startProjection = null;
  let startLonLat = null;
  let draggingShadowIdx = -1;
  let startShadowAnchor = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.spec) return;
    pointerDown = true;
    dragging = false;
    draggingShadowIdx = -1;
    startShadowAnchor = null;
    startClientX = e.clientX;
    startClientY = e.clientY;
    const pt = getCanvasPointerCoords(canvas, e);
    startCanvasX = pt.x;
    startCanvasY = pt.y;
    startCenter = { ...state.spec.center };
    startProjection = state.lastProjection || buildProjection(state.spec, canvas.width, canvas.height);
    startLonLat = screenToLonLat(startProjection, pt.x, pt.y);

    // Check if grabbing a region shadow (in 'shadow' mode or Shift+Drag in pan mode)
    const shadows = state.spec.regionShadows || [];
    if ((state.mode === 'shadow' || e.shiftKey) && shadows.length > 0 && state.renderedShadows.length > 0) {
      let hit = hitTestShadow(startProjection, state.renderedShadows, pt.x, pt.y);
      if (!hit && state.mode === 'shadow') {
        // In shadow mode, pick the nearest visible shadow if only one exists or user clicked near it
        const visibleEntries = state.renderedShadows.filter((r) => r?.shadow?.visible !== false);
        if (visibleEntries.length === 1) {
          hit = visibleEntries[0];
        }
      }
      if (hit) {
        const idx = shadows.findIndex((s) => s.id === hit.shadow.id);
        if (idx >= 0) {
          draggingShadowIdx = idx;
          startShadowAnchor = {
            lon: Number(shadows[idx].targetLon) || 0,
            lat: Number(shadows[idx].targetLat) || 0,
          };
        }
      }
    }

    canvas.setPointerCapture?.(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointerDown && startCenter) {
      const dist = Math.hypot(e.clientX - startClientX, e.clientY - startClientY);
      if (dist > 3) {
        dragging = true;
        canvas.classList.add('dragging');
        hideFeatureHover();
      }

      if (dragging) {
        state.isInteracting = true;
        if (state.wheelCommitTimer) {
          clearTimeout(state.wheelCommitTimer);
          state.wheelCommitTimer = null;
        }
        if (state.coordsRafId) {
          cancelAnimationFrame(state.coordsRafId);
          state.coordsRafId = 0;
          state.pendingCoordsEvent = null;
        }

        const pt = getCanvasPointerCoords(canvas, e);
        const curLonLat = startProjection ? screenToLonLat(startProjection, pt.x, pt.y) : null;

        // Dragging a Region Shadow smoothly across the globe
        if (draggingShadowIdx >= 0 && startShadowAnchor && state.spec.regionShadows?.[draggingShadowIdx]) {
          const shadow = state.spec.regionShadows[draggingShadowIdx];
          let nextLon;
          let nextLat;
          if (startLonLat && curLonLat) {
            const dLon = shortestLonDelta(curLonLat[0], startLonLat[0]);
            const dLat = curLonLat[1] - startLonLat[1];
            nextLon = wrapLon(startShadowAnchor.lon + dLon);
            nextLat = Math.max(-84, Math.min(84, startShadowAnchor.lat + dLat));
          } else {
            const dxNorm = (pt.x - startCanvasX) / canvas.width;
            const dyNorm = (pt.y - startCanvasY) / canvas.height;
            nextLon = wrapLon(startShadowAnchor.lon + dxNorm * state.spec.span.lonDeg);
            nextLat = Math.max(-84, Math.min(84, startShadowAnchor.lat - dyNorm * state.spec.span.latDeg));
          }
          shadow.targetLon = Number(nextLon.toFixed(3));
          shadow.targetLat = Number(nextLat.toFixed(3));
          scheduleRender();
          return;
        }

        let nextLon;
        let nextLat;
        if (
          startLonLat &&
          curLonLat &&
          state.spec.projection !== 'orthographic' &&
          state.spec.projection !== 'azimuthal_equidistant'
        ) {
          const dLon = shortestLonDelta(startLonLat[0], curLonLat[0]);
          const dLat = startLonLat[1] - curLonLat[1];
          nextLon = wrapLon(startCenter.lon + dLon);
          nextLat = Math.max(-85, Math.min(85, startCenter.lat + dLat));
        } else {
          const dxNorm = (pt.x - startCanvasX) / canvas.width;
          const dyNorm = (pt.y - startCanvasY) / canvas.height;
          nextLon = wrapLon(startCenter.lon - dxNorm * state.spec.span.lonDeg);
          nextLat = Math.max(-85, Math.min(85, startCenter.lat + dyNorm * state.spec.span.latDeg));
        }

        const latVal = Number(nextLat.toFixed(3));
        const lonVal = Number(nextLon.toFixed(3));
        state.spec.center.lat = latVal;
        state.spec.center.lon = lonVal;

        setNumericInputValue('center-lat', latVal);
        setNumericInputValue('center-lon', lonVal);
        clearActivePresetDirect();
        scheduleRender();
        return;
      }
    }

    if (state.lastProjection) {
      state.pendingCoordsEvent = e;
      if (!state.coordsRafId) {
        state.coordsRafId = requestAnimationFrame(() => {
          state.coordsRafId = 0;
          const ev = state.pendingCoordsEvent;
          state.pendingCoordsEvent = null;
          if (!ev || !state.lastProjection || dragging) return;
          const pt = getCanvasPointerCoords(canvas, ev);
          const coords = screenToLonLat(state.lastProjection, pt.x, pt.y);
          if (coords) {
            updateCursorCoordinates(coords.lat, coords.lon);
          } else {
            updateCursorCoordinates(NaN, NaN);
          }
          const hit = hitTestGeoJsonPoint(
            state.lastProjection,
            state.spec,
            pt.x,
            pt.y,
            canvas.width,
            canvas.height,
          );
          if (hit) {
            showFeatureHover(hit, canvas);
          } else {
            hideFeatureHover();
          }
        });
      }
    }
  });

  canvas.addEventListener('pointerleave', () => {
    hideFeatureHover();
  });

  const finishPointer = (e, wasCancelled = false) => {
    if (!pointerDown) return;
    pointerDown = false;
    const wasShadowDrag = draggingShadowIdx >= 0;
    draggingShadowIdx = -1;
    startShadowAnchor = null;
    canvas.classList.remove('dragging');
    canvas.releasePointerCapture?.(e.pointerId);

    if (wasCancelled || dragging) {
      if (dragging) {
        dragging = false;
        state.isInteracting = false;
        commitSpec(state.spec, { commitHistory: true, keepPreset: wasShadowDrag });
      }
      return;
    }

    // Handle single click
    const pt = getCanvasPointerCoords(canvas, e);
    if (state.mode === 'country') {
      handleCountryMapClick(pt.x, pt.y);
    } else if (state.mode === 'pin') {
      handlePinMapClick(pt.x, pt.y);
    } else if (state.mode === 'shadow') {
      // Single click in shadow mode moves the last visible shadow right under the cursor
      const shadows = [...(state.spec.regionShadows || [])];
      const targetIdx = shadows.findLastIndex((s) => s.visible !== false);
      const clickCoords = startProjection ? screenToLonLat(startProjection, pt.x, pt.y) : null;
      if (targetIdx >= 0 && clickCoords) {
        shadows[targetIdx] = {
          ...shadows[targetIdx],
          targetLon: Number(clickCoords.lon.toFixed(3)),
          targetLat: Number(Math.max(-84, Math.min(84, clickCoords.lat)).toFixed(3)),
        };
        patchSpec({ regionShadows: shadows }, { commitHistory: true });
      }
    } else if (state.mode === 'pan') {
      const hit = hitTestGeoJsonPoint(
        state.lastProjection,
        state.spec,
        pt.x,
        pt.y,
        canvas.width,
        canvas.height,
      );
      if (hit) {
        showFeatureInfoCard(hit);
      } else if (state.selectedFeature) {
        closeFeatureInfoCard();
      }
    }
  };

  canvas.addEventListener('pointerup', (e) => finishPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => finishPointer(e, true));

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!state.spec) return;
      hideFeatureHover();
      state.isInteracting = true;
      const rawDelta =
        e.deltaMode === 1 ? e.deltaY * 28 : e.deltaMode === 2 ? e.deltaY * 240 : e.deltaY;
      const clampedDelta = Math.max(-120, Math.min(120, rawDelta));
      const factor = Math.exp(clampedDelta * 0.0015);
      applyZoomFactor(factor, { commitHistory: false });
      clearTimeout(state.wheelCommitTimer);
      state.wheelCommitTimer = setTimeout(() => {
        state.wheelCommitTimer = null;
        state.isInteracting = false;
        commitSpec(state.spec, { commitHistory: true });
      }, 180);
    },
    { passive: false },
  );
}

function applyZoomFactor(factor, { commitHistory = true } = {}) {
  const MIN_SPAN_DEG = 0.005;
  const MAX_LON_DEG = 360;
  const MAX_LAT_DEG = 175;
  const curLon = Math.max(MIN_SPAN_DEG, Number(state.spec.span.lonDeg) || 24);
  const curLat = Math.max(MIN_SPAN_DEG, Number(state.spec.span.latDeg) || 14);
  const minFactor = Math.max(MIN_SPAN_DEG / curLon, MIN_SPAN_DEG / curLat);
  const maxFactor = Math.min(MAX_LON_DEG / curLon, MAX_LAT_DEG / curLat);
  const clampedFactor =
    minFactor <= maxFactor ? Math.max(minFactor, Math.min(maxFactor, factor)) : factor;
  const nextLon = Math.max(
    MIN_SPAN_DEG,
    Math.min(MAX_LON_DEG, Number((curLon * clampedFactor).toFixed(4))),
  );
  const nextLat = Math.max(
    MIN_SPAN_DEG,
    Math.min(MAX_LAT_DEG, Number((curLat * clampedFactor).toFixed(4))),
  );

  if (commitHistory) {
    patchSpec({ span: { lonDeg: nextLon, latDeg: nextLat } }, { commitHistory: true });
  } else {
    state.isInteracting = true;
    state.spec.span.lonDeg = nextLon;
    state.spec.span.latDeg = nextLat;
    setNumericInputValue('span-lon', nextLon);
    setNumericInputValue('span-lat', nextLat);
    clearActivePresetDirect();
    scheduleRender();
  }
}

function handleCountryMapClick(x, y) {
  if (!state.datasets || !state.lastProjection) {
    showToast('Still loading country boundaries...', 'warn');
    return;
  }
  const hit = hitTestCountry(state.lastProjection, state.datasets, x, y);
  if (!hit) {
    showToast('No country at that spot — click inside a country border.', 'warn', 2400);
    return;
  }

  const list = [...(state.spec.highlightedCountries || [])];
  const existingIdx = list.findIndex(
    (c) =>
      (hit.id && String(c.id) === String(hit.id)) ||
      (hit.name && c.name?.toLowerCase() === hit.name.toLowerCase()),
  );

  if (existingIdx >= 0) {
    const removed = list.splice(existingIdx, 1)[0];
    patchSpec({ highlightedCountries: list });
    showToast(`Removed highlight: ${removed.name || hit.name}`, 'info', 2200);
  } else {
    list.push({
      id: hit.id,
      name: hit.name || `Country ${hit.id}`,
      fill: state.spec.colors?.highlightFill || '#7a7d7a',
      stroke: state.spec.colors?.highlightStroke || '#ffffff',
      hatch: 'none',
    });
    patchSpec({ highlightedCountries: list });
    showToast(`Highlighted ${hit.name || hit.id}`, 'success', 2200);
  }
}

function handlePinMapClick(x, y) {
  if (!state.lastProjection) return;
  const coords = screenToLonLat(state.lastProjection, x, y);
  if (!coords) {
    showToast('Click inside the map globe to drop a pin.', 'warn');
    return;
  }

  const lon = Number(coords.lon.toFixed(4));
  const lat = Number(coords.lat.toFixed(4));
  const nextIndex = (state.spec.cities?.length || 0) + 1;
  let defaultName = `Pin ${nextIndex}`;

  // If populated places are loaded, suggest nearest city name within 0.45 deg
  if (state.datasets?.populatedPlaces) {
    const nearby = getCitiesInBounds(state.datasets, {
      minLon: lon - 0.45,
      maxLon: lon + 0.45,
      minLat: lat - 0.45,
      maxLat: lat + 0.45,
    });
    if (nearby.length) {
      let best = null;
      let bestDist = Infinity;
      for (const c of nearby) {
        const d = Math.hypot(c.lat - lat, c.lon - lon);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (best && bestDist < 0.35) {
        defaultName = best.name;
      }
    }
  }

  const cities = [
    ...(state.spec.cities || []),
    {
      id: `pin_${Date.now()}_${nextIndex}`,
      name: defaultName,
      lat,
      lon,
      style: 'dot',
      dx: 6,
      dy: -5,
      scale: 1.0,
    },
  ];
  patchSpec({ cities });
  showToast(`Dropped "${defaultName}" (${lat.toFixed(2)}°, ${lon.toFixed(2)}°). Rename in Countries & Pins.`, 'success', 2800);
}

const FEATURE_ENUM_LABELS = {
  major_military_airbase: 'Major Military Airbase',
  military_airfield: 'Military Airfield',
  auxiliary_airfield: 'Auxiliary Airfield',
  civilian_airport: 'Civilian Airport',
  civilian_airfield: 'Civilian Airfield',
  grass_sod: 'Grass / Sod',
  turf_dirt: 'Turf / Dirt',
  paved_asphalt: 'Paved Asphalt',
  paved_concrete: 'Paved Concrete',
  coral_gravel: 'Coral / Gravel',
  graded_earth: 'Graded Earth',
  laterite: 'Laterite',
  sand_clay: 'Sand / Clay',
  operational: 'Operational',
  under_construction: 'Under Construction',
  upgrading: 'Upgrading',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const FEATURE_SKIP_GENERIC_KEYS = new Set([
  'id',
  'name',
  'title',
  'label',
  'NAME',
  'Name',
  'notes',
  'description',
  'marker-color',
  'marker-symbol',
  'marker-size',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'fill',
  'fill-opacity',
]);

function createFeatureEl(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '' && text !== null && text !== undefined) {
    node.textContent = String(text);
  }
  return node;
}

function formatFeatureCoords(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

function formatEnumLabel(value) {
  if (value === null || value === undefined || value === '') return '';
  const str = String(value).trim();
  if (FEATURE_ENUM_LABELS[str]) return FEATURE_ENUM_LABELS[str];
  return str
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function getFeatureTitle(hit) {
  const p = hit?.properties || {};
  return String(
    p.name || p.title || p.label || p.NAME || p.Name || hit?.layer?.label || 'Point Feature',
  ).trim();
}

function getFeatureDotColor(hit) {
  const raw = hit?.properties?.['marker-color'];
  if (typeof raw === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.trim())) {
    return raw.trim();
  }
  const layerColor = hit?.layer?.color;
  if (typeof layerColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(layerColor.trim())) {
    return layerColor.trim();
  }
  return '#d97706';
}

function buildFeatureBadgeRow(hit) {
  const p = hit?.properties || {};
  const row = createFeatureEl('div', 'fht-header');

  const dot = createFeatureEl('span', 'fht-dot');
  dot.style.backgroundColor = getFeatureDotColor(hit);
  row.appendChild(dot);

  if (p.category === 'military') {
    row.appendChild(createFeatureEl('span', 'fht-badge fht-badge-military', 'Military'));
  } else if (p.category === 'civilian') {
    row.appendChild(createFeatureEl('span', 'fht-badge fht-badge-civilian', 'Civilian'));
  } else if (hit?.layer?.label) {
    row.appendChild(createFeatureEl('span', 'fht-badge', hit.layer.label));
  }

  if (p.dual_use === true) {
    row.appendChild(createFeatureEl('span', 'fht-badge fht-badge-dual', 'Dual-Use'));
  }

  return row;
}

function hideFeatureHover() {
  const ring = document.getElementById('feature-hover-ring');
  const tooltip = document.getElementById('feature-hover-tooltip');
  const canvas = document.getElementById('map-canvas');
  if (ring) ring.hidden = true;
  if (tooltip) tooltip.hidden = true;
  if (canvas) canvas.classList.remove('hover-feature');
  state.hoveredFeature = null;
}

function showFeatureHover(hit, canvas) {
  const ring = document.getElementById('feature-hover-ring');
  const tooltip = document.getElementById('feature-hover-tooltip');
  const stageEl = document.querySelector('.stage');
  if (!ring || !tooltip || !stageEl || !canvas) return;

  const canvasRect = canvas.getBoundingClientRect();
  const stageRect = stageEl.getBoundingClientRect();
  if (!canvasRect.width || !canvasRect.height || !stageRect.width || !stageRect.height) return;

  const cssX = canvasRect.left - stageRect.left + (hit.x / canvas.width) * canvasRect.width;
  const cssY = canvasRect.top - stageRect.top + (hit.y / canvas.height) * canvasRect.height;

  ring.style.left = `${cssX.toFixed(1)}px`;
  ring.style.top = `${cssY.toFixed(1)}px`;
  ring.hidden = false;

  canvas.classList.toggle('hover-feature', state.mode === 'pan');

  const prev = state.hoveredFeature;
  const sameFeature =
    prev &&
    prev.feature === hit.feature &&
    prev.layer === hit.layer &&
    prev.lon === hit.lon &&
    prev.lat === hit.lat &&
    prev.mode === state.mode;

  if (!sameFeature) {
    const p = hit.properties || {};
    tooltip.replaceChildren();
    tooltip.appendChild(buildFeatureBadgeRow(hit));
    tooltip.appendChild(createFeatureEl('div', 'fht-title', getFeatureTitle(hit)));

    const subtitleParts = [p.subregion, p.territory_1941].filter(Boolean);
    const subtitleText =
      subtitleParts.length > 0
        ? subtitleParts.join(' · ')
        : p.region || p.modern_country || (p.category ? hit.layer?.label : '');
    if (subtitleText) {
      tooltip.appendChild(createFeatureEl('div', 'fht-subtitle', subtitleText));
    }

    const metaParts = [
      p.operator_1941,
      p.surface_1941 ? formatEnumLabel(p.surface_1941) : '',
    ].filter(Boolean);
    if (metaParts.length > 0) {
      tooltip.appendChild(createFeatureEl('div', 'fht-meta', metaParts.join(' • ')));
    }

    const hintText =
      state.mode === 'pan'
        ? 'Click marker for full details'
        : 'Switch to Pan mode to open info card';
    tooltip.appendChild(createFeatureEl('div', 'fht-hint', hintText));
  }

  tooltip.hidden = false;
  const tipW = tooltip.offsetWidth || 240;
  const tipH = tooltip.offsetHeight || 96;

  let left = cssX + 16;
  let top = cssY - 14;
  if (left + tipW > stageRect.width - 12) {
    left = cssX - tipW - 16;
  }
  if (top + tipH > stageRect.height - 62) {
    top = cssY - tipH - 14;
  }
  left = Math.max(12, Math.min(left, Math.max(12, stageRect.width - tipW - 12)));
  top = Math.max(60, Math.min(top, Math.max(60, stageRect.height - tipH - 12)));

  tooltip.style.left = `${left.toFixed(1)}px`;
  tooltip.style.top = `${top.toFixed(1)}px`;

  state.hoveredFeature = {
    feature: hit.feature,
    layer: hit.layer,
    lon: hit.lon,
    lat: hit.lat,
    mode: state.mode,
  };
}

function closeFeatureInfoCard() {
  const card = document.getElementById('feature-info-card');
  if (card) {
    card.hidden = true;
    card.replaceChildren();
  }
  state.selectedFeature = null;
}

function pinFeatureLabelOnMap(hit) {
  const title = getFeatureTitle(hit);
  const lat = Number(hit.lat.toFixed(4));
  const lon = Number(hit.lon.toFixed(4));
  const current = [...(state.spec.cities || [])];
  const duplicate = current.some(
    (c) =>
      String(c.name || '').trim().toLowerCase() === title.toLowerCase() &&
      Math.abs(Number(c.lat) - lat) < 0.05 &&
      Math.abs(Number(c.lon) - lon) < 0.05,
  );
  if (duplicate) {
    showToast(`"${title}" is already pinned on the map.`, 'info', 2400);
    return;
  }

  const nextIndex = current.length + 1;
  current.push({
    id: `pin_${Date.now()}_${nextIndex}`,
    name: title,
    lat,
    lon,
    style: 'dot',
    dx: 6,
    dy: -5,
    scale: 1.0,
  });
  patchSpec({ cities: current });
  showToast(`Pinned "${title}" label onto the map.`, 'success', 2600);
}

function showFeatureInfoCard(hit) {
  const card = document.getElementById('feature-info-card');
  if (!card) return;

  const p = hit.properties || {};
  const title = getFeatureTitle(hit);
  card.replaceChildren();

  card.appendChild(buildFeatureBadgeRow(hit));

  const topRow = createFeatureEl('div', 'fic-top');
  const titleWrap = createFeatureEl('div');
  titleWrap.appendChild(createFeatureEl('div', 'fic-title', title));

  if (Array.isArray(p.alternate_names) && p.alternate_names.length > 0) {
    const cleanAlts = p.alternate_names.map((n) => String(n || '').trim()).filter(Boolean);
    if (cleanAlts.length > 0) {
      titleWrap.appendChild(createFeatureEl('div', 'fic-alt', `Also: ${cleanAlts.join(', ')}`));
    }
  }
  topRow.appendChild(titleWrap);

  const closeBtn = createFeatureEl('button', 'fic-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close feature details');
  closeBtn.addEventListener('click', () => closeFeatureInfoCard());
  topRow.appendChild(closeBtn);
  card.appendChild(topRow);

  const notesText = p.notes || p.description;
  if (typeof notesText === 'string' && notesText.trim()) {
    card.appendChild(createFeatureEl('div', 'fic-notes', notesText.trim()));
  }

  const grid = createFeatureEl('div', 'fic-grid');
  const addRow = (key, val, extraValClass = '') => {
    if (val === null || val === undefined || val === '') return;
    grid.appendChild(createFeatureEl('div', 'fic-key', key));
    grid.appendChild(
      createFeatureEl('div', extraValClass ? `fic-val ${extraValClass}` : 'fic-val', val),
    );
  };

  const isAirfieldSchema = Boolean(
    p.territory_1941 || p.control_dec_1941 || p.operator_1941 || p.facility_class || p.surface_1941,
  );

  if (isAirfieldSchema) {
    addRow('Facility', formatEnumLabel(p.facility_class));
    addRow('Location', [p.subregion, p.territory_1941].filter(Boolean).join(', '));
    addRow(
      'Dec 1941 Control',
      [p.control_dec_1941, p.alignment_dec_1941 ? `(${p.alignment_dec_1941})` : '']
        .filter(Boolean)
        .join(' '),
    );
    addRow('Operator', p.operator_1941);
    addRow('Surface', formatEnumLabel(p.surface_1941));
    addRow('Runways', p.runway_notes_1941);
    addRow('Dec 1941 Status', formatEnumLabel(p.status_dec_1941));
    addRow(
      'Modern Site',
      [p.modern_equivalent, p.modern_country].filter(Boolean).join(' — '),
    );
    addRow('Confidence', formatEnumLabel(p.source_confidence));
  } else {
    let added = 0;
    for (const [k, rawVal] of Object.entries(p)) {
      if (added >= 14) break;
      if (FEATURE_SKIP_GENERIC_KEYS.has(k)) continue;
      if (rawVal === null || rawVal === undefined || rawVal === '') continue;
      let formatted = '';
      if (Array.isArray(rawVal)) {
        formatted = rawVal.map((v) => String(v)).join(', ');
      } else if (typeof rawVal === 'object') {
        continue;
      } else if (typeof rawVal === 'boolean') {
        formatted = rawVal ? 'Yes' : 'No';
      } else {
        formatted = String(rawVal);
      }
      if (!formatted.trim()) continue;
      addRow(formatEnumLabel(k), formatted);
      added += 1;
    }
  }

  addRow('Layer', hit.layer?.label);
  addRow('Coordinates', formatFeatureCoords(hit.lat, hit.lon), 'fic-coords');
  card.appendChild(grid);

  const actions = createFeatureEl('div', 'fic-actions');
  const pinBtn = createFeatureEl('button', 'fic-btn', '+ Pin Label on Map');
  pinBtn.type = 'button';
  pinBtn.addEventListener('click', () => pinFeatureLabelOnMap(hit));
  actions.appendChild(pinBtn);
  card.appendChild(actions);

  card.hidden = false;
  state.selectedFeature = hit;
}

function validateLocalGeoJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('GeoJSON must be a JSON object.');
  }
  if (!VALID_GEOJSON_TYPES.has(data.type)) {
    throw new Error(`Unsupported GeoJSON type: "${String(data.type || 'missing')}".`);
  }
  if (data.type === 'FeatureCollection' && !Array.isArray(data.features)) {
    throw new Error('GeoJSON FeatureCollection is missing a features array.');
  }
  return data;
}

async function addGeoJsonLayer({ label, url = null, data, style = {} }) {
  if (state.proAvailable) {
    try {
      await inspectGeoJsonViaPythonPro({ url, data: url ? null : data });
    } catch {
      // Non-fatal: browser still renders GeoJSON directly
    }
  }

  const layer = {
    id: `geojson_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    label: label || 'Custom Overlay',
    url,
    data,
    visible: true,
    color: style?.color || '#d97706',
    fillOpacity: Number.isFinite(Number(style?.fillOpacity)) ? Number(style.fillOpacity) : 0.35,
    strokeWidth: Number.isFinite(Number(style?.strokeWidth)) ? Number(style.strokeWidth) : 1.6,
    dashed: Boolean(style?.dashed),
    hatch: style?.hatch || 'none',
  };

  patchSpec({
    customGeoJsonLayers: [...(state.spec.customGeoJsonLayers || []), layer],
  });
  showToast(`Added overlay: ${layer.label}`, 'success');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

async function initPythonProHealth() {
  const health = await checkPythonProHealth(1500);
  if (health?.ok) {
    state.proAvailable = true;
    state.proStatusText =
      'Python Pro Cartopy Engine is connected! Contextily satellite/shaded-relief basemaps, true Vector PDF exports, and full preset ZIP batches are unlocked.';
  } else {
    state.proAvailable = false;
    state.proStatusText =
      'Standalone Studio runs 100% in your browser with 300/600 DPI PNG, JPEG, and Vector SVG exports. Start the optional Python FastAPI server locally to unlock Contextily basemaps, Vector PDF, and batch ZIP exports.';
  }
  syncAllUi();
}

function buildCallbacks() {
  return {
    onSelectPreset: (presetId) => {
      const preset = REGION_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      hideFeatureHover();
      closeFeatureInfoCard();
      state.activePresetId = preset.id;
      commitSpec(structuredClone(preset.spec), { commitHistory: true, keepPreset: true });
      void hydrateRemoteGeoJsonLayers();
      showToast(`Loaded preset: ${preset.label}`, 'success', 2400);
    },

    onUndo: undo,
    onRedo: redo,

    onCopyShareLink: async () => {
      try {
        const hash = encodeSpecToHash(state.spec);
        window.history.replaceState(null, '', hash);
        const fullUrl = `${window.location.origin}${window.location.pathname}${hash}`;
        await copyTextToClipboard(fullUrl);
        showToast('Share link copied to clipboard!', 'success');
      } catch (err) {
        showToast(`Could not copy share link: ${err.message}`, 'error');
      }
    },

    onSaveProjectJson: () => {
      const blob = new Blob([JSON.stringify(state.spec, null, 2)], { type: 'application/json' });
      const filename = `${sanitizeFilename(state.spec.title, 'dusty_map')}.mapstudio.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      showToast(`Saved project: ${filename}`, 'success');
    },

    onLoadProjectFile: async (file) => {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const normalized = normalizeMapSpec(parsed);
        commitSpec(normalized, { commitHistory: true });
        showToast(`Loaded project: ${file.name}`, 'success');
      } catch (err) {
        showToast(`Invalid project file: ${err.message}`, 'error', 4500);
      }
    },

    onExport: async (format) => {
      const fmt = String(format || 'png').toLowerCase();
      try {
        const wantsGshhs =
          state.spec.pro?.coastlineEngine === 'gshhs_high' ||
          state.spec.pro?.coastlineEngine === 'gshhs_full';
        const usePro =
          fmt === 'pdf' ||
          (state.proAvailable &&
            ((state.spec.pro?.basemapProvider && state.spec.pro.basemapProvider !== 'none') || wantsGshhs));

        if (usePro) {
          showToast(`Rendering ${fmt.toUpperCase()} via Python Pro...`, 'info', 2500);
          const res = await renderViaPythonPro(state.spec, fmt);
          showToast(`Downloaded ${res.filename}`, 'success');
          return;
        }

        const exportDs = getActiveRenderDatasets() || state.datasets;
        if (fmt === 'svg') {
          const res = await exportBrowserSvg(state.spec, exportDs);
          showToast(`Downloaded Vector SVG: ${res.filename}`, 'success');
          return;
        }

        const dims = getPixelDimensions(state.spec.page);
        showToast(`Exporting ${dims.widthPx}×${dims.heightPx} (${dims.dpi} DPI) ${fmt.toUpperCase()}...`, 'info', 2200);
        const res = await exportBrowserRaster(state.spec, exportDs, fmt);
        showToast(`Downloaded ${res.filename}`, 'success');
      } catch (err) {
        showToast(`Export failed: ${err.message}`, 'error', 5000);
      }
    },

    onExportPair: async (format) => {
      const fmt = String(format || 'png').toLowerCase();
      try {
        const wantsGshhs =
          state.spec.pro?.coastlineEngine === 'gshhs_high' ||
          state.spec.pro?.coastlineEngine === 'gshhs_full';
        const usePro =
          fmt === 'pdf' ||
          (state.proAvailable &&
            ((state.spec.pro?.basemapProvider && state.spec.pro.basemapProvider !== 'none') || wantsGshhs));

        if (usePro) {
          showToast('Rendering With & No Borders batch via Python Pro...', 'info', 2600);
          const res = await renderBatchViaPythonPro({
            format: fmt === 'jpeg' || fmt === 'pdf' || fmt === 'svg' ? fmt : 'png',
            includeBorderPair: true,
            spec: state.spec,
          });
          showToast(`Downloaded ${res.filename}`, 'success');
          return;
        }

        const rasterFmt = fmt === 'jpeg' ? 'jpeg' : 'png';
        const exportDs = getActiveRenderDatasets() || state.datasets;
        const results = await exportBrowserPairWithWithoutBorders(state.spec, exportDs, rasterFmt);
        showToast(`Downloaded pair: ${results.map((r) => r.filename).join(' & ')}`, 'success', 4200);
      } catch (err) {
        showToast(`Pair export failed: ${err.message}`, 'error', 5000);
      }
    },

    onSearchPlaces: async (query) => {
      const trimmed = String(query || '').trim();
      if (!trimmed) return;
      state.searchAbortController?.abort();
      state.searchAbortController = new AbortController();

      try {
        setLoadingProgress(true, `Searching "${trimmed}"...`);
        const results = await searchPlaces(trimmed, {
          signal: state.searchAbortController.signal,
        });
        setLoadingProgress(false);

        renderSearchResults(results, {
          onFrame: (item) => {
            patchSpec({
              center: { lat: item.lat, lon: item.lon },
              span: { lonDeg: item.spanLonDeg, latDeg: item.spanLatDeg },
            });
            showToast(`Framed on ${item.name}`, 'success', 2200);
          },
          onPin: (item) => {
            const exists = (state.spec.cities || []).some(
              (c) =>
                c.name.toLowerCase() === item.name.toLowerCase() &&
                Math.abs(c.lat - item.lat) < 0.05 &&
                Math.abs(c.lon - item.lon) < 0.05,
            );
            if (exists) {
              showToast(`${item.name} is already pinned.`, 'info', 2200);
              return;
            }
            const nextCities = [
              ...(state.spec.cities || []),
              {
                id: `${sanitizeFilename(item.name, 'pin').toLowerCase()}_${Date.now()}`,
                name: item.name,
                lat: item.lat,
                lon: item.lon,
                style: item.type?.includes('country') ? 'capital' : 'dot',
                dx: 6,
                dy: -5,
                scale: 1.0,
              },
            ];
            patchSpec({ cities: nextCities });
            showToast(`Added pin: ${item.name}`, 'success', 2200);
          },
        });
      } catch (err) {
        setLoadingProgress(false);
        if (err?.name !== 'AbortError') {
          showToast(`Search failed: ${err.message}`, 'error', 4000);
        }
      }
    },

    onPatchSpec: (patch, opts) => patchSpec(patch, opts),

    onApplyTheme: (themeId) => {
      const theme = COLOR_THEMES[themeId];
      if (!theme) return;
      const defaultHighlightFills = new Set([
        ...Object.values(COLOR_THEMES).map((t) => String(t.highlightFill).toLowerCase()),
        '#585b58',
        '#646464',
        '#656765',
        '#686c68',
        '#6d706d',
        '#707270',
        '#7a7d7a',
        '#7e837e',
        '#8c8e8c',
      ]);
      const defaultHighlightStrokes = new Set([
        ...Object.values(COLOR_THEMES).map((t) => String(t.highlightStroke).toLowerCase()),
        '#ffffff',
        '#111111',
      ]);
      const updatedCountries = (state.spec.highlightedCountries || []).map((country) => {
        const curFill = String(country.fill || '').toLowerCase();
        const curStroke = String(country.stroke || '').toLowerCase();
        return {
          ...country,
          fill: defaultHighlightFills.has(curFill) ? theme.highlightFill : country.fill,
          stroke: defaultHighlightStrokes.has(curStroke) ? theme.highlightStroke : country.stroke,
        };
      });
      patchSpec({
        theme: themeId,
        colors: {
          land: theme.land,
          water: theme.water,
          borders: theme.borders,
          coastline: theme.coastline,
          rivers: theme.rivers,
          admin1: theme.admin1,
          bathymetry: theme.bathymetry,
          urban: theme.urban,
          highlightFill: theme.highlightFill,
          highlightStroke: theme.highlightStroke,
          text: theme.text,
          textHalo: theme.textHalo,
        },
        highlightedCountries: updatedCountries,
      });
      showToast(`Applied theme: ${theme.label}`, 'info', 2000);
    },

    onToggleCoastlineNone: () => {
      const currentlyNone = !state.spec.colors.coastline || state.spec.colors.coastline === 'none';
      if (currentlyNone) {
        const fallback =
          state.spec.colors.borders && state.spec.colors.borders !== '#ffffff'
            ? state.spec.colors.borders
            : '#111111';
        patchSpec({
          colors: { coastline: fallback },
          layers: { showCoastlines: true },
        });
      } else {
        patchSpec({
          colors: { coastline: 'none' },
          layers: { showCoastlines: false },
        });
      }
    },

    onToggleMode: (targetMode) => {
      state.mode = state.mode === targetMode ? 'pan' : targetMode;
      syncAllUi();
    },

    onLoadGeoBoundaries: async (countryId, countryName, level = 'ADM1', { asPrimaryLand = false } = {}) => {
      const iso3 = resolveIso3FromNumericId(countryId);
      if (!iso3) {
        showToast(`No ISO-3 code mapping found for "${countryName}". Try loading a GeoJSON URL directly.`, 'warn', 4200);
        return;
      }
      try {
        setLoadingProgress(true, `Fetching OSM ${level} boundaries for ${countryName}...`);
        const result = await fetchGeoBoundariesLayer(iso3, level);
        setLoadingProgress(false);
        const label = `${countryName} (${level} OSM)`;
        const colors = state.spec.colors || {};
        const layersSpec = state.spec.layers || {};
        const landStroke =
          level === 'ADM0'
            ? (layersSpec.showCoastlines && colors.coastline && colors.coastline !== 'none' ? colors.coastline : 'none')
            : (colors.admin1 || colors.borders || '#737373');
        const layer = asPrimaryLand
          ? {
              id: `gb_${iso3}_${level}`,
              label,
              url: result.url,
              data: result.data,
              visible: true,
              role: 'land',
              color: colors.land || '#4a4a4a',
              strokeColor: landStroke,
              fillOpacity: 1.0,
              strokeWidth: level === 'ADM0' ? (layersSpec.showCoastlines ? (layersSpec.coastlineWidth || 0.75) : 0.6) : level === 'ADM2' ? 0.5 : 0.7,
              dashed: false,
              hatch: 'none',
            }
          : {
              id: `gb_${iso3}_${level}_${Date.now()}`,
              label,
              url: result.url,
              data: result.data,
              visible: true,
              role: 'overlay',
              color: level === 'ADM0' ? '#0284c7' : level === 'ADM2' ? '#64748b' : '#475569',
              strokeColor: null,
              fillOpacity: level === 'ADM0' ? 0.14 : 0.0,
              strokeWidth: level === 'ADM0' ? 1.6 : level === 'ADM2' ? 0.7 : 1.0,
              dashed: level === 'ADM2',
              hatch: 'none',
            };

        const existing = (state.spec.customGeoJsonLayers || []).filter(
          (l) => !(asPrimaryLand && l?.id === layer.id),
        );
        const patch = {
          customGeoJsonLayers: [...existing, layer],
        };
        if (asPrimaryLand) {
          patch.layers = { showLand: false };
          const normId = String(countryId || '');
          const normName = String(countryName || '').trim().toLowerCase();
          const filteredHighlights = (state.spec.highlightedCountries || []).filter(
            (hc) => String(hc.id || '') !== normId && String(hc.name || '').trim().toLowerCase() !== normName,
          );
          if (filteredHighlights.length !== (state.spec.highlightedCountries || []).length) {
            patch.highlightedCountries = filteredHighlights;
          }
        }
        patchSpec(patch);
        showToast(
          asPrimaryLand
            ? `Loaded ${label} as Primary Land Map — default land unshaded${result.admUnitCount ? ` (${result.admUnitCount} units)` : ''}`
            : `Loaded ${label}${result.admUnitCount ? ` (${result.admUnitCount} units)` : ''}`,
          'success',
          3800,
        );
      } catch (err) {
        setLoadingProgress(false);
        showToast(`geoBoundaries error: ${err.message}`, 'error', 4800);
      }
    },

    onSwitchShadowSourceType: async (sourceType) => {
      if (sourceType !== 'admin1') return;
      if (state.admin1Polygons) {
        syncAdmin1Catalog(state.admin1Polygons);
        return;
      }
      try {
        setLoadingProgress(true, 'Loading global state & province shapes...');
        const fc = await loadAdmin1Polygons();
        state.admin1Polygons = fc;
        if (state.datasets) {
          state.datasets = { ...state.datasets, admin1Polygons: fc };
        }
        if (state.fastDatasets) {
          state.fastDatasets = { ...state.fastDatasets, admin1Polygons: fc };
        }
        syncAdmin1Catalog(fc);
        setLoadingProgress(false);
      } catch (err) {
        setLoadingProgress(false);
        showToast(`Could not load states/provinces: ${err.message}`, 'error', 4500);
      }
    },

    onAddShadow: async (sourceType, sourceId, sourceName) => {
      if (sourceType === 'admin1' && !state.admin1Polygons) {
        try {
          setLoadingProgress(true, 'Loading state & province shapes...');
          state.admin1Polygons = await loadAdmin1Polygons();
          if (state.datasets) {
            state.datasets = { ...state.datasets, admin1Polygons: state.admin1Polygons };
          }
          setLoadingProgress(false);
        } catch (err) {
          setLoadingProgress(false);
          showToast(`Could not load state geometry: ${err.message}`, 'error', 4200);
          return;
        }
      }

      const existing = state.spec.regionShadows || [];
      const palette = SHADOW_PALETTE[existing.length % SHADOW_PALETTE.length];
      const targetLat = Math.max(-84, Math.min(84, Number(state.spec.center?.lat) || 0));
      const targetLon = Number(state.spec.center?.lon) || 0;

      const nextShadow = {
        id: `shadow_${Date.now()}_${existing.length + 1}`,
        sourceType: sourceType === 'admin1' ? 'admin1' : 'country',
        sourceId: String(sourceId || ''),
        sourceName: String(sourceName || sourceId),
        targetLat: Number(targetLat.toFixed(3)),
        targetLon: Number(targetLon.toFixed(3)),
        rotationDeg: 0,
        fill: palette.fill,
        stroke: palette.stroke,
        opacity: 0.35,
        strokeWidth: 1.6,
        dashed: true,
        hatch: 'none',
        showLabel: true,
        showArea: true,
        visible: true,
      };

      state.mode = 'shadow';
      patchSpec({ regionShadows: [...existing, nextShadow] });
      showToast(
        `Shadowed ${nextShadow.sourceName} at true geodesic scale — drag on map to compare!`,
        'success',
        3400,
      );
    },

    onUpdateShadow: (idx, patch, opts = {}) => {
      const next = [...(state.spec.regionShadows || [])];
      if (!next[idx]) return;
      next[idx] = { ...next[idx], ...patch };
      patchSpec({ regionShadows: next }, opts);
    },

    onCenterShadow: (idx) => {
      const next = [...(state.spec.regionShadows || [])];
      if (!next[idx]) return;
      next[idx] = {
        ...next[idx],
        targetLat: Number(Math.max(-84, Math.min(84, Number(state.spec.center?.lat) || 0)).toFixed(3)),
        targetLon: Number((Number(state.spec.center?.lon) || 0).toFixed(3)),
      };
      patchSpec({ regionShadows: next });
      showToast(`Centered ${next[idx].sourceName} shadow in view`, 'info', 2000);
    },

    onRemoveShadow: (idx) => {
      const next = [...(state.spec.regionShadows || [])];
      const removed = next.splice(idx, 1)[0];
      if (next.length === 0 && state.mode === 'shadow') {
        state.mode = 'pan';
      }
      patchSpec({ regionShadows: next });
      if (removed) {
        showToast(`Removed shadow: ${removed.sourceName}`, 'info', 2000);
      }
    },

    onAddCountry: (id, name) => {
      const existing = state.spec.highlightedCountries || [];
      if (existing.some((c) => (id && c.id === id) || c.name.toLowerCase() === name.toLowerCase())) {
        showToast(`${name} is already highlighted.`, 'info', 2200);
        return;
      }
      patchSpec({
        highlightedCountries: [
          ...existing,
          {
            id: String(id || ''),
            name: String(name || id),
            fill: state.spec.colors?.highlightFill || '#7a7d7a',
            stroke: state.spec.colors?.highlightStroke || '#ffffff',
            hatch: 'none',
          },
        ],
      });
      showToast(`Highlighted ${name}`, 'success', 2000);
    },

    onUpdateCountry: (idx, patch, opts = {}) => {
      const next = [...(state.spec.highlightedCountries || [])];
      if (!next[idx]) return;
      next[idx] = { ...next[idx], ...patch };
      patchSpec({ highlightedCountries: next }, opts);
    },

    onRemoveCountry: (idx) => {
      const next = [...(state.spec.highlightedCountries || [])];
      next.splice(idx, 1);
      patchSpec({ highlightedCountries: next });
    },

    onAutoAddCities: async () => {
      await ensureDatasetsForSpec({ forcePlaces: true });
      if (!state.datasets?.populatedPlaces) {
        showToast('City dataset could not be loaded yet.', 'warn');
        return;
      }
      const picked = pickTopCitiesInExtent(
        state.datasets,
        state.spec.center,
        state.spec.span,
        8,
      );
      if (!picked.length) {
        showToast('No major cities found inside current view.', 'warn');
        return;
      }

      const normalizeCityKey = (str) => String(str || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const current = [...(state.spec.cities || [])];
      const existingNames = new Set(current.map((c) => normalizeCityKey(c.name)));
      let addedCount = 0;
      for (const city of picked) {
        const cleanName = String(city.name || '').replace(/\s+/g, ' ').trim();
        const key = normalizeCityKey(cleanName);
        const nearExisting = current.some(
          (c) => Math.abs(c.lat - city.lat) < 0.12 && Math.abs(c.lon - city.lon) < 0.12,
        );
        if (!key || existingNames.has(key) || nearExisting) continue;
        existingNames.add(key);
        current.push({
          id: city.id,
          name: cleanName,
          lat: city.lat,
          lon: city.lon,
          style: city.style,
          dx: city.dx,
          dy: city.dy,
          scale: 1.0,
        });
        addedCount += 1;
      }

      if (addedCount === 0) {
        showToast('All major cities in view are already pinned.', 'info');
      } else {
        patchSpec({ cities: current });
        showToast(`Added ${addedCount} major ${addedCount === 1 ? 'city' : 'cities'} in view.`, 'success');
      }
    },

    onUpdateCity: (idx, patch, opts = {}) => {
      const next = [...(state.spec.cities || [])];
      if (!next[idx]) return;
      next[idx] = { ...next[idx], ...patch };
      patchSpec({ cities: next }, opts);
    },

    onRemoveCity: (idx) => {
      const next = [...(state.spec.cities || [])];
      next.splice(idx, 1);
      patchSpec({ cities: next });
    },

    onUploadGeoJsonFile: async (file) => {
      try {
        const text = await file.text();
        const data = validateLocalGeoJson(JSON.parse(text));
        const label = file.name.replace(/\.(geo)?json$/i, '') || 'Uploaded GeoJSON';
        await addGeoJsonLayer({ label, url: null, data });
      } catch (err) {
        showToast(`GeoJSON upload error: ${err.message}`, 'error', 4500);
      }
    },

    onLoadGeoJsonUrl: async (url, customLabel = '', style = {}) => {
      try {
        setLoadingProgress(true, 'Fetching custom GeoJSON...');
        const data = await fetchCustomGeoJson(url);
        setLoadingProgress(false);
        const derivedName =
          customLabel ||
          decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'Remote GeoJSON').replace(
            /\.(geo)?json$/i,
            '',
          );
        await addGeoJsonLayer({ label: derivedName, url, data, style });
        const urlInput = document.getElementById('geojson-url-input');
        if (urlInput && !customLabel) urlInput.value = '';
      } catch (err) {
        setLoadingProgress(false);
        showToast(`Could not load GeoJSON URL: ${err.message}`, 'error', 4800);
      }
    },

    onUpdateGeoJsonLayer: (idx, patch, opts = {}) => {
      const next = [...(state.spec.customGeoJsonLayers || [])];
      if (!next[idx]) return;
      const targetLayer = next[idx];
      next[idx] = { ...targetLayer, ...patch };
      if (patch?.visible === false) {
        hideFeatureHover();
        if (state.selectedFeature?.layer?.id === targetLayer.id) {
          closeFeatureInfoCard();
        }
      }
      patchSpec({ customGeoJsonLayers: next }, opts);
    },

    onToggleGeoJsonPrimaryLand: (idx) => {
      const next = [...(state.spec.customGeoJsonLayers || [])];
      const cur = next[idx];
      if (!cur) return;
      const promoting = cur.role !== 'land';
      const colors = state.spec.colors || {};
      if (promoting) {
        const isAdm0 = /ADM0/i.test(cur.label || '') || /ADM0/i.test(cur.id || '');
        next[idx] = {
          ...cur,
          visible: true,
          role: 'land',
          color: colors.land || '#4a4a4a',
          strokeColor: isAdm0 ? 'none' : (colors.admin1 || colors.borders || '#737373'),
          fillOpacity: 1.0,
          strokeWidth: isAdm0 ? 0.6 : 0.7,
          dashed: false,
        };
        patchSpec({
          customGeoJsonLayers: next,
          layers: { showLand: false },
        });
        showToast(`"${cur.label}" set as Primary Land Map — default land unshaded`, 'success', 3000);
      } else {
        next[idx] = {
          ...cur,
          role: 'overlay',
          fillOpacity: 0.14,
          strokeColor: null,
        };
        const stillHasLand = next.some((l) => l?.visible !== false && l?.role === 'land');
        patchSpec({
          customGeoJsonLayers: next,
          ...(stillHasLand ? {} : { layers: { showLand: true } }),
        });
        showToast(
          stillHasLand
            ? `"${cur.label}" switched back to overlay`
            : `"${cur.label}" switched to overlay — default land restored`,
          'info',
          2600,
        );
      }
    },

    onRestoreDefaultLand: () => {
      patchSpec({ layers: { showLand: true } });
      showToast('Default land shading restored', 'info', 2200);
    },

    onRemoveGeoJsonLayer: (idx) => {
      const next = [...(state.spec.customGeoJsonLayers || [])];
      const [removed] = next.splice(idx, 1);
      hideFeatureHover();
      if (removed && state.selectedFeature?.layer?.id === removed.id) {
        closeFeatureInfoCard();
      }
      const stillHasLand = next.some((l) => l?.visible !== false && l?.role === 'land');
      patchSpec({
        customGeoJsonLayers: next,
        ...(removed?.role === 'land' && !stillHasLand && state.spec.layers?.showLand === false
          ? { layers: { showLand: true } }
          : {}),
      });
    },

    onToggleRefPeek: async () => {
      state.refPeek = !state.refPeek;
      syncAllUi();
      if (state.refPeek && !state.datasets?.populatedPlaces) {
        await ensureDatasetsForSpec({ forcePlaces: true });
      }
      scheduleRender();
    },

    onZoom: (factor) => applyZoomFactor(factor, { commitHistory: true }),

    onResetView: () => {
      const preset = state.activePresetId
        ? REGION_PRESETS.find((p) => p.id === state.activePresetId)
        : REGION_PRESETS[0];
      const base = preset ? preset.spec : createDefaultMapSpec();
      patchSpec({
        center: { ...base.center },
        span: { ...base.span },
      });
      showToast('Reset view framing', 'info', 1800);
    },

    onRenderPro: async () => {
      if (!state.proAvailable) return;
      const fmt = document.getElementById('export-format')?.value || 'png';
      try {
        showToast(`Rendering ${fmt.toUpperCase()} via Python Pro...`, 'info', 2500);
        const res = await renderViaPythonPro(state.spec, fmt);
        showToast(`Downloaded ${res.filename}`, 'success');
      } catch (err) {
        showToast(`Python Pro render error: ${err.message}`, 'error', 5000);
      }
    },

    onExportBatchPro: async () => {
      if (!state.proAvailable) return;
      const rawFmt = document.getElementById('export-format')?.value || 'png';
      const fmt = ['png', 'jpeg', 'pdf', 'svg'].includes(rawFmt) ? rawFmt : 'png';
      try {
        showToast('Rendering all region presets (.zip) via Python Pro...', 'info', 3500);
        const res = await renderBatchViaPythonPro({
          format: fmt,
          includeBorderPair: false,
          items: REGION_PRESETS.map((p) => ({
            filename: sanitizeFilename(p.id, 'preset'),
            spec: p.spec,
          })),
        });
        showToast(`Downloaded batch archive: ${res.filename}`, 'success', 4500);
      } catch (err) {
        showToast(`Batch export error: ${err.message}`, 'error', 5000);
      }
    },
  };
}

async function hydrateRemoteGeoJsonLayers() {
  const layers = state.spec?.customGeoJsonLayers || [];
  let updated = false;
  const nextLayers = [...layers];

  for (let i = 0; i < nextLayers.length; i += 1) {
    const layer = nextLayers[i];
    if (layer.url && !layer.data) {
      try {
        const data = await fetchCustomGeoJson(layer.url);
        nextLayers[i] = { ...layer, data };
        updated = true;
      } catch {
        // Leave layer intact if remote GeoJSON temporarily unavailable
      }
    }
  }

  if (updated) {
    state.spec = normalizeMapSpec({ ...state.spec, customGeoJsonLayers: nextLayers });
    scheduleRender();
  }
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName?.toLowerCase();
    const editingText = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;

    if ((e.ctrlKey || e.metaKey) && !editingText) {
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }

    if (e.key === 'Escape') {
      if (state.selectedFeature) {
        closeFeatureInfoCard();
      }
      if (state.mode !== 'pan') {
        state.mode = 'pan';
        syncAllUi();
      }
    }
  });
}

function init() {
  const { spec, source } = loadInitialSpec();
  state.spec = spec;
  state.history = [structuredClone(spec)];
  state.historyIndex = 0;

  if (source === 'default') {
    state.activePresetId = 'ukraine_briefing';
  }

  renderControls(buildCallbacks());
  setupCanvasInteractions();
  setupKeyboardShortcuts();

  const viewport = document.getElementById('stage-viewport');
  if (viewport && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      layoutCanvasSize();
      scheduleRender();
    });
    ro.observe(viewport);
  }
  window.addEventListener('resize', () => {
    layoutCanvasSize();
    scheduleRender();
  });

  syncAllUi();
  layoutCanvasSize();
  scheduleRender();

  void boot();
  void hydrateRemoteGeoJsonLayers();
  void initPythonProHealth();

  if (source === 'link') {
    showToast('Loaded shared map from URL!', 'success', 2600);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
