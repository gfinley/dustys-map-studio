import {
  COLOR_THEMES,
  createDefaultMapSpec,
  decodeSpecFromHash,
  encodeSpecToHash,
  getPixelDimensions,
  normalizeMapSpec,
  sanitizeFilename,
} from './schema.js?v=4';
import {
  ensureDatasets,
  fetchCustomGeoJson,
  getCitiesInBounds,
  getCountryCatalog,
  resolveResolution,
} from './data-loader.js?v=4';
import {
  buildProjection,
  hitTestCountry,
  renderMapToCanvas,
  screenToLonLat,
} from './cartography.js?v=4';
import {
  checkPythonProHealth,
  exportBrowserPairWithWithoutBorders,
  exportBrowserRaster,
  exportBrowserSvg,
  inspectGeoJsonViaPythonPro,
  renderBatchViaPythonPro,
  renderViaPythonPro,
} from './exporter.js?v=4';
import { REGION_PRESETS } from './presets.js?v=4';
import { pickTopCitiesInExtent, searchPlaces } from './search.js?v=4';
import {
  populateCountryCatalog,
  renderControls,
  renderSearchResults,
  setLoadingProgress,
  showToast,
  syncControlsFromSpec,
  updateCursorCoordinates,
} from './controls.js?v=4';

const STORAGE_KEY = 'dusty_mapmaker_last_spec';
const MAX_HISTORY = 40;

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
  countryCatalog: [],
  lastProjection: null,
  mode: 'pan', // 'pan' | 'country' | 'pin'
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
  const merged = deepMergeSpec(state.spec, patch);
  commitSpec(merged, { commitHistory, keepPreset, skipDynamicLists });
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
}

function updateFastDatasetsCache(loaded) {
  if (loaded?.resolution !== '50m') return;
  const prev = state.fastDatasets;
  state.fastDatasets = {
    ...(prev || {}),
    ...loaded,
    lakes: loaded.lakes || prev?.lakes || null,
    rivers: loaded.rivers || prev?.rivers || null,
    admin1: loaded.admin1 || prev?.admin1 || null,
    populatedPlaces: loaded.populatedPlaces || prev?.populatedPlaces || null,
  };
}

function drawReferencePeekOverlay(canvas, projection, datasets = state.datasets) {
  if (!state.refPeek || !datasets?.populatedPlaces || !projection) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const scaleFactor = canvas.width / 900;
  const candidates = pickTopCitiesInExtent(
    datasets,
    state.spec.center,
    state.spec.span,
    24,
  );
  if (!candidates.length) return;

  const existingNames = new Set(
    (state.spec.cities || []).map((c) => String(c.name || '').trim().toLowerCase()),
  );

  ctx.save();
  const fontSize = Math.max(10, Math.round(11.5 * scaleFactor));
  ctx.font = `italic 600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';

  const placedBoxes = [];
  for (const city of candidates) {
    if (existingNames.has(city.name.toLowerCase())) continue;
    const pt = projection([city.lon, city.lat]);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const [x, y] = pt;
    if (x < 12 || x > canvas.width - 12 || y < 12 || y > canvas.height - 12) continue;

    const textW = ctx.measureText(city.name).width;
    const box = { x1: x + 6, y1: y - fontSize * 0.7, x2: x + 12 + textW, y2: y + fontSize * 0.7 };
    const overlaps = placedBoxes.some(
      (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2),
    );
    if (overlaps) continue;
    placedBoxes.push(box);

    // Subtle amber reference dot + readable translucent tag (preview only)
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.2, 2.8 * scaleFactor), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
    ctx.fill();
    ctx.lineWidth = Math.max(0.8, 1.0 * scaleFactor);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.stroke();

    const lx = x + 6 * scaleFactor;
    const ly = y;
    ctx.lineWidth = Math.max(2.5, 3.2 * scaleFactor);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeText(city.name, lx, ly);
    ctx.fillStyle = '#fde68a';
    ctx.fillText(city.name, lx, ly);
  }
  ctx.restore();
}

function getActiveRenderDatasets() {
  if (state.isInteracting && state.fastDatasets) {
    const res = state.datasets?.resolution;
    const spanLon = Number(state.spec?.span?.lonDeg || 24);
    if (res === '10m' || (res === '110m' && spanLon <= 95)) {
      return {
        ...state.fastDatasets,
        rivers: state.fastDatasets.rivers || null,
        admin1: state.fastDatasets.admin1 || state.datasets?.admin1 || null,
        populatedPlaces: state.fastDatasets.populatedPlaces || state.datasets?.populatedPlaces || null,
      };
    }
  }
  return state.datasets;
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
    return;
  }

  const activeDatasets = getActiveRenderDatasets();
  const result = renderMapToCanvas(canvas, state.spec, activeDatasets, {
    interactive: state.isInteracting,
  });
  state.lastProjection = result?.projection || buildProjection(state.spec, canvas.width, canvas.height);

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
  const needFineHydro =
    spec.detailLevel === '10m' &&
    Math.max(Number(spec.span?.lonDeg) || 24, Number(spec.span?.latDeg) || 14) <= 4;
  if (needFineHydro && !datasets.fineHydrology) return false;
  if (spec.layers?.showLakes !== false && !datasets.lakes) return false;
  if (spec.layers?.showRivers && !datasets.rivers) return false;
  if (spec.layers?.showAdmin1 && !datasets.admin1) return false;
  if (needPlaces && !datasets.populatedPlaces) return false;
  return true;
}

async function ensureDatasetsForSpec({ forcePlaces = false } = {}) {
  const spec = state.spec;
  if (!spec) return;

  const needLakes = spec.layers?.showLakes !== false;
  const needRivers = Boolean(spec.layers?.showRivers);
  const needAdmin1 = Boolean(spec.layers?.showAdmin1);
  const needPlaces = Boolean(forcePlaces || state.refPeek || state.datasets?.populatedPlaces);
  const fineHydrology =
    spec.detailLevel === '10m' &&
    Math.max(Number(spec.span?.lonDeg) || 24, Number(spec.span?.latDeg) || 14) <= 4;

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
    scheduleRender();
    return;
  }

  const token = ++state.loadRequestToken;
  const neededRes = resolveResolution(spec);

  try {
    setLoadingProgress(true, `Loading ${neededRes} map data...`);
    const loaded = await ensureDatasets(neededRes, {
      needLakes,
      needRivers,
      needAdmin1,
      needPlaces,
      fineHydrology,
      onProgress: ({ label, completed, total }) => {
        if (token !== state.loadRequestToken) return;
        setLoadingProgress(true, `${label} (${completed}/${total})`);
      },
    });

    if (token !== state.loadRequestToken) return;
    state.datasets = loaded;
    updateFastDatasetsCache(loaded);
    syncCountryCatalog(loaded);

    setLoadingProgress(false);
    scheduleRender();
  } catch (err) {
    if (token !== state.loadRequestToken) return;
    setLoadingProgress(false);
    showToast(`Map data error: ${err.message}`, 'error', 5000);
  }
}

async function boot() {
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

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.spec) return;
    pointerDown = true;
    dragging = false;
    startClientX = e.clientX;
    startClientY = e.clientY;
    const pt = getCanvasPointerCoords(canvas, e);
    startCanvasX = pt.x;
    startCanvasY = pt.y;
    startCenter = { ...state.spec.center };
    startProjection = state.lastProjection || buildProjection(state.spec, canvas.width, canvas.height);
    startLonLat = screenToLonLat(startProjection, pt.x, pt.y);
    canvas.setPointerCapture?.(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointerDown && startCenter) {
      const dist = Math.hypot(e.clientX - startClientX, e.clientY - startClientY);
      if (dist > 4) {
        dragging = true;
        canvas.classList.add('dragging');
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
        let nextLon;
        let nextLat;

        const curLonLat = startProjection ? screenToLonLat(startProjection, pt.x, pt.y) : null;
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
        });
      }
    }
  });

  const finishPointer = (e, wasCancelled = false) => {
    if (!pointerDown) return;
    pointerDown = false;
    canvas.classList.remove('dragging');
    canvas.releasePointerCapture?.(e.pointerId);

    if (wasCancelled || dragging) {
      if (dragging) {
        dragging = false;
        state.isInteracting = false;
        commitSpec(state.spec, { commitHistory: true });
      }
      return;
    }

    // Handle single click
    const pt = getCanvasPointerCoords(canvas, e);
    if (state.mode === 'country') {
      handleCountryMapClick(pt.x, pt.y);
    } else if (state.mode === 'pin') {
      handlePinMapClick(pt.x, pt.y);
    }
  };

  canvas.addEventListener('pointerup', (e) => finishPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => finishPointer(e, true));

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!state.spec) return;
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
  const MIN_SPAN_DEG = 1.5;
  const MAX_LON_DEG = 360;
  const MAX_LAT_DEG = 175;
  const curLon = Math.max(0.05, Number(state.spec.span.lonDeg) || 24);
  const curLat = Math.max(0.05, Number(state.spec.span.latDeg) || 14);
  const minFactor = Math.max(MIN_SPAN_DEG / curLon, MIN_SPAN_DEG / curLat);
  const maxFactor = Math.min(MAX_LON_DEG / curLon, MAX_LAT_DEG / curLat);
  const clampedFactor =
    minFactor <= maxFactor ? Math.max(minFactor, Math.min(maxFactor, factor)) : factor;
  const nextLon = Math.max(
    MIN_SPAN_DEG,
    Math.min(MAX_LON_DEG, Number((curLon * clampedFactor).toFixed(3))),
  );
  const nextLat = Math.max(
    MIN_SPAN_DEG,
    Math.min(MAX_LAT_DEG, Number((curLat * clampedFactor).toFixed(3))),
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
    },
  ];
  patchSpec({ cities });
  showToast(`Dropped "${defaultName}" (${lat.toFixed(2)}°, ${lon.toFixed(2)}°). Rename in Countries & Pins.`, 'success', 2800);
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

async function addGeoJsonLayer({ label, url = null, data }) {
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
    color: '#d97706',
    fillOpacity: 0.35,
    strokeWidth: 1.6,
    dashed: false,
    hatch: 'none',
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
      state.activePresetId = preset.id;
      commitSpec(structuredClone(preset.spec), { commitHistory: true, keepPreset: true });
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
        const usePro =
          fmt === 'pdf' ||
          (state.proAvailable && state.spec.pro?.basemapProvider && state.spec.pro.basemapProvider !== 'none');

        if (usePro) {
          showToast(`Rendering ${fmt.toUpperCase()} via Python Pro...`, 'info', 2500);
          const res = await renderViaPythonPro(state.spec, fmt);
          showToast(`Downloaded ${res.filename}`, 'success');
          return;
        }

        if (fmt === 'svg') {
          const res = await exportBrowserSvg(state.spec, state.datasets);
          showToast(`Downloaded Vector SVG: ${res.filename}`, 'success');
          return;
        }

        const dims = getPixelDimensions(state.spec.page);
        showToast(`Exporting ${dims.widthPx}×${dims.heightPx} (${dims.dpi} DPI) ${fmt.toUpperCase()}...`, 'info', 2200);
        const res = await exportBrowserRaster(state.spec, state.datasets, fmt);
        showToast(`Downloaded ${res.filename}`, 'success');
      } catch (err) {
        showToast(`Export failed: ${err.message}`, 'error', 5000);
      }
    },

    onExportPair: async (format) => {
      const fmt = String(format || 'png').toLowerCase();
      try {
        const usePro =
          fmt === 'pdf' ||
          (state.proAvailable && state.spec.pro?.basemapProvider && state.spec.pro.basemapProvider !== 'none');

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
        const results = await exportBrowserPairWithWithoutBorders(state.spec, state.datasets, rasterFmt);
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

    onUpdateCity: (idx, patch) => {
      const next = [...(state.spec.cities || [])];
      if (!next[idx]) return;
      next[idx] = { ...next[idx], ...patch };
      patchSpec({ cities: next });
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

    onLoadGeoJsonUrl: async (url, customLabel = '') => {
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
        await addGeoJsonLayer({ label: derivedName, url, data });
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
      next[idx] = { ...next[idx], ...patch };
      patchSpec({ customGeoJsonLayers: next }, opts);
    },

    onRemoveGeoJsonLayer: (idx) => {
      const next = [...(state.spec.customGeoJsonLayers || [])];
      next.splice(idx, 1);
      patchSpec({ customGeoJsonLayers: next });
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

    if (e.key === 'Escape' && state.mode !== 'pan') {
      state.mode = 'pan';
      syncAllUi();
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
