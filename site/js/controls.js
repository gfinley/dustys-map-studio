import {
  COLOR_THEMES,
  HATCH_STYLES,
  PAGE_PRESETS,
  PIN_STYLES,
  PROJECTIONS,
  PROJECTION_LABELS,
  getPixelDimensions,
} from './schema.js?v=24';
import {
  AIRFIELD_1941_LAYERS,
  ALASKA_AIRFIELDS_ALL_LAYER_DEFS,
  GEOJSON_EXAMPLES,
  PHILIPPINES_RAIL_1942_LAYERS,
  REGION_PRESETS,
  buildAlaskaYearLayerDefs,
} from './presets.js?v=24';
import { resolveLocatorGlobeZoom } from './ornaments.js?v=24';
import { formatArea } from './shadow.js?v=24';
import {
  OSM_COASTLINE_MAX_SPAN_DEG,
  computePaddedCoastlineBBox,
  isOsmCoastlineUrl,
  isViewOutsideCoastlineBBox,
  parseOsmCoastlineUrl,
} from './osm-coastline.js?v=24';

const PALETTE_COLOR_FIELDS = [
  { key: 'land', inputId: 'color-land', noneBtnId: 'btn-land-none', fallback: '#4a4a4a' },
  { key: 'water', inputId: 'color-water', noneBtnId: 'btn-water-none', fallback: '#d1cfcf' },
  { key: 'borders', inputId: 'color-borders', noneBtnId: 'btn-borders-none', fallback: '#ffffff' },
  { key: 'coastline', inputId: 'color-coastline', noneBtnId: 'btn-coastline-none', fallback: '#111111' },
  { key: 'rivers', inputId: 'color-rivers', noneBtnId: 'btn-rivers-none', fallback: '#73a9ca' },
  { key: 'text', inputId: 'color-text', noneBtnId: 'btn-text-none', fallback: '#111111' },
  { key: 'admin1', inputId: 'color-admin1', noneBtnId: 'btn-admin1-none', fallback: '#737373' },
  { key: 'bathymetry', inputId: 'color-bathymetry', noneBtnId: 'btn-bathymetry-none', fallback: '#bfbdbd' },
  { key: 'urban', inputId: 'color-urban', noneBtnId: 'btn-urban-none', fallback: '#636363' },
];

const HATCH_LABELS = {
  none: 'No Hatch',
  diagonal: '/// Diagonal',
  backdiagonal: '\\\\\\ Back Diag',
  cross: 'xxx Crosshatch',
  dots: '... Stipple Dots',
};

const PIN_STYLE_LABELS = {
  dot: 'City Dot',
  capital: 'Capital Star',
  bullseye: 'Bullseye Ring',
  square: 'Square Pin',
  label_only: 'Text Only',
};

const LABEL_OFFSETS = {
  NE: { dx: 6, dy: -6 },
  NW: { dx: -8, dy: -6 },
  SE: { dx: 6, dy: 8 },
  SW: { dx: -8, dy: 8 },
};

let boundCallbacks = {};
let fullCountryCatalog = [];
let fullAdmin1Catalog = [];
let activeShadowSourceType = 'country';

function $(id) {
  return document.getElementById(id);
}

function safeHexColor(value, fallback = '#4a4a4a') {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return fallback;
}

function detectOffsetCorner(dx, dy) {
  const xRight = Number(dx) >= 0;
  const yUp = Number(dy) < 0;
  if (xRight && yUp) return 'NE';
  if (!xRight && yUp) return 'NW';
  if (xRight && !yUp) return 'SE';
  return 'SW';
}

export function showToast(message, variant = 'info', durationMs = 3400) {
  const container = $('toast-container');
  if (!container) return;

  while (container.children.length >= 4) {
    container.firstElementChild?.remove();
  }

  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  el.textContent = String(message || '');
  container.appendChild(el);

  setTimeout(() => {
    el.remove();
  }, durationMs);
}

export function setLoadingProgress(visible, label = 'Loading map data...') {
  const pill = $('data-loading-pill');
  const textEl = $('data-loading-text');
  if (!pill || !textEl) return;
  pill.hidden = !visible;
  if (visible) {
    textEl.textContent = label;
  }
}

export function updateCursorCoordinates(lat, lon) {
  const el = $('cursor-coords');
  if (!el) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    el.textContent = 'Outside Globe';
    return;
  }
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  el.textContent = `${Math.abs(lat).toFixed(2)}° ${latDir}, ${Math.abs(lon).toFixed(2)}° ${lonDir}`;
}

export function populateCountryCatalog(catalog, filterText = '') {
  if (Array.isArray(catalog)) {
    fullCountryCatalog = catalog;
    populateGeoBoundariesCountrySelect(catalog);
    if (activeShadowSourceType === 'country') {
      populateShadowRegionCatalog(catalog, 'country', $('shadow-filter-input')?.value || '');
    }
  }
  const select = $('country-select');
  if (!select) return;

  const query = String(filterText || '').trim().toLowerCase();
  const prevVal = select.value;
  select.innerHTML = '';

  const filtered = query
    ? fullCountryCatalog.filter((c) => c.name.toLowerCase().includes(query))
    : fullCountryCatalog;

  if (!filtered.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = fullCountryCatalog.length ? 'No matching countries' : 'Loading country list...';
    select.appendChild(opt);
    return;
  }

  for (const country of filtered) {
    const opt = document.createElement('option');
    opt.value = country.id || country.name;
    opt.dataset.name = country.name;
    opt.textContent = country.name;
    select.appendChild(opt);
  }

  if (prevVal && Array.from(select.options).some((o) => o.value === prevVal)) {
    select.value = prevVal;
  }
}

function populateGeoBoundariesCountrySelect(catalog) {
  const select = $('geoboundaries-country');
  if (!select || !Array.isArray(catalog) || !catalog.length) return;
  const prevVal = select.value;
  select.innerHTML = '';
  for (const country of catalog) {
    const opt = document.createElement('option');
    opt.value = country.id || country.name;
    opt.dataset.name = country.name;
    opt.textContent = country.name;
    select.appendChild(opt);
  }
  if (prevVal && Array.from(select.options).some((o) => o.value === prevVal)) {
    select.value = prevVal;
  } else {
    const ukrOpt = Array.from(select.options).find((o) => o.value === '804');
    if (ukrOpt) select.value = '804';
  }
}

export function populateShadowRegionCatalog(catalog, sourceType = activeShadowSourceType, filterText = '') {
  if (sourceType === 'admin1' && Array.isArray(catalog)) {
    fullAdmin1Catalog = catalog;
  } else if (sourceType === 'country' && Array.isArray(catalog)) {
    fullCountryCatalog = catalog;
  }
  activeShadowSourceType = sourceType === 'admin1' ? 'admin1' : 'country';

  $('btn-shadow-src-country')?.classList.toggle('active', activeShadowSourceType === 'country');
  $('btn-shadow-src-admin1')?.classList.toggle('active', activeShadowSourceType === 'admin1');

  const select = $('shadow-region-select');
  if (!select) return;

  const list = activeShadowSourceType === 'admin1' ? fullAdmin1Catalog : fullCountryCatalog;
  const query = String(filterText || '').trim().toLowerCase();
  const prevVal = select.value;
  select.innerHTML = '';

  const filtered = query
    ? list.filter((item) => (item.label || item.name || '').toLowerCase().includes(query))
    : list;

  if (!filtered.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = list.length
      ? 'No matching regions'
      : activeShadowSourceType === 'admin1'
        ? 'Loading states & provinces...'
        : 'Loading country list...';
    select.appendChild(opt);
    return;
  }

  for (const item of filtered) {
    const opt = document.createElement('option');
    opt.value = item.id || item.name;
    opt.dataset.name = item.name;
    opt.dataset.sourceType = activeShadowSourceType;
    opt.textContent = item.label || item.name;
    select.appendChild(opt);
  }

  if (prevVal && Array.from(select.options).some((o) => o.value === prevVal)) {
    select.value = prevVal;
  }
}

export function renderSearchResults(results, { onFrame, onPin } = {}) {
  const box = $('place-search-results');
  if (!box) return;
  box.innerHTML = '';

  if (!Array.isArray(results) || results.length === 0) {
    box.hidden = false;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No places found. Try a city, country, or region name.';
    box.appendChild(empty);
    return;
  }

  box.hidden = false;
  for (const item of results) {
    const row = document.createElement('div');
    row.className = 'search-result-item';

    const title = document.createElement('div');
    title.className = 'search-result-title';
    title.textContent = item.name;

    const sub = document.createElement('div');
    sub.className = 'search-result-sub';
    sub.textContent = `${item.displayName} (${item.lat.toFixed(2)}°, ${item.lon.toFixed(2)}°)`;

    const actions = document.createElement('div');
    actions.className = 'search-result-actions';

    const frameBtn = document.createElement('button');
    frameBtn.type = 'button';
    frameBtn.className = 'btn btn-primary btn-sm';
    frameBtn.textContent = 'Frame Area';
    frameBtn.addEventListener('click', () => onFrame?.(item));

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'btn btn-secondary btn-sm';
    pinBtn.textContent = '+ Pin';
    pinBtn.addEventListener('click', () => onPin?.(item));

    actions.append(frameBtn, pinBtn);
    row.append(title, sub, actions);
    box.appendChild(row);
  }
}

export function renderRegionShadowsList(spec, callbacks = boundCallbacks, shadowMetrics = null) {
  const listEl = $('region-shadows-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const shadows = spec.regionShadows || [];
  const units = spec?.ornaments?.scaleBar?.units === 'mi' ? 'mi' : 'km';
  if (!shadows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent =
      'No region shadows yet. Pick a country or state above and click + Shadow to compare its true size anywhere on the map.';
    listEl.appendChild(empty);
    return;
  }

  shadows.forEach((shadow, idx) => {
    const card = document.createElement('div');
    card.className = 'list-card';

    const top = document.createElement('div');
    top.className = 'list-card-top';

    const visLabel = document.createElement('label');
    visLabel.className = 'switch-label';
    visLabel.style.minWidth = '0';
    visLabel.style.flex = '1';

    const visCheck = document.createElement('input');
    visCheck.type = 'checkbox';
    visCheck.checked = shadow.visible !== false;
    visCheck.addEventListener('change', (e) => {
      callbacks.onUpdateShadow?.(idx, { visible: e.target.checked });
    });

    const title = document.createElement('span');
    title.className = 'list-card-title';
    title.textContent = shadow.sourceName || shadow.sourceId || `Shadow ${idx + 1}`;
    visLabel.append(visCheck, title);

    const actionWrap = document.createElement('div');
    actionWrap.className = 'shadow-actions-inline';

    const centerBtn = document.createElement('button');
    centerBtn.type = 'button';
    centerBtn.className = 'btn-mini-ghost';
    centerBtn.title = 'Snap this shadow to the current map center';
    centerBtn.textContent = 'Center';
    centerBtn.addEventListener('click', () => callbacks.onCenterShadow?.(idx));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-danger-ghost';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => callbacks.onRemoveShadow?.(idx));

    actionWrap.append(centerBtn, removeBtn);
    top.append(visLabel, actionWrap);

    // Geodesic area & live comparison ratio badges
    const metrics = shadowMetrics?.get(shadow.id) || null;
    if (metrics && metrics.areaKm2 > 0) {
      const metricsRow = document.createElement('div');
      metricsRow.className = 'shadow-metrics';

      const areaBadge = document.createElement('span');
      areaBadge.className = 'shadow-area-badge';
      areaBadge.textContent = formatArea(metrics.areaKm2, units);
      metricsRow.appendChild(areaBadge);

      if (metrics.compareName && metrics.compareAreaKm2 > 0) {
        const ratio = metrics.areaKm2 / metrics.compareAreaKm2;
        const cmpBadge = document.createElement('span');
        cmpBadge.className = 'shadow-compare-badge';
        const ratioStr = ratio >= 10 ? ratio.toFixed(1) : ratio.toFixed(2);
        cmpBadge.textContent = `${ratioStr}× vs. ${metrics.compareName}`;
        cmpBadge.title = `${shadow.sourceName} is ${ratioStr}× the true area of ${metrics.compareName} (${formatArea(metrics.compareAreaKm2, units)})`;
        metricsRow.appendChild(cmpBadge);
      }

      card.appendChild(metricsRow);
    }

    // Color, stroke, hatch row
    const ctrls = document.createElement('div');
    ctrls.className = 'list-card-controls';

    const fillInput = document.createElement('input');
    fillInput.type = 'color';
    fillInput.title = 'Shadow fill color';
    fillInput.value = safeHexColor(shadow.fill, '#dc2626');
    fillInput.addEventListener('input', (e) => {
      callbacks.onUpdateShadow?.(idx, { fill: e.target.value }, { commitHistory: false, skipDynamicLists: true });
    });
    fillInput.addEventListener('change', (e) => {
      callbacks.onUpdateShadow?.(idx, { fill: e.target.value }, { commitHistory: true });
    });

    const strokeInput = document.createElement('input');
    strokeInput.type = 'color';
    strokeInput.title = 'Shadow outline color';
    strokeInput.value = safeHexColor(shadow.stroke, '#7f1d1d');
    strokeInput.addEventListener('input', (e) => {
      callbacks.onUpdateShadow?.(idx, { stroke: e.target.value }, { commitHistory: false, skipDynamicLists: true });
    });
    strokeInput.addEventListener('change', (e) => {
      callbacks.onUpdateShadow?.(idx, { stroke: e.target.value }, { commitHistory: true });
    });

    const hatchSelect = document.createElement('select');
    hatchSelect.title = 'Shadow hatch pattern';
    for (const h of HATCH_STYLES) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = HATCH_LABELS[h] || h;
      hatchSelect.appendChild(opt);
    }
    hatchSelect.value = HATCH_STYLES.includes(shadow.hatch) ? shadow.hatch : 'none';
    hatchSelect.addEventListener('change', (e) => {
      callbacks.onUpdateShadow?.(idx, { hatch: e.target.value });
    });

    const coordSpan = document.createElement('span');
    coordSpan.className = 'coord-micro';
    coordSpan.textContent = `${Number(shadow.targetLat).toFixed(1)}°, ${Number(shadow.targetLon).toFixed(1)}°`;

    ctrls.append(fillInput, strokeInput, hatchSelect, coordSpan);

    // Opacity slider
    const opRow = document.createElement('div');
    opRow.className = 'shadow-slider-row';
    const opLbl = document.createElement('span');
    opLbl.className = 'shadow-slider-label';
    opLbl.textContent = 'Opacity';
    const opInput = document.createElement('input');
    opInput.type = 'range';
    opInput.min = '0.05';
    opInput.max = '0.90';
    opInput.step = '0.05';
    opInput.value = String(shadow.opacity ?? 0.35);
    const opVal = document.createElement('span');
    opVal.className = 'mini-val';
    opVal.textContent = `${Math.round((shadow.opacity ?? 0.35) * 100)}%`;
    opInput.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      opVal.textContent = `${Math.round(val * 100)}%`;
      callbacks.onUpdateShadow?.(idx, { opacity: val }, { commitHistory: false, skipDynamicLists: true });
    });
    opInput.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      opVal.textContent = `${Math.round(val * 100)}%`;
      callbacks.onUpdateShadow?.(idx, { opacity: val }, { commitHistory: true });
    });
    opRow.append(opLbl, opInput, opVal);

    // Rotation slider
    const rotRow = document.createElement('div');
    rotRow.className = 'shadow-slider-row';
    const rotLbl = document.createElement('span');
    rotLbl.className = 'shadow-slider-label';
    rotLbl.textContent = 'Rotate';
    const rotInput = document.createElement('input');
    rotInput.type = 'range';
    rotInput.min = '-180';
    rotInput.max = '180';
    rotInput.step = '1';
    rotInput.value = String(Math.round(Number(shadow.rotationDeg) || 0));
    const rotVal = document.createElement('span');
    rotVal.className = 'mini-val';
    rotVal.textContent = `${Math.round(Number(shadow.rotationDeg) || 0)}°`;
    rotInput.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      rotVal.textContent = `${Math.round(val)}°`;
      callbacks.onUpdateShadow?.(idx, { rotationDeg: val }, { commitHistory: false, skipDynamicLists: true });
    });
    rotInput.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      rotVal.textContent = `${Math.round(val)}°`;
      callbacks.onUpdateShadow?.(idx, { rotationDeg: val }, { commitHistory: true });
    });
    rotRow.append(rotLbl, rotInput, rotVal);

    // Compact toggles: Dashed, Label, Area
    const togglesRow = document.createElement('div');
    togglesRow.className = 'shadow-toggles-row';
    const makeMiniToggle = (labelText, checked, key) => {
      const lbl = document.createElement('label');
      lbl.className = 'switch-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.addEventListener('change', (e) => {
        callbacks.onUpdateShadow?.(idx, { [key]: e.target.checked });
      });
      const sp = document.createElement('span');
      sp.textContent = labelText;
      lbl.append(cb, sp);
      return lbl;
    };
    togglesRow.append(
      makeMiniToggle('Dashed', shadow.dashed !== false, 'dashed'),
      makeMiniToggle('Label', shadow.showLabel !== false, 'showLabel'),
      makeMiniToggle('Area', shadow.showArea !== false, 'showArea'),
    );

    card.append(top, ctrls, opRow, rotRow, togglesRow);
    listEl.appendChild(card);
  });
}

export function renderCountryHighlightsList(spec, callbacks = boundCallbacks) {
  const listEl = $('highlighted-countries-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const countries = spec.highlightedCountries || [];
  if (!countries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No countries highlighted yet. Click the map or pick a country above.';
    listEl.appendChild(empty);
    return;
  }

  countries.forEach((country, idx) => {
    const card = document.createElement('div');
    card.className = 'list-card';

    const top = document.createElement('div');
    top.className = 'list-card-top';

    const title = document.createElement('span');
    title.className = 'list-card-title';
    title.textContent = country.name || `Country #${country.id}`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-danger-ghost';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => callbacks.onRemoveCountry?.(idx));

    top.append(title, removeBtn);

    const ctrls = document.createElement('div');
    ctrls.className = 'list-card-controls';

    const fillInput = document.createElement('input');
    fillInput.type = 'color';
    fillInput.title = 'Country highlight fill color';
    fillInput.value = safeHexColor(country.fill, spec.colors?.highlightFill || '#7a7d7a');
    fillInput.addEventListener('input', (e) => {
      callbacks.onUpdateCountry?.(idx, { fill: e.target.value }, { commitHistory: false, skipDynamicLists: true });
    });
    fillInput.addEventListener('change', (e) => {
      callbacks.onUpdateCountry?.(idx, { fill: e.target.value }, { commitHistory: true });
    });

    const strokeInput = document.createElement('input');
    strokeInput.type = 'color';
    strokeInput.title = 'Country highlight outline color';
    strokeInput.value = safeHexColor(country.stroke, spec.colors?.highlightStroke || '#ffffff');
    strokeInput.addEventListener('input', (e) => {
      callbacks.onUpdateCountry?.(idx, { stroke: e.target.value }, { commitHistory: false, skipDynamicLists: true });
    });
    strokeInput.addEventListener('change', (e) => {
      callbacks.onUpdateCountry?.(idx, { stroke: e.target.value }, { commitHistory: true });
    });

    const hatchSelect = document.createElement('select');
    hatchSelect.title = 'Hatch pattern';
    for (const h of HATCH_STYLES) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = HATCH_LABELS[h] || h;
      hatchSelect.appendChild(opt);
    }
    hatchSelect.value = HATCH_STYLES.includes(country.hatch) ? country.hatch : 'none';
    hatchSelect.addEventListener('change', (e) => {
      callbacks.onUpdateCountry?.(idx, { hatch: e.target.value });
    });

    ctrls.append(fillInput, strokeInput, hatchSelect);
    card.append(top, ctrls);
    listEl.appendChild(card);
  });
}

export function renderCitiesList(spec, callbacks = boundCallbacks) {
  const listEl = $('cities-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const cities = spec.cities || [];
  if (!cities.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No city pins placed yet. Drop one on the map or auto-add major cities.';
    listEl.appendChild(empty);
    return;
  }

  cities.forEach((city, idx) => {
    const card = document.createElement('div');
    card.className = 'list-card';

    const top = document.createElement('div');
    top.className = 'list-card-top';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = city.name || '';
    nameInput.placeholder = 'Pin label';
    nameInput.style.flex = '1';
    nameInput.addEventListener('change', (e) => {
      callbacks.onUpdateCity?.(idx, { name: e.target.value.trim() || 'Pin' });
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-danger-ghost';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => callbacks.onRemoveCity?.(idx));

    top.append(nameInput, delBtn);

    const ctrls = document.createElement('div');
    ctrls.className = 'list-card-controls';

    const styleSelect = document.createElement('select');
    styleSelect.title = 'Pin marker style';
    for (const style of PIN_STYLES) {
      const opt = document.createElement('option');
      opt.value = style;
      opt.textContent = PIN_STYLE_LABELS[style] || style;
      styleSelect.appendChild(opt);
    }
    styleSelect.value = PIN_STYLES.includes(city.style) ? city.style : 'dot';
    styleSelect.addEventListener('change', (e) => {
      callbacks.onUpdateCity?.(idx, { style: e.target.value });
    });

    const activeCorner = detectOffsetCorner(city.dx, city.dy);
    const offsetWrap = document.createElement('div');
    offsetWrap.className = 'offset-pills';
    offsetWrap.title = 'Label placement corner relative to pin';

    for (const [corner, coords] of Object.entries(LABEL_OFFSETS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `offset-pill${activeCorner === corner ? ' active' : ''}`;
      btn.textContent = corner;
      btn.addEventListener('click', () => {
        callbacks.onUpdateCity?.(idx, { dx: coords.dx, dy: coords.dy });
      });
      offsetWrap.appendChild(btn);
    }

    const coordSpan = document.createElement('span');
    coordSpan.className = 'coord-micro';
    coordSpan.textContent = `${Number(city.lat).toFixed(2)}°, ${Number(city.lon).toFixed(2)}°`;

    ctrls.append(styleSelect, offsetWrap, coordSpan);

    const scaleRow = document.createElement('div');
    scaleRow.className = 'pin-scale-row';

    const scaleLabel = document.createElement('span');
    scaleLabel.className = 'pin-scale-label';
    scaleLabel.textContent = 'Size';

    const rawScale = Number(city.scale ?? 1.0);
    const pinScale = Number.isFinite(rawScale) ? rawScale : 1.0;

    const scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = '0.5';
    scaleInput.max = '2.5';
    scaleInput.step = '0.1';
    scaleInput.setAttribute('aria-label', 'Pin and label size');
    scaleInput.title = 'Pin marker & label size';
    scaleInput.value = String(pinScale);

    const scaleVal = document.createElement('span');
    scaleVal.className = 'mini-val';
    scaleVal.textContent = `${pinScale.toFixed(1)}×`;

    scaleInput.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      scaleVal.textContent = `${val.toFixed(1)}×`;
      callbacks.onUpdateCity?.(idx, { scale: val }, { commitHistory: false, skipDynamicLists: true });
    });
    scaleInput.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      scaleVal.textContent = `${val.toFixed(1)}×`;
      callbacks.onUpdateCity?.(idx, { scale: val }, { commitHistory: true });
    });

    scaleRow.append(scaleLabel, scaleInput, scaleVal);
    card.append(top, ctrls, scaleRow);
    listEl.appendChild(card);
  });
}

export function renderGeoJsonLayersList(spec, callbacks = boundCallbacks) {
  const listEl = $('geojson-layers-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const layers = spec.customGeoJsonLayers || [];
  if (!layers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No custom GeoJSON overlays loaded.';
    listEl.appendChild(empty);
    return;
  }

  layers.forEach((layer, idx) => {
    const card = document.createElement('div');
    card.className = 'list-card';

    const isPrimaryLand = layer.role === 'land';
    if (isPrimaryLand) {
      card.classList.add('list-card-primary-land');
    }

    const top = document.createElement('div');
    top.className = 'list-card-top';

    const visLabel = document.createElement('label');
    visLabel.className = 'switch-label';
    visLabel.style.minWidth = '0';
    visLabel.style.flex = '1';

    const visCheck = document.createElement('input');
    visCheck.type = 'checkbox';
    visCheck.checked = layer.visible !== false;
    visCheck.addEventListener('change', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(idx, { visible: e.target.checked });
    });

    const title = document.createElement('span');
    title.className = 'list-card-title';
    title.textContent = layer.label || `Overlay ${idx + 1}`;

    visLabel.append(visCheck, title);

    const actions = document.createElement('div');
    actions.className = 'list-card-actions';

    const landBtn = document.createElement('button');
    landBtn.type = 'button';
    landBtn.className = isPrimaryLand ? 'btn-chip active' : 'btn-chip';
    landBtn.textContent = isPrimaryLand ? 'Primary Land' : 'Use as Land';
    landBtn.title = isPrimaryLand
      ? 'Active as primary land base (click to switch back to overlay)'
      : 'Promote this layer to primary land map and unshade default land layers';
    landBtn.addEventListener('click', () => callbacks.onToggleGeoJsonPrimaryLand?.(idx));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-danger-ghost';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => callbacks.onRemoveGeoJsonLayer?.(idx));

    actions.append(landBtn, removeBtn);
    top.append(visLabel, actions);

    const ctrls = document.createElement('div');
    ctrls.className = 'list-card-controls';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.title = isPrimaryLand ? 'Primary land fill color' : 'Overlay fill color';
    colorInput.value = safeHexColor(layer.color, '#222222');
    colorInput.addEventListener('input', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(idx, { color: e.target.value }, { commitHistory: false, skipDynamicLists: true });
    });
    colorInput.addEventListener('change', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(idx, { color: e.target.value }, { commitHistory: true });
    });

    const strokeCombo = document.createElement('div');
    strokeCombo.className = 'color-combo';

    const strokeInput = document.createElement('input');
    strokeInput.type = 'color';
    strokeInput.title = isPrimaryLand ? 'Boundary / division stroke color' : 'Overlay stroke color';
    const strokeNone = layer.strokeColor === 'none';
    strokeInput.value = safeHexColor(strokeNone ? layer.color : (layer.strokeColor || layer.color), '#737373');
    strokeInput.addEventListener('input', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(
        idx,
        { strokeColor: e.target.value, strokeWidth: Math.max(0.5, Number(layer.strokeWidth) || 0.7) },
        { commitHistory: false, skipDynamicLists: true },
      );
    });
    strokeInput.addEventListener('change', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(
        idx,
        { strokeColor: e.target.value, strokeWidth: Math.max(0.5, Number(layer.strokeWidth) || 0.7) },
        { commitHistory: true },
      );
    });

    const strokeNoneBtn = document.createElement('button');
    strokeNoneBtn.type = 'button';
    strokeNoneBtn.className = strokeNone ? 'btn-chip active' : 'btn-chip';
    strokeNoneBtn.textContent = 'No Line';
    strokeNoneBtn.title = 'Toggle border / outline stroke on this layer';
    strokeNoneBtn.addEventListener('click', () => {
      callbacks.onUpdateGeoJsonLayer?.(idx, {
        strokeColor: strokeNone ? (spec.colors?.admin1 || spec.colors?.borders || '#737373') : 'none',
      });
    });
    strokeCombo.append(strokeInput, strokeNoneBtn);

    const opacityRange = document.createElement('input');
    opacityRange.type = 'range';
    opacityRange.min = '0';
    opacityRange.max = '1';
    opacityRange.step = '0.05';
    opacityRange.style.width = '68px';
    opacityRange.title = 'Fill opacity';
    opacityRange.value = String(layer.fillOpacity ?? 0.45);
    const opacityVal = document.createElement('span');
    opacityVal.className = 'mini-val';
    opacityVal.textContent = `${Math.round((layer.fillOpacity ?? 0.45) * 100)}%`;

    opacityRange.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      opacityVal.textContent = `${Math.round(val * 100)}%`;
      callbacks.onUpdateGeoJsonLayer?.(idx, { fillOpacity: val }, { commitHistory: false, skipDynamicLists: true });
    });
    opacityRange.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      callbacks.onUpdateGeoJsonLayer?.(idx, { fillOpacity: val }, { commitHistory: true });
    });

    const dashedLabel = document.createElement('label');
    dashedLabel.className = 'switch-label';
    dashedLabel.style.fontSize = '12.5px';
    const dashedCheck = document.createElement('input');
    dashedCheck.type = 'checkbox';
    dashedCheck.checked = Boolean(layer.dashed);
    dashedCheck.addEventListener('change', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(idx, { dashed: e.target.checked });
    });
    const dashedSpan = document.createElement('span');
    dashedSpan.textContent = 'Dashed';
    dashedLabel.append(dashedCheck, dashedSpan);

    const hatchSelect = document.createElement('select');
    hatchSelect.title = 'Overlay hatch pattern';
    for (const h of HATCH_STYLES) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = HATCH_LABELS[h] || h;
      hatchSelect.appendChild(opt);
    }
    hatchSelect.value = HATCH_STYLES.includes(layer.hatch) ? layer.hatch : 'none';
    hatchSelect.addEventListener('change', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(idx, { hatch: e.target.value });
    });

    ctrls.append(colorInput, strokeCombo, opacityRange, opacityVal, dashedLabel, hatchSelect);

    const widthRow = document.createElement('div');
    widthRow.className = 'pin-scale-row';
    const widthLbl = document.createElement('span');
    widthLbl.className = 'pin-scale-label';
    widthLbl.textContent = 'Size';
    const rawW = Number(layer.strokeWidth ?? 1.5);
    const strokeW = Number.isFinite(rawW) ? rawW : 1.5;
    const widthRange = document.createElement('input');
    widthRange.type = 'range';
    widthRange.min = '0.4';
    widthRange.max = '4.5';
    widthRange.step = '0.1';
    widthRange.title = 'Overlay line width / point dot size';
    widthRange.value = String(strokeW);
    const widthVal = document.createElement('span');
    widthVal.className = 'mini-val';
    widthVal.textContent = strokeW.toFixed(1);
    widthRange.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      widthVal.textContent = val.toFixed(1);
      callbacks.onUpdateGeoJsonLayer?.(idx, { strokeWidth: val }, { commitHistory: false, skipDynamicLists: true });
    });
    widthRange.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      widthVal.textContent = val.toFixed(1);
      callbacks.onUpdateGeoJsonLayer?.(idx, { strokeWidth: val }, { commitHistory: true });
    });
    widthRow.append(widthLbl, widthRange, widthVal);

    card.append(top, ctrls, widthRow);
    listEl.appendChild(card);
  });
}

function renderHistoricalLayerGroup(listId, defs, spec, callbacks) {
  const listEl = $(listId);
  if (!listEl) return;
  listEl.innerHTML = '';

  const layersById = new Map();
  for (const l of spec.customGeoJsonLayers || []) {
    if (l?.id) layersById.set(l.id, l);
  }

  for (const def of defs) {
    const activeLayer = layersById.get(def.id) || null;
    const isVisible = Boolean(activeLayer && activeLayer.visible !== false);
    const currentColor = safeHexColor(activeLayer?.color || def.color, def.color);
    const currentWidth = Number.isFinite(Number(activeLayer?.strokeWidth))
      ? Number(activeLayer.strokeWidth)
      : def.strokeWidth;
    const currentOpacity = Number.isFinite(Number(activeLayer?.fillOpacity))
      ? Number(activeLayer.fillOpacity)
      : def.fillOpacity;
    const currentDashed = activeLayer ? Boolean(activeLayer.dashed) : Boolean(def.dashed);
    const isPoint = def.geometryKind === 'point';

    const item = document.createElement('div');
    item.className = `historical-layer-item${isVisible ? ' active' : ''}`;

    const top = document.createElement('div');
    top.className = 'historical-layer-top';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'switch-label';
    toggleLabel.title = def.label;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isVisible;
    checkbox.addEventListener('change', (e) => {
      callbacks.onToggleHistoricalLayer?.(def, e.target.checked);
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'historical-layer-name';
    nameSpan.textContent = def.shortLabel;

    toggleLabel.append(checkbox, nameSpan);

    const right = document.createElement('div');
    right.className = 'historical-layer-right';

    const metaSpan = document.createElement('span');
    metaSpan.className = 'historical-meta';
    metaSpan.textContent = def.meta;

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'historical-color';
    colorInput.title = `${def.shortLabel} color`;
    colorInput.value = currentColor;
    colorInput.addEventListener('input', (e) => {
      callbacks.onUpdateHistoricalLayer?.(
        def,
        { color: e.target.value },
        { commitHistory: false, skipDynamicLists: true },
      );
    });
    colorInput.addEventListener('change', (e) => {
      callbacks.onUpdateHistoricalLayer?.(def, { color: e.target.value }, { commitHistory: true });
    });

    right.append(metaSpan, colorInput);
    top.append(toggleLabel, right);
    item.appendChild(top);

    if (isVisible) {
      const sub = document.createElement('div');
      sub.className = 'historical-layer-sub';

      // Size / Width slider
      const sizeCtrl = document.createElement('label');
      sizeCtrl.className = 'historical-sub-control';
      const sizeLbl = document.createElement('span');
      sizeLbl.textContent = isPoint ? 'Dot' : 'Width';
      const sizeInput = document.createElement('input');
      sizeInput.type = 'range';
      sizeInput.min = '0.4';
      sizeInput.max = '4.0';
      sizeInput.step = '0.1';
      sizeInput.title = isPoint ? 'Dot radius scale' : 'Track line width';
      sizeInput.value = String(currentWidth);
      const sizeVal = document.createElement('span');
      sizeVal.className = 'mini-val';
      sizeVal.textContent = currentWidth.toFixed(1);
      sizeInput.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        sizeVal.textContent = val.toFixed(1);
        callbacks.onUpdateHistoricalLayer?.(
          def,
          { strokeWidth: val },
          { commitHistory: false, skipDynamicLists: true },
        );
      });
      sizeInput.addEventListener('change', (e) => {
        const val = Number(e.target.value);
        sizeVal.textContent = val.toFixed(1);
        callbacks.onUpdateHistoricalLayer?.(def, { strokeWidth: val }, { commitHistory: true });
      });
      sizeCtrl.append(sizeLbl, sizeInput, sizeVal);
      sub.appendChild(sizeCtrl);

      if (isPoint) {
        // Opacity slider for point layers (airfields & stations)
        const opCtrl = document.createElement('label');
        opCtrl.className = 'historical-sub-control';
        const opLbl = document.createElement('span');
        opLbl.textContent = 'Alpha';
        const opInput = document.createElement('input');
        opInput.type = 'range';
        opInput.min = '0.2';
        opInput.max = '1.0';
        opInput.step = '0.05';
        opInput.title = 'Dot opacity';
        opInput.value = String(currentOpacity);
        const opVal = document.createElement('span');
        opVal.className = 'mini-val';
        opVal.textContent = `${Math.round(currentOpacity * 100)}%`;
        opInput.addEventListener('input', (e) => {
          const val = Number(e.target.value);
          opVal.textContent = `${Math.round(val * 100)}%`;
          callbacks.onUpdateHistoricalLayer?.(
            def,
            { fillOpacity: val },
            { commitHistory: false, skipDynamicLists: true },
          );
        });
        opInput.addEventListener('change', (e) => {
          const val = Number(e.target.value);
          opVal.textContent = `${Math.round(val * 100)}%`;
          callbacks.onUpdateHistoricalLayer?.(def, { fillOpacity: val }, { commitHistory: true });
        });
        opCtrl.append(opLbl, opInput, opVal);
        sub.appendChild(opCtrl);
      } else {
        // Dashed toggle for railway line layers
        const dashLabel = document.createElement('label');
        dashLabel.className = 'switch-label';
        const dashCheck = document.createElement('input');
        dashCheck.type = 'checkbox';
        dashCheck.checked = currentDashed;
        dashCheck.addEventListener('change', (e) => {
          callbacks.onUpdateHistoricalLayer?.(def, { dashed: e.target.checked });
        });
        const dashSpan = document.createElement('span');
        dashSpan.textContent = 'Dashed';
        dashLabel.append(dashCheck, dashSpan);
        sub.appendChild(dashLabel);
      }

      item.appendChild(sub);
    }

    listEl.appendChild(item);
  }
}

export function renderHistoricalTabLists(spec, callbacks = boundCallbacks, alaskaYear = 1943) {
  const year = Number(alaskaYear) || 1943;
  const pillContainer = $('alaska-year-pills');
  if (pillContainer) {
    pillContainer.querySelectorAll('.year-pill').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.akYear) === year);
    });
  }
  renderHistoricalLayerGroup('alaska-airfield-layers-list', buildAlaskaYearLayerDefs(year), spec, callbacks);
  renderHistoricalLayerGroup('airfield-1941-layers-list', AIRFIELD_1941_LAYERS, spec, callbacks);
  renderHistoricalLayerGroup('ph-rail-layers-list', PHILIPPINES_RAIL_1942_LAYERS, spec, callbacks);
}

function populateStaticOptions(callbacks) {
  // Region presets dropdown
  const presetSelect = $('preset-select');
  if (presetSelect) {
    presetSelect.innerHTML = '<option value="">Load Region Preset...</option>';
    for (const preset of REGION_PRESETS) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.label;
      presetSelect.appendChild(opt);
    }
  }

  // Page presets dropdown
  const pagePreset = $('page-preset');
  if (pagePreset) {
    pagePreset.innerHTML = '';
    for (const preset of Object.values(PAGE_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.label;
      pagePreset.appendChild(opt);
    }
  }

  // Projections dropdown
  const projSelect = $('map-projection');
  if (projSelect) {
    projSelect.innerHTML = '';
    for (const proj of PROJECTIONS) {
      const opt = document.createElement('option');
      opt.value = proj;
      opt.textContent = PROJECTION_LABELS[proj] || proj;
      projSelect.appendChild(opt);
    }
  }

  // Color Theme Swatches
  const themeGrid = $('theme-swatches');
  if (themeGrid) {
    themeGrid.innerHTML = '';
    for (const theme of Object.values(COLOR_THEMES)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-swatch-btn';
      btn.dataset.themeId = theme.id;

      const label = document.createElement('span');
      label.className = 'theme-swatch-name';
      label.textContent = theme.label;

      const dots = document.createElement('span');
      dots.className = 'swatch-dots';
      for (const hex of [theme.land, theme.water, theme.borders, theme.highlightFill]) {
        const dot = document.createElement('span');
        dot.className = 'swatch-dot';
        dot.style.background = hex === 'none' ? 'transparent' : hex;
        dots.appendChild(dot);
      }

      btn.append(label, dots);
      btn.addEventListener('click', () => callbacks.onApplyTheme?.(theme.id));
      themeGrid.appendChild(btn);
    }
  }

  // GeoJSON example quick chips
  const examplesRow = $('geojson-examples-row');
  if (examplesRow) {
    examplesRow.innerHTML = '';
    for (const ex of GEOJSON_EXAMPLES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'example-chip';
      chip.textContent = `+ ${ex.label}`;
      chip.addEventListener('click', () => {
        const input = $('geojson-url-input');
        if (input) input.value = ex.url;
        callbacks.onLoadGeoJsonUrl?.(ex.url, ex.label, ex.style);
      });
      examplesRow.appendChild(chip);
    }
  }
}

export function renderControls(callbacks) {
  boundCallbacks = callbacks || {};
  populateStaticOptions(boundCallbacks);

  // Sidebar Tabs
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      tabBtns.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        const active = panel.id === `tab-${targetTab}`;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
      boundCallbacks.onTabChange?.(targetTab);
    });
  });

  // Mobile sidebar drawer toggle
  $('btn-toggle-sidebar')?.addEventListener('click', () => {
    $('sidebar')?.classList.toggle('collapsed');
  });

  // Top Bar actions
  $('preset-select')?.addEventListener('change', (e) => {
    if (e.target.value) {
      boundCallbacks.onSelectPreset?.(e.target.value);
    }
  });
  $('btn-undo')?.addEventListener('click', () => boundCallbacks.onUndo?.());
  $('btn-redo')?.addEventListener('click', () => boundCallbacks.onRedo?.());
  $('btn-share')?.addEventListener('click', () => boundCallbacks.onCopyShareLink?.());
  $('btn-save-json')?.addEventListener('click', () => boundCallbacks.onSaveProjectJson?.());
  $('btn-load-json')?.addEventListener('click', () => $('file-load-json')?.click());
  $('file-load-json')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) boundCallbacks.onLoadProjectFile?.(file);
    e.target.value = '';
  });

  $('btn-export')?.addEventListener('click', () => {
    const fmt = $('export-format')?.value || 'png';
    boundCallbacks.onExport?.(fmt);
  });
  $('btn-export-pair')?.addEventListener('click', () => {
    const fmt = $('export-format')?.value || 'png';
    boundCallbacks.onExportPair?.(fmt);
  });

  // Tab 1: Search & Page & Projection
  $('place-search-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('place-search-input')?.value || '';
    boundCallbacks.onSearchPlaces?.(q);
  });

  $('page-preset')?.addEventListener('change', (e) => {
    const presetId = e.target.value;
    const preset = PAGE_PRESETS[presetId];
    if (!preset) return;
    if (presetId === 'custom') {
      boundCallbacks.onPatchSpec?.({ page: { preset: 'custom' } });
    } else {
      boundCallbacks.onPatchSpec?.({
        page: {
          preset: presetId,
          widthIn: preset.widthIn,
          heightIn: preset.heightIn,
        },
      });
    }
  });

  const handleCustomDims = () => {
    const w = Number($('page-width-in')?.value);
    const h = Number($('page-height-in')?.value);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    boundCallbacks.onPatchSpec?.({
      page: {
        preset: 'custom',
        widthIn: Math.min(40, Math.max(1, w)),
        heightIn: Math.min(40, Math.max(1, h)),
      },
    });
  };
  $('page-width-in')?.addEventListener('change', handleCustomDims);
  $('page-height-in')?.addEventListener('change', handleCustomDims);
  $('page-dpi')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ page: { dpi: Number(e.target.value) || 300 } });
  });

  $('map-projection')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ projection: e.target.value });
  });
  $('map-detail-level')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ detailLevel: e.target.value });
  });

  const bindNum = (id, handler) => {
    $(id)?.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      if (Number.isFinite(val)) handler(val);
    });
  };
  bindNum('center-lat', (v) => boundCallbacks.onPatchSpec?.({ center: { lat: v } }));
  bindNum('center-lon', (v) => boundCallbacks.onPatchSpec?.({ center: { lon: v } }));
  bindNum('span-lon', (v) => boundCallbacks.onPatchSpec?.({ span: { lonDeg: v } }));
  bindNum('span-lat', (v) => boundCallbacks.onPatchSpec?.({ span: { latDeg: v } }));

  // Tab 2: Colors & Layers
  for (const field of PALETTE_COLOR_FIELDS) {
    $(field.inputId)?.addEventListener('input', (e) => {
      boundCallbacks.onPickPaletteColor?.(field.key, e.target.value, {
        commitHistory: false,
        skipDynamicLists: true,
      });
    });
    $(field.inputId)?.addEventListener('change', (e) => {
      boundCallbacks.onPickPaletteColor?.(field.key, e.target.value, {
        commitHistory: true,
      });
    });
    $(field.noneBtnId)?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      boundCallbacks.onTogglePaletteColorNone?.(field.key);
    });
  }

  $('btn-palette-all-off')?.addEventListener('click', () => {
    boundCallbacks.onToggleAllPaletteColorsOff?.();
  });
  $('btn-palette-reset')?.addEventListener('click', () => {
    boundCallbacks.onResetPaletteColors?.();
  });

  const bindCheck = (id, fn) => {
    $(id)?.addEventListener('change', (e) => fn(e.target.checked));
  };
  bindCheck('layer-show-land', (v) => boundCallbacks.onToggleLayerWithColor?.('showLand', 'land', v));
  bindCheck('layer-show-borders', (v) => boundCallbacks.onToggleLayerWithColor?.('showBorders', 'borders', v));
  bindCheck('layer-show-minor-islands', (v) => boundCallbacks.onPatchSpec?.({ layers: { showMinorIslands: v } }));
  bindCheck('layer-show-lakes', (v) => boundCallbacks.onPatchSpec?.({ layers: { showLakes: v } }));
  bindCheck('layer-show-bathymetry', (v) => boundCallbacks.onToggleLayerWithColor?.('showBathymetry', 'bathymetry', v));
  bindCheck('layer-show-urban', (v) => boundCallbacks.onToggleLayerWithColor?.('showUrbanAreas', 'urban', v));
  bindCheck('layer-show-rivers', (v) => boundCallbacks.onToggleLayerWithColor?.('showRivers', 'rivers', v));
  bindCheck('layer-show-admin1', (v) => boundCallbacks.onToggleLayerWithColor?.('showAdmin1', 'admin1', v));
  bindCheck('layer-show-coastlines', (v) => boundCallbacks.onToggleLayerWithColor?.('showCoastlines', 'coastline', v));
  bindCheck('layer-show-graticule', (v) => boundCallbacks.onPatchSpec?.({ layers: { showGraticule: v } }));
  bindCheck('page-show-frame', (v) => boundCallbacks.onPatchSpec?.({ page: { showFrameBorder: v } }));

  const bindRange = (id, labelId, patchBuilder) => {
    $(id)?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      const lbl = $(labelId);
      if (lbl) lbl.textContent = val.toFixed(1);
      boundCallbacks.onPatchSpec?.(patchBuilder(val), { commitHistory: false });
    });
    $(id)?.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      boundCallbacks.onPatchSpec?.(patchBuilder(val), { commitHistory: true });
    });
  };
  bindRange('layer-border-width', 'layer-border-width-val', (v) => ({ layers: { borderWidth: v } }));
  bindRange('layer-river-width', 'layer-river-width-val', (v) => ({ layers: { riverWidth: v } }));
  bindRange('layer-coastline-width', 'layer-coastline-width-val', (v) => ({ layers: { coastlineWidth: v } }));

  $('layer-admin1-scale')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ layers: { admin1Scale: e.target.value } });
  });
  $('layer-admin1-width')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    const lbl = $('layer-admin1-width-val');
    if (lbl) lbl.textContent = val.toFixed(1);
    boundCallbacks.onPatchSpec?.(
      { layers: { admin1Width: val } },
      { commitHistory: false, skipDynamicLists: true },
    );
  });
  $('layer-admin1-width')?.addEventListener('change', (e) => {
    const val = Number(e.target.value);
    boundCallbacks.onPatchSpec?.(
      { layers: { admin1Width: val } },
      { commitHistory: true },
    );
  });

  $('layer-border-style')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ layers: { borderStyle: e.target.value } });
  });
  $('layer-graticule-step')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ layers: { graticuleStepDeg: Number(e.target.value) || 10 } });
  });

  $('hd-coastline-color-mode')?.addEventListener('change', (e) => {
    boundCallbacks.onChangeHdCoastlineColorMode?.(e.target.value);
  });

  $('hd-coastline-color')?.addEventListener('input', (e) => {
    boundCallbacks.onPickHdCoastlineColor?.(e.target.value, { commitHistory: false, skipDynamicLists: true });
  });
  $('hd-coastline-color')?.addEventListener('change', (e) => {
    boundCallbacks.onPickHdCoastlineColor?.(e.target.value, { commitHistory: true });
  });

  $('btn-fetch-osm-coastline-land')?.addEventListener('click', () => {
    const simplifyMeters = Number($('hd-coastline-detail')?.value) || 0;
    const colorMode = $('hd-coastline-color-mode')?.value || 'host';
    boundCallbacks.onFetchOsmCoastlines?.({ asPrimaryLand: true, simplifyMeters, colorMode });
  });

  $('btn-fetch-osm-coastline-overlay')?.addEventListener('click', () => {
    const simplifyMeters = Number($('hd-coastline-detail')?.value) || 0;
    const colorMode = $('hd-coastline-color-mode')?.value || 'host';
    boundCallbacks.onFetchOsmCoastlines?.({ asPrimaryLand: false, simplifyMeters, colorMode });
  });

  $('btn-refresh-osm-coastline')?.addEventListener('click', () => {
    const simplifyMeters = Number($('hd-coastline-detail')?.value) || 0;
    const colorMode = $('hd-coastline-color-mode')?.value || 'host';
    boundCallbacks.onFetchOsmCoastlines?.({ asPrimaryLand: true, simplifyMeters, colorMode, forceRefresh: true });
  });

  $('btn-load-geoboundaries-land')?.addEventListener('click', () => {
    const sel = $('geoboundaries-country');
    const opt = sel?.selectedOptions?.[0];
    const level = $('geoboundaries-level')?.value || 'ADM1';
    if (!opt || !opt.value) return;
    boundCallbacks.onLoadGeoBoundaries?.(opt.value, opt.dataset.name || opt.textContent, level, { asPrimaryLand: true });
  });

  $('btn-load-geoboundaries')?.addEventListener('click', () => {
    const sel = $('geoboundaries-country');
    const opt = sel?.selectedOptions?.[0];
    const level = $('geoboundaries-level')?.value || 'ADM1';
    if (!opt || !opt.value) return;
    boundCallbacks.onLoadGeoBoundaries?.(opt.value, opt.dataset.name || opt.textContent, level, { asPrimaryLand: false });
  });

  $('btn-restore-default-land')?.addEventListener('click', () => {
    boundCallbacks.onRestoreDefaultLand?.();
  });

  // Tab 3: Region Shadows, Countries, Pins & GeoJSON
  $('btn-shadow-src-country')?.addEventListener('click', () => {
    populateShadowRegionCatalog(null, 'country', $('shadow-filter-input')?.value || '');
    boundCallbacks.onSwitchShadowSourceType?.('country');
  });
  $('btn-shadow-src-admin1')?.addEventListener('click', () => {
    populateShadowRegionCatalog(null, 'admin1', $('shadow-filter-input')?.value || '');
    boundCallbacks.onSwitchShadowSourceType?.('admin1');
  });
  $('shadow-filter-input')?.addEventListener('input', (e) => {
    populateShadowRegionCatalog(null, activeShadowSourceType, e.target.value);
  });
  $('btn-add-shadow')?.addEventListener('click', () => {
    const select = $('shadow-region-select');
    const opt = select?.selectedOptions?.[0];
    if (!opt || !opt.value) return;
    boundCallbacks.onAddShadow?.(
      opt.dataset.sourceType || activeShadowSourceType,
      opt.value,
      opt.dataset.name || opt.textContent,
    );
  });
  $('btn-mode-shadow')?.addEventListener('click', () => {
    boundCallbacks.onToggleMode?.('shadow');
  });

  $('btn-mode-country')?.addEventListener('click', () => {
    boundCallbacks.onToggleMode?.('country');
  });
  $('country-filter-input')?.addEventListener('input', (e) => {
    populateCountryCatalog(null, e.target.value);
  });
  $('btn-add-country')?.addEventListener('click', () => {
    const select = $('country-select');
    const opt = select?.selectedOptions?.[0];
    if (!opt || !opt.value) return;
    boundCallbacks.onAddCountry?.(opt.value, opt.dataset.name || opt.textContent);
  });

  $('btn-mode-pin')?.addEventListener('click', () => {
    boundCallbacks.onToggleMode?.('pin');
  });
  $('btn-auto-cities')?.addEventListener('click', () => {
    boundCallbacks.onAutoAddCities?.();
  });

  const bindCityScaleRange = (id, labelId, key) => {
    $(id)?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      const lbl = $(labelId);
      if (lbl) lbl.textContent = `${val.toFixed(1)}×`;
      boundCallbacks.onPatchSpec?.(
        { layers: { [key]: val } },
        { commitHistory: false, skipDynamicLists: true },
      );
    });
    $(id)?.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      const lbl = $(labelId);
      if (lbl) lbl.textContent = `${val.toFixed(1)}×`;
      boundCallbacks.onPatchSpec?.(
        { layers: { [key]: val } },
        { commitHistory: true },
      );
    });
  };
  bindCityScaleRange('city-label-scale', 'city-label-scale-val', 'cityLabelScale');
  bindCityScaleRange('city-icon-scale', 'city-icon-scale-val', 'cityIconScale');

  $('btn-upload-geojson')?.addEventListener('click', () => $('file-upload-geojson')?.click());
  $('file-upload-geojson')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) boundCallbacks.onUploadGeoJsonFile?.(file);
    e.target.value = '';
  });
  $('btn-load-geojson-url')?.addEventListener('click', () => {
    const url = $('geojson-url-input')?.value?.trim();
    if (url) boundCallbacks.onLoadGeoJsonUrl?.(url);
  });

  // Tab 4: Ornaments & Pro
  bindCheck('show-title', (v) => boundCallbacks.onPatchSpec?.({ showTitle: v }));
  $('map-title')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ title: e.target.value });
  });

  bindCheck('orn-scale-enabled', (v) => boundCallbacks.onPatchSpec?.({ ornaments: { scaleBar: { enabled: v } } }));
  $('orn-scale-units')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { scaleBar: { units: e.target.value } } });
  });
  $('orn-scale-pos')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { scaleBar: { position: e.target.value } } });
  });

  bindCheck('orn-globe-enabled', (v) => boundCallbacks.onPatchSpec?.({ ornaments: { locatorGlobe: { enabled: v } } }));
  $('orn-globe-pos')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { locatorGlobe: { position: e.target.value } } });
  });
  $('orn-globe-size')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    const lbl = $('orn-globe-size-val');
    if (lbl) lbl.textContent = `${v}%`;
    boundCallbacks.onPatchSpec?.({ ornaments: { locatorGlobe: { sizePct: v } } }, { commitHistory: false });
  });
  $('orn-globe-size')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { locatorGlobe: { sizePct: Number(e.target.value) } } }, { commitHistory: true });
  });
  $('orn-globe-zoom-mode')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { locatorGlobe: { zoomMode: e.target.value } } });
  });
  $('orn-globe-zoom')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    const lbl = $('orn-globe-zoom-val');
    if (lbl) lbl.textContent = `${val.toFixed(1)}×`;
    boundCallbacks.onPatchSpec?.(
      { ornaments: { locatorGlobe: { zoomMode: 'custom', zoom: val } } },
      { commitHistory: false, skipDynamicLists: true },
    );
  });
  $('orn-globe-zoom')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.(
      { ornaments: { locatorGlobe: { zoomMode: 'custom', zoom: Number(e.target.value) } } },
      { commitHistory: true },
    );
  });
  bindCheck('orn-globe-box', (v) => boundCallbacks.onPatchSpec?.({ ornaments: { locatorGlobe: { showExtentBox: v } } }));

  bindCheck('orn-north-enabled', (v) => boundCallbacks.onPatchSpec?.({ ornaments: { northArrow: { enabled: v } } }));
  $('orn-north-pos')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { northArrow: { position: e.target.value } } });
  });
  bindCheck('orn-legend-enabled', (v) => boundCallbacks.onPatchSpec?.({ ornaments: { legend: { enabled: v } } }));
  $('orn-legend-pos')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { legend: { position: e.target.value } } });
  });

  $('pro-coastline-engine')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ pro: { coastlineEngine: e.target.value } });
  });
  $('pro-basemap')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ pro: { basemapProvider: e.target.value } });
  });
  $('pro-basemap-opacity')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    const lbl = $('pro-basemap-opacity-val');
    if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
    boundCallbacks.onPatchSpec?.({ pro: { basemapOpacity: v } }, { commitHistory: false });
  });
  $('pro-basemap-opacity')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ pro: { basemapOpacity: Number(e.target.value) } }, { commitHistory: true });
  });
  $('btn-render-pro')?.addEventListener('click', () => boundCallbacks.onRenderPro?.());
  $('btn-export-batch-pro')?.addEventListener('click', () => boundCallbacks.onExportBatchPro?.());

  // Tab 4: Historical Layers (Alaska 1939-1945 Airfields, 1941 Airfields & 1942-1945 Philippines Railways)
  $('alaska-year-pills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.year-pill');
    if (!btn) return;
    const yr = Number(btn.dataset.akYear);
    if (Number.isFinite(yr)) {
      boundCallbacks.onSelectAlaskaYear?.(yr);
    }
  });
  $('btn-hist-alaska-both')?.addEventListener('click', () => {
    boundCallbacks.onApplyAlaskaPreset?.('both');
  });
  $('btn-hist-alaska-none')?.addEventListener('click', () => {
    boundCallbacks.onApplyAlaskaPreset?.('none');
  });
  $('btn-hist-frame-alaska')?.addEventListener('click', () => {
    boundCallbacks.onFrameHistoricalRegion?.('alaska');
  });
  $('alaska-airfield-master-size')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    const lbl = $('alaska-airfield-master-size-val');
    if (lbl) lbl.textContent = val.toFixed(1);
    boundCallbacks.onSetHistoricalGroupSize?.('alaska_airfields', val, {
      commitHistory: false,
      skipDynamicLists: true,
    });
  });
  $('alaska-airfield-master-size')?.addEventListener('change', (e) => {
    const val = Number(e.target.value);
    const lbl = $('alaska-airfield-master-size-val');
    if (lbl) lbl.textContent = val.toFixed(1);
    boundCallbacks.onSetHistoricalGroupSize?.('alaska_airfields', val, { commitHistory: true });
  });

  $('btn-hist-airfields-both')?.addEventListener('click', () => {
    boundCallbacks.onApplyAirfieldPreset?.('both');
  });
  $('btn-hist-airfields-none')?.addEventListener('click', () => {
    boundCallbacks.onApplyAirfieldPreset?.('none');
  });
  $('btn-hist-frame-seasia')?.addEventListener('click', () => {
    boundCallbacks.onFrameHistoricalRegion?.('se_asia');
  });
  $('btn-hist-frame-ph-air')?.addEventListener('click', () => {
    boundCallbacks.onFrameHistoricalRegion?.('philippines');
  });

  $('airfield-master-size')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    const lbl = $('airfield-master-size-val');
    if (lbl) lbl.textContent = val.toFixed(1);
    boundCallbacks.onSetHistoricalGroupSize?.('airfields', val, { commitHistory: false, skipDynamicLists: true });
  });
  $('airfield-master-size')?.addEventListener('change', (e) => {
    const val = Number(e.target.value);
    const lbl = $('airfield-master-size-val');
    if (lbl) lbl.textContent = val.toFixed(1);
    boundCallbacks.onSetHistoricalGroupSize?.('airfields', val, { commitHistory: true });
  });

  $('btn-hist-rail-common')?.addEventListener('click', () => {
    boundCallbacks.onApplyRailPreset?.('common_carrier');
  });
  $('btn-hist-rail-all')?.addEventListener('click', () => {
    boundCallbacks.onApplyRailPreset?.('all');
  });
  $('btn-hist-rail-none')?.addEventListener('click', () => {
    boundCallbacks.onApplyRailPreset?.('none');
  });
  $('btn-hist-frame-ph-rail')?.addEventListener('click', () => {
    boundCallbacks.onFrameHistoricalRegion?.('philippines');
  });

  $('ph-rail-master-width')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    const lbl = $('ph-rail-master-width-val');
    if (lbl) lbl.textContent = val.toFixed(1);
    boundCallbacks.onSetHistoricalGroupSize?.('ph_rail_lines', val, { commitHistory: false, skipDynamicLists: true });
  });
  $('ph-rail-master-width')?.addEventListener('change', (e) => {
    const val = Number(e.target.value);
    const lbl = $('ph-rail-master-width-val');
    if (lbl) lbl.textContent = val.toFixed(1);
    boundCallbacks.onSetHistoricalGroupSize?.('ph_rail_lines', val, { commitHistory: true });
  });

  $('btn-preset-alaska-air')?.addEventListener('click', () => {
    boundCallbacks.onSelectPreset?.('alaska_airfields_1939_1945');
  });
  $('btn-preset-ph-rail')?.addEventListener('click', () => {
    boundCallbacks.onSelectPreset?.('philippines_railways_1942_1945');
  });
  $('btn-preset-ph-combined')?.addEventListener('click', () => {
    boundCallbacks.onSelectPreset?.('philippines_wwii_combined');
  });
  $('btn-preset-seasia-air')?.addEventListener('click', () => {
    boundCallbacks.onSelectPreset?.('se_asia_1941_airfields');
  });

  // Tab 5: Timeline Layer Generator (CSV-Driven)
  $('btn-timeline-frame-alaska')?.addEventListener('click', () => {
    boundCallbacks.onFrameHistoricalRegion?.('alaska');
  });
  $('btn-timeline-upload-csv')?.addEventListener('click', () => {
    $('file-timeline-csv')?.click();
  });
  $('file-timeline-csv')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) boundCallbacks.onUploadTimelineCsv?.(file);
    e.target.value = '';
  });
  $('timeline-window-size')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ windowSize: e.target.value });
  });
  $('timeline-gen-mode')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ mode: e.target.value });
  });
  $('timeline-year-slider')?.addEventListener('input', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ startYear: Number(e.target.value) });
  });
  $('timeline-start-year')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ startYear: Number(e.target.value), customRange: true });
  });
  $('timeline-end-year')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ endYear: Number(e.target.value), customRange: true });
  });
  $('btn-timeline-prev')?.addEventListener('click', () => boundCallbacks.onTimelineStep?.(-1));
  $('btn-timeline-next')?.addEventListener('click', () => boundCallbacks.onTimelineStep?.(1));
  $('btn-timeline-play')?.addEventListener('click', () => boundCallbacks.onTimelineTogglePlay?.());
  $('timeline-region-filter')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ regionFilter: e.target.value });
  });
  $('timeline-dot-size')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    const lbl = $('timeline-dot-size-val');
    if (lbl) lbl.textContent = val.toFixed(1);
    boundCallbacks.onTimelineConfigChange?.({ dotSize: val });
  });
  $('timeline-inc-mil')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ includeMilitary: e.target.checked });
  });
  $('timeline-inc-civ')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ includeCivilian: e.target.checked });
  });
  $('timeline-split-dual')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ splitDualUse: e.target.checked });
  });
  $('timeline-inc-const')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ includeConstruction: e.target.checked });
  });
  $('timeline-inc-seaplane')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ includeSeaplane: e.target.checked });
  });
  $('timeline-auto-sync')?.addEventListener('change', (e) => {
    boundCallbacks.onTimelineConfigChange?.({ autoSync: e.target.checked });
  });
  $('btn-timeline-generate')?.addEventListener('click', () => {
    boundCallbacks.onTimelineGenerate?.({ force: true });
  });
  $('btn-timeline-clear')?.addEventListener('click', () => {
    boundCallbacks.onTimelineClear?.();
  });
  $('btn-timeline-export-geojson')?.addEventListener('click', () => {
    boundCallbacks.onTimelineExport?.('geojson');
  });
  $('btn-timeline-export-csv')?.addEventListener('click', () => {
    boundCallbacks.onTimelineExport?.('csv');
  });

  // Stage floating controls
  $('btn-exit-mode')?.addEventListener('click', () => boundCallbacks.onToggleMode?.('pan'));
  $('btn-ref-peek')?.addEventListener('click', () => boundCallbacks.onToggleRefPeek?.());
  $('btn-zoom-in')?.addEventListener('click', () => boundCallbacks.onZoom?.(0.75));
  $('btn-zoom-out')?.addEventListener('click', () => boundCallbacks.onZoom?.(1.35));
  $('btn-reset-view')?.addEventListener('click', () => boundCallbacks.onResetView?.());
}

export function syncControlsFromSpec(spec, uiState = {}) {
  const {
    canUndo = false,
    canRedo = false,
    proAvailable = false,
    proStatusText = '',
    mode = 'pan',
    refPeek = false,
    activePresetId = '',
    skipDynamicLists = false,
    shadowMetrics = null,
  } = uiState;

  // Top bar
  const presetSelect = $('preset-select');
  if (presetSelect && activePresetId !== undefined) {
    presetSelect.value = activePresetId;
  }
  if ($('btn-undo')) $('btn-undo').disabled = !canUndo;
  if ($('btn-redo')) $('btn-redo').disabled = !canRedo;

  // Engine badge & Pro section
  const dims = getPixelDimensions(spec.page);
  const badge = $('engine-status');
  if (badge) {
    if (proAvailable) {
      badge.textContent = `Python Pro Engine Active • ${dims.dpi} DPI`;
      badge.className = 'engine-badge engine-pro';
    } else {
      badge.textContent = `Standalone Studio • ${dims.dpi} DPI`;
      badge.className = 'engine-badge engine-standalone';
    }
  }

  const pdfOpt = document.querySelector('#export-format option[value="pdf"]');
  if (pdfOpt) {
    pdfOpt.disabled = !proAvailable;
    pdfOpt.textContent = proAvailable ? 'Vector PDF (Python Pro)' : 'PDF (Python Pro Only)';
  }
  if (!proAvailable && $('export-format')?.value === 'pdf') {
    $('export-format').value = 'png';
  }

  const proFieldset = $('pro-controls');
  const proPill = $('pro-pill');
  const proNote = $('pro-status-note');
  if (proFieldset) proFieldset.disabled = !proAvailable;
  if (proPill) {
    proPill.textContent = proAvailable ? 'Connected' : 'Standalone Mode';
    proPill.style.color = proAvailable ? '#6ee7b7' : '#7dd3fc';
  }
  if (proNote && proStatusText) {
    proNote.textContent = proStatusText;
  }

  // Page & Framing
  if ($('pixel-dimensions-badge')) {
    $('pixel-dimensions-badge').textContent = `${dims.widthPx} × ${dims.heightPx} px`;
  }
  if ($('page-preset')) $('page-preset').value = spec.page.preset;
  if ($('page-width-in')) $('page-width-in').value = String(spec.page.widthIn);
  if ($('page-height-in')) $('page-height-in').value = String(spec.page.heightIn);
  if ($('page-dpi')) {
    const dpiSelect = $('page-dpi');
    const dpiStr = String(spec.page.dpi);
    if (!Array.from(dpiSelect.options).some((o) => o.value === dpiStr)) {
      const opt = document.createElement('option');
      opt.value = dpiStr;
      opt.textContent = `${dpiStr} DPI (Custom)`;
      dpiSelect.appendChild(opt);
    }
    dpiSelect.value = dpiStr;
  }

  if ($('map-projection')) $('map-projection').value = spec.projection;
  if ($('map-detail-level')) $('map-detail-level').value = spec.detailLevel;
  if ($('center-lat')) $('center-lat').value = Number(spec.center.lat).toFixed(2);
  if ($('center-lon')) $('center-lon').value = Number(spec.center.lon).toFixed(2);
  const fmtSpan = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '1.00';
    return n < 1 ? n.toFixed(3) : n.toFixed(2);
  };
  if ($('span-lon')) $('span-lon').value = fmtSpan(spec.span.lonDeg);
  if ($('span-lat')) $('span-lat').value = fmtSpan(spec.span.latDeg);

  // Themes & Colors
  document.querySelectorAll('.theme-swatch-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeId === spec.theme);
  });

  const themeColors = COLOR_THEMES[spec.theme] || COLOR_THEMES.dusty_prime;
  let allPaletteOff = true;
  for (const field of PALETTE_COLOR_FIELDS) {
    const rawVal = spec.colors?.[field.key];
    const norm = typeof rawVal === 'string' ? rawVal.trim().toLowerCase() : '';
    const isNone = !norm || norm === 'none' || norm === 'transparent';
    if (!isNone) allPaletteOff = false;

    const inputEl = $(field.inputId);
    const btnEl = $(field.noneBtnId);
    if (inputEl) {
      const themeFallback = safeHexColor(themeColors?.[field.key], field.fallback);
      inputEl.value = isNone ? themeFallback : safeHexColor(rawVal, themeFallback);
      const fieldLabel = inputEl.closest('.color-field');
      if (fieldLabel) fieldLabel.classList.toggle('is-none', isNone);
    }
    if (btnEl) {
      btnEl.classList.toggle('active', isNone);
      btnEl.setAttribute('aria-pressed', String(isNone));
    }
  }

  const allOffBtn = $('btn-palette-all-off');
  if (allOffBtn) {
    allOffBtn.classList.toggle('active', allPaletteOff);
    allOffBtn.setAttribute('aria-pressed', String(allPaletteOff));
  }

  const waterNorm = typeof spec.colors?.water === 'string' ? spec.colors.water.trim().toLowerCase() : '';
  const waterIsNone = waterNorm === 'none' || waterNorm === 'transparent';
  $('map-canvas')?.classList.toggle('transparent-bg', waterIsNone);

  // Layers
  if ($('layer-show-land')) $('layer-show-land').checked = spec.layers.showLand !== false;
  if ($('layer-show-borders')) $('layer-show-borders').checked = Boolean(spec.layers.showBorders);
  const landBanner = $('primary-land-status');
  const landBannerText = $('primary-land-status-text');
  if (landBanner) {
    const primaryLandLayers = (spec.customGeoJsonLayers || []).filter(
      (l) => l && l.visible !== false && l.role === 'land',
    );
    const defaultUnshaded = spec.layers.showLand === false;
    landBanner.hidden = !defaultUnshaded && primaryLandLayers.length === 0;
    if (landBannerText) {
      if (primaryLandLayers.length > 0 && defaultUnshaded) {
        landBannerText.textContent = `Primary Land: ${primaryLandLayers.map((l) => l.label).join(', ')} (default land unshaded)`;
      } else if (defaultUnshaded) {
        landBannerText.textContent = 'Default land layers are unshaded';
      } else if (primaryLandLayers.length > 0) {
        landBannerText.textContent = `Primary Land active (${primaryLandLayers.length})`;
      }
    }
  }

  // On-Demand OSM HD Coastlines live span, color sync & active status
  const hdSpanEl = $('hd-coastline-view-span');
  const hdColorModeEl = $('hd-coastline-color-mode');
  const hdColorEl = $('hd-coastline-color');
  const hdStatusEl = $('hd-coastline-status');
  const hdStatusText = $('hd-coastline-status-text');
  const hdBBox = computePaddedCoastlineBBox(spec);
  if (hdSpanEl) {
    const lonStr = hdBBox.rawSpanLon < 1 ? hdBBox.rawSpanLon.toFixed(2) : hdBBox.rawSpanLon.toFixed(1);
    const latStr = hdBBox.rawSpanLat < 1 ? hdBBox.rawSpanLat.toFixed(2) : hdBBox.rawSpanLat.toFixed(1);
    if (hdBBox.tooWide) {
      hdSpanEl.textContent = `View: ${lonStr}° × ${latStr}° · Zoom in ≤ ${OSM_COASTLINE_MAX_SPAN_DEG}°`;
      hdSpanEl.classList.remove('is-ready');
      hdSpanEl.classList.add('is-too-wide');
    } else {
      hdSpanEl.textContent = `View: ${lonStr}° × ${latStr}° · Ready for HD`;
      hdSpanEl.classList.add('is-ready');
      hdSpanEl.classList.remove('is-too-wide');
    }
  }
  if (hdColorModeEl) {
    const mode = uiState.hdCoastlineColorMode || 'host';
    hdColorModeEl.value = mode;
    const hostOpt = hdColorModeEl.querySelector('option[value="host"]');
    if (hostOpt) {
      hostOpt.textContent = uiState.hdHostCountryName
        ? `Sync Host (${uiState.hdHostCountryName})`
        : 'Sync Host Country';
    }
  }
  if (hdColorEl && typeof uiState.hdCoastlineColor === 'string' && /^#[0-9a-f]{6}$/i.test(uiState.hdCoastlineColor)) {
    hdColorEl.value = uiState.hdCoastlineColor;
  }
  if (hdStatusEl) {
    const activeHdLayer = (spec.customGeoJsonLayers || []).find(
      (l) => l && l.visible !== false && (String(l.id || '').startsWith('osm_hd_coastline') || isOsmCoastlineUrl(l.url)),
    );
    if (!activeHdLayer) {
      hdStatusEl.hidden = true;
      hdStatusEl.classList.remove('is-stale');
    } else {
      hdStatusEl.hidden = false;
      const parsedBBox = parseOsmCoastlineUrl(activeHdLayer.url);
      const currentViewBounds = [
        hdBBox.centerLon - hdBBox.rawSpanLon / 2,
        hdBBox.centerLon + hdBBox.rawSpanLon / 2,
        hdBBox.centerLat - hdBBox.rawSpanLat / 2,
        hdBBox.centerLat + hdBBox.rawSpanLat / 2,
      ];
      const isStale = parsedBBox ? isViewOutsideCoastlineBBox(currentViewBounds, parsedBBox) : false;
      hdStatusEl.classList.toggle('is-stale', isStale);
      if (hdStatusText) {
        const polyCount = Array.isArray(activeHdLayer.data?.features) ? activeHdLayer.data.features.length : 0;
        hdStatusText.textContent = isStale
          ? 'View moved outside HD bounds — refresh for current area'
          : `OSM HD active (${polyCount} shoreline shape${polyCount === 1 ? '' : 's'})`;
      }
    }
  }
  if ($('layer-border-width')) $('layer-border-width').value = String(spec.layers.borderWidth);
  if ($('layer-border-width-val')) $('layer-border-width-val').textContent = Number(spec.layers.borderWidth).toFixed(1);
  if ($('layer-border-style')) $('layer-border-style').value = spec.layers.borderStyle;

  if ($('layer-show-minor-islands')) $('layer-show-minor-islands').checked = spec.layers.showMinorIslands !== false;
  if ($('layer-show-lakes')) $('layer-show-lakes').checked = Boolean(spec.layers.showLakes);
  if ($('layer-show-bathymetry')) $('layer-show-bathymetry').checked = Boolean(spec.layers.showBathymetry);
  if ($('layer-show-urban')) $('layer-show-urban').checked = Boolean(spec.layers.showUrbanAreas);
  if ($('layer-show-rivers')) $('layer-show-rivers').checked = Boolean(spec.layers.showRivers);
  if ($('layer-river-width')) $('layer-river-width').value = String(spec.layers.riverWidth);
  if ($('layer-river-width-val')) $('layer-river-width-val').textContent = Number(spec.layers.riverWidth).toFixed(1);

  if ($('layer-show-admin1')) $('layer-show-admin1').checked = Boolean(spec.layers.showAdmin1);
  if ($('layer-admin1-scale')) $('layer-admin1-scale').value = spec.layers.admin1Scale || 'auto';
  if ($('layer-admin1-width')) $('layer-admin1-width').value = String(spec.layers.admin1Width ?? 0.7);
  if ($('layer-admin1-width-val')) {
    $('layer-admin1-width-val').textContent = Number(spec.layers.admin1Width ?? 0.7).toFixed(1);
  }
  if ($('layer-show-coastlines')) $('layer-show-coastlines').checked = Boolean(spec.layers.showCoastlines);
  if ($('layer-coastline-width')) $('layer-coastline-width').value = String(spec.layers.coastlineWidth);
  if ($('layer-coastline-width-val')) $('layer-coastline-width-val').textContent = Number(spec.layers.coastlineWidth).toFixed(1);

  if ($('layer-show-graticule')) $('layer-show-graticule').checked = Boolean(spec.layers.showGraticule);
  if ($('layer-graticule-step')) {
    const stepSelect = $('layer-graticule-step');
    const stepStr = String(spec.layers.graticuleStepDeg);
    if (!Array.from(stepSelect.options).some((o) => o.value === stepStr)) {
      const opt = document.createElement('option');
      opt.value = stepStr;
      opt.textContent = `${stepStr}°`;
      stepSelect.appendChild(opt);
    }
    stepSelect.value = stepStr;
  }
  if ($('page-show-frame')) $('page-show-frame').checked = Boolean(spec.page.showFrameBorder);

  // Cities & Pins global size scales
  const cityLabelScale = Number.isFinite(Number(spec.layers?.cityLabelScale))
    ? Number(spec.layers.cityLabelScale)
    : 1.0;
  if ($('city-label-scale')) $('city-label-scale').value = String(cityLabelScale);
  if ($('city-label-scale-val')) $('city-label-scale-val').textContent = `${cityLabelScale.toFixed(1)}×`;

  const cityIconScale = Number.isFinite(Number(spec.layers?.cityIconScale))
    ? Number(spec.layers.cityIconScale)
    : 1.0;
  if ($('city-icon-scale')) $('city-icon-scale').value = String(cityIconScale);
  if ($('city-icon-scale-val')) $('city-icon-scale-val').textContent = `${cityIconScale.toFixed(1)}×`;

  // Title & Ornaments
  if ($('show-title')) $('show-title').checked = Boolean(spec.showTitle);
  if ($('map-title')) $('map-title').value = spec.title || '';

  const { scaleBar, locatorGlobe, northArrow, legend } = spec.ornaments;
  if ($('orn-scale-enabled')) $('orn-scale-enabled').checked = Boolean(scaleBar.enabled);
  if ($('orn-scale-units')) $('orn-scale-units').value = scaleBar.units;
  if ($('orn-scale-pos')) $('orn-scale-pos').value = scaleBar.position;

  if ($('orn-globe-enabled')) $('orn-globe-enabled').checked = Boolean(locatorGlobe.enabled);
  if ($('orn-globe-pos')) $('orn-globe-pos').value = locatorGlobe.position;
  if ($('orn-globe-size')) $('orn-globe-size').value = String(locatorGlobe.sizePct);
  if ($('orn-globe-size-val')) $('orn-globe-size-val').textContent = `${Math.round(locatorGlobe.sizePct)}%`;
  const globeZoomMode = spec.ornaments?.locatorGlobe?.zoomMode || 'auto';
  const effectiveZoom = resolveLocatorGlobeZoom(spec);
  if ($('orn-globe-zoom-mode')) $('orn-globe-zoom-mode').value = globeZoomMode;
  if ($('orn-globe-zoom')) $('orn-globe-zoom').value = effectiveZoom.toFixed(1);
  if ($('orn-globe-zoom-val')) {
    if (globeZoomMode === 'auto') {
      $('orn-globe-zoom-val').textContent = `Auto (${effectiveZoom.toFixed(1)}×)`;
    } else if (globeZoomMode === 'nearside') {
      $('orn-globe-zoom-val').textContent = '1.8× (3,578 km)';
    } else if (globeZoomMode === 'hemisphere') {
      $('orn-globe-zoom-val').textContent = '1.0×';
    } else {
      $('orn-globe-zoom-val').textContent = `${Number(spec.ornaments?.locatorGlobe?.zoom || effectiveZoom).toFixed(1)}×`;
    }
  }
  if ($('orn-globe-box')) $('orn-globe-box').checked = Boolean(locatorGlobe.showExtentBox);

  if ($('orn-north-enabled')) $('orn-north-enabled').checked = Boolean(northArrow.enabled);
  if ($('orn-north-pos')) $('orn-north-pos').value = northArrow.position;
  if ($('orn-legend-enabled')) $('orn-legend-enabled').checked = Boolean(legend.enabled);
  if ($('orn-legend-pos')) $('orn-legend-pos').value = legend.position;

  // Pro options
  if ($('pro-coastline-engine')) $('pro-coastline-engine').value = spec.pro?.coastlineEngine || 'auto';
  if ($('pro-basemap')) $('pro-basemap').value = spec.pro?.basemapProvider || 'none';
  if ($('pro-basemap-opacity')) $('pro-basemap-opacity').value = String(spec.pro?.basemapOpacity ?? 0.85);
  if ($('pro-basemap-opacity-val')) {
    $('pro-basemap-opacity-val').textContent = `${Math.round((spec.pro?.basemapOpacity ?? 0.85) * 100)}%`;
  }

  // Interaction mode & Reference peek pills
  const countryModeBtn = $('btn-mode-country');
  const pinModeBtn = $('btn-mode-pin');
  const shadowModeBtn = $('btn-mode-shadow');
  if (countryModeBtn) {
    countryModeBtn.classList.toggle('active', mode === 'country');
    countryModeBtn.setAttribute('aria-pressed', String(mode === 'country'));
  }
  if (pinModeBtn) {
    pinModeBtn.classList.toggle('active', mode === 'pin');
    pinModeBtn.setAttribute('aria-pressed', String(mode === 'pin'));
  }
  if (shadowModeBtn) {
    shadowModeBtn.classList.toggle('active', mode === 'shadow');
    shadowModeBtn.setAttribute('aria-pressed', String(mode === 'shadow'));
  }

  const modeBadge = $('interaction-mode-badge');
  const modeText = $('interaction-mode-text');
  const exitBtn = $('btn-exit-mode');
  const canvas = $('map-canvas');
  if (modeBadge && modeText) {
    modeBadge.className = `stage-pill mode-${mode}`;
    if (mode === 'country') {
      modeText.textContent = 'Mode: Click Map to Highlight Country';
    } else if (mode === 'pin') {
      modeText.textContent = 'Mode: Click Map to Drop Pin';
    } else if (mode === 'shadow') {
      modeText.textContent = 'Mode: Drag Shadow on Map to Compare';
    } else {
      modeText.textContent = 'Mode: Pan & Zoom';
    }
  }
  if (exitBtn) exitBtn.hidden = mode === 'pan';
  if (canvas) {
    canvas.classList.toggle('mode-crosshair', mode === 'country' || mode === 'pin');
    canvas.classList.toggle('mode-move', mode === 'shadow');
  }

  const peekBtn = $('btn-ref-peek');
  if (peekBtn) {
    peekBtn.classList.toggle('active', Boolean(refPeek));
    peekBtn.setAttribute('aria-pressed', String(Boolean(refPeek)));
  }

  // Historical tab master sliders (reflect average of active layers when present)
  const overlays = spec.customGeoJsonLayers || [];
  const akIds = new Set(ALASKA_AIRFIELDS_ALL_LAYER_DEFS.map((d) => d.id));
  const activeAk = overlays.filter((l) => l?.id && akIds.has(l.id) && l.visible !== false);
  const akAvg = activeAk.length
    ? activeAk.reduce((s, l) => s + (Number(l.strokeWidth) || 1.5), 0) / activeAk.length
    : 1.5;
  if ($('alaska-airfield-master-size')) $('alaska-airfield-master-size').value = akAvg.toFixed(1);
  if ($('alaska-airfield-master-size-val')) $('alaska-airfield-master-size-val').textContent = akAvg.toFixed(1);

  const airIds = new Set(AIRFIELD_1941_LAYERS.map((d) => d.id));
  const activeAir = overlays.filter((l) => l?.id && airIds.has(l.id) && l.visible !== false);
  const airAvg = activeAir.length
    ? activeAir.reduce((s, l) => s + (Number(l.strokeWidth) || 1.5), 0) / activeAir.length
    : 1.5;
  if ($('airfield-master-size')) $('airfield-master-size').value = airAvg.toFixed(1);
  if ($('airfield-master-size-val')) $('airfield-master-size-val').textContent = airAvg.toFixed(1);

  const railLineIds = new Set(
    PHILIPPINES_RAIL_1942_LAYERS.filter((d) => d.geometryKind === 'line').map((d) => d.id),
  );
  const activeRailLines = overlays.filter((l) => l?.id && railLineIds.has(l.id) && l.visible !== false);
  const railAvg = activeRailLines.length
    ? activeRailLines.reduce((s, l) => s + (Number(l.strokeWidth) || 1.6), 0) / activeRailLines.length
    : 1.6;
  if ($('ph-rail-master-width')) $('ph-rail-master-width').value = railAvg.toFixed(1);
  if ($('ph-rail-master-width-val')) $('ph-rail-master-width-val').textContent = railAvg.toFixed(1);

  // Dynamic lists (skip rebuild mid-slider/picker drag to preserve native input capture)
  if (!skipDynamicLists) {
    renderRegionShadowsList(spec, boundCallbacks, shadowMetrics);
    renderCountryHighlightsList(spec, boundCallbacks);
    renderCitiesList(spec, boundCallbacks);
    renderGeoJsonLayersList(spec, boundCallbacks);
    renderHistoricalTabLists(spec, boundCallbacks, uiState.alaskaYear || 1943);
  }
}
