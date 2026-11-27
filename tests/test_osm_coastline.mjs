import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CACHED_HD_COASTLINE_PACKS,
  buildOverpassCoastlineQuery,
  computePaddedCoastlineBBox,
  encodeOsmCoastlineUrl,
  findMatchingCachedCoastlinePack,
  isCachedCoastlinePackUrl,
  isOsmCoastlineUrl,
  isViewOutsideCoastlineBBox,
  parseOsmCoastlineUrl,
  polygonizeOverpassCoastlines,
  signedRingArea,
  simplifyGeoJsonCoastline,
} from '../site/js/osm-coastline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeWay(id, coords, nodeIds = null) {
  return {
    type: 'way',
    id,
    tags: { natural: 'coastline' },
    nodes: nodeIds || coords.map((_, i) => id * 1000 + i),
    geometry: coords.map(([lon, lat]) => ({ lon, lat })),
  };
}

function pointInPolygon(pt, polygonCoords) {
  const inRing = (p, ring) => {
    const [px, py] = p;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
  if (!inRing(pt, polygonCoords[0])) return false;
  for (let h = 1; h < polygonCoords.length; h += 1) {
    if (inRing(pt, polygonCoords[h])) return false;
  }
  return true;
}

function isLand(pt, fc) {
  return fc.features.some((f) => pointInPolygon(pt, f.geometry.coordinates));
}

test('Manila Bay mouth: Bataan (N), Cavite (S), multi-way Corregidor & Caballo islands', () => {
  const bbox = { south: 14.25, west: 120.45, north: 14.50, east: 120.75 };

  // Corregidor split across 2 OSM ways sharing node IDs 9001 & 9004 (CCW = land on left)
  const corrWay1 = makeWay(
    1,
    [
      [120.56, 14.38],
      [120.60, 14.38],
      [120.61, 14.39],
    ],
    [9001, 9002, 9003],
  );
  const corrWay2 = makeWay(
    2,
    [
      [120.61, 14.39],
      [120.58, 14.40],
      [120.56, 14.395],
      [120.56, 14.38],
    ],
    [9003, 9004, 9005, 9001],
  );

  // Caballo Island (single closed CCW way)
  const caballo = makeWay(
    3,
    [
      [120.612, 14.362],
      [120.624, 14.362],
      [120.624, 14.370],
      [120.612, 14.370],
      [120.612, 14.362],
    ],
    [9100, 9101, 9102, 9103, 9100],
  );

  // Bataan Peninsula sticking down from North edge (enters top-west, goes south around tip, exits top-east)
  // Walking south then north keeps interior of Bataan on the LEFT (land)
  const bataan = makeWay(4, [
    [120.50, 14.55],
    [120.52, 14.44],
    [120.58, 14.42],
    [120.64, 14.44],
    [120.66, 14.55],
  ]);

  // Cavite coast along South edge (enters bottom-east, goes west, exits bottom-west -> South is on LEFT)
  const cavite = makeWay(5, [
    [120.72, 14.20],
    [120.70, 14.31],
    [120.55, 14.30],
    [120.52, 14.20],
  ]);

  const { geojson, stats } = polygonizeOverpassCoastlines(
    { elements: [corrWay1, corrWay2, caballo, bataan, cavite] },
    bbox,
  );

  assert.equal(stats.polygonCount, 4);
  assert.equal(stats.islandCount, 2);
  assert.equal(stats.mainlandCount, 2);

  // Verify land vs water classification across the entire strait
  assert.equal(isLand([120.58, 14.39], geojson), true, 'Corregidor interior is land');
  assert.equal(isLand([120.618, 14.366], geojson), true, 'Caballo interior is land');
  assert.equal(isLand([120.58, 14.47], geojson), true, 'Bataan Peninsula interior is land');
  assert.equal(isLand([120.62, 14.27], geojson), true, 'Cavite coast interior is land');

  // Channels & bay water
  assert.equal(isLand([120.58, 14.41], geojson), false, 'North Channel between Bataan and Corregidor is water');
  assert.equal(isLand([120.58, 14.34], geojson), false, 'South Channel between Corregidor and Cavite is water');
  assert.equal(isLand([120.47, 14.38], geojson), false, 'South China Sea west of Corregidor is water');
  assert.equal(isLand([120.72, 14.42], geojson), false, 'Manila Bay east of Bataan is water');
});

test('Eastern mainland coast wrapping around a bay (Land on East, Water on West)', () => {
  const bbox = { south: 14.0, west: 120.0, north: 15.0, east: 121.0 };
  // Coastline runs North->South so East (interior Luzon) is on the LEFT
  const luzonCoast = makeWay(10, [
    [120.4, 15.2],
    [120.4, 14.7],
    [120.8, 14.5],
    [120.4, 14.3],
    [120.4, 13.8],
  ]);

  const { geojson, stats } = polygonizeOverpassCoastlines({ elements: [luzonCoast] }, bbox);
  assert.equal(stats.polygonCount, 1);
  assert.equal(isLand([120.9, 14.5], geojson), true, 'East mainland is land');
  assert.equal(isLand([120.6, 14.85], geojson), true, 'NE mainland is land');
  assert.equal(isLand([120.2, 14.5], geojson), false, 'West ocean is water');
  assert.equal(isLand([120.6, 14.5], geojson), false, 'Bay interior is water');
});

test('Enclosed harbor where all 4 bbox corners are land (bay entering from South)', () => {
  const bbox = { south: 0, west: 0, north: 1, east: 1 };
  // Harbor sticking North from South edge: CW around water so land is on LEFT
  const harbor = makeWay(20, [
    [0.35, -0.2],
    [0.35, 0.7],
    [0.65, 0.7],
    [0.65, -0.2],
  ]);

  const { geojson, stats } = polygonizeOverpassCoastlines({ elements: [harbor] }, bbox);
  assert.equal(stats.polygonCount, 1);
  assert.equal(isLand([0.5, 0.4], geojson), false, 'Harbor center is water');
  assert.equal(isLand([0.1, 0.1], geojson), true, 'SW corner is land');
  assert.equal(isLand([0.9, 0.1], geojson), true, 'SE corner is land');
  assert.equal(isLand([0.5, 0.9], geojson), true, 'North head of harbor is land');
});

test('Island straddling bbox edge is clipped into a valid land polygon', () => {
  const bbox = { south: 0, west: 0, north: 1, east: 1 };
  // Large closed CCW island straddling the right edge x = 1
  const straddlingIsland = makeWay(
    30,
    [
      [0.7, 0.3],
      [1.3, 0.3],
      [1.3, 0.7],
      [0.7, 0.7],
      [0.7, 0.3],
    ],
    [1, 2, 3, 4, 1],
  );

  const { geojson, stats } = polygonizeOverpassCoastlines({ elements: [straddlingIsland] }, bbox);
  assert.equal(stats.polygonCount, 1);
  assert.equal(isLand([0.85, 0.5], geojson), true, 'Clipped island interior is land');
  assert.equal(isLand([0.4, 0.5], geojson), false, 'Ocean west of island is water');
});

test('CW enclosed lagoon ring inside an island becomes a polygon hole', () => {
  const bbox = { south: 0, west: 0, north: 1, east: 1 };
  const outerIsland = makeWay(
    40,
    [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
      [0.1, 0.1],
    ],
    [1, 2, 3, 4, 1],
  );
  // CW ring = water hole inside the island
  const innerLagoon = makeWay(
    41,
    [
      [0.3, 0.3],
      [0.3, 0.7],
      [0.7, 0.7],
      [0.7, 0.3],
      [0.3, 0.3],
    ],
    [10, 11, 12, 13, 10],
  );

  const { geojson } = polygonizeOverpassCoastlines({ elements: [outerIsland, innerLagoon] }, bbox);
  assert.equal(geojson.features.length, 1);
  assert.equal(geojson.features[0].geometry.coordinates.length, 2, 'Outer ring + 1 hole');
  assert.equal(isLand([0.2, 0.5], geojson), true, 'Island rim is land');
  assert.equal(isLand([0.5, 0.5], geojson), false, 'Inner lagoon is water');
});

test('Antimeridian crossing island and Overpass query split cleanly', () => {
  const bbox = { south: -17.0, west: 179.8, north: -16.5, east: -179.8 };
  const query = buildOverpassCoastlineQuery(bbox);
  assert.match(query, /180\);/);
  assert.match(query, /-180,/);

  // CCW island crossing +/-180 longitude
  const island = makeWay(
    50,
    [
      [179.9, -16.8],
      [-179.9, -16.8],
      [-179.9, -16.7],
      [179.9, -16.7],
      [179.9, -16.8],
    ],
    [1, 2, 3, 4, 1],
  );

  const { geojson, stats } = polygonizeOverpassCoastlines({ elements: [island] }, bbox);
  assert.equal(stats.polygonCount, 1);
  assert.equal(stats.islandCount, 1);
  assert.ok(geojson.features[0].geometry.coordinates[0].every(([lon]) => lon >= -180 && lon <= 180));
});

test('Douglas-Peucker simplification reduces vertices while preserving valid island ring', () => {
  const bbox = { south: 14.3, west: 120.5, north: 14.5, east: 120.7 };
  // Dense 60-point circular island (~2 km radius)
  const pts = [];
  for (let i = 0; i <= 60; i += 1) {
    const a = (i / 60) * Math.PI * 2;
    pts.push([120.58 + Math.cos(a) * 0.02, 14.39 + Math.sin(a) * 0.02]);
  }
  pts[pts.length - 1] = pts[0];
  const denseIsland = makeWay(60, pts, pts.map((_, i) => (i === pts.length - 1 ? 1 : i + 1)));

  const full = polygonizeOverpassCoastlines({ elements: [denseIsland] }, bbox, { simplifyMeters: 0 });
  const smooth = polygonizeOverpassCoastlines({ elements: [denseIsland] }, bbox, { simplifyMeters: 40 });

  assert.equal(full.stats.polygonCount, 1);
  assert.equal(smooth.stats.polygonCount, 1);
  assert.ok(smooth.stats.vertexCount < full.stats.vertexCount, 'Smooth mode reduces vertex count');
  assert.ok(smooth.stats.vertexCount >= 8, 'Retains recognizable island shape');
  assert.ok(signedRingArea(smooth.geojson.features[0].geometry.coordinates[0]) > 0);
});

test('URL codec, padded bbox calculation, and out-of-bounds view check round-trip cleanly', () => {
  const bbox = computePaddedCoastlineBBox({
    center: { lat: 14.386, lon: 120.579 },
    span: { lonDeg: 0.3, latDeg: 0.2 },
    page: { widthIn: 4.6, heightIn: 7.0 },
  });
  assert.equal(bbox.tooWide, false);
  assert.ok(bbox.paddedSpanLat > 0.4, 'Portrait page aspect ratio expands lat coverage');

  const url = encodeOsmCoastlineUrl(bbox, { simplifyMeters: 15 });
  assert.equal(isOsmCoastlineUrl(url), true);
  const parsed = parseOsmCoastlineUrl(url);
  assert.equal(parsed.simplifyMeters, 15);
  assert.equal(parsed.south, bbox.south);
  assert.equal(parsed.north, bbox.north);

  assert.equal(
    isViewOutsideCoastlineBBox([120.48, 120.68, 14.28, 14.48], parsed),
    false,
    'View well inside padded HD bounds',
  );
  assert.equal(
    isViewOutsideCoastlineBBox([120.0, 121.0, 14.2, 14.5], parsed),
    true,
    'Panned/zoomed-out view detected outside HD bounds',
  );
});

test('Site-cached Attu & Corregidor HD coastline packs exist, validate, match view bounds, and simplify cleanly', () => {
  assert.ok(CACHED_HD_COASTLINE_PACKS.length >= 2);

  // Auto-match inside Attu & Near Islands (including pure ocean margin around Attu)
  const attuMatch = findMatchingCachedCoastlinePack([172.35, 173.45, 52.65, 53.15]);
  assert.equal(attuMatch?.id, 'attu_near_islands');
  assert.equal(isCachedCoastlinePackUrl(attuMatch.url), true);

  // Auto-match inside Corregidor & Manila Bay Mouth
  const corrMatch = findMatchingCachedCoastlinePack([120.46, 120.72, 14.25, 14.50]);
  assert.equal(corrMatch?.id, 'corregidor_manila_bay');
  assert.equal(isCachedCoastlinePackUrl(corrMatch.url), true);

  // Outside views return null so Overpass handles other regions
  assert.equal(findMatchingCachedCoastlinePack([25, 36, 45, 52]), null);
  assert.equal(findMatchingCachedCoastlinePack([119.5, 122.0, 13.5, 15.5]), null);

  // Validate both static GeoJSON files on disk
  for (const pack of CACHED_HD_COASTLINE_PACKS) {
    const absPath = path.resolve(__dirname, '..', 'site', pack.url.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(absPath), `Missing cached pack file: ${absPath}`);
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    assert.equal(parsed.type, 'FeatureCollection');
    assert.ok(Array.isArray(parsed.features) && parsed.features.length >= 40);

    const full = simplifyGeoJsonCoastline(parsed, 0);
    const medium = simplifyGeoJsonCoastline(parsed, 15);
    assert.equal(full.stats.polygonCount, parsed.features.length);
    assert.equal(medium.stats.polygonCount, parsed.features.length);
    assert.ok(medium.stats.vertexCount < full.stats.vertexCount, `${pack.id} simplification should reduce vertices`);
    assert.ok(full.stats.islandCount >= 50, `${pack.id} should include surrounding islands & islets`);
  }

  // Spot-check key islands by point-in-polygon inside Corregidor & Attu packs
  const corrGeo = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'site/data/hd_coastlines/corregidor_manila_bay.geojson'), 'utf8'),
  );
  const corrIslands = corrGeo.features.filter((f) => f.properties?.kind === 'island');
  assert.ok(
    corrIslands.some((f) => pointInPolygon([120.580, 14.386], f.geometry.coordinates)),
    'Corregidor Island polygon contains Malinta/Topside',
  );
  assert.ok(
    corrIslands.some((f) => pointInPolygon([120.618, 14.366], f.geometry.coordinates)),
    'Caballo Island (Fort Hughes) polygon present',
  );
  assert.ok(
    corrIslands.some((f) => pointInPolygon([120.61506, 14.2647], f.geometry.coordinates)),
    'Carabao Island (Fort Frank) polygon present',
  );
  assert.ok(
    corrIslands.some((f) => pointInPolygon([120.6305, 14.3050], f.geometry.coordinates)),
    'El Fraile Island (Fort Drum) polygon present',
  );
  assert.ok(
    corrIslands.some((f) => pointInPolygon([120.5222, 14.3756], f.geometry.coordinates)),
    'La Monja Island polygon present',
  );

  const attuGeo = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'site/data/hd_coastlines/attu_near_islands.geojson'), 'utf8'),
  );
  const attuIslands = attuGeo.features.filter((f) => f.properties?.kind === 'island');
  assert.ok(
    attuIslands.some((f) => pointInPolygon([172.92, 52.89], f.geometry.coordinates)),
    'Attu Island polygon contains central Attu',
  );
  assert.ok(
    attuIslands.some((f) => pointInPolygon([173.60, 52.43], f.geometry.coordinates)),
    'Agattu Island polygon present',
  );
  assert.ok(
    attuIslands.some((f) => pointInPolygon([174.11, 52.72], f.geometry.coordinates)),
    'Shemya Island polygon present',
  );
});
