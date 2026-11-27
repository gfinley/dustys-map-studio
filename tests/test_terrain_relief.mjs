import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TERRAIN_STYLES,
  chooseAutoContourInterval,
  computeDemStats,
  contourSegmentsToSvgPath,
  decodeTerrariumElevation,
  extractContourSegments,
  isViewOutsideTerrainBounds,
  planTerrainTiles,
  renderTerrainRasterPixels,
  resolveContourPalette,
  resolveEffectiveContourInterval,
  sampleDemElevation,
  smoothElevationGrid,
  wantsTerrainContours,
} from '../site/js/terrain-relief.js';
import {
  createDefaultMapSpec,
  decodeSpecFromHash,
  encodeSpecToHash,
  normalizeMapSpec,
} from '../site/js/schema.js';

test('Terrarium RGB decoding matches standard elevation formula', () => {
  // Sea level: 128*256 + 0 + 0 - 32768 = 0m
  assert.equal(decodeTerrariumElevation(128, 0, 0), 0);
  // 1,000.5 m -> raw 33768.5 -> r=131, g=232, b=128
  assert.equal(decodeTerrariumElevation(131, 232, 128), 1000.5);
  // Below sea level: -100m -> raw 32668 -> r=127, g=156, b=0
  assert.equal(decodeTerrariumElevation(127, 156, 0), -100);
});

test('planTerrainTiles selects bounded zoom and handles antimeridian crossings cleanly', () => {
  // Luzon regional view
  const luzon = planTerrainTiles([119.5, 123.0, 12.5, 18.6], { maxTiles: 24 });
  assert.ok(luzon.zoom >= 5 && luzon.zoom <= 12, `unexpected zoom ${luzon.zoom}`);
  assert.ok(luzon.tileCount > 0 && luzon.tileCount <= 24, `tileCount ${luzon.tileCount} exceeded max`);
  assert.equal(luzon.width, luzon.cols * 256);
  assert.equal(luzon.height, luzon.rows * 256);

  // Alaska + Aleutians crossing the 180 deg Date Line (unwrapped 170°E to 230°E / 130°W)
  const alaska = planTerrainTiles([170, 230, 50, 71], { maxTiles: 30 });
  assert.ok(alaska.tileCount > 0 && alaska.tileCount <= 30);
  const n = 2 ** alaska.zoom;
  for (const t of alaska.tiles) {
    assert.ok(t.x >= 0 && t.x < n, `wrapped tile x=${t.x} out of range [0, ${n})`);
    assert.ok(t.y >= 0 && t.y < n, `tile y=${t.y} out of range [0, ${n})`);
    assert.ok(t.url.includes(`/terrarium/${t.z}/${t.x}/${t.y}.png`));
  }
});

test('sampleDemElevation bilinearly interpolates across antimeridian mosaic', () => {
  const plan = planTerrainTiles([178, 182, 51, 53], { forcedZoom: 6, maxTiles: 16 });
  const elev = new Float32Array(plan.width * plan.height);
  elev.fill(420);
  const dem = {
    zoom: plan.zoom,
    xStart: plan.xStart,
    yStart: plan.yStart,
    cols: plan.cols,
    rows: plan.rows,
    width: plan.width,
    height: plan.height,
    elev,
  };

  // Both sides of the 180th meridian should sample cleanly inside the mosaic
  assert.ok(Math.abs(sampleDemElevation(dem, 179.5, 52.0) - 420) < 0.01);
  assert.ok(Math.abs(sampleDemElevation(dem, -179.5, 52.0) - 420) < 0.01);
  // Far outside mosaic returns NaN
  assert.ok(Number.isNaN(sampleDemElevation(dem, 10.0, 52.0)));
});

test('Army hillshade lights NW slopes, shadows SE slopes, and keeps flat plains & ocean clean', () => {
  const gw = 32;
  const gh = 32;
  const elev = new Float32Array(gw * gh);
  const stepX = new Float32Array(gw * gh).fill(200);
  const stepY = new Float32Array(gw * gh).fill(200);

  // Synthetic conical mountain centered at (16, 16), peak 2000m, surrounded by flat 100m plain & 0m ocean border
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      if (x < 2 || y < 2) {
        elev[y * gw + x] = 0; // sea level
      } else {
        const dist = Math.hypot(x - 16, y - 16);
        elev[y * gw + x] = dist < 10 ? 100 + (10 - dist) * 190 : 100;
      }
    }
  }

  const rgba = renderTerrainRasterPixels(elev, stepX, stepY, gw, gh, {
    style: 'army_topo',
    intensity: 0.8,
    exaggeration: 2.0,
  });

  // Ocean pixel (0, 0) must stay fully transparent
  assert.equal(rgba[3], 0);

  // Flat plain pixel (29, 29) must stay transparent (alpha 0)
  const flatIdx = (29 * gw + 29) * 4;
  assert.equal(rgba[flatIdx + 3], 0);

  // NW slope pixel (12, 12) faces upper-left light -> warm ivory highlight (R > 200, alpha > 0)
  const nwIdx = (12 * gw + 12) * 4;
  assert.ok(rgba[nwIdx] > 200 && rgba[nwIdx + 3] > 20, `expected NW sunlit highlight, got rgba=${rgba.slice(nwIdx, nwIdx + 4)}`);

  // SE slope pixel (20, 20) faces away from NW light -> charcoal shadow (R < 50, alpha > 0)
  const seIdx = (20 * gw + 20) * 4;
  assert.ok(rgba[seIdx] < 50 && rgba[seIdx + 3] > 20, `expected SE shadow, got rgba=${rgba.slice(seIdx, seIdx + 4)}`);

  // JOG operational hypsometric style renders opaque-ish elevation tint on land, transparent on sea
  const jogRgba = renderTerrainRasterPixels(elev, stepX, stepY, gw, gh, {
    style: 'jog_elevation',
    intensity: 0.75,
    exaggeration: 2.0,
  });
  assert.equal(jogRgba[3], 0);
  const peakIdx = (16 * gw + 16) * 4;
  assert.ok(jogRgba[peakIdx + 3] > 120);
});

test('Marching Squares extracts intermediate and every-5th index contour segments', () => {
  const gw = 40;
  const gh = 40;
  const elev = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const dist = Math.hypot(x - 20, y - 20);
      elev[y * gw + x] = Math.max(0, 1250 - dist * 80);
    }
  }

  const smoothed = smoothElevationGrid(elev, gw, gh);
  const stats = computeDemStats(smoothed);
  assert.ok(stats.maxLandElev > 1000);

  const contours = extractContourSegments(smoothed, gw, gh, 400, 400, 100, stats.maxLandElev);
  assert.ok(contours.levels.includes(500), 'expected 500m index level');
  assert.ok(contours.levels.includes(1000), 'expected 1000m index level');
  assert.ok(contours.indexSegments.length >= 16, 'expected index contour segments');
  assert.ok(contours.intermediateSegments.length >= 32, 'expected intermediate contour segments');

  const svgD = contourSegmentsToSvgPath(contours.indexSegments);
  assert.ok(svgD.startsWith('M') && svgD.includes('L'));
});

test('Auto contour interval, adaptive palette, and stale-view bounds checks behave sensibly', () => {
  assert.equal(chooseAutoContourInterval(2600, 2.0), 200);
  assert.equal(chooseAutoContourInterval(2600, 25.0), 250);
  assert.equal(resolveEffectiveContourInterval(100, 2000, 3.0), 100);
  assert.ok(resolveEffectiveContourInterval(20, 6000, 5.0) >= 100, 'should cap pathological contour floods');

  const lightPalette = resolveContourPalette('#ebe6da', 'army_topo');
  const darkPalette = resolveContourPalette('#1d3c5e', 'army_topo');
  assert.notEqual(lightPalette.indexColor, darkPalette.indexColor);
  assert.equal(Object.keys(TERRAIN_STYLES).length, 4);

  const bounds = { south: 12, west: 119, north: 19, east: 123 };
  assert.equal(isViewOutsideTerrainBounds([120, 122, 13, 18], bounds), false);
  assert.equal(isViewOutsideTerrainBounds([130, 135, 13, 18], bounds), true);
});

test('MapSpec normalizes and URL-hash round-trips terrainRelief config cleanly', () => {
  const def = createDefaultMapSpec();
  assert.equal(def.terrainRelief.enabled, false);
  assert.equal(def.terrainRelief.style, 'army_topo');
  assert.equal(def.terrainRelief.clipMode, 'land');
  assert.equal(def.terrainRelief.showContours, false);
  assert.equal(wantsTerrainContours(def.terrainRelief), false);

  const contoursOnly = normalizeMapSpec({ ...def, terrainRelief: { style: 'topo_contours' } });
  assert.equal(contoursOnly.terrainRelief.showContours, true);
  assert.equal(wantsTerrainContours(contoursOnly.terrainRelief), true);

  const custom = normalizeMapSpec({
    ...def,
    terrainRelief: {
      enabled: true,
      style: 'jog_elevation',
      clipMode: 'highlighted',
      intensity: 0.85,
      exaggeration: 3.1,
      showContours: true,
      contourInterval: 200,
      bounds: { south: 12.1, west: 119.2, north: 18.9, east: 122.8, zoom: 8 },
    },
  });

  const hash = encodeSpecToHash(custom);
  const decoded = decodeSpecFromHash(hash);
  assert.ok(decoded);
  assert.equal(decoded.terrainRelief.enabled, true);
  assert.equal(decoded.terrainRelief.style, 'jog_elevation');
  assert.equal(decoded.terrainRelief.clipMode, 'highlighted');
  assert.equal(decoded.terrainRelief.showContours, true);
  assert.equal(decoded.terrainRelief.contourInterval, 200);
  assert.equal(decoded.terrainRelief.bounds.zoom, 8);
});
