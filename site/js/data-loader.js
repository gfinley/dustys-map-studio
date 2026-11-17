/**
 * Natural Earth & World Atlas CDN dataset loader with in-memory + CacheStorage caching,
 * river lake-centerline filtering, country catalog indexing, and anti-meridian city queries.
 */

import * as topojson from 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';

const CACHE_NAME = 'dusty-mapmaker-v1';
const VALID_RESOLUTIONS = new Set(['110m', '50m', '10m']);

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

function buildUrls(res) {
  const riverRes = res === '110m' ? '50m' : res;
  return {
    world: `https://cdn.jsdelivr.net/npm/world-atlas@2/countries-${res}.json`,
    lakes: `https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_${res}_lakes.geojson`,
    rivers: `https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_${riverRes}_rivers_lake_centerlines.geojson`,
    admin1: 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_admin_1_states_provinces_lines.geojson',
    places: 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_50m_populated_places_simple.geojson',
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
  if (worldAtlasCache.has(res)) {
    return worldAtlasCache.get(res);
  }

  const { world } = buildUrls(res);
  const topo = await fetchJsonCached(world);
  const countriesObj = topo?.objects?.countries;
  if (!countriesObj) {
    throw new Error(`Invalid world-atlas TopoJSON (missing objects.countries) for ${res}`);
  }

  const land = topo.objects.land
    ? topojson.feature(topo, topo.objects.land)
    : topojson.merge(topo, countriesObj.geometries);
  const countries = topojson.feature(topo, countriesObj);
  const internalBorders = topojson.mesh(topo, countriesObj, (a, b) => a !== b);

  const parsed = { land, countries, internalBorders };
  worldAtlasCache.set(res, parsed);
  return parsed;
}

async function loadFilteredRivers(res) {
  const riverRes = res === '110m' ? '50m' : res;
  if (filteredRiversCache.has(riverRes)) {
    return filteredRiversCache.get(riverRes);
  }

  const { rivers } = buildUrls(res);
  const raw = await fetchJsonCached(rivers);
  const features = Array.isArray(raw?.features)
    ? raw.features.filter((f) => {
        const cls = String(f?.properties?.featurecla || '').trim().toLowerCase();
        return cls !== 'lake centerline';
      })
    : [];

  const filtered = {
    type: 'FeatureCollection',
    features,
  };
  filteredRiversCache.set(riverRes, filtered);
  return filtered;
}

function emitProgress(onProgress, info) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(info);
  } catch {
    // Do not let UI progress callbacks break dataset loading
  }
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
  if (maxSpan <= 22 && spec?.projection !== 'orthographic') {
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
    needLakes = true,
    needRivers = false,
    needAdmin1 = false,
    needPlaces = false,
    onProgress = null,
  } = {},
) {
  const res = VALID_RESOLUTIONS.has(resolution) ? resolution : '50m';
  const urls = buildUrls(res);

  const tasks = [
    {
      key: 'world',
      label: `Loading ${res} world boundaries`,
      run: () => loadWorldAtlas(res),
    },
  ];

  if (res !== '110m') {
    tasks.push({
      key: 'locator',
      label: 'Loading 110m locator globe',
      run: () => loadWorldAtlas('110m'),
    });
  }
  if (needLakes) {
    tasks.push({
      key: 'lakes',
      label: `Loading ${res} lakes`,
      run: () => fetchJsonCached(urls.lakes),
    });
  }
  if (needRivers) {
    tasks.push({
      key: 'rivers',
      label: `Loading ${res === '110m' ? '50m' : res} rivers`,
      run: () => loadFilteredRivers(res),
    });
  }
  if (needAdmin1) {
    tasks.push({
      key: 'admin1',
      label: 'Loading 50m admin-1 lines',
      run: () => fetchJsonCached(urls.admin1),
    });
  }
  if (needPlaces) {
    tasks.push({
      key: 'places',
      label: 'Loading populated places',
      run: () => fetchJsonCached(urls.places),
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

  return {
    resolution: res,
    land: world.land,
    countries: world.countries,
    internalBorders: world.internalBorders,
    locatorLand: locator.land,
    locatorBorders: locator.internalBorders,
    lakes: results.lakes || null,
    rivers: results.rivers || null,
    admin1: results.admin1 || null,
    populatedPlaces: results.places || null,
  };
}

export function getCountryCatalog(dataset) {
  const features = dataset?.countries?.features;
  if (!Array.isArray(features)) return [];

  const catalog = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const name = typeof f?.properties?.name === 'string' ? f.properties.name.trim() : '';
    if (!name) continue;
    catalog.push({
      id: f.id != null ? String(f.id) : '',
      name,
    });
  }

  catalog.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return catalog;
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
    return data;
  }
  if (data.type === 'Feature') {
    if (data.geometry !== null && !isValidGeoJsonGeometry(data.geometry)) {
      throw new Error('Invalid geometry in GeoJSON Feature.');
    }
    return data;
  }
  if (!isValidGeoJsonGeometry(data)) {
    throw new Error(`Invalid GeoJSON ${data.type} geometry.`);
  }
  return data;
}

export async function fetchCustomGeoJson(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('GeoJSON URL is required.');
  }
  const trimmed = url.trim();
  if (/^javascript:/i.test(trimmed)) {
    throw new Error('Unsupported URL scheme.');
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
  return validateGeoJson(data);
}
