import {
  COLOR_THEMES,
  HATCH_STYLES,
  PAGE_PRESETS,
  PIN_STYLES,
  PROJECTIONS,
  PROJECTION_LABELS,
  getPixelDimensions,
} from './schema.js';
import { GEOJSON_EXAMPLES, REGION_PRESETS } from './presets.js';

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
    card.append(top, ctrls);
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

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-danger-ghost';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => callbacks.onRemoveGeoJsonLayer?.(idx));

    top.append(visLabel, removeBtn);

    const ctrls = document.createElement('div');
    ctrls.className = 'list-card-controls';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.title = 'Overlay color';
    colorInput.value = safeHexColor(layer.color, '#222222');
    colorInput.addEventListener('input', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(idx, { color: e.target.value }, { commitHistory: false, skipDynamicLists: true });
    });
    colorInput.addEventListener('change', (e) => {
      callbacks.onUpdateGeoJsonLayer?.(idx, { color: e.target.value }, { commitHistory: true });
    });

    const opacityRange = document.createElement('input');
    opacityRange.type = 'range';
    opacityRange.min = '0';
    opacityRange.max = '1';
    opacityRange.step = '0.05';
    opacityRange.style.width = '78px';
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

    ctrls.append(colorInput, opacityRange, opacityVal, dashedLabel, hatchSelect);
    card.append(top, ctrls);
    listEl.appendChild(card);
  });
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
        callbacks.onLoadGeoJsonUrl?.(ex.url, ex.label);
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
  const bindColor = (id, key) => {
    $(id)?.addEventListener('input', (e) => {
      boundCallbacks.onPatchSpec?.({ colors: { [key]: e.target.value } }, { commitHistory: false });
    });
    $(id)?.addEventListener('change', (e) => {
      boundCallbacks.onPatchSpec?.({ colors: { [key]: e.target.value } }, { commitHistory: true });
    });
  };
  bindColor('color-land', 'land');
  bindColor('color-water', 'water');
  bindColor('color-borders', 'borders');
  bindColor('color-rivers', 'rivers');
  bindColor('color-text', 'text');

  $('color-coastline')?.addEventListener('input', (e) => {
    boundCallbacks.onPatchSpec?.(
      { colors: { coastline: e.target.value }, layers: { showCoastlines: true } },
      { commitHistory: false },
    );
  });
  $('color-coastline')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.(
      { colors: { coastline: e.target.value }, layers: { showCoastlines: true } },
      { commitHistory: true },
    );
  });
  $('btn-coastline-none')?.addEventListener('click', () => {
    boundCallbacks.onToggleCoastlineNone?.();
  });

  const bindCheck = (id, fn) => {
    $(id)?.addEventListener('change', (e) => fn(e.target.checked));
  };
  bindCheck('layer-show-borders', (v) => boundCallbacks.onPatchSpec?.({ layers: { showBorders: v } }));
  bindCheck('layer-show-lakes', (v) => boundCallbacks.onPatchSpec?.({ layers: { showLakes: v } }));
  bindCheck('layer-show-rivers', (v) => boundCallbacks.onPatchSpec?.({ layers: { showRivers: v } }));
  bindCheck('layer-show-admin1', (v) => boundCallbacks.onPatchSpec?.({ layers: { showAdmin1: v } }));
  bindCheck('layer-show-coastlines', (v) => boundCallbacks.onPatchSpec?.({ layers: { showCoastlines: v } }));
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

  $('layer-border-style')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ layers: { borderStyle: e.target.value } });
  });
  $('layer-graticule-step')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ layers: { graticuleStepDeg: Number(e.target.value) || 10 } });
  });

  // Tab 3: Countries, Pins & GeoJSON
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
  bindCheck('orn-globe-box', (v) => boundCallbacks.onPatchSpec?.({ ornaments: { locatorGlobe: { showExtentBox: v } } }));

  bindCheck('orn-north-enabled', (v) => boundCallbacks.onPatchSpec?.({ ornaments: { northArrow: { enabled: v } } }));
  $('orn-north-pos')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { northArrow: { position: e.target.value } } });
  });
  bindCheck('orn-legend-enabled', (v) => boundCallbacks.onPatchSpec?.({ ornaments: { legend: { enabled: v } } }));
  $('orn-legend-pos')?.addEventListener('change', (e) => {
    boundCallbacks.onPatchSpec?.({ ornaments: { legend: { position: e.target.value } } });
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
  if ($('span-lon')) $('span-lon').value = Number(spec.span.lonDeg).toFixed(2);
  if ($('span-lat')) $('span-lat').value = Number(spec.span.latDeg).toFixed(2);

  // Themes & Colors
  document.querySelectorAll('.theme-swatch-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeId === spec.theme);
  });

  if ($('color-land')) $('color-land').value = safeHexColor(spec.colors.land, '#4a4a4a');
  if ($('color-water')) $('color-water').value = safeHexColor(spec.colors.water, '#d1cfcf');
  if ($('color-borders')) $('color-borders').value = safeHexColor(spec.colors.borders, '#ffffff');
  const coastIsNone = !spec.colors.coastline || spec.colors.coastline === 'none';
  if ($('color-coastline')) {
    $('color-coastline').value = coastIsNone ? '#111111' : safeHexColor(spec.colors.coastline, '#111111');
  }
  if ($('btn-coastline-none')) {
    $('btn-coastline-none').classList.toggle('active', coastIsNone);
  }
  if ($('color-rivers')) $('color-rivers').value = safeHexColor(spec.colors.rivers, '#73a9ca');
  if ($('color-text')) $('color-text').value = safeHexColor(spec.colors.text, '#111111');

  // Layers
  if ($('layer-show-borders')) $('layer-show-borders').checked = Boolean(spec.layers.showBorders);
  if ($('layer-border-width')) $('layer-border-width').value = String(spec.layers.borderWidth);
  if ($('layer-border-width-val')) $('layer-border-width-val').textContent = Number(spec.layers.borderWidth).toFixed(1);
  if ($('layer-border-style')) $('layer-border-style').value = spec.layers.borderStyle;

  if ($('layer-show-lakes')) $('layer-show-lakes').checked = Boolean(spec.layers.showLakes);
  if ($('layer-show-rivers')) $('layer-show-rivers').checked = Boolean(spec.layers.showRivers);
  if ($('layer-river-width')) $('layer-river-width').value = String(spec.layers.riverWidth);
  if ($('layer-river-width-val')) $('layer-river-width-val').textContent = Number(spec.layers.riverWidth).toFixed(1);

  if ($('layer-show-admin1')) $('layer-show-admin1').checked = Boolean(spec.layers.showAdmin1);
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
  if ($('orn-globe-box')) $('orn-globe-box').checked = Boolean(locatorGlobe.showExtentBox);

  if ($('orn-north-enabled')) $('orn-north-enabled').checked = Boolean(northArrow.enabled);
  if ($('orn-north-pos')) $('orn-north-pos').value = northArrow.position;
  if ($('orn-legend-enabled')) $('orn-legend-enabled').checked = Boolean(legend.enabled);
  if ($('orn-legend-pos')) $('orn-legend-pos').value = legend.position;

  // Pro options
  if ($('pro-basemap')) $('pro-basemap').value = spec.pro?.basemapProvider || 'none';
  if ($('pro-basemap-opacity')) $('pro-basemap-opacity').value = String(spec.pro?.basemapOpacity ?? 0.85);
  if ($('pro-basemap-opacity-val')) {
    $('pro-basemap-opacity-val').textContent = `${Math.round((spec.pro?.basemapOpacity ?? 0.85) * 100)}%`;
  }

  // Interaction mode & Reference peek pills
  const countryModeBtn = $('btn-mode-country');
  const pinModeBtn = $('btn-mode-pin');
  if (countryModeBtn) {
    countryModeBtn.classList.toggle('active', mode === 'country');
    countryModeBtn.setAttribute('aria-pressed', String(mode === 'country'));
  }
  if (pinModeBtn) {
    pinModeBtn.classList.toggle('active', mode === 'pin');
    pinModeBtn.setAttribute('aria-pressed', String(mode === 'pin'));
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
    } else {
      modeText.textContent = 'Mode: Pan & Zoom';
    }
  }
  if (exitBtn) exitBtn.hidden = mode === 'pan';
  if (canvas) canvas.classList.toggle('mode-crosshair', mode !== 'pan');

  const peekBtn = $('btn-ref-peek');
  if (peekBtn) {
    peekBtn.classList.toggle('active', Boolean(refPeek));
    peekBtn.setAttribute('aria-pressed', String(Boolean(refPeek)));
  }

  // Dynamic lists (skip rebuild mid-slider/picker drag to preserve native input capture)
  if (!skipDynamicLists) {
    renderCountryHighlightsList(spec, boundCallbacks);
    renderCitiesList(spec, boundCallbacks);
    renderGeoJsonLayersList(spec, boundCallbacks);
  }
}
