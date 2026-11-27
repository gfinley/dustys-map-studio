/**
 * Exact spherical SO(3) isometry engine for true-size region shadowing and area comparison.
 *
 * Translates any geographic polygon (country or state/province) from its native spherical
 * centroid to a target (lon, lat) with an optional clockwise bearing rotation while
 * preserving exact great-circle distances, angles, and surface area (zero Mercator distortion).
 */

import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { extractAlaskaOnlyFeature, isAlaskaOnlySelection } from './data-loader.js?v=33';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS_KM = 6371.0088;
const EARTH_AREA_KM2_PER_SR = EARTH_RADIUS_KM * EARTH_RADIUS_KM;
const SQ_KM_PER_SQ_MI = 2.589988110336;
const MAX_EDGE_STEP_DEG = 3.5;

const MAX_CACHE_ENTRIES = 120;
const transformedCache = new Map();
const sourceMetaCache = new WeakMap();

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function normalizeLon(lon) {
  let x = (((lon + 180) % 360) + 360) % 360 - 180;
  if (x === -180 && lon > 0) x = 180;
  return x;
}

function lonLatToVec3(lonDeg, latDeg) {
  const lam = lonDeg * DEG2RAD;
  const phi = latDeg * DEG2RAD;
  const cosPhi = Math.cos(phi);
  return [cosPhi * Math.cos(lam), cosPhi * Math.sin(lam), Math.sin(phi)];
}

function vec3ToLonLat(x, y, z) {
  const lat = Math.asin(clamp(z, -1, 1)) * RAD2DEG;
  const lon = Math.atan2(y, x) * RAD2DEG;
  return [normalizeLon(lon), lat];
}

function mulMat3(A, B) {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] =
        A[r * 3 + 0] * B[0 * 3 + c] +
        A[r * 3 + 1] * B[1 * 3 + c] +
        A[r * 3 + 2] * B[2 * 3 + c];
    }
  }
  return out;
}

/**
 * Build a 3x3 SO(3) rotation matrix mapping (srcLon, srcLat) -> (dstLon, dstLat)
 * while aligning local North -> local North + clockwise rotationDeg.
 */
export function buildSphericalRotationMatrix(srcLon, srcLat, dstLon, dstLat, rotationDeg = 0) {
  const lam0 = srcLon * DEG2RAD;
  const phi0 = srcLat * DEG2RAD;
  const lam1 = dstLon * DEG2RAD;
  const phi1 = dstLat * DEG2RAD;
  const theta = rotationDeg * DEG2RAD;

  // 1. Rotate Z by -lam0: brings srcLon to prime meridian
  const c0 = Math.cos(-lam0);
  const s0 = Math.sin(-lam0);
  const Rz0 = new Float64Array([
    c0, -s0, 0,
    s0, c0, 0,
    0, 0, 1,
  ]);

  // 2. Rotate Y by +phi0: brings (cos phi0, 0, sin phi0) to (1, 0, 0), keeping +Z North
  const cp0 = Math.cos(phi0);
  const sp0 = Math.sin(phi0);
  const Ry0 = new Float64Array([
    cp0, 0, sp0,
    0, 1, 0,
    -sp0, 0, cp0,
  ]);

  // 3. Clockwise bearing rotation around +X (where +Y is East and +Z is North)
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const Rx = new Float64Array([
    1, 0, 0,
    0, ct, st,
    0, -st, ct,
  ]);

  // 4. Rotate Y by -phi1: lifts (1, 0, 0) to (cos phi1, 0, sin phi1)
  const cp1 = Math.cos(phi1);
  const sp1 = Math.sin(phi1);
  const Ry1 = new Float64Array([
    cp1, 0, -sp1,
    0, 1, 0,
    sp1, 0, cp1,
  ]);

  // 5. Rotate Z by +lam1: moves prime meridian to dstLon
  const c1 = Math.cos(lam1);
  const s1 = Math.sin(lam1);
  const Rz1 = new Float64Array([
    c1, -s1, 0,
    s1, c1, 0,
    0, 0, 1,
  ]);

  return mulMat3(Rz1, mulMat3(Ry1, mulMat3(Rx, mulMat3(Ry0, Rz0))));
}

export function rotateLonLat(mat, lonDeg, latDeg) {
  const lam = lonDeg * DEG2RAD;
  const phi = latDeg * DEG2RAD;
  const cosPhi = Math.cos(phi);
  const x = cosPhi * Math.cos(lam);
  const y = cosPhi * Math.sin(lam);
  const z = Math.sin(phi);

  const rx = mat[0] * x + mat[1] * y + mat[2] * z;
  const ry = mat[3] * x + mat[4] * y + mat[5] * z;
  const rz = mat[6] * x + mat[7] * y + mat[8] * z;

  return vec3ToLonLat(rx, ry, rz);
}

/**
 * Extract polygon parts and compute main-landmass spherical centroid & total geodesic area.
 * Parts more than 30° away from the largest polygon (e.g. distant overseas territories)
 * are excluded from the anchor centroid so mainland regions snap intuitively under the cursor.
 */
export function getSourceRegionMeta(feature) {
  if (!feature || !feature.geometry) return null;
  if (sourceMetaCache.has(feature)) {
    return sourceMetaCache.get(feature);
  }

  const geom = feature.geometry;
  let polyList = [];
  if (geom.type === 'Polygon') {
    polyList = [geom.coordinates];
  } else if (geom.type === 'MultiPolygon') {
    polyList = geom.coordinates;
  } else {
    return null;
  }

  const parts = [];
  let totalAreaSr = 0;
  let largest = null;

  for (let i = 0; i < polyList.length; i += 1) {
    const polyCoords = polyList[i];
    if (!Array.isArray(polyCoords) || polyCoords.length === 0) continue;
    const partFeat = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: polyCoords },
    };
    let areaSr = d3.geoArea(partFeat);
    if (!Number.isFinite(areaSr) || areaSr <= 0) continue;
    if (areaSr > 2 * Math.PI) {
      areaSr = 4 * Math.PI - areaSr;
    }
    const centroid = d3.geoCentroid(partFeat);
    if (!centroid || !Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) continue;
    const rec = { coords: polyCoords, areaSr, centroid };
    parts.push(rec);
    totalAreaSr += areaSr;
    if (!largest || areaSr > largest.areaSr) {
      largest = rec;
    }
  }

  if (!largest || totalAreaSr <= 0) return null;

  // Area-weighted 3D centroid of all parts within 30° of the primary landmass
  const maxDistRad = 30 * DEG2RAD;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (d3.geoDistance(p.centroid, largest.centroid) <= maxDistRad) {
      const [vx, vy, vz] = lonLatToVec3(p.centroid[0], p.centroid[1]);
      sx += vx * p.areaSr;
      sy += vy * p.areaSr;
      sz += vz * p.areaSr;
    }
  }
  const norm = Math.hypot(sx, sy, sz);
  const anchorCentroid =
    norm > 1e-12 ? vec3ToLonLat(sx / norm, sy / norm, sz / norm) : largest.centroid;

  const meta = {
    centroid: anchorCentroid,
    areaKm2: totalAreaSr * EARTH_AREA_KM2_PER_SR,
    partCount: parts.length,
  };
  sourceMetaCache.set(feature, meta);
  return meta;
}

export function computeRegionAreaKm2(feature) {
  const meta = getSourceRegionMeta(feature);
  return meta ? meta.areaKm2 : 0;
}

export function formatArea(areaKm2, units = 'km') {
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) return '';
  if (units === 'mi') {
    const sqMi = areaKm2 / SQ_KM_PER_SQ_MI;
    const rounded = sqMi >= 100 ? Math.round(sqMi) : Number(sqMi.toFixed(1));
    return `${rounded.toLocaleString('en-US')} mi²`;
  }
  const rounded = areaKm2 >= 100 ? Math.round(areaKm2) : Number(areaKm2.toFixed(1));
  return `${rounded.toLocaleString('en-US')} km²`;
}

function densifyAndRotateRing(ring, mat) {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  const out = [];
  for (let i = 0; i < ring.length; i += 1) {
    const cur = ring[i];
    if (!Array.isArray(cur) || cur.length < 2) continue;
    const lon1 = cur[0];
    const lat1 = cur[1];
    if (!Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;

    if (i > 0) {
      const prev = ring[i - 1];
      if (Array.isArray(prev) && prev.length >= 2) {
        let dLon = lon1 - prev[0];
        if (dLon > 180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        const dLat = lat1 - prev[1];
        const span = Math.hypot(dLon, dLat);
        if (span > MAX_EDGE_STEP_DEG) {
          const steps = Math.min(24, Math.ceil(span / MAX_EDGE_STEP_DEG));
          for (let s = 1; s < steps; s += 1) {
            const t = s / steps;
            out.push(rotateLonLat(mat, prev[0] + dLon * t, prev[1] + dLat * t));
          }
        }
      }
    }
    out.push(rotateLonLat(mat, lon1, lat1));
  }

  if (out.length >= 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      out.push([first[0], first[1]]);
    }
  }
  return out;
}

function transformPolygonCoords(polyCoords, mat) {
  const nextRings = [];
  for (let r = 0; r < polyCoords.length; r += 1) {
    const rotated = densifyAndRotateRing(polyCoords[r], mat);
    if (rotated.length >= 4) {
      nextRings.push(rotated);
    }
  }
  if (nextRings.length === 0) return null;

  // Ensure D3 spherical CW outer ring winding so filled area is < hemisphere
  const outerFeat = { type: 'Polygon', coordinates: [nextRings[0]] };
  if (d3.geoArea(outerFeat) > 2 * Math.PI) {
    nextRings[0].reverse();
  }
  // Ensure inner hole rings have CCW winding (geoArea > 2*pi for single-ring complement)
  for (let r = 1; r < nextRings.length; r += 1) {
    const holeFeat = { type: 'Polygon', coordinates: [nextRings[r]] };
    if (d3.geoArea(holeFeat) < 2 * Math.PI) {
      nextRings[r].reverse();
    }
  }
  return nextRings;
}

/**
 * Find the source GeoJSON feature for a RegionShadow entry across countries or admin1 polygons.
 */
export function resolveShadowSourceFeature(shadow, datasets) {
  if (!shadow || !datasets) return null;
  const sourceType = shadow.sourceType === 'admin1' ? 'admin1' : 'country';
  const targetId = shadow.sourceId != null && String(shadow.sourceId).trim() !== ''
    ? String(shadow.sourceId).trim().toLowerCase()
    : '';
  const targetName = typeof shadow.sourceName === 'string' && shadow.sourceName.trim() !== ''
    ? shadow.sourceName.trim().toLowerCase()
    : '';

  if (sourceType === 'admin1') {
    const features = datasets.admin1Polygons?.features;
    if (!Array.isArray(features)) return null;
    for (let i = 0; i < features.length; i += 1) {
      const f = features[i];
      const props = f?.properties || {};
      const fId = String(props.adm1_code || props.iso_3166_2 || f.id || '').trim().toLowerCase();
      const fName = String(props.name || '').trim().toLowerCase();
      const fullLabel = props.admin ? `${fName} (${String(props.admin).trim().toLowerCase()})` : fName;
      if ((targetId && fId === targetId) || (targetName && (fName === targetName || fullLabel === targetName))) {
        return f;
      }
    }
    return null;
  }

  if (isAlaskaOnlySelection(shadow.sourceId, shadow.sourceName)) {
    return extractAlaskaOnlyFeature(datasets.countries);
  }

  const features = datasets.countries?.features;
  if (!Array.isArray(features)) return null;
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const fId = f?.id != null ? String(f.id).trim().toLowerCase() : '';
    const fName = typeof f?.properties?.name === 'string' ? f.properties.name.trim().toLowerCase() : '';
    if ((targetId && fId === targetId) || (targetName && fName === targetName)) {
      return f;
    }
  }
  return null;
}

/**
 * Transform a source GeoJSON feature onto (targetLon, targetLat) with exact true-size
 * spherical rotation. Results are LRU-cached for 60fps interaction.
 */
export function buildTransformedShadow(shadow, datasets) {
  const sourceFeature = resolveShadowSourceFeature(shadow, datasets);
  if (!sourceFeature) return null;

  const meta = getSourceRegionMeta(sourceFeature);
  if (!meta) return null;

  const targetLon = Number(shadow.targetLon) || 0;
  const targetLat = clamp(Number(shadow.targetLat) || 0, -85, 85);
  const rotDeg = Number(shadow.rotationDeg) || 0;
  const resTag = datasets?.resolution || '50m';

  const cacheKey = `${resTag}|${shadow.sourceType}|${shadow.sourceId}|${shadow.sourceName}|${targetLon.toFixed(3)}|${targetLat.toFixed(3)}|${rotDeg.toFixed(1)}`;
  if (transformedCache.has(cacheKey)) {
    const cached = transformedCache.get(cacheKey);
    transformedCache.delete(cacheKey);
    transformedCache.set(cacheKey, cached);
    return cached;
  }

  const mat = buildSphericalRotationMatrix(
    meta.centroid[0],
    meta.centroid[1],
    targetLon,
    targetLat,
    rotDeg,
  );

  const geom = sourceFeature.geometry;
  let transformedGeom = null;

  if (geom.type === 'Polygon') {
    const poly = transformPolygonCoords(geom.coordinates, mat);
    if (poly) {
      transformedGeom = { type: 'Polygon', coordinates: poly };
    }
  } else if (geom.type === 'MultiPolygon') {
    const polys = [];
    for (let i = 0; i < geom.coordinates.length; i += 1) {
      const poly = transformPolygonCoords(geom.coordinates[i], mat);
      if (poly) polys.push(poly);
    }
    if (polys.length > 0) {
      transformedGeom = { type: 'MultiPolygon', coordinates: polys };
    }
  }

  if (!transformedGeom) return null;

  const transformedFeature = {
    type: 'Feature',
    properties: {
      shadowId: shadow.id,
      sourceName: shadow.sourceName,
      areaKm2: meta.areaKm2,
    },
    geometry: transformedGeom,
  };

  const result = {
    shadow,
    feature: transformedFeature,
    anchorLonLat: [targetLon, targetLat],
    sourceCentroid: meta.centroid,
    areaKm2: meta.areaKm2,
  };

  if (transformedCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = transformedCache.keys().next().value;
    transformedCache.delete(oldest);
  }
  transformedCache.set(cacheKey, result);
  return result;
}

/**
 * Find the topmost visible shadow containing screen pixel (x, y).
 */
export function hitTestShadow(projection, renderedShadows, x, y) {
  if (!projection || typeof projection.invert !== 'function' || !Array.isArray(renderedShadows)) {
    return null;
  }
  const coords = projection.invert([x, y]);
  if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
  const lonLat = [normalizeLon(coords[0]), coords[1]];

  // Iterate reverse so topmost rendered shadow wins
  for (let i = renderedShadows.length - 1; i >= 0; i -= 1) {
    const entry = renderedShadows[i];
    if (!entry?.feature || entry.shadow?.visible === false) continue;
    if (d3.geoContains(entry.feature, lonLat)) {
      return entry;
    }
  }
  return null;
}

/**
 * Compute size ratio comparison text (e.g. "1.10× larger than France").
 */
export function findUnderlyingCountryAt(datasets, lon, lat) {
  const features = datasets?.countries?.features;
  if (!Array.isArray(features) || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const pt = [normalizeLon(lon), lat];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (!f?.geometry) continue;
    const bbox = f._bbox;
    if (bbox && !bbox[4]) {
      if (lat < bbox[1] - 0.1 || lat > bbox[3] + 0.1) continue;
      const minLon = bbox[0] - 0.1;
      const maxLon = bbox[2] + 0.1;
      const lonMatch =
        (pt[0] >= minLon && pt[0] <= maxLon) ||
        (pt[0] - 360 >= minLon && pt[0] - 360 <= maxLon) ||
        (pt[0] + 360 >= minLon && pt[0] + 360 <= maxLon);
      if (!lonMatch) continue;
    }
    if (d3.geoContains(f, pt)) {
      return {
        id: f.id != null ? String(f.id) : '',
        name: String(f.properties?.name || '').trim(),
        areaKm2: computeRegionAreaKm2(f),
      };
    }
  }
  return null;
}
