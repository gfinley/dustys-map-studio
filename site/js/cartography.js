/**
 * D3 geographic projection engine, Canvas 2D renderer, standalone SVG renderer,
 * and interactive screen-to-lon/lat + country hit-testing utilities.
 */

import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { geoRobinson } from 'https://cdn.jsdelivr.net/npm/d3-geo-projection@4/+esm';
import {
  drawScaleBar,
  drawAltitudeScale,
  drawLocatorGlobe,
  drawNorthArrow,
  drawLegend,
  drawTitleBanner,
  buildOrnamentsSvg,
} from './ornaments.js?v=31';
import { getPixelDimensions, COLOR_THEMES } from './schema.js?v=31';
import { buildTransformedShadow, formatArea } from './shadow.js?v=31';
import {
  extractAlaskaOnlyFeature,
  isAlaskaOnlySelection,
  sanitizeGeoJsonWinding,
} from './data-loader.js?v=31';
import {
  buildProjectedTerrainLayer,
  contourSegmentsToSvgPath,
  resolveContourPalette,
} from './terrain-relief.js?v=31';

const FONT_FAMILY = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MAX_HATCH_CACHE_ENTRIES = 64;
const hatchPatternCache = new Map();
const sanitizedCustomGeoJsonCache = new WeakSet();

function isNoneColor(value) {
  if (typeof value !== 'string') return false;
  const cleaned = value.trim().toLowerCase();
  return cleaned === 'none' || cleaned === 'transparent';
}

function wrapLon(lon) {
  let x = (((lon + 180) % 360) + 360) % 360 - 180;
  if (x === -180 && lon > 0) x = 180;
  return x;
}

function unwrapNear(lon, refLon) {
  let d = lon - refLon;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return refLon + d;
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildBoundingRing(spec) {
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = Number(spec?.center?.lat) || 0;
  const lonDeg = Math.max(0.005, Math.min(360, Number(spec?.span?.lonDeg) || 24));
  const latDeg = Math.max(0.005, Math.min(175, Number(spec?.span?.latDeg) || 14));

  const halfLon = Math.min(179.5, lonDeg / 2);
  const halfLat = latDeg / 2;
  let minLat = Math.max(-85, centerLat - halfLat);
  let maxLat = Math.min(85, centerLat + halfLat);
  if (maxLat - minLat < 0.005) {
    if (centerLat >= 0) {
      minLat = Math.max(-85, maxLat - 0.005);
    } else {
      maxLat = Math.min(85, minLat + 0.005);
    }
  }

  // Sample <= 5 deg along every edge so D3 interpolates along exact parallels/meridians across anti-meridians
  const lonSteps = Math.max(10, Math.ceil((halfLon * 2) / 5));
  const latSteps = Math.max(10, Math.ceil((maxLat - minLat) / 5));
  const coords = [];

  for (let i = 0; i < lonSteps; i += 1) {
    const t = i / lonSteps;
    coords.push([wrapLon(centerLon - halfLon + t * halfLon * 2), minLat]);
  }
  for (let i = 0; i < latSteps; i += 1) {
    const t = i / latSteps;
    coords.push([wrapLon(centerLon + halfLon), minLat + t * (maxLat - minLat)]);
  }
  for (let i = 0; i < lonSteps; i += 1) {
    const t = i / lonSteps;
    coords.push([wrapLon(centerLon + halfLon - t * halfLon * 2), maxLat]);
  }
  for (let i = 0; i <= latSteps; i += 1) {
    const t = i / latSteps;
    coords.push([wrapLon(centerLon - halfLon), maxLat - t * (maxLat - minLat)]);
  }

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: coords,
    },
  };
}

export function buildProjection(spec, width, height, options = {}) {
  const projId = spec?.projection || 'mercator';
  const centerLat = Number(spec?.center?.lat) || 0;
  const centerLon = Number(spec?.center?.lon) || 0;
  const lonDeg = Math.max(0.005, Math.min(360, Number(spec?.span?.lonDeg) || 24));
  const latDeg = Math.max(0.005, Math.min(175, Number(spec?.span?.latDeg) || 14));

  let proj;
  switch (projId) {
    case 'equal_earth':
      proj = d3.geoEqualEarth();
      break;
    case 'orthographic':
      proj = d3.geoOrthographic().clipAngle(90);
      break;
    case 'albers': {
      let p1 = Math.max(-80, centerLat - latDeg * 0.25);
      let p2 = Math.min(80, centerLat + latDeg * 0.25);
      if (p2 - p1 < 0.5) {
        const mid = (p1 + p2) / 2;
        p1 = Math.max(-80, mid - 0.25);
        p2 = Math.min(80, mid + 0.25);
      }
      if (Math.abs(p1 + p2) < 0.05) {
        const half = Math.max(0.25, (p2 - p1) / 2);
        p1 = -half;
        p2 = half;
      }
      proj = d3.geoConicEqualArea().parallels([p1, p2]);
      break;
    }
    case 'azimuthal_equidistant':
      proj = d3.geoAzimuthalEquidistant().clipAngle(179);
      break;
    case 'robinson':
      proj = geoRobinson();
      break;
    case 'mercator':
    default:
      proj = d3.geoMercator();
      break;
  }

  if (projId === 'orthographic' || projId === 'azimuthal_equidistant') {
    proj.rotate([-centerLon, -centerLat]);
  } else {
    proj.rotate([-centerLon, 0]);
  }

  if (projId === 'orthographic') {
    const pad = Math.min(width, height) * 0.04;
    proj.fitExtent([[pad, pad], [width - pad, height - pad]], { type: 'Sphere' });
    const zoom = Math.max(0.8, Math.min(250.0, 120 / Math.max(0.1, lonDeg)));
    proj.scale(proj.scale() * zoom).translate([width / 2, height / 2]);
  } else {
    const boxRing = buildBoundingRing(spec);
    proj.fitSize([width, height], boxRing);
    const pad = Math.max(8, Math.round(Math.max(width, height) * 0.02));
    proj.clipExtent([[-pad, -pad], [width + pad, height + pad]]);
  }

  proj.precision(options.interactive ? 0 : 0.3);
  return proj;
}

function isFrontHemisphere(spec, lon, lat) {
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = Number(spec?.center?.lat) || 0;
  if (spec?.projection === 'orthographic') {
    return d3.geoDistance([lon, lat], [centerLon, centerLat]) <= Math.PI / 2 - 0.005;
  }
  if (spec?.projection === 'azimuthal_equidistant') {
    return d3.geoDistance([lon, lat], [centerLon, centerLat]) <= (179 * Math.PI) / 180;
  }
  return true;
}

export function computeVisibleBounds(spec, projection, width, height) {
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = Number(spec?.center?.lat) || 0;
  const halfLon = (Number(spec?.span?.lonDeg) || 24) / 2;
  const halfLat = (Number(spec?.span?.latDeg) || 14) / 2;

  const fallback = [
    centerLon - halfLon,
    centerLon + halfLon,
    Math.max(-90, centerLat - halfLat),
    Math.min(90, centerLat + halfLat),
  ];

  if (!projection || typeof projection.invert !== 'function') {
    return fallback;
  }

  const samples = [
    [0, 0],
    [width * 0.5, 0],
    [width, 0],
    [width, height * 0.5],
    [width, height],
    [width * 0.5, height],
    [0, height],
    [0, height * 0.5],
    [width * 0.5, height * 0.5],
  ];

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let count = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const pt = projection.invert(samples[i]);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    if (!isFrontHemisphere(spec, pt[0], pt[1])) continue;
    const uLon = unwrapNear(pt[0], centerLon);
    minLon = Math.min(minLon, uLon);
    maxLon = Math.max(maxLon, uLon);
    minLat = Math.min(minLat, pt[1]);
    maxLat = Math.max(maxLat, pt[1]);
    count += 1;
  }

  if (count < 4) {
    return fallback;
  }

  if (spec?.projection === 'orthographic' && (maxLon - minLon >= 170 || count < 8)) {
    return [
      Math.max(centerLon - 90, fallback[0]),
      Math.min(centerLon + 90, fallback[1]),
      Math.max(-90, minLat),
      Math.min(90, maxLat),
    ];
  }

  return [minLon, maxLon, Math.max(-90, minLat), Math.min(90, maxLat)];
}

/**
 * Coarse O(1) longitude/latitude bounding-box view intersection test with anti-meridian wrap checks.
 */
export function bboxMayIntersectView(bbox, viewBounds, skipCull) {
  if (skipCull || !bbox || bbox[4] || !Array.isArray(viewBounds) || viewBounds.length < 4) {
    return true;
  }
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const [viewMinLon, viewMaxLon, viewMinLat, viewMaxLat] = viewBounds;

  if (maxLat < viewMinLat - 2 || minLat > viewMaxLat + 2) {
    return false;
  }

  const lo = viewMinLon - 3;
  const hi = viewMaxLon + 3;
  return (
    (maxLon >= lo && minLon <= hi) ||
    (maxLon - 360 >= lo && minLon - 360 <= hi) ||
    (maxLon + 360 >= lo && minLon + 360 <= hi)
  );
}

function drawCulledCollection(path, items, fallback, viewBounds, skipCull) {
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item && bboxMayIntersectView(item._bbox, viewBounds, skipCull)) {
        path(item);
      }
    }
    return;
  }
  if (fallback) {
    path(fallback);
  }
}

function matchCountryFeatures(countries, hc) {
  const features = countries?.features;
  if (!Array.isArray(features) || !hc) return [];

  if (isAlaskaOnlySelection(hc.id, hc.name)) {
    const alaska = extractAlaskaOnlyFeature(countries);
    return alaska ? [alaska] : [];
  }

  const targetId = hc.id != null && String(hc.id).trim() !== '' ? String(hc.id).trim() : null;
  const targetName =
    typeof hc.name === 'string' && hc.name.trim() !== '' ? hc.name.trim().toLowerCase() : null;

  const matched = [];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    const fId = f?.id != null ? String(f.id).trim() : null;
    const fName =
      typeof f?.properties?.name === 'string' ? f.properties.name.trim().toLowerCase() : null;

    if ((targetId && fId === targetId) || (targetName && fName === targetName)) {
      matched.push(f);
    }
  }
  return matched;
}

/**
 * Find the highlighted country covering or surrounding the current viewBounds
 * (e.g. Philippines when framed on Corregidor Island in Manila Bay).
 */
export function findHostHighlightedCountry(spec, datasets, viewBounds) {
  const highlighted = Array.isArray(spec?.highlightedCountries) ? spec.highlightedCountries : [];
  if (highlighted.length === 0) return null;

  const countries = datasets?.countries;
  const fallbackFill = spec?.colors?.highlightFill || '#7a7d7a';
  const toResult = (hc) => ({
    id: hc.id != null ? String(hc.id) : '',
    name: String(hc.name || '').trim(),
    fill: !isNoneColor(hc.fill) && hc.fill ? hc.fill : fallbackFill,
    stroke: hc.stroke || spec?.colors?.highlightStroke || '#ffffff',
    hatch: hc.hatch || 'none',
  });

  if (!countries || !Array.isArray(viewBounds) || viewBounds.length < 4) {
    return highlighted.length === 1 ? toResult(highlighted[0]) : null;
  }

  const [minLon, maxLon, minLat, maxLat] = viewBounds.map(Number);
  if (![minLon, maxLon, minLat, maxLat].every(Number.isFinite)) {
    return highlighted.length === 1 ? toResult(highlighted[0]) : null;
  }

  const cLon = (minLon + maxLon) / 2;
  const cLat = (minLat + maxLat) / 2;
  const dLon = (maxLon - minLon) * 0.35;
  const dLat = (maxLat - minLat) * 0.35;
  const samples = [
    [wrapLon(cLon), cLat],
    [wrapLon(cLon), Math.min(85, cLat + dLat)],
    [wrapLon(cLon), Math.max(-85, cLat - dLat)],
    [wrapLon(cLon - dLon), cLat],
    [wrapLon(cLon + dLon), cLat],
    [wrapLon(cLon - dLon), Math.min(85, cLat + dLat)],
    [wrapLon(cLon + dLon), Math.min(85, cLat + dLat)],
    [wrapLon(cLon - dLon), Math.max(-85, cLat - dLat)],
    [wrapLon(cLon + dLon), Math.max(-85, cLat - dLat)],
  ];

  const candidates = highlighted.map((hc) => ({
    hc,
    features: matchCountryFeatures(countries, hc),
  }));

  // Pass 1: exact spherical containment on center or surrounding sample points
  for (let s = 0; s < samples.length; s += 1) {
    const pt = samples[s];
    for (let i = 0; i < candidates.length; i += 1) {
      const { hc, features } = candidates[i];
      for (let j = 0; j < features.length; j += 1) {
        if (d3.geoContains(features[j], pt)) {
          return toResult(hc);
        }
      }
    }
  }

  // Pass 2: bounding-box intersection fallback (e.g. tight zoom inside a bay/strait)
  let best = null;
  let bestBBoxArea = Infinity;
  for (let i = 0; i < candidates.length; i += 1) {
    const { hc, features } = candidates[i];
    for (let j = 0; j < features.length; j += 1) {
      const bbox = features[j]?._bbox;
      if (bboxMayIntersectView(bbox, viewBounds, false)) {
        const area =
          Array.isArray(bbox) && bbox.length >= 4 && !bbox[4]
            ? Math.max(0.01, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
            : 1e6;
        if (area < bestBBoxArea) {
          bestBBoxArea = area;
          best = hc;
        }
      }
    }
  }

  return best ? toResult(best) : null;
}

function createCanvasHatchPattern(ctx, hatch, color, scaleFactor) {
  if (!hatch || hatch === 'none' || typeof document === 'undefined') return null;
  const size = Math.max(8, Math.round(12 * scaleFactor));
  const resolvedColor = color || '#111111';
  const cacheKey = `${hatch}|${resolvedColor}|${size}`;
  if (hatchPatternCache.has(cacheKey)) {
    const cached = hatchPatternCache.get(cacheKey);
    hatchPatternCache.delete(cacheKey);
    hatchPatternCache.set(cacheKey, cached);
    return cached;
  }

  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const tctx = tile.getContext('2d');
  if (!tctx) return null;

  tctx.strokeStyle = resolvedColor;
  tctx.fillStyle = resolvedColor;
  tctx.lineWidth = Math.max(0.8, 1.15 * scaleFactor);
  tctx.lineCap = 'square';

  if (hatch === 'diagonal' || hatch === 'cross') {
    tctx.beginPath();
    tctx.moveTo(0, size);
    tctx.lineTo(size, 0);
    tctx.moveTo(-size * 0.5, size * 0.5);
    tctx.lineTo(size * 0.5, -size * 0.5);
    tctx.moveTo(size * 0.5, size * 1.5);
    tctx.lineTo(size * 1.5, size * 0.5);
    tctx.stroke();
  }
  if (hatch === 'backdiagonal' || hatch === 'cross') {
    tctx.beginPath();
    tctx.moveTo(0, 0);
    tctx.lineTo(size, size);
    tctx.moveTo(-size * 0.5, size * 0.5);
    tctx.lineTo(size * 0.5, size * 1.5);
    tctx.moveTo(size * 0.5, -size * 0.5);
    tctx.lineTo(size * 1.5, size * 0.5);
    tctx.stroke();
  }
  if (hatch === 'dots') {
    const r = Math.max(0.9, 1.3 * scaleFactor);
    tctx.beginPath();
    tctx.arc(size * 0.25, size * 0.25, r, 0, Math.PI * 2);
    tctx.arc(size * 0.75, size * 0.75, r, 0, Math.PI * 2);
    tctx.fill();
  }

  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) {
    if (hatchPatternCache.size >= MAX_HATCH_CACHE_ENTRIES) {
      const oldestKey = hatchPatternCache.keys().next().value;
      hatchPatternCache.delete(oldestKey);
    }
    hatchPatternCache.set(cacheKey, pattern);
  }
  return pattern;
}

function collectGeoJsonFeatures(data) {
  if (!data || typeof data !== 'object') return [];
  if (!sanitizedCustomGeoJsonCache.has(data)) {
    sanitizeGeoJsonWinding(data);
    sanitizedCustomGeoJsonCache.add(data);
  }
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
    return data.features.filter((f) => f && f.geometry);
  }
  if (data.type === 'Feature') {
    return data.geometry ? [data] : [];
  }
  return [{ type: 'Feature', properties: {}, geometry: data }];
}

function classifyGeometry(geom, out) {
  if (!geom) return;
  if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    for (let i = 0; i < geom.geometries.length; i += 1) {
      classifyGeometry(geom.geometries[i], out);
    }
    return;
  }
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    out.polygons.push(geom);
  } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
    out.lines.push(geom);
  } else if (geom.type === 'Point' || geom.type === 'MultiPoint') {
    out.points.push(geom);
  }
}

function drawCustomLayersCanvas(ctx, projection, spec, scaleFactor, roleFilter = null) {
  const overlays = Array.isArray(spec?.customGeoJsonLayers) ? spec.customGeoJsonLayers : [];
  if (overlays.length === 0) return;

  const path = d3.geoPath(projection, ctx);

  for (let i = 0; i < overlays.length; i += 1) {
    const layer = overlays[i];
    if (layer?.visible === false || !layer?.data) continue;
    const layerRole = layer.role === 'land' ? 'land' : 'overlay';
    if (roleFilter && layerRole !== roleFilter) continue;

    const features = collectGeoJsonFeatures(layer.data);
    const color = layer.color || '#222222';
    const rawStroke = typeof layer.strokeColor === 'string' && layer.strokeColor ? layer.strokeColor : color;
    const strokeWidthNum = Number.isFinite(Number(layer.strokeWidth)) ? Number(layer.strokeWidth) : 1.5;
    const hasStroke = rawStroke !== 'none' && strokeWidthNum > 0;
    const fillOpacity = Number.isFinite(Number(layer.fillOpacity)) ? Number(layer.fillOpacity) : 0.45;
    const strokeWidth = hasStroke ? Math.max(0.25, strokeWidthNum * scaleFactor) : 0;
    const dashed = Boolean(layer.dashed);
    const hatch = layer.hatch || 'none';
    const hatchColor = hasStroke ? rawStroke : color;
    const pointRadius = Math.max(1.5, Math.max(0.4, strokeWidthNum) * 2.5) * scaleFactor;
    const pointPath = d3.geoPath(projection, ctx).pointRadius(pointRadius);

    const groups = { polygons: [], lines: [], points: [] };
    for (let j = 0; j < features.length; j += 1) {
      classifyGeometry(features[j].geometry, groups);
    }

    if (groups.polygons.length > 0) {
      const fc = {
        type: 'FeatureCollection',
        features: groups.polygons.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
      };
      ctx.save();
      ctx.beginPath();
      path(fc);
      if (fillOpacity > 0) {
        ctx.save();
        ctx.globalAlpha *= fillOpacity;
        ctx.fillStyle = color;
        ctx.fill('evenodd');
        ctx.restore();
      }
      if (hatch !== 'none') {
        const pattern = createCanvasHatchPattern(ctx, hatch, hatchColor, scaleFactor);
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fill('evenodd');
        }
      }
      if (hasStroke) {
        ctx.strokeStyle = rawStroke;
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (dashed) ctx.setLineDash([6 * scaleFactor, 4 * scaleFactor]);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (groups.lines.length > 0 && hasStroke) {
      const fc = {
        type: 'FeatureCollection',
        features: groups.lines.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
      };
      ctx.save();
      ctx.beginPath();
      path(fc);
      ctx.strokeStyle = rawStroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (dashed) ctx.setLineDash([6 * scaleFactor, 4 * scaleFactor]);
      ctx.stroke();
      ctx.restore();
    }

    if (groups.points.length > 0) {
      const fc = {
        type: 'FeatureCollection',
        features: groups.points.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
      };
      ctx.save();
      ctx.globalAlpha *= Math.max(0.05, Math.min(1, fillOpacity));
      ctx.beginPath();
      pointPath(fc);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(0.7, Math.min(1.4, strokeWidthNum * 0.85) * scaleFactor);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function appendCustomLayersSvg(mapParts, svgPath, projection, spec, scaleFactor, getHatchPatternId, roleFilter = null) {
  const overlays = Array.isArray(spec?.customGeoJsonLayers) ? spec.customGeoJsonLayers : [];
  for (let i = 0; i < overlays.length; i += 1) {
    const layer = overlays[i];
    if (layer?.visible === false || !layer?.data) continue;
    const layerRole = layer.role === 'land' ? 'land' : 'overlay';
    if (roleFilter && layerRole !== roleFilter) continue;

    const features = collectGeoJsonFeatures(layer.data);
    const color = layer.color || '#222222';
    const rawStroke = typeof layer.strokeColor === 'string' && layer.strokeColor ? layer.strokeColor : color;
    const strokeWidthNum = Number.isFinite(Number(layer.strokeWidth)) ? Number(layer.strokeWidth) : 1.5;
    const hasStroke = rawStroke !== 'none' && strokeWidthNum > 0;
    const fillOpacity = Number.isFinite(Number(layer.fillOpacity)) ? Number(layer.fillOpacity) : 0.45;
    const strokeWidth = hasStroke ? Math.max(0.25, strokeWidthNum * scaleFactor) : 0;
    const dashAttr = hasStroke && layer.dashed
      ? ` stroke-dasharray="${(6 * scaleFactor).toFixed(1)},${(4 * scaleFactor).toFixed(1)}"`
      : '';
    const strokeAttrs = hasStroke
      ? ` stroke="${escapeXml(rawStroke)}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"${dashAttr}`
      : ' stroke="none"';
    const hatchId = getHatchPatternId(layer.hatch || 'none', hasStroke ? rawStroke : color);
    const pointRadius = Math.max(1.5, Math.max(0.4, strokeWidthNum) * 2.5) * scaleFactor;
    const pointSvgPath = d3.geoPath(projection).pointRadius(pointRadius);

    const groups = { polygons: [], lines: [], points: [] };
    for (let j = 0; j < features.length; j += 1) {
      classifyGeometry(features[j].geometry, groups);
    }

    if (groups.polygons.length > 0) {
      const d =
        svgPath({
          type: 'FeatureCollection',
          features: groups.polygons.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
        }) || '';
      if (d) {
        const fillAttrs = fillOpacity > 0
          ? `fill="${escapeXml(color)}" fill-opacity="${fillOpacity}" fill-rule="evenodd"`
          : 'fill="none"';
        mapParts.push(`<path d="${d}" ${fillAttrs}${strokeAttrs} />`);
        if (hatchId) {
          mapParts.push(`<path d="${d}" fill="url(#${escapeXml(hatchId)})" fill-rule="evenodd" />`);
        }
      }
    }

    if (groups.lines.length > 0 && hasStroke) {
      const d =
        svgPath({
          type: 'FeatureCollection',
          features: groups.lines.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
        }) || '';
      if (d) {
        mapParts.push(`<path d="${d}" fill="none"${strokeAttrs} />`);
      }
    }

    if (groups.points.length > 0) {
      const d =
        pointSvgPath({
          type: 'FeatureCollection',
          features: groups.points.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
        }) || '';
      if (d) {
        const ptOpacity = Math.max(0.05, Math.min(1, fillOpacity));
        const ptStroke = Math.max(0.7, Math.min(1.4, strokeWidthNum * 0.85) * scaleFactor);
        mapParts.push(
          `<path d="${d}" fill="${escapeXml(color)}" fill-opacity="${ptOpacity}" stroke="#ffffff" stroke-opacity="${ptOpacity}" stroke-width="${ptStroke.toFixed(2)}" />`,
        );
      }
    }
  }
}

/**
 * Builds the 10 alternating [x, y] vertices of an upright 5-pointed star.
 */
function buildStarVertices(cx, cy, outerR, innerR) {
  const verts = [];
  for (let k = 0; k < 10; k += 1) {
    const angle = -Math.PI / 2 + (k * Math.PI) / 5;
    const r = k % 2 === 0 ? outerR : innerR;
    verts.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return verts;
}

function drawCitiesCanvas(ctx, projection, spec, width, height, scaleFactor) {
  const cities = Array.isArray(spec?.cities) ? spec.cities : [];
  if (cities.length === 0) return;

  const colors = spec?.colors || {};
  if (isNoneColor(colors.text)) return;
  const textColor = colors.text || '#111111';
  const haloColor = colors.textHalo || '#ffffff';
  const globalLabelScale = Math.min(3.5, Math.max(0.4, Number(spec?.layers?.cityLabelScale) || 1.0));
  const globalIconScale = Math.min(3.5, Math.max(0.4, Number(spec?.layers?.cityIconScale) || 1.0));

  for (let i = 0; i < cities.length; i += 1) {
    const city = cities[i];
    const lat = Number(city?.lat);
    const lon = Number(city?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!isFrontHemisphere(spec, lon, lat)) continue;

    const pt = projection([lon, lat]);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const [x, y] = pt;

    const pinScale = Math.min(3.0, Math.max(0.4, Number(city?.scale) || 1.0));
    const iconMult = globalIconScale * pinScale;
    const labelMult = globalLabelScale * pinScale;
    const style = city.style || 'dot';
    const minIconClear = style === 'capital' ? iconMult * 1.12 : iconMult * 0.9;
    const offsetMult =
      style === 'label_only' ? labelMult : Math.max(0.5 * (iconMult + labelMult), minIconClear);
    const cullMargin = 40 * scaleFactor * Math.max(1, iconMult, labelMult);
    if (x < -cullMargin || x > width + cullMargin || y < -cullMargin || y > height + cullMargin) {
      continue;
    }

    ctx.save();

    if (style === 'capital') {
      const outerR = Math.max(3.0, 6.6 * scaleFactor * iconMult);
      const innerR = outerR * 0.42;
      const verts = buildStarVertices(x, y, outerR, innerR);
      ctx.beginPath();
      ctx.moveTo(verts[0][0], verts[0][1]);
      for (let v = 1; v < verts.length; v += 1) {
        ctx.lineTo(verts[v][0], verts[v][1]);
      }
      ctx.closePath();
      if (haloColor && haloColor !== 'none') {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = Math.max(1.2, 2.5 * scaleFactor * Math.sqrt(iconMult));
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.stroke();
      }
      ctx.fillStyle = textColor;
      ctx.fill();
    } else if (style === 'bullseye') {
      const outerR = Math.max(2.0, 5.2 * scaleFactor * iconMult);
      const innerR = Math.max(0.9, 2.4 * scaleFactor * iconMult);
      ctx.beginPath();
      ctx.arc(x, y, outerR, 0, Math.PI * 2);
      ctx.fillStyle = haloColor !== 'none' ? haloColor : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = textColor;
      ctx.lineWidth = Math.max(0.7, 1.4 * scaleFactor * Math.sqrt(iconMult));
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, innerR, 0, Math.PI * 2);
      ctx.fillStyle = textColor;
      ctx.fill();
    } else if (style === 'square') {
      const sz = Math.max(2.2, 5.8 * scaleFactor * iconMult);
      const half = sz / 2;
      if (haloColor && haloColor !== 'none') {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = Math.max(1.0, 2.4 * scaleFactor * Math.sqrt(iconMult));
        ctx.strokeRect(x - half, y - half, sz, sz);
      }
      ctx.fillStyle = textColor;
      ctx.fillRect(x - half, y - half, sz, sz);
    } else if (style === 'dot') {
      const r = Math.max(1.2, 3.2 * scaleFactor * iconMult);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (haloColor && haloColor !== 'none') {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = Math.max(0.9, 2.2 * scaleFactor * Math.sqrt(iconMult));
        ctx.stroke();
      }
      ctx.fillStyle = textColor;
      ctx.fill();
    }

    const label = String(city.name || '').trim();
    if (label) {
      const textScale = Math.max(scaleFactor, (Math.max(width, height * 0.78) / 900));
      const dx = Number.isFinite(Number(city.dx)) ? Number(city.dx) : 6;
      const dy = Number.isFinite(Number(city.dy)) ? Number(city.dy) : -5;
      const lx = x + dx * textScale * offsetMult;
      const ly = y + dy * textScale * offsetMult;
      const isBoldPin = style === 'capital' || style === 'bullseye';
      const fontSize = Math.max(5.5, (isBoldPin ? 14.5 : 12.8) * textScale * labelMult);
      const textHaloW = Math.max(1.5, 3.6 * textScale * Math.pow(labelMult, 0.75));

      ctx.font = `${isBoldPin ? 700 : 600} ${fontSize.toFixed(1)}px ${FONT_FAMILY}`;
      ctx.textAlign = dx < -2 ? 'right' : Math.abs(dx) <= 2 ? 'center' : 'left';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;

      if (haloColor && haloColor !== 'none') {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = textHaloW;
        ctx.strokeText(label, lx, ly);
      }
      ctx.fillStyle = textColor;
      ctx.fillText(label, lx, ly);
    }

    ctx.restore();
  }
}

function collectPrimaryLandPolygonFeatures(spec) {
  const overlays = Array.isArray(spec?.customGeoJsonLayers) ? spec.customGeoJsonLayers : [];
  const polygons = [];
  for (let i = 0; i < overlays.length; i += 1) {
    const layer = overlays[i];
    if (layer?.visible === false || layer?.role !== 'land' || !layer?.data) continue;
    const features = collectGeoJsonFeatures(layer.data);
    const groups = { polygons: [], lines: [], points: [] };
    for (let j = 0; j < features.length; j += 1) {
      classifyGeometry(features[j].geometry, groups);
    }
    for (let j = 0; j < groups.polygons.length; j += 1) {
      polygons.push({ type: 'Feature', properties: {}, geometry: groups.polygons[j] });
    }
  }
  return polygons;
}

function drawContourSegmentList(ctx, segments) {
  if (!Array.isArray(segments) || segments.length < 4) return;
  ctx.beginPath();
  for (let i = 0; i + 3 < segments.length; i += 4) {
    ctx.moveTo(segments[i], segments[i + 1]);
    ctx.lineTo(segments[i + 2], segments[i + 3]);
  }
  ctx.stroke();
}

function drawTerrainReliefCanvas(
  ctx,
  path,
  projection,
  spec,
  datasets,
  viewBounds,
  skipCull,
  width,
  height,
  scaleFactor,
  options = {},
) {
  const tr = spec?.terrainRelief;
  const dem = datasets?.terrainRelief;
  if (!tr?.enabled || !dem) return null;

  const layers = spec?.layers || {};
  const colors = spec?.colors || {};
  const clipMode = tr.clipMode === 'highlighted' ? 'highlighted' : 'land';
  const highlighted = Array.isArray(spec?.highlightedCountries) ? spec.highlightedCountries : [];

  const highlightedFeatures = [];
  if (highlighted.length > 0 && datasets?.countries) {
    for (let i = 0; i < highlighted.length; i += 1) {
      const feats = matchCountryFeatures(datasets.countries, highlighted[i]);
      for (let j = 0; j < feats.length; j += 1) {
        if (bboxMayIntersectView(feats[j]._bbox, viewBounds, skipCull)) {
          highlightedFeatures.push(feats[j]);
        }
      }
    }
  }

  if (clipMode === 'highlighted' && highlightedFeatures.length === 0) {
    return {
      skippedReason: highlighted.length === 0 ? 'no_highlighted_countries' : 'highlighted_out_of_view',
    };
  }

  const artifact = buildProjectedTerrainLayer(dem, projection, spec, width, height, {
    interactive: Boolean(options.interactive),
    isFrontPoint: (lon, lat) => isFrontHemisphere(spec, lon, lat),
  });
  if (!artifact) return null;

  const landParts =
    Array.isArray(datasets?.landParts) && datasets.landParts.length > 0 ? datasets.landParts : null;
  const primaryLandPolys = collectPrimaryLandPolygonFeatures(spec);
  const useDefaultLand = layers.showLand !== false && Boolean(landParts || datasets?.land);

  let surfaceColor = colors.land;
  if (clipMode === 'highlighted') {
    surfaceColor = highlighted[0]?.fill || colors.highlightFill || colors.land;
  } else if (!useDefaultLand && primaryLandPolys.length > 0) {
    const firstLandLayer = (spec?.customGeoJsonLayers || []).find(
      (l) => l?.visible !== false && l?.role === 'land',
    );
    surfaceColor = firstLandLayer?.color || colors.land;
  } else if (!useDefaultLand && highlighted.length > 0) {
    surfaceColor = highlighted[0]?.fill || colors.highlightFill || colors.land;
  }

  ctx.save();
  ctx.beginPath();
  let hasClip = false;

  if (clipMode === 'highlighted') {
    for (let i = 0; i < highlightedFeatures.length; i += 1) {
      path(highlightedFeatures[i]);
      hasClip = true;
    }
  } else {
    if (useDefaultLand) {
      drawCulledCollection(path, landParts, datasets?.land, viewBounds, skipCull);
      hasClip = true;
      if (layers.showMinorIslands !== false && datasets?.minorIslands) {
        drawCulledCollection(
          path,
          Array.isArray(datasets.minorIslands.features) ? datasets.minorIslands.features : null,
          datasets.minorIslands,
          viewBounds,
          skipCull,
        );
      }
    }
    if (primaryLandPolys.length > 0) {
      path({ type: 'FeatureCollection', features: primaryLandPolys });
      hasClip = true;
    }
    if (!hasClip && highlightedFeatures.length > 0) {
      for (let i = 0; i < highlightedFeatures.length; i += 1) {
        path(highlightedFeatures[i]);
        hasClip = true;
      }
    }
  }

  if (!hasClip) {
    ctx.restore();
    return null;
  }

  ctx.clip();

  if (artifact.rasterCanvas) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(artifact.rasterCanvas, 0, 0, width, height);
    ctx.restore();
  }

  if (artifact.contours) {
    const palette = resolveContourPalette(surfaceColor, artifact.style, {
      contourColor: artifact.contourColor,
      tone: artifact.tone,
      contrast: artifact.contrast,
    });
    const alphaScale = 0.48 + 0.52 * artifact.intensity;

    if (artifact.contours.intermediateSegments.length >= 4) {
      ctx.save();
      ctx.strokeStyle = palette.intermediateColor;
      ctx.globalAlpha *= palette.intermediateAlpha * alphaScale;
      ctx.lineWidth = Math.max(0.45, 0.72 * scaleFactor);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      drawContourSegmentList(ctx, artifact.contours.intermediateSegments);
      ctx.restore();
    }

    if (artifact.contours.indexSegments.length >= 4) {
      ctx.save();
      ctx.strokeStyle = palette.indexColor;
      ctx.globalAlpha *= palette.indexAlpha * alphaScale;
      ctx.lineWidth = Math.max(0.85, 1.45 * scaleFactor);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      drawContourSegmentList(ctx, artifact.contours.indexSegments);
      ctx.restore();
    }

    if (Array.isArray(artifact.contours.labels) && artifact.contours.labels.length > 0) {
      const textScale = Math.max(scaleFactor, Math.max(width, height * 0.78) / 900);
      const fontSize = Math.max(10.5, 11.8 * textScale);
      const haloW = Math.max(2.6, 3.6 * textScale);
      ctx.save();
      ctx.font = `700 ${fontSize.toFixed(1)}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = haloW;
      ctx.strokeStyle = palette.haloColor;
      ctx.fillStyle = palette.indexColor;

      const labelAlpha = Math.min(0.98, Math.max(0.84, palette.indexAlpha * (0.68 + 0.32 * artifact.intensity)));
      for (let i = 0; i < artifact.contours.labels.length; i += 1) {
        const lbl = artifact.contours.labels[i];
        ctx.save();
        ctx.translate(lbl.x, lbl.y);
        ctx.rotate(lbl.angleRad);
        ctx.globalAlpha = 0.92;
        ctx.strokeText(lbl.text, 0, 0);
        ctx.globalAlpha = labelAlpha;
        ctx.fillText(lbl.text, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  if (Array.isArray(artifact.summits) && artifact.summits.length > 0) {
    const summitPalette = resolveContourPalette(surfaceColor, artifact.style, {
      contourColor: artifact.contourColor,
      tone: artifact.tone,
      contrast: artifact.contrast,
    });
    const textScale = Math.max(scaleFactor, Math.max(width, height * 0.78) / 900);
    const triR = Math.max(3.2, 4.0 * textScale);
    const fontSize = Math.max(10.5, 11.4 * textScale);
    const haloW = Math.max(2.6, 3.6 * textScale);

    ctx.save();
    ctx.font = `800 ${fontSize.toFixed(1)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (let i = 0; i < artifact.summits.length; i += 1) {
      const pk = artifact.summits[i];
      const px = pk.x;
      const py = pk.y;

      // Crisp military summit triangle (▲) with halo
      ctx.beginPath();
      ctx.moveTo(px, py - triR);
      ctx.lineTo(px + triR * 0.92, py + triR * 0.72);
      ctx.lineTo(px - triR * 0.92, py + triR * 0.72);
      ctx.closePath();
      ctx.strokeStyle = summitPalette.haloColor;
      ctx.lineWidth = Math.max(2.0, 2.6 * textScale);
      ctx.globalAlpha = 0.92;
      ctx.stroke();
      ctx.fillStyle = summitPalette.indexColor;
      ctx.globalAlpha = 0.96;
      ctx.fill();

      // Spot elevation text above the summit triangle
      const textY = py - triR - 1.8 * textScale;
      ctx.lineWidth = haloW;
      ctx.strokeStyle = summitPalette.haloColor;
      ctx.globalAlpha = 0.92;
      ctx.strokeText(pk.text, px, textY);
      ctx.fillStyle = summitPalette.indexColor;
      ctx.globalAlpha = 0.96;
      ctx.fillText(pk.text, px, textY);
    }
    ctx.restore();
  }

  ctx.restore();

  // Re-stroke highlighted country outlines cleanly above the relief shading
  if (highlighted.length > 0 && datasets?.countries) {
    for (let i = 0; i < highlighted.length; i += 1) {
      const hc = highlighted[i];
      const stroke = hc.stroke || colors.highlightStroke || '#ffffff';
      if (!stroke || isNoneColor(stroke)) continue;
      const feats = matchCountryFeatures(datasets.countries, hc);
      for (let j = 0; j < feats.length; j += 1) {
        const feat = feats[j];
        if (!bboxMayIntersectView(feat._bbox, viewBounds, skipCull)) continue;
        ctx.save();
        ctx.beginPath();
        path(feat);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.max(0.5, (Number(layers.borderWidth) || 1.0) * 1.15 * scaleFactor);
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  return {
    effectiveInterval: artifact.effectiveInterval,
    maxVisibleElev: artifact.maxVisibleElev,
    style: artifact.style,
    clipMode,
  };
}

function appendTerrainReliefSvg(defs, mapParts, svgPath, projection, spec, datasets, widthPx, heightPx, scaleFactor) {
  const tr = spec?.terrainRelief;
  const dem = datasets?.terrainRelief;
  if (!tr?.enabled || !dem) return;

  const layers = spec?.layers || {};
  const colors = spec?.colors || {};
  const clipMode = tr.clipMode === 'highlighted' ? 'highlighted' : 'land';
  const highlighted = Array.isArray(spec?.highlightedCountries) ? spec.highlightedCountries : [];

  const highlightedFeatures = [];
  if (highlighted.length > 0 && datasets?.countries) {
    for (let i = 0; i < highlighted.length; i += 1) {
      const feats = matchCountryFeatures(datasets.countries, highlighted[i]);
      for (let j = 0; j < feats.length; j += 1) {
        highlightedFeatures.push(feats[j]);
      }
    }
  }
  if (clipMode === 'highlighted' && highlightedFeatures.length === 0) return;

  const artifact = buildProjectedTerrainLayer(dem, projection, spec, widthPx, heightPx, {
    interactive: false,
    isFrontPoint: (lon, lat) => isFrontHemisphere(spec, lon, lat),
  });
  if (!artifact) return;

  const primaryLandPolys = collectPrimaryLandPolygonFeatures(spec);
  const useDefaultLand = layers.showLand !== false && Boolean(datasets?.land);
  const clipPaths = [];

  if (clipMode === 'highlighted') {
    for (let i = 0; i < highlightedFeatures.length; i += 1) {
      const d = svgPath(highlightedFeatures[i]) || '';
      if (d) clipPaths.push(`<path d="${d}" />`);
    }
  } else {
    if (useDefaultLand) {
      const landD = svgPath(datasets.land) || '';
      if (landD) clipPaths.push(`<path d="${landD}" />`);
      if (layers.showMinorIslands !== false && datasets?.minorIslands) {
        const minorD = svgPath(datasets.minorIslands) || '';
        if (minorD) clipPaths.push(`<path d="${minorD}" />`);
      }
    }
    if (primaryLandPolys.length > 0) {
      const pD = svgPath({ type: 'FeatureCollection', features: primaryLandPolys }) || '';
      if (pD) clipPaths.push(`<path d="${pD}" />`);
    }
    if (clipPaths.length === 0 && highlightedFeatures.length > 0) {
      for (let i = 0; i < highlightedFeatures.length; i += 1) {
        const d = svgPath(highlightedFeatures[i]) || '';
        if (d) clipPaths.push(`<path d="${d}" />`);
      }
    }
  }

  if (clipPaths.length === 0) return;

  defs.push(`<clipPath id="terrain-relief-clip">${clipPaths.join('')}</clipPath>`);

  let surfaceColor = colors.land;
  if (clipMode === 'highlighted') {
    surfaceColor = highlighted[0]?.fill || colors.highlightFill || colors.land;
  } else if (!useDefaultLand && highlighted.length > 0) {
    surfaceColor = highlighted[0]?.fill || colors.highlightFill || colors.land;
  }

  mapParts.push('<g clip-path="url(#terrain-relief-clip)">');

  if (artifact.rasterCanvas) {
    try {
      const dataUrl = artifact.rasterCanvas.toDataURL('image/png');
      mapParts.push(
        `<image href="${dataUrl}" x="0" y="0" width="${widthPx}" height="${heightPx}" preserveAspectRatio="none" />`,
      );
    } catch {
      // Ignore if canvas serialization is unavailable
    }
  }

  if (artifact.contours) {
    const palette = resolveContourPalette(surfaceColor, artifact.style, {
      contourColor: artifact.contourColor,
      tone: artifact.tone,
      contrast: artifact.contrast,
    });
    const alphaScale = 0.48 + 0.52 * artifact.intensity;
    const interD = contourSegmentsToSvgPath(artifact.contours.intermediateSegments);
    if (interD) {
      const w = Math.max(0.45, 0.72 * scaleFactor).toFixed(2);
      const op = (palette.intermediateAlpha * alphaScale).toFixed(3);
      mapParts.push(
        `<path d="${interD}" fill="none" stroke="${escapeXml(palette.intermediateColor)}" stroke-opacity="${op}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" />`,
      );
    }
    const idxD = contourSegmentsToSvgPath(artifact.contours.indexSegments);
    if (idxD) {
      const w = Math.max(0.85, 1.45 * scaleFactor).toFixed(2);
      const op = (palette.indexAlpha * alphaScale).toFixed(3);
      mapParts.push(
        `<path d="${idxD}" fill="none" stroke="${escapeXml(palette.indexColor)}" stroke-opacity="${op}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" />`,
      );
    }
    if (Array.isArray(artifact.contours.labels) && artifact.contours.labels.length > 0) {
      const textScale = Math.max(scaleFactor, Math.max(widthPx, heightPx * 0.78) / 900);
      const fontSize = Math.max(10.5, 11.8 * textScale).toFixed(1);
      const haloW = Math.max(2.6, 3.6 * textScale).toFixed(2);
      const labelOp = Math.min(0.98, Math.max(0.84, palette.indexAlpha * (0.68 + 0.32 * artifact.intensity))).toFixed(3);
      for (let i = 0; i < artifact.contours.labels.length; i += 1) {
        const lbl = artifact.contours.labels[i];
        const deg = ((lbl.angleRad * 180) / Math.PI).toFixed(1);
        mapParts.push(
          `<text transform="translate(${lbl.x.toFixed(1)},${lbl.y.toFixed(1)}) rotate(${deg})" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize}" font-weight="700" fill="${escapeXml(palette.indexColor)}" fill-opacity="${labelOp}" stroke="${escapeXml(palette.haloColor)}" stroke-opacity="0.92" stroke-width="${haloW}" stroke-linejoin="round" paint-order="stroke">${escapeXml(lbl.text)}</text>`,
        );
      }
    }
  }

  if (Array.isArray(artifact.summits) && artifact.summits.length > 0) {
    const summitPalette = resolveContourPalette(surfaceColor, artifact.style, {
      contourColor: artifact.contourColor,
      tone: artifact.tone,
      contrast: artifact.contrast,
    });
    const textScale = Math.max(scaleFactor, Math.max(widthPx, heightPx * 0.78) / 900);
    const triR = Math.max(3.2, 4.0 * textScale);
    const fontSize = Math.max(10.5, 11.4 * textScale).toFixed(1);
    const haloW = Math.max(2.6, 3.6 * textScale).toFixed(2);
    const triStrokeW = Math.max(2.0, 2.6 * textScale).toFixed(2);

    for (let i = 0; i < artifact.summits.length; i += 1) {
      const pk = artifact.summits[i];
      const px = pk.x;
      const py = pk.y;
      const ptsStr = `${px.toFixed(1)},${(py - triR).toFixed(1)} ${(px + triR * 0.92).toFixed(1)},${(py + triR * 0.72).toFixed(1)} ${(px - triR * 0.92).toFixed(1)},${(py + triR * 0.72).toFixed(1)}`;
      const textY = (py - triR - 1.8 * textScale).toFixed(1);
      mapParts.push(
        `<polygon points="${ptsStr}" fill="${escapeXml(summitPalette.indexColor)}" fill-opacity="0.96" stroke="${escapeXml(summitPalette.haloColor)}" stroke-opacity="0.92" stroke-width="${triStrokeW}" stroke-linejoin="round" paint-order="stroke" />`,
      );
      mapParts.push(
        `<text x="${px.toFixed(1)}" y="${textY}" text-anchor="middle" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize}" font-weight="800" fill="${escapeXml(summitPalette.indexColor)}" fill-opacity="0.96" stroke="${escapeXml(summitPalette.haloColor)}" stroke-opacity="0.92" stroke-width="${haloW}" stroke-linejoin="round" paint-order="stroke">${escapeXml(pk.text)}</text>`,
      );
    }
  }

  mapParts.push('</g>');

  // Re-stroke highlighted country outlines cleanly above the relief shading
  if (highlighted.length > 0 && datasets?.countries) {
    for (let i = 0; i < highlighted.length; i += 1) {
      const hc = highlighted[i];
      const stroke = hc.stroke || colors.highlightStroke || '#ffffff';
      if (!stroke || isNoneColor(stroke)) continue;
      const feats = matchCountryFeatures(datasets.countries, hc);
      const strokeW = Math.max(0.5, (Number(layers.borderWidth) || 1.0) * 1.15 * scaleFactor).toFixed(2);
      for (let j = 0; j < feats.length; j += 1) {
        const d = svgPath(feats[j]) || '';
        if (d) {
          mapParts.push(`<path d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${strokeW}" stroke-linejoin="round" />`);
        }
      }
    }
  }
}

export function renderMapToCanvas(canvas, spec, datasets, options = {}) {
  const width = options.width || canvas.width;
  const height = options.height || canvas.height;
  const scaleFactor = width / 900;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not acquire 2D canvas context.');
  }

  const colors = spec?.colors || {};
  const layers = spec?.layers || {};
  const themeDef = COLOR_THEMES[spec?.theme] || COLOR_THEMES.dusty_prime;
  const globeBg = colors.globeBg || themeDef?.globeBg || '#111827';
  const basePrecision = options.interactive ? 0 : 0.3;
  const projection = buildProjection(spec, width, height, options);
  const viewBounds = computeVisibleBounds(spec, projection, width, height);
  const skipCull =
    spec?.projection === 'orthographic' ||
    spec?.projection === 'azimuthal_equidistant' ||
    viewBounds[1] - viewBounds[0] >= 170;
  const path = d3.geoPath(projection, ctx);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();

  const waterIsNone = isNoneColor(colors.water);
  const landIsNone = isNoneColor(colors.land);
  const coastIsNone = !colors.coastline || isNoneColor(colors.coastline);
  const hasCoastStroke = Boolean(layers.showCoastlines && !coastIsNone);
  const frameStrokeColor = !isNoneColor(colors.text) ? (colors.text || '#111111') : '#111111';

  // Always clear canvas so transparent water (colors.water === 'none') shows cleanly
  ctx.clearRect(0, 0, width, height);

  // 1. Water / globe background
  if (spec?.projection === 'orthographic') {
    if (!waterIsNone) {
      ctx.fillStyle = globeBg;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.save();
    ctx.beginPath();
    path({ type: 'Sphere' });
    if (!waterIsNone) {
      ctx.fillStyle = colors.water || '#d1cfcf';
      ctx.fill();
    }
    ctx.clip();
  } else if (!waterIsNone) {
    ctx.fillStyle = colors.water || '#d1cfcf';
    ctx.fillRect(0, 0, width, height);
  }

  // 1b. Ocean Bathymetry / Continental Shelf Contours
  if (
    layers.showBathymetry &&
    !isNoneColor(colors.bathymetry) &&
    (datasets?.bathymetry1000 || datasets?.bathymetry200)
  ) {
    const bathyColor = colors.bathymetry || themeDef?.bathymetry || '#bfbdbd';
    projection.precision(0);
    if (datasets.bathymetry1000) {
      ctx.save();
      ctx.beginPath();
      drawCulledCollection(
        path,
        Array.isArray(datasets.bathymetry1000.features) ? datasets.bathymetry1000.features : null,
        datasets.bathymetry1000,
        viewBounds,
        skipCull,
      );
      ctx.globalAlpha *= 0.45;
      ctx.fillStyle = bathyColor;
      ctx.fill();
      ctx.restore();
    }
    if (datasets.bathymetry200) {
      ctx.save();
      ctx.beginPath();
      drawCulledCollection(
        path,
        Array.isArray(datasets.bathymetry200.features) ? datasets.bathymetry200.features : null,
        datasets.bathymetry200,
        viewBounds,
        skipCull,
      );
      ctx.globalAlpha *= 0.45;
      ctx.fillStyle = bathyColor;
      ctx.fill();
      ctx.restore();
    }
  }

  // 2. Graticule
  if (layers.showGraticule) {
    const step = Math.max(1, Math.min(60, Number(layers.graticuleStepDeg) || 10));
    const graticule = d3.geoGraticule().step([step, step])();
    projection.precision(0.5);
    ctx.save();
    ctx.globalAlpha *= 0.4;
    ctx.beginPath();
    path(graticule);
    ctx.strokeStyle = !isNoneColor(colors.admin1) ? (colors.admin1 || '#737373') : '#737373';
    ctx.lineWidth = Math.max(0.4, 0.65 * scaleFactor);
    ctx.stroke();
    ctx.restore();
  }

  // Use zero-resample streaming for dense natural datasets while clipExtent keeps bounds tight
  projection.precision(0);

  // 3. Default Land (+ optional minor islands & coastline)
  const landParts =
    Array.isArray(datasets?.landParts) && datasets.landParts.length > 0 ? datasets.landParts : null;
  if (layers.showLand !== false && (!landIsNone || hasCoastStroke) && (landParts || datasets?.land)) {
    ctx.save();
    ctx.beginPath();
    drawCulledCollection(path, landParts, datasets?.land, viewBounds, skipCull);
    if (!landIsNone) {
      ctx.fillStyle = colors.land || '#4a4a4a';
      ctx.fill('evenodd');
    }
    if (hasCoastStroke) {
      ctx.strokeStyle = colors.coastline;
      ctx.lineWidth = Math.max(0.3, (Number(layers.coastlineWidth) || 0.75) * scaleFactor);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();

    if (layers.showMinorIslands !== false && datasets?.minorIslands) {
      ctx.save();
      ctx.beginPath();
      drawCulledCollection(
        path,
        Array.isArray(datasets.minorIslands.features) ? datasets.minorIslands.features : null,
        datasets.minorIslands,
        viewBounds,
        skipCull,
      );
      if (!landIsNone) {
        ctx.fillStyle = colors.land || '#4a4a4a';
        ctx.fill();
      }
      if (hasCoastStroke) {
        ctx.strokeStyle = colors.coastline;
        ctx.lineWidth = Math.max(0.3, (Number(layers.coastlineWidth) || 0.75) * 0.85 * scaleFactor);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 3a. Primary Land GeoJSON layers (e.g. OSM Ultra-Detail replacing default land)
  if (Array.isArray(spec?.customGeoJsonLayers) && spec.customGeoJsonLayers.some((l) => l?.role === 'land')) {
    projection.precision(basePrecision);
    drawCustomLayersCanvas(ctx, projection, spec, scaleFactor, 'land');
    projection.precision(0);
  }

  // 3b. Urban Areas / Metropolitan Footprints
  if (layers.showUrbanAreas && !isNoneColor(colors.urban) && datasets?.urbanAreas) {
    const urbanColor = colors.urban || themeDef?.urban || '#636363';
    ctx.save();
    ctx.beginPath();
    drawCulledCollection(
      path,
      Array.isArray(datasets.urbanAreas.features) ? datasets.urbanAreas.features : null,
      datasets.urbanAreas,
      viewBounds,
      skipCull,
    );
    ctx.globalAlpha *= 0.72;
    ctx.fillStyle = urbanColor;
    ctx.fill();
    ctx.restore();
  }

  // 4. Highlighted countries
  const highlighted = Array.isArray(spec?.highlightedCountries) ? spec.highlightedCountries : [];
  if (highlighted.length > 0 && datasets?.countries) {
    for (let i = 0; i < highlighted.length; i += 1) {
      const hc = highlighted[i];
      const features = matchCountryFeatures(datasets.countries, hc);
      if (features.length === 0) continue;

      const fill = hc.fill || colors.highlightFill || '#7a7d7a';
      const stroke = hc.stroke || colors.highlightStroke || '#ffffff';
      const hatch = hc.hatch || 'none';
      const pattern = hatch !== 'none' ? createCanvasHatchPattern(ctx, hatch, stroke, scaleFactor) : null;

      for (let j = 0; j < features.length; j += 1) {
        const feat = features[j];
        if (!bboxMayIntersectView(feat._bbox, viewBounds, skipCull)) continue;
        ctx.save();
        ctx.beginPath();
        path(feat);
        if (!isNoneColor(fill)) {
          ctx.fillStyle = fill;
          ctx.fill('evenodd');
        }
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fill('evenodd');
        }
        if (stroke && !isNoneColor(stroke)) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = Math.max(0.5, (Number(layers.borderWidth) || 1.0) * 1.15 * scaleFactor);
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  // 4b. On-Demand Military Terrain Relief (clipped to land or highlighted countries)
  const terrainMeta = drawTerrainReliefCanvas(
    ctx,
    path,
    projection,
    spec,
    datasets,
    viewBounds,
    skipCull,
    width,
    height,
    scaleFactor,
    options,
  );

  // 5. Lakes & Inland Seas
  if (layers.showLakes && (!waterIsNone || hasCoastStroke) && datasets?.lakes) {
    ctx.save();
    ctx.beginPath();
    drawCulledCollection(
      path,
      Array.isArray(datasets.lakes.features) ? datasets.lakes.features : null,
      datasets.lakes,
      viewBounds,
      skipCull,
    );
    if (!waterIsNone) {
      ctx.fillStyle = colors.water || '#d1cfcf';
      ctx.fill('evenodd');
    }
    if (hasCoastStroke) {
      ctx.strokeStyle = colors.coastline;
      ctx.lineWidth = Math.max(0.25, (Number(layers.coastlineWidth) || 0.75) * 0.85 * scaleFactor);
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  // 6. Rivers
  if (layers.showRivers && datasets?.rivers && colors.rivers && !isNoneColor(colors.rivers)) {
    ctx.save();
    ctx.beginPath();
    drawCulledCollection(
      path,
      Array.isArray(datasets.rivers.features) ? datasets.rivers.features : null,
      datasets.rivers,
      viewBounds,
      skipCull,
    );
    ctx.strokeStyle = colors.rivers;
    ctx.lineWidth = Math.max(0.35, (Number(layers.riverWidth) || 0.75) * scaleFactor);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  // 7. Admin-1 lines
  if (layers.showAdmin1 && datasets?.admin1 && colors.admin1 && !isNoneColor(colors.admin1)) {
    const admin1W = Math.max(0.2, (Number(layers.admin1Width) || 0.7) * scaleFactor);
    ctx.save();
    ctx.beginPath();
    drawCulledCollection(
      path,
      Array.isArray(datasets.admin1.features) ? datasets.admin1.features : null,
      datasets.admin1,
      viewBounds,
      skipCull,
    );
    ctx.strokeStyle = colors.admin1;
    ctx.lineWidth = admin1W;
    ctx.setLineDash([Math.max(2, 4 * scaleFactor), Math.max(1.5, 3 * scaleFactor)]);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  // 8. Custom GeoJSON overlays
  if (Array.isArray(spec?.customGeoJsonLayers) && spec.customGeoJsonLayers.length > 0) {
    projection.precision(basePrecision);
    drawCustomLayersCanvas(ctx, projection, spec, scaleFactor, 'overlay');
    projection.precision(0);
  }

  // 9. Internal borders
  const borderParts =
    Array.isArray(datasets?.borderParts) && datasets.borderParts.length > 0
      ? datasets.borderParts
      : null;
  if (
    layers.showBorders &&
    colors.borders &&
    !isNoneColor(colors.borders) &&
    (borderParts || datasets?.internalBorders)
  ) {
    ctx.save();
    ctx.beginPath();
    drawCulledCollection(path, borderParts, datasets?.internalBorders, viewBounds, skipCull);
    ctx.strokeStyle = colors.borders;
    const bw = Math.max(0.3, (Number(layers.borderWidth) || 1.0) * scaleFactor);
    ctx.lineWidth = bw;
    ctx.lineJoin = 'round';
    if (layers.borderStyle === 'dashed') {
      ctx.setLineDash([6 * scaleFactor, 4 * scaleFactor]);
    } else if (layers.borderStyle === 'dotted') {
      ctx.lineCap = 'round';
      ctx.setLineDash([1.2 * scaleFactor, 3.2 * scaleFactor]);
    }
    ctx.stroke();
    ctx.restore();
  }

  projection.precision(basePrecision);

  // 9b. True-Size Region Shadows (geodesic SO(3) size-comparison overlays)
  const renderedShadows = drawRegionShadowsCanvas(ctx, projection, spec, datasets, width, height, scaleFactor);

  // 10. Cities & haloed labels
  drawCitiesCanvas(ctx, projection, spec, width, height, scaleFactor);

  // Restore orthographic Sphere clip and draw crisp globe limb
  if (spec?.projection === 'orthographic') {
    ctx.restore();
    if (!waterIsNone || !coastIsNone) {
      ctx.save();
      ctx.beginPath();
      path({ type: 'Sphere' });
      ctx.strokeStyle = !coastIsNone
        ? colors.coastline
        : (!isNoneColor(colors.text) && colors.text) || 'rgba(0,0,0,0.35)';
      ctx.lineWidth = Math.max(0.75, 1.1 * scaleFactor);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 11. Ornaments
  if (!options.skipOrnaments) {
    drawScaleBar(ctx, spec, projection, width, height, scaleFactor);
    drawAltitudeScale(ctx, spec, datasets, projection, width, height, scaleFactor);
    drawLocatorGlobe(ctx, spec, datasets, width, height, scaleFactor, projection);
    drawNorthArrow(ctx, spec, width, height, scaleFactor);
    drawLegend(ctx, spec, width, height, scaleFactor);
    drawTitleBanner(ctx, spec, width, height, scaleFactor);
  }

  // 12. Page frame border
  if (spec?.page?.showFrameBorder) {
    const fw = Math.max(1, 1.5 * scaleFactor);
    ctx.save();
    ctx.strokeStyle = frameStrokeColor;
    ctx.lineWidth = fw;
    ctx.strokeRect(fw / 2, fw / 2, width - fw, height - fw);
    ctx.restore();
  }

  ctx.restore();

  return {
    projection,
    bounds: viewBounds,
    renderedShadows,
    terrainMeta,
  };
}

function drawRegionShadowsCanvas(ctx, projection, spec, datasets, width, height, scaleFactor) {
  const shadows = Array.isArray(spec?.regionShadows) ? spec.regionShadows : [];
  if (shadows.length === 0) return [];

  const path = d3.geoPath(projection, ctx);
  const units = spec?.ornaments?.scaleBar?.units === 'mi' ? 'mi' : 'km';
  const rendered = [];

  for (let i = 0; i < shadows.length; i += 1) {
    const shadow = shadows[i];
    if (!shadow || shadow.visible === false) continue;

    const built = buildTransformedShadow(shadow, datasets);
    if (!built) continue;
    rendered.push(built);

    const fill = shadow.fill || '#dc2626';
    const stroke = shadow.stroke || '#7f1d1d';
    const opacity = Number.isFinite(Number(shadow.opacity)) ? Number(shadow.opacity) : 0.35;
    const strokeWidth = Math.max(0.6, (Number(shadow.strokeWidth) || 1.6) * scaleFactor);
    const hatch = shadow.hatch || 'none';
    const pattern = hatch !== 'none' ? createCanvasHatchPattern(ctx, hatch, stroke, scaleFactor) : null;

    ctx.save();
    ctx.beginPath();
    path(built.feature);

    // Subtle soft shadow underneath the region silhouette
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.32)';
    ctx.shadowBlur = Math.max(4, 9 * scaleFactor);
    ctx.shadowOffsetX = 2 * scaleFactor;
    ctx.shadowOffsetY = 2.5 * scaleFactor;
    ctx.globalAlpha = Math.max(0.05, Math.min(0.95, opacity));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    if (pattern) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.85, opacity + 0.25);
      ctx.fillStyle = pattern;
      ctx.fill();
      ctx.restore();
    }

    if (stroke && stroke !== 'none') {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (shadow.dashed !== false) {
        ctx.setLineDash([6.5 * scaleFactor, 3.8 * scaleFactor]);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Centered haloed label with optional geodesic area readout
    if (shadow.showLabel !== false && isFrontHemisphere(spec, built.anchorLonLat[0], built.anchorLonLat[1])) {
      const pt = projection(built.anchorLonLat);
      if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
        const [cx, cy] = pt;
        if (cx >= -40 && cx <= width + 40 && cy >= -40 && cy <= height + 40) {
          const textScale = Math.max(scaleFactor, Math.max(width, height * 0.78) / 900);
          const titleSize = Math.max(8, 12.5 * textScale);
          const subSize = Math.max(6.5, 9.8 * textScale);
          const haloW = Math.max(2, 3.8 * textScale);
          const labelName = String(shadow.sourceName || shadow.sourceId || 'Region').trim();
          const areaText = shadow.showArea !== false ? formatArea(built.areaKm2, units) : '';

          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineJoin = 'round';
          ctx.miterLimit = 2;

          const titleY = areaText ? cy - subSize * 0.62 : cy;
          ctx.font = `700 ${titleSize.toFixed(1)}px ${FONT_FAMILY}`;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.lineWidth = haloW;
          ctx.strokeText(labelName, cx, titleY);
          ctx.fillStyle = stroke && stroke !== 'none' ? stroke : '#111111';
          ctx.fillText(labelName, cx, titleY);

          if (areaText) {
            const subY = cy + titleSize * 0.62;
            ctx.font = `600 ${subSize.toFixed(1)}px ${FONT_FAMILY}`;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
            ctx.lineWidth = Math.max(1.6, haloW * 0.85);
            ctx.strokeText(areaText, cx, subY);
            ctx.fillStyle = '#1f2937';
            ctx.fillText(areaText, cx, subY);
          }
          ctx.restore();
        }
      }
    }
  }

  return rendered;
}

function buildSvgHatchPattern(hatch, color, id, scaleFactor) {
  const size = Math.max(8, Math.round(12 * scaleFactor));
  const sw = Math.max(0.8, 1.15 * scaleFactor).toFixed(2);
  const col = escapeXml(color || '#111111');
  let body = '';

  if (hatch === 'diagonal' || hatch === 'cross') {
    body += `<path d="M0,${size} L${size},0 M${-size * 0.5},${size * 0.5} L${size * 0.5},${-size * 0.5} M${size * 0.5},${size * 1.5} L${size * 1.5},${size * 0.5}" stroke="${col}" stroke-width="${sw}" />`;
  }
  if (hatch === 'backdiagonal' || hatch === 'cross') {
    body += `<path d="M0,0 L${size},${size} M${-size * 0.5},${size * 0.5} L${size * 0.5},${size * 1.5} M${size * 0.5},${-size * 0.5} L${size * 1.5},${size * 0.5}" stroke="${col}" stroke-width="${sw}" />`;
  }
  if (hatch === 'dots') {
    const r = Math.max(0.9, 1.3 * scaleFactor).toFixed(2);
    body += `<circle cx="${(size * 0.25).toFixed(2)}" cy="${(size * 0.25).toFixed(2)}" r="${r}" fill="${col}" />`;
    body += `<circle cx="${(size * 0.75).toFixed(2)}" cy="${(size * 0.75).toFixed(2)}" r="${r}" fill="${col}" />`;
  }

  return `<pattern id="${escapeXml(id)}" width="${size}" height="${size}" patternUnits="userSpaceOnUse">${body}</pattern>`;
}

export function renderMapToSvgString(spec, datasets) {
  const { widthPx, heightPx, widthIn, heightIn } = getPixelDimensions(spec?.page);
  const scaleFactor = widthPx / 900;
  const colors = spec?.colors || {};
  const layers = spec?.layers || {};
  const themeDef = COLOR_THEMES[spec?.theme] || COLOR_THEMES.dusty_prime;
  const globeBg = colors.globeBg || themeDef?.globeBg || '#111827';

  const projection = buildProjection(spec, widthPx, heightPx);
  const svgPath = d3.geoPath(projection);

  const defs = [
    `<clipPath id="map-clip"><rect x="0" y="0" width="${widthPx}" height="${heightPx}" /></clipPath>`,
  ];
  const hatchCache = new Map();
  let hatchCounter = 0;

  function getHatchPatternId(hatch, color) {
    if (!hatch || hatch === 'none') return null;
    const key = `${hatch}::${color}`;
    if (hatchCache.has(key)) return hatchCache.get(key);
    hatchCounter += 1;
    const id = `hatch_${hatchCounter}`;
    hatchCache.set(key, id);
    defs.push(buildSvgHatchPattern(hatch, color, id, scaleFactor));
    return id;
  }

  const mapParts = [];
  const isOrtho = spec?.projection === 'orthographic';
  const waterIsNone = isNoneColor(colors.water);
  const landIsNone = isNoneColor(colors.land);
  const coastIsNone = !colors.coastline || isNoneColor(colors.coastline);
  const hasCoastStroke = Boolean(layers.showCoastlines && !coastIsNone);
  const frameStrokeColor = !isNoneColor(colors.text) ? (colors.text || '#111111') : '#111111';
  let sphereD = '';

  if (isOrtho) {
    sphereD = svgPath({ type: 'Sphere' }) || '';
    if (sphereD) {
      defs.push(`<clipPath id="globe-clip"><path d="${sphereD}" /></clipPath>`);
    }
    if (!waterIsNone) {
      mapParts.push(`<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="${escapeXml(globeBg)}" />`);
    }
    if (sphereD) {
      mapParts.push(`<g clip-path="url(#globe-clip)">`);
      if (!waterIsNone) {
        mapParts.push(`<path d="${sphereD}" fill="${escapeXml(colors.water || '#d1cfcf')}" />`);
      }
    }
  } else if (!waterIsNone) {
    mapParts.push(
      `<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="${escapeXml(colors.water || '#d1cfcf')}" />`,
    );
  }

  // 1b. Ocean Bathymetry / Continental Shelf
  if (
    layers.showBathymetry &&
    !isNoneColor(colors.bathymetry) &&
    (datasets?.bathymetry1000 || datasets?.bathymetry200)
  ) {
    const bathyColor = colors.bathymetry || themeDef?.bathymetry || '#bfbdbd';
    if (datasets.bathymetry1000) {
      const b1000D = svgPath(datasets.bathymetry1000) || '';
      if (b1000D) {
        mapParts.push(`<path d="${b1000D}" fill="${escapeXml(bathyColor)}" fill-opacity="0.45" />`);
      }
    }
    if (datasets.bathymetry200) {
      const b200D = svgPath(datasets.bathymetry200) || '';
      if (b200D) {
        mapParts.push(`<path d="${b200D}" fill="${escapeXml(bathyColor)}" fill-opacity="0.45" />`);
      }
    }
  }

  // 2. Graticule
  if (layers.showGraticule) {
    const step = Math.max(1, Math.min(60, Number(layers.graticuleStepDeg) || 10));
    const gratD = svgPath(d3.geoGraticule().step([step, step])()) || '';
    if (gratD) {
      const gratStroke = !isNoneColor(colors.admin1) ? (colors.admin1 || '#737373') : '#737373';
      mapParts.push(
        `<path d="${gratD}" fill="none" stroke="${escapeXml(gratStroke)}" stroke-opacity="0.4" stroke-width="${Math.max(0.4, 0.65 * scaleFactor).toFixed(2)}" />`,
      );
    }
  }

  // 3. Default Land (+ minor islands)
  if (layers.showLand !== false && (!landIsNone || hasCoastStroke) && datasets?.land) {
    const landD = svgPath(datasets.land) || '';
    const landFill = landIsNone ? 'none' : escapeXml(colors.land || '#4a4a4a');
    const coastStroke = hasCoastStroke
      ? ` stroke="${escapeXml(colors.coastline)}" stroke-width="${Math.max(0.3, (Number(layers.coastlineWidth) || 0.75) * scaleFactor).toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"`
      : '';
    if (landD) {
      mapParts.push(`<path d="${landD}" fill="${landFill}" fill-rule="evenodd"${coastStroke} />`);
    }
    if (layers.showMinorIslands !== false && datasets?.minorIslands) {
      const minorD = svgPath(datasets.minorIslands) || '';
      if (minorD) {
        mapParts.push(`<path d="${minorD}" fill="${landFill}"${coastStroke} />`);
      }
    }
  }

  // 3a. Primary Land GeoJSON layers (e.g. OSM Ultra-Detail replacing default land)
  appendCustomLayersSvg(mapParts, svgPath, projection, spec, scaleFactor, getHatchPatternId, 'land');

  // 3b. Urban Areas
  if (layers.showUrbanAreas && !isNoneColor(colors.urban) && datasets?.urbanAreas) {
    const urbanD = svgPath(datasets.urbanAreas) || '';
    if (urbanD) {
      const urbanColor = colors.urban || themeDef?.urban || '#636363';
      mapParts.push(`<path d="${urbanD}" fill="${escapeXml(urbanColor)}" fill-opacity="0.72" />`);
    }
  }

  // 4. Highlighted countries
  const highlighted = Array.isArray(spec?.highlightedCountries) ? spec.highlightedCountries : [];
  if (highlighted.length > 0 && datasets?.countries) {
    for (let i = 0; i < highlighted.length; i += 1) {
      const hc = highlighted[i];
      const features = matchCountryFeatures(datasets.countries, hc);
      if (features.length === 0) continue;

      const fill = hc.fill || colors.highlightFill || '#7a7d7a';
      const stroke = hc.stroke || colors.highlightStroke || '#ffffff';
      const hatchId = getHatchPatternId(hc.hatch || 'none', stroke);
      const fillAttr = isNoneColor(fill) ? 'none' : escapeXml(fill);
      const strokeAttrs =
        stroke && !isNoneColor(stroke)
          ? ` stroke="${escapeXml(stroke)}" stroke-width="${Math.max(0.5, (Number(layers.borderWidth) || 1.0) * 1.15 * scaleFactor).toFixed(2)}" stroke-linejoin="round"`
          : '';

      for (let j = 0; j < features.length; j += 1) {
        const d = svgPath(features[j]) || '';
        if (!d) continue;
        mapParts.push(`<path d="${d}" fill="${fillAttr}" fill-rule="evenodd"${strokeAttrs} />`);
        if (hatchId) {
          mapParts.push(`<path d="${d}" fill="url(#${escapeXml(hatchId)})" fill-rule="evenodd" />`);
        }
      }
    }
  }

  // 4b. On-Demand Military Terrain Relief (clipped shaded raster + crisp vector contours)
  appendTerrainReliefSvg(defs, mapParts, svgPath, projection, spec, datasets, widthPx, heightPx, scaleFactor);

  // 5. Lakes & Inland Seas
  if (layers.showLakes && (!waterIsNone || hasCoastStroke) && datasets?.lakes) {
    const lakesD = svgPath(datasets.lakes) || '';
    if (lakesD) {
      const lakeFill = waterIsNone ? 'none' : escapeXml(colors.water || '#d1cfcf');
      const lakeStroke = hasCoastStroke
        ? ` stroke="${escapeXml(colors.coastline)}" stroke-width="${Math.max(0.25, (Number(layers.coastlineWidth) || 0.75) * 0.85 * scaleFactor).toFixed(2)}" stroke-linejoin="round"`
        : '';
      mapParts.push(`<path d="${lakesD}" fill="${lakeFill}" fill-rule="evenodd"${lakeStroke} />`);
    }
  }

  // 6. Rivers
  if (layers.showRivers && datasets?.rivers && colors.rivers && !isNoneColor(colors.rivers)) {
    const riversD = svgPath(datasets.rivers) || '';
    if (riversD) {
      mapParts.push(
        `<path d="${riversD}" fill="none" stroke="${escapeXml(colors.rivers)}" stroke-width="${Math.max(0.35, (Number(layers.riverWidth) || 0.75) * scaleFactor).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" />`,
      );
    }
  }

  // 7. Admin-1 lines
  if (layers.showAdmin1 && datasets?.admin1 && colors.admin1 && !isNoneColor(colors.admin1)) {
    const adminD = svgPath(datasets.admin1) || '';
    if (adminD) {
      const admin1W = Math.max(0.2, (Number(layers.admin1Width) || 0.7) * scaleFactor);
      mapParts.push(
        `<path d="${adminD}" fill="none" stroke="${escapeXml(colors.admin1)}" stroke-width="${admin1W.toFixed(2)}" stroke-dasharray="${Math.max(2, 4 * scaleFactor).toFixed(1)},${Math.max(1.5, 3 * scaleFactor).toFixed(1)}" stroke-linejoin="round" />`,
      );
    }
  }

  // 8. Custom GeoJSON overlays
  appendCustomLayersSvg(mapParts, svgPath, projection, spec, scaleFactor, getHatchPatternId, 'overlay');

  // 9. Internal borders
  if (layers.showBorders && datasets?.internalBorders && colors.borders && !isNoneColor(colors.borders)) {
    const borderD = svgPath(datasets.internalBorders) || '';
    if (borderD) {
      const bw = Math.max(0.3, (Number(layers.borderWidth) || 1.0) * scaleFactor);
      let extra = '';
      if (layers.borderStyle === 'dashed') {
        extra = ` stroke-dasharray="${(6 * scaleFactor).toFixed(1)},${(4 * scaleFactor).toFixed(1)}"`;
      } else if (layers.borderStyle === 'dotted') {
        extra = ` stroke-dasharray="${(1.2 * scaleFactor).toFixed(1)},${(3.2 * scaleFactor).toFixed(1)}" stroke-linecap="round"`;
      }
      mapParts.push(
        `<path d="${borderD}" fill="none" stroke="${escapeXml(colors.borders)}" stroke-width="${bw.toFixed(2)}" stroke-linejoin="round"${extra} />`,
      );
    }
  }

  // 9b. True-Size Region Shadows
  const shadows = Array.isArray(spec?.regionShadows) ? spec.regionShadows : [];
  const units = spec?.ornaments?.scaleBar?.units === 'mi' ? 'mi' : 'km';
  for (let i = 0; i < shadows.length; i += 1) {
    const shadow = shadows[i];
    if (!shadow || shadow.visible === false) continue;
    const built = buildTransformedShadow(shadow, datasets);
    if (!built) continue;
    const d = svgPath(built.feature) || '';
    if (!d) continue;

    const fill = shadow.fill || '#dc2626';
    const stroke = shadow.stroke || '#7f1d1d';
    const opacity = Number.isFinite(Number(shadow.opacity)) ? Number(shadow.opacity) : 0.35;
    const strokeWidth = Math.max(0.6, (Number(shadow.strokeWidth) || 1.6) * scaleFactor);
    const dashAttr = shadow.dashed !== false
      ? ` stroke-dasharray="${(6.5 * scaleFactor).toFixed(1)},${(3.8 * scaleFactor).toFixed(1)}"`
      : '';
    const hatchId = getHatchPatternId(shadow.hatch || 'none', stroke);
    const strokeAttr = stroke && stroke !== 'none'
      ? ` stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"${dashAttr}`
      : '';

    mapParts.push(
      `<path d="${d}" fill="${escapeXml(fill)}" fill-opacity="${opacity.toFixed(2)}"${strokeAttr} />`,
    );
    if (hatchId) {
      mapParts.push(`<path d="${d}" fill="url(#${escapeXml(hatchId)})" fill-opacity="${Math.min(0.85, opacity + 0.25).toFixed(2)}" />`);
    }

    if (shadow.showLabel !== false && isFrontHemisphere(spec, built.anchorLonLat[0], built.anchorLonLat[1])) {
      const pt = projection(built.anchorLonLat);
      if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
        const [cx, cy] = pt;
        const textScale = Math.max(scaleFactor, Math.max(widthPx, heightPx * 0.78) / 900);
        const titleSize = Math.max(8, 12.5 * textScale);
        const subSize = Math.max(6.5, 9.8 * textScale);
        const haloW = Math.max(2, 3.8 * textScale);
        const labelName = String(shadow.sourceName || shadow.sourceId || 'Region').trim();
        const areaText = shadow.showArea !== false ? formatArea(built.areaKm2, units) : '';
        const titleY = areaText ? cy - subSize * 0.62 : cy;
        mapParts.push(
          `<text x="${cx.toFixed(2)}" y="${titleY.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${titleSize.toFixed(1)}" font-weight="700" fill="${escapeXml(stroke && stroke !== 'none' ? stroke : '#111111')}" text-anchor="middle" dominant-baseline="central" stroke="rgba(255,255,255,0.92)" stroke-width="${haloW.toFixed(2)}" stroke-linejoin="round" paint-order="stroke fill" style="paint-order: stroke fill;">${escapeXml(labelName)}</text>`,
        );
        if (areaText) {
          const subY = cy + titleSize * 0.62;
          mapParts.push(
            `<text x="${cx.toFixed(2)}" y="${subY.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${subSize.toFixed(1)}" font-weight="600" fill="#1f2937" text-anchor="middle" dominant-baseline="central" stroke="rgba(255,255,255,0.92)" stroke-width="${Math.max(1.6, haloW * 0.85).toFixed(2)}" stroke-linejoin="round" paint-order="stroke fill" style="paint-order: stroke fill;">${escapeXml(areaText)}</text>`,
          );
        }
      }
    }
  }

  // 10. Cities & haloed labels
  const cities = !isNoneColor(colors.text) && Array.isArray(spec?.cities) ? spec.cities : [];
  const textColor = colors.text || '#111111';
  const haloColor = colors.textHalo || '#ffffff';
  const globalLabelScale = Math.min(3.5, Math.max(0.4, Number(spec?.layers?.cityLabelScale) || 1.0));
  const globalIconScale = Math.min(3.5, Math.max(0.4, Number(spec?.layers?.cityIconScale) || 1.0));

  for (let i = 0; i < cities.length; i += 1) {
    const city = cities[i];
    const lat = Number(city?.lat);
    const lon = Number(city?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!isFrontHemisphere(spec, lon, lat)) continue;

    const pt = projection([lon, lat]);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const [x, y] = pt;

    const pinScale = Math.min(3.0, Math.max(0.4, Number(city?.scale) || 1.0));
    const iconMult = globalIconScale * pinScale;
    const labelMult = globalLabelScale * pinScale;
    const style = city.style || 'dot';
    const minIconClear = style === 'capital' ? iconMult * 1.12 : iconMult * 0.9;
    const offsetMult =
      style === 'label_only' ? labelMult : Math.max(0.5 * (iconMult + labelMult), minIconClear);
    const cullMargin = 40 * scaleFactor * Math.max(1, iconMult, labelMult);
    if (
      x < -cullMargin ||
      x > widthPx + cullMargin ||
      y < -cullMargin ||
      y > heightPx + cullMargin
    ) {
      continue;
    }

    if (style === 'capital') {
      const outerR = Math.max(3.0, 6.6 * scaleFactor * iconMult);
      const innerR = outerR * 0.42;
      const pts = buildStarVertices(x, y, outerR, innerR)
        .map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`)
        .join(' ');
      let haloAttr = '';
      if (haloColor && haloColor !== 'none') {
        const haloStroke = Math.max(1.2, 2.5 * scaleFactor * Math.sqrt(iconMult));
        haloAttr = ` stroke="${escapeXml(haloColor)}" stroke-width="${haloStroke.toFixed(2)}" stroke-linejoin="round" paint-order="stroke fill" style="paint-order: stroke fill;"`;
      }
      mapParts.push(
        `<polygon points="${pts}" fill="${escapeXml(textColor)}"${haloAttr} />`,
      );
    } else if (style === 'bullseye') {
      const outerR = Math.max(2.0, 5.2 * scaleFactor * iconMult);
      const innerR = Math.max(0.9, 2.4 * scaleFactor * iconMult);
      const outerFill = haloColor !== 'none' ? haloColor : '#ffffff';
      const ringStroke = Math.max(0.7, 1.4 * scaleFactor * Math.sqrt(iconMult));
      mapParts.push(
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${outerR.toFixed(2)}" fill="${escapeXml(outerFill)}" stroke="${escapeXml(textColor)}" stroke-width="${ringStroke.toFixed(2)}" />`,
      );
      mapParts.push(
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${innerR.toFixed(2)}" fill="${escapeXml(textColor)}" />`,
      );
    } else if (style === 'square') {
      const sz = Math.max(2.2, 5.8 * scaleFactor * iconMult);
      const half = sz / 2;
      const haloStroke = Math.max(1.0, 2.4 * scaleFactor * Math.sqrt(iconMult));
      const haloAttr =
        haloColor && haloColor !== 'none'
          ? ` stroke="${escapeXml(haloColor)}" stroke-width="${haloStroke.toFixed(2)}"`
          : '';
      mapParts.push(
        `<rect x="${(x - half).toFixed(2)}" y="${(y - half).toFixed(2)}" width="${sz.toFixed(2)}" height="${sz.toFixed(2)}" fill="${escapeXml(textColor)}"${haloAttr} />`,
      );
    } else if (style === 'dot') {
      const r = Math.max(1.2, 3.2 * scaleFactor * iconMult);
      const haloStroke = Math.max(0.9, 2.2 * scaleFactor * Math.sqrt(iconMult));
      const haloAttr =
        haloColor && haloColor !== 'none'
          ? ` stroke="${escapeXml(haloColor)}" stroke-width="${haloStroke.toFixed(2)}"`
          : '';
      mapParts.push(
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}" fill="${escapeXml(textColor)}"${haloAttr} />`,
      );
    }

    const label = String(city.name || '').trim();
    if (label) {
      const textScale = Math.max(scaleFactor, (Math.max(widthPx, heightPx * 0.78) / 900));
      const dx = Number.isFinite(Number(city.dx)) ? Number(city.dx) : 6;
      const dy = Number.isFinite(Number(city.dy)) ? Number(city.dy) : -5;
      const lx = x + dx * textScale * offsetMult;
      const ly = y + dy * textScale * offsetMult;
      const isBoldPin = style === 'capital' || style === 'bullseye';
      const fontSize = Math.max(5.5, (isBoldPin ? 14.5 : 12.8) * textScale * labelMult);
      const textHaloW = Math.max(1.5, 3.6 * textScale * Math.pow(labelMult, 0.75));
      const anchor = dx < -2 ? 'end' : Math.abs(dx) <= 2 ? 'middle' : 'start';
      const weight = isBoldPin ? 700 : 600;
      const strokeAttr =
        haloColor && haloColor !== 'none'
          ? ` stroke="${escapeXml(haloColor)}" stroke-width="${textHaloW.toFixed(2)}" stroke-linejoin="round" paint-order="stroke fill" style="paint-order: stroke fill;"`
          : '';
      mapParts.push(
        `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize.toFixed(1)}" font-weight="${weight}" fill="${escapeXml(textColor)}" text-anchor="${anchor}" dominant-baseline="central"${strokeAttr}>${escapeXml(label)}</text>`,
      );
    }
  }

  if (isOrtho && sphereD) {
    mapParts.push('</g>');
    if (!waterIsNone || !coastIsNone) {
      const limbStroke = !coastIsNone
        ? colors.coastline
        : (!isNoneColor(colors.text) && colors.text) || '#333333';
      mapParts.push(
        `<path d="${sphereD}" fill="none" stroke="${escapeXml(limbStroke)}" stroke-width="${Math.max(0.75, 1.1 * scaleFactor).toFixed(2)}" />`,
      );
    }
  }

  // 11. Ornaments
  const ornamentsSvg = buildOrnamentsSvg(spec, projection, datasets, widthPx, heightPx, scaleFactor);

  // 12. Frame border
  let frameSvg = '';
  if (spec?.page?.showFrameBorder) {
    const fw = Math.max(1, 1.5 * scaleFactor);
    frameSvg = `<rect x="${(fw / 2).toFixed(2)}" y="${(fw / 2).toFixed(2)}" width="${(widthPx - fw).toFixed(2)}" height="${(heightPx - fw).toFixed(2)}" fill="none" stroke="${escapeXml(frameStrokeColor)}" stroke-width="${fw.toFixed(2)}" />`;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthIn}in" height="${heightIn}in" viewBox="0 0 ${widthPx} ${heightPx}">`,
    `<defs>${defs.join('\n')}</defs>`,
    `<g clip-path="url(#map-clip)">`,
    mapParts.join('\n'),
    ornamentsSvg,
    frameSvg,
    `</g>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function screenToLonLat(projection, x, y) {
  if (!projection || typeof projection.invert !== 'function') return null;
  const coords = projection.invert([x, y]);
  if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
    return null;
  }
  const lon = wrapLon(coords[0]);
  const lat = coords[1];
  if (lat < -90 || lat > 90) return null;

  const back = projection([lon, lat]);
  if (!back || !Number.isFinite(back[0]) || !Number.isFinite(back[1])) return null;
  if (Math.hypot(back[0] - x, back[1] - y) > 2.5) return null;

  const out = [lon, lat];
  out.lon = lon;
  out.lat = lat;
  return out;
}

export function hitTestCountry(projection, datasets, x, y) {
  const coords = screenToLonLat(projection, x, y);
  if (!coords) return null;
  const features = datasets?.countries?.features;
  if (!Array.isArray(features)) return null;

  const lon = coords[0];
  const lat = coords[1];
  const lonLat = [lon, lat];
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (!f || !f.geometry) continue;
    const bbox = f._bbox;
    if (bbox && !bbox[4]) {
      if (lat < bbox[1] - 1e-6 || lat > bbox[3] + 1e-6) continue;
      const minLon = bbox[0] - 1e-6;
      const maxLon = bbox[2] + 1e-6;
      const lonMatch =
        (lon >= minLon && lon <= maxLon) ||
        (lon - 360 >= minLon && lon - 360 <= maxLon) ||
        (lon + 360 >= minLon && lon + 360 <= maxLon);
      if (!lonMatch) continue;
    }
    if (d3.geoContains(f, lonLat)) {
      return {
        id: f.id != null ? String(f.id) : '',
        name: typeof f.properties?.name === 'string' ? f.properties.name : '',
        feature: f,
      };
    }
  }
  return null;
}

/**
 * Find the nearest visible custom GeoJSON Point/MultiPoint feature under canvas pixel `(x, y)`.
 */
export function hitTestGeoJsonPoint(projection, spec, x, y, width, height) {
  if (!projection || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const overlays = Array.isArray(spec?.customGeoJsonLayers) ? spec.customGeoJsonLayers : [];
  if (overlays.length === 0) return null;

  const scaleFactor = (width || 900) / 900;
  const isOrtho = spec?.projection === 'orthographic';
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = Number(spec?.center?.lat) || 0;

  let best = null;
  let bestDist = Infinity;

  // Iterate topmost layer first
  for (let i = overlays.length - 1; i >= 0; i -= 1) {
    const layer = overlays[i];
    if (layer?.visible === false || layer?.role === 'land' || !layer?.data) continue;

    const strokeWidthNum = Number.isFinite(Number(layer.strokeWidth)) ? Number(layer.strokeWidth) : 1.5;
    const pointRadius = Math.max(1.5, Math.max(0.4, strokeWidthNum) * 2.5) * scaleFactor;
    const hitRadius = Math.max(12 * scaleFactor, pointRadius + 8 * scaleFactor);
    const features = collectGeoJsonFeatures(layer.data);

    for (let j = 0; j < features.length; j += 1) {
      const feature = features[j];
      const geom = feature?.geometry;
      if (!geom) continue;

      let coordsList = null;
      if (geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
        coordsList = [geom.coordinates];
      } else if (geom.type === 'MultiPoint' && Array.isArray(geom.coordinates)) {
        coordsList = geom.coordinates;
      }
      if (!coordsList) continue;

      for (let k = 0; k < coordsList.length; k += 1) {
        const pt = coordsList[k];
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

        if (isOrtho && d3.geoDistance([lon, lat], [centerLon, centerLat]) > Math.PI / 2 - 1e-4) {
          continue;
        }

        const projected = projection([lon, lat]);
        if (!projected || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
          continue;
        }
        const [px, py] = projected;
        if (width && height && (px < -hitRadius || px > width + hitRadius || py < -hitRadius || py > height + hitRadius)) {
          continue;
        }

        const dist = Math.hypot(px - x, py - y);
        if (dist <= hitRadius && dist < bestDist) {
          bestDist = dist;
          best = {
            layer,
            layerIndex: i,
            feature,
            properties: feature.properties && typeof feature.properties === 'object' ? feature.properties : {},
            lon,
            lat,
            x: px,
            y: py,
            dist,
          };
        }
      }
    }
  }

  return best;
}
