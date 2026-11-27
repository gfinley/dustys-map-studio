/**
 * Cartographic map ornaments for both Canvas 2D and standalone SVG output:
 * scale bar, orthographic/satellite locator globe, north arrow, legend, and title banner.
 */

import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { geoSatellite } from 'https://cdn.jsdelivr.net/npm/d3-geo-projection@4/+esm';
import {
  computeAltitudeScaleInfo,
  resolveContourPalette,
  sampleAltitudeRampColor,
} from './terrain-relief.js?v=35';

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_MILE = 1.609344;
const SCALE_CANDIDATES = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
const FONT_FAMILY = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const locatorGlobeCache = {
  key: '',
  canvas: null,
};

function formatScaleLabel(value, units) {
  if (units === 'km' && value < 1) {
    return `${Math.round(value * 1000)} m`;
  }
  return `${value} ${units}`;
}

function formatScaleMid(value, units) {
  if (units === 'km' && value < 1) {
    return String(Math.round((value * 1000) / 2));
  }
  return String(value / 2);
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

function resolveOrnamentColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim();
  if (!cleaned) return fallback;
  const lower = cleaned.toLowerCase();
  if (lower === 'none' || lower === 'transparent') return fallback;
  return cleaned;
}

function buildExtentRing(spec, asPolygon = false) {
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

  const lonSteps = Math.max(8, Math.ceil((halfLon * 2) / 6));
  const latSteps = Math.max(6, Math.ceil((maxLat - minLat) / 6));
  const coords = [];

  if (asPolygon) {
    // D3 spherical CW winding (interior < 2*pi): top-left -> top-right -> bottom-right -> bottom-left -> top-left
    for (let i = 0; i < lonSteps; i += 1) {
      const t = i / lonSteps;
      coords.push([wrapLon(centerLon - halfLon + t * halfLon * 2), maxLat]);
    }
    for (let i = 0; i < latSteps; i += 1) {
      const t = i / latSteps;
      coords.push([wrapLon(centerLon + halfLon), maxLat - t * (maxLat - minLat)]);
    }
    for (let i = 0; i < lonSteps; i += 1) {
      const t = i / lonSteps;
      coords.push([wrapLon(centerLon + halfLon - t * halfLon * 2), minLat]);
    }
    for (let i = 0; i < latSteps; i += 1) {
      const t = i / latSteps;
      coords.push([wrapLon(centerLon - halfLon), minLat + t * (maxLat - minLat)]);
    }
    coords.push([...coords[0]]);
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [coords] },
    };
  }

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
    geometry: { type: 'LineString', coordinates: coords },
  };
}

function estimateEffectiveSpanDeg(spec) {
  const centerLat = Number(spec?.center?.lat) || 0;
  const lonDeg = Math.max(0.05, Math.min(360, Number(spec?.span?.lonDeg) || 24));
  const latDeg = Math.max(0.05, Math.min(175, Number(spec?.span?.latDeg) || 14));
  if (spec?.projection === 'orthographic') {
    return Math.max(lonDeg, latDeg);
  }
  const cosLat = Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
  const pageAspect =
    Math.max(1, Number(spec?.page?.widthIn) || 7) /
    Math.max(1, Number(spec?.page?.heightIn) || 5);
  const gcWidth = lonDeg * cosLat;
  const gcHeight = latDeg;
  const fittedGcWidth = Math.max(gcWidth, gcHeight * pageAspect);
  const fittedGcHeight = Math.max(gcHeight, gcWidth / pageAspect);
  return Math.max(fittedGcWidth, fittedGcHeight);
}

function computeTrueViewportFootprint(spec, projection, width, height) {
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = Number(spec?.center?.lat) || 0;
  const lonDeg = Math.max(0.05, Math.min(360, Number(spec?.span?.lonDeg) || 24));
  const latDeg = Math.max(0.05, Math.min(175, Number(spec?.span?.latDeg) || 14));

  const buildFallbackFootprint = (canFill = lonDeg < 150 && latDeg < 120) => ({
    feature: buildExtentRing(spec, canFill),
    canFill,
    visLonSpan: lonDeg,
    visLatSpan: latDeg,
    maxCornerDistDeg: estimateEffectiveSpanDeg(spec) * 0.5,
  });

  if (!projection || typeof projection.invert !== 'function' || !(width > 0) || !(height > 0)) {
    return buildFallbackFootprint();
  }

  const tolPx = Math.max(4, Math.max(width, height) * 0.01);
  const invertPointSafe = (sx, sy) => {
    const raw = projection.invert([sx, sy]);
    if (!raw || !Number.isFinite(raw[0]) || !Number.isFinite(raw[1])) return null;
    const lat = raw[1];
    if (Math.abs(lat) > 89.999) return null;
    const lon = wrapLon(raw[0]);
    if (spec?.projection === 'orthographic') {
      if (d3.geoDistance([lon, lat], [centerLon, centerLat]) > Math.PI / 2 - 0.025) {
        return null;
      }
    } else if (spec?.projection === 'azimuthal_equidistant') {
      if (d3.geoDistance([lon, lat], [centerLon, centerLat]) > (179 * Math.PI) / 180) {
        return null;
      }
    }
    const back = projection([lon, lat]);
    if (!back || !Number.isFinite(back[0]) || !Number.isFinite(back[1])) return null;
    if (Math.hypot(back[0] - sx, back[1] - sy) > tolPx) return null;
    return [lon, lat];
  };

  const stepsPerEdge = 24;
  const perimeter = [];
  for (let i = 0; i < stepsPerEdge; i += 1) {
    perimeter.push([(i / stepsPerEdge) * width, 0]);
  }
  for (let i = 0; i < stepsPerEdge; i += 1) {
    perimeter.push([width, (i / stepsPerEdge) * height]);
  }
  for (let i = 0; i < stepsPerEdge; i += 1) {
    perimeter.push([(1 - i / stepsPerEdge) * width, height]);
  }
  for (let i = 0; i < stepsPerEdge; i += 1) {
    perimeter.push([0, (1 - i / stepsPerEdge) * height]);
  }

  const totalSamples = perimeter.length;
  const cx = width / 2;
  const cy = height / 2;
  const centerPt = invertPointSafe(cx, cy);
  const pts = [];
  const unclampedPts = [];
  let clampedCount = 0;

  for (let i = 0; i < totalSamples; i += 1) {
    const [bx, by] = perimeter[i];
    const directPt = invertPointSafe(bx, by);
    if (directPt) {
      pts.push(directPt);
      unclampedPts.push(directPt);
      continue;
    }

    let lo = 0;
    let bestPt = centerPt;
    if (!bestPt) {
      const nudgePt = invertPointSafe(cx + (bx - cx) * 0.02, cy + (by - cy) * 0.02);
      if (!nudgePt) continue;
      lo = 0.02;
      bestPt = nudgePt;
    }

    let hi = 1;
    for (let step = 0; step < 10; step += 1) {
      const mid = (lo + hi) * 0.5;
      const candidate = invertPointSafe(cx + (bx - cx) * mid, cy + (by - cy) * mid);
      if (candidate) {
        lo = mid;
        bestPt = candidate;
      } else {
        hi = mid;
      }
    }
    pts.push(bestPt);
    clampedCount += 1;
  }

  if (pts.length < 16) {
    return buildFallbackFootprint();
  }

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const uLon = unwrapNear(pts[i][0], centerLon);
    const lat = pts[i][1];
    if (uLon < minLon) minLon = uLon;
    if (uLon > maxLon) maxLon = uLon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const visLonSpan = maxLon - minLon;
  const visLatSpan = maxLat - minLat;

  const distSource =
    spec?.projection !== 'orthographic' && unclampedPts.length > 0 ? unclampedPts : pts;
  let maxCornerDistDeg = 0;
  for (let i = 0; i < distSource.length; i += 1) {
    const distDeg = (d3.geoDistance(distSource[i], [centerLon, centerLat]) * 180) / Math.PI;
    if (distDeg > maxCornerDistDeg) maxCornerDistDeg = distDeg;
  }

  if (spec?.projection === 'orthographic' && clampedCount >= totalSamples * 0.96) {
    if (lonDeg < 115 && latDeg < 120) {
      return buildFallbackFootprint(true);
    }
    const horizonCircle = d3.geoCircle().center([centerLon, centerLat]).radius(86)();
    return {
      feature: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: horizonCircle.coordinates[0] },
      },
      canFill: false,
      visLonSpan,
      visLatSpan,
      maxCornerDistDeg,
    };
  }

  const canFill =
    maxCornerDistDeg < 72 &&
    visLonSpan < 165 &&
    visLatSpan < 140 &&
    !(spec?.projection === 'orthographic' && clampedCount >= totalSamples * 0.95);

  const ring = [...pts, [...pts[0]]];
  let feature;
  if (canFill) {
    feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
    if (d3.geoArea(feature) > 2 * Math.PI) {
      ring.reverse();
    }
  } else {
    feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: ring },
    };
  }

  return {
    feature,
    canFill,
    visLonSpan,
    visLatSpan,
    maxCornerDistDeg,
  };
}

function measureScaleSpec(spec, projection, width, height, scaleFactor) {
  const units = spec?.ornaments?.scaleBar?.units === 'mi' ? 'mi' : 'km';
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = Number(spec?.center?.lat) || 0;

  let unitsPerPx = null;

  if (projection && typeof projection.invert === 'function') {
    const x1 = width * 0.35;
    const x2 = width * 0.65;
    const y = height * 0.5;
    const p1 = projection.invert([x1, y]);
    const p2 = projection.invert([x2, y]);

    const validPts =
      p1 &&
      p2 &&
      Number.isFinite(p1[0]) &&
      Number.isFinite(p1[1]) &&
      Number.isFinite(p2[0]) &&
      Number.isFinite(p2[1]);

    if (validPts) {
      const onFront =
        spec?.projection !== 'orthographic' ||
        (d3.geoDistance(p1, [centerLon, centerLat]) < Math.PI / 2 - 0.05 &&
          d3.geoDistance(p2, [centerLon, centerLat]) < Math.PI / 2 - 0.05);
      if (onFront) {
        const distKm = d3.geoDistance(p1, p2) * EARTH_RADIUS_KM;
        const distUnits = units === 'mi' ? distKm / KM_PER_MILE : distKm;
        if (distUnits > 0 && Number.isFinite(distUnits)) {
          unitsPerPx = distUnits / (x2 - x1);
        }
      }
    }
  }

  if (!unitsPerPx && projection) {
    const deltaLon = Math.min(8, Math.max(0.02, (Number(spec?.span?.lonDeg) || 24) * 0.1));
    const a = [wrapLon(centerLon - deltaLon), centerLat];
    const b = [wrapLon(centerLon + deltaLon), centerLat];
    const sa = projection(a);
    const sb = projection(b);
    if (sa && sb && Number.isFinite(sa[0]) && Number.isFinite(sb[0])) {
      const px = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]);
      if (px > 1) {
        const distKm = d3.geoDistance(a, b) * EARTH_RADIUS_KM;
        const distUnits = units === 'mi' ? distKm / KM_PER_MILE : distKm;
        unitsPerPx = distUnits / px;
      }
    }
  }

  if (!unitsPerPx || !Number.isFinite(unitsPerPx) || unitsPerPx <= 0) {
    const approxLonDeg = Number(spec?.span?.lonDeg) || 24;
    const distKm = approxLonDeg * 111.32 * Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
    const distUnits = units === 'mi' ? distKm / KM_PER_MILE : distKm;
    unitsPerPx = distUnits / Math.max(1, width);
  }

  const targetPx = width * 0.22;
  const minPx = Math.max(36, 44 * scaleFactor);
  const maxPx = width * 0.34;

  let bestValue = SCALE_CANDIDATES[0];
  let bestScore = Infinity;
  let foundInRange = false;

  for (let i = 0; i < SCALE_CANDIDATES.length; i += 1) {
    const val = SCALE_CANDIDATES[i];
    const px = val / unitsPerPx;
    const inRange = px >= minPx && px <= maxPx;
    const score = Math.abs(px - targetPx);
    if (inRange && (!foundInRange || score < bestScore)) {
      foundInRange = true;
      bestScore = score;
      bestValue = val;
    } else if (!foundInRange && score < bestScore) {
      bestScore = score;
      bestValue = val;
    }
  }

  const barPx = Math.max(28 * scaleFactor, Math.min(width * 0.42, bestValue / unitsPerPx));
  const padX = Math.max(12, 16 * scaleFactor);
  const padY = Math.max(6, 7 * scaleFactor);
  const barH = Math.max(4, 6 * scaleFactor);
  const fontSize = Math.max(8, 10.5 * scaleFactor);
  const boxW = Math.max(barPx + padX * 2, 86 * scaleFactor);
  const boxH = padY * 2 + barH + fontSize + 6 * scaleFactor;

  return {
    value: bestValue,
    units,
    barPx,
    barH,
    padX,
    padY,
    fontSize,
    boxW,
    boxH,
    showMid: bestValue >= 2 && barPx >= 80 * scaleFactor,
  };
}

function getLegendItems(spec) {
  const items = [];
  const colors = spec?.colors || {};
  const highlighted = Array.isArray(spec?.highlightedCountries) ? spec.highlightedCountries : [];
  for (let i = 0; i < highlighted.length; i += 1) {
    const hc = highlighted[i];
    const label = String(hc?.name || hc?.id || '').trim();
    if (!label) continue;
    items.push({
      kind: 'polygon',
      label,
      fill: hc.fill || colors.highlightFill || '#7a7d7a',
      stroke: hc.stroke || colors.highlightStroke || '#ffffff',
      hatch: hc.hatch || 'none',
      dashed: false,
    });
  }

  const shadows = Array.isArray(spec?.regionShadows) ? spec.regionShadows : [];
  for (let i = 0; i < shadows.length; i += 1) {
    const sh = shadows[i];
    if (!sh || sh.visible === false) continue;
    const label = String(sh.sourceName || sh.sourceId || '').trim();
    if (!label) continue;
    items.push({
      kind: 'overlay',
      label: `${label} (Shadow)`,
      fill: sh.fill || '#dc2626',
      fillOpacity: Number.isFinite(Number(sh.opacity)) ? Number(sh.opacity) : 0.35,
      stroke: sh.stroke || '#7f1d1d',
      hatch: sh.hatch || 'none',
      dashed: sh.dashed !== false,
    });
  }

  const overlays = Array.isArray(spec?.customGeoJsonLayers) ? spec.customGeoJsonLayers : [];
  for (let i = 0; i < overlays.length; i += 1) {
    const layer = overlays[i];
    if (layer?.visible === false || !layer?.data || layer?.role === 'land') continue;
    const strokeCol = layer.strokeColor && layer.strokeColor !== 'none'
      ? layer.strokeColor
      : (layer.color || '#222222');
    items.push({
      kind: 'overlay',
      label: String(layer.label || `Overlay ${i + 1}`),
      fill: layer.color || '#222222',
      fillOpacity: Number.isFinite(Number(layer.fillOpacity)) ? Number(layer.fillOpacity) : 0.45,
      stroke: strokeCol,
      hatch: layer.hatch || 'none',
      dashed: Boolean(layer.dashed),
    });
  }

  if (items.length === 0) {
    items.push(
      {
        kind: 'polygon',
        label: 'Land',
        fill: resolveOrnamentColor(colors.land, '#4a4a4a'),
        stroke: resolveOrnamentColor(colors.borders, '#ffffff'),
        hatch: 'none',
        dashed: false,
      },
      {
        kind: 'polygon',
        label: 'Water',
        fill: resolveOrnamentColor(colors.water, '#d1cfcf'),
        stroke: resolveOrnamentColor(colors.coastline, '#999999'),
        hatch: 'none',
        dashed: false,
      },
    );
  }

  return items;
}

function measureLegendBox(spec, width, scaleFactor, ctx = null) {
  const items = getLegendItems(spec);
  const fontSize = Math.max(8, 10.5 * scaleFactor);
  const rowH = Math.max(12, 16 * scaleFactor);
  const padX = Math.max(8, 10 * scaleFactor);
  const padY = Math.max(7, 8 * scaleFactor);
  const swatchW = Math.max(12, 16 * scaleFactor);
  const swatchGap = Math.max(6, 7 * scaleFactor);

  let maxLabelW = 48 * scaleFactor;
  if (ctx) {
    ctx.save();
    ctx.font = `500 ${fontSize}px ${FONT_FAMILY}`;
    for (let i = 0; i < items.length; i += 1) {
      maxLabelW = Math.max(maxLabelW, ctx.measureText(items[i].label).width);
    }
    ctx.restore();
  } else {
    for (let i = 0; i < items.length; i += 1) {
      maxLabelW = Math.max(maxLabelW, items[i].label.length * fontSize * 0.56);
    }
  }

  const maxAllowedW = width * 0.36;
  const boxW = Math.min(maxAllowedW, padX * 2 + swatchW + swatchGap + maxLabelW + 4 * scaleFactor);
  const boxH = padY * 2 + items.length * rowH;

  return { items, fontSize, rowH, padX, padY, swatchW, swatchGap, boxW, boxH };
}

function getTitleBannerBox(spec, width, scaleFactor, ctx = null) {
  if (!spec?.showTitle || !String(spec?.title || '').trim()) return null;
  const title = String(spec.title).trim();
  const margin = Math.round(width * 0.03);
  const fontSize = Math.max(11, 15 * scaleFactor);
  const padX = Math.max(12, 16 * scaleFactor);
  const padY = Math.max(6, 8 * scaleFactor);

  let textW = title.length * fontSize * 0.58;
  if (ctx) {
    ctx.save();
    ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
    textW = ctx.measureText(title).width;
    ctx.restore();
  }

  const maxBoxW = width * 0.72;
  const boxW = Math.min(maxBoxW, textW + padX * 2);
  const boxH = fontSize + padY * 2;
  const x = (width - boxW) / 2;
  const y = margin;

  return { title, fontSize, padX, padY, x, y, boxW, boxH };
}

function measureAltitudeScaleBox(spec, datasets, width, height, scaleFactor) {
  const dem = datasets === undefined
    ? { stats: { maxLandElev: 2000, p98LandElev: 2000 } }
    : datasets?.terrainRelief;
  const info = computeAltitudeScaleInfo(spec, dem);
  if (!info) return null;

  const textScale = Math.max(scaleFactor, Math.max(width, height * 0.78) / 900);
  const padX = Math.max(9, 11 * textScale);
  const padY = Math.max(7, 8 * textScale);
  const headerFont = Math.max(8, 9.2 * textScale);
  const tickFont = Math.max(7.5, 8.6 * textScale);
  const keyFont = Math.max(7.5, 8.5 * textScale);
  const barH = Math.max(8, 10 * textScale);
  const barW = Math.min(width * 0.36, Math.max(138 * textScale, 178 * textScale));
  const boxW = barW + padX * 2;
  const keyRowH = info.showContours ? keyFont + 6 * textScale : 0;
  const boxH =
    padY * 2 +
    headerFont +
    5 * textScale +
    barH +
    4 * textScale +
    tickFont +
    (keyRowH > 0 ? 5 * textScale + keyRowH : 0);

  return {
    info,
    textScale,
    padX,
    padY,
    headerFont,
    tickFont,
    keyFont,
    barW,
    barH,
    boxW,
    boxH,
  };
}

function getOrnamentSizes(spec, projection, datasets, width, height, scaleFactor, ctx = null) {
  const sizes = {};
  const orn = spec?.ornaments || {};

  if (orn.scaleBar?.enabled) {
    const scaleMeta = measureScaleSpec(spec, projection, width, height, scaleFactor);
    sizes.scaleBar = {
      position: orn.scaleBar.position || 'bottom-left',
      boxW: scaleMeta.boxW,
      boxH: scaleMeta.boxH,
      meta: scaleMeta,
    };
  }

  const altMeta = measureAltitudeScaleBox(spec, datasets, width, height, scaleFactor);
  if (altMeta) {
    sizes.altitudeScale = {
      position: altMeta.info.position || 'bottom-right',
      boxW: altMeta.boxW,
      boxH: altMeta.boxH,
      meta: altMeta,
    };
  }

  if (
    orn.locatorGlobe?.enabled &&
    (datasets === undefined || datasets?.locatorDetailLand || datasets?.locatorLand || datasets?.land)
  ) {
    const sizePct = Math.max(10, Math.min(40, Number(orn.locatorGlobe.sizePct) || 22));
    const diameter = width * (sizePct / 100);
    sizes.locatorGlobe = {
      position: orn.locatorGlobe.position || 'top-right',
      boxW: diameter,
      boxH: diameter,
      meta: { diameter, radius: diameter / 2 },
    };
  }

  if (orn.northArrow?.enabled) {
    sizes.northArrow = {
      position: orn.northArrow.position || 'top-left',
      boxW: 36 * scaleFactor,
      boxH: 48 * scaleFactor,
      meta: {},
    };
  }

  if (orn.legend?.enabled) {
    const legendMeta = measureLegendBox(spec, width, scaleFactor, ctx);
    sizes.legend = {
      position: orn.legend.position || 'bottom-right',
      boxW: legendMeta.boxW,
      boxH: legendMeta.boxH,
      meta: legendMeta,
    };
  }

  return sizes;
}

function computeCornerPositions(spec, projection, datasets, width, height, scaleFactor, ctx = null) {
  const sizes = getOrnamentSizes(spec, projection, datasets, width, height, scaleFactor, ctx);
  const titleBox = getTitleBannerBox(spec, width, scaleFactor, ctx);
  const margin = Math.round(width * 0.03);
  const gap = Math.max(6, Math.round(10 * scaleFactor));

  const order = ['scaleBar', 'altitudeScale', 'legend', 'northArrow', 'locatorGlobe'];
  const corners = {
    'bottom-left': [],
    'bottom-right': [],
    'top-left': [],
    'top-right': [],
  };

  for (let i = 0; i < order.length; i += 1) {
    const key = order[i];
    if (sizes[key]) {
      const pos = corners[sizes[key].position] ? sizes[key].position : 'bottom-left';
      corners[pos].push({ key, ...sizes[key] });
    }
  }

  const placements = {};

  for (const [corner, items] of Object.entries(corners)) {
    const isRight = corner.endsWith('right');
    const isBottom = corner.startsWith('bottom');

    let cursorY = isBottom ? height - margin : margin;

    if (!isBottom && titleBox && items.length > 0) {
      const widest = items.reduce((m, it) => Math.max(m, it.boxW), 0);
      const itemX1 = isRight ? width - margin - widest : margin;
      const itemX2 = itemX1 + widest;
      const overlapsTitle =
        itemX1 < titleBox.x + titleBox.boxW + gap && itemX2 > titleBox.x - gap;
      if (overlapsTitle) {
        cursorY = Math.max(cursorY, titleBox.y + titleBox.boxH + gap);
      }
    }

    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const x = isRight ? width - margin - it.boxW : margin;
      const y = isBottom ? cursorY - it.boxH : cursorY;
      placements[it.key] = {
        x,
        y,
        boxW: it.boxW,
        boxH: it.boxH,
        meta: it.meta,
      };
      if (isBottom) {
        cursorY = y - gap;
      } else {
        cursorY = y + it.boxH + gap;
      }
    }
  }

  return { placements, titleBox };
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function drawCanvasHatchInRect(ctx, hatch, color, x, y, w, h, scaleFactor) {
  if (!hatch || hatch === 'none') return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color || '#111111';
  ctx.fillStyle = color || '#111111';
  ctx.lineWidth = Math.max(0.8, 1 * scaleFactor);
  const step = Math.max(3, 4.5 * scaleFactor);
  if (hatch === 'diagonal' || hatch === 'cross') {
    ctx.beginPath();
    for (let d = -h; d <= w + h; d += step) {
      ctx.moveTo(x + d, y + h);
      ctx.lineTo(x + d + h, y);
    }
    ctx.stroke();
  }
  if (hatch === 'backdiagonal' || hatch === 'cross') {
    ctx.beginPath();
    for (let d = -h; d <= w + h; d += step) {
      ctx.moveTo(x + d, y);
      ctx.lineTo(x + d + h, y + h);
    }
    ctx.stroke();
  }
  if (hatch === 'dots') {
    const r = Math.max(0.7, 1 * scaleFactor);
    for (let px = x + step * 0.5; px < x + w; px += step) {
      for (let py = y + step * 0.5; py < y + h; py += step) {
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

export function drawScaleBar(ctx, spec, projection, width, height, scaleFactor) {
  if (!spec?.ornaments?.scaleBar?.enabled) return;
  const { placements } = computeCornerPositions(spec, projection, undefined, width, height, scaleFactor, ctx);
  const slot = placements.scaleBar;
  if (!slot) return;

  const { x, y, boxW, boxH, meta } = slot;
  const { value, units, barPx, barH, padY, fontSize, showMid } = meta;
  const barX = x + (boxW - barPx) / 2;
  const barY = y + padY;

  ctx.save();
  drawRoundedRect(ctx, x, y, boxW, boxH, 4 * scaleFactor);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.90)';
  ctx.fill();
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.8, 1.0 * scaleFactor);
  ctx.stroke();

  const segs = 4;
  const segW = barPx / segs;
  for (let i = 0; i < segs; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? '#111111' : '#ffffff';
    ctx.fillRect(barX + i * segW, barY, segW, barH);
  }
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.8, 1.0 * scaleFactor);
  ctx.strokeRect(barX, barY, barPx, barH);

  ctx.fillStyle = '#111111';
  ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  const labelY = barY + barH + 4 * scaleFactor;

  ctx.textAlign = 'left';
  ctx.fillText('0', barX, labelY);

  if (showMid) {
    ctx.textAlign = 'center';
    ctx.fillText(formatScaleMid(value, units), barX + barPx / 2, labelY);
  }

  ctx.textAlign = 'right';
  ctx.fillText(formatScaleLabel(value, units), barX + barPx, labelY);
  ctx.restore();
}

function formatAltitudeTick(val) {
  return Math.round(val).toLocaleString('en-US');
}

export function drawAltitudeScale(ctx, spec, datasets, projection, width, height, scaleFactor) {
  if (!spec?.terrainRelief?.enabled || spec?.terrainRelief?.showAltitudeScale === false || !datasets?.terrainRelief) {
    return;
  }
  const { placements } = computeCornerPositions(spec, projection, datasets, width, height, scaleFactor, ctx);
  const slot = placements.altitudeScale;
  if (!slot) return;

  const { x, y, boxW, boxH, meta } = slot;
  const { info, textScale, padX, padY, headerFont, tickFont, keyFont, barW, barH } = meta;
  const contourPalette = resolveContourPalette('#f4f0e6', info.style, {
    contourColor: info.contourColor,
    tone: info.tone,
    contrast: info.contrast,
  });
  const barX = x + padX;
  const headerY = y + padY;
  const barY = headerY + headerFont + 5 * textScale;
  const tickLabelY = barY + barH + 4 * textScale;

  ctx.save();
  drawRoundedRect(ctx, x, y, boxW, boxH, 4 * scaleFactor);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fill();
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.8, 1.0 * scaleFactor);
  ctx.stroke();

  // Header row: "ALTITUDE (m)" + "▲ Peak"
  ctx.fillStyle = '#111111';
  ctx.font = `700 ${headerFont.toFixed(1)}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('ALTITUDE (m)', barX, headerY);

  ctx.fillStyle = contourPalette.indexColor;
  ctx.textAlign = 'right';
  ctx.fillText(`▲ ${formatAltitudeTick(info.maxElev)} m`, barX + barW, headerY);

  // Altitude scale bar fill: 1:1 exact match with rendered altitude shading,
  // or a clean neutral graduated ruler for slope-only / contour-only styles
  if (info.hasHypsometric) {
    const slices = 48;
    const sliceW = barW / slices;
    for (let i = 0; i < slices; i += 1) {
      const e = ((i + 0.5) / slices) * info.scaleMax;
      ctx.fillStyle = sampleAltitudeRampColor(e, info.scaleMax, {
        style: info.style,
        tone: info.tone,
        contrast: info.contrast,
      });
      ctx.fillRect(barX + i * sliceW, barY, sliceW + 0.5, barH);
    }
  } else {
    const bandCount = Math.max(2, Math.min(8, Math.round(info.scaleMax / info.tickStep)));
    const bandW = barW / bandCount;
    for (let i = 0; i < bandCount; i += 1) {
      ctx.fillStyle = i % 2 === 0 ? '#f6f4ef' : '#e5e2da';
      ctx.fillRect(barX + i * bandW, barY, bandW + 0.5, barH);
    }
  }

  // Contour interval tick lines across the bar
  if (info.showContours && info.interval > 0) {
    for (let v = info.interval; v < info.scaleMax; v += info.interval) {
      const tx = barX + (v / info.scaleMax) * barW;
      const isIdx = v % info.indexInterval === 0;
      ctx.beginPath();
      ctx.moveTo(tx, barY);
      ctx.lineTo(tx, barY + barH + (isIdx ? 2.5 * textScale : 0));
      ctx.strokeStyle = isIdx ? contourPalette.indexColor : contourPalette.intermediateColor;
      ctx.lineWidth = isIdx ? Math.max(1.0, 1.5 * textScale) : Math.max(0.5, 0.75 * textScale);
      ctx.globalAlpha = isIdx ? 0.92 : 0.6;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Bar border
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.75, 0.95 * scaleFactor);
  ctx.strokeRect(barX, barY, barW, barH);

  // Peak marker triangle on top edge of bar
  const peakFrac = Math.min(1, Math.max(0, info.maxElev / info.scaleMax));
  const peakX = barX + peakFrac * barW;
  const triSz = Math.max(2.6, 3.2 * textScale);
  ctx.beginPath();
  ctx.moveTo(peakX, barY + 0.5);
  ctx.lineTo(peakX - triSz * 0.75, barY - triSz);
  ctx.lineTo(peakX + triSz * 0.75, barY - triSz);
  ctx.closePath();
  ctx.fillStyle = contourPalette.indexColor;
  ctx.fill();

  // Altitude tick labels
  ctx.fillStyle = '#111111';
  ctx.font = `600 ${tickFont.toFixed(1)}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  const ticks = info.ticks;
  for (let i = 0; i < ticks.length; i += 1) {
    const val = ticks[i];
    const tx = barX + (val / info.scaleMax) * barW;
    ctx.textAlign = i === 0 ? 'left' : (i === ticks.length - 1 ? 'right' : 'center');
    const lbl = i === ticks.length - 1 ? `${formatAltitudeTick(val)}m` : formatAltitudeTick(val);
    ctx.fillText(lbl, tx, tickLabelY);
  }

  // Optional contour key row (Index + CI)
  if (info.showContours) {
    const keyY = tickLabelY + tickFont + 5 * textScale;
    const midY = keyY + keyFont * 0.52;
    const swLen = Math.max(11, 14 * textScale);

    // Index contour swatch
    ctx.beginPath();
    ctx.moveTo(barX, midY);
    ctx.lineTo(barX + swLen, midY);
    ctx.strokeStyle = contourPalette.indexColor;
    ctx.lineWidth = Math.max(1.2, 1.8 * textScale);
    ctx.stroke();

    ctx.fillStyle = '#222222';
    ctx.font = `600 ${keyFont.toFixed(1)}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(`Index ${formatAltitudeTick(info.indexInterval)}m`, barX + swLen + 4 * textScale, keyY);

    // Intermediate contour CI swatch on right side
    const ciText = `CI ${formatAltitudeTick(info.interval)}m`;
    const ciTextW = ctx.measureText(ciText).width;
    const ciLineEnd = barX + barW - ciTextW - 4 * textScale;
    const ciLineStart = ciLineEnd - swLen;
    if (ciLineStart > barX + swLen + 52 * textScale) {
      ctx.beginPath();
      ctx.moveTo(ciLineStart, midY);
      ctx.lineTo(ciLineEnd, midY);
      ctx.strokeStyle = contourPalette.intermediateColor;
      ctx.lineWidth = Math.max(0.65, 0.9 * textScale);
      ctx.stroke();
    }
    ctx.textAlign = 'right';
    ctx.fillText(ciText, barX + barW, keyY);
  }

  ctx.restore();
}

export function resolveLocatorGlobeZoom(spec, footprint = null) {
  const globeSpec = spec?.ornaments?.locatorGlobe || {};
  const mode = globeSpec.zoomMode || 'auto';
  if (mode === 'hemisphere') return 1.0;
  if (mode === 'nearside') return 1.8;
  if (mode === 'custom') {
    return Math.min(6.0, Math.max(1.0, Number(globeSpec.zoom) || 2.0));
  }
  const baseSpan = estimateEffectiveSpanDeg(spec);
  const effectiveSpan =
    footprint && Number.isFinite(footprint.maxCornerDistDeg) && footprint.maxCornerDistDeg > 0
      ? Math.max(baseSpan, footprint.maxCornerDistDeg * 2.2)
      : baseSpan;
  return Math.min(4.2, Math.max(1.0, 56 / Math.max(6, effectiveSpan)));
}

export function buildLocatorGlobeProjection(
  spec,
  cx,
  cy,
  globeRadius,
  effectiveZoomOverride = null,
) {
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = Number(spec?.center?.lat) || 0;
  const effectiveZoom = effectiveZoomOverride ?? resolveLocatorGlobeZoom(spec);
  if (effectiveZoom <= 1.03) {
    return d3
      .geoOrthographic()
      .rotate([-centerLon, -centerLat])
      .translate([cx, cy])
      .scale(globeRadius)
      .clipAngle(90)
      .precision(0);
  }
  const thetaH = Math.PI / (2 * effectiveZoom);
  const pDist = 1 / Math.cos(thetaH);
  const thetaClip = thetaH - 0.0005;
  const clipDeg = (thetaClip * 180) / Math.PI;
  const rClip = ((pDist - 1) * Math.sin(thetaClip)) / (pDist - Math.cos(thetaClip));
  return geoSatellite()
    .distance(pDist)
    .tilt(0)
    .rotate([-centerLon, -centerLat, 0])
    .translate([cx, cy])
    .scale((globeRadius + 0.5) / rClip)
    .clipAngle(clipDeg)
    .precision(0);
}

function selectLocatorDatasets(datasets, effectiveZoom) {
  if (effectiveZoom >= 1.35) {
    return {
      land:
        datasets?.locatorDetailLand ||
        (datasets?.resolution === '50m' ? datasets.land : null) ||
        datasets?.locatorLand ||
        datasets?.land ||
        null,
      borders:
        datasets?.locatorDetailBorders ||
        (datasets?.resolution === '50m' ? datasets.internalBorders : null) ||
        datasets?.locatorBorders ||
        (!datasets?.locatorLand ? datasets?.internalBorders : null) ||
        null,
    };
  }
  return {
    land: datasets?.locatorLand || datasets?.land || null,
    borders:
      datasets?.locatorBorders || (!datasets?.locatorLand ? datasets?.internalBorders : null) || null,
  };
}

function renderLocatorGlobeToCanvas(
  ctx,
  spec,
  datasets,
  cx,
  cy,
  radius,
  scaleFactor,
  footprint = null,
) {
  const fp = footprint || computeTrueViewportFootprint(spec, null, 0, 0);
  const effectiveZoom = resolveLocatorGlobeZoom(spec, fp);
  const { land: locatorLand, borders: locatorBorders } = selectLocatorDatasets(datasets, effectiveZoom);
  if (!locatorLand) return;

  const globeRadius = Math.max(4, radius - 2 * scaleFactor);
  const globeProj = buildLocatorGlobeProjection(spec, cx, cy, globeRadius, effectiveZoom);
  const path = d3.geoPath(globeProj, ctx);
  const colors = spec?.colors || {};
  const globeSpec = spec?.ornaments?.locatorGlobe || {};

  ctx.save();
  // Outer white halo so globe separates cleanly from underlying map colors
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, globeRadius, 0, Math.PI * 2);
  ctx.clip();

  ctx.beginPath();
  ctx.arc(cx, cy, globeRadius, 0, Math.PI * 2);
  ctx.fillStyle = resolveOrnamentColor(colors.water, '#d1cfcf');
  ctx.fill();

  ctx.beginPath();
  path(locatorLand);
  ctx.fillStyle = resolveOrnamentColor(colors.land, '#4a4a4a');
  ctx.fill();

  if (locatorBorders) {
    ctx.beginPath();
    path(locatorBorders);
    ctx.strokeStyle = resolveOrnamentColor(colors.borders, '#ffffff');
    ctx.lineWidth = Math.max(0.35, 0.55 * scaleFactor);
    ctx.stroke();
  }

  if (globeSpec.showExtentBox !== false) {
    const ring = fp.feature;
    globeProj.precision(0.5);
    const bounds = path.bounds(ring);
    const boxPixelSpan = Math.max(
      Math.abs(bounds[1][0] - bounds[0][0]),
      Math.abs(bounds[1][1] - bounds[0][1]),
    );

    ctx.beginPath();
    path(ring);
    globeProj.precision(0);
    if (fp.canFill) {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.24)';
      ctx.fill();
    }
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = Math.max(1.1, 1.8 * scaleFactor);
    ctx.stroke();

    if (!Number.isFinite(boxPixelSpan) || boxPixelSpan < 6 * scaleFactor) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2.5, 3.2 * scaleFactor), 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(0.8, 1 * scaleFactor);
      ctx.stroke();
    }
  }
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, globeRadius, 0, Math.PI * 2);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.9, 1.3 * scaleFactor);
  ctx.stroke();
  ctx.restore();
}

export function drawLocatorGlobe(
  ctx,
  spec,
  datasets,
  width,
  height,
  scaleFactor,
  projection = null,
) {
  if (!spec?.ornaments?.locatorGlobe?.enabled) return;
  const footprint = computeTrueViewportFootprint(spec, projection, width, height);
  const effectiveZoom = resolveLocatorGlobeZoom(spec, footprint);
  const { land: locatorLand, borders: locatorBorders } = selectLocatorDatasets(datasets, effectiveZoom);
  if (!locatorLand) return;
  const { placements } = computeCornerPositions(spec, projection, datasets, width, height, scaleFactor, ctx);
  const slot = placements.locatorGlobe;
  if (!slot) return;

  const { x, y, meta } = slot;
  const { diameter, radius } = meta;
  if (!(diameter > 0) || !(radius > 0)) return;

  if (typeof document === 'undefined') {
    renderLocatorGlobeToCanvas(
      ctx,
      spec,
      datasets,
      x + radius,
      y + radius,
      radius,
      scaleFactor,
      footprint,
    );
    return;
  }

  const globeSpec = spec?.ornaments?.locatorGlobe || {};
  const colors = spec?.colors || {};
  const centerLon = Number(spec?.center?.lon) || 0;
  const centerLat = Number(spec?.center?.lat) || 0;
  const lonDeg = Number(spec?.span?.lonDeg) || 24;
  const latDeg = Number(spec?.span?.latDeg) || 14;
  const aspectRatio = (width / Math.max(1, height)).toFixed(3);
  const zoomMode = globeSpec.zoomMode || 'auto';
  const hasDetail =
    effectiveZoom >= 1.35 && Boolean(datasets?.locatorDetailLand || datasets?.resolution === '50m');

  const ctxTransform = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const ctxScale = ctxTransform ? Math.hypot(ctxTransform.a, ctxTransform.b) : 1;
  const winDpr =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio
      : 1;
  const dpr = Math.max(1, Math.min(2, Math.max(ctxScale || 1, winDpr)));
  const pixelSize = Math.max(1, Math.round(diameter * dpr));

  const cacheKey = `${centerLon.toFixed(2)}|${centerLat.toFixed(2)}|${lonDeg.toFixed(2)}|${latDeg.toFixed(2)}|${aspectRatio}|${zoomMode}|${Math.round(diameter)}|${colors.water}|${colors.land}|${colors.borders}|${colors.highlightStroke}|${globeSpec.showExtentBox !== false}|${spec?.projection}|${Boolean(locatorBorders)}|${pixelSize}|${scaleFactor.toFixed(2)}|${effectiveZoom.toFixed(2)}|${hasDetail}|${Boolean(projection)}`;

  if (locatorGlobeCache.key === cacheKey && locatorGlobeCache.canvas) {
    ctx.drawImage(locatorGlobeCache.canvas, x, y, diameter, diameter);
    return;
  }

  const offscreen = locatorGlobeCache.canvas || document.createElement('canvas');
  if (offscreen.width !== pixelSize || offscreen.height !== pixelSize) {
    offscreen.width = pixelSize;
    offscreen.height = pixelSize;
  }
  const octx = offscreen.getContext('2d');
  if (!octx) {
    renderLocatorGlobeToCanvas(
      ctx,
      spec,
      datasets,
      x + radius,
      y + radius,
      radius,
      scaleFactor,
      footprint,
    );
    return;
  }

  const renderScale = pixelSize / diameter;
  octx.save();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, pixelSize, pixelSize);
  octx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  renderLocatorGlobeToCanvas(octx, spec, datasets, radius, radius, radius, scaleFactor, footprint);
  octx.restore();

  locatorGlobeCache.key = cacheKey;
  locatorGlobeCache.canvas = offscreen;
  ctx.drawImage(offscreen, x, y, diameter, diameter);
}

export function drawNorthArrow(ctx, spec, width, height, scaleFactor) {
  if (!spec?.ornaments?.northArrow?.enabled) return;
  const { placements } = computeCornerPositions(spec, null, undefined, width, height, scaleFactor, ctx);
  const slot = placements.northArrow;
  if (!slot) return;

  const { x, y, boxW, boxH } = slot;
  const cx = x + boxW / 2;

  ctx.save();
  drawRoundedRect(ctx, x, y, boxW, boxH, 4 * scaleFactor);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.90)';
  ctx.fill();
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.8, 1.0 * scaleFactor);
  ctx.stroke();

  const fontSize = Math.max(8, 10.5 * scaleFactor);
  ctx.fillStyle = '#111111';
  ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('N', cx, y + 4 * scaleFactor);

  const tipY = y + fontSize + 6 * scaleFactor;
  const baseY = y + boxH - 6 * scaleFactor;
  const notchY = baseY - (baseY - tipY) * 0.25;
  const halfW = boxW * 0.26;

  // Left half (filled black)
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx - halfW, baseY);
  ctx.lineTo(cx, notchY);
  ctx.closePath();
  ctx.fillStyle = '#111111';
  ctx.fill();
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.7, 0.9 * scaleFactor);
  ctx.stroke();

  // Right half (white)
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx + halfW, baseY);
  ctx.lineTo(cx, notchY);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

export function drawLegend(ctx, spec, width, height, scaleFactor) {
  if (!spec?.ornaments?.legend?.enabled) return;
  const { placements } = computeCornerPositions(spec, null, undefined, width, height, scaleFactor, ctx);
  const slot = placements.legend;
  if (!slot) return;

  const { x, y, boxW, boxH, meta } = slot;
  const { items, fontSize, rowH, padX, padY, swatchW, swatchGap } = meta;

  ctx.save();
  drawRoundedRect(ctx, x, y, boxW, boxH, 4 * scaleFactor);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fill();
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.8, 1.0 * scaleFactor);
  ctx.stroke();

  ctx.font = `500 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const swatchH = Math.max(7, rowH * 0.62);
  const maxTextW = boxW - padX * 2 - swatchW - swatchGap;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const rowY = y + padY + i * rowH;
    const swX = x + padX;
    const swY = rowY + (rowH - swatchH) / 2;

    if (item.kind === 'overlay') {
      ctx.save();
      ctx.globalAlpha = item.fillOpacity ?? 0.45;
      ctx.fillStyle = item.fill;
      ctx.fillRect(swX, swY, swatchW, swatchH);
      ctx.restore();
      if (item.hatch && item.hatch !== 'none') {
        drawCanvasHatchInRect(ctx, item.hatch, item.stroke, swX, swY, swatchW, swatchH, scaleFactor);
      }
      ctx.save();
      ctx.strokeStyle = item.stroke;
      ctx.lineWidth = Math.max(0.8, 1.1 * scaleFactor);
      if (item.dashed) ctx.setLineDash([3 * scaleFactor, 2 * scaleFactor]);
      ctx.strokeRect(swX, swY, swatchW, swatchH);
      ctx.restore();
    } else {
      ctx.fillStyle = item.fill;
      ctx.fillRect(swX, swY, swatchW, swatchH);
      if (item.hatch && item.hatch !== 'none') {
        drawCanvasHatchInRect(ctx, item.hatch, item.stroke, swX, swY, swatchW, swatchH, scaleFactor);
      }
      ctx.strokeStyle = item.stroke === '#ffffff' ? '#333333' : item.stroke;
      ctx.lineWidth = Math.max(0.7, 0.9 * scaleFactor);
      ctx.strokeRect(swX, swY, swatchW, swatchH);
    }

    ctx.fillStyle = '#111111';
    let label = item.label;
    if (ctx.measureText(label).width > maxTextW) {
      while (label.length > 2 && ctx.measureText(`${label}…`).width > maxTextW) {
        label = label.slice(0, -1);
      }
      label = `${label}…`;
    }
    ctx.fillText(label, swX + swatchW + swatchGap, rowY + rowH / 2);
  }

  ctx.restore();
}

export function drawTitleBanner(ctx, spec, width, height, scaleFactor) {
  const titleBox = getTitleBannerBox(spec, width, scaleFactor, ctx);
  if (!titleBox) return;

  const { title, fontSize, x, y, boxW, boxH, padX } = titleBox;

  ctx.save();
  drawRoundedRect(ctx, x, y, boxW, boxH, 5 * scaleFactor);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fill();
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = Math.max(0.9, 1.2 * scaleFactor);
  ctx.stroke();

  ctx.fillStyle = '#111111';
  ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let text = title;
  const maxTextW = boxW - padX * 2;
  if (ctx.measureText(text).width > maxTextW) {
    while (text.length > 2 && ctx.measureText(`${text}…`).width > maxTextW) {
      text = text.slice(0, -1);
    }
    text = `${text}…`;
  }
  ctx.fillText(text, x + boxW / 2, y + boxH / 2);
  ctx.restore();
}

function buildSvgSwatchHatch(hatch, color, id, scaleFactor) {
  if (!hatch || hatch === 'none') return '';
  const size = Math.max(4, 5 * scaleFactor);
  const sw = Math.max(0.7, 0.9 * scaleFactor);
  const col = escapeXml(color || '#111111');
  let body = '';
  if (hatch === 'diagonal' || hatch === 'cross') {
    body += `<path d="M0,${size} L${size},0 M-${size * 0.5},${size * 0.5} L${size * 0.5},-${size * 0.5} M${size * 0.5},${size * 1.5} L${size * 1.5},${size * 0.5}" stroke="${col}" stroke-width="${sw}" />`;
  }
  if (hatch === 'backdiagonal' || hatch === 'cross') {
    body += `<path d="M0,0 L${size},${size} M-${size * 0.5},${size * 0.5} L${size * 0.5},${size * 1.5} M${size * 0.5},-${size * 0.5} L${size * 1.5},${size * 0.5}" stroke="${col}" stroke-width="${sw}" />`;
  }
  if (hatch === 'dots') {
    body += `<circle cx="${size * 0.5}" cy="${size * 0.5}" r="${Math.max(0.7, 0.9 * scaleFactor)}" fill="${col}" />`;
  }
  return `<pattern id="${escapeXml(id)}" width="${size}" height="${size}" patternUnits="userSpaceOnUse">${body}</pattern>`;
}

export function buildOrnamentsSvg(spec, projection, datasets, width, height, scaleFactor) {
  const { placements, titleBox } = computeCornerPositions(
    spec,
    projection,
    datasets,
    width,
    height,
    scaleFactor,
    null,
  );
  const parts = ['<g class="map-ornaments">'];

  // 1. Scale bar
  if (placements.scaleBar) {
    const { x, y, boxW, boxH, meta } = placements.scaleBar;
    const { value, units, barPx, barH, padY, fontSize, showMid } = meta;
    const barX = x + (boxW - barPx) / 2;
    const barY = y + padY;
    const labelY = barY + barH + 4 * scaleFactor + fontSize * 0.85;
    const segW = barPx / 4;
    const r = 4 * scaleFactor;
    const strokeW = Math.max(0.8, 1.0 * scaleFactor);

    parts.push(`<g class="ornament-scalebar">`);
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="${r.toFixed(2)}" fill="rgba(255,255,255,0.90)" stroke="#111111" stroke-width="${strokeW.toFixed(2)}" />`,
    );
    for (let i = 0; i < 4; i += 1) {
      const fill = i % 2 === 0 ? '#111111' : '#ffffff';
      parts.push(
        `<rect x="${(barX + i * segW).toFixed(2)}" y="${barY.toFixed(2)}" width="${segW.toFixed(2)}" height="${barH.toFixed(2)}" fill="${fill}" />`,
      );
    }
    parts.push(
      `<rect x="${barX.toFixed(2)}" y="${barY.toFixed(2)}" width="${barPx.toFixed(2)}" height="${barH.toFixed(2)}" fill="none" stroke="#111111" stroke-width="${strokeW.toFixed(2)}" />`,
    );
    parts.push(
      `<text x="${barX.toFixed(2)}" y="${labelY.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize.toFixed(1)}" font-weight="600" fill="#111111" text-anchor="start">0</text>`,
    );
    if (showMid) {
      parts.push(
        `<text x="${(barX + barPx / 2).toFixed(2)}" y="${labelY.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize.toFixed(1)}" font-weight="600" fill="#111111" text-anchor="middle">${escapeXml(formatScaleMid(value, units))}</text>`,
      );
    }
    parts.push(
      `<text x="${(barX + barPx).toFixed(2)}" y="${labelY.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize.toFixed(1)}" font-weight="600" fill="#111111" text-anchor="end">${escapeXml(formatScaleLabel(value, units))}</text>`,
    );
    parts.push('</g>');
  }

  // 2. Locator Globe
  if (placements.locatorGlobe) {
    const svgFootprint = computeTrueViewportFootprint(spec, projection, width, height);
    const svgEffectiveZoom = resolveLocatorGlobeZoom(spec, svgFootprint);
    const { land: svgLocatorLand, borders: svgLocatorBorders } = selectLocatorDatasets(
      datasets,
      svgEffectiveZoom,
    );
    if (svgLocatorLand) {
      const { x, y, meta } = placements.locatorGlobe;
      const { radius } = meta;
      const cx = x + radius;
      const cy = y + radius;
      const globeRadius = Math.max(4, radius - 2 * scaleFactor);
      const globeProj = buildLocatorGlobeProjection(spec, cx, cy, globeRadius, svgEffectiveZoom);
      const svgPath = d3.geoPath(globeProj);
      const colors = spec?.colors || {};
      const clipId = 'locator-globe-clip';

      parts.push('<g class="ornament-locator-globe">');
      parts.push(
        `<defs><clipPath id="${clipId}"><circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${globeRadius.toFixed(2)}" /></clipPath></defs>`,
      );
      parts.push(
        `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgba(255,255,255,0.92)" />`,
      );
      parts.push(`<g clip-path="url(#${clipId})">`);
      parts.push(
        `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${globeRadius.toFixed(2)}" fill="${escapeXml(resolveOrnamentColor(colors.water, '#d1cfcf'))}" />`,
      );
      const landD = svgPath(svgLocatorLand) || '';
      if (landD) {
        parts.push(`<path d="${landD}" fill="${escapeXml(resolveOrnamentColor(colors.land, '#4a4a4a'))}" />`);
      }
      if (svgLocatorBorders) {
        const borderD = svgPath(svgLocatorBorders) || '';
        if (borderD) {
          parts.push(
            `<path d="${borderD}" fill="none" stroke="${escapeXml(resolveOrnamentColor(colors.borders, '#ffffff'))}" stroke-width="${Math.max(0.35, 0.55 * scaleFactor).toFixed(2)}" />`,
          );
        }
      }
      if (spec?.ornaments?.locatorGlobe?.showExtentBox !== false) {
        const ring = svgFootprint.feature;
        globeProj.precision(0.5);
        const ringD = svgPath(ring) || '';
        const bounds = svgPath.bounds(ring);
        globeProj.precision(0);
        const boxPixelSpan = Math.max(
          Math.abs(bounds[1][0] - bounds[0][0]),
          Math.abs(bounds[1][1] - bounds[0][1]),
        );
        if (ringD) {
          parts.push(
            `<path d="${ringD}" fill="${svgFootprint.canFill ? 'rgba(220,38,38,0.24)' : 'none'}" stroke="#dc2626" stroke-width="${Math.max(1.1, 1.8 * scaleFactor).toFixed(2)}" />`,
          );
        }
        if (!Number.isFinite(boxPixelSpan) || boxPixelSpan < 6 * scaleFactor) {
          parts.push(
            `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${Math.max(2.5, 3.2 * scaleFactor).toFixed(2)}" fill="#dc2626" stroke="#ffffff" stroke-width="${Math.max(0.8, 1 * scaleFactor).toFixed(2)}" />`,
          );
        }
      }
      parts.push('</g>');
      parts.push(
        `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${globeRadius.toFixed(2)}" fill="none" stroke="#111111" stroke-width="${Math.max(0.9, 1.3 * scaleFactor).toFixed(2)}" />`,
      );
      parts.push('</g>');
    }
  }

  // 3. North Arrow
  if (placements.northArrow) {
    const { x, y, boxW, boxH } = placements.northArrow;
    const cx = x + boxW / 2;
    const r = 4 * scaleFactor;
    const strokeW = Math.max(0.8, 1.0 * scaleFactor);
    const fontSize = Math.max(8, 10.5 * scaleFactor);
    const tipY = y + fontSize + 6 * scaleFactor;
    const baseY = y + boxH - 6 * scaleFactor;
    const notchY = baseY - (baseY - tipY) * 0.25;
    const halfW = boxW * 0.26;
    const arrowStroke = Math.max(0.7, 0.9 * scaleFactor);

    parts.push('<g class="ornament-north-arrow">');
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="${r.toFixed(2)}" fill="rgba(255,255,255,0.90)" stroke="#111111" stroke-width="${strokeW.toFixed(2)}" />`,
    );
    parts.push(
      `<text x="${cx.toFixed(2)}" y="${(y + 4 * scaleFactor + fontSize * 0.88).toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize.toFixed(1)}" font-weight="700" fill="#111111" text-anchor="middle">N</text>`,
    );
    parts.push(
      `<polygon points="${cx.toFixed(2)},${tipY.toFixed(2)} ${(cx - halfW).toFixed(2)},${baseY.toFixed(2)} ${cx.toFixed(2)},${notchY.toFixed(2)}" fill="#111111" stroke="#111111" stroke-width="${arrowStroke.toFixed(2)}" />`,
    );
    parts.push(
      `<polygon points="${cx.toFixed(2)},${tipY.toFixed(2)} ${(cx + halfW).toFixed(2)},${baseY.toFixed(2)} ${cx.toFixed(2)},${notchY.toFixed(2)}" fill="#ffffff" stroke="#111111" stroke-width="${arrowStroke.toFixed(2)}" />`,
    );
    parts.push('</g>');
  }

  // 4. Legend
  if (placements.legend) {
    const { x, y, boxW, boxH, meta } = placements.legend;
    const { items, fontSize, rowH, padX, padY, swatchW, swatchGap } = meta;
    const r = 4 * scaleFactor;
    const strokeW = Math.max(0.8, 1.0 * scaleFactor);
    const swatchH = Math.max(7, rowH * 0.62);

    const defs = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].hatch && items[i].hatch !== 'none') {
        defs.push(buildSvgSwatchHatch(items[i].hatch, items[i].stroke, `leg_hatch_${i}`, scaleFactor));
      }
    }

    parts.push('<g class="ornament-legend">');
    if (defs.length > 0) {
      parts.push(`<defs>${defs.join('')}</defs>`);
    }
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="${r.toFixed(2)}" fill="rgba(255,255,255,0.92)" stroke="#111111" stroke-width="${strokeW.toFixed(2)}" />`,
    );
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const rowY = y + padY + i * rowH;
      const swX = x + padX;
      const swY = rowY + (rowH - swatchH) / 2;
      const textY = rowY + rowH / 2 + fontSize * 0.35;
      const fillOp = item.kind === 'overlay' ? (item.fillOpacity ?? 0.45) : 1;
      const swStroke = item.kind === 'overlay' ? item.stroke : (item.stroke === '#ffffff' ? '#333333' : item.stroke);
      const dashAttr = item.dashed ? ` stroke-dasharray="${(3 * scaleFactor).toFixed(1)},${(2 * scaleFactor).toFixed(1)}"` : '';

      parts.push(
        `<rect x="${swX.toFixed(2)}" y="${swY.toFixed(2)}" width="${swatchW.toFixed(2)}" height="${swatchH.toFixed(2)}" fill="${escapeXml(item.fill)}" fill-opacity="${fillOp}" stroke="${escapeXml(swStroke)}" stroke-width="${Math.max(0.7, 0.9 * scaleFactor).toFixed(2)}"${dashAttr} />`,
      );
      if (item.hatch && item.hatch !== 'none') {
        parts.push(
          `<rect x="${swX.toFixed(2)}" y="${swY.toFixed(2)}" width="${swatchW.toFixed(2)}" height="${swatchH.toFixed(2)}" fill="url(#leg_hatch_${i})" />`,
        );
      }
      parts.push(
        `<text x="${(swX + swatchW + swatchGap).toFixed(2)}" y="${textY.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize.toFixed(1)}" font-weight="500" fill="#111111">${escapeXml(item.label)}</text>`,
      );
    }
    parts.push('</g>');
  }

  // 4b. Altitude Scale (for active Terrain Relief)
  if (placements.altitudeScale) {
    const { x, y, boxW, boxH, meta } = placements.altitudeScale;
    const { info, textScale, padX, padY, headerFont, tickFont, keyFont, barW, barH } = meta;
    const contourPalette = resolveContourPalette('#f4f0e6', info.style, {
      contourColor: info.contourColor,
      tone: info.tone,
      contrast: info.contrast,
    });
    const r = 4 * scaleFactor;
    const strokeW = Math.max(0.8, 1.0 * scaleFactor);
    const barX = x + padX;
    const headerY = y + padY;
    const barY = headerY + headerFont + 5 * textScale;
    const tickLabelY = barY + barH + 4 * textScale;

    parts.push('<g class="ornament-altitude-scale">');
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="${r.toFixed(2)}" fill="rgba(255,255,255,0.92)" stroke="#111111" stroke-width="${strokeW.toFixed(2)}" />`,
    );
    parts.push(
      `<text x="${barX.toFixed(2)}" y="${(headerY + headerFont * 0.86).toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${headerFont.toFixed(1)}" font-weight="700" fill="#111111" text-anchor="start">ALTITUDE (m)</text>`,
    );
    parts.push(
      `<text x="${(barX + barW).toFixed(2)}" y="${(headerY + headerFont * 0.86).toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${headerFont.toFixed(1)}" font-weight="700" fill="${escapeXml(contourPalette.indexColor)}" text-anchor="end">▲ ${escapeXml(formatAltitudeTick(info.maxElev))} m</text>`,
    );

    if (info.hasHypsometric) {
      const slices = 48;
      const sliceW = barW / slices;
      for (let i = 0; i < slices; i += 1) {
        const e = ((i + 0.5) / slices) * info.scaleMax;
        const fill = sampleAltitudeRampColor(e, info.scaleMax, {
          style: info.style,
          tone: info.tone,
          contrast: info.contrast,
        });
        parts.push(
          `<rect x="${(barX + i * sliceW).toFixed(2)}" y="${barY.toFixed(2)}" width="${(sliceW + 0.4).toFixed(2)}" height="${barH.toFixed(2)}" fill="${escapeXml(fill)}" />`,
        );
      }
    } else {
      const bandCount = Math.max(2, Math.min(8, Math.round(info.scaleMax / info.tickStep)));
      const bandW = barW / bandCount;
      for (let i = 0; i < bandCount; i += 1) {
        const fill = i % 2 === 0 ? '#f6f4ef' : '#e5e2da';
        parts.push(
          `<rect x="${(barX + i * bandW).toFixed(2)}" y="${barY.toFixed(2)}" width="${(bandW + 0.4).toFixed(2)}" height="${barH.toFixed(2)}" fill="${fill}" />`,
        );
      }
    }

    if (info.showContours && info.interval > 0) {
      for (let v = info.interval; v < info.scaleMax; v += info.interval) {
        const tx = barX + (v / info.scaleMax) * barW;
        const isIdx = v % info.indexInterval === 0;
        const y2 = barY + barH + (isIdx ? 2.5 * textScale : 0);
        const col = isIdx ? contourPalette.indexColor : contourPalette.intermediateColor;
        const lw = (isIdx ? Math.max(1.0, 1.5 * textScale) : Math.max(0.5, 0.75 * textScale)).toFixed(2);
        const op = isIdx ? '0.92' : '0.6';
        parts.push(
          `<line x1="${tx.toFixed(2)}" y1="${barY.toFixed(2)}" x2="${tx.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${escapeXml(col)}" stroke-opacity="${op}" stroke-width="${lw}" />`,
        );
      }
    }

    parts.push(
      `<rect x="${barX.toFixed(2)}" y="${barY.toFixed(2)}" width="${barW.toFixed(2)}" height="${barH.toFixed(2)}" fill="none" stroke="#111111" stroke-width="${Math.max(0.75, 0.95 * scaleFactor).toFixed(2)}" />`,
    );

    const peakFrac = Math.min(1, Math.max(0, info.maxElev / info.scaleMax));
    const peakX = barX + peakFrac * barW;
    const triSz = Math.max(2.6, 3.2 * textScale);
    parts.push(
      `<polygon points="${peakX.toFixed(2)},${(barY + 0.5).toFixed(2)} ${(peakX - triSz * 0.75).toFixed(2)},${(barY - triSz).toFixed(2)} ${(peakX + triSz * 0.75).toFixed(2)},${(barY - triSz).toFixed(2)}" fill="${escapeXml(contourPalette.indexColor)}" />`,
    );

    const ticks = info.ticks;
    for (let i = 0; i < ticks.length; i += 1) {
      const val = ticks[i];
      const tx = barX + (val / info.scaleMax) * barW;
      const anchor = i === 0 ? 'start' : (i === ticks.length - 1 ? 'end' : 'middle');
      const lbl = i === ticks.length - 1 ? `${formatAltitudeTick(val)}m` : formatAltitudeTick(val);
      parts.push(
        `<text x="${tx.toFixed(2)}" y="${(tickLabelY + tickFont * 0.86).toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${tickFont.toFixed(1)}" font-weight="600" fill="#111111" text-anchor="${anchor}">${escapeXml(lbl)}</text>`,
      );
    }

    if (info.showContours) {
      const keyY = tickLabelY + tickFont + 5 * textScale;
      const midY = keyY + keyFont * 0.52;
      const swLen = Math.max(11, 14 * textScale);
      parts.push(
        `<line x1="${barX.toFixed(2)}" y1="${midY.toFixed(2)}" x2="${(barX + swLen).toFixed(2)}" y2="${midY.toFixed(2)}" stroke="${escapeXml(contourPalette.indexColor)}" stroke-width="${Math.max(1.2, 1.8 * textScale).toFixed(2)}" />`,
      );
      parts.push(
        `<text x="${(barX + swLen + 4 * textScale).toFixed(2)}" y="${(keyY + keyFont * 0.86).toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${keyFont.toFixed(1)}" font-weight="600" fill="#222222" text-anchor="start">Index ${escapeXml(formatAltitudeTick(info.indexInterval))}m</text>`,
      );
      parts.push(
        `<text x="${(barX + barW).toFixed(2)}" y="${(keyY + keyFont * 0.86).toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${keyFont.toFixed(1)}" font-weight="600" fill="#222222" text-anchor="end">CI ${escapeXml(formatAltitudeTick(info.interval))}m</text>`,
      );
    }

    parts.push('</g>');
  }

  // 5. Title Banner
  if (titleBox) {
    const { title, fontSize, x, y, boxW, boxH } = titleBox;
    const r = 5 * scaleFactor;
    const strokeW = Math.max(0.9, 1.2 * scaleFactor);
    const textY = y + boxH / 2 + fontSize * 0.35;
    parts.push('<g class="ornament-title">');
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="${r.toFixed(2)}" fill="rgba(255,255,255,0.92)" stroke="#111111" stroke-width="${strokeW.toFixed(2)}" />`,
    );
    parts.push(
      `<text x="${(x + boxW / 2).toFixed(2)}" y="${textY.toFixed(2)}" font-family="${escapeXml(FONT_FAMILY)}" font-size="${fontSize.toFixed(1)}" font-weight="700" fill="#111111" text-anchor="middle">${escapeXml(title)}</text>`,
    );
    parts.push('</g>');
  }

  parts.push('</g>');
  return parts.join('\n');
}
