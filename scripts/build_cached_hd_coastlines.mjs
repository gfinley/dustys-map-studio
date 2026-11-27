#!/usr/bin/env node
/**
 * Build script for site-cached hyper-accurate OpenStreetMap HD coastline packs.
 *
 * Fetches full-resolution (1–5 m, zero simplification) OSM `natural=coastline`
 * ways via Overpass, polygonizes them with the studio's exact pure-JS polygonizer
 * (`site/js/osm-coastline.js`), verifies expected islands & topology, and writes
 * compact GeoJSON FeatureCollections to `site/data/hd_coastlines/`.
 *
 * Usage:
 *   node scripts/build_cached_hd_coastlines.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
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
];

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

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const pack of PACK_SPECS) {
    console.log(`\nFetching ${pack.name} (${JSON.stringify(pack.bbox)})...`);
    const query = buildOverpassCoastlineQuery(pack.bbox, { timeoutSec: 45 });
    const { json, endpoint } = await fetchOverpassJson(query);
    const { geojson, stats } = polygonizeOverpassCoastlines(json, pack.bbox, { simplifyMeters: 0 });

    if (stats.incompleteChains > 0) {
      throw new Error(`${pack.id}: detected ${stats.incompleteChains} incomplete coastline chains`);
    }
    if (geojson.features.length === 0) {
      throw new Error(`${pack.id}: produced 0 polygons`);
    }

    // Verify every expected island is present with reasonable area
    for (const exp of pack.expectedFeatures) {
      const match = geojson.features.find((f) => {
        if (f.properties?.kind !== 'island') return false;
        const bb = featureBBox(f);
        const area = Number(f.properties?.area_km2 || 0);
        return (
          exp.lon >= bb.minLon - 0.005 &&
          exp.lon <= bb.maxLon + 0.005 &&
          exp.lat >= bb.minLat - 0.005 &&
          exp.lat <= bb.maxLat + 0.005 &&
          area >= exp.minAreaKm2
        );
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
        source: 'OpenStreetMap contributors (ODbL) via Overpass API',
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
