/**
 * Canonical MapSpec schema, presets, color themes, and URL/JSON codec
 * shared across Dusty's Browser Studio and the Python Cartopy Pro backend.
 */

export const SCHEMA_VERSION = 1;

export const PAGE_PRESETS = {
  book_4_6x7: {
    id: 'book_4_6x7',
    label: 'Book Page (4.6" × 7.0")',
    widthIn: 4.6,
    heightIn: 7.0,
  },
  book_landscape: {
    id: 'book_landscape',
    label: 'Book Landscape (7.0" × 4.6")',
    widthIn: 7.0,
    heightIn: 4.6,
  },
  letter_portrait: {
    id: 'letter_portrait',
    label: 'US Letter (8.5" × 11")',
    widthIn: 8.5,
    heightIn: 11.0,
  },
  letter_landscape: {
    id: 'letter_landscape',
    label: 'US Letter Landscape (11" × 8.5")',
    widthIn: 11.0,
    heightIn: 8.5,
  },
  square_8x8: {
    id: 'square_8x8',
    label: 'Square (8.0" × 8.0")',
    widthIn: 8.0,
    heightIn: 8.0,
  },
  widescreen_16x9: {
    id: 'widescreen_16x9',
    label: 'Widescreen 16:9 (10" × 5.625")',
    widthIn: 10.0,
    heightIn: 5.625,
  },
  custom: {
    id: 'custom',
    label: 'Custom Inches',
    widthIn: 6.0,
    heightIn: 6.0,
  },
};

export const COLOR_THEMES = {
  dusty_prime: {
    id: 'dusty_prime',
    label: 'Dusty Prime Dark',
    land: '#4a4a4a',
    water: '#d1cfcf',
    borders: '#ffffff',
    coastline: 'none',
    rivers: '#d1cfcf',
    admin1: '#737373',
    bathymetry: '#bfbdbd',
    urban: '#636363',
    highlightFill: '#7a7d7a',
    highlightStroke: '#ffffff',
    text: '#111111',
    textHalo: '#d1cfcf',
    globeBg: '#e8e8e8',
  },
  editorial_grayscale: {
    id: 'editorial_grayscale',
    label: 'Editorial Grayscale',
    land: '#929492',
    water: '#ffffff',
    borders: '#111111',
    coastline: '#111111',
    rivers: '#ffffff',
    admin1: '#555555',
    bathymetry: '#e9ebed',
    urban: '#767876',
    highlightFill: '#c4c6c4',
    highlightStroke: '#111111',
    text: '#111111',
    textHalo: '#ffffff',
    globeBg: '#f5f5f5',
  },
  clean_bw_outline: {
    id: 'clean_bw_outline',
    label: 'Clean B&W Outline',
    land: '#ffffff',
    water: '#e9ecef',
    borders: '#111111',
    coastline: '#111111',
    rivers: '#adb5bd',
    admin1: '#6c757d',
    bathymetry: '#d4dce3',
    urban: '#ced4da',
    highlightFill: '#d8dde2',
    highlightStroke: '#000000',
    text: '#000000',
    textHalo: '#ffffff',
    globeBg: '#f8f9fa',
  },
  classic_atlas: {
    id: 'classic_atlas',
    label: 'Classic Atlas',
    land: '#ebe6da',
    water: '#b9d9eb',
    borders: '#4a4a4a',
    coastline: '#6c8ea4',
    rivers: '#73a9ca',
    admin1: '#8c8577',
    bathymetry: '#9cc6de',
    urban: '#d4cab6',
    highlightFill: '#f3d58d',
    highlightStroke: '#4a4a4a',
    text: '#1f2937',
    textHalo: '#ebe6da',
    globeBg: '#f3f7fa',
  },
  naval_blueprint: {
    id: 'naval_blueprint',
    label: 'Naval Blueprint',
    land: '#1d3c5e',
    water: '#0d223a',
    borders: '#7dd3fc',
    coastline: '#38bdf8',
    rivers: '#0d223a',
    admin1: '#3b6a99',
    bathymetry: '#143354',
    urban: '#2c5480',
    highlightFill: '#2b5886',
    highlightStroke: '#bae6fd',
    text: '#f0f9ff',
    textHalo: '#0d223a',
    globeBg: '#081728',
  },
};

export const PROJECTIONS = [
  'mercator',
  'equal_earth',
  'orthographic',
  'albers',
  'azimuthal_equidistant',
  'robinson',
];

export const PROJECTION_LABELS = {
  mercator: 'Mercator',
  equal_earth: 'Equal Earth',
  orthographic: '3D Globe (Orthographic)',
  albers: 'Albers Equal Area',
  azimuthal_equidistant: 'Azimuthal Equidistant',
  robinson: 'Robinson',
};

export const DETAIL_LEVELS = ['auto', 'ultra', '10m', '50m', '110m'];

export const ADMIN1_SCALES = ['auto', '50m', '10m'];

export const HATCH_STYLES = ['none', 'diagonal', 'backdiagonal', 'cross', 'dots'];

export const BORDER_STYLES = ['solid', 'dashed', 'dotted'];

export const PIN_STYLES = ['dot', 'capital', 'bullseye', 'square', 'label_only'];

export const SHADOW_SOURCE_TYPES = ['country', 'admin1'];

export const COASTLINE_ENGINES = ['auto', 'natural_earth', 'gshhs_high', 'gshhs_full'];

export const CORNER_POSITIONS = [
  'bottom-left',
  'bottom-right',
  'top-left',
  'top-right',
];

export const GLOBE_ZOOM_MODES = ['auto', 'nearside', 'hemisphere', 'custom'];

export const BASEMAP_PROVIDERS = [
  'none',
  'CartoDB.VoyagerNoLabels',
  'CartoDB.PositronNoLabels',
  'CartoDB.DarkMatterNoLabels',
  'Esri.WorldShadedRelief',
  'Esri.WorldTerrain',
  'Esri.OceanBasemap',
  'Esri.WorldImagery',
  'OpenTopoMap',
];

export function createDefaultMapSpec() {
  return {
    version: SCHEMA_VERSION,
    title: 'Ukraine Briefing Map',
    showTitle: false,
    projection: 'mercator',
    detailLevel: 'auto',
    center: {
      lat: 48.5,
      lon: 31.2,
    },
    span: {
      lonDeg: 24.0,
      latDeg: 14.0,
    },
    page: {
      preset: 'book_4_6x7',
      widthIn: 4.6,
      heightIn: 7.0,
      dpi: 300,
      showFrameBorder: true,
    },
    theme: 'dusty_prime',
    colors: {
      land: COLOR_THEMES.dusty_prime.land,
      water: COLOR_THEMES.dusty_prime.water,
      borders: COLOR_THEMES.dusty_prime.borders,
      coastline: COLOR_THEMES.dusty_prime.coastline,
      rivers: COLOR_THEMES.dusty_prime.rivers,
      admin1: COLOR_THEMES.dusty_prime.admin1,
      bathymetry: COLOR_THEMES.dusty_prime.bathymetry,
      urban: COLOR_THEMES.dusty_prime.urban,
      highlightFill: COLOR_THEMES.dusty_prime.highlightFill,
      highlightStroke: COLOR_THEMES.dusty_prime.highlightStroke,
      text: COLOR_THEMES.dusty_prime.text,
      textHalo: COLOR_THEMES.dusty_prime.textHalo,
    },
    layers: {
      showBorders: true,
      borderWidth: 1.0,
      borderStyle: 'solid',
      showCoastlines: false,
      coastlineWidth: 0.75,
      showMinorIslands: true,
      showLakes: true,
      showRivers: false,
      riverWidth: 0.75,
      showBathymetry: false,
      showUrbanAreas: false,
      showAdmin1: false,
      admin1Width: 0.7,
      admin1Scale: 'auto',
      showGraticule: false,
      graticuleStepDeg: 10,
      cityLabelScale: 1.0,
      cityIconScale: 1.0,
    },
    highlightedCountries: [
      {
        id: '804',
        name: 'Ukraine',
        fill: '#7a7d7a',
        stroke: '#ffffff',
        hatch: 'none',
      },
    ],
    regionShadows: [],
    cities: [
      { id: 'kyiv', name: 'Kyiv', lat: 50.4501, lon: 30.5234, style: 'capital', dx: 6, dy: -6, scale: 1.0 },
      { id: 'lviv', name: 'Lviv', lat: 49.8397, lon: 24.0297, style: 'dot', dx: 6, dy: -5, scale: 1.0 },
      { id: 'odesa', name: 'Odesa', lat: 46.4825, lon: 30.7233, style: 'dot', dx: 6, dy: 8, scale: 1.0 },
      { id: 'kharkiv', name: 'Kharkiv', lat: 49.9935, lon: 36.2304, style: 'dot', dx: 6, dy: -5, scale: 1.0 },
    ],
    customGeoJsonLayers: [],
    ornaments: {
      scaleBar: {
        enabled: true,
        units: 'km',
        position: 'bottom-left',
      },
      locatorGlobe: {
        enabled: true,
        position: 'top-right',
        sizePct: 22,
        showExtentBox: true,
        zoomMode: 'auto',
        zoom: 2.0,
      },
      northArrow: {
        enabled: false,
        position: 'top-left',
      },
      legend: {
        enabled: false,
        position: 'bottom-right',
      },
    },
    pro: {
      basemapProvider: 'none',
      basemapOpacity: 0.85,
      coastlineEngine: 'auto',
    },
  };
}

function clamp(num, min, max, fallback) {
  const n = Number(num);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeMapSpec(partial) {
  const def = createDefaultMapSpec();
  if (!isPlainObject(partial)) return def;

  const themeId = typeof partial.theme === 'string' && COLOR_THEMES[partial.theme]
    ? partial.theme
    : def.theme;
  const themeColors = COLOR_THEMES[themeId];

  const pageRaw = isPlainObject(partial.page) ? partial.page : {};
  const presetId = typeof pageRaw.preset === 'string' && PAGE_PRESETS[pageRaw.preset]
    ? pageRaw.preset
    : def.page.preset;
  const presetDims = PAGE_PRESETS[presetId];

  const centerRaw = isPlainObject(partial.center) ? partial.center : {};
  const spanRaw = isPlainObject(partial.span) ? partial.span : {};
  const colorsRaw = isPlainObject(partial.colors) ? partial.colors : {};
  const layersRaw = isPlainObject(partial.layers) ? partial.layers : {};
  const ornRaw = isPlainObject(partial.ornaments) ? partial.ornaments : {};
  const scaleRaw = isPlainObject(ornRaw.scaleBar) ? ornRaw.scaleBar : {};
  const globeRaw = isPlainObject(ornRaw.locatorGlobe) ? ornRaw.locatorGlobe : {};
  const northRaw = isPlainObject(ornRaw.northArrow) ? ornRaw.northArrow : {};
  const legendRaw = isPlainObject(ornRaw.legend) ? ornRaw.legend : {};
  const proRaw = isPlainObject(partial.pro) ? partial.pro : {};

  const projection = PROJECTIONS.includes(partial.projection) ? partial.projection : def.projection;
  const detailLevel = DETAIL_LEVELS.includes(partial.detailLevel) ? partial.detailLevel : def.detailLevel;

  return {
    version: SCHEMA_VERSION,
    title: typeof partial.title === 'string' ? partial.title : def.title,
    showTitle: typeof partial.showTitle === 'boolean' ? partial.showTitle : def.showTitle,
    projection,
    detailLevel,
    center: {
      lat: clamp(centerRaw.lat, -89.5, 89.5, def.center.lat),
      lon: clamp(centerRaw.lon, -180, 180, def.center.lon),
    },
    span: {
      lonDeg: clamp(spanRaw.lonDeg, 0.05, 360, def.span.lonDeg),
      latDeg: clamp(spanRaw.latDeg, 0.05, 175, def.span.latDeg),
    },
    page: {
      preset: presetId,
      widthIn: clamp(pageRaw.widthIn, 1.0, 40.0, presetDims.widthIn),
      heightIn: clamp(pageRaw.heightIn, 1.0, 40.0, presetDims.heightIn),
      dpi: Math.round(clamp(pageRaw.dpi, 72, 1200, def.page.dpi)),
      showFrameBorder: typeof pageRaw.showFrameBorder === 'boolean'
        ? pageRaw.showFrameBorder
        : def.page.showFrameBorder,
    },
    theme: themeId,
    colors: {
      land: typeof colorsRaw.land === 'string' ? colorsRaw.land : themeColors.land,
      water: typeof colorsRaw.water === 'string' ? colorsRaw.water : themeColors.water,
      borders: typeof colorsRaw.borders === 'string' ? colorsRaw.borders : themeColors.borders,
      coastline: typeof colorsRaw.coastline === 'string' ? colorsRaw.coastline : themeColors.coastline,
      rivers: typeof colorsRaw.rivers === 'string' ? colorsRaw.rivers : themeColors.rivers,
      admin1: typeof colorsRaw.admin1 === 'string' ? colorsRaw.admin1 : themeColors.admin1,
      bathymetry: typeof colorsRaw.bathymetry === 'string' ? colorsRaw.bathymetry : themeColors.bathymetry,
      urban: typeof colorsRaw.urban === 'string' ? colorsRaw.urban : themeColors.urban,
      highlightFill: typeof colorsRaw.highlightFill === 'string' ? colorsRaw.highlightFill : themeColors.highlightFill,
      highlightStroke: typeof colorsRaw.highlightStroke === 'string' ? colorsRaw.highlightStroke : themeColors.highlightStroke,
      text: typeof colorsRaw.text === 'string' ? colorsRaw.text : themeColors.text,
      textHalo: typeof colorsRaw.textHalo === 'string' ? colorsRaw.textHalo : themeColors.textHalo,
    },
    layers: {
      showBorders: typeof layersRaw.showBorders === 'boolean' ? layersRaw.showBorders : def.layers.showBorders,
      borderWidth: clamp(layersRaw.borderWidth, 0.1, 8.0, def.layers.borderWidth),
      borderStyle: BORDER_STYLES.includes(layersRaw.borderStyle) ? layersRaw.borderStyle : def.layers.borderStyle,
      showCoastlines: typeof layersRaw.showCoastlines === 'boolean' ? layersRaw.showCoastlines : def.layers.showCoastlines,
      coastlineWidth: clamp(layersRaw.coastlineWidth, 0.1, 8.0, def.layers.coastlineWidth),
      showMinorIslands: typeof layersRaw.showMinorIslands === 'boolean' ? layersRaw.showMinorIslands : def.layers.showMinorIslands,
      showLakes: typeof layersRaw.showLakes === 'boolean' ? layersRaw.showLakes : def.layers.showLakes,
      showRivers: typeof layersRaw.showRivers === 'boolean' ? layersRaw.showRivers : def.layers.showRivers,
      riverWidth: clamp(layersRaw.riverWidth, 0.1, 8.0, def.layers.riverWidth),
      showBathymetry: typeof layersRaw.showBathymetry === 'boolean' ? layersRaw.showBathymetry : def.layers.showBathymetry,
      showUrbanAreas: typeof layersRaw.showUrbanAreas === 'boolean' ? layersRaw.showUrbanAreas : def.layers.showUrbanAreas,
      showAdmin1: typeof layersRaw.showAdmin1 === 'boolean' ? layersRaw.showAdmin1 : def.layers.showAdmin1,
      admin1Width: clamp(layersRaw.admin1Width, 0.1, 8.0, def.layers.admin1Width),
      admin1Scale: ADMIN1_SCALES.includes(layersRaw.admin1Scale) ? layersRaw.admin1Scale : def.layers.admin1Scale,
      showGraticule: typeof layersRaw.showGraticule === 'boolean' ? layersRaw.showGraticule : def.layers.showGraticule,
      graticuleStepDeg: clamp(layersRaw.graticuleStepDeg, 1, 60, def.layers.graticuleStepDeg),
      cityLabelScale: clamp(layersRaw.cityLabelScale, 0.4, 3.5, def.layers.cityLabelScale),
      cityIconScale: clamp(layersRaw.cityIconScale, 0.4, 3.5, def.layers.cityIconScale),
    },
    highlightedCountries: Array.isArray(partial.highlightedCountries)
      ? partial.highlightedCountries
          .filter((c) => isPlainObject(c) && (c.id || c.name))
          .map((c) => ({
            id: c.id != null ? String(c.id) : '',
            name: typeof c.name === 'string' ? c.name : '',
            fill: typeof c.fill === 'string' ? c.fill : themeColors.highlightFill,
            stroke: typeof c.stroke === 'string' ? c.stroke : themeColors.highlightStroke,
            hatch: HATCH_STYLES.includes(c.hatch) ? c.hatch : 'none',
          }))
      : def.highlightedCountries.map((c) => ({ ...c })),
    regionShadows: Array.isArray(partial.regionShadows)
      ? partial.regionShadows
          .filter((s) => isPlainObject(s) && (s.sourceId || s.sourceName))
          .map((s, idx) => ({
            id: typeof s.id === 'string' && s.id ? s.id : `shadow_${idx}_${Date.now()}`,
            sourceType: SHADOW_SOURCE_TYPES.includes(s.sourceType) ? s.sourceType : 'country',
            sourceId: s.sourceId != null ? String(s.sourceId) : '',
            sourceName: typeof s.sourceName === 'string' ? s.sourceName : '',
            targetLat: clamp(s.targetLat, -85, 85, def.center.lat),
            targetLon: clamp(s.targetLon, -180, 180, def.center.lon),
            rotationDeg: clamp(s.rotationDeg, -180, 180, 0),
            fill: typeof s.fill === 'string' ? s.fill : '#dc2626',
            stroke: typeof s.stroke === 'string' ? s.stroke : '#7f1d1d',
            opacity: clamp(s.opacity, 0.05, 0.95, 0.35),
            strokeWidth: clamp(s.strokeWidth, 0.3, 8.0, 1.6),
            dashed: typeof s.dashed === 'boolean' ? s.dashed : true,
            hatch: HATCH_STYLES.includes(s.hatch) ? s.hatch : 'none',
            showLabel: typeof s.showLabel === 'boolean' ? s.showLabel : true,
            showArea: typeof s.showArea === 'boolean' ? s.showArea : true,
            visible: typeof s.visible === 'boolean' ? s.visible : true,
          }))
      : [],
    cities: Array.isArray(partial.cities)
      ? partial.cities
          .filter((c) => isPlainObject(c) && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon)))
          .map((c, idx) => ({
            id: typeof c.id === 'string' && c.id ? c.id : `city_${idx}_${Date.now()}`,
            name: typeof c.name === 'string' ? c.name : 'Point',
            lat: clamp(c.lat, -90, 90, 0),
            lon: clamp(c.lon, -180, 180, 0),
            style: PIN_STYLES.includes(c.style) ? c.style : 'dot',
            dx: clamp(c.dx, -80, 80, 6),
            dy: clamp(c.dy, -80, 80, -5),
            scale: clamp(c.scale, 0.4, 3.0, 1.0),
          }))
      : def.cities.map((c) => ({ ...c })),
    customGeoJsonLayers: Array.isArray(partial.customGeoJsonLayers)
      ? partial.customGeoJsonLayers
          .filter((l) => isPlainObject(l))
          .map((l, idx) => ({
            id: typeof l.id === 'string' && l.id ? l.id : `layer_${idx}`,
            label: typeof l.label === 'string' ? l.label : `Overlay ${idx + 1}`,
            url: typeof l.url === 'string' ? l.url : null,
            data: isPlainObject(l.data) ? l.data : null,
            visible: typeof l.visible === 'boolean' ? l.visible : true,
            color: typeof l.color === 'string' ? l.color : '#222222',
            fillOpacity: clamp(l.fillOpacity, 0, 1, 0.45),
            strokeWidth: clamp(l.strokeWidth, 0.2, 8, 1.5),
            dashed: typeof l.dashed === 'boolean' ? l.dashed : false,
            hatch: HATCH_STYLES.includes(l.hatch) ? l.hatch : 'none',
          }))
      : [],
    ornaments: {
      scaleBar: {
        enabled: typeof scaleRaw.enabled === 'boolean' ? scaleRaw.enabled : def.ornaments.scaleBar.enabled,
        units: scaleRaw.units === 'mi' ? 'mi' : 'km',
        position: CORNER_POSITIONS.includes(scaleRaw.position) ? scaleRaw.position : def.ornaments.scaleBar.position,
      },
      locatorGlobe: {
        enabled: typeof globeRaw.enabled === 'boolean' ? globeRaw.enabled : def.ornaments.locatorGlobe.enabled,
        position: CORNER_POSITIONS.includes(globeRaw.position) ? globeRaw.position : def.ornaments.locatorGlobe.position,
        sizePct: clamp(globeRaw.sizePct, 10, 40, def.ornaments.locatorGlobe.sizePct),
        showExtentBox: typeof globeRaw.showExtentBox === 'boolean' ? globeRaw.showExtentBox : def.ornaments.locatorGlobe.showExtentBox,
        zoomMode: GLOBE_ZOOM_MODES.includes(globeRaw.zoomMode) ? globeRaw.zoomMode : def.ornaments.locatorGlobe.zoomMode,
        zoom: clamp(globeRaw.zoom, 1.0, 6.0, def.ornaments.locatorGlobe.zoom),
      },
      northArrow: {
        enabled: typeof northRaw.enabled === 'boolean' ? northRaw.enabled : def.ornaments.northArrow.enabled,
        position: CORNER_POSITIONS.includes(northRaw.position) ? northRaw.position : def.ornaments.northArrow.position,
      },
      legend: {
        enabled: typeof legendRaw.enabled === 'boolean' ? legendRaw.enabled : def.ornaments.legend.enabled,
        position: CORNER_POSITIONS.includes(legendRaw.position) ? legendRaw.position : def.ornaments.legend.position,
      },
    },
    pro: {
      basemapProvider: BASEMAP_PROVIDERS.includes(proRaw.basemapProvider) ? proRaw.basemapProvider : def.pro.basemapProvider,
      basemapOpacity: clamp(proRaw.basemapOpacity, 0.1, 1.0, def.pro.basemapOpacity),
      coastlineEngine: COASTLINE_ENGINES.includes(proRaw.coastlineEngine) ? proRaw.coastlineEngine : def.pro.coastlineEngine,
    },
  };
}

export function getPixelDimensions(page) {
  const widthIn = clamp(page?.widthIn, 1.0, 40.0, 4.6);
  const heightIn = clamp(page?.heightIn, 1.0, 40.0, 7.0);
  const dpi = Math.round(clamp(page?.dpi, 72, 1200, 300));
  return {
    widthPx: Math.round(widthIn * dpi),
    heightPx: Math.round(heightIn * dpi),
    widthIn,
    heightIn,
    dpi,
  };
}

export function stripInlineGeoJsonForShare(spec) {
  const clone = structuredClone(spec);
  clone.customGeoJsonLayers = (clone.customGeoJsonLayers || []).map((layer) => {
    if (layer.url) {
      return { ...layer, data: null };
    }
    return layer;
  });
  return clone;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeSpecToHash(spec) {
  const shareable = stripInlineGeoJsonForShare(spec);
  // Omit inline GeoJSON payloads without a remote URL so URLs stay compact
  shareable.customGeoJsonLayers = shareable.customGeoJsonLayers.filter(
    (l) => Boolean(l.url) || !l.data || JSON.stringify(l.data).length < 4096,
  );
  const json = JSON.stringify(shareable);
  const bytes = new TextEncoder().encode(json);
  return `#m=${bytesToBase64Url(bytes)}`;
}

export function decodeSpecFromHash(hash) {
  if (!hash || typeof hash !== 'string') return null;
  const cleaned = hash.startsWith('#') ? hash.slice(1) : hash;
  const prefix = 'm=';
  const idx = cleaned.indexOf(prefix);
  if (idx === -1) return null;
  const token = cleaned.slice(idx + prefix.length).split('&')[0];
  if (!token) return null;
  try {
    const bytes = base64UrlToBytes(token);
    const json = new TextDecoder().decode(bytes);
    return normalizeMapSpec(JSON.parse(json));
  } catch {
    return null;
  }
}

export function sanitizeFilename(name, fallback = 'dusty_map') {
  const cleaned = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\- ]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}
