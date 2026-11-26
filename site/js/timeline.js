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
