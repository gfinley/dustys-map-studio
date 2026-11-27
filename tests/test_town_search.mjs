import test from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineDistanceKm,
  isPointInViewBounds,
  normalizeViewBounds,
  pickTopCitiesInExtent,
  rankTownResults,
  searchLocalPopulatedPlaces,
  searchTowns,
} from '../site/js/search.js';

function makeJsonResponse(payload, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => payload,
  });
}

test('normalizeViewBounds and isPointInViewBounds handle standard and antimeridian views', () => {
  // Standard regional view (Manila Bay / Bataan)
  const bay = normalizeViewBounds([120.2, 121.1, 14.2, 14.8]);
  assert.equal(bay.crossesAntimeridian, false);
  assert.equal(bay.isFullWorld, false);
  assert.equal(isPointInViewBounds(14.43, 120.49, bay), true);
  assert.equal(isPointInViewBounds(37.3382, -121.8863, bay), false);

  // Antimeridian crossing view (Aleutians / Attu / Bering Sea: 168°E .. 196°E = -164°W)
  const aleutians = normalizeViewBounds([168, 196, 51, 56], { lat: 53.5, lon: -178 });
  assert.equal(aleutians.crossesAntimeridian, true);
  assert.equal(isPointInViewBounds(52.84, 173.18, aleutians), true); // Attu (East side of 180°)
  assert.equal(isPointInViewBounds(51.88, -176.65, aleutians), true); // Adak (West side of 180°)
  assert.equal(isPointInViewBounds(53.87, -166.54, aleutians), true); // Unalaska
  assert.equal(isPointInViewBounds(48.5, 31.2, aleutians), false); // Ukraine

  // Wrapped object input where west > east (e.g. west: 170, east: -170)
  const wrapped = normalizeViewBounds({ west: 170, east: -170, south: 50, north: 58 });
  assert.equal(wrapped.crossesAntimeridian, true);
  assert.equal(isPointInViewBounds(52.84, 173.18, wrapped), true);
  assert.equal(isPointInViewBounds(51.88, -176.65, wrapped), true);
  assert.equal(isPointInViewBounds(52.0, 0.0, wrapped), false);
});

test('haversineDistanceKm computes accurate distance including across the antimeridian', () => {
  const kyivToLviv = haversineDistanceKm(50.4501, 30.5234, 49.8397, 24.0297);
  assert.ok(kyivToLviv > 450 && kyivToLviv < 490, `Expected ~468 km, got ${kyivToLviv}`);

  // Two points 2° apart across the antimeridian at 52°N
  const crossDateLine = haversineDistanceKm(52.0, 179.0, 52.0, -179.0);
  assert.ok(crossDateLine > 125 && crossDateLine < 150, `Expected ~137 km, got ${crossDateLine}`);
});

test('rankTownResults strongly biases visible-area towns ahead of larger global cities', () => {
  // User is zoomed into Oregon (Springfield, OR is inside view; Springfield, IL & MO are outside)
  const oregonView = normalizeViewBounds([-124.8, -119.5, 42.5, 45.8], { lat: 44.1, lon: -122.2 });

  const candidates = [
    {
      name: 'Springfield',
      displayName: 'Springfield, Sangamon County, Illinois, United States',
      lat: 39.7817,
      lon: -89.6501,
      type: 'city',
      population: 114394,
      importance: 0.78,
      source: 'nominatim',
    },
    {
      name: 'Springfield',
      displayName: 'Springfield, Greene County, Missouri, United States',
      lat: 37.209,
      lon: -93.2923,
      type: 'city',
      population: 169176,
      importance: 0.81,
      source: 'photon',
    },
    {
      name: 'Springfield',
      displayName: 'Springfield, Lane County, Oregon, United States',
      lat: 44.0462,
      lon: -123.022,
      type: 'city',
      population: 61851,
      importance: 0.62,
      source: 'nominatim',
    },
    {
      name: 'Springfield Road',
      displayName: 'Springfield Road, Eugene, Oregon, United States',
      lat: 44.05,
      lon: -123.05,
      type: 'road',
      osmCategory: 'highway',
      source: 'photon',
    },
  ];

  const ranked = rankTownResults(candidates, 'Springfield', oregonView, 8);
  assert.equal(ranked.length, 4);
  assert.equal(ranked[0].displayName, 'Springfield, Lane County, Oregon, United States');
  assert.equal(ranked[0].inView, true);
  assert.equal(ranked[1].type, 'city');
  assert.equal(ranked[2].type, 'city');
  assert.equal(ranked[3].name, 'Springfield Road');
  assert.equal(ranked[3].inView, true);
});

test('rankTownResults deduplicates same town across local, Nominatim, and Photon while preserving capital metadata', () => {
  const ukraineView = normalizeViewBounds([22, 41, 44, 53], { lat: 48.5, lon: 31.2 });

  const candidates = [
    {
      name: 'Kyiv',
      displayName: 'Kyiv, Ukraine',
      lat: 50.45,
      lon: 30.523,
      type: 'capital',
      isCapital: true,
      population: 2952000,
      source: 'local',
    },
    {
      name: 'Kyiv',
      displayName: 'Kyiv, Ukraine',
      lat: 50.4501,
      lon: 30.5234,
      type: 'city',
      isCapital: false,
      population: 0,
      source: 'photon',
    },
    {
      name: 'Kyiv',
      displayName: 'Kyiv, Kyiv City, Ukraine',
      lat: 50.4504,
      lon: 30.5245,
      type: 'city',
      isCapital: true,
      population: 2967360,
      source: 'nominatim',
    },
  ];

  const ranked = rankTownResults(candidates, 'Kyiv', ukraineView, 8);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, 'Kyiv');
  assert.equal(ranked[0].isCapital, true);
  assert.equal(ranked[0].typeLabel, 'Capital');
  assert.equal(ranked[0].inView, true);
  assert.equal(ranked[0].context, 'Kyiv City, Ukraine');
});

test('searchLocalPopulatedPlaces supports diacritic-insensitive matching and view-bias ranking', () => {
  const placesFc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-121.8863, 37.3382] },
        properties: { name: 'San Jose', adm1name: 'California', adm0name: 'United States', pop_max: 1021795, scalerank: 2 },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-84.0907, 9.9281] },
        properties: { name: 'San José', adm0name: 'Costa Rica', adm0cap: 1, pop_max: 342188, scalerank: 3 },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [120.9896, 15.7928] },
        properties: { name: 'San Jose', adm1name: 'Nueva Ecija', adm0name: 'Philippines', pop_max: 150917, scalerank: 6 },
      },
    ],
  };

  // Framed on Luzon / Philippines
  const luzonView = normalizeViewBounds([119.5, 122.8, 13.5, 17.0], { lat: 15.2, lon: 121.1 });
  const results = searchLocalPopulatedPlaces(placesFc, 'san jose', { bounds: luzonView, limit: 5 });

  assert.equal(results.length, 3);
  assert.equal(results[0].context, 'Nueva Ecija, Philippines');
  assert.equal(results[0].inView, true);
  assert.equal(results.some((r) => r.name === 'San José' && r.isCapital), true);
});

test('searchTowns queries bounded Nominatim + view-biased Photon and puts in-view towns first', async () => {
  const requestedUrls = [];
  const mockFetch = (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes('nominatim.openstreetmap.org')) {
      return makeJsonResponse([
        {
          name: 'Balanga',
          display_name: 'Balanga, Bataan, Central Luzon, Philippines',
          lat: '14.6760',
          lon: '120.5363',
          addresstype: 'city',
          boundingbox: ['14.62', '14.71', '120.47', '120.57'],
          importance: 0.45,
          extratags: { population: '104173' },
        },
      ]);
    }
    if (String(url).includes('photon.komoot.io')) {
      return makeJsonResponse({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [120.5363, 14.676] },
            properties: { name: 'Balanga', state: 'Bataan', country: 'Philippines', osm_key: 'place', osm_value: 'city' },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [14.5, 50.2] },
            properties: { name: 'Balanga', country: 'Faraway', osm_key: 'place', osm_value: 'town' },
          },
        ],
      });
    }
    return makeJsonResponse([], false, 404);
  };

  const results = await searchTowns('Balanga', {
    viewBounds: [120.2, 121.0, 14.2, 14.9],
    center: { lat: 14.55, lon: 120.6 },
    span: { lonDeg: 0.8, latDeg: 0.7 },
    limit: 6,
    fetchImpl: mockFetch,
  });

  assert.equal(requestedUrls.length, 2);
  const nomUrl = requestedUrls.find((u) => u.includes('nominatim'));
  const phoUrl = requestedUrls.find((u) => u.includes('photon'));
  assert.ok(nomUrl.includes('featureType=settlement'));
  assert.ok(nomUrl.includes('bounded=1'));
  assert.ok(nomUrl.includes('viewbox='));
  assert.ok(phoUrl.includes('lat=14.5500'));
  assert.ok(phoUrl.includes('lon=120.6000'));
  assert.ok(phoUrl.includes('location_bias_scale='));
  assert.ok(phoUrl.includes('layer=city'));

  assert.equal(results.length, 2);
  assert.equal(results[0].name, 'Balanga');
  assert.equal(results[0].inView, true);
  assert.equal(results[0].context, 'Bataan, Central Luzon, Philippines');
  assert.equal(results[1].inView, false);
});

test('searchTowns avoids inverted Nominatim viewbox across antimeridian and falls back cleanly', async () => {
  const requestedUrls = [];
  const mockFetch = (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes('nominatim.openstreetmap.org')) {
      return makeJsonResponse([]);
    }
    if (String(url).includes('photon.komoot.io')) {
      return makeJsonResponse({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-176.6581, 51.88] },
            properties: { name: 'Adak', state: 'Alaska', country: 'United States', osm_key: 'place', osm_value: 'town' },
          },
        ],
      });
    }
    return makeJsonResponse([], false, 500);
  };

  const results = await searchTowns('Adak', {
    viewBounds: [170, 195, 50, 56],
    center: { lat: 53.0, lon: -177.5 },
    span: { lonDeg: 25, latDeg: 6 },
    fetchImpl: mockFetch,
  });

  const nomUrl = requestedUrls.find((u) => u.includes('nominatim'));
  assert.ok(nomUrl && !nomUrl.includes('viewbox='), `Did not expect viewbox across antimeridian: ${nomUrl}`);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Adak');
  assert.equal(results[0].inView, true);
});

test('searchTowns falls back to unbounded Nominatim when Photon fails and town is outside visible area', async () => {
  const requestedUrls = [];
  const mockFetch = (url) => {
    const s = String(url);
    requestedUrls.push(s);
    if (s.includes('photon.komoot.io')) {
      return Promise.reject(new Error('Network offline'));
    }
    if (s.includes('nominatim') && s.includes('bounded=1')) {
      return makeJsonResponse([]);
    }
    if (s.includes('nominatim') && !s.includes('bounded=1')) {
      return makeJsonResponse([
        {
          name: 'Tokyo',
          display_name: 'Tokyo, Japan',
          lat: '35.6762',
          lon: '139.6503',
          addresstype: 'city',
          extratags: { capital: 'yes', population: '14000000' },
        },
      ]);
    }
    return makeJsonResponse([]);
  };

  const results = await searchTowns('Tokyo', {
    viewBounds: [22, 41, 44, 53],
    center: { lat: 48.5, lon: 31.2 },
    span: { lonDeg: 19, latDeg: 9 },
    fetchImpl: mockFetch,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Tokyo');
  assert.equal(results[0].isCapital, true);
  assert.equal(results[0].inView, false);
  assert.ok(requestedUrls.some((u) => u.includes('nominatim') && !u.includes('bounded=1')));
});

test('searchTowns returns local populated places when network fails completely', async () => {
  const placesFc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-165.4064, 64.5011] },
        properties: { name: 'Nome', adm1name: 'Alaska', adm0name: 'United States', pop_max: 3700, scalerank: 6 },
      },
    ],
  };

  const results = await searchTowns('Nome', {
    viewBounds: [-170, -140, 58, 68],
    populatedPlaces: placesFc,
    fetchImpl: () => Promise.reject(new Error('Offline')),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Nome');
  assert.equal(results[0].inView, true);
});

test('pickTopCitiesInExtent remains self-contained and antimeridian-aware', () => {
  const dataset = {
    populatedPlaces: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [177.51, 64.73] },
          properties: { name: 'Anadyr', adm0name: 'Russia', pop_max: 15000, scalerank: 6 },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-165.4064, 64.5011] },
          properties: { name: 'Nome', adm0name: 'United States', pop_max: 3700, scalerank: 7 },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [30.5234, 50.4501] },
          properties: { name: 'Kyiv', adm0name: 'Ukraine', adm0cap: 1, pop_max: 2952000, scalerank: 2 },
        },
      ],
    },
  };

  const picked = pickTopCitiesInExtent(dataset, { lat: 64.5, lon: -175 }, { lonDeg: 30, latDeg: 10 }, 5);
  assert.deepEqual(
    picked.map((c) => c.name),
    ['Anadyr', 'Nome'],
  );
});
