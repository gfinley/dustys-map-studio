/**
 * Timeline CSV parser and dynamic historical GeoJSON layer generator.
 *
 * Powers the Timeline tab in Dusty's Map Studio (defaulting to a 1-year window)
 * using lightweight CSV datasets such as Alaska Airfields (1939-1945).
 */

export const ALASKA_AIRFIELDS_CSV_URL =
  './data/alaska_airfields_1939_1945/alaska_airfields_1939_1945.csv';

export const ALASKA_YEARS = [1939, 1940, 1941, 1942, 1943, 1944, 1945];

export const ACTIVE_STATUSES = new Set(['civilian', 'dual_use', 'military']);
export const MILITARY_STATUSES = new Set(['military', 'dual_use']);

export const TIMELINE_LAYER_PREFIX = 'timeline_gen_';

export const TIMELINE_COLORS = {
  military: '#b91c1c',
  dual_use: '#d97706',
  civilian: '#1d4ed8',
  construction: '#64748b',
  new_addition: '#10b981',
  baseline: '#475569',
};

const datasetCache = new Map();

/**
 * RFC 4180 compliant CSV parser (handles quoted commas and escaped double quotes).
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);

  if (rows.length < 2) {
    throw new Error('CSV must include a header row and at least one data row.');
  }

  const headers = rows[0].map((h) => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r += 1) {
    const vals = rows[r];
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c]] = (vals[c] ?? '').trim();
    }
    records.push(obj);
  }
  return { headers, records };
}

/**
 * Normalize parsed CSV records into timeline-ready airfield entries.
 */
export function normalizeTimelineDataset(csvText, datasetName = 'Alaska Airfields (1939–1945)') {
  const { headers, records } = parseCsv(csvText);
  const yearCols = headers
    .map((h) => {
      const m = /^status_(\d{4})$/.exec(h);
      return m ? Number(m[1]) : null;
    })
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);

  if (yearCols.length === 0) {
    throw new Error('CSV must contain at least one status_YYYY column (e.g. status_1939).');
  }

  const normalized = [];
  const regionsSet = new Set();

  for (let i = 0; i < records.length; i += 1) {
    const raw = records[i];
    const lat = Number(raw.latitude ?? raw.lat);
    const lon = Number(raw.longitude ?? raw.lon ?? raw.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const statuses = {};
    for (const y of yearCols) {
      statuses[y] = (raw[`status_${y}`] || 'none').trim().toLowerCase() || 'none';
    }

    const region = raw.region || 'Alaska';
    regionsSet.add(region);

    normalized.push({
      id: raw.id || `site_${i + 1}`,
      name: raw.name || `Site ${i + 1}`,
      alternate_names: (raw.alternate_names || '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
      latitude: lat,
      longitude: lon,
      region,
      facility_type: (raw.facility_type || 'land_airfield').trim().toLowerCase(),
      origin_category: (raw.origin_category || 'civilian').trim().toLowerCase(),
      opened_date: raw.opened_date || '',
      opened_year: raw.opened_year ? Number(raw.opened_year) : null,
      military_start_year: raw.military_start_year ? Number(raw.military_start_year) : null,
      closed_year: raw.closed_year ? Number(raw.closed_year) : null,
      statuses,
      operator_1939_1945: raw.operator_1939_1945 || '',
      surface_wartime: raw.surface_wartime || '',
      runway_specs: raw.runway_specs || '',
      strategic_role: raw.strategic_role || '',
      transition_notes: raw.transition_notes || '',
      modern_equivalent: raw.modern_equivalent || '',
      proof_summary: raw.proof_summary || '',
      primary_sources: (raw.primary_sources || '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
      source_url: raw.source_url || '',
      confidence: (raw.confidence || 'high').trim().toLowerCase(),
    });
  }

  return {
    name: datasetName,
    years: yearCols,
    minYear: yearCols[0],
    maxYear: yearCols[yearCols.length - 1],
    regions: Array.from(regionsSet).sort(),
    records: normalized,
  };
}

/**
 * Fetch and cache a CSV timeline dataset by URL.
 */
export async function loadTimelineDataset(url = ALASKA_AIRFIELDS_CSV_URL, name = 'Alaska Airfields (1939–1945)') {
  if (datasetCache.has(url)) {
    return datasetCache.get(url);
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} loading ${url}`);
  }
  const text = await resp.text();
  const parsed = normalizeTimelineDataset(text, name);
  datasetCache.set(url, parsed);
  return parsed;
}

/**
 * Resolve a record's effective status across a [startYear, endYear] timeline window.
 * Priority within a multi-year window: military > dual_use > civilian > construction > closed > none.
 */
export function resolveWindowStatus(record, startYear, endYear, allYears) {
  const s = Math.min(startYear, endYear);
  const e = Math.max(startYear, endYear);
  const prevYear = s - 1;
  const prevStatus = allYears.includes(prevYear) ? record.statuses[prevYear] || 'none' : 'none';
  const endStatus = record.statuses[e] || 'none';

  // For single-year windows (default 1 year), exact year status is authoritative.
  if (s === e) {
    const isNewOperational =
      allYears.includes(prevYear) &&
      ACTIVE_STATUSES.has(endStatus) &&
      !ACTIVE_STATUSES.has(prevStatus);
    const isNewMilitary =
      allYears.includes(prevYear) &&
      MILITARY_STATUSES.has(endStatus) &&
      !MILITARY_STATUSES.has(prevStatus);
    return {
      status: endStatus,
      endStatus,
      prevStatus,
      isNewOperational,
      isNewMilitary,
      changedInWindow: isNewOperational || isNewMilitary,
    };
  }

  // Multi-year window: determine peak active role during [s, e] and whether it opened/militarized during [s, e].
  let sawMil = false;
  let sawDual = false;
  let sawCiv = false;
  let sawConst = false;
  let sawClosed = false;

  for (let y = s; y <= e; y += 1) {
    const st = record.statuses[y] || 'none';
    if (st === 'military') sawMil = true;
    else if (st === 'dual_use') sawDual = true;
    else if (st === 'civilian') sawCiv = true;
    else if (st === 'construction') sawConst = true;
    else if (st === 'closed') sawClosed = true;
  }

  let effective = 'none';
  if (sawMil) effective = 'military';
  else if (sawDual) effective = 'dual_use';
  else if (sawCiv) effective = 'civilian';
  else if (sawConst) effective = 'construction';
  else if (sawClosed) effective = 'closed';

  const isNewOperational =
    allYears.includes(prevYear) &&
    ACTIVE_STATUSES.has(effective) &&
    !ACTIVE_STATUSES.has(prevStatus);
  const isNewMilitary =
    allYears.includes(prevYear) &&
    MILITARY_STATUSES.has(effective) &&
    !MILITARY_STATUSES.has(prevStatus);

  return {
    status: effective,
    endStatus,
    prevStatus,
    isNewOperational,
    isNewMilitary,
    changedInWindow: isNewOperational || isNewMilitary,
  };
}

function buildFeature(record, windowInfo, startYear, endYear, allYears, displayColor) {
  const windowLabel = startYear === endYear ? String(endYear) : `${startYear}–${endYear}`;
  const isDual = windowInfo.status === 'dual_use';
  const category = MILITARY_STATUSES.has(windowInfo.status)
    ? 'military'
    : windowInfo.status === 'civilian'
      ? 'civilian'
      : windowInfo.status;

  const timelineSummary = allYears
    .filter((y) => record.statuses[y] && record.statuses[y] !== 'none')
    .map((y) => `${String(y).slice(2)}:${record.statuses[y]}`)
    .join(' · ');

  const props = {
    id: record.id,
    name: record.name,
    alternate_names: record.alternate_names,
    dataset: 'alaska_airfields_1939_1945',
    snapshot_year: windowLabel,
    year_status: windowInfo.status,
    category,
    dual_use: isDual,
    airfield_type: record.facility_type,
    origin_category: record.origin_category,
    region: record.region,
    territory: 'Territory of Alaska (USA)',
    opened_date: record.opened_date,
    opened_year: record.opened_year,
    military_start_year: record.military_start_year,
    closed_year: record.closed_year,
    is_new_in_year: windowInfo.isNewOperational,
    is_new_military_in_year: windowInfo.isNewMilitary,
    operator_1939_1945: record.operator_1939_1945,
    surface_wartime: record.surface_wartime,
    runway_specs: record.runway_specs,
    strategic_role: record.strategic_role,
    timeline_1939_1945: timelineSummary,
    notes: record.transition_notes,
    modern_equivalent: record.modern_equivalent,
    proof_summary: record.proof_summary,
    primary_sources: record.primary_sources,
    source_url: record.source_url,
    source_confidence: record.confidence,
    title: record.name,
    'marker-color': displayColor,
    'marker-symbol': 'airport',
    'marker-size': windowInfo.status === 'military' ? 'medium' : 'small',
  };

  for (const y of allYears) {
    props[`status_${y}`] = record.statuses[y];
  }

  return {
    type: 'Feature',
    id: record.id,
    geometry: {
      type: 'Point',
      coordinates: [record.longitude, record.latitude],
    },
    properties: props,
  };
}

/**
 * Generate Dusty's Map Studio customGeoJsonLayers and summary stats for a selected timeline window.
 */
export function generateTimelineLayers(dataset, options = {}) {
  const startYear = Number(options.startYear ?? dataset.minYear);
  const endYear = Number(options.endYear ?? startYear);
  const mode = options.mode || 'cumulative_split';
  const splitDualUse = Boolean(options.splitDualUse);
  const includeMilitary = options.includeMilitary !== false;
  const includeCivilian = options.includeCivilian !== false;
  const includeConstruction = Boolean(options.includeConstruction);
  const includeSeaplane = options.includeSeaplane !== false;
  const regionFilter = options.regionFilter || 'all';
  const dotSize = Number.isFinite(Number(options.dotSize)) ? Number(options.dotSize) : 1.5;

  const windowLabel = startYear === endYear ? String(endYear) : `${startYear}–${endYear}`;
  const allYears = dataset.years;

  const buckets = {
    military: [],
    dual_use: [],
    civilian: [],
    construction: [],
    new_additions: [],
    existing_baseline: [],
  };

  const matchedRows = [];
  const stats = {
    windowLabel,
    startYear,
    endYear,
    totalActive: 0,
    militaryOnly: 0,
    dualUse: 0,
    civilianOnly: 0,
    construction: 0,
    newOperational: 0,
    newMilitary: 0,
  };

  for (const rec of dataset.records) {
    if (!includeSeaplane && rec.facility_type === 'seaplane_base') continue;
    if (regionFilter !== 'all' && rec.region !== regionFilter) continue;

    const info = resolveWindowStatus(rec, startYear, endYear, allYears);
    const st = info.status;

    if (st === 'military') stats.militaryOnly += 1;
    else if (st === 'dual_use') stats.dualUse += 1;
    else if (st === 'civilian') stats.civilianOnly += 1;
    else if (st === 'construction') stats.construction += 1;

    if (ACTIVE_STATUSES.has(st)) {
      stats.totalActive += 1;
      if (info.isNewOperational) stats.newOperational += 1;
      if (info.isNewMilitary) stats.newMilitary += 1;
    }

    if (st === 'construction') {
      if (includeConstruction) {
        buckets.construction.push(
          buildFeature(rec, info, startYear, endYear, allYears, TIMELINE_COLORS.construction),
        );
        matchedRows.push({ record: rec, info });
      }
      continue;
    }

    if (!ACTIVE_STATUSES.has(st)) continue;

    const isMil = st === 'military' || st === 'dual_use';
    const isCiv = st === 'civilian';
    if (isMil && !includeMilitary) continue;
    if (isCiv && !includeCivilian) continue;

    if (mode === 'new_only') {
      if (!info.changedInWindow) continue;
      const color =
        st === 'military'
          ? TIMELINE_COLORS.military
          : st === 'dual_use'
            ? TIMELINE_COLORS.dual_use
            : TIMELINE_COLORS.civilian;
      buckets.new_additions.push(buildFeature(rec, info, startYear, endYear, allYears, color));
      matchedRows.push({ record: rec, info });
      continue;
    }

    if (mode === 'cumulative_highlight_new') {
      if (info.changedInWindow) {
        buckets.new_additions.push(
          buildFeature(rec, info, startYear, endYear, allYears, TIMELINE_COLORS.new_addition),
        );
      } else {
        buckets.existing_baseline.push(
          buildFeature(rec, info, startYear, endYear, allYears, TIMELINE_COLORS.baseline),
        );
      }
      matchedRows.push({ record: rec, info });
      continue;
    }

    // Default: cumulative_split
    if (st === 'military') {
      buckets.military.push(
        buildFeature(rec, info, startYear, endYear, allYears, TIMELINE_COLORS.military),
      );
    } else if (st === 'dual_use') {
      if (splitDualUse) {
        buckets.dual_use.push(
          buildFeature(rec, info, startYear, endYear, allYears, TIMELINE_COLORS.dual_use),
        );
      } else {
        buckets.military.push(
          buildFeature(rec, info, startYear, endYear, allYears, TIMELINE_COLORS.military),
        );
      }
    } else if (st === 'civilian') {
      buckets.civilian.push(
        buildFeature(rec, info, startYear, endYear, allYears, TIMELINE_COLORS.civilian),
      );
    }
    matchedRows.push({ record: rec, info });
  }

  const layers = [];
  const makeLayer = (suffix, label, color, features, extra = {}) => {
    if (!features.length) return;
    layers.push({
      id: `${TIMELINE_LAYER_PREFIX}${suffix}`,
      label,
      url: null,
      data: {
        type: 'FeatureCollection',
        name: `${TIMELINE_LAYER_PREFIX}${suffix}`,
        metadata: {
          dataset: dataset.name,
          window: windowLabel,
          mode,
          count: features.length,
        },
        features,
      },
      visible: true,
      color,
      fillOpacity: extra.fillOpacity ?? 0.9,
      strokeWidth: extra.strokeWidth ?? dotSize,
      dashed: Boolean(extra.dashed),
      hatch: 'none',
    });
  };

  if (mode === 'new_only') {
    makeLayer(
      'new_only',
      `Alaska Newly Added / Militarized (${windowLabel})`,
      TIMELINE_COLORS.new_addition,
      buckets.new_additions,
      { strokeWidth: Math.min(4.0, dotSize + 0.2) },
    );
  } else if (mode === 'cumulative_highlight_new') {
    makeLayer(
      'baseline',
      `Alaska Existing Airfields (${windowLabel})`,
      TIMELINE_COLORS.baseline,
      buckets.existing_baseline,
      { fillOpacity: 0.72, strokeWidth: Math.max(0.8, dotSize - 0.2) },
    );
    makeLayer(
      'new_highlight',
      `Alaska New / Upgraded in ${windowLabel}`,
      TIMELINE_COLORS.new_addition,
      buckets.new_additions,
      { fillOpacity: 0.95, strokeWidth: Math.min(4.0, dotSize + 0.3) },
    );
  } else {
    makeLayer(
      'civilian',
      `Alaska Civilian Airfields (${windowLabel})`,
      TIMELINE_COLORS.civilian,
      buckets.civilian,
      { strokeWidth: Math.max(0.4, dotSize - 0.1) },
    );
    if (splitDualUse) {
      makeLayer(
        'dual_use',
        `Alaska Dual-Use CAA/Military (${windowLabel})`,
        TIMELINE_COLORS.dual_use,
        buckets.dual_use,
        { strokeWidth: dotSize },
      );
    }
    makeLayer(
      'military',
      splitDualUse
        ? `Alaska Military Airfields (${windowLabel})`
        : `Alaska Military & Dual-Use Airfields (${windowLabel})`,
      TIMELINE_COLORS.military,
      buckets.military,
      { strokeWidth: dotSize },
    );
  }

  if (includeConstruction && buckets.construction.length > 0) {
    makeLayer(
      'construction',
      `Alaska Under Construction (${windowLabel})`,
      TIMELINE_COLORS.construction,
      buckets.construction,
      { fillOpacity: 0.7, strokeWidth: Math.max(0.6, dotSize - 0.3) },
    );
  }

  const combinedFeatures = layers.flatMap((l) => l.data.features);
  const combinedGeoJson = {
    type: 'FeatureCollection',
    name: `alaska_airfields_${windowLabel.replace(/[^0-9a-zA-Z_-]/g, '_')}`,
    metadata: {
      dataset: dataset.name,
      window: windowLabel,
      mode,
      stats,
    },
    features: combinedFeatures,
  };

  return { layers, stats, combinedGeoJson, matchedRows };
}

/**
 * Compute annual stacked bar metrics across all years in the dataset for the Timeline chart.
 */
export function computeAnnualSeries(dataset, { includeSeaplane = true, regionFilter = 'all' } = {}) {
  return dataset.years.map((year) => {
    let military = 0;
    let dual_use = 0;
    let civilian = 0;
    let construction = 0;
    for (const rec of dataset.records) {
      if (!includeSeaplane && rec.facility_type === 'seaplane_base') continue;
      if (regionFilter !== 'all' && rec.region !== regionFilter) continue;
      const st = rec.statuses[year] || 'none';
      if (st === 'military') military += 1;
      else if (st === 'dual_use') dual_use += 1;
      else if (st === 'civilian') civilian += 1;
      else if (st === 'construction') construction += 1;
    }
    return {
      year,
      military,
      dual_use,
      civilian,
      construction,
      total: military + dual_use + civilian,
    };
  });
}

function escapeCsvCell(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Export matched timeline slice rows as a standalone CSV string.
 */
export function exportTimelineSliceCsv(matchedRows, windowLabel) {
  const headers = [
    'id',
    'name',
    'latitude',
    'longitude',
    'region',
    'facility_type',
    'window',
    'window_status',
    'new_in_window',
    'opened_date',
    'operator_1939_1945',
    'surface_wartime',
    'runway_specs',
    'strategic_role',
    'modern_equivalent',
    'confidence',
    'proof_summary',
    'primary_sources',
  ];
  const lines = [headers.join(',')];
  for (const { record, info } of matchedRows) {
    const vals = [
      record.id,
      record.name,
      record.latitude.toFixed(4),
      record.longitude.toFixed(4),
      record.region,
      record.facility_type,
      windowLabel,
      info.status,
      info.changedInWindow ? 'true' : 'false',
      record.opened_date,
      record.operator_1939_1945,
      record.surface_wartime,
      record.runway_specs,
      record.strategic_role,
      record.modern_equivalent,
      record.confidence,
      record.proof_summary,
      record.primary_sources.join('; '),
    ];
    lines.push(vals.map(escapeCsvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Extract an FAA/ICAO airport identifier (e.g., PAMR, PAED, Z93, 5KE, AK75) from modern_equivalent.
 */
export function extractAirportCode(modernEquivalent) {
  const raw = String(modernEquivalent || '').trim();
  if (!raw || /^(abandoned|closed)/i.test(raw)) return '';
  const m = /^([A-Z0-9]{3,4})\s*\//.exec(raw);
  return m ? m[1] : '';
}

function buildTextFragment(text) {
  const clean = String(text || '').trim();
  return clean ? `#:~:text=${encodeURIComponent(clean)}` : '';
}

function pickRecordSearchTerm(record) {
  const name = String(record?.name || '').trim();
  if (!name) return '';
  // Prefer short recognizable place/base name for HTML text-fragment jump
  if (/kodiak/i.test(name)) return 'Kodiak';
  if (/sitka/i.test(name)) return 'Sitka';
  if (/dutch harbor/i.test(name)) return 'Dutch Harbor';
  if (/cold bay|fort randall/i.test(name)) return 'Cold Bay';
  if (/umnak|fort glenn/i.test(name)) return 'Fort Glenn';
  if (/port heiden|fort morrow/i.test(name)) return 'Fort Morrow';
  if (/port althorp/i.test(name)) return 'Port Althorp';
  if (/port armstrong/i.test(name)) return 'Port Armstrong';
  if (/sand point/i.test(name)) return 'Sand Point';
  if (/seward|walseth/i.test(name)) return 'Seward';
  if (/yakutat/i.test(name)) return 'Yakutat';
  if (/annette/i.test(name)) return 'Annette Island';
  if (/cape chiniak/i.test(name)) return 'Cape Chiniak';
  if (/ketchikan/i.test(name)) return 'Ketchikan';
  if (/adak/i.test(name)) return 'Adak';
  if (/amchitka/i.test(name)) return 'Amchitka';
  if (/alexai/i.test(name)) return 'Alexai Point';
  if (/casco cove/i.test(name)) return 'Casco Cove';
  if (/shemya/i.test(name)) return 'Shemya';
  if (/kiska/i.test(name)) return 'Kiska';
  if (/ogliuga/i.test(name)) return 'Ogliuga';
  if (/tanaga/i.test(name)) return 'Tanaga';
  if (/atka/i.test(name)) return 'Atka';
  if (/elmendorf/i.test(name)) return 'Elmendorf';
  if (/ladd/i.test(name)) return 'Ladd';
  if (/mile 26|eielson/i.test(name)) return 'Mile 26';
  if (/big delta/i.test(name)) return 'Big Delta';
  if (/tanacross/i.test(name)) return 'Tanacross';
  if (/northway/i.test(name)) return 'Northway';
  if (/galena/i.test(name)) return 'Galena';
  if (/mcgrath/i.test(name)) return 'McGrath';
  if (/marks/i.test(name)) return 'Marks Army Airfield';
  if (/moses point/i.test(name)) return 'Moses Point';
  if (/gambell/i.test(name)) return 'Gambell';
  if (/naknek|king salmon/i.test(name)) return 'Naknek';
  if (/bethel/i.test(name)) return 'Bethel';
  if (/cordova/i.test(name)) return 'Cordova';
  if (/juneau/i.test(name)) return 'Juneau';
  if (/gakona/i.test(name)) return 'Gakona';
  if (/point barrow/i.test(name)) return 'Point Barrow';
  if (/umiat/i.test(name)) return 'Umiat';
  return name.split(/[/(]/)[0].trim();
}

/**
 * Resolve any citation string from primary_sources into a direct, clickable URL
 * pointing to the exact authoritative page, section, PDF, or FAA airport record.
 */
export function resolveSourceUrl(sourceLabel, record = null) {
  const s = String(sourceLabel || '').trim();
  const low = s.toLowerCase();
  const term = pickRecordSearchTerm(record);
  const frag = buildTextFragment(term);
  const code = extractAirportCode(record?.modern_equivalent);

  // Specific site reports & exact documents first
  if (low.includes('site report #2620')) {
    return 'https://dec.alaska.gov/Applications/SPAR/PublicMVC/CSP/SiteReport/2620';
  }
  if (low.includes('site report #2637')) {
    return 'https://dec.alaska.gov/Applications/SPAR/PublicMVC/CSP/SiteReport/2637';
  }
  if (low.includes('alaska dec fuds')) {
    return 'https://dec.alaska.gov/Applications/SPAR/PublicMVC/CSP/Download?documentID=43940&fileName=96_20020930%20MAP.pdf';
  }
  if (low.includes('skyvector ak23')) {
    return 'https://skyvector.com/airport/AK23/Driftwood-Bay-Air-Force-Station-Airport';
  }
  if (low.includes('gustavus section 4(f)')) {
    return 'https://dot.alaska.gov/sereg/projects/gustavus_airport/assets/appendix_k_section_4_f_statement.pdf';
  }
  if (low.includes('atka auxiliary field')) {
    return 'https://apiai.org/wp-content/uploads/2016/03/2006.-DERP-Preliminary-Assesment.-USACE-Alaska.-USACE-Rock-Island-District-r.pdf';
  }
  if (low.includes('shemya')) {
    return 'https://www.hlswilliwaw.com/aleutians/shemya/index_htm_files/Shemya-Construction-1943-1945.pdf';
  }
  if (low.includes('ladd field')) {
    return 'https://dnr.alaska.gov/parks/oha/publications/The%20WWII%20Heritage%20of%20Ladd%20Field.pdf';
  }
  if (low.includes('dutch harbor report')) {
    return 'https://npshistory.com/publications/aleu/dutch_harbor.pdf';
  }
  if (low.includes('wrangells')) {
    return 'https://npshistory.com/publications/wrst/work-in-the-wrangells.pdf';
  }
  if (low.includes('usgs professional paper 301')) {
    return 'https://pubs.usgs.gov/pp/0301/report.pdf';
  }
  if (low.includes('blm history of npr-4')) {
    return 'https://www.blm.gov/sites/default/files/documents/files/PublicRoom_Alaska_HistoryoftheNPR-4.pdf';
  }
  if (low.includes('seabee cbd 1058')) {
    return 'https://en.wikipedia.org/wiki/Seabee#Seabee_North_Slope_Oil_Exploration_1944';
  }
  if (low.includes('polar record')) {
    return 'https://www.cambridge.org/core/journals/polar-record/article/oil-spill-august-1944-the-cula-expedition-and-the-north-slope-inupiat/A13C2E1D035F70C04F3A424D7483A299';
  }
  if (low.includes('rcaf journal')) {
    return 'https://publications.gc.ca/collections/collection_2018/mdn-dnd/D12-16-7-2-eng.pdf';
  }
  if (low.includes('gila historical')) {
    return 'https://www.gilaschool.org/about-gila/our-story';
  }
  if (low.includes('russell (1997)')) {
    return 'https://en.wikipedia.org/wiki/Project_Hula';
  }
  if (low.includes('maurer (1983)')) {
    return 'https://media.defense.gov/2010/Sep/21/2001330257/-1/-1/0/combat_wings.pdf';
  }
  if (low.includes('usaf office of history')) {
    return 'https://media.defense.gov/2025/Jun/23/2003741903/-1/-1/0/PRINTED_UNIT_HISTORIES.PDF';
  }
  if (low.includes('bureau of mines')) {
    return 'https://dggs.alaska.gov/webpubs/usbm/ic/text/ic9177.pdf';
  }

  // Major archival series (with exact text-fragment jump on HTML pages)
  if (low.includes('budocks')) {
    return `https://www.ibiblio.org/hyperwar/USN/Building_Bases/bases-23.html${frag}`;
  }
  if (low.includes('nhhc') || low.includes('the aleutians campaign')) {
    return `https://www.history.navy.mil/research/library/online-reading-room/title-list-alphabetically/a/the-aleutians-campaign.html${frag}`;
  }
  if (low.includes('cmh aleutian')) {
    return `https://www.ibiblio.org/hyperwar/USA/USA-C-Aleutians/${frag}`;
  }
  if (low.includes('cmh')) {
    return `https://www.ibiblio.org/hyperwar/USA/USA-WH-Guard/USA-WH-Guard-9.html${frag}`;
  }
  if (low.includes('alaska wwii army airfields')) {
    return `https://en.wikipedia.org/wiki/Alaska_World_War_II_Army_airfields${frag}`;
  }
  if (low.includes('green book ii')) {
    return 'https://www.poa.usace.army.mil/Portals/34/docs/AKdistrict/green_book_ii.pdf';
  }
  if (low.includes('green book iv')) {
    return 'https://www.poa.usace.army.mil/Portals/34/docs/AKdistrict/green_book_iv.pdf';
  }
  if (low.includes('narrative report') || low.includes('alaska construction report')) {
    return 'https://apiai.org/wp-content/uploads/2016/03/1941-1944.-Narrative-Report-of-Alaska-Construction.-US-Army-r.pdf';
  }
  if (low.includes('cold war plan') || low.includes('usace alaska district')) {
    return 'https://www.poa.usace.army.mil/Portals/34/docs/civilworks/archive/TheColdWarInAlaskaAManagementPlanForCulturalResourcesAug1994a.pdf';
  }
  if (low.includes('wwii caa nav ranges')) {
    return 'https://www.faa.gov/sites/faa.gov/files/about/office_org/headquarters_offices/arc/WWII_CAA_NAV_RANGES.pdf';
  }
  if (low.includes('civil aviation policy')) {
    return 'https://www.faa.gov/sites/faa.gov/files/about/office_org/headquarters_offices/arc/Civil_Aviation_Policy_in_Alaska.pdf';
  }
  if (low.includes('alaska road commission')) {
    return 'https://rowalaska.net/archives/projects/2016_loewen_v_soa/Research/ARC-BPR/Paving_Alaska%27s_Trails_Part3.pdf';
  }
  if (low.includes('alaska aviation history')) {
    return 'https://www.sketchesofalaska.com/2022/02/world-war-ii-construction-laid-the-groundwork-for-north-pacific-great-circle-air-route.html';
  }
  if (low.includes('us army alaska wwii')) {
    return 'https://www.nps.gov/articles/world-war-ii-in-alaska.htm';
  }
  if (low === 'faa' || low === 'faa adip') {
    if (code) {
      return `https://www.airnav.com/airport/${encodeURIComponent(code)}`;
    }
    return 'https://www.faa.gov/sites/faa.gov/files/about/office_org/headquarters_offices/arc/Civil_Aviation_Policy_in_Alaska.pdf';
  }

  return record?.source_url || '';
}

