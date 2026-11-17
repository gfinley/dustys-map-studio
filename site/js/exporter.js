/**
 * High-DPI raster/SVG browser exporter (with binary pHYs / JFIF DPI metadata)
 * and optional Python Cartopy Pro backend client.
 */

import { getPixelDimensions, sanitizeFilename } from './schema.js?v=4';
import { renderMapToCanvas, renderMapToSvgString } from './cartography.js?v=4';
import { injectPngDpi, injectJpegDpi } from './dpi-metadata.js?v=4';
import { ensureDatasets, resolveResolution } from './data-loader.js?v=4';

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error(`Canvas failed to encode ${mime}.`));
        }
      },
      mime,
      quality,
    );
  });
}

async function resolveExportDatasets(spec, datasets) {
  const neededRes = resolveResolution(spec);
  const needLakes = spec?.layers?.showLakes !== false;
  const needRivers = Boolean(spec?.layers?.showRivers);
  const needAdmin1 = Boolean(spec?.layers?.showAdmin1);

  const hasAllRequired =
    datasets &&
    datasets.resolution === neededRes &&
    datasets.land &&
    datasets.countries &&
    datasets.internalBorders &&
    datasets.locatorLand &&
    (!needLakes || datasets.lakes) &&
    (!needRivers || datasets.rivers) &&
    (!needAdmin1 || datasets.admin1);

  if (hasAllRequired) {
    return datasets;
  }

  return ensureDatasets(neededRes, {
    needLakes,
    needRivers,
    needAdmin1,
    needPlaces: false,
  });
}

function parseContentDispositionFilename(headerValue, fallback) {
  if (!headerValue || typeof headerValue !== 'string') return fallback;

  const utf8Match = headerValue.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      const decoded = decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ''));
      const clean = decoded.split(/[\\/]/).pop();
      if (clean) return clean;
    } catch {
      // Fall back to standard filename attribute
    }
  }

  const plainMatch = headerValue.match(/filename\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  const raw = plainMatch && (plainMatch[1] || plainMatch[2] || plainMatch[3]);
  if (raw) {
    const clean = raw.trim().split(/[\\/]/).pop();
    if (clean) return clean;
  }

  return fallback;
}

async function readErrorMessage(res) {
  const fallback = `Request failed (${res.status} ${res.statusText})`;
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.detail === 'string') return parsed.detail;
      if (parsed?.detail) return JSON.stringify(parsed.detail);
      if (typeof parsed?.error === 'string') return parsed.error;
    } catch {
      // Non-JSON error body
    }
    return text.slice(0, 300);
  } catch {
    return fallback;
  }
}

export async function exportBrowserRaster(spec, datasets, format = 'png', options = {}) {
  const normalizedFmt = String(format || 'png').toLowerCase();
  const isJpeg = normalizedFmt === 'jpeg' || normalizedFmt === 'jpg';
  const mime = isJpeg ? 'image/jpeg' : 'image/png';
  const ext = isJpeg ? 'jpg' : 'png';

  const { widthPx, heightPx, dpi } = getPixelDimensions(spec?.page);
  const exportDatasets = await resolveExportDatasets(spec, datasets);

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;

  renderMapToCanvas(canvas, spec, exportDatasets, {
    width: widthPx,
    height: heightPx,
  });

  const rawBlob = await canvasToBlob(canvas, mime, isJpeg ? 0.95 : undefined);
  const rawBytes = new Uint8Array(await rawBlob.arrayBuffer());
  const injectedBytes = isJpeg ? injectJpegDpi(rawBytes, dpi) : injectPngDpi(rawBytes, dpi);
  const finalBlob = new Blob([injectedBytes], { type: mime });

  const base = sanitizeFilename(spec?.title, 'dusty_map');
  const suffix = options?.filenameSuffix ? `_${sanitizeFilename(options.filenameSuffix, '')}` : '';
  const filename = `${base}${suffix}_${dpi}dpi.${ext}`;
  triggerDownload(finalBlob, filename);

  return {
    filename,
    widthPx,
    heightPx,
    dpi,
    byteLength: injectedBytes.byteLength,
  };
}

export async function exportBrowserPairWithWithoutBorders(spec, datasets, format = 'png') {
  const exportDatasets = await resolveExportDatasets(spec, datasets);

  const specWithBorders = {
    ...spec,
    layers: {
      ...(spec?.layers || {}),
      showBorders: true,
    },
  };
  const specWithoutBorders = {
    ...spec,
    layers: {
      ...(spec?.layers || {}),
      showBorders: false,
    },
  };

  const first = await exportBrowserRaster(specWithBorders, exportDatasets, format, {
    filenameSuffix: 'with_borders',
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = await exportBrowserRaster(specWithoutBorders, exportDatasets, format, {
    filenameSuffix: 'no_borders',
  });

  return [first, second];
}

export async function exportBrowserSvg(spec, datasets) {
  const exportDatasets = await resolveExportDatasets(spec, datasets);
  const svgString = renderMapToSvgString(spec, exportDatasets);
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const base = sanitizeFilename(spec?.title, 'dusty_map');
  const filename = `${base}.svg`;
  triggerDownload(blob, filename);

  return {
    filename,
    byteLength: blob.size,
  };
}

export async function checkPythonProHealth(timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 1500));
  try {
    const res = await fetch('./api/health', {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const data = await res.json();
    return {
      ok: Boolean(data?.ok ?? true),
      ...data,
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function renderViaPythonPro(spec, format = 'png') {
  const fmt = String(format || 'png').toLowerCase() === 'jpg' ? 'jpeg' : String(format || 'png').toLowerCase();
  const res = await fetch(`./api/render?format=${encodeURIComponent(fmt)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }

  const blob = await res.blob();
  const base = sanitizeFilename(spec?.title, 'dusty_map');
  const dpi = Math.round(Number(spec?.page?.dpi) || 300);
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const fallbackName = fmt === 'pdf' || fmt === 'svg' ? `${base}.${ext}` : `${base}_${dpi}dpi.${ext}`;
  const filename = parseContentDispositionFilename(res.headers.get('Content-Disposition'), fallbackName);

  triggerDownload(blob, filename);
  return { filename, byteLength: blob.size };
}

export async function renderBatchViaPythonPro(batchReq) {
  const res = await fetch('./api/render-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchReq),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }

  const blob = await res.blob();
  const filename = parseContentDispositionFilename(
    res.headers.get('Content-Disposition'),
    'dusty_maps_batch.zip',
  );
  triggerDownload(blob, filename);
  return { filename, byteLength: blob.size };
}

export async function inspectGeoJsonViaPythonPro(payload) {
  const body = {
    url: payload?.url ?? null,
    data: payload?.data ?? null,
  };
  const res = await fetch('./api/geojson-inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return res.json();
}
