#!/usr/bin/env node
/**
 * Build script for site-cached hyper-accurate OpenStreetMap HD coastline packs.
 *
 * Fetches full-resolution (1–5 m, zero simplification) OSM `natural=coastline`
 * ways via Overpass (or reads a pre-filtered local OSM `.opl` extract via `--opl`),
 * polygonizes them with the studio's exact pure-JS polygonizer
 * (`site/js/osm-coastline.js`), verifies expected islands & topology, and writes
 * compact GeoJSON FeatureCollections to `site/data/hd_coastlines/`.
 *
 * Usage:
 *   node scripts/build_cached_hd_coastlines.mjs
 *   node scripts/build_cached_hd_coastlines.mjs --pack luzon_surrounding --pack leyte_surrounding --opl /path/to/ph_coastlines.opl
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  OVERPASS_ENDPOINTS,
  buildOverpassCoastlineQuery,
  polygonizeOverpassCoastlines,
} from '../site/js/osm-coastline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'site', 'data', 'hd_coastlines');

const PACK_SPECS = [
  {
    id: 'attu_near_islands',
    filename: 'attu_near_islands.geojson',
    name: 'Attu & Near Islands (Aleutians)',
    bbox: { south: 52.28, west: 172.30, north: 53.12, east: 174.26 },
    // Verify key islands by expected reference point inside/near polygon bbox
    expectedFeatures: [
      { label: 'Attu Island', lat: 52.88, lon: 172.92, minAreaKm2: 750 },
      { label: 'Agattu Island', lat: 52.43, lon: 173.60, minAreaKm2: 180 },
      { label: 'Shemya Island', lat: 52.72, lon: 174.11, minAreaKm2: 10 },
      { label: 'Nizki Island', lat: 52.74, lon: 173.98, minAreaKm2: 4 },
      { label: 'Alaid Island', lat: 52.76, lon: 173.90, minAreaKm2: 2 },
    ],
  },
  {
    id: 'corregidor_manila_bay',
    filename: 'corregidor_manila_bay.geojson',
    name: 'Corregidor & Manila Bay Mouth',
    bbox: { south: 14.12, west: 120.38, north: 14.62, east: 120.92 },
    expectedFeatures: [
      { label: 'Corregidor Island', lat: 14.386, lon: 120.580, minAreaKm2: 4.5 },
      { label: 'Caballo Island (Fort Hughes)', lat: 14.364, lon: 120.619, minAreaKm2: 0.25 },
      { label: 'Carabao Island (Fort Frank)', lat: 14.273, lon: 120.613, minAreaKm2: 0.1 },
      { label: 'El Fraile Island (Fort Drum)', lat: 14.306, lon: 120.630, minAreaKm2: 0.002 },
      { label: 'La Monja Island', lat: 14.381, lon: 120.517, minAreaKm2: 0.005 },
    ],
  },
  {
    id: 'luzon_surrounding',
    filename: 'luzon_surrounding.geojson',
    name: 'Luzon & Surrounding Islands',
    bbox: { south: 12.10, west: 119.30, north: 19.65, east: 124.75 },
    expectedFeatures: [
      { label: 'Luzon Island', lat: 15.80, lon: 121.00, minAreaKm2: 95000 },
      { label: 'Mindoro Island', lat: 13.00, lon: 121.05, minAreaKm2: 8500 },
      { label: 'Catanduanes Island', lat: 13.80, lon: 124.22, minAreaKm2: 1200 },
      { label: 'Marinduque Island', lat: 13.40, lon: 121.98, minAreaKm2: 750 },
      { label: 'Polillo Island', lat: 14.85, lon: 121.94, minAreaKm2: 500 },
      { label: 'Burias Island', lat: 12.92, lon: 123.16, minAreaKm2: 350 },
      { label: 'Ticao Island', lat: 12.52, lon: 123.70, minAreaKm2: 250 },
      { label: 'Corregidor Island', lat: 14.386, lon: 120.580, minAreaKm2: 4.5 },
    ],
  },
  {
    id: 'leyte_surrounding',
    filename: 'leyte_surrounding.geojson',
    name: 'Leyte, Samar & Leyte Gulf',
    bbox: { south: 9.35, west: 123.00, north: 12.65, east: 126.25 },
    expectedFeatures: [
      { label: 'Leyte Island', lat: 10.85, lon: 124.85, minAreaKm2: 6500 },
      { label: 'Samar Island', lat: 11.75, lon: 125.10, minAreaKm2: 11000 },
      { label: 'Cebu Island', lat: 10.35, lon: 123.80, minAreaKm2: 4000 },
      { label: 'Bohol Island', lat: 9.85, lon: 124.20, minAreaKm2: 3200 },
      { label: 'Dinagat Island', lat: 10.15, lon: 125.58, minAreaKm2: 650 },
      { label: 'Biliran Island', lat: 11.58, lon: 124.48, minAreaKm2: 420 },
      { label: 'Siargao Island', lat: 9.86, lon: 126.06, minAreaKm2: 300 },
      { label: 'Panaon Island', lat: 10.04, lon: 125.21, minAreaKm2: 170 },
      { label: 'Homonhon Island', lat: 10.74, lon: 125.73, minAreaKm2: 85 },
    ],
  },
];

function parseArgs(argv) {
  const packIds = [];
  let oplPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pack' && argv[i + 1]) {
      for (const part of argv[++i].split(',')) {
        const trimmed = part.trim();
        if (trimmed) packIds.push(trimmed);
      }
    } else if (arg.startsWith('--pack=')) {
      for (const part of arg.slice('--pack='.length).split(',')) {
        const trimmed = part.trim();
        if (trimmed) packIds.push(trimmed);
      }
    } else if (arg === '--opl' && argv[i + 1]) {
      oplPath = argv[++i];
    } else if (arg.startsWith('--opl=')) {
      oplPath = arg.slice('--opl='.length);
    }
  }
  return { packIds, oplPath };
}

async function loadOplCoastlineIndex(oplPath) {
  const nodes = new Map();
  const ways = [];
  const rl = readline.createInterface({
    input: createReadStream(oplPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    if (line[0] === 'n') {
      const sp = line.indexOf(' ');
      const id = Number(line.slice(1, sp));
      const xIdx = line.lastIndexOf(' x');
      const yIdx = line.lastIndexOf(' y');
      if (xIdx > 0 && yIdx > xIdx) {
        const lon = Number(line.slice(xIdx + 2, yIdx));
        const lat = Number(line.slice(yIdx + 2));
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          nodes.set(id, [lon, lat]);
        }
      }
    } else if (line[0] === 'w') {
      const sp = line.indexOf(' ');
      const id = Number(line.slice(1, sp));
      const nIdx = line.lastIndexOf(' Nn');
      if (nIdx < 0) continue;
      const nodeStrs = line.slice(nIdx + 2).split(',');
      const nodeIds = [];
      const geometry = [];
      let minLon = Infinity;
      let maxLon = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;

      for (let i = 0; i < nodeStrs.length; i += 1) {
        const nid = Number(nodeStrs[i].slice(1));
        const pt = nodes.get(nid);
        if (!pt) continue;
        nodeIds.push(nid);
        geometry.push({ lon: pt[0], lat: pt[1] });
        if (pt[0] < minLon) minLon = pt[0];
        if (pt[0] > maxLon) maxLon = pt[0];
        if (pt[1] < minLat) minLat = pt[1];
        if (pt[1] > maxLat) maxLat = pt[1];
      }

      if (geometry.length >= 2) {
        ways.push({
          type: 'way',
          id,
          tags: { natural: 'coastline' },
          nodes: nodeIds,
          geometry,
          _bb: [minLon, maxLon, minLat, maxLat],
        });
      }
    }
  }

  return ways;
}

function queryOplCoastlinesForBBox(indexedWays, bbox) {
  const elements = [];
  for (let i = 0; i < indexedWays.length; i += 1) {
    const w = indexedWays[i];
    const [minLon, maxLon, minLat, maxLat] = w._bb;
    if (maxLon >= bbox.west && minLon <= bbox.east && maxLat >= bbox.south && minLat <= bbox.north) {
      elements.push(w);
    }
  }
  return { elements };
}

async function fetchOverpassJson(query) {
  let lastErr = null;
  // Try reliable mirrors with retry fallback
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            Accept: 'application/json',
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) {
          throw new Error('Malformed Overpass response');
        }
        return { json, endpoint };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = err;
      console.warn(`  Mirror ${endpoint} failed (${err.message}), trying next...`);
    }
  }
  throw lastErr || new Error('All Overpass mirrors failed');
}

function featureBBox(feature) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const ring = feature.geometry?.coordinates?.[0] || [];
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}

function pointInRing(pt, ring) {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(pt, polygonCoords) {
  if (!Array.isArray(polygonCoords) || !polygonCoords.length) return false;
  if (!pointInRing(pt, polygonCoords[0])) return false;
  for (let h = 1; h < polygonCoords.length; h += 1) {
    if (pointInRing(pt, polygonCoords[h])) return false;
  }
  return true;
}

async function main() {
  const { packIds, oplPath } = parseArgs(process.argv.slice(2));
  const selectedPacks = packIds.length
    ? PACK_SPECS.filter((p) => packIds.includes(p.id))
    : PACK_SPECS;

  if (selectedPacks.length === 0) {
    throw new Error(`No matching packs for --pack=${packIds.join(',')}`);
  }

  let oplWays = null;
  if (oplPath) {
    console.log(`Indexing local OSM coastline OPL extract: ${oplPath}...`);
    oplWays = await loadOplCoastlineIndex(oplPath);
    console.log(`  Indexed ${oplWays.length.toLocaleString()} coastline ways.`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const pack of selectedPacks) {
    console.log(`\nBuilding ${pack.name} (${JSON.stringify(pack.bbox)})...`);
    let json;
    let endpoint;
    if (oplWays) {
      json = queryOplCoastlinesForBBox(oplWays, pack.bbox);
      endpoint = 'Geofabrik OSM extract (osmium)';
    } else {
      const query = buildOverpassCoastlineQuery(pack.bbox, { timeoutSec: 45 });
      ({ json, endpoint } = await fetchOverpassJson(query));
    }

    const { geojson, stats } = polygonizeOverpassCoastlines(json, pack.bbox, { simplifyMeters: 0 });

    if (stats.incompleteChains > 0) {
      throw new Error(`${pack.id}: detected ${stats.incompleteChains} incomplete coastline chains`);
    }
    if (geojson.features.length === 0) {
      throw new Error(`${pack.id}: produced 0 polygons`);
    }

    // Verify every expected island is present with reasonable area (point-in-polygon, fallback to tight bbox for tiny sea stacks)
    for (const exp of pack.expectedFeatures) {
      const match = geojson.features.find((f) => {
        if (f.properties?.kind !== 'island') return false;
        const area = Number(f.properties?.area_km2 || 0);
        if (area < exp.minAreaKm2) return false;
        if (pointInPolygon([exp.lon, exp.lat], f.geometry?.coordinates)) return true;
        if (exp.minAreaKm2 < 0.5) {
          const bb = featureBBox(f);
          return (
            exp.lon >= bb.minLon - 0.005 &&
            exp.lon <= bb.maxLon + 0.005 &&
            exp.lat >= bb.minLat - 0.005 &&
            exp.lat <= bb.maxLat + 0.005
          );
        }
        return false;
      });
      if (!match) {
        throw new Error(`${pack.id}: expected feature "${exp.label}" not found!`);
      }
      console.log(
        `  ✓ Verified ${exp.label}: ${match.properties.area_km2} km² (${match.properties.vertices} vertices)`,
      );
    }

    const payload = {
      type: 'FeatureCollection',
      metadata: {
        id: pack.id,
        name: pack.name,
        source: oplWays
          ? 'OpenStreetMap contributors (ODbL) via Geofabrik OSM extract'
          : 'OpenStreetMap contributors (ODbL) via Overpass API',
        resolution: 'Full (1-5m, unsimplified)',
        generatedAt: new Date().toISOString().slice(0, 10),
        bbox: pack.bbox,
        stats: {
          wayCount: stats.wayCount,
          polygonCount: stats.polygonCount,
          islandCount: stats.islandCount,
          mainlandCount: stats.mainlandCount,
          vertexCount: stats.vertexCount,
        },
      },
      features: geojson.features,
    };

    const outPath = path.join(OUT_DIR, pack.filename);
    const serialized = JSON.stringify(payload);
    await fs.writeFile(outPath, serialized, 'utf8');
    console.log(
      `  -> Wrote ${path.relative(process.cwd(), outPath)} (${(Buffer.byteLength(serialized) / 1024).toFixed(1)} KB, ${stats.polygonCount} shapes, ${stats.islandCount} islands, ${stats.vertexCount.toLocaleString()} vertices, via ${endpoint})`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
