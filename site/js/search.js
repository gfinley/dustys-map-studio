import { sanitizeFilename } from './schema.js?v=21';
import { getCitiesInBounds } from './data-loader.js?v=21';

function clamp(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeLon(lon) {
  let x = Number(lon);
  if (!Number.isFinite(x)) return 0;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function inferSpanByType(typeHint) {
  const t = String(typeHint || '').toLowerCase();
  if (t.includes('continent')) return { lonDeg: 75, latDeg: 50 };
  if (t.includes('country') || t === 'administrative') return { lonDeg: 22, latDeg: 14 };
  if (t.includes('state') || t.includes('province') || t.includes('region')) return { lonDeg: 10, latDeg: 7 };
  if (t.includes('county') || t.includes('district')) return { lonDeg: 3.5, latDeg: 2.5 };
  if (t.includes('city') || t.includes('town') || t.includes('municipality')) return { lonDeg: 2.5, latDeg: 1.8 };
  return { lonDeg: 4.0, latDeg: 3.0 };
}

function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const outerSignal = options.signal;

  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) {
      controller.abort();
    } else {
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    if (outerSignal) {
      outerSignal.removeEventListener('abort', onOuterAbort);
    }
  });
}

function normalizeNominatimItem(item) {
  const lat = clamp(item.lat, -89.5, 89.5, 0);
  const lon = normalizeLon(item.lon);
  const type = String(item.addresstype || item.type || item.category || 'place');
  const fallbackSpan = inferSpanByType(type);

  let spanLatDeg = fallbackSpan.latDeg;
  let spanLonDeg = fallbackSpan.lonDeg;

  if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
    const south = Number(item.boundingbox[0]);
    const north = Number(item.boundingbox[1]);
    const west = Number(item.boundingbox[2]);
    const east = Number(item.boundingbox[3]);

    if ([south, north, west, east].every(Number.isFinite)) {
      const rawLat = Math.abs(north - south);
      const rawLon = east >= west ? (east - west) : (360 - west + east);
      if (rawLat > 0.005) {
        spanLatDeg = clamp(rawLat * 1.25, 0.05, 140.0, fallbackSpan.latDeg);
      }
      if (rawLon > 0.005) {
        spanLonDeg = clamp(rawLon * 1.25, 0.05, 140.0, fallbackSpan.lonDeg);
      }
    }
  }

  const addr = item.address || {};
  const shortName =
    item.name ||
    addr.city ||
    addr.town ||
    addr.village ||
    addr.state ||
    addr.country ||
    String(item.display_name || '').split(',')[0].trim() ||
    'Location';

  return {
    name: String(shortName).trim(),
    displayName: String(item.display_name || shortName).trim(),
    lat: Number(lat.toFixed(4)),
    lon: Number(lon.toFixed(4)),
    spanLonDeg: Number(spanLonDeg.toFixed(3)),
    spanLatDeg: Number(spanLatDeg.toFixed(3)),
    type,
  };
}

function normalizePhotonFeature(feature) {
  const coords = feature?.geometry?.coordinates || [0, 0];
  const props = feature?.properties || {};
  const lon = normalizeLon(coords[0]);
  const lat = clamp(coords[1], -89.5, 89.5, 0);
  const type = String(props.osm_value || props.type || 'place');
  const fallbackSpan = inferSpanByType(type);

  let spanLonDeg = fallbackSpan.lonDeg;
  let spanLatDeg = fallbackSpan.latDeg;

  // Photon extent is [minLon, maxLat, maxLon, minLat]
  if (Array.isArray(props.extent) && props.extent.length === 4) {
    const [minLon, maxLat, maxLon, minLat] = props.extent.map(Number);
    if ([minLon, maxLat, maxLon, minLat].every(Number.isFinite)) {
      const rawLat = Math.abs(maxLat - minLat);
      const rawLon = maxLon >= minLon ? (maxLon - minLon) : (360 - minLon + maxLon);
      if (rawLat > 0.005) {
        spanLatDeg = clamp(rawLat * 1.25, 0.05, 140.0, fallbackSpan.latDeg);
      }
      if (rawLon > 0.005) {
        spanLonDeg = clamp(rawLon * 1.25, 0.05, 140.0, fallbackSpan.lonDeg);
      }
    }
  }

  const name = String(props.name || props.city || props.state || props.country || 'Location').trim();
  const parts = [];
  for (const part of [props.name, props.city, props.state, props.country]) {
    if (part && !parts.includes(part)) parts.push(part);
  }

  return {
    name,
    displayName: parts.join(', ') || name,
    lat: Number(lat.toFixed(4)),
    lon: Number(lon.toFixed(4)),
    spanLonDeg: Number(spanLonDeg.toFixed(3)),
    spanLatDeg: Number(spanLatDeg.toFixed(3)),
    type,
  };
}

/**
 * Search places worldwide via Nominatim with automatic Photon fallback.
 * Returns normalized { name, displayName, lat, lon, spanLonDeg, spanLatDeg, type } items.
 */
export async function searchPlaces(query, { signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=6&addressdetails=1`;
  try {
    const res = await fetchWithTimeout(
      nominatimUrl,
      {
        headers: { Accept: 'application/json' },
        signal,
      },
      6500,
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.map(normalizeNominatimItem);
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError' && signal?.aborted) {
      throw err;
    }
    // Fall through to Photon
  }

  const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`;
  const photonRes = await fetchWithTimeout(
    photonUrl,
    {
      headers: { Accept: 'application/json' },
      signal,
    },
    6500,
  );
  if (!photonRes.ok) {
    throw new Error(`Place search failed (HTTP ${photonRes.status})`);
  }
  const photonData = await photonRes.json();
  const features = Array.isArray(photonData?.features) ? photonData.features : [];
  return features.map(normalizePhotonFeature);
}

function shortestLonDiff(lonA, lonB) {
  let diff = ((lonA - lonB + 540) % 360) - 180;
  if (diff < -180) diff += 360;
  return diff;
}

function extractCityRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // GeoJSON Feature
  if (raw.type === 'Feature' && raw.geometry && raw.properties) {
    const coords = raw.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const p = raw.properties;
    const name = p.NAME || p.name || p.NAMEASCII || p.nameascii || p.LABEL || '';
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const pop = Number(p.POP_MAX ?? p.pop_max ?? p.POP_MIN ?? p.population ?? 0) || 0;
    const scalerank = Number(p.SCALERANK ?? p.scalerank ?? 10);
    const featureCla = String(p.FEATURECLA ?? p.featurecla ?? '').toLowerCase();
    const adm0Cap = Number(p.ADM0CAP ?? p.adm0cap ?? 0) === 1;
    const isCapital = adm0Cap || featureCla.includes('capital');
    return {
      name: String(name).trim(),
      lat,
      lon,
      pop,
      scalerank: Number.isFinite(scalerank) ? scalerank : 10,
      isCapital,
      country: String(p.ADM0NAME ?? p.adm0name ?? p.SOV0NAME ?? p.country ?? '').trim(),
    };
  }

  // Flat record
  const name = raw.name || raw.NAME || raw.nameascii || '';
  const lat = Number(raw.lat ?? raw.LATITUDE ?? raw.latitude);
  const lon = Number(raw.lon ?? raw.lng ?? raw.LONGITUDE ?? raw.longitude);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const pop = Number(raw.pop_max ?? raw.POP_MAX ?? raw.population ?? raw.pop ?? 0) || 0;
  const scalerank = Number(raw.scalerank ?? raw.SCALERANK ?? 10);
  const isCapital = Boolean(
    raw.isCapital ||
      raw.capital ||
      Number(raw.adm0cap ?? raw.ADM0CAP ?? 0) === 1 ||
      String(raw.featurecla ?? raw.FEATURECLA ?? '').toLowerCase().includes('capital') ||
      raw.style === 'capital',
  );
  return {
    name: String(name).trim(),
    lat,
    lon,
    pop,
    scalerank: Number.isFinite(scalerank) ? scalerank : 10,
    isCapital,
    country: String(raw.country ?? raw.adm0name ?? raw.ADM0NAME ?? '').trim(),
  };
}

/**
 * Picks top populated cities / capitals inside the current map extent.
 * Handles antimeridian wrapping and accepts either GeoJSON FeatureCollection or flat arrays.
 */
export function pickTopCitiesInExtent(populatedPlaces, center, span, limit = 8) {
  const cLat = Number(center?.lat ?? 0);
  const cLon = Number(center?.lon ?? 0);
  const halfLon = Math.max(0.02, Number(span?.lonDeg ?? 20) / 2) * 0.92;
  const halfLat = Math.max(0.02, Number(span?.latDeg ?? 15) / 2) * 0.92;

  const minLat = Math.max(-89.5, cLat - halfLat);
  const maxLat = Math.min(89.5, cLat + halfLat);
  const minLon = halfLon >= 180 ? -180 : normalizeLon(cLon - halfLon);
  const maxLon = halfLon >= 180 ? 180 : normalizeLon(cLon + halfLon);

  let inside = [];
  const datasetLike = populatedPlaces?.populatedPlaces?.features
    ? populatedPlaces
    : Array.isArray(populatedPlaces?.features)
      ? { populatedPlaces }
      : null;

  if (datasetLike) {
    inside = getCitiesInBounds(datasetLike, { minLon, maxLon, minLat, maxLat }).map((city) => ({
      name: city.name,
      lat: city.lat,
      lon: city.lon,
      pop: city.popMax || 0,
      scalerank: city.scalerank ?? 10,
      isCapital: Boolean(city.isCapital),
      country: city.country || '',
    }));
  } else if (Array.isArray(populatedPlaces)) {
    for (const item of populatedPlaces) {
      const rec = extractCityRecord(item);
      if (!rec) continue;
      const dLat = Math.abs(rec.lat - cLat);
      const dLon = Math.abs(shortestLonDiff(rec.lon, cLon));
      if (dLat <= halfLat && dLon <= halfLon) {
        inside.push(rec);
      }
    }
  }

  if (!inside.length) return [];

  inside.sort((a, b) => {
    if (a.isCapital !== b.isCapital) return a.isCapital ? -1 : 1;
    if (a.scalerank !== b.scalerank) return a.scalerank - b.scalerank;
    return b.pop - a.pop;
  });

  const seen = new Set();
  const picked = [];
  for (const city of inside) {
    const key = city.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({
      id: `${sanitizeFilename(city.name, 'city').toLowerCase()}_${Math.round((city.lat + 90) * 100)}_${Math.round((city.lon + 180) * 100)}`,
      name: city.name,
      lat: Number(city.lat.toFixed(4)),
      lon: Number(city.lon.toFixed(4)),
      style: city.isCapital ? 'capital' : 'dot',
      dx: 6,
      dy: -5,
      population: city.pop,
      country: city.country,
    });
    if (picked.length >= limit) break;
  }

  return picked;
}
