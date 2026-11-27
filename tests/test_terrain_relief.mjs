import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TERRAIN_STYLES,
  chooseAutoContourInterval,
  computeAltitudeScaleInfo,
  computeDemStats,
  contourSegmentsToSvgPath,
  decodeTerrariumElevation,
  extractContourSegments,
  extractRelativeSummits,
  isViewOutsideTerrainBounds,
  planTerrainTiles,
  renderTerrainRasterPixels,
  resolveContourPalette,
  resolveEffectiveContourInterval,
  sampleAltitudeRampColor,
  sampleAltitudeRampRgb,
  sampleDemElevation,
  sampleJogElevationColor,
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

test('Army Topo & JOG apply 1:1 altitude shading + NW relief while Staff Hillshade keeps flat plains transparent', () => {
  const gw = 40;
  const gh = 40;
  const elev = new Float32Array(gw * gh);
  const stepX = new Float32Array(gw * gh).fill(200);
  const stepY = new Float32Array(gw * gh).fill(200);

  // Synthetic terrain: 0m ocean border, 100m lowland plain, 1200m flat high plateau, and 2000m conical peak
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      if (x < 2 || y < 2) {
        elev[y * gw + x] = 0; // sea level
      } else if (x >= 28 && x <= 36 && y >= 4 && y <= 12) {
        elev[y * gw + x] = 1200; // flat elevated plateau
      } else {
        const dist = Math.hypot(x - 16, y - 16);
        elev[y * gw + x] = dist < 10 ? 100 + (10 - dist) * 190 : 100;
      }
    }
  }

  // 1. Army Topo (default): applies tone-matched altitude shading + NW hillshade
  const topoRgba = renderTerrainRasterPixels(elev, stepX, stepY, gw, gh, {
    style: 'army_topo',
    tone: 'sepia',
    intensity: 0.8,
    contrast: 1.0,
    exaggeration: 2.0,
    scaleMax: 2000,
  });

  // Ocean pixel (0, 0) stays fully transparent
  assert.equal(topoRgba[3], 0);

  // Flat lowland (34, 34 @ 100m) vs flat plateau (32, 8 @ 1200m): both shaded, plateau noticeably darker
  const lowIdx = (34 * gw + 34) * 4;
  const platIdx = (8 * gw + 32) * 4;
  assert.ok(topoRgba[lowIdx + 3] > 150, `expected opaque-ish lowland altitude tint, got alpha=${topoRgba[lowIdx + 3]}`);
  assert.ok(topoRgba[platIdx + 3] > 150, `expected opaque-ish plateau altitude tint, got alpha=${topoRgba[platIdx + 3]}`);
  assert.ok(
    topoRgba[lowIdx] > topoRgba[platIdx] + 35,
    `expected 100m lowland (${topoRgba[lowIdx]}) to be much lighter than 1200m plateau (${topoRgba[platIdx]})`,
  );

  // Flat plateau pixel matches sampleAltitudeRampRgb(1200, 2000) within 1 LUT step
  const expectedPlat = sampleAltitudeRampRgb(1200, 2000, { style: 'army_topo', tone: 'sepia', contrast: 1.0 });
  assert.ok(Math.abs(topoRgba[platIdx] - expectedPlat[0]) <= 3);
  assert.ok(Math.abs(topoRgba[platIdx + 1] - expectedPlat[1]) <= 3);
  assert.ok(Math.abs(topoRgba[platIdx + 2] - expectedPlat[2]) <= 3);

  // NW slope (12, 12) is brighter than SE slope (20, 20) at the same elevation
  const nwIdx = (12 * gw + 12) * 4;
  const seIdx = (20 * gw + 20) * 4;
  assert.ok(
    topoRgba[nwIdx] > topoRgba[seIdx] + 30,
    `expected NW slope (${topoRgba[nwIdx]}) brighter than SE slope (${topoRgba[seIdx]})`,
  );

  // 2. Staff Hillshade: pure slope shading — flat plains stay transparent
  const hsRgba = renderTerrainRasterPixels(elev, stepX, stepY, gw, gh, {
    style: 'staff_hillshade',
    intensity: 0.8,
    exaggeration: 2.0,
  });
  assert.equal(hsRgba[3], 0);
  assert.equal(hsRgba[lowIdx + 3], 0, 'Staff Hillshade flat plain must stay transparent');
  assert.ok(hsRgba[nwIdx] > 200 && hsRgba[nwIdx + 3] > 20, `expected NW sunlit highlight, got rgba=${hsRgba.slice(nwIdx, nwIdx + 4)}`);
  assert.ok(hsRgba[seIdx] < 50 && hsRgba[seIdx + 3] > 20, `expected SE shadow, got rgba=${hsRgba.slice(seIdx, seIdx + 4)}`);

  // 3. JOG Operational: distinct color elevation shading across lowland vs plateau, matching sampleAltitudeRampRgb
  const jogRgba = renderTerrainRasterPixels(elev, stepX, stepY, gw, gh, {
    style: 'jog_elevation',
    intensity: 0.75,
    exaggeration: 2.0,
    scaleMax: 2000,
  });
  assert.equal(jogRgba[3], 0);
  assert.ok(jogRgba[platIdx + 3] > 150);
  // Lowland (100m) is greenish (G > R), high plateau (1200m) shifts warm ochre/tan (R > G)
  assert.ok(jogRgba[lowIdx + 1] > jogRgba[lowIdx], `expected green lowland in JOG, got rgb=${jogRgba.slice(lowIdx, lowIdx + 3)}`);
  assert.ok(jogRgba[platIdx] > jogRgba[platIdx + 1], `expected warm ochre/tan plateau in JOG, got rgb=${jogRgba.slice(platIdx, platIdx + 3)}`);
});

test('Marching Squares extracts index/intermediate contours and right-side-up elevation labels', () => {
  const gw = 60;
  const gh = 60;
  const elev = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const dist = Math.hypot(x - 30, y - 30);
      elev[y * gw + x] = Math.max(0, 1250 - dist * 52);
    }
  }

  const smoothed = smoothElevationGrid(elev, gw, gh);
  const stats = computeDemStats(smoothed);
  assert.ok(stats.maxLandElev > 1000);

  const contours = extractContourSegments(smoothed, gw, gh, 600, 600, 100, stats.maxLandElev, {
    includeLabels: true,
  });
  assert.ok(contours.levels.includes(500), 'expected 500m index level');
  assert.ok(contours.levels.includes(1000), 'expected 1000m index level');
  assert.ok(contours.indexSegments.length >= 16, 'expected index contour segments');
  assert.ok(contours.intermediateSegments.length >= 32, 'expected intermediate contour segments');
  assert.ok(contours.labels.length >= 2, `expected elevation labels along index contours, got ${contours.labels.length}`);
  assert.ok(
    contours.labels.some((l) => l.level === contours.topLevel && l.isTopLevel),
    `expected uppermost contour level (${contours.topLevel}m) to be labeled`,
  );

  for (const lbl of contours.labels) {
    assert.match(lbl.text, /^\d+m$/);
    assert.ok(lbl.angleRad > -Math.PI * 0.5 - 1e-6 && lbl.angleRad <= Math.PI * 0.5 + 1e-6, 'label should stay right-side up');
  }

  const noLabels = extractContourSegments(smoothed, gw, gh, 600, 600, 100, stats.maxLandElev, {
    includeLabels: false,
  });
  assert.equal(noLabels.labels.length, 0);

  const svgD = contourSegmentsToSvgPath(contours.indexSegments);
  assert.ok(svgD.startsWith('M') && svgD.includes('L'));
});

test('extractRelativeSummits detects prominent peaks and respects minimum peak spacing', () => {
  const gw = 80;
  const gh = 80;
  const elev = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const p1 = Math.max(0, 2150 - Math.hypot(x - 24, y - 28) * 95);
      const p2 = Math.max(0, 1680 - Math.hypot(x - 56, y - 52) * 90);
      elev[y * gw + x] = Math.max(80, p1, p2);
    }
  }
  const smoothed = smoothElevationGrid(elev, gw, gh);
  const summits = extractRelativeSummits(smoothed, gw, gh, 800, 800, {
    rawElevGrid: elev,
    intervalMeters: 200,
    maxElevHint: 2150,
  });
  assert.equal(summits.length, 2, `expected 2 distinct relative summits, got ${summits.length}`);
  assert.ok(summits[0].elev >= 2100 && summits[0].elev <= 2160, `primary summit elev=${summits[0].elev}`);
  assert.ok(summits[1].elev >= 1640 && summits[1].elev <= 1700, `secondary summit elev=${summits[1].elev}`);
  assert.match(summits[0].text, /^2,\d{3}m$/);
});

test('Auto contour interval, contrast/tone palettes, custom contour color, and stale-view bounds checks', () => {
  assert.equal(chooseAutoContourInterval(2600, 2.0), 200);
  assert.equal(chooseAutoContourInterval(2600, 25.0), 250);
  assert.equal(resolveEffectiveContourInterval(100, 2000, 3.0), 100);
  assert.ok(resolveEffectiveContourInterval(20, 6000, 5.0) >= 100, 'should cap pathological contour floods');

  const lightPalette = resolveContourPalette('#ebe6da', 'staff_hillshade');
  const darkPalette = resolveContourPalette('#1d3c5e', 'staff_hillshade');
  const topoDarkBase = resolveContourPalette('#1d3c5e', 'army_topo', { tone: 'charcoal' });
  const bwPalette = resolveContourPalette('#ebe6da', 'army_topo', { tone: 'bw_print', contrast: 1.8 });
  const customPalette = resolveContourPalette('#ebe6da', 'army_topo', { contourColor: '#8b0000' });
  assert.notEqual(lightPalette.indexColor, darkPalette.indexColor);
  assert.equal(topoDarkBase.indexColor, '#5a2f12', 'hypsometric army_topo uses crisp dark topo ink over light altitude shading');
  assert.notEqual(bwPalette.indexColor, lightPalette.indexColor);
  assert.equal(customPalette.indexColor, '#8b0000');
  assert.ok(bwPalette.indexAlpha > lightPalette.indexAlpha, 'higher contrast should raise contour crispness');
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
  assert.equal(def.terrainRelief.contrast, 1.0);
  assert.equal(def.terrainRelief.tone, 'charcoal');
  assert.equal(def.terrainRelief.showContours, false);
  assert.equal(def.terrainRelief.showContourLabels, true);
  assert.equal(def.terrainRelief.contourColor, 'auto');
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
      contrast: 1.65,
      exaggeration: 3.1,
      tone: 'sepia',
      showContours: true,
      showContourLabels: true,
      contourColor: '#6b2c12',
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
  assert.equal(decoded.terrainRelief.contrast, 1.65);
  assert.equal(decoded.terrainRelief.tone, 'sepia');
  assert.equal(decoded.terrainRelief.showContours, true);
  assert.equal(decoded.terrainRelief.showContourLabels, true);
  assert.equal(decoded.terrainRelief.contourColor, '#6b2c12');
  assert.equal(decoded.terrainRelief.contourInterval, 200);
  assert.equal(decoded.terrainRelief.showAltitudeScale, true);
  assert.equal(decoded.terrainRelief.altitudeScalePosition, 'bottom-right');
  assert.equal(decoded.terrainRelief.bounds.zoom, 8);
});

test('computeAltitudeScaleInfo builds clean altitude ticks, index interval, and matched ramp colors', () => {
  const baseDef = createDefaultMapSpec();
  const dem = { stats: { maxLandElev: 2295, p98LandElev: 2100 } };

  const topoSpec = normalizeMapSpec({
    ...baseDef,
    span: { lonDeg: 10, latDeg: 7 },
    terrainRelief: { enabled: true, style: 'army_topo', showContours: true, showAltitudeScale: true },
  });
  const topoInfo = computeAltitudeScaleInfo(topoSpec, dem);
  assert.ok(topoInfo);
  assert.equal(topoInfo.hasHypsometric, true);
  assert.equal(topoInfo.maxElev, 2295);
  assert.ok(topoInfo.scaleMax >= 2295);
  assert.equal(topoInfo.ticks[0], 0);
  assert.equal(topoInfo.ticks[topoInfo.ticks.length - 1], topoInfo.scaleMax);
  assert.ok(topoInfo.ticks.length >= 3 && topoInfo.ticks.length <= 6);

  const hsSpec = normalizeMapSpec({
    ...baseDef,
    terrainRelief: { enabled: true, style: 'staff_hillshade', showAltitudeScale: true },
  });
  const hsInfo = computeAltitudeScaleInfo(hsSpec, dem);
  assert.equal(hsInfo.hasHypsometric, false);

  assert.match(sampleAltitudeRampColor(1200, 2500, { style: 'army_topo', tone: 'olive', contrast: 1.2 }), /^rgb\(\d+, \d+, \d+\)$/);
  assert.match(sampleJogElevationColor(1200, { tone: 'sepia', contrast: 1.4 }), /^rgb\(\d+, \d+, \d+\)$/);
});
