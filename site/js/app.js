import {
  COLOR_THEMES,
  createDefaultMapSpec,
  decodeSpecFromHash,
  encodeSpecToHash,
  getPixelDimensions,
  normalizeMapSpec,
  sanitizeFilename,
  stripLegacyAutoPins,
} from './schema.js?v=31';
import {
  ensureDatasets,
  fetchCustomGeoJson,
  fetchGeoBoundariesLayer,
  fetchOsmCoastlineForBounds,
  filterGeoJsonToAlaska,
  getAdmin1Catalog,
  getCitiesInBounds,
  getCountryCatalog,
  getMarineLabelsInBounds,
  loadAdmin1Polygons,
  resolveAdmin1Scale,
  resolveIso3FromNumericId,
  resolveResolution,
} from './data-loader.js?v=31';
import {
  buildProjection,
  computeVisibleBounds,
  findHostHighlightedCountry,
  hitTestCountry,
  hitTestGeoJsonPoint,
  renderMapToCanvas,
  screenToLonLat,
} from './cartography.js?v=31';
import {
  OSM_COASTLINE_MAX_SPAN_DEG,
  computePaddedCoastlineBBox,
  isOsmCoastlineUrl,
} from './osm-coastline.js?v=31';
import {
  TERRAIN_STYLES,
  fetchTerrainDemForBounds,
  isViewOutsideTerrainBounds,
} from './terrain-relief.js?v=31';
import {
  checkPythonProHealth,
  exportBrowserPairWithWithoutBorders,
  exportBrowserRaster,
  exportBrowserSvg,
  inspectGeoJsonViaPythonPro,
  renderBatchViaPythonPro,
  renderViaPythonPro,
} from './exporter.js?v=31';
import {
  AIRFIELD_1941_LAYERS,
  ALASKA_AIRFIELDS_ALL_LAYER_DEFS,
  PHILIPPINES_RAIL_1942_LAYERS,
  REGION_PRESETS,
  buildAlaskaYearLayerDefs,
} from './presets.js?v=31';
import { pickTopCitiesInExtent, searchPlaces } from './search.js?v=31';
import {
  closeMobileDrawers,
  populateCountryCatalog,
  populateShadowRegionCatalog,
  renderControls,
  renderSearchResults,
  setLoadingProgress,
  showToast,
  syncControlsFromSpec,
  updateCursorCoordinates,
} from './controls.js?v=31';
import {
  computeRegionAreaKm2,
  findUnderlyingCountryAt,
  hitTestShadow,
  resolveShadowSourceFeature,
} from './shadow.js?v=31';
import {
  ALASKA_AIRFIELDS_CSV_URL,
  TIMELINE_LAYER_PREFIX,
  computeAnnualSeries,
  exportTimelineSliceCsv,
  extractAirportCode,
  generateTimelineLayers,
  loadTimelineDataset,
  normalizeTimelineDataset,
  resolveSourceUrl,
} from './timeline.js?v=31';

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

const PALETTE_KEYS = [
  'land',
  'water',
  'borders',
  'coastline',
  'rivers',
  'text',
  'admin1',
  'bathymetry',
  'urban',
];

const PALETTE_LAYER_LINKS = {
  land: 'showLand',
  borders: 'showBorders',
  coastline: 'showCoastlines',
  rivers: 'showRivers',
  admin1: 'showAdmin1',
  bathymetry: 'showBathymetry',
  urban: 'showUrbanAreas',
};

const PALETTE_FALLBACKS = {
  land: '#4a4a4a',
  water: '#d1cfcf',
  borders: '#ffffff',
  coastline: '#111111',
  rivers: '#73a9ca',
  text: '#111111',
  admin1: '#737373',
  bathymetry: '#bfbdbd',
  urban: '#636363',
};

function isNoneColor(val) {
  if (typeof val !== 'string') return false;
  const cleaned = val.trim().toLowerCase();
  return cleaned === 'none' || cleaned === 'transparent';
}

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
  alaskaYear: 1943,
  timeline: {
    dataset: null,
    windowSize: '1', // Defaults to 1-year window
    startYear: 1939,
    endYear: 1939,
    mode: 'cumulative_split',
    regionFilter: 'all',
    dotSize: 1.5,
    includeMilitary: true,
    includeCivilian: true,
    splitDualUse: false,
    includeConstruction: false,
    includeSeaplane: true,
    autoSync: true,
    playTimer: null,
    lastResult: null,
  },
  mode: 'pan', // 'pan' | 'country' | 'pin' | 'shadow'
  refPeek: false,
  proAvailable: false,
  proStatusText: '',
  activePresetId: '',
  lastPaletteColors: {},
  hdCoastlineColorMode: 'host', // 'host' | 'land' | 'custom'
  hdCoastlineCustomColor: null,
  hdCoastlineReplacedHighlight: null,
  gbReplacedHighlights: [],
  terrainData: null,
  terrainMeta: null,
  terrainFetchSeq: 0,
  loadRequestToken: 0,
  searchAbortController: null,
  wheelCommitTimer: null,
  rafRenderPending: false,
  isInteracting: false,
  pendingCoordsEvent: null,
  coordsRafId: 0,
};

function resolveRestoredPaletteColor(key) {
  const remembered = state.lastPaletteColors[key];
  if (remembered && !isNoneColor(remembered)) {
    return remembered;
  }
  const theme = COLOR_THEMES[state.spec?.theme] || COLOR_THEMES.dusty_prime;
  const fromTheme = theme?.[key];
  if (fromTheme && !isNoneColor(fromTheme)) {
    return fromTheme;
  }
  if (key === 'coastline') {
    const borders = state.spec?.colors?.borders;
    if (borders && !isNoneColor(borders) && borders.toLowerCase() !== '#ffffff') {
      return borders;
    }
  }
  return PALETTE_FALLBACKS[key] || '#4a4a4a';
}

function loadInitialSpec() {
  const fromHash = decodeSpecFromHash(window.location.hash);
  if (fromHash) {
    return { spec: fromHash, source: 'link' };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const normalized = normalizeMapSpec(JSON.parse(raw));
      const { spec: cleaned, removedCount } = stripLegacyAutoPins(normalized);
      if (removedCount > 0) {
        saveDraftToStorage(cleaned);
      }
      return { spec: cleaned, source: 'draft' };
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

function isOsmHdLayer(layer) {
  return Boolean(
    layer &&
      (String(layer.id || '').startsWith('osm_hd_coastline') || isOsmCoastlineUrl(layer.url)),
  );
}

function isGeoBoundariesLayer(layer) {
  return Boolean(layer && String(layer.id || '').startsWith('gb_'));
}

function isSuperAccuracyLayer(layer) {
  return isOsmHdLayer(layer) || isGeoBoundariesLayer(layer);
}

function mergeRestoredHighlights(currentHighlights, toRestore) {
  const list = [...(currentHighlights || [])];
  let changed = false;
  for (const stashed of toRestore || []) {
    if (!stashed) continue;
    const alreadyPresent = list.some(
      (hc) =>
        (stashed.id && String(hc.id || '') === String(stashed.id)) ||
        (stashed.name && String(hc.name || '').toLowerCase() === String(stashed.name).toLowerCase()),
    );
    if (!alreadyPresent) {
      list.push(structuredClone(stashed));
      changed = true;
    }
  }
  return changed ? list : null;
}

function toggleSuperAccuracyLayers(matcher, labelName, forceVisible = null) {
  const spec = state.spec;
  const current = spec?.customGeoJsonLayers || [];
  const matching = current.filter(matcher);
  if (!matching.length) return false;

  const anyCurrentlyVisible = matching.some((l) => l.visible !== false);
  const nextVisible = forceVisible !== null ? Boolean(forceVisible) : !anyCurrentlyVisible;
  const touchesHd = matching.some(isOsmHdLayer);
  const touchesGb = matching.some(isGeoBoundariesLayer);
  const touchesLand = matching.some((l) => l.role === 'land');

  const nextLayers = current.map((l) => (matcher(l) ? { ...l, visible: nextVisible } : l));
  const patch = { customGeoJsonLayers: nextLayers };

  if (!nextVisible) {
    hideFeatureHover();
    if (state.selectedFeature?.layer && matcher(state.selectedFeature.layer)) {
      closeFeatureInfoCard();
    }
    const stillHasVisibleLand = nextLayers.some((l) => l?.visible !== false && l?.role === 'land');
    if (touchesLand && !stillHasVisibleLand) {
      patch.layers = { showLand: true };
      if (isNoneColor(spec.colors?.land)) {
        patch.colors = { land: resolveRestoredPaletteColor('land') };
      }
      const restorePool = [];
      if (touchesHd && state.hdCoastlineReplacedHighlight) {
        restorePool.push(state.hdCoastlineReplacedHighlight);
      }
      if (touchesGb && state.gbReplacedHighlights.length) {
        restorePool.push(...state.gbReplacedHighlights);
      }
      const merged = mergeRestoredHighlights(spec.highlightedCountries, restorePool);
      if (merged) {
        patch.highlightedCountries = merged;
      }
    }
    patchSpec(patch);
    showToast(
      touchesLand && !stillHasVisibleLand
        ? `${labelName} toggled off — default map shown`
        : `${labelName} hidden`,
      'info',
      2400,
    );
  } else {
    if (touchesLand) {
      patch.layers = { showLand: false };
      let nextHighlights = spec.highlightedCountries || [];
      let highlightsChanged = false;
      if (touchesHd) {
        const visibleBounds = computeCurrentVisibleBounds(spec);
        const colorInfo = resolveHdCoastlineColorInfo(spec, state.hdCoastlineColorMode, visibleBounds);
        if (colorInfo.liveHost) {
          const normId = String(colorInfo.liveHost.id || '');
          const normName = String(colorInfo.liveHost.name || '').trim().toLowerCase();
          const removed = nextHighlights.find(
            (hc) =>
              (normId && String(hc.id || '') === normId) ||
              (normName && String(hc.name || '').trim().toLowerCase() === normName),
          );
          if (removed) {
            state.hdCoastlineReplacedHighlight = structuredClone(removed);
            nextHighlights = nextHighlights.filter((hc) => hc !== removed);
            highlightsChanged = true;
          }
        }
      }
      if (touchesGb && state.gbReplacedHighlights.length) {
        const replacedIds = new Set(state.gbReplacedHighlights.map((h) => String(h.id || '')));
        const replacedNames = new Set(
          state.gbReplacedHighlights.map((h) => String(h.name || '').trim().toLowerCase()),
        );
        const filtered = nextHighlights.filter(
          (hc) =>
            !replacedIds.has(String(hc.id || '')) &&
            !replacedNames.has(String(hc.name || '').trim().toLowerCase()),
        );
        if (filtered.length !== nextHighlights.length) {
          nextHighlights = filtered;
          highlightsChanged = true;
        }
      }
      if (highlightsChanged) {
        patch.highlightedCountries = nextHighlights;
      }
    }
    patchSpec(patch);
    showToast(`${labelName} toggled on`, 'success', 2200);
  }
  return true;
}

function removeSuperAccuracyLayers(matcher, labelName) {
  const spec = state.spec;
  const current = spec?.customGeoJsonLayers || [];
  const removedList = current.filter(matcher);
  if (!removedList.length) return false;

  const nextLayers = current.filter((l) => !matcher(l));
  const removedHadLand = removedList.some((l) => l.role === 'land');
  const removedHd = removedList.some(isOsmHdLayer);
  const removedGb = removedList.some(isGeoBoundariesLayer);

  hideFeatureHover();
  if (state.selectedFeature?.layer && matcher(state.selectedFeature.layer)) {
    closeFeatureInfoCard();
  }

  const patch = { customGeoJsonLayers: nextLayers };
  const stillHasVisibleLand = nextLayers.some((l) => l?.visible !== false && l?.role === 'land');
  const restoreDefault = removedHadLand && !stillHasVisibleLand;

  if (restoreDefault || (removedHadLand && spec.layers?.showLand === false && !stillHasVisibleLand)) {
    patch.layers = { showLand: true };
    if (isNoneColor(spec.colors?.land)) {
      patch.colors = { land: resolveRestoredPaletteColor('land') };
    }
    const restorePool = [];
    if (removedHd && state.hdCoastlineReplacedHighlight) {
      restorePool.push(state.hdCoastlineReplacedHighlight);
    }
    if (removedGb && state.gbReplacedHighlights.length) {
      restorePool.push(...state.gbReplacedHighlights);
    }
    const merged = mergeRestoredHighlights(spec.highlightedCountries, restorePool);
    if (merged) {
      patch.highlightedCountries = merged;
    }
  }

  if (removedHd && !nextLayers.some(isOsmHdLayer)) {
    state.hdCoastlineReplacedHighlight = null;
  }
  if (removedGb && !nextLayers.some(isGeoBoundariesLayer)) {
    state.gbReplacedHighlights = [];
  }

  patchSpec(patch);
  showToast(
    restoreDefault
      ? `Removed ${labelName} — default map restored`
      : `Removed ${labelName}`,
    'info',
    2600,
  );
  return true;
}

function computeCurrentVisibleBounds(spec) {
  const { widthPx, heightPx } = getPixelDimensions(spec?.page);
  const projWidth = Math.max(200, Math.min(1200, widthPx));
  const projHeight = Math.max(200, Math.round((projWidth * heightPx) / Math.max(1, widthPx)));
  const projection = buildProjection(spec, projWidth, projHeight);
  return computeVisibleBounds(spec, projection, projWidth, projHeight);
}

function resolveHdCoastlineColorInfo(spec, modeOverride = null, visibleBoundsOverride = null) {
  const mode = modeOverride || state.hdCoastlineColorMode || 'host';
  const colors = spec?.colors || {};
  const landFill = !isNoneColor(colors.land) && colors.land
    ? colors.land
    : resolveRestoredPaletteColor('land');
  const bounds = visibleBoundsOverride || computeCurrentVisibleBounds(spec);
  const ds = state.datasets || state.fastDatasets;

  // Detect live highlighted host country covering current view, or fallback to stashed host / geoBoundaries land
  const liveHost = findHostHighlightedCountry(spec, ds, bounds);
  const activeGbLand = (spec?.customGeoJsonLayers || []).find(
    (l) => l && l.visible !== false && l.role === 'land' && String(l.id || '').startsWith('gb_'),
  );
  const stashedHost = state.hdCoastlineReplacedHighlight
    ? {
        ...state.hdCoastlineReplacedHighlight,
        fill:
          !isNoneColor(colors.highlightFill) && colors.highlightFill
            ? colors.highlightFill
            : state.hdCoastlineReplacedHighlight.fill,
      }
    : null;
  const hostCountry = liveHost || stashedHost || null;

  const activeHdLayer = (spec?.customGeoJsonLayers || []).find(
    (l) => l && l.visible !== false && isOsmHdLayer(l),
  );

  if (mode === 'custom') {
    const color =
      state.hdCoastlineCustomColor ||
      (activeHdLayer && !isNoneColor(activeHdLayer.color) ? activeHdLayer.color : null) ||
      hostCountry?.fill ||
      landFill;
    return {
      mode,
      color,
      hostCountry,
      liveHost,
      sourceLabel: 'Custom',
    };
  }

  if (mode === 'land') {
    return {
      mode,
      color: landFill,
      hostCountry,
      liveHost,
      sourceLabel: 'Land Fill',
    };
  }

  // mode === 'host'
  if (hostCountry && hostCountry.fill && !isNoneColor(hostCountry.fill)) {
    return {
      mode: 'host',
      color: hostCountry.fill,
      hostCountry,
      liveHost,
      sourceLabel: hostCountry.name || 'Host Country',
    };
  }
  if (activeGbLand && activeGbLand.color && !isNoneColor(activeGbLand.color)) {
    return {
      mode: 'host',
      color: activeGbLand.color,
      hostCountry: null,
      liveHost: null,
      sourceLabel: activeGbLand.label || 'Primary Land',
    };
  }
  return {
    mode: 'host',
    color: landFill,
    hostCountry: null,
    liveHost: null,
    sourceLabel: 'Land Fill',
  };
}

function patchSpec(patch, { commitHistory = true, keepPreset = false, skipDynamicLists = false } = {}) {
  const prevColors = state.spec?.colors || {};
  const prevLayers = state.spec?.layers || {};
  let effectivePatch = patch;
  const hasAnySyncTarget =
    Array.isArray(state.spec?.customGeoJsonLayers) &&
    state.spec.customGeoJsonLayers.some((l) => l?.role === 'land' || isOsmHdLayer(l));

  if (
    (patch?.colors || patch?.layers || patch?.highlightedCountries) &&
    !patch.customGeoJsonLayers &&
    hasAnySyncTarget
  ) {
    const nextColors = { ...prevColors, ...(patch.colors || {}) };
    const nextLayers = { ...prevLayers, ...(patch.layers || {}) };
    const previewSpec = {
      ...state.spec,
      colors: nextColors,
      layers: nextLayers,
      ...(patch.highlightedCountries ? { highlightedCountries: patch.highlightedCountries } : {}),
    };
    let changed = false;
    const syncedLayers = state.spec.customGeoJsonLayers.map((layer) => {
      if (isOsmHdLayer(layer)) {
        const next = { ...layer };
        const hdMode = state.hdCoastlineColorMode || 'host';
        if (hdMode === 'land' && typeof patch.colors?.land === 'string') {
          if (isNoneColor(patch.colors.land)) {
            next.fillOpacity = 0;
          } else {
            next.color = patch.colors.land;
            next.fillOpacity = 1.0;
          }
          changed = true;
        } else if (
          hdMode === 'host' &&
          (typeof patch.colors?.highlightFill === 'string' ||
            typeof patch.colors?.land === 'string' ||
            Array.isArray(patch.highlightedCountries))
        ) {
          const info = resolveHdCoastlineColorInfo(previewSpec, 'host');
          if (info.color && !isNoneColor(info.color)) {
            next.color = info.color;
            next.fillOpacity = 1.0;
            changed = true;
          }
        }
        if (
          typeof patch.colors?.coastline === 'string' ||
          typeof patch.layers?.showCoastlines === 'boolean' ||
          typeof patch.layers?.coastlineWidth === 'number'
        ) {
          const wantStroke =
            Boolean(nextLayers.showCoastlines) &&
            Boolean(nextColors.coastline) &&
            !isNoneColor(nextColors.coastline);
          next.strokeColor = wantStroke ? nextColors.coastline : 'none';
          next.strokeWidth = Number(nextLayers.coastlineWidth) || 0.75;
          changed = true;
        }
        return next;
      }

      if (layer?.role !== 'land') return layer;
      const next = { ...layer };

      if (
        typeof patch.colors?.land === 'string' &&
        !isNoneColor(patch.colors.land) &&
        String(layer.color || '').toLowerCase() === String(prevColors.land || '').toLowerCase()
      ) {
        next.color = patch.colors.land;
        changed = true;
      }
      if (layer.strokeColor && layer.strokeColor !== 'none') {
        const prevStroke = String(layer.strokeColor).toLowerCase();
        if (typeof patch.colors?.admin1 === 'string' && prevStroke === String(prevColors.admin1 || '').toLowerCase()) {
          next.strokeColor = patch.colors.admin1;
          changed = true;
        } else if (typeof patch.colors?.borders === 'string' && prevStroke === String(prevColors.borders || '').toLowerCase()) {
          next.strokeColor = patch.colors.borders;
          changed = true;
        } else if (typeof patch.colors?.coastline === 'string' && prevStroke === String(prevColors.coastline || '').toLowerCase()) {
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
  const hdColorInfo = state.spec ? resolveHdCoastlineColorInfo(state.spec) : null;
  syncControlsFromSpec(state.spec, {
    canUndo: state.historyIndex > 0,
    canRedo: state.historyIndex < state.history.length - 1,
    proAvailable: state.proAvailable,
    proStatusText: state.proStatusText,
    mode: state.mode,
    refPeek: state.refPeek,
    activePresetId: state.activePresetId,
    alaskaYear: state.alaskaYear,
    hdCoastlineColorMode: state.hdCoastlineColorMode,
    hdCoastlineColor: hdColorInfo?.color || '#7a7d7a',
    hdHostCountryName: hdColorInfo?.hostCountry?.name || '',
    terrainLoaded: Boolean(state.terrainData),
    terrainBounds: state.terrainData?.bounds || state.spec?.terrainRelief?.bounds || null,
    terrainStats: state.terrainData?.stats || null,
    terrainMeta: state.terrainMeta,
    terrainViewBounds: state.spec ? computeCurrentVisibleBounds(state.spec) : null,
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
  void hydrateRemoteGeoJsonLayers();
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
  void hydrateRemoteGeoJsonLayers();
}

function layoutCanvasSize() {
  const viewport = document.getElementById('stage-viewport');
  const canvas = document.getElementById('map-canvas');
  if (!viewport || !canvas || !state.spec) return;

  const cs = window.getComputedStyle(viewport);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 14;
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + 14;
  const availW = Math.max(160, viewport.clientWidth - padX);
  const availH = Math.max(160, viewport.clientHeight - padY);
  const widthIn = Number(state.spec.page?.widthIn) || 4.6;
  const heightIn = Number(state.spec.page?.heightIn) || 7.0;
  const aspect = Math.max(0.2, Math.min(5, widthIn / heightIn));

  let cssW = availW;
  let cssH = cssW / aspect;
  if (cssH > availH) {
    cssH = availH;
    cssW = cssH * aspect;
  }

  const roundedCssW = Math.max(140, Math.round(cssW));
  const roundedCssH = Math.max(140, Math.round(cssH));
  canvas.style.width = `${roundedCssW}px`;
  canvas.style.height = `${roundedCssH}px`;

  // Keep logical canvas crisp across mobile and desktop while capping preview max dimension at 1380px
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const minLogicalW = window.innerWidth <= 640 ? 640 : 800;
  let targetW = Math.max(minLogicalW, Math.round(roundedCssW * dpr));
  let targetH = Math.max(160, Math.round(targetW / aspect));

  const maxDim = Math.max(targetW, targetH);
  if (maxDim > 1380) {
    const scale = 1380 / maxDim;
    targetW = Math.max(160, Math.round(targetW * scale));
    targetH = Math.max(160, Math.round(targetH * scale));
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
  const terrainRelief = state.terrainData || null;
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
        terrainRelief,
        populatedPlaces: state.fastDatasets.populatedPlaces || state.datasets?.populatedPlaces || null,
      };
    }
  }
  if (!state.datasets) return null;
  if ((admin1Polygons && !state.datasets.admin1Polygons) || terrainRelief) {
    return {
      ...state.datasets,
      ...(admin1Polygons ? { admin1Polygons } : {}),
      ...(terrainRelief ? { terrainRelief } : {}),
    };
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
      if (isNoneColor(state.spec.colors?.water)) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = state.spec.colors?.water || '#d1cfcf';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
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

  const nextTerrainMeta = result?.terrainMeta || null;
  const prevTerrainSig = state.terrainMeta
    ? `${state.terrainMeta.effectiveInterval}|${state.terrainMeta.maxVisibleElev}|${state.terrainMeta.skippedReason || ''}`
    : '';
  const nextTerrainSig = nextTerrainMeta
    ? `${nextTerrainMeta.effectiveInterval}|${nextTerrainMeta.maxVisibleElev}|${nextTerrainMeta.skippedReason || ''}`
    : '';
  state.terrainMeta = nextTerrainMeta;
  if (!state.isInteracting && prevTerrainSig !== nextTerrainSig && state.spec?.terrainRelief?.enabled) {
    syncAllUi({ skipDynamicLists: true });
  }

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

  const activePointers = new Map();
  let primaryPointerId = null;
  let pointerDown = false;
  let dragging = false;
  let pinching = false;
  let suppressTapUntilAllUp = false;
  let startClientX = 0;
  let startClientY = 0;
  let startCanvasX = 0;
  let startCanvasY = 0;
  let startCenter = null;
  let startProjection = null;
  let startLonLat = null;
  let draggingShadowIdx = -1;
  let startShadowAnchor = null;

  // Multi-touch pinch state
  let startPinchDist = 0;
  let startPinchMidX = 0;
  let startPinchMidY = 0;
  let startPinchSpan = null;
  let startPinchCenter = null;
  let startPinchRect = null;

  const getPinchMetrics = () => {
    const pts = Array.from(activePointers.values());
    if (pts.length < 2) return null;
    const [p1, p2] = pts;
    const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
    return {
      dist: Math.max(10, dist),
      midX: (p1.clientX + p2.clientX) * 0.5,
      midY: (p1.clientY + p2.clientY) * 0.5,
    };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || !state.spec) return;
    activePointers.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType || 'mouse',
    });
    canvas.setPointerCapture?.(e.pointerId);

    // Second finger down -> switch cleanly to two-finger pinch-zoom + pan
    if (activePointers.size === 2) {
      const metrics = getPinchMetrics();
      if (metrics) {
        pinching = true;
        suppressTapUntilAllUp = true;
        pointerDown = false;
        dragging = false;
        draggingShadowIdx = -1;
        startShadowAnchor = null;
        primaryPointerId = null;
        canvas.classList.remove('dragging');
        hideFeatureHover();
        if (state.wheelCommitTimer) {
          clearTimeout(state.wheelCommitTimer);
          state.wheelCommitTimer = null;
        }
        startPinchDist = metrics.dist;
        startPinchMidX = metrics.midX;
        startPinchMidY = metrics.midY;
        startPinchSpan = {
          lonDeg: Math.max(0.005, Number(state.spec.span?.lonDeg) || 24),
          latDeg: Math.max(0.005, Number(state.spec.span?.latDeg) || 14),
        };
        startPinchCenter = { ...state.spec.center };
        startPinchRect = canvas.getBoundingClientRect();
        state.isInteracting = true;
      }
      return;
    }

    if (activePointers.size > 2 || pinching) return;

    primaryPointerId = e.pointerId;
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
  });

  canvas.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, {
        clientX: e.clientX,
        clientY: e.clientY,
        pointerType: e.pointerType || 'mouse',
      });
    }

    // Two-finger pinch-to-zoom + midpoint pan
    if (pinching && activePointers.size >= 2 && startPinchSpan && startPinchCenter && state.spec) {
      const metrics = getPinchMetrics();
      if (!metrics) return;
      state.isInteracting = true;
      const MIN_SPAN_DEG = 0.005;
      const MAX_LON_DEG = 360;
      const MAX_LAT_DEG = 175;
      const rawFactor = startPinchDist / metrics.dist;
      const minFactor = Math.max(MIN_SPAN_DEG / startPinchSpan.lonDeg, MIN_SPAN_DEG / startPinchSpan.latDeg);
      const maxFactor = Math.min(MAX_LON_DEG / startPinchSpan.lonDeg, MAX_LAT_DEG / startPinchSpan.latDeg);
      const clampedFactor =
        minFactor <= maxFactor ? Math.max(minFactor, Math.min(maxFactor, rawFactor)) : rawFactor;

      const nextLonSpan = Math.max(
        MIN_SPAN_DEG,
        Math.min(MAX_LON_DEG, Number((startPinchSpan.lonDeg * clampedFactor).toFixed(4))),
      );
      const nextLatSpan = Math.max(
        MIN_SPAN_DEG,
        Math.min(MAX_LAT_DEG, Number((startPinchSpan.latDeg * clampedFactor).toFixed(4))),
      );

      const rectW = Math.max(100, startPinchRect?.width || canvas.clientWidth || 320);
      const rectH = Math.max(100, startPinchRect?.height || canvas.clientHeight || 320);
      const dxNorm = (metrics.midX - startPinchMidX) / rectW;
      const dyNorm = (metrics.midY - startPinchMidY) / rectH;
      const nextCenterLon = Number(wrapLon(startPinchCenter.lon - dxNorm * nextLonSpan).toFixed(3));
      const nextCenterLat = Number(
        Math.max(-85, Math.min(85, startPinchCenter.lat + dyNorm * nextLatSpan)).toFixed(3),
      );

      state.spec.span.lonDeg = nextLonSpan;
      state.spec.span.latDeg = nextLatSpan;
      state.spec.center.lon = nextCenterLon;
      state.spec.center.lat = nextCenterLat;

      setNumericInputValue('span-lon', nextLonSpan);
      setNumericInputValue('span-lat', nextLatSpan);
      setNumericInputValue('center-lat', nextCenterLat);
      setNumericInputValue('center-lon', nextCenterLon);
      clearActivePresetDirect();
      scheduleRender();
      return;
    }

    if (pointerDown && e.pointerId === primaryPointerId && startCenter) {
      const dist = Math.hypot(e.clientX - startClientX, e.clientY - startClientY);
      const dragThreshold = e.pointerType === 'touch' ? 8 : 3;
      if (dist > dragThreshold) {
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

    // Skip hover coordinate/tooltip updates for touch pointers
    if (e.pointerType === 'touch') return;

    if (state.lastProjection) {
      state.pendingCoordsEvent = e;
      if (!state.coordsRafId) {
        state.coordsRafId = requestAnimationFrame(() => {
          state.coordsRafId = 0;
          const ev = state.pendingCoordsEvent;
          state.pendingCoordsEvent = null;
          if (!ev || !state.lastProjection || dragging || pinching) return;
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
    activePointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);

    if (pinching) {
      if (activePointers.size < 2) {
        pinching = false;
        startPinchSpan = null;
        startPinchCenter = null;
        startPinchRect = null;
        state.isInteracting = false;
        commitSpec(state.spec, { commitHistory: true });
      }
      if (activePointers.size === 0) {
        suppressTapUntilAllUp = false;
      }
      return;
    }

    if (suppressTapUntilAllUp) {
      if (activePointers.size === 0) {
        suppressTapUntilAllUp = false;
      }
      pointerDown = false;
      primaryPointerId = null;
      return;
    }

    if (!pointerDown || e.pointerId !== primaryPointerId) return;
    pointerDown = false;
    primaryPointerId = null;
    const wasShadowDrag = draggingShadowIdx >= 0;
    draggingShadowIdx = -1;
    startShadowAnchor = null;
    canvas.classList.remove('dragging');

    if (wasCancelled || dragging) {
      if (dragging) {
        dragging = false;
        state.isInteracting = false;
        commitSpec(state.spec, { commitHistory: true, keepPreset: wasShadowDrag });
      }
      return;
    }

    // Handle single click / tap
    const pt = getCanvasPointerCoords(canvas, e);
    if (state.mode === 'country') {
      handleCountryMapClick(pt.x, pt.y);
    } else if (state.mode === 'pin') {
      handlePinMapClick(pt.x, pt.y);
    } else if (state.mode === 'shadow') {
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

    const subtitleParts = [p.subregion, p.territory_1941 || p.territory].filter(Boolean);
    const subtitleText =
      p.dataset === 'alaska_airfields_1939_1945'
        ? [p.region, p.snapshot_year ? `${p.snapshot_year} (${formatEnumLabel(p.year_status)})` : '']
            .filter(Boolean)
            .join(' · ')
        : subtitleParts.length > 0
          ? subtitleParts.join(' · ')
          : p.region || p.modern_country || (p.category ? hit.layer?.label : '');
    if (subtitleText) {
      tooltip.appendChild(createFeatureEl('div', 'fht-subtitle', subtitleText));
    }

    const metaParts = [
      p.strategic_role || p.operator_1941 || p.operator_1939_1945,
      p.surface_wartime
        ? formatEnumLabel(p.surface_wartime)
        : p.surface_1941
          ? formatEnumLabel(p.surface_1941)
          : '',
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

  const isAlaskaAirfield = p.dataset === 'alaska_airfields_1939_1945' || Boolean(p.timeline_1939_1945);
  const isAirfieldSchema = Boolean(
    !isAlaskaAirfield &&
      (p.territory_1941 || p.control_dec_1941 || p.operator_1941 || p.facility_class || p.surface_1941),
  );

  if (isAlaskaAirfield) {
    addRow(
      'Snapshot Status',
      [p.snapshot_year, formatEnumLabel(p.year_status), p.is_new_in_year ? '(New in Window)' : '']
        .filter(Boolean)
        .join(' — '),
    );
    addRow('Region', [p.region, p.territory].filter(Boolean).join(', '));
    addRow('Strategic Role', p.strategic_role);
    addRow('Facility Type', formatEnumLabel(p.airfield_type));
    addRow('Opened', p.opened_date);
    addRow('1939–1945 Arc', p.timeline_1939_1945);
    addRow('Operator(s)', p.operator_1939_1945);
    addRow('Surface / Runways', [formatEnumLabel(p.surface_wartime), p.runway_specs].filter(Boolean).join(' — '));
    const modernCode = extractAirportCode(p.modern_equivalent);
    if (modernCode) {
      grid.appendChild(createFeatureEl('div', 'fic-key', 'Modern Site'));
      const modernVal = createFeatureEl('div', 'fic-val');
      const a = document.createElement('a');
      a.className = 'fic-link';
      a.href = `https://www.airnav.com/airport/${encodeURIComponent(modernCode)}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `${p.modern_equivalent} ↗`;
      modernVal.appendChild(a);
      grid.appendChild(modernVal);
    } else {
      addRow('Modern Site', p.modern_equivalent);
    }
    addRow('Proof Summary', p.proof_summary);
    if (Array.isArray(p.primary_sources) && p.primary_sources.length > 0) {
      grid.appendChild(createFeatureEl('div', 'fic-key', 'Sources'));
      const srcVal = createFeatureEl('div', 'fic-val fic-links-wrap');
      for (const srcLabel of p.primary_sources) {
        const href = resolveSourceUrl(srcLabel, p);
        if (href) {
          const a = document.createElement('a');
          a.className = 'fic-link-chip';
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = `Open reference: ${srcLabel}`;
          a.textContent = `${srcLabel} ↗`;
          srcVal.appendChild(a);
        } else {
          srcVal.appendChild(createFeatureEl('span', 'fic-link-chip', srcLabel));
        }
      }
      grid.appendChild(srcVal);
    }
    addRow('Confidence', formatEnumLabel(p.source_confidence));
  } else if (isAirfieldSchema) {
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
  } else if (p.feature_type === 'station' || (p.line && p.island && p.role)) {
    addRow('Railway Line', p.line);
    addRow('Island', p.island);
    addRow('Station Role', formatEnumLabel(p.role));
    if (p.km_post !== null && p.km_post !== undefined && p.km_post !== '') {
      addRow('Km Post', `km ${p.km_post}`);
    }
    if (p.system) addRow('System', p.system);
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

function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stopTimelinePlay() {
  if (state.timeline.playTimer) {
    clearInterval(state.timeline.playTimer);
    state.timeline.playTimer = null;
  }
  const btn = document.getElementById('btn-timeline-play');
  if (btn) btn.textContent = '▶ Play';
}

function syncTimelineWindowBounds() {
  const tl = state.timeline;
  const ds = tl.dataset;
  const minY = ds ? ds.minYear : 1939;
  const maxY = ds ? ds.maxYear : 1945;

  tl.startYear = Math.max(minY, Math.min(maxY, Number(tl.startYear) || minY));
  if (tl.windowSize === 'all') {
    tl.startYear = minY;
    tl.endYear = maxY;
  } else if (tl.windowSize === 'custom') {
    tl.endYear = Math.max(tl.startYear, Math.min(maxY, Number(tl.endYear) || tl.startYear));
  } else {
    const spanYears = Math.max(1, Number(tl.windowSize) || 1);
    const maxStart = Math.max(minY, maxY - (spanYears - 1));
    tl.startYear = Math.min(tl.startYear, maxStart);
    tl.endYear = Math.min(maxY, tl.startYear + spanYears - 1);
  }
}

function populateTimelineDatasetSelectors() {
  const ds = state.timeline.dataset;
  if (!ds) return;

  const slider = document.getElementById('timeline-year-slider');
  if (slider) {
    slider.min = String(ds.minYear);
    slider.max = String(ds.maxYear);
  }

  const ticksEl = document.getElementById('timeline-year-ticks');
  if (ticksEl) {
    ticksEl.replaceChildren();
    for (const y of ds.years) {
      const sp = document.createElement('span');
      sp.textContent = String(y);
      ticksEl.appendChild(sp);
    }
  }

  const startSel = document.getElementById('timeline-start-year');
  const endSel = document.getElementById('timeline-end-year');
  for (const sel of [startSel, endSel]) {
    if (!sel) continue;
    sel.replaceChildren();
    for (const y of ds.years) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      sel.appendChild(opt);
    }
  }

  const regSel = document.getElementById('timeline-region-filter');
  if (regSel) {
    const prev = state.timeline.regionFilter;
    regSel.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All Regions';
    regSel.appendChild(allOpt);
    for (const reg of ds.regions) {
      const opt = document.createElement('option');
      opt.value = reg;
      opt.textContent = reg;
      regSel.appendChild(opt);
    }
    state.timeline.regionFilter = ds.regions.includes(prev) ? prev : 'all';
    regSel.value = state.timeline.regionFilter;
  }
}

function renderTimelineUi() {
  const tl = state.timeline;
  const ds = tl.dataset;
  if (!ds) return;

  syncTimelineWindowBounds();
  const result = generateTimelineLayers(ds, {
    startYear: tl.startYear,
    endYear: tl.endYear,
    mode: tl.mode,
    splitDualUse: tl.splitDualUse,
    includeMilitary: tl.includeMilitary,
    includeCivilian: tl.includeCivilian,
    includeConstruction: tl.includeConstruction,
    includeSeaplane: tl.includeSeaplane,
    regionFilter: tl.regionFilter,
    dotSize: tl.dotSize,
  });
  tl.lastResult = result;

  const spanCount = tl.endYear - tl.startYear + 1;
  const badge = document.getElementById('timeline-window-badge');
  if (badge) {
    badge.textContent = `${result.stats.windowLabel} (${spanCount} ${spanCount === 1 ? 'yr' : 'yrs'})`;
  }
  const rangeLbl = document.getElementById('timeline-range-label');
  if (rangeLbl) rangeLbl.textContent = result.stats.windowLabel;

  const slider = document.getElementById('timeline-year-slider');
  if (slider) {
    slider.value = String(tl.startYear);
    slider.disabled = tl.windowSize === 'all';
  }

  const customRow = document.getElementById('timeline-custom-range-row');
  if (customRow) customRow.hidden = tl.windowSize !== 'custom';
  const startSel = document.getElementById('timeline-start-year');
  const endSel = document.getElementById('timeline-end-year');
  if (startSel) startSel.value = String(tl.startYear);
  if (endSel) endSel.value = String(tl.endYear);

  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };
  setTxt('tl-stat-total', result.stats.totalActive);
  setTxt('tl-stat-mil', result.stats.militaryOnly);
  setTxt('tl-stat-dual', result.stats.dualUse);
  setTxt('tl-stat-civ', result.stats.civilianOnly);
  setTxt('tl-stat-new', `+${result.stats.newOperational}`);

  // Interactive stacked progression bar chart
  const chartEl = document.getElementById('timeline-chart');
  if (chartEl) {
    const series = computeAnnualSeries(ds, {
      includeSeaplane: tl.includeSeaplane,
      regionFilter: tl.regionFilter,
    });
    const maxTotal = Math.max(1, ...series.map((s) => s.total));
    chartEl.style.gridTemplateColumns = `repeat(${series.length}, 1fr)`;
    chartEl.replaceChildren();

    for (const item of series) {
      const inWin = item.year >= tl.startYear && item.year <= tl.endYear;
      const col = document.createElement('button');
      col.type = 'button';
      col.className = `tl-bar-col${inWin ? ' in-window' : ''}`;
      col.title = `${item.year}: ${item.total} active (${item.military} Mil, ${item.dual_use} Dual, ${item.civilian} Civ)`;
      col.addEventListener('click', () => {
        stopTimelinePlay();
        if (tl.windowSize === 'all' || tl.windowSize === 'custom') {
          tl.windowSize = '1';
          const ws = document.getElementById('timeline-window-size');
          if (ws) ws.value = '1';
        }
        tl.startYear = item.year;
        renderTimelineUi();
        if (tl.autoSync) applyTimelineLayersToMap({ quiet: true });
      });

      const stack = document.createElement('div');
      stack.className = 'tl-bar-stack';
      const maxH = 56;
      const totalH = Math.max(2, Math.round((item.total / maxTotal) * maxH));
      stack.style.height = `${totalH}px`;

      const addSeg = (cls, count) => {
        if (!count || !item.total) return;
        const seg = document.createElement('div');
        seg.className = cls;
        seg.style.flex = String(count);
        stack.appendChild(seg);
      };
      addSeg('tl-seg-mil', item.military);
      addSeg('tl-seg-dual', item.dual_use);
      addSeg('tl-seg-civ', item.civilian);

      const yr = document.createElement('span');
      yr.className = 'tl-bar-yr';
      yr.textContent = String(item.year).slice(2);

      col.append(stack, yr);
      chartEl.appendChild(col);
    }
  }

  return result;
}

function applyTimelineLayersToMap({ quiet = false, commitHistory = false } = {}) {
  const result = state.timeline.lastResult || renderTimelineUi();
  if (!result) return;

  const akPresetIds = new Set(ALASKA_AIRFIELDS_ALL_LAYER_DEFS.map((d) => d.id));
  const preserved = (state.spec.customGeoJsonLayers || []).filter(
    (l) => !l?.id || (!l.id.startsWith(TIMELINE_LAYER_PREFIX) && !akPresetIds.has(l.id)),
  );
  patchSpec({ customGeoJsonLayers: [...preserved, ...result.layers] }, { commitHistory });
  if (!quiet) {
    showToast(
      `Generated ${result.layers.length} timeline layer(s) for ${result.stats.windowLabel} (${result.combinedGeoJson.features.length} airfields).`,
      'success',
      2600,
    );
  }
}

async function ensureTimelineDatasetLoaded() {
  if (state.timeline.dataset) {
    renderTimelineUi();
    return state.timeline.dataset;
  }
  try {
    setLoadingProgress(true, 'Loading Alaska Airfields (1939–1945) CSV...');
    const ds = await loadTimelineDataset(ALASKA_AIRFIELDS_CSV_URL, 'Alaska Airfields (1939–1945)');
    state.timeline.dataset = ds;
    state.timeline.startYear = ds.minYear;
    state.timeline.endYear = ds.minYear;
    populateTimelineDatasetSelectors();
    renderTimelineUi();
    setLoadingProgress(false);
    return ds;
  } catch (err) {
    setLoadingProgress(false);
    showToast(`Could not load timeline CSV: ${err.message}`, 'error', 4500);
    return null;
  }
}

function buildCallbacks() {
  return {
    onSelectPreset: (presetId) => {
      const preset = REGION_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      hideFeatureHover();
      closeFeatureInfoCard();
      closeMobileDrawers();
      state.hdCoastlineReplacedHighlight = null;
      state.gbReplacedHighlights = [];
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
        void hydrateRemoteGeoJsonLayers();
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
            closeMobileDrawers();
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
      const hasPrimaryLand = (state.spec.customGeoJsonLayers || []).some(
        (l) => l && l.visible !== false && l.role === 'land',
      );
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
        ...(isNoneColor(state.spec.colors?.land) && !hasPrimaryLand
          ? { layers: { showLand: true } }
          : {}),
        highlightedCountries: updatedCountries,
      });
      showToast(`Applied theme: ${theme.label}`, 'info', 2000);
    },

    onPickPaletteColor: (key, value, opts = {}) => {
      if (!PALETTE_KEYS.includes(key)) return;
      state.lastPaletteColors[key] = value;
      const wasNone = isNoneColor(state.spec.colors?.[key]);
      const layerKey = PALETTE_LAYER_LINKS[key];
      const patch = { colors: { [key]: value } };
      if (layerKey && (wasNone || key === 'coastline')) {
        patch.layers = { [layerKey]: true };
      }
      patchSpec(patch, opts);
    },

    onTogglePaletteColorNone: (key) => {
      if (!PALETTE_KEYS.includes(key)) return;
      const current = state.spec.colors?.[key];
      const currentlyNone = !current || isNoneColor(current);
      const layerKey = PALETTE_LAYER_LINKS[key];

      if (currentlyNone) {
        const restored = resolveRestoredPaletteColor(key);
        const patch = { colors: { [key]: restored } };
        if (layerKey) {
          patch.layers = { [layerKey]: true };
        }
        patchSpec(patch);
      } else {
        state.lastPaletteColors[key] = current;
        const patch = { colors: { [key]: 'none' } };
        if (layerKey) {
          patch.layers = { [layerKey]: false };
        }
        patchSpec(patch);
      }
    },

    onToggleAllPaletteColorsOff: () => {
      const colors = state.spec.colors || {};
      const allOff = PALETTE_KEYS.every((k) => !colors[k] || isNoneColor(colors[k]));
      if (allOff) {
        const restoredColors = {};
        for (const k of PALETTE_KEYS) {
          restoredColors[k] = resolveRestoredPaletteColor(k);
        }
        const theme = COLOR_THEMES[state.spec?.theme] || COLOR_THEMES.dusty_prime;
        if (theme && isNoneColor(theme.coastline) && !state.lastPaletteColors.coastline) {
          restoredColors.coastline = 'none';
        }
        patchSpec({
          colors: restoredColors,
          layers: { showLand: true },
        });
        showToast('Restored palette choices', 'info', 2200);
        return;
      }

      const nextColors = {};
      const nextLayers = {};
      for (const k of PALETTE_KEYS) {
        if (colors[k] && !isNoneColor(colors[k])) {
          state.lastPaletteColors[k] = colors[k];
        }
        nextColors[k] = 'none';
        if (PALETTE_LAYER_LINKS[k]) {
          nextLayers[PALETTE_LAYER_LINKS[k]] = false;
        }
      }
      patchSpec({
        colors: nextColors,
        layers: nextLayers,
      });
      showToast('All palette choices toggled off — pick a country or Alaska to isolate it', 'info', 3000);
    },

    onResetPaletteColors: () => {
      const theme = COLOR_THEMES[state.spec?.theme] || COLOR_THEMES.dusty_prime;
      if (!theme) return;
      const nextColors = {};
      for (const k of PALETTE_KEYS) {
        nextColors[k] = theme[k];
      }
      patchSpec({
        colors: nextColors,
        layers: {
          showLand: true,
          showCoastlines: !isNoneColor(theme.coastline),
        },
      });
      showToast(`Reset palette to ${theme.label}`, 'info', 2200);
    },

    onToggleLayerWithColor: (layerKey, colorKey, enabled) => {
      const patch = { layers: { [layerKey]: Boolean(enabled) } };
      if (enabled && colorKey && isNoneColor(state.spec.colors?.[colorKey])) {
        patch.colors = { [colorKey]: resolveRestoredPaletteColor(colorKey) };
      }
      patchSpec(patch);
    },

    onToggleMode: (targetMode) => {
      state.mode = state.mode === targetMode ? 'pan' : targetMode;
      if (state.mode !== 'pan') {
        closeMobileDrawers();
      }
      syncAllUi();
    },

    onToggleOsmCoastlines: (forceVisible = null) => {
      toggleSuperAccuracyLayers(isOsmHdLayer, 'OSM HD Coastlines', forceVisible);
    },

    onRemoveOsmCoastlines: () => {
      removeSuperAccuracyLayers(isOsmHdLayer, 'OSM HD Coastlines');
    },

    onToggleGeoBoundaries: (forceVisible = null) => {
      toggleSuperAccuracyLayers(isGeoBoundariesLayer, 'OSM Ultra-Detail Boundaries', forceVisible);
    },

    onRemoveGeoBoundaries: () => {
      removeSuperAccuracyLayers(isGeoBoundariesLayer, 'OSM Ultra-Detail Boundaries');
    },

    onToggleSuperAccuracy: () => {
      const layers = state.spec?.customGeoJsonLayers || [];
      const hasHd = layers.some(isOsmHdLayer);
      const hasGb = layers.some(isGeoBoundariesLayer);
      if (hasHd && !hasGb) {
        toggleSuperAccuracyLayers(isOsmHdLayer, 'OSM HD Coastlines');
      } else if (hasGb && !hasHd) {
        toggleSuperAccuracyLayers(isGeoBoundariesLayer, 'OSM Ultra-Detail Boundaries');
      } else if (hasHd || hasGb) {
        toggleSuperAccuracyLayers(isSuperAccuracyLayer, 'Super-Accuracy Map');
      }
    },

    onRemoveSuperAccuracy: () => {
      const layers = state.spec?.customGeoJsonLayers || [];
      const hasHd = layers.some(isOsmHdLayer);
      const hasGb = layers.some(isGeoBoundariesLayer);
      if (hasHd && !hasGb) {
        removeSuperAccuracyLayers(isOsmHdLayer, 'OSM HD Coastlines');
      } else if (hasGb && !hasHd) {
        removeSuperAccuracyLayers(isGeoBoundariesLayer, 'OSM Ultra-Detail Boundaries');
      } else if (hasHd || hasGb) {
        removeSuperAccuracyLayers(isSuperAccuracyLayer, 'Super-Accuracy Map');
      }
    },

    onChangeHdCoastlineColorMode: (mode) => {
      const nextMode = ['host', 'land', 'custom'].includes(mode) ? mode : 'host';
      state.hdCoastlineColorMode = nextMode;
      const spec = state.spec;
      const info = resolveHdCoastlineColorInfo(spec, nextMode);
      if (nextMode === 'custom') {
        state.hdCoastlineCustomColor = info.color;
      }

      const layers = spec.customGeoJsonLayers || [];
      const hasHd = layers.some((l) => isOsmHdLayer(l));
      if (!hasHd) {
        syncAllUi({ skipDynamicLists: true });
        return;
      }

      const nextLayers = layers.map((l) => {
        if (!isOsmHdLayer(l)) return l;
        return {
          ...l,
          color: info.color,
          fillOpacity: nextMode === 'land' && isNoneColor(spec.colors?.land) ? 0 : 1.0,
        };
      });
      patchSpec({ customGeoJsonLayers: nextLayers });
      showToast(`HD Coastlines color synced to ${info.sourceLabel} (${info.color})`, 'info', 2200);
    },

    onPickHdCoastlineColor: (color, opts = {}) => {
      if (typeof color !== 'string' || !color) return;
      state.hdCoastlineColorMode = 'custom';
      state.hdCoastlineCustomColor = color;

      const layers = state.spec?.customGeoJsonLayers || [];
      const hasHd = layers.some((l) => isOsmHdLayer(l));
      if (!hasHd) {
        syncAllUi({ skipDynamicLists: true });
        return;
      }

      const nextLayers = layers.map((l) => {
        if (!isOsmHdLayer(l)) return l;
        return {
          ...l,
          color,
          fillOpacity: 1.0,
        };
      });
      patchSpec({ customGeoJsonLayers: nextLayers }, opts);
    },

    onFetchTerrainRelief: async ({ forceRefresh = false } = {}) => {
      const spec = state.spec;
      if (!spec) return;
      const visibleBounds = computeCurrentVisibleBounds(spec);
      const seq = ++state.terrainFetchSeq;

      try {
        setLoadingProgress(true, 'Downloading elevation tiles for framed view...');
        const dem = await fetchTerrainDemForBounds(visibleBounds, {
          forceRefresh,
          onStatus: (msg) => {
            if (seq === state.terrainFetchSeq) {
              setLoadingProgress(true, msg);
            }
          },
        });
        if (seq !== state.terrainFetchSeq) return;
        setLoadingProgress(false);

        state.terrainData = dem;
        state.terrainMeta = null;
        patchSpec({
          terrainRelief: {
            enabled: true,
            bounds: dem.bounds,
          },
        });

        const styleDef = TERRAIN_STYLES[state.spec?.terrainRelief?.style] || TERRAIN_STYLES.army_topo;
        const maxE = dem.stats?.maxLandElev || 0;
        const peakNote = maxE > 0 ? ` · Peak ${maxE.toLocaleString()} m` : '';
        const clipNote =
          state.spec?.terrainRelief?.clipMode === 'highlighted' &&
          (!state.spec.highlightedCountries || state.spec.highlightedCountries.length === 0)
            ? ' (highlight a country in Regions & Pins to show clipped relief)'
            : '';
        showToast(
          `${styleDef.shortLabel} loaded (z${dem.zoom} · ${dem.tileCount} tiles${peakNote})${clipNote}`,
          clipNote ? 'warn' : 'success',
          4600,
        );
      } catch (err) {
        if (seq === state.terrainFetchSeq) {
          setLoadingProgress(false);
          showToast(`Terrain Relief error: ${err.message}`, 'error', 5200);
        }
      }
    },

    onToggleTerrainRelief: async () => {
      const tr = state.spec?.terrainRelief;
      if (!tr) return;
      if (!tr.enabled && !state.terrainData) {
        const visibleBounds = computeCurrentVisibleBounds(state.spec);
        const seq = ++state.terrainFetchSeq;
        try {
          setLoadingProgress(true, 'Downloading elevation tiles for framed view...');
          const dem = await fetchTerrainDemForBounds(visibleBounds, {
            onStatus: (msg) => {
              if (seq === state.terrainFetchSeq) {
                setLoadingProgress(true, msg);
              }
            },
          });
          if (seq !== state.terrainFetchSeq) return;
          setLoadingProgress(false);
          state.terrainData = dem;
          state.terrainMeta = null;
          patchSpec({ terrainRelief: { enabled: true, bounds: dem.bounds } });
          showToast('Terrain relief enabled', 'success', 2600);
        } catch (err) {
          if (seq === state.terrainFetchSeq) {
            setLoadingProgress(false);
            showToast(`Terrain Relief error: ${err.message}`, 'error', 5200);
          }
        }
        return;
      }

      const nextEnabled = !tr.enabled;
      patchSpec({ terrainRelief: { enabled: nextEnabled } });
      showToast(
        nextEnabled ? 'Terrain relief shown' : 'Terrain relief hidden',
        'info',
        2200,
      );
    },

    onRemoveTerrainRelief: () => {
      state.terrainFetchSeq += 1;
      state.terrainData = null;
      state.terrainMeta = null;
      patchSpec({
        terrainRelief: {
          enabled: false,
          bounds: null,
        },
      });
      showToast('Terrain relief removed', 'info', 2200);
    },

    onFetchOsmCoastlines: async ({
      asPrimaryLand = true,
      simplifyMeters = 0,
      colorMode = null,
      forceRefresh = false,
    } = {}) => {
      const spec = state.spec;
      if (colorMode && ['host', 'land', 'custom'].includes(colorMode)) {
        state.hdCoastlineColorMode = colorMode;
      }
      const visibleBounds = computeCurrentVisibleBounds(spec);
      const bbox = computePaddedCoastlineBBox(visibleBounds);

      if (bbox.tooWide) {
        showToast(
          `Zoom in to ≤ ${OSM_COASTLINE_MAX_SPAN_DEG}° first (current view is ${bbox.maxRawSpan.toFixed(1)}°). For full countries, use geoBoundaries below.`,
          'warn',
          5200,
        );
        return;
      }

      try {
        setLoadingProgress(true, 'Downloading OpenStreetMap HD coastlines...');
        const result = await fetchOsmCoastlineForBounds(bbox, {
          simplifyMeters,
          forceRefresh,
          onStatus: (msg) => setLoadingProgress(true, msg),
        });
        setLoadingProgress(false);

        const colors = spec.colors || {};
        const layersSpec = spec.layers || {};
        const colorInfo = resolveHdCoastlineColorInfo(spec, state.hdCoastlineColorMode, visibleBounds);
        const fillColor = colorInfo.color;
        const fillIsNone = state.hdCoastlineColorMode === 'land' && isNoneColor(colors.land);
        const wantCoastStroke =
          Boolean(layersSpec.showCoastlines) &&
          Boolean(colors.coastline) &&
          !isNoneColor(colors.coastline);
        const detailTag =
          simplifyMeters >= 35 ? '~40m' : simplifyMeters >= 10 ? '~15m' : 'Full';
        const areaTitle = String(spec.title || '')
          .replace(/\bBriefing Map\b/i, '')
          .trim();
        const label = areaTitle
          ? `${areaTitle} (OSM HD ${detailTag})`
          : `OSM HD Coastlines (${detailTag})`;

        const layer = asPrimaryLand
          ? {
              id: 'osm_hd_coastline_land',
              label,
              url: result.url,
              data: result.data,
              visible: true,
              role: 'land',
              color: fillColor,
              strokeColor: wantCoastStroke ? colors.coastline : 'none',
              fillOpacity: fillIsNone ? 0 : 1.0,
              strokeWidth: Number(layersSpec.coastlineWidth) || 0.75,
              dashed: false,
              hatch: 'none',
            }
          : {
              id: `osm_hd_coastline_overlay_${Date.now()}`,
              label,
              url: result.url,
              data: result.data,
              visible: true,
              role: 'overlay',
              color: fillColor,
              strokeColor: wantCoastStroke ? colors.coastline : 'none',
              fillOpacity: fillIsNone ? 0 : 1.0,
              strokeWidth: Number(layersSpec.coastlineWidth) || 0.75,
              dashed: false,
              hatch: 'none',
            };

        const existing = (spec.customGeoJsonLayers || []).filter(
          (l) => !(asPrimaryLand && l?.id === 'osm_hd_coastline_land'),
        );
        const patch = {
          customGeoJsonLayers: [...existing, layer],
        };
        if (asPrimaryLand) {
          patch.layers = { showLand: false };
          // Remove overlapping low-poly Natural Earth host country highlight so it does not draw over crisp HD shorelines
          if (colorInfo.liveHost) {
            const normId = String(colorInfo.liveHost.id || '');
            const normName = String(colorInfo.liveHost.name || '').trim().toLowerCase();
            const currentHighlights = spec.highlightedCountries || [];
            const removed = currentHighlights.find(
              (hc) =>
                (normId && String(hc.id || '') === normId) ||
                (normName && String(hc.name || '').trim().toLowerCase() === normName),
            );
            if (removed) {
              state.hdCoastlineReplacedHighlight = structuredClone(removed);
              patch.highlightedCountries = currentHighlights.filter((hc) => hc !== removed);
            }
          }
        }
        patchSpec(patch);

        const st = result.stats || {};
        const summary = `${st.polygonCount || 0} shape${st.polygonCount === 1 ? '' : 's'} (${st.islandCount || 0} island${st.islandCount === 1 ? '' : 's'}, ${(st.vertexCount || 0).toLocaleString()} pts)`;
        const matchNote = colorInfo.hostCountry && state.hdCoastlineColorMode === 'host'
          ? ` · matched ${colorInfo.hostCountry.name}`
          : '';
        showToast(
          asPrimaryLand
            ? `Loaded OSM HD Coastlines${matchNote} — ${summary}`
            : `Added OSM HD Coastlines overlay${matchNote} — ${summary}`,
          'success',
          4200,
        );
      } catch (err) {
        setLoadingProgress(false);
        showToast(`OSM HD Coastlines error: ${err.message}`, 'error', 5400);
      }
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
        const primaryFill = !isNoneColor(colors.land) && colors.land
          ? colors.land
          : resolveRestoredPaletteColor('land');
        const admin1Stroke = !isNoneColor(colors.admin1) ? colors.admin1 : null;
        const borderStroke = !isNoneColor(colors.borders) ? colors.borders : null;
        const landStroke =
          level === 'ADM0'
            ? (layersSpec.showCoastlines && colors.coastline && !isNoneColor(colors.coastline) ? colors.coastline : 'none')
            : (admin1Stroke || borderStroke || 'none');
        const layer = asPrimaryLand
          ? {
              id: `gb_${iso3}_${level}`,
              label,
              url: result.url,
              data: result.data,
              visible: true,
              role: 'land',
              color: primaryFill,
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
          const currentHighlights = state.spec.highlightedCountries || [];
          const removedHighlights = currentHighlights.filter(
            (hc) => String(hc.id || '') === normId || String(hc.name || '').trim().toLowerCase() === normName,
          );
          if (removedHighlights.length) {
            const existingStashed = state.gbReplacedHighlights || [];
            state.gbReplacedHighlights = mergeRestoredHighlights(existingStashed, removedHighlights) || existingStashed;
            patch.highlightedCountries = currentHighlights.filter((hc) => !removedHighlights.includes(hc));
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
      const specPatch = { customGeoJsonLayers: next };

      if (patch?.visible === false) {
        hideFeatureHover();
        if (state.selectedFeature?.layer?.id === targetLayer.id) {
          closeFeatureInfoCard();
        }
        const stillHasVisibleLand = next.some((l) => l?.visible !== false && l?.role === 'land');
        if (targetLayer.role === 'land' && !stillHasVisibleLand) {
          specPatch.layers = { showLand: true };
          if (isNoneColor(state.spec.colors?.land)) {
            specPatch.colors = { land: resolveRestoredPaletteColor('land') };
          }
          const restorePool = [];
          if (isOsmHdLayer(targetLayer) && state.hdCoastlineReplacedHighlight) {
            restorePool.push(state.hdCoastlineReplacedHighlight);
          }
          if (isGeoBoundariesLayer(targetLayer) && state.gbReplacedHighlights.length) {
            restorePool.push(...state.gbReplacedHighlights);
          }
          const merged = mergeRestoredHighlights(state.spec.highlightedCountries, restorePool);
          if (merged) {
            specPatch.highlightedCountries = merged;
          }
        }
      } else if (patch?.visible === true && targetLayer.role === 'land') {
        specPatch.layers = { showLand: false };
      }
      patchSpec(specPatch, opts);
    },

    onToggleGeoJsonPrimaryLand: (idx) => {
      const next = [...(state.spec.customGeoJsonLayers || [])];
      const cur = next[idx];
      if (!cur) return;
      const promoting = cur.role !== 'land';
      const colors = state.spec.colors || {};
      if (promoting) {
        const isCoastLayer =
          /ADM0/i.test(cur.label || '') ||
          /ADM0/i.test(cur.id || '') ||
          String(cur.id || '').startsWith('osm_hd_coastline') ||
          isOsmCoastlineUrl(cur.url);
        const primaryFill = !isNoneColor(colors.land) && colors.land
          ? colors.land
          : resolveRestoredPaletteColor('land');
        const layersSpec = state.spec.layers || {};
        const coastStroke =
          layersSpec.showCoastlines && colors.coastline && !isNoneColor(colors.coastline)
            ? colors.coastline
            : 'none';
        const admin1Stroke = !isNoneColor(colors.admin1) ? colors.admin1 : null;
        const borderStroke = !isNoneColor(colors.borders) ? colors.borders : null;
        next[idx] = {
          ...cur,
          visible: true,
          role: 'land',
          color: primaryFill,
          strokeColor: isCoastLayer ? coastStroke : (admin1Stroke || borderStroke || 'none'),
          fillOpacity: 1.0,
          strokeWidth: isCoastLayer ? (Number(layersSpec.coastlineWidth) || 0.75) : 0.7,
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
        const restorePatch = stillHasLand
          ? {}
          : {
              layers: { showLand: true },
              ...(isNoneColor(colors.land) ? { colors: { land: resolveRestoredPaletteColor('land') } } : {}),
            };
        patchSpec({
          customGeoJsonLayers: next,
          ...restorePatch,
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
      const patch = { layers: { showLand: true } };
      if (isNoneColor(state.spec.colors?.land)) {
        patch.colors = { land: resolveRestoredPaletteColor('land') };
      }
      const restorePool = [];
      if (state.hdCoastlineReplacedHighlight) {
        restorePool.push(state.hdCoastlineReplacedHighlight);
        state.hdCoastlineReplacedHighlight = null;
      }
      if (state.gbReplacedHighlights.length) {
        restorePool.push(...state.gbReplacedHighlights);
        state.gbReplacedHighlights = [];
      }
      const merged = mergeRestoredHighlights(state.spec.highlightedCountries, restorePool);
      if (merged) {
        patch.highlightedCountries = merged;
      }
      patchSpec(patch);
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
      const specPatch = { customGeoJsonLayers: next };
      if (removed?.role === 'land' && !stillHasLand) {
        if (state.spec.layers?.showLand === false) {
          specPatch.layers = { showLand: true };
        }
        if (isNoneColor(state.spec.colors?.land)) {
          specPatch.colors = { land: resolveRestoredPaletteColor('land') };
        }
        const restorePool = [];
        if (isOsmHdLayer(removed) && state.hdCoastlineReplacedHighlight) {
          restorePool.push(state.hdCoastlineReplacedHighlight);
        }
        if (isGeoBoundariesLayer(removed) && state.gbReplacedHighlights.length) {
          restorePool.push(...state.gbReplacedHighlights);
        }
        const merged = mergeRestoredHighlights(state.spec.highlightedCountries, restorePool);
        if (merged) {
          specPatch.highlightedCountries = merged;
        }
      }
      if (isOsmHdLayer(removed) && !next.some(isOsmHdLayer)) {
        state.hdCoastlineReplacedHighlight = null;
      }
      if (isGeoBoundariesLayer(removed) && !next.some(isGeoBoundariesLayer)) {
        state.gbReplacedHighlights = [];
      }
      patchSpec(specPatch);
    },

    onToggleHistoricalLayer: async (layerDef, enabled) => {
      if (!layerDef?.id) return;
      const current = [...(state.spec.customGeoJsonLayers || [])];
      const existingIdx = current.findIndex((l) => l?.id === layerDef.id);

      if (!enabled) {
        if (existingIdx !== -1) {
          current[existingIdx] = { ...current[existingIdx], visible: false };
          hideFeatureHover();
          if (state.selectedFeature?.layer?.id === layerDef.id) {
            closeFeatureInfoCard();
          }
          patchSpec({ customGeoJsonLayers: current });
        }
        return;
      }

      if (existingIdx !== -1 && current[existingIdx].data) {
        current[existingIdx] = { ...current[existingIdx], visible: true };
        patchSpec({ customGeoJsonLayers: current });
        return;
      }

      try {
        setLoadingProgress(true, `Loading ${layerDef.shortLabel}...`);
        const data = await fetchCustomGeoJson(layerDef.url);
        setLoadingProgress(false);

        const latest = [...(state.spec.customGeoJsonLayers || [])];
        const idx = latest.findIndex((l) => l?.id === layerDef.id);
        if (idx !== -1) {
          latest[idx] = { ...latest[idx], data, visible: true };
        } else {
          latest.push({
            id: layerDef.id,
            label: layerDef.label,
            url: layerDef.url,
            data,
            visible: true,
            color: layerDef.color,
            fillOpacity: layerDef.fillOpacity,
            strokeWidth: layerDef.strokeWidth,
            dashed: Boolean(layerDef.dashed),
            hatch: 'none',
          });
        }
        patchSpec({ customGeoJsonLayers: latest });
      } catch (err) {
        setLoadingProgress(false);
        syncAllUi();
        showToast(`Could not load ${layerDef.shortLabel}: ${err.message}`, 'error', 4500);
      }
    },

    onUpdateHistoricalLayer: async (layerDef, patch, opts = {}) => {
      if (!layerDef?.id) return;
      const current = [...(state.spec.customGeoJsonLayers || [])];
      const idx = current.findIndex((l) => l?.id === layerDef.id);
      if (idx !== -1) {
        current[idx] = { ...current[idx], ...patch };
        patchSpec({ customGeoJsonLayers: current }, opts);
        return;
      }

      try {
        const data = await fetchCustomGeoJson(layerDef.url);
        const latest = [...(state.spec.customGeoJsonLayers || [])];
        const latestIdx = latest.findIndex((l) => l?.id === layerDef.id);
        if (latestIdx !== -1) {
          latest[latestIdx] = { ...latest[latestIdx], data, ...patch };
        } else {
          latest.push({
            id: layerDef.id,
            label: layerDef.label,
            url: layerDef.url,
            data,
            visible: true,
            color: layerDef.color,
            fillOpacity: layerDef.fillOpacity,
            strokeWidth: layerDef.strokeWidth,
            dashed: Boolean(layerDef.dashed),
            hatch: 'none',
            ...patch,
          });
        }
        patchSpec({ customGeoJsonLayers: latest }, opts);
      } catch (err) {
        showToast(`Could not load ${layerDef.shortLabel}: ${err.message}`, 'error', 4500);
      }
    },

    onSetHistoricalGroupSize: (groupKey, sizeVal, opts = {}) => {
      const targetIds = new Set(
        groupKey === 'airfields'
          ? AIRFIELD_1941_LAYERS.map((d) => d.id)
          : groupKey === 'alaska_airfields'
            ? ALASKA_AIRFIELDS_ALL_LAYER_DEFS.map((d) => d.id)
            : PHILIPPINES_RAIL_1942_LAYERS.filter((d) => d.geometryKind === 'line').map((d) => d.id),
      );
      const current = [...(state.spec.customGeoJsonLayers || [])];
      let touched = false;
      const next = current.map((l) => {
        if (l?.id && targetIds.has(l.id)) {
          touched = true;
          return { ...l, strokeWidth: sizeVal };
        }
        return l;
      });
      if (touched) {
        patchSpec({ customGeoJsonLayers: next }, opts);
      }
    },

    onSelectAlaskaYear: async (year) => {
      const y = Number(year);
      if (!Number.isFinite(y)) return;
      state.alaskaYear = y;
      const defs = buildAlaskaYearLayerDefs(y);
      const neededDefs = defs.filter((d) => d.defaultOn);
      const loadedById = new Map();

      try {
        setLoadingProgress(true, `Loading Alaska ${y} airfield layers...`);
        await Promise.all(
          neededDefs.map(async (def) => {
            const existing = (state.spec.customGeoJsonLayers || []).find((l) => l?.id === def.id);
            const data = existing?.data || (await fetchCustomGeoJson(def.url));
            loadedById.set(def.id, data);
          }),
        );
        setLoadingProgress(false);
      } catch (err) {
        setLoadingProgress(false);
        showToast(`Could not load Alaska ${y} airfields: ${err.message}`, 'error', 4500);
        return;
      }

      const allAkIds = new Set(ALASKA_AIRFIELDS_ALL_LAYER_DEFS.map((d) => d.id));
      const others = (state.spec.customGeoJsonLayers || []).filter(
        (l) => !l?.id || (!allAkIds.has(l.id) && !l.id.startsWith(TIMELINE_LAYER_PREFIX)),
      );
      const nextGroup = neededDefs.map((def) => ({
        id: def.id,
        label: def.label,
        url: def.url,
        data: loadedById.get(def.id) || null,
        visible: true,
        color: def.color,
        fillOpacity: def.fillOpacity,
        strokeWidth: def.strokeWidth,
        dashed: false,
        hatch: 'none',
      }));

      patchSpec({ customGeoJsonLayers: [...others, ...nextGroup] });
      showToast(`Loaded Alaska ${y} Military & Civilian airfield layers.`, 'success', 2200);
    },

    onApplyAlaskaPreset: async (mode) => {
      const allAkIds = new Set(ALASKA_AIRFIELDS_ALL_LAYER_DEFS.map((d) => d.id));
      if (mode === 'none') {
        const others = (state.spec.customGeoJsonLayers || []).filter((l) => !l?.id || !allAkIds.has(l.id));
        hideFeatureHover();
        if (state.selectedFeature?.layer?.id && allAkIds.has(state.selectedFeature.layer.id)) {
          closeFeatureInfoCard();
        }
        patchSpec({ customGeoJsonLayers: others });
        showToast('Hid all Alaska 1939–1945 airfield layers.', 'success', 2200);
        return;
      }
      await buildCallbacks().onSelectAlaskaYear(state.alaskaYear);
    },

    onApplyAirfieldPreset: async (mode) => {
      const targetVisible = (def) => (mode === 'both' ? Boolean(def.defaultOn) : false);
      const neededDefs = AIRFIELD_1941_LAYERS.filter((def) => targetVisible(def));
      const loadedById = new Map();

      if (neededDefs.length > 0) {
        try {
          setLoadingProgress(true, 'Loading 1941 land airfield layers...');
          await Promise.all(
            neededDefs.map(async (def) => {
              const existing = (state.spec.customGeoJsonLayers || []).find((l) => l?.id === def.id);
              const data = existing?.data || (await fetchCustomGeoJson(def.url));
              loadedById.set(def.id, data);
            }),
          );
          setLoadingProgress(false);
        } catch (err) {
          setLoadingProgress(false);
          showToast(`Could not load 1941 airfield layers: ${err.message}`, 'error', 4500);
          return;
        }
      }

      const groupIds = new Set(AIRFIELD_1941_LAYERS.map((d) => d.id));
      const existingById = new Map();
      const others = [];
      for (const l of state.spec.customGeoJsonLayers || []) {
        if (l?.id && groupIds.has(l.id)) existingById.set(l.id, l);
        else others.push(l);
      }

      const nextGroup = [];
      for (const def of AIRFIELD_1941_LAYERS) {
        const vis = targetVisible(def);
        const prev = existingById.get(def.id);
        if (prev) {
          nextGroup.push({ ...prev, data: prev.data || loadedById.get(def.id) || null, visible: vis });
        } else if (vis) {
          nextGroup.push({
            id: def.id,
            label: def.label,
            url: def.url,
            data: loadedById.get(def.id) || null,
            visible: true,
            color: def.color,
            fillOpacity: def.fillOpacity,
            strokeWidth: def.strokeWidth,
            dashed: false,
            hatch: 'none',
          });
        }
      }

      if (mode === 'none') {
        hideFeatureHover();
        if (state.selectedFeature?.layer?.id && groupIds.has(state.selectedFeature.layer.id)) {
          closeFeatureInfoCard();
        }
      }
      patchSpec({ customGeoJsonLayers: [...others, ...nextGroup] });
      showToast(
        mode === 'both'
          ? 'Enabled 1941 Military & Civilian land airfields (163 sites).'
          : 'Hid all 1941 land airfield layers.',
        'success',
        2400,
      );
    },

    onApplyRailPreset: async (mode) => {
      const targetVisible = (def) => {
        if (mode === 'all') return true;
        if (mode === 'common_carrier') return Boolean(def.commonCarrier);
        return false;
      };
      const neededDefs = PHILIPPINES_RAIL_1942_LAYERS.filter((def) => targetVisible(def));
      const loadedById = new Map();

      if (neededDefs.length > 0) {
        try {
          setLoadingProgress(true, 'Loading Philippines 1942–1945 railway layers...');
          await Promise.all(
            neededDefs.map(async (def) => {
              const existing = (state.spec.customGeoJsonLayers || []).find((l) => l?.id === def.id);
              const data = existing?.data || (await fetchCustomGeoJson(def.url));
              loadedById.set(def.id, data);
            }),
          );
          setLoadingProgress(false);
        } catch (err) {
          setLoadingProgress(false);
          showToast(`Could not load railway layers: ${err.message}`, 'error', 4500);
          return;
        }
      }

      const groupIds = new Set(PHILIPPINES_RAIL_1942_LAYERS.map((d) => d.id));
      const existingById = new Map();
      const others = [];
      for (const l of state.spec.customGeoJsonLayers || []) {
        if (l?.id && groupIds.has(l.id)) existingById.set(l.id, l);
        else others.push(l);
      }

      const nextGroup = [];
      for (const def of PHILIPPINES_RAIL_1942_LAYERS) {
        const vis = targetVisible(def);
        const prev = existingById.get(def.id);
        if (prev) {
          nextGroup.push({ ...prev, data: prev.data || loadedById.get(def.id) || null, visible: vis });
        } else if (vis) {
          nextGroup.push({
            id: def.id,
            label: def.label,
            url: def.url,
            data: loadedById.get(def.id) || null,
            visible: true,
            color: def.color,
            fillOpacity: def.fillOpacity,
            strokeWidth: def.strokeWidth,
            dashed: Boolean(def.dashed),
            hatch: 'none',
          });
        }
      }

      if (mode === 'none') {
        hideFeatureHover();
        if (state.selectedFeature?.layer?.id && groupIds.has(state.selectedFeature.layer.id)) {
          closeFeatureInfoCard();
        }
      }
      patchSpec({ customGeoJsonLayers: [...others, ...nextGroup] });
      const msg =
        mode === 'all'
          ? 'Enabled all 7 Philippines 1942–1945 railway layers.'
          : mode === 'common_carrier'
            ? 'Enabled 1942–1945 common-carrier railroads (MRR + Panay + Cebu).'
            : 'Hid all Philippines 1942–1945 railway layers.';
      showToast(msg, 'success', 2400);
    },

    onFrameHistoricalRegion: (regionKey) => {
      closeMobileDrawers();
      if (regionKey === 'alaska') {
        patchSpec({
          projection: 'mercator',
          detailLevel: '10m',
          center: { lat: 60.8, lon: -158.0 },
          span: { lonDeg: 58.0, latDeg: 22.0 },
        });
        showToast('Framed Alaska & Aleutian Islands across the Date Line', 'info', 2200);
      } else if (regionKey === 'se_asia') {
        patchSpec({
          projection: 'mercator',
          detailLevel: '50m',
          center: { lat: 5.5, lon: 113.5 },
          span: { lonDeg: 44.0, latDeg: 35.0 },
        });
        showToast('Framed SE Asia & Western Pacific theater', 'info', 2200);
      } else {
        patchSpec({
          projection: 'mercator',
          detailLevel: '10m',
          center: { lat: 13.4, lon: 122.0 },
          span: { lonDeg: 8.5, latDeg: 11.5 },
        });
        showToast('Framed Philippines (Luzon & Visayas, 10m detail)', 'info', 2200);
      }
    },

    onTabChange: (tabId) => {
      if (tabId === 'timeline') {
        void ensureTimelineDatasetLoaded();
      } else {
        stopTimelinePlay();
      }
    },

    onUploadTimelineCsv: async (file) => {
      try {
        const text = await file.text();
        const ds = normalizeTimelineDataset(text, file.name.replace(/\.csv$/i, ''));
        stopTimelinePlay();
        state.timeline.dataset = ds;
        state.timeline.startYear = ds.minYear;
        state.timeline.endYear = ds.minYear;
        state.timeline.windowSize = '1';
        const sel = document.getElementById('timeline-dataset-select');
        if (sel) {
          const opt = document.createElement('option');
          opt.value = `custom_${Date.now()}`;
          opt.textContent = `${ds.name} (${ds.records.length} rows)`;
          sel.appendChild(opt);
          sel.value = opt.value;
        }
        const ws = document.getElementById('timeline-window-size');
        if (ws) ws.value = '1';
        populateTimelineDatasetSelectors();
        renderTimelineUi();
        if (state.timeline.autoSync) applyTimelineLayersToMap({ commitHistory: true });
        showToast(`Loaded custom CSV "${ds.name}" (${ds.records.length} rows, ${ds.minYear}–${ds.maxYear}).`, 'success', 3200);
      } catch (err) {
        showToast(`Could not parse CSV: ${err.message}`, 'error', 4500);
      }
    },

    onTimelineConfigChange: async (patch = {}) => {
      await ensureTimelineDatasetLoaded();
      const tl = state.timeline;
      if (patch.windowSize !== undefined) tl.windowSize = patch.windowSize;
      if (patch.mode !== undefined) tl.mode = patch.mode;
      if (patch.startYear !== undefined) tl.startYear = Number(patch.startYear);
      if (patch.endYear !== undefined) tl.endYear = Number(patch.endYear);
      if (patch.regionFilter !== undefined) tl.regionFilter = patch.regionFilter;
      if (patch.dotSize !== undefined) tl.dotSize = Number(patch.dotSize);
      if (patch.includeMilitary !== undefined) tl.includeMilitary = Boolean(patch.includeMilitary);
      if (patch.includeCivilian !== undefined) tl.includeCivilian = Boolean(patch.includeCivilian);
      if (patch.splitDualUse !== undefined) tl.splitDualUse = Boolean(patch.splitDualUse);
      if (patch.includeConstruction !== undefined) tl.includeConstruction = Boolean(patch.includeConstruction);
      if (patch.includeSeaplane !== undefined) tl.includeSeaplane = Boolean(patch.includeSeaplane);
      if (patch.autoSync !== undefined) tl.autoSync = Boolean(patch.autoSync);

      renderTimelineUi();
      if (tl.autoSync) {
        applyTimelineLayersToMap({ quiet: true, commitHistory: false });
      }
    },

    onTimelineStep: async (delta) => {
      const ds = await ensureTimelineDatasetLoaded();
      if (!ds) return;
      stopTimelinePlay();
      const tl = state.timeline;
      if (tl.windowSize === 'all' || tl.windowSize === 'custom') {
        tl.windowSize = '1';
        const ws = document.getElementById('timeline-window-size');
        if (ws) ws.value = '1';
      }
      const spanYears = Math.max(1, Number(tl.windowSize) || 1);
      const maxStart = Math.max(ds.minYear, ds.maxYear - (spanYears - 1));
      let nextStart = tl.startYear + delta;
      if (nextStart > maxStart) nextStart = ds.minYear;
      if (nextStart < ds.minYear) nextStart = maxStart;
      tl.startYear = nextStart;
      renderTimelineUi();
      if (tl.autoSync) applyTimelineLayersToMap({ quiet: true });
    },

    onTimelineTogglePlay: async () => {
      const ds = await ensureTimelineDatasetLoaded();
      if (!ds) return;
      const tl = state.timeline;
      if (tl.playTimer) {
        stopTimelinePlay();
        return;
      }
      if (tl.windowSize === 'all' || tl.windowSize === 'custom') {
        tl.windowSize = '1';
        const ws = document.getElementById('timeline-window-size');
        if (ws) ws.value = '1';
      }
      const btn = document.getElementById('btn-timeline-play');
      if (btn) btn.textContent = '⏸ Pause';

      renderTimelineUi();
      applyTimelineLayersToMap({ quiet: true });

      tl.playTimer = setInterval(() => {
        const spanYears = Math.max(1, Number(tl.windowSize) || 1);
        const maxStart = Math.max(ds.minYear, ds.maxYear - (spanYears - 1));
        tl.startYear = tl.startYear >= maxStart ? ds.minYear : tl.startYear + 1;
        renderTimelineUi();
        applyTimelineLayersToMap({ quiet: true });
      }, 1350);
    },

    onTimelineGenerate: async () => {
      const ds = await ensureTimelineDatasetLoaded();
      if (!ds) return;
      renderTimelineUi();
      applyTimelineLayersToMap({ quiet: false, commitHistory: true });
    },

    onTimelineClear: () => {
      stopTimelinePlay();
      const preserved = (state.spec.customGeoJsonLayers || []).filter(
        (l) => !l?.id || !l.id.startsWith(TIMELINE_LAYER_PREFIX),
      );
      hideFeatureHover();
      if (state.selectedFeature?.layer?.id?.startsWith(TIMELINE_LAYER_PREFIX)) {
        closeFeatureInfoCard();
      }
      patchSpec({ customGeoJsonLayers: preserved });
      showToast('Cleared generated timeline layers.', 'info', 2000);
    },

    onTimelineExport: async (fmt) => {
      const ds = await ensureTimelineDatasetLoaded();
      if (!ds) return;
      const result = state.timeline.lastResult || renderTimelineUi();
      const slug = sanitizeFilename(`alaska_airfields_${result.stats.windowLabel}`);
      if (fmt === 'csv') {
        const csv = exportTimelineSliceCsv(result.matchedRows, result.stats.windowLabel);
        downloadTextFile(`${slug}.csv`, csv, 'text/csv;charset=utf-8');
        showToast(`Downloaded ${slug}.csv (${result.matchedRows.length} rows).`, 'success', 2400);
      } else {
        const json = `${JSON.stringify(result.combinedGeoJson, null, 2)}\n`;
        downloadTextFile(`${slug}.geojson`, json, 'application/geo+json;charset=utf-8');
        showToast(`Downloaded ${slug}.geojson (${result.combinedGeoJson.features.length} features).`, 'success', 2400);
      }
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

async function hydrateTerrainReliefIfNeeded() {
  const tr = state.spec?.terrainRelief;
  if (!tr?.enabled) return;

  const targetBounds = tr.bounds || computeCurrentVisibleBounds(state.spec);
  if (state.terrainData && !isViewOutsideTerrainBounds(targetBounds, state.terrainData.bounds)) {
    return;
  }

  const seq = ++state.terrainFetchSeq;
  try {
    const dem = await fetchTerrainDemForBounds(targetBounds, {
      forcedZoom: Number.isInteger(tr.bounds?.zoom) ? tr.bounds.zoom : null,
    });
    if (seq !== state.terrainFetchSeq || !state.spec?.terrainRelief?.enabled) return;
    state.terrainData = dem;
    state.terrainMeta = null;
    syncAllUi({ skipDynamicLists: true });
    scheduleRender();
  } catch {
    // Leave spec intact if elevation tiles are temporarily unavailable offline
  }
}

async function hydrateRemoteGeoJsonLayers() {
  void hydrateTerrainReliefIfNeeded();
  const initialLayers = state.spec?.customGeoJsonLayers || [];
  const pending = initialLayers.filter((l) => l?.url && !l?.data && l?.visible !== false);
  if (pending.length === 0) return;

  const fetched = new Map();
  await Promise.all(
    pending.map(async (layer) => {
      try {
        let data = await fetchCustomGeoJson(layer.url);
        if (typeof layer.id === 'string' && layer.id.startsWith('gb_US-AK_')) {
          data = filterGeoJsonToAlaska(data);
        }
        fetched.set(layer.id || layer.url, data);
      } catch {
        // Leave layer intact if remote GeoJSON temporarily unavailable
      }
    }),
  );

  if (fetched.size === 0) return;
  let updated = false;
  const nextLayers = (state.spec?.customGeoJsonLayers || []).map((layer) => {
    const key = layer?.id || layer?.url;
    if (layer?.url && !layer?.data && fetched.has(key)) {
      updated = true;
      return { ...layer, data: fetched.get(key) };
    }
    return layer;
  });

  if (updated) {
    state.spec = normalizeMapSpec({ ...state.spec, customGeoJsonLayers: nextLayers });
    syncAllUi();
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
      closeMobileDrawers();
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
