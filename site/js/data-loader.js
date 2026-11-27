/**
 * Natural Earth & World Atlas CDN dataset loader with in-memory + CacheStorage caching,
 * river lake-centerline filtering, country catalog indexing, and anti-meridian city queries.
 */

import * as topojson from 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';
import { geoArea, geoCentroid } from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import {
  OVERPASS_ENDPOINTS,
  buildOverpassCoastlineQuery,
  computePaddedCoastlineBBox,
  encodeOsmCoastlineUrl,
  findMatchingCachedCoastlinePack,
  getCachedCoastlinePackById,
  isOsmCoastlineUrl,
  parseOsmCoastlineUrl,
  polygonizeOverpassCoastlines,
  simplifyGeoJsonCoastline,
} from './osm-coastline.js?v=37';

const CACHE_NAME = 'dusty-mapmaker-v4';
try {
  if (typeof caches !== 'undefined') {
    void caches.delete('dusty-mapmaker-v1');
    void caches.delete('dusty-mapmaker-v2');
    void caches.delete('dusty-mapmaker-v3');
  }
} catch {
  // Ignore CacheStorage errors on restricted origins
}
const VALID_RESOLUTIONS = new Set(['110m', '50m', '10m', 'ultra']);

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

// In-memory caches shared across renders and exports
const jsonMemoryCache = new Map();
const inflightFetches = new Map();
const worldAtlasCache = new Map();
const filteredRiversCache = new Map();
const bboxAttachedCollections = new WeakSet();

/**
 * Compute `[minLon, minLat, maxLon, maxLat, crossesAntimeridian]` for nested GeoJSON coordinates.
 */
export function computeCoordsBBox(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let crossesAntimeridian = false;
  let hasPoint = false;

  function walk(node) {
    if (!Array.isArray(node) || node.length === 0) return;

    if (typeof node[0] === 'number') {
      const lon = node[0];
      const lat = node[1];
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        hasPoint = true;
      }
      return;
    }

    const first = node[0];
    if (Array.isArray(first) && typeof first[0] === 'number') {
      let prevLon = NaN;
      for (let i = 0; i < node.length; i += 1) {
        const pt = node[i];
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lon = pt[0];
        const lat = pt[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (Number.isFinite(prevLon) && Math.abs(lon - prevLon) > 180) {
          crossesAntimeridian = true;
        }
        prevLon = lon;
        hasPoint = true;
      }
      return;
    }

    for (let i = 0; i < node.length; i += 1) {
      walk(node[i]);
    }
  }

  walk(coords);
  if (!hasPoint) return null;
  if (maxLon - minLon > 180) {
    crossesAntimeridian = true;
  }
  return [minLon, minLat, maxLon, maxLat, crossesAntimeridian];
}

function attachFeatureBBoxes(fc) {
  const features = fc?.features;
  if (!Array.isArray(features) || bboxAttachedCollections.has(fc)) {
    return fc;
  }
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (!f) continue;
    f._bbox = computeCoordsBBox(f.geometry?.coordinates);
  }
  bboxAttachedCollections.add(fc);
  return fc;
}

function sanitizePolygonRings(polyCoords) {
  if (!Array.isArray(polyCoords) || polyCoords.length === 0) return;
  const outer = polyCoords[0];
  if (Array.isArray(outer) && outer.length >= 4) {
    if (geoArea({ type: 'Polygon', coordinates: [outer] }) > 2 * Math.PI) {
      outer.reverse();
    }
  }
  // Inner hole rings in D3 spherical winding must be CCW (single-ring complement area > 2*pi)
  for (let r = 1; r < polyCoords.length; r += 1) {
    const hole = polyCoords[r];
    if (Array.isArray(hole) && hole.length >= 4) {
      if (geoArea({ type: 'Polygon', coordinates: [hole] }) < 2 * Math.PI) {
        hole.reverse();
      }
    }
  }
}

function sanitizeGeometryWinding(geom) {
  if (!geom || typeof geom !== 'object') return;
  if (geom.type === 'Polygon') {
    sanitizePolygonRings(geom.coordinates);
  } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
    for (let j = 0; j < geom.coordinates.length; j += 1) {
      sanitizePolygonRings(geom.coordinates[j]);
    }
  } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    for (let j = 0; j < geom.geometries.length; j += 1) {
      sanitizeGeometryWinding(geom.geometries[j]);
    }
  }
}

export function sanitizeGeoJsonWinding(geojson) {
  if (!geojson || typeof geojson !== 'object') return geojson;
  if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
    for (let i = 0; i < geojson.features.length; i += 1) {
      sanitizeGeometryWinding(geojson.features[i]?.geometry);
    }
  } else if (geojson.type === 'Feature') {
    sanitizeGeometryWinding(geojson.geometry);
  } else {
    sanitizeGeometryWinding(geojson);
  }
  return geojson;
}

function sanitizePolygonFeatureCollection(fc) {
  return sanitizeGeoJsonWinding(fc);
}

function decomposeGeometryParts(geojson, singleType, multiType) {
  const parts = [];
  function pushPart(partCoords) {
    if (singleType === 'Polygon') {
      sanitizePolygonRings(partCoords);
    }
    const bbox = computeCoordsBBox(partCoords);
    parts.push({
      type: singleType,
      coordinates: partCoords,
      _bbox: bbox,
    });
  }
  function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FeatureCollection' && Array.isArray(node.features)) {
      for (let i = 0; i < node.features.length; i += 1) {
        collect(node.features[i]);
      }
      return;
    }
    if (node.type === 'Feature') {
      collect(node.geometry);
      return;
    }
    if (node.type === 'GeometryCollection' && Array.isArray(node.geometries)) {
      for (let i = 0; i < node.geometries.length; i += 1) {
        collect(node.geometries[i]);
      }
      return;
    }
    if (node.type === singleType && Array.isArray(node.coordinates)) {
      pushPart(node.coordinates);
      return;
    }
    if (node.type === multiType && Array.isArray(node.coordinates)) {
      for (let i = 0; i < node.coordinates.length; i += 1) {
        pushPart(node.coordinates[i]);
      }
    }
  }
  collect(geojson);
  return parts;
}

function buildUrls(res, fineHydrology = false, admin1Scale = '50m', finePlaces = false) {
  const worldRes = res === 'ultra' ? '10m' : res;
  const use10mLakes = res === 'ultra' || res === '10m' || (fineHydrology && worldRes === '10m');
  const use10mRivers = res === 'ultra' || (fineHydrology && worldRes === '10m');
  const hydroRes = use10mLakes ? '10m' : '50m';
  const riverRes = use10mRivers ? '10m' : '50m';
  const effAdmin1 = admin1Scale === '10m' ? '10m' : '50m';
  const placesRes = res === 'ultra' || finePlaces ? '10m' : '50m';

  return {
    world: `https://cdn.jsdelivr.net/npm/world-atlas@2/countries-${worldRes}.json`,
    minorIslands:
      'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_minor_islands.geojson',
    lakes:
      hydroRes === '10m'
        ? 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_lakes.geojson'
        : 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_lakes.geojson',
    rivers:
      riverRes === '10m'
        ? 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_rivers_lake_centerlines.geojson'
        : 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_rivers_lake_centerlines.geojson',
    bathymetry200:
      'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_bathymetry_K_200.geojson',
    bathymetry1000:
      'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_bathymetry_J_1000.geojson',
    urbanAreas:
      'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_urban_areas.geojson',
    marinePolys:
      'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_geography_marine_polys.geojson',
    admin1:
      effAdmin1 === '10m'
        ? 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces_lines.geojson'
        : 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_admin_1_states_provinces_lines.geojson',
    admin1Polygons:
      'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_admin_1_states_provinces.geojson',
    places:
      placesRes === '10m'
        ? 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_populated_places_simple.geojson'
        : 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_populated_places_simple.geojson',
    worldRes,
    hydroRes,
    riverRes,
    admin1Res: effAdmin1,
    placesRes,
  };
}

async function readCacheStorage(url) {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(url);
    if (!match) return null;
    return await match.json();
  } catch {
    return null;
  }
}

async function writeCacheStorage(url, responseClone) {
  try {
    if (typeof caches === 'undefined' || !responseClone) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, responseClone);
  } catch {
    // CacheStorage may be disabled in sandboxed origins or full
  }
}

async function fetchJsonCached(url) {
  if (jsonMemoryCache.has(url)) {
    return jsonMemoryCache.get(url);
  }
  if (inflightFetches.has(url)) {
    return inflightFetches.get(url);
  }

  const promise = (async () => {
    const cached = await readCacheStorage(url);
    if (cached) {
      jsonMemoryCache.set(url, cached);
      return cached;
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch dataset (${res.status} ${res.statusText}): ${url}`);
    }

    const responseClone = typeof caches !== 'undefined' ? res.clone() : null;
    const data = await res.json();
    jsonMemoryCache.set(url, data);
    if (responseClone) {
      await writeCacheStorage(url, responseClone);
    }
    return data;
  })();

  inflightFetches.set(url, promise);
  try {
    return await promise;
  } finally {
    inflightFetches.delete(url);
  }
}

async function loadWorldAtlas(res) {
  const worldRes = res === 'ultra' ? '10m' : res;
  if (worldAtlasCache.has(worldRes)) {
    return worldAtlasCache.get(worldRes);
  }

  const { world } = buildUrls(worldRes);
  const topo = await fetchJsonCached(world);
  const countriesObj = topo?.objects?.countries;
  if (!countriesObj) {
    throw new Error(`Invalid world-atlas TopoJSON (missing objects.countries) for ${worldRes}`);
  }

  const land = topo.objects.land
    ? topojson.feature(topo, topo.objects.land)
    : topojson.merge(topo, countriesObj.geometries);
  const countries = attachFeatureBBoxes(topojson.feature(topo, countriesObj));
  sanitizePolygonFeatureCollection(countries);
  const internalBorders = topojson.mesh(topo, countriesObj, (a, b) => a !== b);
  const landParts = decomposeGeometryParts(land, 'Polygon', 'MultiPolygon');
  const borderParts = decomposeGeometryParts(internalBorders, 'LineString', 'MultiLineString');

  const parsed = { land, landParts, countries, internalBorders, borderParts };
  worldAtlasCache.set(worldRes, parsed);
  return parsed;
}

async function loadFilteredRivers(res, fineHydrology = false) {
  const urls = buildUrls(res, fineHydrology);
  const riverRes = urls.riverRes;
  if (filteredRiversCache.has(riverRes)) {
    return filteredRiversCache.get(riverRes);
  }

  const raw = await fetchJsonCached(urls.rivers);
  const features = Array.isArray(raw?.features)
    ? raw.features.filter((f) => {
        const cls = String(f?.properties?.featurecla || '').trim().toLowerCase();
        return cls !== 'lake centerline';
      })
    : [];

  const filtered = attachFeatureBBoxes({
    type: 'FeatureCollection',
    features,
  });
  filteredRiversCache.set(riverRes, filtered);
  return filtered;
}

async function loadPolygonCollection(url) {
  const fc = attachFeatureBBoxes(await fetchJsonCached(url));
  sanitizePolygonFeatureCollection(fc);
  return fc;
}

export async function loadAdmin1Polygons() {
  const { admin1Polygons } = buildUrls('50m');
  return loadPolygonCollection(admin1Polygons);
}

function emitProgress(onProgress, info) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(info);
  } catch {
    // Do not let UI progress callbacks break dataset loading
  }
}

export function resolveAdmin1Scale(spec) {
  const configured = spec?.layers?.admin1Scale;
  if (configured === '10m' || configured === '50m') {
    return configured;
  }
  const maxSpan = Math.max(
    Number(spec?.span?.lonDeg) || 24,
    Number(spec?.span?.latDeg) || 14,
  );
  return maxSpan <= 35 ? '10m' : '50m';
}

export function resolveResolution(spec) {
  if (spec && typeof spec.detailLevel === 'string' && spec.detailLevel !== 'auto') {
    if (VALID_RESOLUTIONS.has(spec.detailLevel)) {
      return spec.detailLevel;
    }
  }
  const lonDeg = Number(spec?.span?.lonDeg);
  const latDeg = Number(spec?.span?.latDeg);
  const maxSpan = Math.max(
    Number.isFinite(lonDeg) ? lonDeg : 24,
    Number.isFinite(latDeg) ? latDeg : 14,
  );
  if (maxSpan <= 5) {
    return 'ultra';
  }
  if (maxSpan <= 16) {
    return '10m';
  }
  if (maxSpan <= 90) {
    return '50m';
  }
  return '110m';
}

export async function ensureDatasets(
  resolution = '50m',
  {
    needMinorIslands = true,
    needLakes = true,
    needRivers = false,
    needBathymetry = false,
    needUrbanAreas = false,
    needAdmin1 = false,
    needAdmin1Polygons = false,
    needPlaces = false,
    fineHydrology = false,
    finePlaces = false,
    admin1Scale = '50m',
    onProgress = null,
  } = {},
) {
  const res = VALID_RESOLUTIONS.has(resolution) ? resolution : '50m';
  const effAdmin1 = admin1Scale === '10m' ? '10m' : '50m';
  const urls = buildUrls(res, fineHydrology, effAdmin1, finePlaces);
  let usedAdmin1Scale = effAdmin1;
  let usedPlacesRes = urls.placesRes;

  const tasks = [
    {
      key: 'world',
      label: `Loading ${res === 'ultra' ? 'Ultra 10m+' : res} world boundaries`,
      run: () => loadWorldAtlas(res),
    },
  ];

  const cached50m = worldAtlasCache.get('50m') || null;
  const locatorRes = (res === '10m' || res === 'ultra') && !cached50m ? '50m' : '110m';

  if (res !== '110m') {
    tasks.push({
      key: 'locator',
      label: `Loading ${locatorRes} locator globe`,
      run: () => loadWorldAtlas(locatorRes),
    });
  }
  if (needMinorIslands && (res === '10m' || res === 'ultra')) {
    tasks.push({
      key: 'minorIslands',
      label: 'Loading 10m minor islands',
      run: async () => {
        try {
          return await loadPolygonCollection(urls.minorIslands);
        } catch (err) {
          console.warn('Minor islands layer unavailable:', err);
          return null;
        }
      },
    });
  }
  if (needLakes) {
    tasks.push({
      key: 'lakes',
      label: `Loading ${urls.hydroRes} lakes & inland seas`,
      run: async () => {
        try {
          return await loadPolygonCollection(urls.lakes);
        } catch (err) {
          if (urls.hydroRes === '10m') {
            console.warn('Failed to load 10m lakes; falling back to 50m:', err);
            return await loadPolygonCollection(buildUrls('50m').lakes);
          }
          throw err;
        }
      },
    });
  }
  if (needRivers) {
    tasks.push({
      key: 'rivers',
      label: `Loading ${urls.riverRes} rivers`,
      run: () => loadFilteredRivers(res, fineHydrology),
    });
  }
  if (needBathymetry) {
    tasks.push({
      key: 'bathymetry200',
      label: 'Loading ocean continental shelf (200m)',
      run: async () => {
        try {
          return await loadPolygonCollection(urls.bathymetry200);
        } catch (err) {
          console.warn('Bathymetry 200m unavailable:', err);
          return null;
        }
      },
    });
    tasks.push({
      key: 'bathymetry1000',
      label: 'Loading ocean slope (1000m)',
      run: async () => {
        try {
          return await loadPolygonCollection(urls.bathymetry1000);
        } catch (err) {
          console.warn('Bathymetry 1000m unavailable:', err);
          return null;
        }
      },
    });
  }
  if (needUrbanAreas) {
    tasks.push({
      key: 'urbanAreas',
      label: 'Loading urban area footprints',
      run: async () => {
        try {
          return await loadPolygonCollection(urls.urbanAreas);
        } catch (err) {
          console.warn('Urban areas unavailable:', err);
          return null;
        }
      },
    });
  }
  if (needAdmin1) {
    tasks.push({
      key: 'admin1',
      label: `Loading ${effAdmin1} state/province lines`,
      run: async () => {
        try {
          return attachFeatureBBoxes(await fetchJsonCached(urls.admin1));
        } catch (err) {
          if (effAdmin1 === '10m') {
            console.warn('Failed to load 10m admin-1 lines; falling back to 50m:', err);
            usedAdmin1Scale = '50m';
            const fallbackUrl = buildUrls(res, fineHydrology, '50m').admin1;
            return attachFeatureBBoxes(await fetchJsonCached(fallbackUrl));
          }
          throw err;
        }
      },
    });
  }
  if (needAdmin1Polygons) {
    tasks.push({
      key: 'admin1Polygons',
      label: 'Loading state & province shapes',
      run: async () => {
        try {
          return await loadPolygonCollection(urls.admin1Polygons);
        } catch (err) {
          console.warn('Admin-1 polygons unavailable:', err);
          return null;
        }
      },
    });
  }
  if (needPlaces) {
    tasks.push({
      key: 'places',
      label: `Loading ${urls.placesRes} populated places`,
      run: async () => {
        try {
          return await fetchJsonCached(urls.places);
        } catch (err) {
          if (urls.placesRes === '10m') {
            console.warn('Failed to load 10m populated places; falling back to 50m:', err);
            usedPlacesRes = '50m';
            return await fetchJsonCached(buildUrls('50m').places);
          }
          throw err;
        }
      },
    });
    tasks.push({
      key: 'marinePolys',
      label: 'Loading seas, bays & gulfs labels',
      run: async () => {
        try {
          return await loadPolygonCollection(urls.marinePolys);
        } catch (err) {
          console.warn('Marine polygons unavailable:', err);
          return null;
        }
      },
    });
  }

  let completed = 0;
  const total = tasks.length;
  emitProgress(onProgress, {
    completed: 0,
    total,
    fraction: 0,
    resolution: res,
    label: tasks[0].label,
  });

  const results = {};
  await Promise.all(
    tasks.map(async (task) => {
      const value = await task.run();
      results[task.key] = value;
      completed += 1;
      emitProgress(onProgress, {
        completed,
        total,
        fraction: completed / total,
        resolution: res,
        label: task.label,
      });
    }),
  );

  const world = results.world;
  const locator = res === '110m' ? world : results.locator;
  let locatorDetail = null;
  if (res === '50m') {
    locatorDetail = world;
  } else if (res === '10m' || res === 'ultra') {
    locatorDetail = cached50m || worldAtlasCache.get('50m') || locator;
  } else {
    locatorDetail = worldAtlasCache.get('50m') || null;
  }

  return {
    resolution: res,
    fineHydrology: Boolean(fineHydrology || res === 'ultra'),
    placesResolution: needPlaces ? usedPlacesRes : null,
    admin1Resolution: needAdmin1 ? usedAdmin1Scale : null,
    land: world.land,
    landParts: world.landParts,
    minorIslands: results.minorIslands || null,
    countries: world.countries,
    internalBorders: world.internalBorders,
    borderParts: world.borderParts,
    locatorLand: locator.land,
    locatorBorders: locator.internalBorders,
    locatorDetailLand: locatorDetail ? locatorDetail.land : null,
    locatorDetailBorders: locatorDetail ? locatorDetail.internalBorders : null,
    lakes: results.lakes || null,
    rivers: results.rivers || null,
    bathymetry200: results.bathymetry200 || null,
    bathymetry1000: results.bathymetry1000 || null,
    urbanAreas: results.urbanAreas || null,
    marinePolys: results.marinePolys || null,
    admin1: results.admin1 || null,
    admin1Polygons: results.admin1Polygons || null,
    populatedPlaces: results.places || null,
  };
}

export const ALASKA_ONLY_COUNTRY = {
  id: 'US-AK',
  name: 'Alaska (Only)',
};

const alaskaFeatureCache = new WeakMap();

export function isAlaskaOnlySelection(id, name = '') {
  const normId = id != null ? String(id).trim().toLowerCase() : '';
  const normName = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return normId === 'us-ak' || normName === 'alaska (only)' || normName === 'alaska';
}

function isAlaskaBBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return false;
  const minLat = bbox[1];
  return Number.isFinite(minLat) && minLat >= 50.0;
}

/**
 * Extract an Alaska-only GeoJSON Feature from the USA MultiPolygon in a world-atlas
 * countries FeatureCollection (all Alaska mainland + Aleutian polygons lie >= 50°N,
 * cleanly separated from the contiguous 48 states <= 49.38°N and Hawaii <= 29°N).
 */
export function extractAlaskaOnlyFeature(countries) {
  const features = countries?.features;
  if (!Array.isArray(features)) return null;
  if (alaskaFeatureCache.has(countries)) {
    return alaskaFeatureCache.get(countries);
  }

  let usaFeature = null;
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const fId = f?.id != null ? String(f.id).trim() : '';
    const fName = typeof f?.properties?.name === 'string' ? f.properties.name.trim().toLowerCase() : '';
    if (fId === '840' || fName === 'united states of america' || fName === 'united states') {
      usaFeature = f;
      break;
    }
  }

  if (!usaFeature?.geometry) {
    alaskaFeatureCache.set(countries, null);
    return null;
  }

  const geom = usaFeature.geometry;
  let polyList = [];
  if (geom.type === 'Polygon') {
    polyList = [geom.coordinates];
  } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
    polyList = geom.coordinates;
  }

  const alaskaPolys = [];
  for (let i = 0; i < polyList.length; i += 1) {
    const polyCoords = polyList[i];
    const bbox = computeCoordsBBox(polyCoords);
    if (isAlaskaBBox(bbox)) {
      alaskaPolys.push(polyCoords);
    }
  }

  if (!alaskaPolys.length) {
    alaskaFeatureCache.set(countries, null);
    return null;
  }

  const feature = {
    type: 'Feature',
    id: ALASKA_ONLY_COUNTRY.id,
    properties: {
      name: ALASKA_ONLY_COUNTRY.name,
      iso_3166_2: 'US-AK',
      adm0_id: '840',
    },
    geometry:
      alaskaPolys.length === 1
        ? { type: 'Polygon', coordinates: alaskaPolys[0] }
        : { type: 'MultiPolygon', coordinates: alaskaPolys },
    _bbox: computeCoordsBBox(alaskaPolys),
  };

  alaskaFeatureCache.set(countries, feature);
  return feature;
}

/**
 * Filter a GeoJSON payload (such as geoBoundaries USA ADM1/ADM2) down to Alaska-only features.
 */
export function filterGeoJsonToAlaska(geojson) {
  const validated = validateGeoJson(geojson);
  const features =
    validated.type === 'FeatureCollection'
      ? validated.features
      : validated.type === 'Feature'
        ? [validated]
        : [{ type: 'Feature', properties: {}, geometry: validated }];

  const matched = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (!f?.geometry) continue;
    const props = f.properties || {};
    const shapeIso = String(props.shapeISO || props.iso_3166_2 || props.ISO_3166_2 || '').trim().toUpperCase();
    const shapeName = String(props.shapeName || props.name || props.NAME || '').trim().toLowerCase();
    const stateFp = String(props.STATEFP || props.statefp || '').trim();

    const byProp =
      shapeIso === 'US-AK' ||
      shapeIso.startsWith('US-AK-') ||
      shapeName === 'alaska' ||
      stateFp === '02';

    const bbox = computeCoordsBBox(f.geometry.coordinates);
    if (byProp || isAlaskaBBox(bbox)) {
      matched.push(f);
    }
  }

  if (!matched.length) {
    throw new Error('Could not find Alaska geometry in USA boundary dataset.');
  }

  return attachFeatureBBoxes(
    sanitizeGeoJsonWinding({
      type: 'FeatureCollection',
      features: matched,
    }),
  );
}

export function getCountryCatalog(dataset) {
  const features = dataset?.countries?.features;
  if (!Array.isArray(features)) return [];

  const catalog = [];
  let hasUsa = false;
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const name = typeof f?.properties?.name === 'string' ? f.properties.name.trim() : '';
    if (!name) continue;
    const id = f.id != null ? String(f.id) : '';
    if (id === '840' || name.toLowerCase() === 'united states of america' || name.toLowerCase() === 'united states') {
      hasUsa = true;
    }
    catalog.push({
      id,
      name,
    });
  }

  if (hasUsa && !catalog.some((c) => c.id === ALASKA_ONLY_COUNTRY.id)) {
    catalog.push({ ...ALASKA_ONLY_COUNTRY });
  }

  catalog.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return catalog;
}

export function getAdmin1Catalog(dataset) {
  const features = dataset?.admin1Polygons?.features;
  if (!Array.isArray(features)) return [];

  const catalog = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const props = f?.properties || {};
    const name = String(props.name || '').trim();
    const admin = String(props.admin || '').trim();
    if (!name) continue;
    const id = String(props.adm1_code || props.iso_3166_2 || f.id || name).trim();
    catalog.push({
      id,
      name,
      admin,
      label: admin ? `${name} (${admin})` : name,
    });
  }

  catalog.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
  return catalog;
}

const ISO_N3_TO_ISO3 = {
  '004': 'AFG', '008': 'ALB', '012': 'DZA', '024': 'AGO', '032': 'ARG', '036': 'AUS',
  '040': 'AUT', '031': 'AZE', '050': 'BGD', '112': 'BLR', '056': 'BEL', '068': 'BOL',
  '070': 'BIH', '076': 'BRA', '100': 'BGR', '116': 'KHM', '120': 'CMR', '124': 'CAN',
  '152': 'CHL', '156': 'CHN', '170': 'COL', '180': 'COD', '188': 'CRI', '191': 'HRV',
  '192': 'CUB', '196': 'CYP', '203': 'CZE', '208': 'DNK', '214': 'DOM', '218': 'ECU',
  '818': 'EGY', '233': 'EST', '231': 'ETH', '246': 'FIN', '250': 'FRA', '268': 'GEO',
  '276': 'DEU', '288': 'GHA', '300': 'GRC', '304': 'GRL', '320': 'GTM', '348': 'HUN',
  '352': 'ISL', '356': 'IND', '360': 'IDN', '364': 'IRN', '368': 'IRQ', '372': 'IRL',
  '376': 'ISR', '380': 'ITA', '392': 'JPN', '400': 'JOR', '398': 'KAZ', '404': 'KEN',
  '408': 'PRK', '410': 'KOR', '414': 'KWT', '417': 'KGZ', '418': 'LAO', '428': 'LVA',
  '422': 'LBN', '434': 'LBY', '440': 'LTU', '458': 'MYS', '484': 'MEX', '498': 'MDA',
  '496': 'MNG', '504': 'MAR', '508': 'MOZ', '104': 'MMR', '524': 'NPL', '528': 'NLD',
  '554': 'NZL', '566': 'NGA', '578': 'NOR', '512': 'OMN', '586': 'PAK', '275': 'PSE',
  '591': 'PAN', '598': 'PNG', '600': 'PRY', '604': 'PER', '608': 'PHL', '616': 'POL',
  '620': 'PRT', '634': 'QAT', '642': 'ROU', '643': 'RUS', '682': 'SAU', '686': 'SEN',
  '688': 'SRB', '702': 'SGP', '703': 'SVK', '705': 'SVN', '706': 'SOM', '710': 'ZAF',
  '724': 'ESP', '144': 'LKA', '729': 'SDN', '752': 'SWE', '756': 'CHE', '760': 'SYR',
  '158': 'TWN', '762': 'TJK', '834': 'TZA', '764': 'THA', '788': 'TUN', '792': 'TUR',
  '795': 'TKM', '800': 'UGA', '804': 'UKR', '784': 'ARE', '826': 'GBR', '840': 'USA',
  '858': 'URY', '860': 'UZB', '862': 'VEN', '704': 'VNM', '887': 'YEM', '894': 'ZMB',
  '716': 'ZWE',
};

export function resolveIso3FromNumericId(id) {
  if (isAlaskaOnlySelection(id)) {
    return 'US-AK';
  }
  const key = String(id || '').trim().padStart(3, '0');
  return ISO_N3_TO_ISO3[key] || null;
}

/**
 * Fetch OSM-derived ultra-granular ADM0/ADM1/ADM2 boundaries from geoBoundaries.org.
 * Uses simplified GeoJSON by default for fast browser rendering, or full vertices when requested.
 * Also supports 'US-AK' (Alaska Only) by filtering USA ADM1 (for ADM0/ADM1) or USA ADM2 (boroughs).
 */
export async function fetchGeoBoundariesLayer(iso3, admLevel = 'ADM1', { fullVertices = false } = {}) {
  const code = String(iso3 || '').trim().toUpperCase();
  const level = ['ADM0', 'ADM1', 'ADM2'].includes(String(admLevel).toUpperCase())
    ? String(admLevel).toUpperCase()
    : 'ADM1';

  const isAlaskaOnly = code === 'US-AK';
  if (!isAlaskaOnly && !/^[A-Z]{3}$/.test(code)) {
    throw new Error(`Invalid ISO-3 country code: "${iso3}"`);
  }

  const fetchCode = isAlaskaOnly ? 'USA' : code;
  const fetchLevel = isAlaskaOnly ? (level === 'ADM2' ? 'ADM2' : 'ADM1') : level;

  const metaUrl = `https://www.geoboundaries.org/api/current/gbOpen/${fetchCode}/${fetchLevel}/`;
  const meta = await fetchJsonCached(metaUrl);
  const gjUrl = fullVertices
    ? (meta?.gjDownloadURL || meta?.simplifiedGeometryGeoJSON)
    : (meta?.simplifiedGeometryGeoJSON || meta?.gjDownloadURL);

  if (!gjUrl) {
    throw new Error(`geoBoundaries ${level} data is not available for ${isAlaskaOnly ? 'Alaska (Only)' : code}.`);
  }

  const rawData = await fetchJsonCached(gjUrl);
  const processedData = isAlaskaOnly ? filterGeoJsonToAlaska(rawData) : validateGeoJson(rawData);
  return {
    iso3: code,
    admLevel: level,
    boundaryName: isAlaskaOnly ? ALASKA_ONLY_COUNTRY.name : (meta?.boundaryName || code),
    admUnitCount: isAlaskaOnly
      ? (processedData?.features?.length || 1)
      : (Number(meta?.admUnitCount) || 0),
    maxVertices: Number(meta?.maxVertices) || 0,
    source: meta?.boundarySource || 'geoBoundaries / OpenStreetMap',
    url: gjUrl,
    data: processedData,
  };
}

function lonInBounds(lon, minLon, maxLon) {
  if (maxLon - minLon >= 360) return true;
  if (minLon > maxLon) {
    return lon >= minLon || lon <= maxLon;
  }
  return (
    (lon >= minLon && lon <= maxLon) ||
    (lon - 360 >= minLon && lon - 360 <= maxLon) ||
    (lon + 360 >= minLon && lon + 360 <= maxLon)
  );
}

export function getCitiesInBounds(dataset, bounds) {
  const features = dataset?.populatedPlaces?.features;
  if (!Array.isArray(features) || !bounds) return [];

  let minLon;
  let maxLon;
  let minLat;
  let maxLat;
  if (Array.isArray(bounds) && bounds.length >= 4) {
    [minLon, maxLon, minLat, maxLat] = bounds.map(Number);
  } else if (typeof bounds === 'object') {
    minLon = Number(bounds.minLon);
    maxLon = Number(bounds.maxLon);
    minLat = Number(bounds.minLat);
    maxLat = Number(bounds.maxLat);
  }
  if (![minLon, maxLon, minLat, maxLat].every(Number.isFinite)) {
    return [];
  }

  const results = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const coords = f?.geometry?.coordinates;
    if (f?.geometry?.type !== 'Point' || !Array.isArray(coords) || coords.length < 2) {
      continue;
    }
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lat < minLat || lat > maxLat) continue;
    if (!lonInBounds(lon, minLon, maxLon)) continue;

    const props = f.properties || {};
    const name = String(props.name || props.nameascii || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) continue;

    const scalerank = Number.isFinite(Number(props.scalerank)) ? Number(props.scalerank) : 10;
    const natscale = Number.isFinite(Number(props.natscale)) ? Number(props.natscale) : 0;
    const popMax = Number.isFinite(Number(props.pop_max)) ? Number(props.pop_max) : 0;
    const featurecla = String(props.featurecla || '');
    const isCapital =
      Number(props.adm0cap) === 1 || featurecla.toLowerCase().includes('admin-0 capital');

    results.push({
      name,
      lat,
      lon,
      scalerank,
      natscale,
      popMax,
      isCapital,
      style: isCapital ? 'capital' : 'dot',
      country: String(props.adm0name || props.sov0name || ''),
      featurecla,
    });
  }

  results.sort(
    (a, b) => a.scalerank - b.scalerank || b.natscale - a.natscale || b.popMax - a.popMax,
  );
  return results;
}

export function getMarineLabelsInBounds(dataset, bounds) {
  const features = dataset?.marinePolys?.features;
  if (!Array.isArray(features) || !bounds) return [];

  let minLon;
  let maxLon;
  let minLat;
  let maxLat;
  if (Array.isArray(bounds) && bounds.length >= 4) {
    [minLon, maxLon, minLat, maxLat] = bounds.map(Number);
  } else if (typeof bounds === 'object') {
    minLon = Number(bounds.minLon);
    maxLon = Number(bounds.maxLon);
    minLat = Number(bounds.minLat);
    maxLat = Number(bounds.maxLat);
  }
  if (![minLon, maxLon, minLat, maxLat].every(Number.isFinite)) {
    return [];
  }

  const results = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const props = f?.properties || {};
    const name = String(props.name || props.name_en || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) continue;

    if (!f._centroid) {
      const c = geoCentroid(f);
      f._centroid = Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? c : null;
    }
    if (!f._centroid) continue;
    const [lon, lat] = f._centroid;
    if (lat < minLat || lat > maxLat) continue;
    if (!lonInBounds(lon, minLon, maxLon)) continue;

    const scalerank = Number.isFinite(Number(props.scalerank)) ? Number(props.scalerank) : 6;
    results.push({
      name,
      lat,
      lon,
      scalerank,
      featurecla: String(props.featurecla || ''),
    });
  }

  results.sort((a, b) => a.scalerank - b.scalerank || a.name.localeCompare(b.name));
  return results;
}

function isValidGeoJsonGeometry(geom) {
  if (!geom || typeof geom !== 'object' || !VALID_GEOJSON_TYPES.has(geom.type)) {
    return false;
  }
  if (geom.type === 'GeometryCollection') {
    return Array.isArray(geom.geometries) && geom.geometries.every(isValidGeoJsonGeometry);
  }
  return Array.isArray(geom.coordinates);
}

export function validateGeoJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('GeoJSON payload must be a JSON object.');
  }
  if (!VALID_GEOJSON_TYPES.has(data.type)) {
    throw new Error(`Unsupported GeoJSON type: "${String(data.type || 'missing')}".`);
  }
  if (data.type === 'FeatureCollection') {
    if (!Array.isArray(data.features)) {
      throw new Error('GeoJSON FeatureCollection must contain a "features" array.');
    }
    for (let i = 0; i < data.features.length; i += 1) {
      const f = data.features[i];
      if (!f || f.type !== 'Feature' || (f.geometry !== null && !isValidGeoJsonGeometry(f.geometry))) {
        throw new Error(`Invalid Feature at index ${i} in GeoJSON FeatureCollection.`);
      }
    }
    return sanitizeGeoJsonWinding(data);
  }
  if (data.type === 'Feature') {
    if (data.geometry !== null && !isValidGeoJsonGeometry(data.geometry)) {
      throw new Error('Invalid geometry in GeoJSON Feature.');
    }
    return sanitizeGeoJsonWinding(data);
  }
  if (!isValidGeoJsonGeometry(data)) {
    throw new Error(`Invalid GeoJSON ${data.type} geometry.`);
  }
  return sanitizeGeoJsonWinding(data);
}

function buildOsmCacheRequestUrl(osmUrl) {
  return `https://cache.dusty-map-studio.local/osm-coastline/${encodeURIComponent(osmUrl)}`;
}

async function fetchOverpassJson(query, { timeoutMs = 28000, onStatus = null } = {}) {
  let lastError = null;
  const body = `data=${encodeURIComponent(query)}`;

  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i += 1) {
    const endpoint = OVERPASS_ENDPOINTS[i];
    const host = endpoint.replace(/^https?:\/\//, '').split('/')[0];
    if (typeof onStatus === 'function') {
      onStatus(
        i === 0
          ? `Downloading OpenStreetMap HD coastlines (${host})...`
          : `Primary server busy — trying mirror (${host})...`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        lastError = new Error(`Overpass (${host}) returned HTTP ${res.status}`);
        // Retry next mirror on rate limit / timeout / gateway errors
        if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
          continue;
        }
        continue;
      }

      const payload = await res.json();
      if (!payload || !Array.isArray(payload.elements)) {
        lastError = new Error(`Overpass (${host}) returned an unexpected payload.`);
        continue;
      }
      return { payload, endpoint: host };
    } catch (err) {
      lastError =
        err?.name === 'AbortError'
          ? new Error(`Overpass (${host}) timed out after ${Math.round(timeoutMs / 1000)}s`)
          : err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `OpenStreetMap Overpass request failed across all mirrors (${lastError?.message || 'network error'}). Try zooming in slightly or retrying in a few seconds.`,
  );
}

/**
 * Load a static site-cached hyper-accurate OSM HD coastline pack from `./data/hd_coastlines/`
 * with instant memory caching and optional local simplification.
 */
export async function fetchCachedCoastlinePack(
  packOrId,
  { simplifyMeters = 0, onStatus = null } = {},
) {
  const pack = typeof packOrId === 'string' ? getCachedCoastlinePackById(packOrId) : packOrId;
  if (!pack || !pack.url) {
    throw new Error(`Unknown cached HD coastline pack: "${packOrId}"`);
  }

  const simp = Math.max(0, Math.round(Number(simplifyMeters) || 0));
  const cacheKey = `cached_hd_pack::${pack.id}::s=${simp}`;
  if (jsonMemoryCache.has(cacheKey)) {
    return jsonMemoryCache.get(cacheKey);
  }

  if (typeof onStatus === 'function') {
    onStatus(`Loading cached HD coastlines (${pack.name})...`);
  }

  const rawKey = `cached_hd_pack_raw::${pack.id}`;
  let rawGeoJson = jsonMemoryCache.get(rawKey);
  if (!rawGeoJson) {
    const res = await fetch(pack.url);
    if (!res.ok) {
      throw new Error(`Failed to load cached HD coastline pack (${res.status} ${res.statusText})`);
    }
    rawGeoJson = await res.json();
    jsonMemoryCache.set(rawKey, rawGeoJson);
  }

  const { geojson, stats } = simplifyGeoJsonCoastline(rawGeoJson, simp);
  const sanitized = attachFeatureBBoxes(sanitizeGeoJsonWinding(geojson));
  const result = {
    url: pack.url,
    data: sanitized,
    pack,
    stats: {
      ...stats,
      simplifyMeters: simp,
      endpoint: 'site-cache',
      cachedPackId: pack.id,
      cachedPackName: pack.name,
    },
  };

  jsonMemoryCache.set(cacheKey, result);
  return result;
}

/**
 * Fetch meter-accurate OpenStreetMap coastlines & islands for a padded bounding box
 * via site-cached static packs (when covered) or the Overpass API, polygonize them
 * into closed land Polygons, and cache the result.
 */
export async function fetchOsmCoastlineForBounds(
  bboxInput,
  { simplifyMeters = 0, onStatus = null, forceRefresh = false, visibleBounds = null } = {},
) {
  const bbox =
    bboxInput &&
    Number.isFinite(Number(bboxInput.south)) &&
    Number.isFinite(Number(bboxInput.west)) &&
    Number.isFinite(Number(bboxInput.north)) &&
    Number.isFinite(Number(bboxInput.east))
      ? {
          south: Number(bboxInput.south),
          west: Number(bboxInput.west),
          north: Number(bboxInput.north),
          east: Number(bboxInput.east),
          crossesAntimeridian: Number(bboxInput.west) > Number(bboxInput.east),
          tooWide: Boolean(bboxInput.tooWide),
        }
      : computePaddedCoastlineBBox(bboxInput);

  const simp = Math.max(0, Math.round(Number(simplifyMeters) || 0));

  // Instant site-cache hit for bundled hyper-accurate island packs (e.g. Attu, Corregidor, Luzon, Leyte)
  const matchedPack =
    findMatchingCachedCoastlinePack(visibleBounds) || findMatchingCachedCoastlinePack(bbox);
  if (matchedPack) {
    return fetchCachedCoastlinePack(matchedPack, { simplifyMeters: simp, onStatus });
  }

  if (bbox.tooWide) {
    throw new Error('Framed area is too wide for live OSM coastline download. Zoom in to 3° or less.');
  }

  const osmUrl = encodeOsmCoastlineUrl(bbox, { simplifyMeters: simp });
  const cacheKey = `osm_coastline::${osmUrl}`;
  const cacheReqUrl = buildOsmCacheRequestUrl(osmUrl);

  if (!forceRefresh) {
    if (jsonMemoryCache.has(cacheKey)) {
      return jsonMemoryCache.get(cacheKey);
    }
    const cached = await readCacheStorage(cacheReqUrl);
    if (cached && cached.data && cached.stats) {
      const hydrated = {
        ...cached,
        data: attachFeatureBBoxes(sanitizeGeoJsonWinding(cached.data)),
      };
      jsonMemoryCache.set(cacheKey, hydrated);
      return hydrated;
    }
  }

  const query = buildOverpassCoastlineQuery(bbox, { timeoutSec: 28 });
  const { payload, endpoint } = await fetchOverpassJson(query, { timeoutMs: 30000, onStatus });

  if (typeof onStatus === 'function') {
    onStatus('Stitching & closing HD shoreline polygons...');
  }

  const { geojson, stats } = polygonizeOverpassCoastlines(payload, bbox, { simplifyMeters: simp });
  if (!geojson.features.length) {
    throw new Error(
      'No OpenStreetMap coastlines were found in this view. Try zooming out slightly to include a shoreline.',
    );
  }

  const sanitized = attachFeatureBBoxes(sanitizeGeoJsonWinding(geojson));
  const result = {
    url: osmUrl,
    data: sanitized,
    stats: {
      ...stats,
      simplifyMeters: simp,
      endpoint,
    },
  };

  jsonMemoryCache.set(cacheKey, result);
  try {
    if (typeof Response !== 'undefined') {
      await writeCacheStorage(
        cacheReqUrl,
        new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
  } catch {
    // Non-fatal cache write failure
  }

  return result;
}

export async function fetchOsmCoastlineByUrl(osmUrl, { onStatus = null, forceRefresh = false } = {}) {
  const parsed = parseOsmCoastlineUrl(osmUrl);
  if (!parsed) {
    throw new Error(`Invalid OSM coastline URL: "${osmUrl}"`);
  }
  return fetchOsmCoastlineForBounds(parsed, {
    simplifyMeters: parsed.simplifyMeters,
    onStatus,
    forceRefresh,
  });
}

export async function fetchCustomGeoJson(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('GeoJSON URL is required.');
  }
  const trimmed = url.trim();
  if (/^javascript:/i.test(trimmed)) {
    throw new Error('Unsupported URL scheme.');
  }
  if (isOsmCoastlineUrl(trimmed)) {
    const res = await fetchOsmCoastlineByUrl(trimmed);
    return res.data;
  }

  const cacheKey = `custom_geojson::${trimmed}`;
  if (jsonMemoryCache.has(cacheKey)) {
    return jsonMemoryCache.get(cacheKey);
  }

  const res = await fetch(trimmed);
  if (!res.ok) {
    throw new Error(`Failed to fetch GeoJSON (${res.status} ${res.statusText})`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Remote response is not valid JSON.');
  }
  const validated = validateGeoJson(data);
  jsonMemoryCache.set(cacheKey, validated);
  return validated;
}
