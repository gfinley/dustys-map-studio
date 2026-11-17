/**
 * D3 geographic projection engine, Canvas 2D renderer, standalone SVG renderer,
 * and interactive screen-to-lon/lat + country hit-testing utilities.
 */

import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { geoRobinson } from 'https://cdn.jsdelivr.net/npm/d3-geo-projection@4/+esm';
import {
  drawScaleBar,
  drawLocatorGlobe,
  drawNorthArrow,
  drawLegend,
  drawTitleBanner,
  buildOrnamentsSvg,
} from './ornaments.js?v=7';
import { getPixelDimensions, COLOR_THEMES } from './schema.js?v=7';

const FONT_FAMILY = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MAX_HATCH_CACHE_ENTRIES = 64;
const hatchPatternCache = new Map();

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
  const lonDeg = Math.max(0.05, Math.min(360, Number(spec?.span?.lonDeg) || 24));
  const latDeg = Math.max(0.05, Math.min(175, Number(spec?.span?.latDeg) || 14));

  const halfLon = Math.min(179.5, lonDeg / 2);
  const halfLat = latDeg / 2;
  let minLat = Math.max(-85, centerLat - halfLat);
  let maxLat = Math.min(85, centerLat + halfLat);
  if (maxLat - minLat < 0.05) {
    if (centerLat >= 0) {
      minLat = Math.max(-85, maxLat - 0.05);
    } else {
      maxLat = Math.min(85, minLat + 0.05);
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
  const lonDeg = Math.max(0.05, Math.min(360, Number(spec?.span?.lonDeg) || 24));
  const latDeg = Math.max(0.05, Math.min(175, Number(spec?.span?.latDeg) || 14));

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
    const zoom = Math.max(0.8, Math.min(45.0, 120 / Math.max(1.5, lonDeg)));
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

function computeVisibleBounds(spec, projection, width, height) {
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

function drawCustomLayersCanvas(ctx, projection, spec, scaleFactor) {
  const overlays = Array.isArray(spec?.customGeoJsonLayers) ? spec.customGeoJsonLayers : [];
  if (overlays.length === 0) return;

  const path = d3.geoPath(projection, ctx);

  for (let i = 0; i < overlays.length; i += 1) {
    const layer = overlays[i];
    if (layer?.visible === false || !layer?.data) continue;

    const features = collectGeoJsonFeatures(layer.data);
    const color = layer.color || '#222222';
    const fillOpacity = Number.isFinite(Number(layer.fillOpacity)) ? Number(layer.fillOpacity) : 0.45;
    const strokeWidth = Math.max(0.3, (Number(layer.strokeWidth) || 1.5) * scaleFactor);
    const dashed = Boolean(layer.dashed);
    const hatch = layer.hatch || 'none';
    const pointRadius = Math.max(3, (Number(layer.strokeWidth) || 1.5) * 2.5) * scaleFactor;
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
        ctx.fill();
        ctx.restore();
      }
      if (hatch !== 'none') {
        const pattern = createCanvasHatchPattern(ctx, hatch, color, scaleFactor);
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fill();
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (dashed) ctx.setLineDash([6 * scaleFactor, 4 * scaleFactor]);
      ctx.stroke();
      ctx.restore();
    }

    if (groups.lines.length > 0) {
      const fc = {
        type: 'FeatureCollection',
        features: groups.lines.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
      };
      ctx.save();
      ctx.beginPath();
      path(fc);
      ctx.strokeStyle = color;
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
      ctx.beginPath();
      pointPath(fc);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(0.8, 1.2 * scaleFactor);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawCitiesCanvas(ctx, projection, spec, width, height, scaleFactor) {
  const cities = Array.isArray(spec?.cities) ? spec.cities : [];
  if (cities.length === 0) return;

  const colors = spec?.colors || {};
  const textColor = colors.text || '#111111';
  const haloColor = colors.textHalo || '#ffffff';

  for (let i = 0; i < cities.length; i += 1) {
    const city = cities[i];
    const lat = Number(city?.lat);
    const lon = Number(city?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!isFrontHemisphere(spec, lon, lat)) continue;

    const pt = projection([lon, lat]);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const [x, y] = pt;
    if (x < -40 * scaleFactor || x > width + 40 * scaleFactor || y < -40 * scaleFactor || y > height + 40 * scaleFactor) {
      continue;
    }

    const style = city.style || 'dot';
    ctx.save();

    if (style === 'capital') {
      const outerR = Math.max(3.5, 5.2 * scaleFactor);
      const innerR = Math.max(1.6, 2.4 * scaleFactor);
      ctx.beginPath();
      ctx.arc(x, y, outerR, 0, Math.PI * 2);
      ctx.fillStyle = haloColor !== 'none' ? haloColor : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = textColor;
      ctx.lineWidth = Math.max(1.0, 1.4 * scaleFactor);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, innerR, 0, Math.PI * 2);
      ctx.fillStyle = textColor;
      ctx.fill();
    } else if (style === 'square') {
      const sz = Math.max(4, 5.8 * scaleFactor);
      const half = sz / 2;
      if (haloColor && haloColor !== 'none') {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = Math.max(1.5, 2.4 * scaleFactor);
        ctx.strokeRect(x - half, y - half, sz, sz);
      }
      ctx.fillStyle = textColor;
      ctx.fillRect(x - half, y - half, sz, sz);
    } else if (style === 'dot') {
      const r = Math.max(2, 3.2 * scaleFactor);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (haloColor && haloColor !== 'none') {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = Math.max(1.4, 2.2 * scaleFactor);
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
      const lx = x + dx * textScale;
      const ly = y + dy * textScale;
      const fontSize = Math.max(9.5, (style === 'capital' ? 14.5 : 12.8) * textScale);

      ctx.font = `${style === 'capital' ? 700 : 600} ${fontSize.toFixed(1)}px ${FONT_FAMILY}`;
      ctx.textAlign = dx < -2 ? 'right' : Math.abs(dx) <= 2 ? 'center' : 'left';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;

      if (haloColor && haloColor !== 'none') {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = Math.max(2.4, 3.6 * textScale);
        ctx.strokeText(label, lx, ly);
      }
      ctx.fillStyle = textColor;
      ctx.fillText(label, lx, ly);
    }

    ctx.restore();
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

  // 1. Water / globe background
  if (spec?.projection === 'orthographic') {
    ctx.fillStyle = globeBg;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.beginPath();
    path({ type: 'Sphere' });
    ctx.fillStyle = colors.water || '#d1cfcf';
    ctx.fill();
    ctx.clip();
  } else {
    ctx.fillStyle = colors.water || '#d1cfcf';
    ctx.fillRect(0, 0, width, height);
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
    ctx.strokeStyle = colors.admin1 || '#737373';
    ctx.lineWidth = Math.max(0.4, 0.65 * scaleFactor);
    ctx.stroke();
    ctx.restore();
  }

  // Use zero-resample streaming for dense natural datasets while clipExtent keeps bounds tight
  projection.precision(0);

  // 3. Land (+ optional coastline)
  const landParts =
    Array.isArray(datasets?.landParts) && datasets.landParts.length > 0 ? datasets.landParts : null;
  if (landParts || datasets?.land) {
    ctx.save();
    ctx.beginPath();
    drawCulledCollection(path, landParts, datasets?.land, viewBounds, skipCull);
    ctx.fillStyle = colors.land || '#4a4a4a';
    ctx.fill();
    if (layers.showCoastlines && colors.coastline && colors.coastline !== 'none') {
      ctx.strokeStyle = colors.coastline;
      ctx.lineWidth = Math.max(0.3, (Number(layers.coastlineWidth) || 0.75) * scaleFactor);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
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
        ctx.fillStyle = fill;
        ctx.fill();
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fill();
        }
        if (stroke && stroke !== 'none') {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = Math.max(0.5, (Number(layers.borderWidth) || 1.0) * 1.15 * scaleFactor);
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  // 5. Lakes
  if (layers.showLakes && datasets?.lakes) {
    ctx.save();
    ctx.beginPath();
    drawCulledCollection(
      path,
      Array.isArray(datasets.lakes.features) ? datasets.lakes.features : null,
      datasets.lakes,
      viewBounds,
      skipCull,
    );
    ctx.fillStyle = colors.water || '#d1cfcf';
    ctx.fill();
    if (layers.showCoastlines && colors.coastline && colors.coastline !== 'none') {
      ctx.strokeStyle = colors.coastline;
      ctx.lineWidth = Math.max(0.25, (Number(layers.coastlineWidth) || 0.75) * 0.85 * scaleFactor);
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  // 6. Rivers
  if (layers.showRivers && datasets?.rivers && colors.rivers && colors.rivers !== 'none') {
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
  if (layers.showAdmin1 && datasets?.admin1 && colors.admin1 && colors.admin1 !== 'none') {
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
    drawCustomLayersCanvas(ctx, projection, spec, scaleFactor);
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
    colors.borders !== 'none' &&
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

  // 10. Cities & haloed labels
  drawCitiesCanvas(ctx, projection, spec, width, height, scaleFactor);

  // Restore orthographic Sphere clip and draw crisp globe limb
  if (spec?.projection === 'orthographic') {
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    path({ type: 'Sphere' });
    ctx.strokeStyle =
      colors.coastline && colors.coastline !== 'none'
        ? colors.coastline
        : colors.text || 'rgba(0,0,0,0.35)';
    ctx.lineWidth = Math.max(0.75, 1.1 * scaleFactor);
    ctx.stroke();
    ctx.restore();
  }

  // 11. Ornaments
  if (!options.skipOrnaments) {
    drawScaleBar(ctx, spec, projection, width, height, scaleFactor);
    drawLocatorGlobe(ctx, spec, datasets, width, height, scaleFactor, projection);
    drawNorthArrow(ctx, spec, width, height, scaleFactor);
    drawLegend(ctx, spec, width, height, scaleFactor);
    drawTitleBanner(ctx, spec, width, height, scaleFactor);
  }

  // 12. Page frame border
  if (spec?.page?.showFrameBorder) {
    const fw = Math.max(1, 1.5 * scaleFactor);
    ctx.save();
    ctx.strokeStyle = colors.text || '#111111';
    ctx.lineWidth = fw;
    ctx.strokeRect(fw / 2, fw / 2, width - fw, height - fw);
    ctx.restore();
  }

  ctx.restore();

  return {
    projection,
    bounds: viewBounds,
  };
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
  let sphereD = '';

  if (isOrtho) {
    sphereD = svgPath({ type: 'Sphere' }) || '';
    if (sphereD) {
      defs.push(`<clipPath id="globe-clip"><path d="${sphereD}" /></clipPath>`);
    }
    mapParts.push(`<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="${escapeXml(globeBg)}" />`);
    if (sphereD) {
      mapParts.push(`<g clip-path="url(#globe-clip)">`);
      mapParts.push(`<path d="${sphereD}" fill="${escapeXml(colors.water || '#d1cfcf')}" />`);
    }
  } else {
    mapParts.push(
      `<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="${escapeXml(colors.water || '#d1cfcf')}" />`,
    );
  }

  // 2. Graticule
  if (layers.showGraticule) {
    const step = Math.max(1, Math.min(60, Number(layers.graticuleStepDeg) || 10));
    const gratD = svgPath(d3.geoGraticule().step([step, step])()) || '';
    if (gratD) {
      mapParts.push(
        `<path d="${gratD}" fill="none" stroke="${escapeXml(colors.admin1 || '#737373')}" stroke-opacity="0.4" stroke-width="${Math.max(0.4, 0.65 * scaleFactor).toFixed(2)}" />`,
      );
    }
  }

  // 3. Land
  if (datasets?.land) {
    const landD = svgPath(datasets.land) || '';
    if (landD) {
      const coastStroke =
        layers.showCoastlines && colors.coastline && colors.coastline !== 'none'
          ? ` stroke="${escapeXml(colors.coastline)}" stroke-width="${Math.max(0.3, (Number(layers.coastlineWidth) || 0.75) * scaleFactor).toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"`
          : '';
      mapParts.push(`<path d="${landD}" fill="${escapeXml(colors.land || '#4a4a4a')}"${coastStroke} />`);
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
      const strokeAttrs =
        stroke && stroke !== 'none'
          ? ` stroke="${escapeXml(stroke)}" stroke-width="${Math.max(0.5, (Number(layers.borderWidth) || 1.0) * 1.15 * scaleFactor).toFixed(2)}" stroke-linejoin="round"`
          : '';

      for (let j = 0; j < features.length; j += 1) {
        const d = svgPath(features[j]) || '';
        if (!d) continue;
        mapParts.push(`<path d="${d}" fill="${escapeXml(fill)}"${strokeAttrs} />`);
        if (hatchId) {
          mapParts.push(`<path d="${d}" fill="url(#${escapeXml(hatchId)})" />`);
        }
      }
    }
  }

  // 5. Lakes
  if (layers.showLakes && datasets?.lakes) {
    const lakesD = svgPath(datasets.lakes) || '';
    if (lakesD) {
      const lakeStroke =
        layers.showCoastlines && colors.coastline && colors.coastline !== 'none'
          ? ` stroke="${escapeXml(colors.coastline)}" stroke-width="${Math.max(0.25, (Number(layers.coastlineWidth) || 0.75) * 0.85 * scaleFactor).toFixed(2)}" stroke-linejoin="round"`
          : '';
      mapParts.push(`<path d="${lakesD}" fill="${escapeXml(colors.water || '#d1cfcf')}"${lakeStroke} />`);
    }
  }

  // 6. Rivers
  if (layers.showRivers && datasets?.rivers && colors.rivers && colors.rivers !== 'none') {
    const riversD = svgPath(datasets.rivers) || '';
    if (riversD) {
      mapParts.push(
        `<path d="${riversD}" fill="none" stroke="${escapeXml(colors.rivers)}" stroke-width="${Math.max(0.35, (Number(layers.riverWidth) || 0.75) * scaleFactor).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" />`,
      );
    }
  }

  // 7. Admin-1 lines
  if (layers.showAdmin1 && datasets?.admin1 && colors.admin1 && colors.admin1 !== 'none') {
    const adminD = svgPath(datasets.admin1) || '';
    if (adminD) {
      const admin1W = Math.max(0.2, (Number(layers.admin1Width) || 0.7) * scaleFactor);
      mapParts.push(
        `<path d="${adminD}" fill="none" stroke="${escapeXml(colors.admin1)}" stroke-width="${admin1W.toFixed(2)}" stroke-dasharray="${Math.max(2, 4 * scaleFactor).toFixed(1)},${Math.max(1.5, 3 * scaleFactor).toFixed(1)}" stroke-linejoin="round" />`,
      );
    }
  }

  // 8. Custom GeoJSON overlays
  const overlays = Array.isArray(spec?.customGeoJsonLayers) ? spec.customGeoJsonLayers : [];
  for (let i = 0; i < overlays.length; i += 1) {
    const layer = overlays[i];
    if (layer?.visible === false || !layer?.data) continue;

    const features = collectGeoJsonFeatures(layer.data);
    const color = layer.color || '#222222';
    const fillOpacity = Number.isFinite(Number(layer.fillOpacity)) ? Number(layer.fillOpacity) : 0.45;
    const strokeWidth = Math.max(0.3, (Number(layer.strokeWidth) || 1.5) * scaleFactor);
    const dashAttr = layer.dashed
      ? ` stroke-dasharray="${(6 * scaleFactor).toFixed(1)},${(4 * scaleFactor).toFixed(1)}"`
      : '';
    const hatchId = getHatchPatternId(layer.hatch || 'none', color);
    const pointRadius = Math.max(3, (Number(layer.strokeWidth) || 1.5) * 2.5) * scaleFactor;
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
        mapParts.push(
          `<path d="${d}" fill="${escapeXml(color)}" fill-opacity="${fillOpacity}" stroke="${escapeXml(color)}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"${dashAttr} />`,
        );
        if (hatchId) {
          mapParts.push(`<path d="${d}" fill="url(#${escapeXml(hatchId)})" />`);
        }
      }
    }

    if (groups.lines.length > 0) {
      const d =
        svgPath({
          type: 'FeatureCollection',
          features: groups.lines.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
        }) || '';
      if (d) {
        mapParts.push(
          `<path d="${d}" fill="none" stroke="${escapeXml(color)}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"${dashAttr} />`,
        );
      }
    }

    if (groups.points.length > 0) {
      const d =
        pointSvgPath({
          type: 'FeatureCollection',
          features: groups.points.map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
        }) || '';
      if (d) {
        mapParts.push(
          `<path d="${d}" fill="${escapeXml(color)}" stroke="#ffffff" stroke-width="${Math.max(0.8, 1.2 * scaleFactor).toFixed(2)}" />`,
        );
      }
    }
  }

  // 9. Internal borders
  if (layers.showBorders && datasets?.internalBorders && colors.borders && colors.borders !== 'none') {
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

  // 10. Cities & haloed labels
  const cities = Array.isArray(spec?.cities) ? spec.cities : [];
  const textColor = colors.text || '#111111';
  const haloColor = colors.textHalo || '#ffffff';

  for (let i = 0; i < cities.length; i += 1) {
    const city = cities[i];
    const lat = Number(city?.lat);
    const lon = Number(city?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!isFrontHemisphere(spec, lon, lat)) continue;

    const pt = projection([lon, lat]);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const [x, y] = pt;
    if (
      x < -40 * scaleFactor ||
      x > widthPx + 40 * scaleFactor ||
      y < -40 * scaleFactor ||
      y > heightPx + 40 * scaleFactor
    ) {
      continue;
    }

    const style = city.style || 'dot';
    if (style === 'capital') {
      const outerR = Math.max(3.5, 5.2 * scaleFactor);
      const innerR = Math.max(1.6, 2.4 * scaleFactor);
      const outerFill = haloColor !== 'none' ? haloColor : '#ffffff';
      mapParts.push(
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${outerR.toFixed(2)}" fill="${escapeXml(outerFill)}" stroke="${escapeXml(textColor)}" stroke-width="${Math.max(1.0, 1.4 * scaleFactor).toFixed(2)}" />`,
      );
      mapParts.push(
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${innerR.toFixed(2)}" fill="${escapeXml(textColor)}" />`,
      );
    } else if (style === 'square') {
      const sz = Math.max(4, 5.8 * scaleFactor);
      const half = sz / 2;
      const haloAttr =
        haloColor && haloColor !== 'none'
          ? ` stroke="${escapeXml(haloColor)}" stroke-width="${Math.max(1.5, 2.4 * scaleFactor).toFixed(2)}"`
          : '';
      mapParts.push(
        `<rect x="${(x - half).toFixed(2)}" y="${(y - half).toFixed(2)}" width="${sz.toFixed(2)}" height="${sz.toFixed(2)}" fill="${escapeXml(textColor)}"${haloAttr} />`,
      );
    } else if (style === 'dot') {
      const r = Math.max(2, 3.2 * scaleFactor);
      const haloAttr =
        haloColor && haloColor !== 'none'
          ? ` stroke="${escapeXml(haloColor)}" stroke-width="${Math.max(1.4, 2.2 * scaleFactor).toFixed(2)}"`
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
      const lx = x + dx * textScale;
      const ly = y + dy * textScale;
      const fontSize = Math.max(9.5, (style === 'capital' ? 14.5 : 12.8) * textScale);
      const anchor = dx < -2 ? 'end' : Math.abs(dx) <= 2 ? 'middle' : 'start';
      const weight = style === 'capital' ? 700 : 600;
      const strokeAttr =
        haloColor && haloColor !== 'none'
          ? ` stroke="${escapeXml(haloColor)}" stroke-width="${Math.max(2.4, 3.6 * textScale).toFixed(2)}" stroke-linejoin="round" paint-order="stroke fill" style="paint-order: stroke fill;"`
          : '';
      mapParts.push(
        `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize.toFixed(1)}" font-weight="${weight}" fill="${escapeXml(textColor)}" text-anchor="${anchor}" dominant-baseline="central"${strokeAttr}>${escapeXml(label)}</text>`,
      );
    }
  }

  if (isOrtho && sphereD) {
    mapParts.push('</g>');
    const limbStroke =
      colors.coastline && colors.coastline !== 'none'
        ? colors.coastline
        : colors.text || '#333333';
    mapParts.push(
      `<path d="${sphereD}" fill="none" stroke="${escapeXml(limbStroke)}" stroke-width="${Math.max(0.75, 1.1 * scaleFactor).toFixed(2)}" />`,
    );
  }

  // 11. Ornaments
  const ornamentsSvg = buildOrnamentsSvg(spec, projection, datasets, widthPx, heightPx, scaleFactor);

  // 12. Frame border
  let frameSvg = '';
  if (spec?.page?.showFrameBorder) {
    const fw = Math.max(1, 1.5 * scaleFactor);
    frameSvg = `<rect x="${(fw / 2).toFixed(2)}" y="${(fw / 2).toFixed(2)}" width="${(widthPx - fw).toFixed(2)}" height="${(heightPx - fw).toFixed(2)}" fill="none" stroke="${escapeXml(colors.text || '#111111')}" stroke-width="${fw.toFixed(2)}" />`;
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
