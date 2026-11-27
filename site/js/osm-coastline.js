/**
 * On-demand OpenStreetMap HD coastline query builder & pure-JS polygonizer.
 *
 * Converts Overpass `natural=coastline` ways inside a padded viewport bounding box
 * into topologically closed GeoJSON Polygon features using OSM's land-on-left rule
 * and CCW bounding-box perimeter closure. Zero external dependencies so it runs
 * identically in the browser studio and Node.js test suites.
 */

export const OSM_COASTLINE_URL_PREFIX = 'osm-coastline://';
export const OSM_COASTLINE_MAX_SPAN_DEG = 3.0;
export const OSM_COASTLINE_DEFAULT_PAD_FRACTION = 0.2;

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const EPS = 1e-9;

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function wrapLon(lon) {
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

/**
 * Compute a padded bounding box for an Overpass coastline fetch from either
 * `[minLon, maxLon, minLat, maxLat]` visible bounds or a MapSpec object.
 */
export function computePaddedCoastlineBBox(
  specOrBounds,
  {
    padFraction = OSM_COASTLINE_DEFAULT_PAD_FRACTION,
    maxSpanDeg = OSM_COASTLINE_MAX_SPAN_DEG,
  } = {},
) {
  let minLon;
  let maxLon;
  let minLat;
  let maxLat;
  let centerLon;
  let centerLat;

  if (Array.isArray(specOrBounds) && specOrBounds.length >= 4) {
    [minLon, maxLon, minLat, maxLat] = specOrBounds.map(Number);
    centerLon = (minLon + maxLon) / 2;
    centerLat = (minLat + maxLat) / 2;
  } else {
    const spec = specOrBounds || {};
    centerLon = Number(spec?.center?.lon) || 0;
    centerLat = clamp(Number(spec?.center?.lat) || 0, -84.5, 84.5);
    let spanLon = Math.max(0.005, Number(spec?.span?.lonDeg) || 24);
    let spanLat = Math.max(0.005, Number(spec?.span?.latDeg) || 14);

    // Account for page aspect ratio so portrait/landscape framing doesn't under-fetch
    const widthIn = Number(spec?.page?.widthIn) || 0;
    const heightIn = Number(spec?.page?.heightIn) || 0;
    if (widthIn > 0 && heightIn > 0) {
      const cosLat = Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
      const boxAspect = (spanLon * cosLat) / spanLat;
      const pageAspect = widthIn / heightIn;
      if (boxAspect > pageAspect) {
        spanLat = (spanLon * cosLat) / pageAspect;
      } else if (boxAspect < pageAspect) {
        spanLon = (spanLat * pageAspect) / cosLat;
      }
    }

    minLon = centerLon - spanLon / 2;
    maxLon = centerLon + spanLon / 2;
    minLat = centerLat - spanLat / 2;
    maxLat = centerLat + spanLat / 2;
  }

  const rawSpanLon = Math.max(0.002, maxLon - minLon);
  const rawSpanLat = Math.max(0.002, maxLat - minLat);
  const maxRawSpan = Math.max(rawSpanLon, rawSpanLat);

  const padLon = Math.max(0.004, rawSpanLon * padFraction);
  const padLat = Math.max(0.004, rawSpanLat * padFraction);

  const south = Number(clamp(minLat - padLat, -85, 85).toFixed(4));
  const north = Number(clamp(maxLat + padLat, -85, 85).toFixed(4));
  const unwrappedWest = minLon - padLon;
  const unwrappedEast = maxLon + padLon;
  const west = Number(wrapLon(unwrappedWest).toFixed(4));
  const east = Number(wrapLon(unwrappedEast).toFixed(4));
  const crossesAntimeridian = west > east;
  const paddedSpanLon = crossesAntimeridian ? (180 - west) + (east + 180) : east - west;
  const paddedSpanLat = Math.max(0.002, north - south);

  return {
    south,
    west,
    north,
    east,
    rawSpanLon,
    rawSpanLat,
    maxRawSpan,
    paddedSpanLon,
    paddedSpanLat,
    centerLon: wrapLon(centerLon),
    centerLat,
    crossesAntimeridian,
    tooWide: maxRawSpan > maxSpanDeg,
  };
}

/**
 * Encode a deterministic synthetic URL so HD coastline layers can be cached
 * and re-hydrated from Share Links / stripped localStorage drafts.
 */
export function encodeOsmCoastlineUrl(bbox, { simplifyMeters = 0 } = {}) {
  const s = Number(bbox.south).toFixed(4);
  const w = Number(bbox.west).toFixed(4);
  const n = Number(bbox.north).toFixed(4);
  const e = Number(bbox.east).toFixed(4);
  const simp = Math.max(0, Math.round(Number(simplifyMeters) || 0));
  return `${OSM_COASTLINE_URL_PREFIX}${s},${w},${n},${e}?s=${simp}`;
}

export function isOsmCoastlineUrl(url) {
  return typeof url === 'string' && url.trim().startsWith(OSM_COASTLINE_URL_PREFIX);
}

/**
 * Parse an `osm-coastline://S,W,N,E?s=0` URL back into bbox + options.
 */
export function parseOsmCoastlineUrl(url) {
  if (!isOsmCoastlineUrl(url)) return null;
  const body = url.trim().slice(OSM_COASTLINE_URL_PREFIX.length);
  const [coordsPart, queryPart = ''] = body.split('?');
  const nums = coordsPart.split(',').map(Number);
  if (nums.length !== 4 || !nums.every(Number.isFinite)) return null;
  const [south, west, north, east] = nums;
  if (south >= north || south < -85.1 || north > 85.1 || west < -180.1 || east > 180.1) {
    return null;
  }
  const params = new URLSearchParams(queryPart);
  const simplifyMeters = Math.max(0, Number(params.get('s')) || 0);
  const crossesAntimeridian = west > east;
  const paddedSpanLon = crossesAntimeridian ? (180 - west) + (east + 180) : east - west;
  const paddedSpanLat = north - south;
  const centerLon = crossesAntimeridian
    ? wrapLon(west + paddedSpanLon / 2)
    : (west + east) / 2;

  return {
    south,
    west,
    north,
    east,
    simplifyMeters,
    crossesAntimeridian,
    paddedSpanLon,
    paddedSpanLat,
    centerLon,
    centerLat: (south + north) / 2,
  };
}

/**
 * Check whether the user's current visible map extent has moved outside a fetched HD bbox.
 */
export function isViewOutsideCoastlineBBox(viewBounds, hdBBox) {
  if (!Array.isArray(viewBounds) || viewBounds.length < 4 || !hdBBox) return false;
  const [vMinLon, vMaxLon, vMinLat, vMaxLat] = viewBounds.map(Number);
  if (![vMinLon, vMaxLon, vMinLat, vMaxLat].every(Number.isFinite)) return false;

  if (vMinLat < hdBBox.south + 1e-4 || vMaxLat > hdBBox.north - 1e-4) {
    return true;
  }

  const refLon = hdBBox.crossesAntimeridian
    ? wrapLon(hdBBox.west + (((180 - hdBBox.west) + (hdBBox.east + 180)) / 2))
    : (hdBBox.west + hdBBox.east) / 2;

  let bMin = unwrapNear(hdBBox.west, refLon);
  let bMax = unwrapNear(hdBBox.east, refLon);
  if (bMax < bMin) bMax += 360;

  let uMin = unwrapNear(vMinLon, refLon);
  let uMax = unwrapNear(vMaxLon, refLon);
  if (uMax < uMin) uMax += 360;

  return uMin < bMin + 1e-4 || uMax > bMax - 1e-4;
}

/**
 * Build the Overpass QL query for `natural=coastline` ways inside `bbox`.
 * Splits cleanly across the antimeridian when `west > east`.
 */
export function buildOverpassCoastlineQuery(bbox, { timeoutSec = 28 } = {}) {
  const s = Number(bbox.south).toFixed(5);
  const w = Number(bbox.west).toFixed(5);
  const n = Number(bbox.north).toFixed(5);
  const e = Number(bbox.east).toFixed(5);
  const timeout = Math.max(10, Math.min(60, Math.round(timeoutSec)));

  if (Number(bbox.west) > Number(bbox.east)) {
    return `[out:json][timeout:${timeout}];\n(\n  way["natural"="coastline"](${s},${w},${n},180);\n  way["natural"="coastline"](${s},-180,${n},${e});\n);\nout geom;`;
  }
  return `[out:json][timeout:${timeout}];\n(\n  way["natural"="coastline"](${s},${w},${n},${e});\n);\nout geom;`;
}

function coordKey(pt, digits = 6) {
  return `${pt[0].toFixed(digits)},${pt[1].toFixed(digits)}`;
}

function dedupeConsecutive(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (!out.length) {
      out.push(p);
      continue;
    }
    const prev = out[out.length - 1];
    if (Math.abs(p[0] - prev[0]) > 1e-11 || Math.abs(p[1] - prev[1]) > 1e-11) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Iterative Ramer-Douglas-Peucker simplification in approximate local meters.
 */
export function simplifyPolylineMeters(pts, toleranceMeters, isRing = false) {
  if (!Array.isArray(pts) || pts.length <= 3 || !(toleranceMeters > 0)) {
    return pts;
  }

  let sumLat = 0;
  for (let i = 0; i < pts.length; i += 1) sumLat += pts[i][1];
  const midLat = sumLat / pts.length;
  const mPerDegLat = 111320;
  const mPerDegLon = Math.max(1000, mPerDegLat * Math.cos((midLat * Math.PI) / 180));
  const sqTol = toleranceMeters * toleranceMeters;

  const last = pts.length - 1;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[last] = 1;

  // For closed rings, split at the farthest vertex from pts[0] so the loop isn't collapsed
  const stack = [];
  if (isRing && pts.length >= 4) {
    let splitIdx = 1;
    let maxD2 = -1;
    const x0 = pts[0][0] * mPerDegLon;
    const y0 = pts[0][1] * mPerDegLat;
    for (let i = 1; i < last; i += 1) {
      const dx = pts[i][0] * mPerDegLon - x0;
      const dy = pts[i][1] * mPerDegLat - y0;
      const d2 = dx * dx + dy * dy;
      if (d2 > maxD2) {
        maxD2 = d2;
        splitIdx = i;
      }
    }
    keep[splitIdx] = 1;
    if (splitIdx > 1) stack.push([0, splitIdx]);
    if (last - splitIdx > 1) stack.push([splitIdx, last]);
  } else {
    stack.push([0, last]);
  }

  while (stack.length > 0) {
    const [a, b] = stack.pop();
    const ax = pts[a][0] * mPerDegLon;
    const ay = pts[a][1] * mPerDegLat;
    const bx = pts[b][0] * mPerDegLon;
    const by = pts[b][1] * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let maxDistSq = -1;
    let maxIdx = -1;

    for (let i = a + 1; i < b; i += 1) {
      const px = pts[i][0] * mPerDegLon;
      const py = pts[i][1] * mPerDegLat;
      let distSq;
      if (lenSq < 1e-9) {
        const vx = px - ax;
        const vy = py - ay;
        distSq = vx * vx + vy * vy;
      } else {
        const t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
        const projX = ax + t * dx;
        const projY = ay + t * dy;
        const vx = px - projX;
        const vy = py - projY;
        distSq = vx * vx + vy * vy;
      }
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        maxIdx = i;
      }
    }

    if (maxDistSq > sqTol && maxIdx !== -1) {
      keep[maxIdx] = 1;
      if (maxIdx - a > 1) stack.push([a, maxIdx]);
      if (b - maxIdx > 1) stack.push([maxIdx, b]);
    }
  }

  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    if (keep[i]) out.push(pts[i]);
  }

  // Never collapse a real island ring below a valid triangle
  if (isRing && out.length < 4) {
    return pts;
  }
  return out;
}

/**
 * Signed planar shoelace area of a closed ring in (lon, lat).
 * Positive (> 0) = CCW = land outer ring in OSM coastline convention.
 * Negative (< 0) = CW  = water hole / enclosed sea.
 */
export function signedRingArea(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum * 0.5;
}

function estimateRingAreaKm2(ring) {
  const deg2 = Math.abs(signedRingArea(ring));
  if (!(deg2 > 0)) return 0;
  let sumLat = 0;
  for (let i = 0; i < ring.length - 1; i += 1) sumLat += ring[i][1];
  const avgLat = sumLat / Math.max(1, ring.length - 1);
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.max(0.01, Math.cos((avgLat * Math.PI) / 180));
  return deg2 * kmPerDegLat * kmPerDegLon;
}

function pointInRing(pt, ring) {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Stitch directed coastline ways into maximal chains & closed rings.
 */
function stitchDirectedWays(ways) {
  const closedRings = [];
  const active = new Map();
  let nextId = 1;

  for (let i = 0; i < ways.length; i += 1) {
    const w = ways[i];
    if (!w || w.pts.length < 2) continue;
    if (w.startKey === w.endKey && w.pts.length >= 4) {
      const ring = w.pts.slice();
      ring[ring.length - 1] = ring[0];
      closedRings.push(ring);
    } else if (w.startKey !== w.endKey) {
      active.set(nextId++, {
        pts: w.pts.slice(),
        startKey: w.startKey,
        endKey: w.endKey,
      });
    }
  }

  function runMergePass(keyFn) {
    const starts = new Map();
    for (const [id, chain] of active.entries()) {
      const sk = keyFn ? keyFn(chain.pts[0]) : chain.startKey;
      const ek = keyFn ? keyFn(chain.pts[chain.pts.length - 1]) : chain.endKey;
      chain._sk = sk;
      chain._ek = ek;
      if (!starts.has(sk)) starts.set(sk, new Set());
      starts.get(sk).add(id);
    }

    let mergedAny = true;
    while (mergedAny) {
      mergedAny = false;
      for (const idA of Array.from(active.keys())) {
        const chainA = active.get(idA);
        if (!chainA) continue;
        const candidates = starts.get(chainA._ek);
        if (!candidates || candidates.size === 0) continue;

        let idB = null;
        for (const cand of candidates) {
          if (cand !== idA && active.has(cand)) {
            idB = cand;
            break;
          }
        }
        if (idB === null) continue;

        const chainB = active.get(idB);
        candidates.delete(idB);
        active.delete(idB);

        // Append B onto A (skipping duplicate junction point)
        for (let k = 1; k < chainB.pts.length; k += 1) {
          chainA.pts.push(chainB.pts[k]);
        }
        chainA.endKey = chainB.endKey;
        chainA._ek = chainB._ek;
        mergedAny = true;

        // Check if A just closed into a loop
        if (chainA._sk === chainA._ek && chainA.pts.length >= 4) {
          starts.get(chainA._sk)?.delete(idA);
          active.delete(idA);
          chainA.pts[chainA.pts.length - 1] = chainA.pts[0];
          closedRings.push(chainA.pts);
        }
      }
    }
  }

  // Pass 1: exact OSM node-ID stitching
  runMergePass(null);
  // Pass 2: coordinate-key stitching for any ways without matching node IDs
  runMergePass((pt) => coordKey(pt, 6));

  const openChains = [];
  for (const chain of active.values()) {
    if (chain.pts.length >= 2) {
      openChains.push(chain.pts);
    }
  }

  return { closedRings, openChains };
}

function isPointInsideOrOnBox(pt, box) {
  const [W, S, E, N] = box;
  return pt[0] >= W - EPS && pt[0] <= E + EPS && pt[1] >= S - EPS && pt[1] <= N + EPS;
}

function isPointStrictlyInsideBox(pt, box) {
  const [W, S, E, N] = box;
  return pt[0] > W + EPS && pt[0] < E - EPS && pt[1] > S + EPS && pt[1] < N - EPS;
}

function isPointOnBoxBoundary(pt, box) {
  const [W, S, E, N] = box;
  if (!isPointInsideOrOnBox(pt, box)) return false;
  return (
    Math.abs(pt[0] - W) <= EPS * 10 ||
    Math.abs(pt[0] - E) <= EPS * 10 ||
    Math.abs(pt[1] - S) <= EPS * 10 ||
    Math.abs(pt[1] - N) <= EPS * 10
  );
}

function snapToBox(pt, box) {
  const [W, S, E, N] = box;
  let [x, y] = pt;
  if (Math.abs(x - W) <= EPS * 10) x = W;
  else if (Math.abs(x - E) <= EPS * 10) x = E;
  if (Math.abs(y - S) <= EPS * 10) y = S;
  else if (Math.abs(y - N) <= EPS * 10) y = N;
  return [clamp(x, W, E), clamp(y, S, N)];
}

/**
 * Liang-Barsky directed segment clip against [W, S, E, N].
 * Returns `{ p0, p1, clippedStart, clippedEnd }` or `null` if completely outside / degenerate.
 */
function clipSegmentLiangBarsky(a, b, box) {
  const [W, S, E, N] = box;
  const x0 = a[0];
  const y0 = a[1];
  const dx = b[0] - x0;
  const dy = b[1] - y0;

  let t0 = 0;
  let t1 = 1;

  const p = [-dx, dx, -dy, dy];
  const q = [x0 - W, E - x0, y0 - S, N - y0];

  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(p[i]) < 1e-15) {
      if (q[i] < -EPS) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }

  if (t1 - t0 < 1e-12) return null;

  const rawP0 = t0 > 0 ? [x0 + t0 * dx, y0 + t0 * dy] : [a[0], a[1]];
  const rawP1 = t1 < 1 ? [x0 + t1 * dx, y0 + t1 * dy] : [b[0], b[1]];
  const p0 = snapToBox(rawP0, box);
  const p1 = snapToBox(rawP1, box);

  if (Math.abs(p0[0] - p1[0]) < 1e-11 && Math.abs(p0[1] - p1[1]) < 1e-11) {
    return null;
  }

  return {
    p0,
    p1,
    clippedStart: t0 > 1e-12,
    clippedEnd: t1 < 1 - 1e-12,
  };
}

/**
 * Clip a directed polyline against `box = [W, S, E, N]`, returning an array of
 * directed sub-polylines inside the box.
 */
function clipPolylineToBox(pts, box) {
  const pieces = [];
  let current = null;

  for (let i = 0; i < pts.length - 1; i += 1) {
    const seg = clipSegmentLiangBarsky(pts[i], pts[i + 1], box);
    if (!seg) {
      if (current && current.length >= 2) {
        pieces.push(current);
      }
      current = null;
      continue;
    }

    if (!current || seg.clippedStart) {
      if (current && current.length >= 2) {
        pieces.push(current);
      }
      current = [seg.p0, seg.p1];
    } else {
      const prev = current[current.length - 1];
      if (Math.abs(prev[0] - seg.p0[0]) > 1e-8 || Math.abs(prev[1] - seg.p0[1]) > 1e-8) {
        if (current.length >= 2) pieces.push(current);
        current = [seg.p0, seg.p1];
      } else {
        current.push(seg.p1);
      }
    }

    if (seg.clippedEnd) {
      if (current && current.length >= 2) {
        pieces.push(current);
      }
      current = null;
    }
  }

  if (current && current.length >= 2) {
    pieces.push(current);
  }

  return pieces;
}

/**
 * Map a point on the perimeter of `box = [W, S, E, N]` to CCW parameter `t ∈ [0, 4)`:
 *   [0, 1): Bottom edge (W,S) -> (E,S)
 *   [1, 2): Right edge  (E,S) -> (E,N)
 *   [2, 3): Top edge    (E,N) -> (W,N)
 *   [3, 4): Left edge   (W,N) -> (W,S)
 */
export function perimeterParam(pt, box) {
  const [W, S, E, N] = box;
  const wSpan = E - W;
  const hSpan = N - S;
  const [x, y] = snapToBox(pt, box);

  const onS = Math.abs(y - S) <= EPS * 10;
  const onN = Math.abs(y - N) <= EPS * 10;
  const onW = Math.abs(x - W) <= EPS * 10;
  const onE = Math.abs(x - E) <= EPS * 10;

  // Exact corners first
  if (onS && onW) return 0;
  if (onS && onE) return 1;
  if (onN && onE) return 2;
  if (onN && onW) return 3;

  if (onS) return clamp((x - W) / wSpan, 0, 1);
  if (onE) return 1 + clamp((y - S) / hSpan, 0, 1);
  if (onN) return 2 + clamp((E - x) / wSpan, 0, 1);
  if (onW) return 3 + clamp((N - y) / hSpan, 0, 1);

  // Fallback: project to nearest edge
  const dS = Math.abs(y - S);
  const dE = Math.abs(x - E);
  const dN = Math.abs(y - N);
  const dW = Math.abs(x - W);
  const minD = Math.min(dS, dE, dN, dW);
  if (minD === dS) return clamp((x - W) / wSpan, 0, 1);
  if (minD === dE) return 1 + clamp((y - S) / hSpan, 0, 1);
  if (minD === dN) return 2 + clamp((E - x) / wSpan, 0, 1);
  return 3 + clamp((N - y) / hSpan, 0, 1);
}

function collectCcwPerimeterCorners(tOut, tIn, box) {
  const [W, S, E, N] = box;
  const delta = (((tIn - tOut) % 4) + 4) % 4;
  if (delta < 1e-11) return [];

  const corners = [
    { t: 1, pt: [E, S] },
    { t: 2, pt: [E, N] },
    { t: 3, pt: [W, N] },
    { t: 4, pt: [W, S] },
  ];

  const between = [];
  for (let i = 0; i < corners.length; i += 1) {
    const dist = (((corners[i].t - tOut) % 4) + 4) % 4;
    if (dist > 1e-10 && dist < delta - 1e-10) {
      between.push({ dist, pt: corners[i].pt });
    }
  }
  between.sort((a, b) => a.dist - b.dist);
  return between.map((c) => c.pt);
}

/**
 * Close boundary-to-boundary directed coastline chains along the CCW perimeter of `box`.
 */
function closeOpenChainsAlongPerimeter(clippedChains, box) {
  if (!clippedChains.length) return [];

  const validChains = [];
  for (let i = 0; i < clippedChains.length; i += 1) {
    const c = clippedChains[i];
    if (c.length < 2) continue;
    const tIn = perimeterParam(c[0], box);
    const tOut = perimeterParam(c[c.length - 1], box);
    // Drop degenerate boundary-only slivers that never enter the box interior
    const hasInterior = c.some((pt) => isPointStrictlyInsideBox(pt, box));
    if (!hasInterior && Math.abs(tIn - tOut) < 1e-7) continue;
    validChains.push({ pts: c, tIn, tOut });
  }
  if (!validChains.length) return [];

  // Build perimeter event list in ascending CCW order
  const events = [];
  for (let i = 0; i < validChains.length; i += 1) {
    events.push({ type: 'in', chainIdx: i, t: validChains[i].tIn });
    events.push({ type: 'out', chainIdx: i, t: validChains[i].tOut });
  }
  events.sort((a, b) => {
    if (Math.abs(a.t - b.t) > 1e-10) return a.t - b.t;
    // If an 'out' and an 'in' coincide, visit 'out' before 'in'
    if (a.type !== b.type) return a.type === 'out' ? -1 : 1;
    return a.chainIdx - b.chainIdx;
  });

  // Index each chain's 'out' event position in the sorted circular list
  const outEventIdxByChain = new Array(validChains.length).fill(-1);
  for (let eIdx = 0; eIdx < events.length; eIdx += 1) {
    if (events[eIdx].type === 'out') {
      outEventIdxByChain[events[eIdx].chainIdx] = eIdx;
    }
  }

  const visited = new Uint8Array(validChains.length);
  const closedRings = [];

  for (let startIdx = 0; startIdx < validChains.length; startIdx += 1) {
    if (visited[startIdx]) continue;

    const ring = [];
    let cur = startIdx;
    let safety = 0;

    while (safety <= validChains.length + 1) {
      safety += 1;
      visited[cur] = 1;
      const chain = validChains[cur];
      for (let k = 0; k < chain.pts.length; k += 1) {
        const pt = chain.pts[k];
        if (
          ring.length === 0 ||
          Math.abs(ring[ring.length - 1][0] - pt[0]) > 1e-10 ||
          Math.abs(ring[ring.length - 1][1] - pt[1]) > 1e-10
        ) {
          ring.push(pt);
        }
      }

      // Walk CCW from cur's exit event to the next 'in' event
      const outPos = outEventIdxByChain[cur];
      let nextInEvent = null;
      for (let step = 1; step <= events.length; step += 1) {
        const cand = events[(outPos + step) % events.length];
        if (cand.type === 'in') {
          if (cand.chainIdx === startIdx || !visited[cand.chainIdx]) {
            nextInEvent = cand;
            break;
          }
        }
      }

      if (!nextInEvent) break;

      const corners = collectCcwPerimeterCorners(chain.tOut, nextInEvent.t, box);
      for (let cIdx = 0; cIdx < corners.length; cIdx += 1) {
        ring.push(corners[cIdx]);
      }

      if (nextInEvent.chainIdx === startIdx) {
        break;
      }
      cur = nextInEvent.chainIdx;
    }

    if (ring.length >= 3) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (Math.abs(first[0] - last[0]) > 1e-10 || Math.abs(first[1] - last[1]) > 1e-10) {
        ring.push([first[0], first[1]]);
      }
      if (ring.length >= 4) {
        closedRings.push(ring);
      }
    }
  }

  return closedRings;
}

/**
 * Convert an Overpass JSON response (`natural=coastline` ways with `out geom;`)
 * into a GeoJSON FeatureCollection of closed land Polygons clipped to `bbox`.
 */
export function polygonizeOverpassCoastlines(
  overpassJson,
  bbox,
  { simplifyMeters = 0 } = {},
) {
  const elements = Array.isArray(overpassJson?.elements) ? overpassJson.elements : [];
  const south = Number(bbox.south);
  const north = Number(bbox.north);
  const rawWest = Number(bbox.west);
  const rawEast = Number(bbox.east);
  const crossesAntimeridian = rawWest > rawEast;

  // Work in an unwrapped continuous longitude domain [W, E]
  const W = rawWest;
  const E = crossesAntimeridian ? rawEast + 360 : rawEast;
  const refLon = (W + E) / 2;
  const clipBox = [W, south, E, north];

  const ways = [];
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i];
    if (!el || el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) {
      continue;
    }
    if (el.tags && el.tags.natural && el.tags.natural !== 'coastline') {
      continue;
    }

    const rawPts = [];
    for (let j = 0; j < el.geometry.length; j += 1) {
      const g = el.geometry[j];
      if (!g || !Number.isFinite(Number(g.lon)) || !Number.isFinite(Number(g.lat))) continue;
      rawPts.push([unwrapNear(Number(g.lon), refLon), Number(g.lat)]);
    }
    const pts = dedupeConsecutive(rawPts);
    if (pts.length < 2) continue;

    const hasNodes = Array.isArray(el.nodes) && el.nodes.length === el.geometry.length;
    const startKey = hasNodes ? `n:${el.nodes[0]}` : `c:${coordKey(pts[0], 6)}`;
    const endKey = hasNodes ? `n:${el.nodes[el.nodes.length - 1]}` : `c:${coordKey(pts[pts.length - 1], 6)}`;
    ways.push({ pts, startKey, endKey });
  }

  if (ways.length === 0) {
    return {
      geojson: { type: 'FeatureCollection', features: [] },
      stats: {
        wayCount: 0,
        polygonCount: 0,
        islandCount: 0,
        mainlandCount: 0,
        vertexCount: 0,
        incompleteChains: 0,
        bbox: { south, west: rawWest, north, east: rawEast },
      },
    };
  }

  const { closedRings, openChains } = stitchDirectedWays(ways);

  const interiorClosedRings = [];
  const boundaryOpenChains = [];
  let incompleteChains = 0;

  // Classify & clip closed rings
  for (let i = 0; i < closedRings.length; i += 1) {
    let ring = closedRings[i];
    if (simplifyMeters > 0) {
      ring = simplifyPolylineMeters(ring, simplifyMeters, true);
    }

    let rMinX = Infinity;
    let rMaxX = -Infinity;
    let rMinY = Infinity;
    let rMaxY = -Infinity;
    let firstOutsideIdx = -1;

    for (let k = 0; k < ring.length - 1; k += 1) {
      const [x, y] = ring[k];
      if (x < rMinX) rMinX = x;
      if (x > rMaxX) rMaxX = x;
      if (y < rMinY) rMinY = y;
      if (y > rMaxY) rMaxY = y;
      if (firstOutsideIdx === -1 && !isPointInsideOrOnBox(ring[k], clipBox)) {
        firstOutsideIdx = k;
      }
    }

    // Disjoint from clipBox
    if (rMaxX < W - EPS || rMinX > E + EPS || rMaxY < south - EPS || rMinY > north + EPS) {
      continue;
    }

    // Completely inside clipBox (e.g. Corregidor, Caballo, Carabao, El Fraile)
    if (firstOutsideIdx === -1) {
      interiorClosedRings.push(ring);
      continue;
    }

    // Crosses clipBox boundary: rotate so vertex 0 is strictly outside, then clip
    const ringOpen = ring.slice(0, -1);
    const rotated = [
      ...ringOpen.slice(firstOutsideIdx),
      ...ringOpen.slice(0, firstOutsideIdx),
      ringOpen[firstOutsideIdx],
    ];
    const clippedPieces = clipPolylineToBox(rotated, clipBox);
    for (let p = 0; p < clippedPieces.length; p += 1) {
      const piece = clippedPieces[p];
      if (
        piece.length >= 2 &&
        isPointOnBoxBoundary(piece[0], clipBox) &&
        isPointOnBoxBoundary(piece[piece.length - 1], clipBox)
      ) {
        boundaryOpenChains.push(piece);
      }
    }
  }

  // Clip open mainland chains against clipBox
  for (let i = 0; i < openChains.length; i += 1) {
    let chain = openChains[i];
    if (simplifyMeters > 0) {
      chain = simplifyPolylineMeters(chain, simplifyMeters, false);
    }
    const clippedPieces = clipPolylineToBox(chain, clipBox);
    for (let p = 0; p < clippedPieces.length; p += 1) {
      const piece = clippedPieces[p];
      if (
        piece.length >= 2 &&
        isPointOnBoxBoundary(piece[0], clipBox) &&
        isPointOnBoxBoundary(piece[piece.length - 1], clipBox)
      ) {
        boundaryOpenChains.push(piece);
      } else {
        incompleteChains += 1;
      }
    }
  }

  const perimeterClosedRings = closeOpenChainsAlongPerimeter(boundaryOpenChains, clipBox);

  // Separate CCW land outer rings from CW water hole rings
  const outers = [];
  const holes = [];

  for (let i = 0; i < interiorClosedRings.length; i += 1) {
    const r = interiorClosedRings[i];
    const area = signedRingArea(r);
    if (Math.abs(area) < 1e-12) continue;
    if (area > 0) {
      outers.push({ ring: r, area, kind: 'island', holes: [] });
    } else {
      holes.push({ ring: r, area: Math.abs(area) });
    }
  }

  for (let i = 0; i < perimeterClosedRings.length; i += 1) {
    const r = perimeterClosedRings[i];
    const area = signedRingArea(r);
    if (Math.abs(area) < 1e-12) continue;
    if (area > 0) {
      outers.push({ ring: r, area, kind: 'mainland', holes: [] });
    } else {
      holes.push({ ring: r, area: Math.abs(area) });
    }
  }

  // Sort outer rings smallest-first so holes match their tightest enclosing outer ring
  outers.sort((a, b) => a.area - b.area);

  // Assign CW holes to their smallest containing CCW outer ring
  let boxOuter = null;
  for (let h = 0; h < holes.length; h += 1) {
    const hole = holes[h];
    const sample = hole.ring[0];
    let matchedOuter = null;
    for (let o = 0; o < outers.length; o += 1) {
      if (outers[o].area > hole.area && pointInRing(sample, outers[o].ring)) {
        matchedOuter = outers[o];
        break;
      }
    }
    if (matchedOuter) {
      matchedOuter.holes.push(hole.ring);
    } else {
      // Enclosed water body with no coastlines touching the box edge -> whole box is land around it
      if (!boxOuter) {
        const boxRing = [
          [W, south],
          [E, south],
          [E, north],
          [W, north],
          [W, south],
        ];
        boxOuter = { ring: boxRing, area: signedRingArea(boxRing), kind: 'mainland', holes: [] };
        outers.push(boxOuter);
      }
      boxOuter.holes.push(hole.ring);
    }
  }

  // Output largest land polygons first, wrapping coordinates back to [-180, 180]
  outers.sort((a, b) => b.area - a.area);

  let vertexCount = 0;
  let islandCount = 0;
  let mainlandCount = 0;

  const features = outers.map((item, idx) => {
    const allRings = [item.ring, ...item.holes].map((ring) => {
      vertexCount += ring.length;
      return ring.map(([lon, lat]) => [
        Number(wrapLon(lon).toFixed(6)),
        Number(lat.toFixed(6)),
      ]);
    });
    if (item.kind === 'island') islandCount += 1;
    else mainlandCount += 1;

    return {
      type: 'Feature',
      id: `osm_land_${idx + 1}`,
      properties: {
        source: 'OpenStreetMap',
        kind: item.kind,
        area_km2: Number(estimateRingAreaKm2(item.ring).toFixed(3)),
        vertices: item.ring.length,
      },
      geometry: {
        type: 'Polygon',
        coordinates: allRings,
      },
    };
  });

  return {
    geojson: {
      type: 'FeatureCollection',
      features,
    },
    stats: {
      wayCount: ways.length,
      polygonCount: features.length,
      islandCount,
      mainlandCount,
      vertexCount,
      incompleteChains,
      bbox: { south, west: rawWest, north, east: rawEast },
    },
  };
}

/**
 * Static site-cached hyper-accurate (Full 1–5m OSM) coastline packs served directly
 * from `./data/hd_coastlines/` with zero Overpass API latency or rate limits.
 *
 * `coverageBBox` defines the geographic extent where the pack contains 100% of all
 * real-world shorelines (for isolated archipelagos like Attu/Near Islands, this safely
 * extends across surrounding pure ocean where no other islands exist).
 */
export const CACHED_HD_COASTLINE_PACKS = [
  {
    id: 'attu_near_islands',
    name: 'Attu & Near Islands',
    shortLabel: 'Attu Island',
    description:
      'Attu Island, Agattu, Semichi Islands (Shemya, Nizki, Alaid), and all 121 surrounding Aleutian islets & sea stacks (1–5m OSM).',
    url: './data/hd_coastlines/attu_near_islands.geojson',
    bbox: { south: 52.28, west: 172.30, north: 53.12, east: 174.26 },
    // Pure Bering Sea / North Pacific ocean surrounds the Near Islands (>115 km to Buldir East, >300 km to Commander Islands West)
    coverageBBox: { south: 51.80, west: 171.20, north: 53.60, east: 175.40 },
    defaultView: {
      center: { lat: 52.89, lon: 172.92 },
      span: { lonDeg: 1.05, latDeg: 0.42 },
    },
    hostCountryId: '840',
    hostCountryName: 'United States of America',
    scaleUnits: 'mi',
  },
  {
    id: 'corregidor_manila_bay',
    name: 'Corregidor & Manila Bay Mouth',
    shortLabel: 'Corregidor',
    description:
      'Corregidor, Caballo (Fort Hughes), Carabao (Fort Frank), El Fraile (Fort Drum), La Monja, Limbones, southern Bataan Peninsula, and Cavite mouth (1–5m OSM).',
    url: './data/hd_coastlines/corregidor_manila_bay.geojson',
    bbox: { south: 14.12, west: 120.38, north: 14.62, east: 120.92 },
    coverageBBox: { south: 14.12, west: 120.38, north: 14.62, east: 120.92 },
    defaultView: {
      center: { lat: 14.37, lon: 120.585 },
      span: { lonDeg: 0.24, latDeg: 0.20 },
    },
    hostCountryId: '608',
    hostCountryName: 'Philippines',
    scaleUnits: 'km',
  },
];

export function getCachedCoastlinePackById(packId) {
  if (!packId) return null;
  return CACHED_HD_COASTLINE_PACKS.find((p) => p.id === packId) || null;
}

export function isCachedCoastlinePackUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  const cleaned = url.trim().split('?')[0];
  return CACHED_HD_COASTLINE_PACKS.some(
    (p) => cleaned === p.url || cleaned.endsWith(p.url.replace(/^\./, '')),
  );
}

/**
 * Return the site-cached HD coastline pack that completely covers `boundsOrBBox`
 * (`[minLon, maxLon, minLat, maxLat]` or `{ south, west, north, east }`), or `null`.
 */
export function findMatchingCachedCoastlinePack(boundsOrBBox) {
  if (!boundsOrBBox) return null;
  let south;
  let west;
  let north;
  let east;

  if (Array.isArray(boundsOrBBox) && boundsOrBBox.length >= 4) {
    [west, east, south, north] = boundsOrBBox.map(Number);
  } else if (
    Number.isFinite(Number(boundsOrBBox.south)) &&
    Number.isFinite(Number(boundsOrBBox.west)) &&
    Number.isFinite(Number(boundsOrBBox.north)) &&
    Number.isFinite(Number(boundsOrBBox.east))
  ) {
    south = Number(boundsOrBBox.south);
    west = Number(boundsOrBBox.west);
    north = Number(boundsOrBBox.north);
    east = Number(boundsOrBBox.east);
  } else {
    return null;
  }

  if (![south, west, north, east].every(Number.isFinite) || south >= north) {
    return null;
  }

  const tol = 0.002;
  for (let i = 0; i < CACHED_HD_COASTLINE_PACKS.length; i += 1) {
    const pack = CACHED_HD_COASTLINE_PACKS[i];
    const cov = pack.coverageBBox || pack.bbox;
    if (south < cov.south - tol || north > cov.north + tol) continue;

    const refLon = (cov.west + cov.east) / 2;
    let uW = unwrapNear(west, refLon);
    let uE = unwrapNear(east, refLon);
    if (uE < uW) uE += 360;

    if (uW >= cov.west - tol && uE <= cov.east + tol) {
      return pack;
    }
  }
  return null;
}

/**
 * Optionally simplify a cached GeoJSON coastline FeatureCollection in local meters
 * and recompute summary stats (`polygonCount`, `islandCount`, `mainlandCount`, `vertexCount`).
 */
export function simplifyGeoJsonCoastline(geojson, simplifyMeters = 0) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const tol = Math.max(0, Number(simplifyMeters) || 0);
  let islandCount = 0;
  let mainlandCount = 0;
  let vertexCount = 0;

  const outFeatures = features.map((feat) => {
    const kind = feat?.properties?.kind === 'mainland' ? 'mainland' : 'island';
    if (kind === 'island') islandCount += 1;
    else mainlandCount += 1;

    if (feat?.geometry?.type !== 'Polygon' || !Array.isArray(feat.geometry.coordinates)) {
      return feat;
    }

    const nextRings = feat.geometry.coordinates.map((ring) => {
      const processed = tol > 0 ? simplifyPolylineMeters(ring, tol, true) : ring;
      vertexCount += processed.length;
      return processed;
    });

    return {
      ...feat,
      properties: {
        ...(feat.properties || {}),
        vertices: nextRings[0]?.length || 0,
      },
      geometry: {
        type: 'Polygon',
        coordinates: nextRings,
      },
    };
  });

  return {
    geojson: {
      type: 'FeatureCollection',
      ...(geojson?.metadata ? { metadata: geojson.metadata } : {}),
      features: outFeatures,
    },
    stats: {
      polygonCount: outFeatures.length,
      islandCount,
      mainlandCount,
      vertexCount,
      incompleteChains: 0,
      bbox: geojson?.metadata?.bbox || null,
    },
  };
}
