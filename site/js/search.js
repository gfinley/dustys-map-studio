import { sanitizeFilename } from './schema.js?v=34';

const EARTH_RADIUS_KM = 6371.0088;

const SETTLEMENT_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'borough',
  'suburb',
  'quarter',
  'neighbourhood',
  'neighborhood',
  'locality',
  'isolated_dwelling',
  'capital',
  'populated_place',
  'city_district',
  'district',
  'township',
  'census_designated_place',
]);

const PRIMARY_SETTLEMENT_TYPES = new Set([
  'capital',
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'borough',
  'township',
]);

const NON_SETTLEMENT_TYPES = new Set([
  'continent',
  'country',
  'state',
  'province',
  'region',
  'road',
  'street',
  'highway',
  'motorway',
  'residential',
  'path',
  'footway',
  'building',
  'house',
  'shop',
  'amenity',
  'restaurant',
  'cafe',
  'hotel',
  'river',
  'stream',
  'waterway',
  'sea',
  'ocean',
  'railway',
  'station',
  'bus_stop',
]);

const TYPE_LABELS = {
  capital: 'Capital',
  city: 'City',
  town: 'Town',
  village: 'Village',
  hamlet: 'Hamlet',
  municipality: 'Municipality',
  borough: 'Borough',
  suburb: 'Suburb',
  quarter: 'Quarter',
  neighbourhood: 'Neighborhood',
  neighborhood: 'Neighborhood',
  locality: 'Locality',
  isolated_dwelling: 'Settlement',
  district: 'District',
  city_district: 'District',
  township: 'Township',
  county: 'County',
  state: 'State',
  province: 'Province',
  region: 'Region',
  country: 'Country',
  island: 'Island',
  administrative: 'Place',
};

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

function foldText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function formatTypeLabel(type, isCapital = false) {
  if (isCapital) return 'Capital';
  const key = String(type || '').trim().toLowerCase();
  if (!key) return '';
  if (TYPE_LABELS[key]) return TYPE_LABELS[key];
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function inferSpanByType(typeHint) {
  const t = String(typeHint || '').toLowerCase();
  if (t.includes('continent')) return { lonDeg: 75, latDeg: 50 };
  if (t.includes('country') || t === 'administrative') return { lonDeg: 22, latDeg: 14 };
  if (t.includes('state') || t.includes('province') || t.includes('region')) return { lonDeg: 10, latDeg: 7 };
  if (t.includes('county') || t.includes('district')) return { lonDeg: 3.5, latDeg: 2.5 };
  if (t.includes('city') || t.includes('capital') || t.includes('municipality')) return { lonDeg: 2.2, latDeg: 1.6 };
  if (t.includes('town') || t.includes('village') || t.includes('hamlet') || t.includes('locality')) {
    return { lonDeg: 1.2, latDeg: 0.9 };
  }
  return { lonDeg: 4.0, latDeg: 3.0 };
}

function fetchWithTimeout(url, options = {}, timeoutMs = 7000, fetchImpl = fetch) {
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
  return fetchImpl(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    if (outerSignal) {
      outerSignal.removeEventListener('abort', onOuterAbort);
    }
  });
}

function stripLeadingNameFromDisplay(name, displayName) {
  const cleanName = String(name || '').trim();
  const cleanDisplay = String(displayName || '').trim();
  if (!cleanDisplay) return '';
  const parts = cleanDisplay
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return cleanDisplay;
  if (foldText(parts[0]) === foldText(cleanName)) {
    return parts.slice(1).join(', ');
  }
  return cleanDisplay;
}

function normalizeNominatimItem(item) {
  const lat = clamp(item.lat, -89.5, 89.5, 0);
  const lon = normalizeLon(item.lon);
  const rawType = String(item.addresstype || item.type || item.category || 'place').toLowerCase();
  const extratags = item.extratags && typeof item.extratags === 'object' ? item.extratags : {};
  const isCapital =
    extratags.capital === 'yes' ||
    extratags.capital === '2' ||
    Number(extratags.capital) === 2;
  const type = isCapital ? 'capital' : rawType;
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
    addr.hamlet ||
    addr.municipality ||
    addr.suburb ||
    addr.state ||
    addr.country ||
    String(item.display_name || '').split(',')[0].trim() ||
    'Location';
  const cleanName = String(shortName).trim();
  const displayName = String(item.display_name || cleanName).trim();
  const population = Number(extratags.population) || 0;
  const importance = Number.isFinite(Number(item.importance)) ? Number(item.importance) : 0;

  return {
    name: cleanName,
    displayName,
    context: stripLeadingNameFromDisplay(cleanName, displayName),
    lat: Number(lat.toFixed(4)),
    lon: Number(lon.toFixed(4)),
    spanLonDeg: Number(spanLonDeg.toFixed(3)),
    spanLatDeg: Number(spanLatDeg.toFixed(3)),
    type,
    typeLabel: formatTypeLabel(type, isCapital),
    isCapital,
    population,
    importance,
    osmCategory: String(item.category || item.class || '').toLowerCase(),
    source: 'nominatim',
  };
}

function normalizePhotonFeature(feature) {
  const coords = feature?.geometry?.coordinates || [0, 0];
  const props = feature?.properties || {};
  const lon = normalizeLon(coords[0]);
  const lat = clamp(coords[1], -89.5, 89.5, 0);
  const type = String(props.osm_value || props.type || 'place').toLowerCase();
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

  const name = String(props.name || props.city || props.locality || props.state || props.country || 'Location').trim();
  const parts = [];
  for (const part of [props.name, props.city, props.county, props.state, props.country]) {
    if (part && !parts.some((p) => foldText(p) === foldText(part))) {
      parts.push(part);
    }
  }
  const displayName = parts.join(', ') || name;

  return {
    name,
    displayName,
    context: stripLeadingNameFromDisplay(name, displayName),
    lat: Number(lat.toFixed(4)),
    lon: Number(lon.toFixed(4)),
    spanLonDeg: Number(spanLonDeg.toFixed(3)),
    spanLatDeg: Number(spanLatDeg.toFixed(3)),
    type,
    typeLabel: formatTypeLabel(type, false),
    isCapital: false,
    population: 0,
    importance: 0,
    osmCategory: String(props.osm_key || '').toLowerCase(),
    source: 'photon',
  };
}

/**
 * Great-circle distance in kilometers between two lat/lon coordinates (handles antimeridian).
 */
export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = shortestLonDiff(lon2, lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
}

/**
 * Normalize map view bounds from `[minLon, maxLon, minLat, maxLat]`, `{ minLon, maxLon, minLat, maxLat }`,
 * `{ west, east, south, north }`, or fallback `{ center, span }`.
 * Preserves unwrapped longitude span for antimeridian-crossing views (e.g. Alaska & Aleutians).
 */
export function normalizeViewBounds(viewBounds = null, center = null, span = null) {
  let rawMinLon;
  let rawMaxLon;
  let minLat;
  let maxLat;

  if (Array.isArray(viewBounds) && viewBounds.length >= 4) {
    [rawMinLon, rawMaxLon, minLat, maxLat] = viewBounds.map(Number);
  } else if (viewBounds && typeof viewBounds === 'object') {
    rawMinLon = Number(viewBounds.rawMinLon ?? viewBounds.minLon ?? viewBounds.west);
    rawMaxLon = Number(viewBounds.rawMaxLon ?? viewBounds.maxLon ?? viewBounds.east);
    minLat = Number(viewBounds.minLat ?? viewBounds.south);
    maxLat = Number(viewBounds.maxLat ?? viewBounds.north);
  }

  const hasValidBox = [rawMinLon, rawMaxLon, minLat, maxLat].every(Number.isFinite);
  if (!hasValidBox) {
    if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lon))) {
      return null;
    }
    const cLat = clamp(center.lat, -89.5, 89.5, 0);
    const cLon = normalizeLon(center.lon);
    const halfLon = clamp(Number(span?.lonDeg) / 2, 0.02, 180, 12);
    const halfLat = clamp(Number(span?.latDeg) / 2, 0.02, 89.5, 7);
    rawMinLon = cLon - halfLon;
    rawMaxLon = cLon + halfLon;
    minLat = Math.max(-89.5, cLat - halfLat);
    maxLat = Math.min(89.5, cLat + halfLat);
  }

  if (minLat > maxLat) {
    [minLat, maxLat] = [maxLat, minLat];
  }
  minLat = clamp(minLat, -89.5, 89.5, -89.5);
  maxLat = clamp(maxLat, -89.5, 89.5, 89.5);

  if (rawMinLon > rawMaxLon) {
    // Wrapped representation (e.g. west=165, east=-170) -> unwrap east past 180
    rawMaxLon += 360;
  }

  const lonSpan = Math.max(0.01, Math.min(360, rawMaxLon - rawMinLon));
  const latSpan = Math.max(0.01, Math.min(179, maxLat - minLat));
  const isFullWorld = lonSpan >= 350;
  const crossesAntimeridian = !isFullWorld && (rawMinLon < -180 || rawMaxLon > 180);

  const centerLat = Number.isFinite(Number(center?.lat))
    ? clamp(center.lat, -89.5, 89.5, (minLat + maxLat) / 2)
    : clamp((minLat + maxLat) / 2, -89.5, 89.5, 0);
  const centerLon = Number.isFinite(Number(center?.lon))
    ? normalizeLon(center.lon)
    : normalizeLon((rawMinLon + rawMaxLon) / 2);

  const west = isFullWorld ? -180 : normalizeLon(rawMinLon);
  const east = isFullWorld ? 180 : normalizeLon(rawMaxLon);

  // Approximate viewport radius in km for near-view scoring
  const halfDiagKm = Math.max(
    15,
    haversineDistanceKm(centerLat, centerLon, maxLat, normalizeLon(centerLon + Math.min(90, lonSpan / 2))),
  );

  return {
    rawMinLon,
    rawMaxLon,
    minLat,
    maxLat,
    west,
    east,
    south: minLat,
    north: maxLat,
    lonSpan,
    latSpan,
    centerLat,
    centerLon,
    crossesAntimeridian,
    isFullWorld,
    halfDiagKm,
  };
}

/**
 * Check whether `(lat, lon)` lies inside normalized visible map bounds (handles antimeridian).
 */
export function isPointInViewBounds(lat, lon, bounds) {
  if (!bounds || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return false;
  }
  const nLat = Number(lat);
  const nLon = normalizeLon(lon);
  if (nLat < bounds.minLat || nLat > bounds.maxLat) {
    return false;
  }
  if (bounds.isFullWorld || bounds.lonSpan >= 359.5) {
    return true;
  }
  const { rawMinLon, rawMaxLon } = bounds;
  return (
    (nLon >= rawMinLon && nLon <= rawMaxLon) ||
    (nLon - 360 >= rawMinLon && nLon - 360 <= rawMaxLon) ||
    (nLon + 360 >= rawMinLon && nLon + 360 <= rawMaxLon)
  );
}

/**
 * Search places worldwide via Nominatim with automatic Photon fallback.
 * Returns normalized { name, displayName, lat, lon, spanLonDeg, spanLatDeg, type } items.
 */
export async function searchPlaces(query, { signal, fetchImpl = fetch } = {}) {
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
      fetchImpl,
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
    fetchImpl,
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
    const name = String(p.NAME || p.name || p.NAMEASCII || p.nameascii || p.LABEL || '')
      .replace(/\s+/g, ' ')
      .trim();
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const pop = Number(p.POP_MAX ?? p.pop_max ?? p.POP_MIN ?? p.population ?? 0) || 0;
    const scalerank = Number(p.SCALERANK ?? p.scalerank ?? 10);
    const featureCla = String(p.FEATURECLA ?? p.featurecla ?? '').toLowerCase();
    const adm0Cap = Number(p.ADM0CAP ?? p.adm0cap ?? 0) === 1;
    const isCapital = adm0Cap || featureCla.includes('admin-0 capital') || featureCla.includes('capital');
    const altNames = [
      p.NAMEASCII ?? p.nameascii,
      p.NAMEALT ?? p.namealt,
      p.NAME_EN ?? p.name_en,
    ]
      .filter(Boolean)
      .map((s) => String(s).trim());
    const admin1 = String(p.ADM1NAME ?? p.adm1name ?? '').trim();
    const country = String(p.ADM0NAME ?? p.adm0name ?? p.SOV0NAME ?? p.sov0name ?? p.country ?? '').trim();
    return {
      name,
      altNames,
      lat,
      lon,
      pop,
      scalerank: Number.isFinite(scalerank) ? scalerank : 10,
      isCapital,
      admin1,
      country,
    };
  }

  // Flat record
  const name = String(raw.name || raw.NAME || raw.nameascii || '')
    .replace(/\s+/g, ' ')
    .trim();
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
  const altNames = [raw.nameascii, raw.NAMEASCII, raw.namealt, raw.NAMEALT]
    .filter(Boolean)
    .map((s) => String(s).trim());
  const admin1 = String(raw.adm1name ?? raw.ADM1NAME ?? raw.state ?? '').trim();
  const country = String(raw.country ?? raw.adm0name ?? raw.ADM0NAME ?? '').trim();
  return {
    name,
    altNames,
    lat,
    lon,
    pop,
    scalerank: Number.isFinite(scalerank) ? scalerank : 10,
    isCapital,
    admin1,
    country,
  };
}

function getPopulatedPlaceItems(populatedPlaces) {
  if (Array.isArray(populatedPlaces?.populatedPlaces?.features)) {
    return populatedPlaces.populatedPlaces.features;
  }
  if (Array.isArray(populatedPlaces?.features)) {
    return populatedPlaces.features;
  }
  if (Array.isArray(populatedPlaces)) {
    return populatedPlaces;
  }
  return [];
}

/**
 * Search local Natural Earth populated places by name (diacritic-insensitive),
 * returning normalized town candidates enriched with visible-area metadata.
 */
export function searchLocalPopulatedPlaces(populatedPlaces, query, { bounds = null, limit = 10 } = {}) {
  const foldedQuery = foldText(query);
  if (!foldedQuery) return [];
  const rawItems = getPopulatedPlaceItems(populatedPlaces);
  if (!rawItems.length) return [];

  const matches = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const rec = extractCityRecord(rawItems[i]);
    if (!rec) continue;
    const candidates = [rec.name, ...(rec.altNames || [])].map(foldText).filter(Boolean);
    const matched = candidates.some((c) => c.includes(foldedQuery));
    if (!matched) continue;

    const parts = [rec.name];
    if (rec.admin1 && foldText(rec.admin1) !== foldText(rec.name)) parts.push(rec.admin1);
    if (rec.country && !parts.some((p) => foldText(p) === foldText(rec.country))) parts.push(rec.country);
    const displayName = parts.join(', ');
    const type = rec.isCapital ? 'capital' : rec.pop >= 100000 ? 'city' : 'town';
    const spanHint = inferSpanByType(type);

    matches.push({
      name: rec.name,
      displayName,
      context: stripLeadingNameFromDisplay(rec.name, displayName),
      lat: Number(rec.lat.toFixed(4)),
      lon: Number(normalizeLon(rec.lon).toFixed(4)),
      spanLonDeg: spanHint.lonDeg,
      spanLatDeg: spanHint.latDeg,
      type,
      typeLabel: formatTypeLabel(type, rec.isCapital),
      isCapital: rec.isCapital,
      population: rec.pop,
      importance: Math.max(0.1, (11 - Math.min(10, rec.scalerank)) / 12),
      osmCategory: 'place',
      source: 'local',
    });
  }

  return rankTownResults(matches, query, bounds, limit);
}

function computeTextMatchScore(name, displayName, foldedQuery) {
  if (!foldedQuery) return 0;
  const fName = foldText(name);
  const fDisplay = foldText(displayName);
  if (fName === foldedQuery) return 100;
  if (fName.startsWith(foldedQuery)) return 75;
  const tokens = fName.split(/[\s\-/]+/).filter(Boolean);
  if (tokens.some((t) => t === foldedQuery)) return 68;
  if (tokens.some((t) => t.startsWith(foldedQuery))) return 55;
  if (fName.includes(foldedQuery)) return 40;
  if (fDisplay.includes(foldedQuery)) return 22;
  return 0;
}

function computeSettlementScore(item) {
  const t = String(item.type || '').toLowerCase();
  const cat = String(item.osmCategory || '').toLowerCase();
  if (item.isCapital || t === 'capital') return 36;
  if (PRIMARY_SETTLEMENT_TYPES.has(t)) return 32;
  if (SETTLEMENT_TYPES.has(t)) return 24;
  if (cat === 'place' && !NON_SETTLEMENT_TYPES.has(t)) return 18;
  if (t === 'administrative' && (item.spanLonDeg || 20) <= 4) return 16;
  if (NON_SETTLEMENT_TYPES.has(t)) return -35;
  if (cat === 'highway' || cat === 'building' || cat === 'amenity' || cat === 'shop') return -40;
  return 4;
}

/**
 * Deduplicate and rank town/city candidates, strongly biasing toward the currently visible map area.
 */
export function rankTownResults(items, query, bounds = null, limit = 8) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const normBounds = bounds && typeof bounds.minLat === 'number' && typeof bounds.rawMinLon === 'number'
    ? bounds
    : normalizeViewBounds(bounds);
  const foldedQuery = foldText(query);

  // Deduplicate candidates representing the same town across local / Nominatim / Photon
  const deduped = [];
  for (const raw of items) {
    if (!raw || !raw.name || !Number.isFinite(Number(raw.lat)) || !Number.isFinite(Number(raw.lon))) {
      continue;
    }
    const lat = Number(raw.lat);
    const lon = normalizeLon(raw.lon);
    const fName = foldText(raw.name);
    const rawContext =
      raw.context != null ? String(raw.context) : stripLeadingNameFromDisplay(raw.name, raw.displayName);
    const rawSettlementScore = computeSettlementScore(raw);

    let merged = false;
    for (let i = 0; i < deduped.length; i += 1) {
      const existing = deduped[i];
      const distKm = haversineDistanceKm(lat, lon, existing.lat, existing.lon);
      const existingName = foldText(existing.name);
      const existingSettlementScore = computeSettlementScore(existing);
      const sameCategoryClass = (rawSettlementScore >= 0) === (existingSettlementScore >= 0);
      const sameName = fName === existingName;
      const similarName =
        sameName ||
        (sameCategoryClass && distKm < 4 && (fName.includes(existingName) || existingName.includes(fName)));

      if ((sameName && distKm < 18) || (similarName && distKm < 4)) {
        // Merge best fields
        const incomingBetterContext =
          rawContext.length > (existing.context || '').length &&
          rawContext.length <= 120;
        const incomingBetterType = rawSettlementScore > existingSettlementScore;
        const isCapital = Boolean(existing.isCapital || raw.isCapital);
        const nextType = isCapital
          ? 'capital'
          : incomingBetterType
            ? raw.type
            : existing.type;

        deduped[i] = {
          ...existing,
          displayName: incomingBetterContext ? (raw.displayName || existing.displayName) : existing.displayName,
          context: incomingBetterContext ? rawContext : existing.context,
          type: nextType,
          typeLabel: formatTypeLabel(nextType, isCapital),
          isCapital,
          population: Math.max(Number(existing.population) || 0, Number(raw.population) || 0),
          importance: Math.max(Number(existing.importance) || 0, Number(raw.importance) || 0),
          source: existing.source === 'local' ? raw.source || existing.source : existing.source,
        };
        merged = true;
        break;
      }
    }

    if (!merged) {
      const isCapital = Boolean(raw.isCapital);
      const type = isCapital ? 'capital' : String(raw.type || 'place').toLowerCase();
      deduped.push({
        ...raw,
        lat: Number(lat.toFixed(4)),
        lon: Number(lon.toFixed(4)),
        type,
        typeLabel: raw.typeLabel || formatTypeLabel(type, isCapital),
        context: rawContext,
        isCapital,
      });
    }
  }

  const scored = deduped.map((item) => {
    const inView = normBounds ? isPointInViewBounds(item.lat, item.lon, normBounds) : false;
    const distanceKm = normBounds
      ? Math.round(haversineDistanceKm(item.lat, item.lon, normBounds.centerLat, normBounds.centerLon))
      : null;
    const nearRadiusKm = normBounds ? Math.max(120, normBounds.halfDiagKm * 2.1) : 0;
    const nearView = Boolean(normBounds && !inView && distanceKm != null && distanceKm <= nearRadiusKm);

    const textScore = computeTextMatchScore(item.name, item.displayName, foldedQuery);
    const settlementScore = computeSettlementScore(item);
    const isNonSettlement = settlementScore < 0;
    const popBoost = item.population > 0 ? Math.min(22, Math.log10(item.population + 10) * 3.2) : 0;
    const importanceBoost = Number.isFinite(item.importance) ? Math.min(18, item.importance * 22) : 0;

    // Visible-area bias:
    //   - Settlements strictly inside current map view get a dominant tier boost (+420)
    //   - Settlements near the current map view get a strong secondary boost (+150..+210)
    //   - Non-settlements (roads, shops, buildings) receive only a modest bias so they never beat actual towns
    let viewBias = 0;
    if (normBounds) {
      if (inView) {
        const relDist = distanceKm / Math.max(15, normBounds.halfDiagKm);
        viewBias = isNonSettlement ? 35 : 420 + Math.max(0, 40 - relDist * 20);
      } else if (nearView) {
        const proximityRatio = 1 - distanceKm / Math.max(1, nearRadiusKm);
        viewBias = isNonSettlement ? 15 : 150 + proximityRatio * 60;
      } else if (distanceKm != null) {
        viewBias = (isNonSettlement ? 8 : 45) / (1 + distanceKm / 1200);
      }
    }

    const totalScore = viewBias + textScore + settlementScore + popBoost + importanceBoost;

    return {
      ...item,
      inView,
      nearView,
      distanceKm,
      _score: totalScore,
    };
  });

  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    if (a.distanceKm != null && b.distanceKm != null && a.distanceKm !== b.distanceKm) {
      return a.distanceKm - b.distanceKm;
    }
    return (b.population || 0) - (a.population || 0);
  });

  return scored.slice(0, Math.max(1, limit)).map(({ _score, ...rest }) => rest);
}

function buildPaddedViewboxString(bounds) {
  if (!bounds || bounds.isFullWorld || bounds.crossesAntimeridian || bounds.lonSpan >= 170) {
    return null;
  }
  const padLon = Math.min(8, Math.max(0.05, bounds.lonSpan * 0.08));
  const padLat = Math.min(6, Math.max(0.05, bounds.latSpan * 0.08));
  const west = clamp(bounds.west - padLon, -180, 180, bounds.west);
  const east = clamp(bounds.east + padLon, -180, 180, bounds.east);
  const south = clamp(bounds.south - padLat, -89.5, 89.5, bounds.south);
  const north = clamp(bounds.north + padLat, -89.5, 89.5, bounds.north);
  if (west >= east || south >= north) return null;
  return `${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)},${south.toFixed(4)}`;
}

async function fetchNominatimTowns(query, { viewbox = null, bounded = false, settlementOnly = true, limit = 8, signal, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    q: query,
    limit: String(limit),
    addressdetails: '1',
    extratags: '1',
  });
  if (settlementOnly) {
    params.set('featureType', 'settlement');
  }
  if (viewbox) {
    params.set('viewbox', viewbox);
    if (bounded) {
      params.set('bounded', '1');
    }
  }
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: { Accept: 'application/json' },
      signal,
    },
    6500,
    fetchImpl,
  );
  if (!res.ok) {
    throw new Error(`Nominatim search failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data.map(normalizeNominatimItem) : [];
}

async function fetchPhotonTowns(query, { bounds = null, settlementOnly = true, limit = 10, signal, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  if (bounds) {
    params.set('lat', bounds.centerLat.toFixed(4));
    params.set('lon', bounds.centerLon.toFixed(4));
    params.set('location_bias_scale', bounds.lonSpan < 40 ? '0.7' : '0.45');
  }
  if (settlementOnly) {
    params.append('layer', 'city');
    params.append('layer', 'locality');
    params.append('layer', 'district');
  }
  const url = `https://photon.komoot.io/api/?${params.toString()}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: { Accept: 'application/json' },
      signal,
    },
    6500,
    fetchImpl,
  );
  if (!res.ok) {
    throw new Error(`Photon search failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.map(normalizePhotonFeature);
}

/**
 * Search for towns, villages, and cities, strongly biasing results toward the currently visible map area.
 * Combines instant local populated-place matching with bounded-view Nominatim + view-biased Photon queries.
 */
export async function searchTowns(
  query,
  {
    viewBounds = null,
    center = null,
    span = null,
    populatedPlaces = null,
    limit = 8,
    signal,
    fetchImpl = fetch,
  } = {},
) {
  const q = String(query || '').trim();
  if (!q) return [];

  const normBounds = normalizeViewBounds(viewBounds, center, span);
  const viewbox = buildPaddedViewboxString(normBounds);
  const localMatches = searchLocalPopulatedPlaces(populatedPlaces, q, {
    bounds: normBounds,
    limit: limit + 4,
  });

  const canUseBoundedNominatim = Boolean(viewbox && normBounds && normBounds.lonSpan < 140);
  const candidates = [...localMatches];
  let nominatimSucceeded = false;
  let photonSucceeded = false;
  let nominatimCount = 0;
  let photonCount = 0;
  let lastError = null;

  // Run at most one Nominatim request and one Photon request in parallel:
  // - Nominatim bounded to visible area guarantees small in-view towns aren't drowned out by huge global cities
  // - Photon with lat/lon location bias surfaces both in-view and nearby/worldwide matches quickly
  const tasks = [
    fetchNominatimTowns(q, {
      viewbox,
      bounded: canUseBoundedNominatim,
      settlementOnly: true,
      limit: Math.max(8, limit),
      signal,
      fetchImpl,
    })
      .then((items) => {
        nominatimSucceeded = true;
        nominatimCount = items.length;
        candidates.push(...items);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' && signal?.aborted) throw err;
        lastError = err;
      }),
    fetchPhotonTowns(q, {
      bounds: normBounds,
      settlementOnly: true,
      limit: Math.max(10, limit + 2),
      signal,
      fetchImpl,
    })
      .then((items) => {
        photonSucceeded = true;
        photonCount = items.length;
        candidates.push(...items);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' && signal?.aborted) throw err;
        lastError = err;
      }),
  ];

  await Promise.all(tasks);
  if (signal?.aborted) {
    const abortErr = new Error('Search aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  // If Photon failed/returned empty and our Nominatim query was hard-bounded to the visible area with 0 hits,
  // try an unbounded view-biased Nominatim query so out-of-view towns can still be found.
  if (canUseBoundedNominatim && nominatimCount === 0 && photonCount === 0 && (!photonSucceeded || candidates.length === 0)) {
    try {
      const globalNom = await fetchNominatimTowns(q, {
        viewbox,
        bounded: false,
        settlementOnly: true,
        limit: Math.max(8, limit),
        signal,
        fetchImpl,
      });
      nominatimSucceeded = true;
      candidates.push(...globalNom);
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw err;
      lastError = err;
    }
  }

  // If settlement-only queries found nothing (e.g. a small fort, station, or unincorporated locality),
  // fall back to unfiltered view-biased search so the user can still pin it.
  if (candidates.length === 0 && (nominatimSucceeded || photonSucceeded)) {
    try {
      const fallbackPhoton = await fetchPhotonTowns(q, {
        bounds: normBounds,
        settlementOnly: false,
        limit: Math.max(8, limit),
        signal,
        fetchImpl,
      });
      candidates.push(...fallbackPhoton);
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw err;
      lastError = err;
    }

    if (candidates.length === 0) {
      try {
        const fallbackNom = await fetchNominatimTowns(q, {
          viewbox,
          bounded: false,
          settlementOnly: false,
          limit: Math.max(6, limit),
          signal,
          fetchImpl,
        });
        candidates.push(...fallbackNom);
      } catch (err) {
        if (err?.name === 'AbortError' && signal?.aborted) throw err;
        lastError = err;
      }
    }
  }

  if (candidates.length === 0 && !nominatimSucceeded && !photonSucceeded && lastError) {
    throw lastError;
  }

  return rankTownResults(candidates, q, normBounds, limit);
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

  const rawItems = getPopulatedPlaceItems(populatedPlaces);
  if (!rawItems.length) return [];

  const inside = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const rec = extractCityRecord(rawItems[i]);
    if (!rec) continue;
    const dLat = Math.abs(rec.lat - cLat);
    const dLon = Math.abs(shortestLonDiff(rec.lon, cLon));
    if (dLat <= halfLat && dLon <= halfLon) {
      inside.push(rec);
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
