/**
 * On-demand military topographic terrain relief engine (pure client-side JS).
 *
 * Fetches CORS-enabled AWS/Mapzen Terrarium global elevation PNG tiles for the
 * current framed area, caches tiles in memory + CacheStorage, reprojects DEM
 * elevation through any D3 projection (including across the antimeridian), and
 * renders Army-familiar multidirectional NW shaded relief, DMA/NGA JOG
 * hypsometric elevation tints, and crisp Marching Squares index/intermediate
 * brown topographic contour lines.
 *
 * Zero external dependencies so core math, tile planning, Terrarium decoding,
 * hillshade, and contour extraction are directly unit-testable in Node.js.
 */

export const TERRARIUM_TILE_URL_TEMPLATE =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export const TERRAIN_CACHE_NAME = 'dusty-mapmaker-terrain-v1';
export const TERRAIN_TILE_SIZE = 256;
export const TERRAIN_MIN_ZOOM = 2;
export const TERRAIN_MAX_ZOOM = 12;
export const TERRAIN_DEFAULT_MAX_TILES = 30;
export const TERRAIN_DEFAULT_PAD_FRACTION = 0.15;

export const TERRAIN_STYLES = {
  army_topo: {
    id: 'army_topo',
    label: 'Army Topo (NW Shaded Relief)',
    shortLabel: 'Army Topo',
    hasHillshade: true,
    hasHypsometric: false,
    contoursOnly: false,
  },
  staff_hillshade: {
    id: 'staff_hillshade',
    label: 'Staff Hillshade (Briefing Relief)',
    shortLabel: 'Staff Hillshade',
    hasHillshade: true,
    hasHypsometric: false,
    contoursOnly: false,
  },
  jog_elevation: {
    id: 'jog_elevation',
    label: 'JOG Operational (Elevation Tint + Relief)',
    shortLabel: 'JOG Relief',
    hasHillshade: true,
    hasHypsometric: true,
    contoursOnly: false,
  },
  topo_contours: {
    id: 'topo_contours',
    label: 'Contour Lines Only (Pure Vector)',
    shortLabel: 'Topo Contours',
    hasHillshade: false,
    hasHypsometric: false,
    contoursOnly: true,
  },
};

export const TERRAIN_STYLE_IDS = Object.keys(TERRAIN_STYLES);
export const TERRAIN_CLIP_MODES = ['land', 'highlighted'];
export const TERRAIN_CONTOUR_INTERVALS = ['auto', 20, 50, 100, 200, 250, 500, 1000];

export function wantsTerrainContours(terrainRelief) {
  if (!terrainRelief) return false;
  return terrainRelief.style === 'topo_contours' || Boolean(terrainRelief.showContours);
}

const STANDARD_CONTOUR_INTERVALS = [20, 50, 100, 200, 250, 500, 1000];
const MAX_LAT_MERCATOR = 85.05112878;
const MAX_TILE_MEMORY_CACHE = 240;

// Muted NATO / DMA Joint Operations Graphic (JOG) hypsometric elevation ramp (meters -> RGB)
const JOG_ELEVATION_STOPS = [
  { elev: 0, r: 194, g: 209, b: 181 },
  { elev: 150, r: 210, g: 218, b: 190 },
  { elev: 400, r: 228, g: 222, b: 190 },
  { elev: 800, r: 225, g: 202, b: 162 },
  { elev: 1400, r: 210, g: 171, b: 130 },
  { elev: 2200, r: 186, g: 137, b: 101 },
  { elev: 3200, r: 168, g: 122, b: 98 },
  { elev: 4500, r: 216, g: 208, b: 202 },
  { elev: 6500, r: 242, g: 240, b: 238 },
];

// In-memory LRU cache of decoded Float32Array(256*256) Terrarium elevation tiles
const decodedTileCache = new Map();
const inflightTileFetches = new Map();

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function wrapLon(lon) {
  let x = (((lon + 180) % 360) + 360) % 360 - 180;
  if (x === -180 && lon > 0) x = 180;
  return x;
}

function wrapDeltaLon(dlon) {
  let d = dlon;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Decode a single RGB pixel from AWS/Mapzen Terrarium format into meters above sea level.
 */
export function decodeTerrariumElevation(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Convert longitude in degrees to continuous Web Mercator tile X coordinate at `zoom`.
 * Accepts unwrapped longitudes (e.g. > 180 or < -180) for antimeridian continuity.
 */
export function lonToTileX(lon, zoom) {
  const n = 2 ** zoom;
  return ((lon + 180) / 360) * n;
}

/**
 * Convert latitude in degrees to continuous Web Mercator tile Y coordinate at `zoom`.
 */
export function latToTileY(lat, zoom) {
  const n = 2 ** zoom;
  const clamped = clamp(lat, -MAX_LAT_MERCATOR, MAX_LAT_MERCATOR);
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
}

export function tileXToLon(tileX, zoom) {
  const n = 2 ** zoom;
  return (tileX / n) * 360 - 180;
}

export function tileYToLat(tileY, zoom) {
  const n = 2 ** zoom;
  const rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n)));
  return (rad * 180) / Math.PI;
}

export function buildTerrariumTileUrl(z, x, y) {
  return TERRARIUM_TILE_URL_TEMPLATE
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * Normalize visible bounds array `[minLon, maxLon, minLat, maxLat]`, bounds object,
 * or MapSpec into unwrapped `{ minLon, maxLon, minLat, maxLat }` coordinates.
 */
export function normalizeBoundsInput(boundsOrSpec) {
  if (Array.isArray(boundsOrSpec) && boundsOrSpec.length >= 4) {
    let minLon = Number(boundsOrSpec[0]);
    let maxLon = Number(boundsOrSpec[1]);
    const minLat = clamp(Number(boundsOrSpec[2]), -85, 85);
    const maxLat = clamp(Number(boundsOrSpec[3]), -85, 85);
    if (!Number.isFinite(minLon) || !Number.isFinite(maxLon)) {
      minLon = -180;
      maxLon = 180;
    }
    if (maxLon < minLon) {
      maxLon += 360;
    }
    if (maxLon - minLon > 360) {
      const mid = (minLon + maxLon) * 0.5;
      minLon = mid - 180;
      maxLon = mid + 180;
    }
    return {
      minLon,
      maxLon: Math.max(minLon + 0.005, maxLon),
      minLat: Math.min(minLat, maxLat),
      maxLat: Math.max(minLat + 0.005, maxLat),
    };
  }

  if (
    boundsOrSpec &&
    typeof boundsOrSpec === 'object' &&
    Number.isFinite(Number(boundsOrSpec.west)) &&
    Number.isFinite(Number(boundsOrSpec.east)) &&
    Number.isFinite(Number(boundsOrSpec.south)) &&
    Number.isFinite(Number(boundsOrSpec.north))
  ) {
    let minLon = Number(boundsOrSpec.west);
    let maxLon = Number(boundsOrSpec.east);
    if (maxLon < minLon) maxLon += 360;
    const minLat = clamp(Number(boundsOrSpec.south), -85, 85);
    const maxLat = clamp(Number(boundsOrSpec.north), -85, 85);
    return {
      minLon,
      maxLon: Math.max(minLon + 0.005, maxLon),
      minLat: Math.min(minLat, maxLat),
      maxLat: Math.max(minLat + 0.005, maxLat),
    };
  }

  // Fallback: derive from MapSpec
  const spec = boundsOrSpec || {};
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = clamp(Number(spec?.center?.lat) || 0, -84.5, 84.5);
  let spanLon = Math.max(0.005, Math.min(360, Number(spec?.span?.lonDeg) || 24));
  let spanLat = Math.max(0.005, Math.min(170, Number(spec?.span?.latDeg) || 14));

  const widthIn = Number(spec?.page?.widthIn) || 0;
  const heightIn = Number(spec?.page?.heightIn) || 0;
  if (widthIn > 0 && heightIn > 0) {
    const cosLat = Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
    const boxAspect = (spanLon * cosLat) / spanLat;
    const pageAspect = widthIn / heightIn;
    if (boxAspect > pageAspect) {
      spanLat = Math.min(170, (spanLon * cosLat) / pageAspect);
    } else if (boxAspect < pageAspect) {
      spanLon = Math.min(360, (spanLat * pageAspect) / cosLat);
    }
  }

  return {
    minLon: centerLon - spanLon / 2,
    maxLon: centerLon + spanLon / 2,
    minLat: clamp(centerLat - spanLat / 2, -85, 85),
    maxLat: clamp(centerLat + spanLat / 2, -85, 85),
  };
}

/**
 * Plan the optimal Web Mercator Terrarium tile set for a framed area.
 * Handles antimeridian crossings cleanly by keeping unwrapped logical columns
 * and wrapping each tile's X index modulo 2^zoom.
 */
export function planTerrainTiles(
  boundsOrSpec,
  {
    padFraction = TERRAIN_DEFAULT_PAD_FRACTION,
    maxTiles = TERRAIN_DEFAULT_MAX_TILES,
    minZoom = TERRAIN_MIN_ZOOM,
    maxZoom = TERRAIN_MAX_ZOOM,
    forcedZoom = null,
  } = {},
) {
  const raw = normalizeBoundsInput(boundsOrSpec);
  const rawSpanLon = Math.max(0.005, raw.maxLon - raw.minLon);
  const rawSpanLat = Math.max(0.005, raw.maxLat - raw.minLat);

  const padLon = rawSpanLon >= 340 ? 0 : Math.max(0.01, rawSpanLon * padFraction);
  const padLat = Math.max(0.01, rawSpanLat * padFraction);

  let unwrappedMinLon = raw.minLon - padLon;
  let unwrappedMaxLon = raw.maxLon + padLon;
  if (unwrappedMaxLon - unwrappedMinLon >= 359.5) {
    unwrappedMinLon = -180;
    unwrappedMaxLon = 179.9999;
  }

  const south = clamp(raw.minLat - padLat, -85.0, 85.0);
  const north = clamp(raw.maxLat + padLat, -85.0, 85.0);

  const computeGridForZoom = (z) => {
    const n = 2 ** z;
    const tx0 = Math.floor(lonToTileX(unwrappedMinLon, z));
    const tx1 = Math.floor(lonToTileX(unwrappedMaxLon - 1e-9, z));
    const cols = Math.min(n, Math.max(1, tx1 - tx0 + 1));
    const xStart = cols >= n ? 0 : tx0;

    const ty0 = clamp(Math.floor(latToTileY(north, z)), 0, n - 1);
    const ty1 = clamp(Math.floor(latToTileY(south, z)), 0, n - 1);
    const yStart = Math.min(ty0, ty1);
    const rows = Math.max(1, Math.max(ty0, ty1) - yStart + 1);
    return { z, n, xStart, yStart, cols, rows, count: cols * rows };
  };

  let chosen = null;
  if (Number.isInteger(forcedZoom)) {
    const z = clamp(forcedZoom, minZoom, maxZoom);
    chosen = computeGridForZoom(z);
    while (chosen.count > maxTiles && chosen.z > minZoom) {
      chosen = computeGridForZoom(chosen.z - 1);
    }
  } else {
    for (let z = maxZoom; z >= minZoom; z -= 1) {
      const candidate = computeGridForZoom(z);
      if (candidate.count <= maxTiles) {
        chosen = candidate;
        break;
      }
    }
    if (!chosen) {
      chosen = computeGridForZoom(minZoom);
    }
  }

  const tiles = [];
  for (let row = 0; row < chosen.rows; row += 1) {
    const y = chosen.yStart + row;
    for (let col = 0; col < chosen.cols; col += 1) {
      const x = (((chosen.xStart + col) % chosen.n) + chosen.n) % chosen.n;
      tiles.push({
        z: chosen.z,
        x,
        y,
        col,
        row,
        url: buildTerrariumTileUrl(chosen.z, x, y),
      });
    }
  }

  const covWest = wrapLon(tileXToLon(chosen.xStart, chosen.z));
  const covEast = chosen.cols >= chosen.n
    ? 180
    : wrapLon(tileXToLon(chosen.xStart + chosen.cols, chosen.z));
  const covNorth = Number(clamp(tileYToLat(chosen.yStart, chosen.z), -85.05, 85.05).toFixed(4));
  const covSouth = Number(clamp(tileYToLat(chosen.yStart + chosen.rows, chosen.z), -85.05, 85.05).toFixed(4));

  return {
    zoom: chosen.z,
    xStart: chosen.xStart,
    yStart: chosen.yStart,
    cols: chosen.cols,
    rows: chosen.rows,
    tileCount: tiles.length,
    width: chosen.cols * TERRAIN_TILE_SIZE,
    height: chosen.rows * TERRAIN_TILE_SIZE,
    tiles,
    rawSpanLon,
    rawSpanLat,
    paddedBounds: {
      south: Number(south.toFixed(4)),
      west: Number(wrapLon(unwrappedMinLon).toFixed(4)),
      north: Number(north.toFixed(4)),
      east: Number(wrapLon(unwrappedMaxLon).toFixed(4)),
      zoom: chosen.z,
    },
    coverageBounds: {
      south: covSouth,
      west: Number(covWest.toFixed(4)),
      north: covNorth,
      east: Number(covEast.toFixed(4)),
      fullWorldLon: chosen.cols >= chosen.n,
      zoom: chosen.z,
    },
  };
}

/**
 * Determine whether the current framed view has moved outside a previously fetched terrain bbox.
 */
export function isViewOutsideTerrainBounds(viewBoundsOrSpec, terrainBounds) {
  if (!terrainBounds) return false;
  const view = normalizeBoundsInput(viewBoundsOrSpec);
  const vSouth = view.minLat;
  const vNorth = view.maxLat;
  const bSouth = Number(terrainBounds.south);
  const bNorth = Number(terrainBounds.north);
  if (!Number.isFinite(bSouth) || !Number.isFinite(bNorth)) return false;

  const latSpan = Math.max(0.05, vNorth - vSouth);
  const latTol = latSpan * 0.08;
  if (vSouth < bSouth - latTol || vNorth > bNorth + latTol) {
    return true;
  }

  if (terrainBounds.fullWorldLon) {
    return false;
  }

  const bWest = Number(terrainBounds.west);
  const bEast = Number(terrainBounds.east);
  if (!Number.isFinite(bWest) || !Number.isFinite(bEast)) return false;

  const bSpanLon = bWest > bEast ? (180 - bWest) + (bEast + 180) : bEast - bWest;
  if (bSpanLon >= 355) return false;

  const vSpanLon = view.maxLon - view.minLon;
  if (vSpanLon > bSpanLon * 1.15) return true;

  const bMidLon = bWest + bSpanLon * 0.5;
  const vMidLonRaw = (view.minLon + view.maxLon) * 0.5;
  const vMidLon = bMidLon + wrapDeltaLon(vMidLonRaw - bMidLon);
  const vWest = vMidLon - vSpanLon * 0.5;
  const vEast = vMidLon + vSpanLon * 0.5;
  const lonTol = Math.max(0.05, vSpanLon * 0.08);

  return vWest < bWest - lonTol || vEast > bWest + bSpanLon + lonTol;
}

/**
 * Pick a clean, Army-standard metric contour interval (meters) for the local terrain relief.
 */
export function chooseAutoContourInterval(maxElevMeters, spanDeg = 10) {
  const maxE = Math.max(0, Number(maxElevMeters) || 0);
  if (maxE < 40) return 20;

  // Target ~10–14 contour steps across local relief while preventing clutter at wide theater spans
  let minBySpan = 20;
  if (spanDeg > 40) minBySpan = 500;
  else if (spanDeg > 16) minBySpan = 250;
  else if (spanDeg > 7) minBySpan = 200;
  else if (spanDeg > 2.5) minBySpan = 100;
  else if (spanDeg > 0.8) minBySpan = 50;

  const ideal = maxE / 11;
  for (let i = 0; i < STANDARD_CONTOUR_INTERVALS.length; i += 1) {
    const candidate = STANDARD_CONTOUR_INTERVALS[i];
    if (candidate >= minBySpan && candidate >= ideal * 0.82) {
      return candidate;
    }
  }
  return STANDARD_CONTOUR_INTERVALS[STANDARD_CONTOUR_INTERVALS.length - 1];
}

/**
 * Resolve effective contour interval (respecting manual selection while preventing pathological line floods).
 */
export function resolveEffectiveContourInterval(configuredInterval, p98LandElev, spanDeg) {
  const maxE = Math.max(100, Number(p98LandElev) || 1000);
  if (configuredInterval === 'auto' || configuredInterval == null || configuredInterval === '') {
    return chooseAutoContourInterval(maxE, spanDeg);
  }
  const numeric = Number(configuredInterval);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return chooseAutoContourInterval(maxE, spanDeg);
  }
  // Guard against > 48 stacked levels on giant ranges at tiny interval
  if (maxE / numeric > 48) {
    for (let i = 0; i < STANDARD_CONTOUR_INTERVALS.length; i += 1) {
      const candidate = STANDARD_CONTOUR_INTERVALS[i];
      if (candidate >= numeric && maxE / candidate <= 48) {
        return candidate;
      }
    }
    return 1000;
  }
  return numeric;
}

/**
 * Bilinearly sample elevation in meters from a stitched DEM mosaic at `(lon, lat)`.
 * Returns `NaN` when `(lon, lat)` falls outside the fetched mosaic.
 */
export function sampleDemElevation(dem, lon, lat) {
  if (!dem || !dem.elev || !Number.isFinite(lon) || !Number.isFinite(lat)) return NaN;
  if (lat < -MAX_LAT_MERCATOR || lat > MAX_LAT_MERCATOR) return NaN;

  const n = 2 ** dem.zoom;
  const rawTx = lonToTileX(lon, dem.zoom);
  let relTx = rawTx - dem.xStart;

  if (relTx < 0 || relTx > dem.cols) {
    if (relTx + n >= 0 && relTx + n <= dem.cols) {
      relTx += n;
    } else if (relTx - n >= 0 && relTx - n <= dem.cols) {
      relTx -= n;
    } else {
      return NaN;
    }
  }

  const relTy = latToTileY(lat, dem.zoom) - dem.yStart;
  if (relTy < 0 || relTy > dem.rows) return NaN;

  const w = dem.width;
  const h = dem.height;
  const u = clamp(relTx * TERRAIN_TILE_SIZE - 0.5, 0, w - 1);
  const v = clamp(relTy * TERRAIN_TILE_SIZE - 0.5, 0, h - 1);

  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = u - x0;
  const fy = v - y0;

  const elev = dem.elev;
  const row0 = y0 * w;
  const row1 = y1 * w;
  const e00 = elev[row0 + x0];
  const e10 = elev[row0 + x1];
  const e01 = elev[row1 + x0];
  const e11 = elev[row1 + x1];

  if (!Number.isFinite(e00) || !Number.isFinite(e10) || !Number.isFinite(e01) || !Number.isFinite(e11)) {
    return Number.isFinite(e00) ? e00 : NaN;
  }

  const top = e00 + (e10 - e00) * fx;
  const bot = e01 + (e11 - e01) * fx;
  return top + (bot - top) * fy;
}

/**
 * Compute elevation summary statistics (min/max/98th percentile above sea level)
 * for a Float32Array elevation grid.
 */
export function computeDemStats(elevArray) {
  if (!elevArray || elevArray.length === 0) {
    return { minLandElev: 0, maxLandElev: 0, p98LandElev: 0, landSamples: 0 };
  }
  const stride = Math.max(1, Math.floor(elevArray.length / 40000));
  const landVals = [];
  let minLand = Infinity;
  let maxLand = -Infinity;

  for (let i = 0; i < elevArray.length; i += stride) {
    const v = elevArray[i];
    if (!Number.isFinite(v) || v <= 0.5) continue;
    if (v < minLand) minLand = v;
    if (v > maxLand) maxLand = v;
    landVals.push(v);
  }

  if (landVals.length === 0) {
    return { minLandElev: 0, maxLandElev: 0, p98LandElev: 0, landSamples: 0 };
  }

  landVals.sort((a, b) => a - b);
  const p98Idx = Math.min(landVals.length - 1, Math.floor(landVals.length * 0.985));
  return {
    minLandElev: Math.round(minLand),
    maxLandElev: Math.round(maxLand),
    p98LandElev: Math.round(landVals[p98Idx]),
    landSamples: landVals.length,
  };
}

/**
 * Separable 1-pass [0.25, 0.5, 0.25] gentle smoothing on a projected Float32Array
 * elevation grid to suppress SRTM quantization artifacts while preserving ridges.
 */
export function smoothElevationGrid(elev, gw, gh) {
  const tmp = new Float32Array(gw * gh);
  const out = new Float32Array(gw * gh);

  for (let y = 0; y < gh; y += 1) {
    const row = y * gw;
    for (let x = 0; x < gw; x += 1) {
      const c = elev[row + x];
      if (!Number.isFinite(c) || c <= 0) {
        tmp[row + x] = c;
        continue;
      }
      let sum = c * 2;
      let wt = 2;
      if (x > 0) {
        const l = elev[row + x - 1];
        if (Number.isFinite(l) && l > 0) {
          sum += l;
          wt += 1;
        }
      }
      if (x + 1 < gw) {
        const r = elev[row + x + 1];
        if (Number.isFinite(r) && r > 0) {
          sum += r;
          wt += 1;
        }
      }
      tmp[row + x] = sum / wt;
    }
  }

  for (let y = 0; y < gh; y += 1) {
    const row = y * gw;
    for (let x = 0; x < gw; x += 1) {
      const c = tmp[row + x];
      if (!Number.isFinite(c) || c <= 0) {
        out[row + x] = c;
        continue;
      }
      let sum = c * 2;
      let wt = 2;
      if (y > 0) {
        const u = tmp[(y - 1) * gw + x];
        if (Number.isFinite(u) && u > 0) {
          sum += u;
          wt += 1;
        }
      }
      if (y + 1 < gh) {
        const d = tmp[(y + 1) * gw + x];
        if (Number.isFinite(d) && d > 0) {
          sum += d;
          wt += 1;
        }
      }
      out[row + x] = sum / wt;
    }
  }

  return out;
}

function interpolateJogColor(elevMeters) {
  const e = Math.max(0, elevMeters);
  const stops = JOG_ELEVATION_STOPS;
  if (e <= stops[0].elev) {
    return [stops[0].r, stops[0].g, stops[0].b];
  }
  for (let i = 1; i < stops.length; i += 1) {
    if (e <= stops[i].elev) {
      const prev = stops[i - 1];
      const next = stops[i];
      const t = (e - prev.elev) / Math.max(1, next.elev - prev.elev);
      return [
        Math.round(prev.r + (next.r - prev.r) * t),
        Math.round(prev.g + (next.g - prev.g) * t),
        Math.round(prev.b + (next.b - prev.b) * t),
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last.r, last.g, last.b];
}

function localGeoDistanceMeters(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * 111132.95;
  const meanLatRad = (((lat1 + lat2) * 0.5) * Math.PI) / 180;
  const dLon = wrapDeltaLon(lon2 - lon1) * 111319.49 * Math.max(0.05, Math.cos(meanLatRad));
  return Math.hypot(dLon, dLat);
}

/**
 * Render multidirectional NW Army hillshade (and optional DMA/NGA JOG elevation tint)
 * into an RGBA Uint8ClampedArray of size `gw * gh * 4`.
 */
export function renderTerrainRasterPixels(
  elevGrid,
  stepXMGrid,
  stepYMGrid,
  gw,
  gh,
  {
    style = 'army_topo',
    intensity = 0.72,
    exaggeration = 2.2,
  } = {},
) {
  const styleDef = TERRAIN_STYLES[style] || TERRAIN_STYLES.army_topo;
  const rgba = new Uint8ClampedArray(gw * gh * 4);
  if (!styleDef.hasHillshade && !styleDef.hasHypsometric) {
    return rgba;
  }

  const clampedIntensity = clamp(Number(intensity) || 0.72, 0.1, 1.0);
  const clampedExag = clamp(Number(exaggeration) || 2.2, 0.5, 6.0);

  // Multidirectional illumination vectors in screen coordinates (+X east, +Y south, +Z up)
  // 70% classic NW (315 deg, 45 deg alt) + 15% W (270 deg, 42 deg alt) + 15% N (360 deg, 42 deg alt)
  const l1x = -0.5;
  const l1y = -0.5;
  const l1z = 0.70710678;
  const l2x = -0.74314483;
  const l2z = 0.66913061;
  const l3y = -0.74314483;
  const l3z = 0.66913061;
  const flatIllum = 0.7 * l1z + 0.15 * l2z + 0.15 * l3z;

  for (let y = 0; y < gh; y += 1) {
    const yPrev = Math.max(0, y - 1);
    const yNext = Math.min(gh - 1, y + 1);
    const row = y * gw;
    const rowPrev = yPrev * gw;
    const rowNext = yNext * gw;

    for (let x = 0; x < gw; x += 1) {
      const idx = row + x;
      const eC = elevGrid[idx];
      if (!Number.isFinite(eC) || eC <= 0.1) continue;

      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(gw - 1, x + 1);

      const e00 = Number.isFinite(elevGrid[rowPrev + xPrev]) ? Math.max(0, elevGrid[rowPrev + xPrev]) : eC;
      const e01 = Number.isFinite(elevGrid[rowPrev + x]) ? Math.max(0, elevGrid[rowPrev + x]) : eC;
      const e02 = Number.isFinite(elevGrid[rowPrev + xNext]) ? Math.max(0, elevGrid[rowPrev + xNext]) : eC;
      const e10 = Number.isFinite(elevGrid[row + xPrev]) ? Math.max(0, elevGrid[row + xPrev]) : eC;
      const e12 = Number.isFinite(elevGrid[row + xNext]) ? Math.max(0, elevGrid[row + xNext]) : eC;
      const e20 = Number.isFinite(elevGrid[rowNext + xPrev]) ? Math.max(0, elevGrid[rowNext + xPrev]) : eC;
      const e21 = Number.isFinite(elevGrid[rowNext + x]) ? Math.max(0, elevGrid[rowNext + x]) : eC;
      const e22 = Number.isFinite(elevGrid[rowNext + xNext]) ? Math.max(0, elevGrid[rowNext + xNext]) : eC;

      const stepXM = Math.max(15, stepXMGrid[idx] || 500);
      const stepYM = Math.max(15, stepYMGrid[idx] || 500);
      const meanStep = 0.5 * (stepXM + stepYM);

      // Gentle scale-aware vertical boost so operational/continental mountain belts remain legible
      const scaleBoost = clamp(Math.pow(meanStep / 240, 0.42), 1.0, 5.5);
      const effZ = clampedExag * scaleBoost;

      const dzdx = ((e02 + 2 * e12 + e22) - (e00 + 2 * e10 + e20)) / (8 * stepXM);
      const dzdy = ((e20 + 2 * e21 + e22) - (e00 + 2 * e01 + e02)) / (8 * stepYM);

      const nx = -dzdx * effZ;
      const ny = -dzdy * effZ;
      const invLen = 1 / Math.hypot(nx, ny, 1);
      const ux = nx * invLen;
      const uy = ny * invLen;
      const uz = invLen;

      const i1 = Math.max(0, ux * l1x + uy * l1y + uz * l1z);
      const i2 = Math.max(0, ux * l2x + uz * l2z);
      const i3 = Math.max(0, uy * l3y + uz * l3z);
      const illum = 0.7 * i1 + 0.15 * i2 + 0.15 * i3;
      const delta = illum - flatIllum;

      const outIdx = idx * 4;

      if (styleDef.hasHypsometric) {
        const [baseR, baseG, baseB] = interpolateJogColor(eC);
        // Modulate JOG elevation tint by hillshade contrast
        const shadeGain = clamp(1 + delta * 1.45, 0.45, 1.32);
        rgba[outIdx] = clamp(Math.round(baseR * shadeGain), 0, 255);
        rgba[outIdx + 1] = clamp(Math.round(baseG * shadeGain), 0, 255);
        rgba[outIdx + 2] = clamp(Math.round(baseB * shadeGain), 0, 255);
        rgba[outIdx + 3] = clamp(Math.round(255 * (0.28 + clampedIntensity * 0.62)), 0, 255);
      } else {
        // Two-tone transparent hillshade: flat plains stay 100% clean across all Dusty themes
        const absD = Math.abs(delta);
        if (absD < 0.012) continue;
        const shaped = Math.pow(clamp((absD - 0.012) / 0.46, 0, 1), 0.88);
        if (delta < 0) {
          // Shadowed SE slope: deep warm charcoal-umber
          rgba[outIdx] = 22;
          rgba[outIdx + 1] = 18;
          rgba[outIdx + 2] = 14;
          rgba[outIdx + 3] = clamp(Math.round(shaped * clampedIntensity * 215), 0, 230);
        } else {
          // Sunlit NW slope: crisp warm ivory highlight
          rgba[outIdx] = 255;
          rgba[outIdx + 1] = 252;
          rgba[outIdx + 2] = 244;
          rgba[outIdx + 3] = clamp(Math.round(shaped * clampedIntensity * 155), 0, 175);
        }
      }
    }
  }

  return rgba;
}

/**
 * Extract crisp vector contour segments (index every 5th level + intermediate)
 * from a projected elevation grid via Marching Squares.
 *
 * Returns `{ indexSegments, intermediateSegments, levels }` where each segment
 * list is a flat array `[x1, y1, x2, y2, ...]` in target canvas pixel coordinates.
 */
export function extractContourSegments(
  elevGrid,
  gw,
  gh,
  targetWidth,
  targetHeight,
  intervalMeters,
  maxElevHint = 0,
) {
  const indexSegments = [];
  const intermediateSegments = [];
  const interval = Math.max(10, Math.round(Number(intervalMeters) || 100));

  let maxE = Number(maxElevHint) || 0;
  if (maxE <= 0) {
    for (let i = 0; i < elevGrid.length; i += 1) {
      const v = elevGrid[i];
      if (Number.isFinite(v) && v > maxE) maxE = v;
    }
  }
  if (maxE < interval) {
    return { indexSegments, intermediateSegments, levels: [], interval };
  }

  const maxLevels = 48;
  const levels = [];
  for (let level = interval; level <= maxE && levels.length < maxLevels; level += interval) {
    levels.push(level);
  }
  if (levels.length === 0) {
    return { indexSegments, intermediateSegments, levels, interval };
  }

  const sx = targetWidth / gw;
  const sy = targetHeight / gh;
  const indexMod = interval * 5;

  const interp = (a, b, level) => {
    const denom = b - a;
    if (Math.abs(denom) < 1e-9) return 0.5;
    return clamp((level - a) / denom, 0, 1);
  };

  for (let li = 0; li < levels.length; li += 1) {
    const level = levels[li];
    const target = level % indexMod === 0 ? indexSegments : intermediateSegments;

    for (let y = 0; y < gh - 1; y += 1) {
      const row0 = y * gw;
      const row1 = (y + 1) * gw;
      const py0 = (y + 0.5) * sy;
      const py1 = (y + 1.5) * sy;

      for (let x = 0; x < gw - 1; x += 1) {
        const v0 = elevGrid[row0 + x]; // TL
        const v1 = elevGrid[row0 + x + 1]; // TR
        const v2 = elevGrid[row1 + x + 1]; // BR
        const v3 = elevGrid[row1 + x]; // BL

        if (
          !Number.isFinite(v0) ||
          !Number.isFinite(v1) ||
          !Number.isFinite(v2) ||
          !Number.isFinite(v3)
        ) {
          continue;
        }
        // Keep contours strictly on land above sea level
        if (v0 <= 0.1 && v1 <= 0.1 && v2 <= 0.1 && v3 <= 0.1) continue;

        const code =
          (v0 >= level ? 8 : 0) |
          (v1 >= level ? 4 : 0) |
          (v2 >= level ? 2 : 0) |
          (v3 >= level ? 1 : 0);

        if (code === 0 || code === 15) continue;

        const px0 = (x + 0.5) * sx;
        const px1 = (x + 1.5) * sx;

        // Edge midpoints lazily computed: 0=Top, 1=Right, 2=Bottom, 3=Left
        const topX = px0 + interp(v0, v1, level) * sx;
        const rightY = py0 + interp(v1, v2, level) * sy;
        const botX = px0 + interp(v3, v2, level) * sx;
        const leftY = py0 + interp(v0, v3, level) * sy;

        switch (code) {
          case 1:
          case 14:
            target.push(px0, leftY, botX, py1);
            break;
          case 2:
          case 13:
            target.push(botX, py1, px1, rightY);
            break;
          case 3:
          case 12:
            target.push(px0, leftY, px1, rightY);
            break;
          case 4:
          case 11:
            target.push(topX, py0, px1, rightY);
            break;
          case 5: {
            const center = 0.25 * (v0 + v1 + v2 + v3);
            if (center >= level) {
              target.push(px0, leftY, topX, py0, botX, py1, px1, rightY);
            } else {
              target.push(px0, leftY, botX, py1, topX, py0, px1, rightY);
            }
            break;
          }
          case 6:
          case 9:
            target.push(topX, py0, botX, py1);
            break;
          case 7:
          case 8:
            target.push(px0, leftY, topX, py0);
            break;
          case 10: {
            const center = 0.25 * (v0 + v1 + v2 + v3);
            if (center >= level) {
              target.push(px0, leftY, botX, py1, topX, py0, px1, rightY);
            } else {
              target.push(px0, leftY, topX, py0, botX, py1, px1, rightY);
            }
            break;
          }
          default:
            break;
        }
      }
    }
  }

  return { indexSegments, intermediateSegments, levels, interval };
}

/**
 * Compute adaptive Army topographic brown contour colors so lines remain crisp
 * on both light parchment/B&W themes and dark charcoal/blueprint themes.
 */
export function resolveContourPalette(surfaceColorHex, style = 'army_topo') {
  if (style === 'jog_elevation') {
    return {
      indexColor: '#5c3114',
      intermediateColor: '#824d26',
      indexAlpha: 0.76,
      intermediateAlpha: 0.44,
    };
  }
  const lum = parseHexLuminance(surfaceColorHex);
  if (lum !== null && lum < 0.34) {
    // Dark land surface (e.g. Dusty Prime #4a4a4a or Naval Blueprint #1d3c5e): warm bronze-tan topo lines
    return {
      indexColor: '#d9ab7e',
      intermediateColor: '#b98b5e',
      indexAlpha: 0.72,
      intermediateAlpha: 0.42,
    };
  }
  // Light / medium land surface: classic USGS/Army Field Manual topographic brown
  return {
    indexColor: '#5e3214',
    intermediateColor: '#87542c',
    indexAlpha: 0.78,
    intermediateAlpha: 0.48,
  };
}

function parseHexLuminance(color) {
  if (typeof color !== 'string') return null;
  const m = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Sample a stitched DEM mosaic through an active D3 projection onto a regular screen grid.
 */
export function buildProjectedElevationGrid(
  dem,
  projection,
  width,
  height,
  {
    maxGridDim = 560,
    isFrontPoint = null,
  } = {},
) {
  if (!dem || !projection || typeof projection.invert !== 'function' || width <= 0 || height <= 0) {
    return null;
  }

  const scale = Math.min(1, maxGridDim / Math.max(width, height));
  const gw = Math.max(32, Math.round(width * scale));
  const gh = Math.max(32, Math.round(height * scale));
  const dx = width / gw;
  const dy = height / gh;

  const elevRaw = new Float32Array(gw * gh);
  const lonGrid = new Float32Array(gw * gh);
  const latGrid = new Float32Array(gw * gh);
  elevRaw.fill(NaN);
  lonGrid.fill(NaN);
  latGrid.fill(NaN);

  let validLandCount = 0;
  let maxVisibleElev = 0;

  for (let y = 0; y < gh; y += 1) {
    const py = (y + 0.5) * dy;
    const row = y * gw;
    for (let x = 0; x < gw; x += 1) {
      const px = (x + 0.5) * dx;
      const pt = projection.invert([px, py]);
      if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
      const lon = pt[0];
      const lat = pt[1];
      if (isFrontPoint && !isFrontPoint(lon, lat)) continue;

      const idx = row + x;
      lonGrid[idx] = lon;
      latGrid[idx] = lat;

      const e = sampleDemElevation(dem, lon, lat);
      if (Number.isFinite(e)) {
        elevRaw[idx] = e;
        if (e > 0.5) {
          validLandCount += 1;
          if (e > maxVisibleElev) maxVisibleElev = e;
        }
      }
    }
  }

  if (validLandCount === 0) {
    return {
      gw,
      gh,
      elev: elevRaw,
      stepXM: new Float32Array(gw * gh),
      stepYM: new Float32Array(gw * gh),
      validLandCount: 0,
      maxVisibleElev: 0,
    };
  }

  const elev = smoothElevationGrid(elevRaw, gw, gh);
  const stepXM = new Float32Array(gw * gh);
  const stepYM = new Float32Array(gw * gh);

  for (let y = 0; y < gh; y += 1) {
    const row = y * gw;
    const yUp = Math.max(0, y - 1) * gw;
    const yDn = Math.min(gh - 1, y + 1) * gw;
    const ySpan = y === 0 || y === gh - 1 ? 1 : 2;

    for (let x = 0; x < gw; x += 1) {
      const idx = row + x;
      if (!Number.isFinite(elev[idx]) || elev[idx] <= 0.1) continue;

      const xL = Math.max(0, x - 1);
      const xR = Math.min(gw - 1, x + 1);
      const xSpan = x === 0 || x === gw - 1 ? 1 : 2;

      const lonL = lonGrid[row + xL];
      const latL = latGrid[row + xL];
      const lonR = lonGrid[row + xR];
      const latR = latGrid[row + xR];
      if (Number.isFinite(lonL) && Number.isFinite(lonR)) {
        stepXM[idx] = Math.max(15, localGeoDistanceMeters(lonL, latL, lonR, latR) / xSpan);
      } else {
        stepXM[idx] = 500;
      }

      const lonU = lonGrid[yUp + x];
      const latU = latGrid[yUp + x];
      const lonD = lonGrid[yDn + x];
      const latD = latGrid[yDn + x];
      if (Number.isFinite(lonU) && Number.isFinite(lonD)) {
        stepYM[idx] = Math.max(15, localGeoDistanceMeters(lonU, latU, lonD, latD) / ySpan);
      } else {
        stepYM[idx] = stepXM[idx];
      }
    }
  }

  return { gw, gh, elev, stepXM, stepYM, validLandCount, maxVisibleElev };
}

/**
 * Build or retrieve a cached projected terrain relief render artifact for Canvas & SVG.
 */
export function buildProjectedTerrainLayer(
  dem,
  projection,
  spec,
  width,
  height,
  { interactive = false, isFrontPoint = null } = {},
) {
  const tr = spec?.terrainRelief;
  if (!dem || !tr?.enabled) return null;

  const style = TERRAIN_STYLES[tr.style] ? tr.style : 'army_topo';
  const styleDef = TERRAIN_STYLES[style];
  const intensity = clamp(Number(tr.intensity) || 0.72, 0.1, 1.0);
  const exaggeration = clamp(Number(tr.exaggeration) || 2.2, 0.5, 6.0);
  const spanDeg = Math.max(Number(spec?.span?.lonDeg) || 10, Number(spec?.span?.latDeg) || 10);
  const maxGridDim = interactive ? 220 : Math.min(1050, Math.max(540, Math.round(Math.max(width, height) * 0.72)));

  const projKey = [
    dem.key,
    spec?.projection || 'mercator',
    Number(spec?.center?.lat || 0).toFixed(5),
    Number(spec?.center?.lon || 0).toFixed(5),
    Number(spec?.span?.lonDeg || 0).toFixed(5),
    Number(spec?.span?.latDeg || 0).toFixed(5),
    width,
    height,
    maxGridDim,
  ].join('|');

  if (!dem._gridCache || dem._gridCache.key !== projKey) {
    const grid = buildProjectedElevationGrid(dem, projection, width, height, {
      maxGridDim,
      isFrontPoint,
    });
    dem._gridCache = { key: projKey, grid };
  }

  const grid = dem._gridCache.grid;
  if (!grid || grid.validLandCount === 0) return null;

  const showContours = wantsTerrainContours(tr);
  const effectiveInterval = resolveEffectiveContourInterval(
    tr.contourInterval,
    Math.max(dem.stats?.p98LandElev || 0, grid.maxVisibleElev || 0),
    spanDeg,
  );

  const renderKey = [
    projKey,
    style,
    intensity.toFixed(2),
    exaggeration.toFixed(2),
    showContours && !interactive ? effectiveInterval : 'nc',
  ].join('::');

  if (dem._renderCache && dem._renderCache.key === renderKey) {
    return dem._renderCache.artifact;
  }

  let rasterCanvas = null;
  if (styleDef.hasHillshade || styleDef.hasHypsometric) {
    const rgba = renderTerrainRasterPixels(
      grid.elev,
      grid.stepXM,
      grid.stepYM,
      grid.gw,
      grid.gh,
      { style, intensity, exaggeration },
    );
    if (typeof document !== 'undefined') {
      rasterCanvas = document.createElement('canvas');
      rasterCanvas.width = grid.gw;
      rasterCanvas.height = grid.gh;
      const rctx = rasterCanvas.getContext('2d');
      if (rctx) {
        const imgData = new ImageData(rgba, grid.gw, grid.gh);
        rctx.putImageData(imgData, 0, 0);
      }
    }
  }

  let contours = null;
  if (showContours && !interactive) {
    contours = extractContourSegments(
      grid.elev,
      grid.gw,
      grid.gh,
      width,
      height,
      effectiveInterval,
      grid.maxVisibleElev,
    );
  }

  const artifact = {
    style,
    showContours,
    intensity,
    exaggeration,
    effectiveInterval,
    maxVisibleElev: Math.round(grid.maxVisibleElev || dem.stats?.maxLandElev || 0),
    rasterCanvas,
    contours,
    width,
    height,
  };

  dem._renderCache = { key: renderKey, artifact };
  return artifact;
}

/**
 * Convert a flat segment array `[x1, y1, x2, y2, ...]` into a compact SVG `d` path string.
 */
export function contourSegmentsToSvgPath(segments) {
  if (!Array.isArray(segments) || segments.length < 4) return '';
  const parts = [];
  for (let i = 0; i + 3 < segments.length; i += 4) {
    parts.push(
      `M${segments[i].toFixed(1)},${segments[i + 1].toFixed(1)}L${segments[i + 2].toFixed(1)},${segments[i + 3].toFixed(1)}`,
    );
  }
  return parts.join('');
}

// ============================================================================
// Browser Tile Decoding & Cached On-Demand Fetcher
// ============================================================================

async function decodePngBlobToElevation(blob) {
  const canvas = document.createElement('canvas');
  canvas.width = TERRAIN_TILE_SIZE;
  canvas.height = TERRAIN_TILE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Could not acquire 2D canvas context to decode elevation tile.');
  }

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try {
      ctx.drawImage(bitmap, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE);
    } finally {
      bitmap.close?.();
    }
  } else {
    const objectUrl = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.drawImage(img, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE);
          resolve();
        };
        img.onerror = () => reject(new Error('Failed to decode elevation PNG tile.'));
        img.src = objectUrl;
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  const { data } = ctx.getImageData(0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE);
  const elev = new Float32Array(TERRAIN_TILE_SIZE * TERRAIN_TILE_SIZE);
  for (let i = 0, p = 0; i < elev.length; i += 1, p += 4) {
    elev[i] = decodeTerrariumElevation(data[p], data[p + 1], data[p + 2]);
  }
  return elev;
}

function rememberDecodedTile(key, elev) {
  if (decodedTileCache.has(key)) {
    decodedTileCache.delete(key);
  }
  decodedTileCache.set(key, elev);
  while (decodedTileCache.size > MAX_TILE_MEMORY_CACHE) {
    const oldest = decodedTileCache.keys().next().value;
    decodedTileCache.delete(oldest);
  }
}

async function fetchSingleTerrariumTile(tile, { forceRefresh = false } = {}) {
  const key = `${tile.z}/${tile.x}/${tile.y}`;
  if (!forceRefresh && decodedTileCache.has(key)) {
    return decodedTileCache.get(key);
  }
  if (!forceRefresh && inflightTileFetches.has(key)) {
    return inflightTileFetches.get(key);
  }

  const promise = (async () => {
    let cache = null;
    if (typeof caches !== 'undefined') {
      try {
        cache = await caches.open(TERRAIN_CACHE_NAME);
      } catch {
        cache = null;
      }
    }

    let response = null;
    if (cache && !forceRefresh) {
      try {
        response = await cache.match(tile.url);
      } catch {
        response = null;
      }
    }

    if (!response) {
      response = await fetch(tile.url, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) {
        throw new Error(`Terrain tile ${key} failed (${response.status})`);
      }
      if (cache) {
        try {
          await cache.put(tile.url, response.clone());
        } catch {
          // Ignore CacheStorage quota errors
        }
      }
    }

    const blob = await response.blob();
    const elev = await decodePngBlobToElevation(blob);
    rememberDecodedTile(key, elev);
    return elev;
  })();

  inflightTileFetches.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightTileFetches.delete(key);
  }
}

/**
 * Fetch and stitch a Terrarium DEM mosaic on demand for the given bounds or MapSpec.
 */
export async function fetchTerrainDemForBounds(
  boundsOrSpec,
  {
    maxTiles = TERRAIN_DEFAULT_MAX_TILES,
    forcedZoom = null,
    forceRefresh = false,
    onStatus = null,
    concurrency = 6,
  } = {},
) {
  const plan = planTerrainTiles(boundsOrSpec, { maxTiles, forcedZoom });
  const total = plan.tileCount;
  let completed = 0;

  onStatus?.(`Fetching elevation tiles (0/${total}, z${plan.zoom})...`);

  const mosaic = new Float32Array(plan.width * plan.height);
  mosaic.fill(NaN);

  const queue = plan.tiles.slice();
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  let failures = 0;

  async function worker() {
    while (queue.length > 0) {
      const tile = queue.shift();
      if (!tile) break;
      try {
        const tileElev = await fetchSingleTerrariumTile(tile, { forceRefresh });
        const dstBaseX = tile.col * TERRAIN_TILE_SIZE;
        const dstBaseY = tile.row * TERRAIN_TILE_SIZE;
        for (let ty = 0; ty < TERRAIN_TILE_SIZE; ty += 1) {
          const dstRow = (dstBaseY + ty) * plan.width + dstBaseX;
          const srcRow = ty * TERRAIN_TILE_SIZE;
          mosaic.set(tileElev.subarray(srcRow, srcRow + TERRAIN_TILE_SIZE), dstRow);
        }
      } catch {
        failures += 1;
      }
      completed += 1;
      onStatus?.(`Fetching elevation tiles (${completed}/${total}, z${plan.zoom})...`);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures === total) {
    throw new Error('Could not download elevation tiles. Check your internet connection and retry.');
  }

  const stats = computeDemStats(mosaic);
  const key = `dem_z${plan.zoom}_${plan.xStart}_${plan.yStart}_${plan.cols}x${plan.rows}`;

  return {
    key,
    zoom: plan.zoom,
    xStart: plan.xStart,
    yStart: plan.yStart,
    cols: plan.cols,
    rows: plan.rows,
    width: plan.width,
    height: plan.height,
    tileCount: plan.tileCount,
    failedTiles: failures,
    elev: mosaic,
    stats,
    bounds: plan.coverageBounds,
    paddedBounds: plan.paddedBounds,
    _gridCache: null,
    _renderCache: null,
  };
}
