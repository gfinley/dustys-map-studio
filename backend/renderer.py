"""Thread-safe Cartopy + GeoPandas map rendering engine for Dusty's Map Studio."""

from __future__ import annotations

import io
import json
import logging
import math
import re
import threading
from typing import Any

import matplotlib

matplotlib.use("Agg")

from matplotlib import patheffects
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.backends.backend_pdf import FigureCanvasPdf
from matplotlib.backends.backend_svg import FigureCanvasSVG
from matplotlib.colors import is_color_like, to_rgba
from matplotlib.figure import Figure
from matplotlib.lines import Line2D
from matplotlib.patches import FancyBboxPatch, Patch, Polygon as MplPolygon, Rectangle
import matplotlib.ticker as mticker
from matplotlib.transforms import offset_copy

import cartopy.crs as ccrs
import cartopy.feature as cfeature
import cartopy.io.shapereader as shpreader
import contextily as cx
import geopandas as gpd
import numpy as np
from PIL import Image
import pyproj
import requests
from shapely import clip_by_rect
from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPoint,
    MultiPolygon,
    Point,
    Polygon,
)
from shapely.ops import unary_union

from backend.schemas import CustomGeoJsonLayer, HighlightedCountry, MapSpec, RegionShadow

logger = logging.getLogger(__name__)

_NE_LOCK = threading.RLock()
_WARMED_NE_FEATURES: set[tuple[str, str, str]] = set()
_COUNTRIES_CACHE: dict[str, tuple[tuple[Any, dict[str, str]], ...]] = {}
_ADMIN1_POLYGONS_CACHE: tuple[tuple[Any, dict[str, str]], ...] | None = None
_GSHHS_CACHE: dict[tuple[str, int], tuple[tuple[Any, tuple[float, float, float, float]], ...]] = {}
_NE_GEOM_BBOX_CACHE: dict[
    tuple[str, str, str], tuple[tuple[Any, tuple[float, float, float, float]], ...]
] = {}

_EARTH_RADIUS_M = 6_370_997.0
_SQ_KM_PER_SQ_MI = 2.589988110336
_SCALE_FALLBACK_ORDER: dict[str, tuple[str, ...]] = {
    "ultra": ("10m", "50m", "110m"),
    "10m": ("10m", "50m", "110m"),
    "50m": ("50m", "110m", "10m"),
    "110m": ("110m", "50m", "10m"),
}
_HATCH_MAP: dict[str, str | None] = {
    "none": None,
    "diagonal": "///",
    "backdiagonal": "\\\\\\",
    "cross": "xxx",
    "dots": "...",
}
_BORDER_STYLE_MAP: dict[str, str] = {
    "solid": "-",
    "dashed": "--",
    "dotted": ":",
}
_GEOJSON_TYPES = {
    "FeatureCollection",
    "Feature",
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
}
_NICE_SCALE_STEPS = (
    1,
    2,
    5,
    10,
    20,
    25,
    50,
    100,
    200,
    250,
    500,
    1000,
    2000,
    5000,
    10000,
)
_GEOD = pyproj.Geod(ellps="WGS84")


def sanitize_filename(name: str | None, fallback: str = "dusty_map") -> str:
    """Return an ASCII-safe filename stem matching site/js/schema.js."""
    cleaned = re.sub(r"[^a-zA-Z0-9_\- ]+", "", str(name or "").strip())
    cleaned = re.sub(r"\s+", "_", cleaned).strip("_")
    return cleaned or fallback


def resolve_scale(spec: MapSpec) -> str:
    """Resolve dataset scale ('ultra', '10m', '50m', or '110m') from MapSpec."""
    if spec.detailLevel in ("ultra", "10m", "50m", "110m"):
        return spec.detailLevel
    max_span = max(spec.span.lonDeg, spec.span.latDeg)
    if max_span <= 5.0 and spec.projection != "orthographic":
        return "ultra"
    if max_span <= 16.0 and spec.projection != "orthographic":
        return "10m"
    if max_span <= 90.0:
        return "50m"
    return "110m"


def _ne_scale_for(scale: str) -> str:
    """Map logical detail scale to a valid Natural Earth scale ('10m', '50m', '110m')."""
    return "10m" if scale == "ultra" else scale


def resolve_admin1_scale(spec: MapSpec) -> str:
    """Resolve Natural Earth Admin-1 dataset scale ('10m' or '50m') from MapSpec."""
    if spec.layers.admin1Scale in ("10m", "50m"):
        return spec.layers.admin1Scale
    max_span = max(spec.span.lonDeg, spec.span.latDeg)
    return "10m" if max_span <= 35.0 else "50m"


def _valid_color(value: str | None, fallback: str) -> str:
    """Return value when it is a valid non-none Matplotlib color, else fallback."""
    if not value:
        return fallback
    cleaned = value.strip()
    if cleaned.lower() in ("none", "transparent", ""):
        return fallback
    return cleaned if is_color_like(cleaned) else fallback


def _build_projection(spec: MapSpec) -> ccrs.Projection:
    """Instantiate the Cartopy CRS corresponding to spec.projection."""
    lon = spec.center.lon
    lat = spec.center.lat
    mapping: dict[str, ccrs.Projection] = {
        "mercator": ccrs.Mercator(central_longitude=lon),
        "equal_earth": ccrs.EqualEarth(central_longitude=lon),
        "orthographic": ccrs.Orthographic(central_longitude=lon, central_latitude=lat),
        "albers": ccrs.AlbersEqualArea(central_longitude=lon, central_latitude=lat),
        "azimuthal_equidistant": ccrs.AzimuthalEquidistant(
            central_longitude=lon, central_latitude=lat
        ),
        "robinson": ccrs.Robinson(central_longitude=lon),
    }
    return mapping.get(spec.projection, ccrs.Mercator(central_longitude=lon))


def _configure_extent(
    ax: Any, spec: MapSpec, proj: ccrs.Projection
) -> tuple[float, float, float, float]:
    """Set projected axis limits with anti-meridian safety and page aspect fill."""
    max_span = max(spec.span.lonDeg, spec.span.latDeg)
    if spec.projection == "orthographic":
        if max_span >= 85.0:
            ax.set_global()
        else:
            radius = abs(proj.x_limits[1]) or _EARTH_RADIUS_M
            half_extent = radius * min(0.98, max(0.015, max_span / 90.0))
            ax.set_xlim(-half_extent, half_extent)
            ax.set_ylim(-half_extent, half_extent)
        xmin, xmax = ax.get_xlim()
        ymin, ymax = ax.get_ylim()
        return (xmin, xmax, ymin, ymax)

    geodetic = ccrs.PlateCarree()
    dlon = min(spec.span.lonDeg * 0.5, 179.5)
    dlat = spec.span.latDeg * 0.5
    lat_cap_min, lat_cap_max = (-80.0, 84.0) if spec.projection == "mercator" else (-89.5, 89.5)

    lat_min = max(lat_cap_min, spec.center.lat - dlat)
    lat_max = min(lat_cap_max, spec.center.lat + dlat)
    if lat_min >= lat_max:
        clamped_c = max(lat_cap_min + 0.5, min(lat_cap_max - 0.5, spec.center.lat))
        lat_min = max(lat_cap_min, clamped_c - 0.5)
        lat_max = min(lat_cap_max, clamped_c + 0.5)

    lon_fractions = (-1.0, -0.5, 0.0, 0.5, 1.0)
    lat_samples = (lat_min, 0.5 * (lat_min + lat_max), lat_max)
    xs: list[float] = []
    ys: list[float] = []
    for frac in lon_fractions:
        sample_lon = spec.center.lon + frac * dlon
        for sample_lat in lat_samples:
            px, py = proj.transform_point(sample_lon, sample_lat, geodetic)
            if math.isfinite(px) and math.isfinite(py):
                xs.append(px)
                ys.append(py)

    if len(xs) >= 2 and len(ys) >= 2:
        xmin, xmax = min(xs), max(xs)
        ymin, ymax = min(ys), max(ys)
    else:
        xmin, xmax = proj.x_limits
        ymin, ymax = proj.y_limits

    if spec.span.lonDeg >= 355.0 and spec.projection in ("mercator", "equal_earth", "robinson"):
        xmin, xmax = proj.x_limits

    x_span = max(xmax - xmin, 1000.0)
    y_span = max(ymax - ymin, 1000.0)
    x_mid = 0.5 * (xmin + xmax)
    y_mid = 0.5 * (ymin + ymax)
    fig_aspect = spec.page.widthIn / spec.page.heightIn

    if (x_span / y_span) < fig_aspect:
        x_span = y_span * fig_aspect
    else:
        y_span = x_span / fig_aspect

    xmin = x_mid - 0.5 * x_span
    xmax = x_mid + 0.5 * x_span
    ymin = y_mid - 0.5 * y_span
    ymax = y_mid + 0.5 * y_span
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)
    return (xmin, xmax, ymin, ymax)


def _resolve_basemap_provider(name: str) -> Any | None:
    """Map spec.pro.basemapProvider string to a Contextily TileProvider."""
    providers = {
        "CartoDB.VoyagerNoLabels": cx.providers.CartoDB.VoyagerNoLabels,
        "CartoDB.PositronNoLabels": cx.providers.CartoDB.PositronNoLabels,
        "CartoDB.DarkMatterNoLabels": cx.providers.CartoDB.DarkMatterNoLabels,
        "Esri.WorldShadedRelief": cx.providers.Esri.WorldShadedRelief,
        "Esri.WorldTerrain": cx.providers.Esri.WorldTerrain,
        "Esri.OceanBasemap": cx.providers.Esri.OceanBasemap,
        "Esri.WorldImagery": cx.providers.Esri.WorldImagery,
        "OpenTopoMap": cx.providers.OpenTopoMap,
    }
    return providers.get(name)


def _resolve_gshhs_scale(spec: MapSpec, resolved_scale: str) -> str | None:
    """Determine GSHHS scale ('h' ~200m or 'f' ~40m) when enabled, else None."""
    engine = spec.pro.coastlineEngine
    if engine == "natural_earth":
        return None
    if engine == "gshhs_full":
        return "f"
    if engine == "gshhs_high":
        return "h"
    # Auto: activate GSHHG high/full shorelines when in Ultra detail mode
    if resolved_scale == "ultra" and spec.projection != "orthographic":
        max_span = max(spec.span.lonDeg, spec.span.latDeg)
        return "f" if max_span <= 3.0 else "h"
    return None


def _load_gshhs_level(
    gshhs_scale: str, level: int
) -> tuple[tuple[Any, tuple[float, float, float, float]], ...]:
    """Load and cache NOAA/GMT GSHHS geometries with bounding boxes for fast viewport culling."""
    cache_key = (gshhs_scale, level)
    with _NE_LOCK:
        if cache_key in _GSHHS_CACHE:
            return _GSHHS_CACHE[cache_key]
        path = shpreader.gshhs(scale=gshhs_scale, level=level)
        reader = shpreader.Reader(path)
        items: list[tuple[Any, tuple[float, float, float, float]]] = []
        for geom in reader.geometries():
            if geom is None or geom.is_empty:
                continue
            items.append((geom, geom.bounds))
        frozen = tuple(items)
        _GSHHS_CACHE[cache_key] = frozen
        return frozen


def _bbox_intersects_view(
    geom_bounds: tuple[float, float, float, float],
    min_lon: float,
    max_lon: float,
    min_lat: float,
    max_lat: float,
) -> bool:
    """Fast O(1) geographic bbox intersection with antimeridian wrap handling."""
    gx0, gy0, gx1, gy1 = geom_bounds
    if gy1 < min_lat or gy0 > max_lat:
        return False
    if (max_lon - min_lon) >= 350.0 or (gx1 - gx0) > 180.0:
        return True
    return (
        (gx1 >= min_lon and gx0 <= max_lon)
        or (gx1 - 360.0 >= min_lon and gx0 - 360.0 <= max_lon)
        or (gx1 + 360.0 >= min_lon and gx0 + 360.0 <= max_lon)
    )


def _padded_viewport_bounds(
    spec: MapSpec,
) -> tuple[float, float, float, float, bool]:
    """Compute aspect- and latitude-aware padded geographic bounds and rect-clip eligibility."""
    aspect = max(
        spec.page.widthIn / max(0.5, spec.page.heightIn),
        spec.page.heightIn / max(0.5, spec.page.widthIn),
    )
    cos_lat = max(0.25, math.cos(math.radians(spec.center.lat)))
    half_lon = 0.5 * spec.span.lonDeg * max(1.0, aspect / cos_lat * 0.75) + max(
        3.0, spec.span.lonDeg * 0.35
    )
    half_lat = 0.5 * spec.span.latDeg * max(1.0, aspect) + max(
        2.5, spec.span.latDeg * 0.35
    )
    min_lon = spec.center.lon - half_lon
    max_lon = spec.center.lon + half_lon
    min_lat = max(-89.9, spec.center.lat - half_lat)
    max_lat = min(89.9, spec.center.lat + half_lat)
    can_rect_clip = min_lon >= -179.5 and max_lon <= 179.5 and (max_lon - min_lon) < 175.0
    return min_lon, max_lon, min_lat, max_lat, can_rect_clip


def _filter_and_clip_items(
    items: tuple[tuple[Any, tuple[float, float, float, float]], ...],
    min_lon: float,
    max_lon: float,
    min_lat: float,
    max_lat: float,
    can_rect_clip: bool,
) -> list[Any]:
    """Filter cached (geom, bounds) items to viewport and clip oversized polygons via GEOS."""
    geoms: list[Any] = []
    for geom, bounds in items:
        if not _bbox_intersects_view(bounds, min_lon, max_lon, min_lat, max_lat):
            continue
        if can_rect_clip and (
            bounds[0] < min_lon
            or bounds[2] > max_lon
            or bounds[1] < min_lat
            or bounds[3] > max_lat
        ):
            try:
                clipped = clip_by_rect(geom, min_lon, min_lat, max_lon, max_lat)
                if clipped is not None and not clipped.is_empty:
                    geoms.append(clipped)
                continue
            except Exception:
                pass
        geoms.append(geom)
    return geoms


def _draw_gshhs_land_and_lakes(
    ax: Any,
    spec: MapSpec,
    gshhs_scale: str,
    land_color: str,
    water_color: str,
    coast_color: str,
) -> tuple[bool, list[Any], list[Any]]:
    """Render NOAA/GMT GSHHG high/full-resolution vector land & lakes with GEOS viewport clipping."""
    try:
        min_lon, max_lon, min_lat, max_lat, can_rect_clip = _padded_viewport_bounds(spec)

        geodetic = ccrs.PlateCarree()
        edge = coast_color if spec.layers.showCoastlines else "none"
        lw = spec.layers.coastlineWidth if spec.layers.showCoastlines else 0.0

        # L1: continents & islands; L5: Antarctica
        land_levels = (1, 5) if min_lat < -58.0 else (1,)
        land_geoms: list[Any] = []
        for lvl in land_levels:
            land_geoms.extend(
                _filter_and_clip_items(
                    _load_gshhs_level(gshhs_scale, lvl),
                    min_lon,
                    max_lon,
                    min_lat,
                    max_lat,
                    can_rect_clip,
                )
            )

        if land_geoms:
            ax.add_geometries(
                land_geoms,
                crs=geodetic,
                facecolor=land_color,
                edgecolor=edge,
                linewidth=lw,
                zorder=2,
            )

        lake_geoms: list[Any] = []
        island_in_lake_geoms: list[Any] = []
        if spec.layers.showLakes:
            lake_geoms = _filter_and_clip_items(
                _load_gshhs_level(gshhs_scale, 2),
                min_lon,
                max_lon,
                min_lat,
                max_lat,
                can_rect_clip,
            )
            if lake_geoms:
                ax.add_geometries(
                    lake_geoms,
                    crs=geodetic,
                    facecolor=water_color,
                    edgecolor=edge,
                    linewidth=lw * 0.7,
                    zorder=2.5,
                )
            island_in_lake_geoms = _filter_and_clip_items(
                _load_gshhs_level(gshhs_scale, 3),
                min_lon,
                max_lon,
                min_lat,
                max_lat,
                can_rect_clip,
            )
            if island_in_lake_geoms:
                ax.add_geometries(
                    island_in_lake_geoms,
                    crs=geodetic,
                    facecolor=land_color,
                    edgecolor=edge,
                    linewidth=lw * 0.6,
                    zorder=2.6,
                )

        all_land_mask = land_geoms + island_in_lake_geoms
        return True, all_land_mask, lake_geoms
    except Exception as exc:
        logger.warning(
            "GSHHS (%s) shorelines unavailable (%s); falling back to Natural Earth 10m.",
            gshhs_scale,
            exc,
        )
        return False, [], []


def _add_basemap_underlay(ax: Any, spec: MapSpec, proj: ccrs.Projection) -> bool:
    """Add Contextily tile basemap when configured, gracefully returning False if offline."""
    if spec.pro.basemapProvider == "none":
        return False
    provider = _resolve_basemap_provider(spec.pro.basemapProvider)
    if provider is None:
        logger.warning("Unknown basemap provider: %s", spec.pro.basemapProvider)
        return False
    try:
        cx.add_basemap(
            ax,
            crs=proj,
            source=provider,
            alpha=spec.pro.basemapOpacity,
            zorder=1,
        )
        return True
    except Exception as exc:
        logger.warning(
            "Contextily basemap '%s' unavailable (%s); falling back to vector layers.",
            spec.pro.basemapProvider,
            exc,
        )
        return False


def _load_ne_feature(
    category: str, name: str, scale: str, **kwargs: Any
) -> cfeature.NaturalEarthFeature | None:
    """Load and cache a Natural Earth feature under lock, falling back gracefully offline."""
    for candidate_scale in _SCALE_FALLBACK_ORDER.get(scale, (scale, "50m", "10m", "110m")):
        cache_key = (category, name, candidate_scale)
        try:
            with _NE_LOCK:
                feat = cfeature.NaturalEarthFeature(category, name, candidate_scale, **kwargs)
                if cache_key not in _WARMED_NE_FEATURES:
                    next(feat.geometries(), None)
                    _WARMED_NE_FEATURES.add(cache_key)
                return feat
        except Exception as exc:
            logger.warning(
                "Natural Earth %s/%s (%s) unavailable: %s",
                category,
                name,
                candidate_scale,
                exc,
            )
    return None


def _add_ne_layer(
    ax: Any,
    category: str,
    name: str,
    scale: str,
    **kwargs: Any,
) -> None:
    """Attach a Natural Earth feature layer to ax when available."""
    feat = _load_ne_feature(category, name, scale, **kwargs)
    if feat is not None:
        ax.add_feature(feat)


def _load_ne_geometries_bbox(
    category: str, name: str, scale: str
) -> tuple[tuple[Any, tuple[float, float, float, float]], ...]:
    """Load and cache Natural Earth geometries with geographic bounding boxes for fast culling."""
    for candidate_scale in _SCALE_FALLBACK_ORDER.get(scale, (scale, "50m", "10m", "110m")):
        cache_key = (category, name, candidate_scale)
        with _NE_LOCK:
            if cache_key in _NE_GEOM_BBOX_CACHE:
                return _NE_GEOM_BBOX_CACHE[cache_key]
            try:
                path = shpreader.natural_earth(
                    resolution=candidate_scale, category=category, name=name
                )
                reader = shpreader.Reader(path)
                items: list[tuple[Any, tuple[float, float, float, float]]] = []
                for geom in reader.geometries():
                    if geom is None or geom.is_empty:
                        continue
                    items.append((geom, geom.bounds))
                frozen = tuple(items)
                _NE_GEOM_BBOX_CACHE[cache_key] = frozen
                return frozen
            except Exception as exc:
                logger.warning(
                    "Natural Earth %s/%s (%s) unavailable: %s",
                    category,
                    name,
                    candidate_scale,
                    exc,
                )
    return ()


def _add_ne_layer_bbox(
    ax: Any,
    spec: MapSpec,
    category: str,
    name: str,
    scale: str,
    **kwargs: Any,
) -> None:
    """Attach a Natural Earth feature layer pre-filtered and clipped to the padded viewport."""
    items = _load_ne_geometries_bbox(category, name, scale)
    if not items:
        return
    if spec.projection == "orthographic" or max(spec.span.lonDeg, spec.span.latDeg) >= 170.0:
        geoms = [geom for geom, _ in items]
    else:
        min_lon, max_lon, min_lat, max_lat, can_rect_clip = _padded_viewport_bounds(spec)
        geoms = _filter_and_clip_items(
            items, min_lon, max_lon, min_lat, max_lat, can_rect_clip
        )
    if geoms:
        ax.add_geometries(geoms, crs=ccrs.PlateCarree(), **kwargs)


def _load_countries_index(scale: str) -> tuple[tuple[Any, dict[str, str]], ...]:
    """Load and cache Natural Earth admin_0_countries geometries and normalized lookup attrs."""
    with _NE_LOCK:
        if scale in _COUNTRIES_CACHE:
            return _COUNTRIES_CACHE[scale]

        for candidate_scale in _SCALE_FALLBACK_ORDER.get(scale, (scale, "50m", "110m", "10m")):
            if candidate_scale in _COUNTRIES_CACHE:
                _COUNTRIES_CACHE[scale] = _COUNTRIES_CACHE[candidate_scale]
                return _COUNTRIES_CACHE[scale]
            try:
                path = shpreader.natural_earth(
                    resolution=candidate_scale,
                    category="cultural",
                    name="admin_0_countries",
                )
                reader = shpreader.Reader(path)
                entries: list[tuple[Any, dict[str, str]]] = []
                attr_keys = (
                    "ISO_N3",
                    "ISO_N3_EH",
                    "UN_A3",
                    "ADM0_A3",
                    "ISO_A3",
                    "ISO_A3_EH",
                    "ISO_A2",
                    "ISO_A2_EH",
                    "NAME",
                    "NAME_LONG",
                    "ADMIN",
                    "FORMAL_EN",
                    "NAME_SORT",
                    "BRK_NAME",
                    "SOVEREIGNT",
                )
                for record in reader.records():
                    geom = record.geometry
                    if geom is None or geom.is_empty:
                        continue
                    attrs = record.attributes
                    norm = {
                        key: str(attrs.get(key) or "").strip().lower()
                        for key in attr_keys
                    }
                    entries.append((geom, norm))
                frozen = tuple(entries)
                _COUNTRIES_CACHE[candidate_scale] = frozen
                _COUNTRIES_CACHE[scale] = frozen
                return frozen
            except Exception as exc:
                logger.warning(
                    "Natural Earth admin_0_countries (%s) unavailable: %s",
                    candidate_scale,
                    exc,
                )
    return ()


def _match_country_geometries(
    hc: HighlightedCountry, countries: tuple[tuple[Any, dict[str, str]], ...]
) -> list[Any]:
    """Match a HighlightedCountry against Natural Earth records without false sovereign matches."""
    target_id = hc.id.strip().lower()
    target_id_z = target_id.zfill(3) if target_id.isdigit() else ""
    target_name = hc.name.strip().lower()

    primary_id_keys = ("iso_n3", "iso_n3_eh", "un_a3", "adm0_a3", "iso_a3", "iso_a3_eh")
    primary_name_keys = ("name", "name_long", "admin", "formal_en", "name_sort", "brk_name")

    id_tokens = {tok for tok in (target_id, target_id_z) if tok and tok != "-99"}
    matches: list[Any] = []

    for geom, attrs in countries:
        id_vals = {
            attrs[k.upper()]
            for k in primary_id_keys
            if attrs.get(k.upper()) and attrs[k.upper()] != "-99"
        }
        if id_tokens and id_vals & id_tokens:
            matches.append(geom)
            continue
        if target_name:
            name_vals = {attrs[k.upper()] for k in primary_name_keys if attrs.get(k.upper())}
            if target_name in name_vals:
                matches.append(geom)

    if not matches and target_name:
        for geom, attrs in countries:
            if attrs.get("SOVEREIGNT") == target_name:
                matches.append(geom)

    return matches


def _draw_highlighted_countries(
    ax: Any,
    spec: MapSpec,
    scale: str,
    gshhs_land_geoms: list[Any] | None = None,
    gshhs_lake_geoms: list[Any] | None = None,
) -> None:
    """Render highlighted country fills, strokes, and hatches (clipped to GSHHS shorelines when active)."""
    if not spec.highlightedCountries:
        return
    countries = _load_countries_index(scale)
    if not countries:
        return

    geodetic = ccrs.PlateCarree()
    target_proj = ax.projection

    gshhs_land_mask = None
    min_lon = max_lon = min_lat = max_lat = 0.0
    can_rect_clip = False
    if gshhs_land_geoms:
        try:
            min_lon, max_lon, min_lat, max_lat, can_rect_clip = _padded_viewport_bounds(spec)
            land_union = unary_union([g.buffer(0) for g in gshhs_land_geoms if not g.is_empty])
            if gshhs_lake_geoms and spec.layers.showLakes:
                lake_union = unary_union([g.buffer(0) for g in gshhs_lake_geoms if not g.is_empty])
                land_union = land_union.difference(lake_union)
            if land_union is not None and not land_union.is_empty:
                gshhs_land_mask = land_union
        except Exception as exc:
            logger.debug("GSHHS highlight shoreline mask fallback: %s", exc)
            gshhs_land_mask = None

    for hc in spec.highlightedCountries:
        geoms = _match_country_geometries(hc, countries)
        if not geoms:
            continue

        matched_ids = {id(g) for g in geoms}
        render_geoms = geoms

        if gshhs_land_mask is not None and can_rect_clip:
            try:
                hc_view = []
                for g in geoms:
                    c = clip_by_rect(g, min_lon, min_lat, max_lon, max_lat)
                    if c is not None and not c.is_empty:
                        hc_view.append(c.buffer(0))
                if hc_view:
                    hc_union = unary_union(hc_view)
                    other_view = []
                    for og, _ in countries:
                        if id(og) in matched_ids:
                            continue
                        if not _bbox_intersects_view(og.bounds, min_lon, max_lon, min_lat, max_lat):
                            continue
                        oc = clip_by_rect(og, min_lon, min_lat, max_lon, max_lat)
                        if oc is not None and not oc.is_empty:
                            other_view.append(oc.buffer(0))
                    # Buffer slightly into ocean to capture fine GSHHS capes/islets smoothed by NE 10m,
                    # while keeping international land borders exact via difference(other_countries).
                    coastal_env = hc_union.buffer(0.035)
                    if other_view:
                        coastal_env = coastal_env.difference(unary_union(other_view))
                    clipped_hc = gshhs_land_mask.intersection(coastal_env)
                    if clipped_hc is not None and not clipped_hc.is_empty:
                        render_geoms = [clipped_hc]
            except Exception as exc:
                logger.debug("GSHHS highlight clip fallback for %s: %s", hc.name or hc.id, exc)

        fill = _valid_color(hc.fill, _valid_color(spec.colors.highlightFill, "#7a7d7a"))
        stroke = _valid_color(hc.stroke, _valid_color(spec.colors.highlightStroke, "#ffffff"))
        hatch = _HATCH_MAP.get(hc.hatch)
        kwargs: dict[str, Any] = {
            "crs": geodetic,
            "facecolor": fill,
            "edgecolor": stroke,
            "linewidth": max(0.8, spec.layers.borderWidth * 0.9),
            "zorder": 4,
        }
        if hatch:
            kwargs["hatch"] = hatch

        # Stitch split +/-180 deg polygons in projected space so no antimeridian seam shows
        if spec.projection != "orthographic" and gshhs_land_mask is None:
            try:
                projected = []
                for g in render_geoms:
                    pg = target_proj.project_geometry(g, geodetic)
                    if pg is not None and not pg.is_empty:
                        projected.append(pg.buffer(0))
                if projected:
                    stitched = unary_union(projected).buffer(150.0).buffer(-150.0)
                    if not stitched.is_empty:
                        proj_kwargs = dict(kwargs)
                        proj_kwargs["crs"] = target_proj
                        ax.add_geometries([stitched], **proj_kwargs)
                        continue
            except Exception as exc:
                logger.debug("Projected union fallback for %s: %s", hc.name or hc.id, exc)

        ax.add_geometries(render_geoms, **kwargs)


def _load_admin1_polygons_index() -> tuple[tuple[Any, dict[str, str]], ...]:
    """Load and cache Natural Earth 50m admin_1_states_provinces polygons."""
    global _ADMIN1_POLYGONS_CACHE
    with _NE_LOCK:
        if _ADMIN1_POLYGONS_CACHE is not None:
            return _ADMIN1_POLYGONS_CACHE
        try:
            path = shpreader.natural_earth(
                resolution="50m",
                category="cultural",
                name="admin_1_states_provinces",
            )
            reader = shpreader.Reader(path)
            attr_keys = ("adm1_code", "iso_3166_2", "name", "name_alt", "admin", "postal")
            entries: list[tuple[Any, dict[str, str]]] = []
            for record in reader.records():
                geom = record.geometry
                if geom is None or geom.is_empty:
                    continue
                attrs = record.attributes
                norm = {
                    k: str(attrs.get(k) or attrs.get(k.upper()) or "").strip().lower()
                    for k in attr_keys
                }
                entries.append((geom, norm))
            _ADMIN1_POLYGONS_CACHE = tuple(entries)
            return _ADMIN1_POLYGONS_CACHE
        except Exception as exc:
            logger.warning("Natural Earth admin_1_states_provinces (50m) unavailable: %s", exc)
            return ()


def _match_admin1_geometries(
    source_id: str,
    source_name: str,
    records: tuple[tuple[Any, dict[str, str]], ...],
) -> list[Any]:
    """Match an Admin-1 state/province by adm1_code, iso_3166_2, or name."""
    tid = source_id.strip().lower()
    tname = source_name.strip().lower()
    matches: list[Any] = []
    for geom, attrs in records:
        if tid and tid in (attrs.get("adm1_code"), attrs.get("iso_3166_2")):
            matches.append(geom)
            continue
        if tname:
            name = attrs.get("name", "")
            admin = attrs.get("admin", "")
            full_label = f"{name} ({admin})" if admin else name
            if tname in (name, full_label):
                matches.append(geom)
    return matches


def build_spherical_rotation_matrix(
    src_lon: float,
    src_lat: float,
    dst_lon: float,
    dst_lat: float,
    rotation_deg: float = 0.0,
) -> np.ndarray:
    """Build a 3x3 SO(3) rotation matrix mapping (src_lon, src_lat) -> (dst_lon, dst_lat)."""
    lam0 = math.radians(src_lon)
    phi0 = math.radians(src_lat)
    lam1 = math.radians(dst_lon)
    phi1 = math.radians(dst_lat)
    theta = math.radians(rotation_deg)

    c0, s0 = math.cos(-lam0), math.sin(-lam0)
    rz0 = np.array([[c0, -s0, 0.0], [s0, c0, 0.0], [0.0, 0.0, 1.0]], dtype=float)

    cp0, sp0 = math.cos(phi0), math.sin(phi0)
    ry0 = np.array([[cp0, 0.0, sp0], [0.0, 1.0, 0.0], [-sp0, 0.0, cp0]], dtype=float)

    ct, st = math.cos(theta), math.sin(theta)
    rx = np.array([[1.0, 0.0, 0.0], [0.0, ct, st], [0.0, -st, ct]], dtype=float)

    cp1, sp1 = math.cos(phi1), math.sin(phi1)
    ry1 = np.array([[cp1, 0.0, -sp1], [0.0, 1.0, 0.0], [sp1, 0.0, cp1]], dtype=float)

    c1, s1 = math.cos(lam1), math.sin(lam1)
    rz1 = np.array([[c1, -s1, 0.0], [s1, c1, 0.0], [0.0, 0.0, 1.0]], dtype=float)

    return rz1 @ ry1 @ rx @ ry0 @ rz0


def compute_geodesic_area_km2(geoms: list[Any]) -> float:
    """Compute exact WGS84 ellipsoidal geodesic area in square kilometers."""
    total_m2 = 0.0
    for g in geoms:
        if g is None or g.is_empty:
            continue
        area_m2, _ = _GEOD.geometry_area_perimeter(g)
        if math.isfinite(area_m2):
            total_m2 += abs(area_m2)
    return total_m2 / 1_000_000.0


def _format_area_label(area_km2: float, units: str = "km") -> str:
    """Format geodesic area cleanly in km² or mi² matching site/js/shadow.js."""
    if not math.isfinite(area_km2) or area_km2 <= 0.0:
        return ""
    if units == "mi":
        sq_mi = area_km2 / _SQ_KM_PER_SQ_MI
        val = f"{round(sq_mi):,}" if sq_mi >= 100.0 else f"{sq_mi:.1f}"
        return f"{val} mi²"
    val = f"{round(area_km2):,}" if area_km2 >= 100.0 else f"{area_km2:.1f}"
    return f"{val} km²"


def _compute_main_landmass_centroid(geoms: list[Any]) -> tuple[float, float]:
    """Compute area-weighted spherical centroid of primary landmass parts within 30° of largest."""
    parts: list[tuple[float, float, float]] = []
    for g in geoms:
        polys = [g] if isinstance(g, Polygon) else (list(g.geoms) if isinstance(g, MultiPolygon) else [])
        for poly in polys:
            if poly.is_empty:
                continue
            area_m2, _ = _GEOD.geometry_area_perimeter(poly)
            area_km2 = abs(area_m2) / 1_000_000.0
            if area_km2 <= 0.0:
                continue
            pt = poly.representative_point()
            parts.append((float(pt.x), float(pt.y), area_km2))

    if not parts:
        return (0.0, 0.0)

    largest = max(parts, key=lambda item: item[2])
    sx, sy, sz = 0.0, 0.0, 0.0
    for lon, lat, area in parts:
        if _angular_distance_deg(lon, lat, largest[0], largest[1]) <= 30.0:
            lam = math.radians(lon)
            phi = math.radians(lat)
            cphi = math.cos(phi)
            sx += cphi * math.cos(lam) * area
            sy += cphi * math.sin(lam) * area
            sz += math.sin(phi) * area

    norm = math.sqrt(sx * sx + sy * sy + sz * sz)
    if norm <= 1e-12:
        return (largest[0], largest[1])
    lat_c = math.degrees(math.asin(max(-1.0, min(1.0, sz / norm))))
    lon_c = math.degrees(math.atan2(sy, sx))
    return (lon_c, lat_c)


def _densify_ring_coords(coords: Any, max_step_deg: float = 3.5) -> np.ndarray:
    """Densify long straight polygon edges before spherical rotation."""
    pts = np.asarray(coords, dtype=float)
    if pts.ndim != 2 or len(pts) < 3:
        return np.empty((0, 2), dtype=float)
    out: list[tuple[float, float]] = []
    for idx in range(len(pts)):
        lon1, lat1 = float(pts[idx, 0]), float(pts[idx, 1])
        if idx > 0:
            lon0, lat0 = float(pts[idx - 1, 0]), float(pts[idx - 1, 1])
            dlon = lon1 - lon0
            if dlon > 180.0:
                dlon -= 360.0
            elif dlon < -180.0:
                dlon += 360.0
            dlat = lat1 - lat0
            span = math.hypot(dlon, dlat)
            if span > max_step_deg:
                steps = min(24, int(math.ceil(span / max_step_deg)))
                for s in range(1, steps):
                    t = s / float(steps)
                    out.append((lon0 + dlon * t, lat0 + dlat * t))
        out.append((lon1, lat1))
    return np.asarray(out, dtype=float)


def _rotate_ring_spherical(coords: Any, mat: np.ndarray) -> list[tuple[float, float]]:
    """Apply SO(3) spherical rotation matrix to a coordinate ring."""
    dense = _densify_ring_coords(coords)
    if len(dense) < 3:
        return []
    lam = np.radians(dense[:, 0])
    phi = np.radians(dense[:, 1])
    cos_phi = np.cos(phi)
    vecs = np.column_stack((cos_phi * np.cos(lam), cos_phi * np.sin(lam), np.sin(phi)))
    rot = vecs @ mat.T
    new_lat = np.degrees(np.arcsin(np.clip(rot[:, 2], -1.0, 1.0)))
    new_lon = np.degrees(np.arctan2(rot[:, 1], rot[:, 0]))
    ring = list(zip(new_lon.tolist(), new_lat.tolist()))
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


def transform_shadow_geometries(
    geoms: list[Any],
    target_lon: float,
    target_lat: float,
    rotation_deg: float = 0.0,
) -> tuple[list[Any], float]:
    """Translate & rotate Shapely polygon(s) on the sphere preserving exact geodesic area."""
    area_km2 = compute_geodesic_area_km2(geoms)
    src_lon, src_lat = _compute_main_landmass_centroid(geoms)
    mat = build_spherical_rotation_matrix(src_lon, src_lat, target_lon, target_lat, rotation_deg)

    out_polys: list[Polygon] = []
    for g in geoms:
        polys = [g] if isinstance(g, Polygon) else (list(g.geoms) if isinstance(g, MultiPolygon) else [])
        for poly in polys:
            if poly.is_empty:
                continue
            ext = _rotate_ring_spherical(poly.exterior.coords, mat)
            if len(ext) < 4:
                continue
            try:
                ext_area, _ = _GEOD.geometry_area_perimeter(Polygon(ext))
                if math.isfinite(ext_area) and ext_area < 0.0:
                    ext = list(reversed(ext))
            except Exception:
                pass
            holes = []
            for interior in poly.interiors:
                hring = _rotate_ring_spherical(interior.coords, mat)
                if len(hring) >= 4:
                    try:
                        h_area, _ = _GEOD.geometry_area_perimeter(Polygon(hring))
                        if math.isfinite(h_area) and h_area > 0.0:
                            hring = list(reversed(hring))
                    except Exception:
                        pass
                    holes.append(hring)
            try:
                p = Polygon(ext, holes)
                if not p.is_empty:
                    out_polys.append(p)
            except Exception:
                continue
    return out_polys, area_km2


def _poly_crosses_antimeridian(poly: Polygon) -> bool:
    """Return True if any consecutive ring segment jumps > 180 degrees in longitude."""
    coords = list(poly.exterior.coords)
    for idx in range(1, len(coords)):
        if abs(coords[idx][0] - coords[idx - 1][0]) > 180.0:
            return True
    return False


def _draw_region_shadows(
    ax: Any,
    spec: MapSpec,
    ne_scale: str,
    proj: ccrs.Projection,
    limits: tuple[float, float, float, float],
) -> None:
    """Render true-size geodesic region comparison shadows onto ax."""
    if not spec.regionShadows:
        return

    countries = _load_countries_index(ne_scale)
    admin1_records: tuple[tuple[Any, dict[str, str]], ...] | None = None
    geodetic_arc = ccrs.Geodetic()
    plate_carree = ccrs.PlateCarree()
    units = spec.ornaments.scaleBar.units
    xmin, xmax, ymin, ymax = limits

    for shadow in spec.regionShadows:
        if not shadow.visible:
            continue
        if shadow.sourceType == "admin1":
            if admin1_records is None:
                admin1_records = _load_admin1_polygons_index()
            geoms = _match_admin1_geometries(shadow.sourceId, shadow.sourceName, admin1_records)
        else:
            hc_proxy = HighlightedCountry(id=shadow.sourceId, name=shadow.sourceName)
            geoms = _match_country_geometries(hc_proxy, countries)

        if not geoms:
            continue

        transformed, area_km2 = transform_shadow_geometries(
            geoms, shadow.targetLon, shadow.targetLat, shadow.rotationDeg
        )
        if not transformed:
            continue

        fill = _valid_color(shadow.fill, "#dc2626")
        stroke = _valid_color(shadow.stroke, "#7f1d1d")
        hatch = _HATCH_MAP.get(shadow.hatch)
        fill_rgba = to_rgba(fill, max(0.05, min(0.95, float(shadow.opacity))))
        linestyle = "--" if shadow.dashed else "-"

        base_kwargs: dict[str, Any] = {
            "facecolor": fill_rgba,
            "edgecolor": stroke,
            "linewidth": max(0.5, float(shadow.strokeWidth)),
            "linestyle": linestyle,
            "zorder": 5.5,
        }
        if hatch:
            base_kwargs["hatch"] = hatch

        planar_polys = [p for p in transformed if not _poly_crosses_antimeridian(p)]
        wrap_polys = [p for p in transformed if _poly_crosses_antimeridian(p)]
        if planar_polys:
            ax.add_geometries(planar_polys, crs=plate_carree, **base_kwargs)
        if wrap_polys:
            ax.add_geometries(wrap_polys, crs=geodetic_arc, **base_kwargs)

        if shadow.showLabel:
            px, py = proj.transform_point(shadow.targetLon, shadow.targetLat, plate_carree)
            if math.isfinite(px) and math.isfinite(py) and xmin <= px <= xmax and ymin <= py <= ymax:
                label_name = (shadow.sourceName or shadow.sourceId or "Region").strip()
                area_text = _format_area_label(area_km2, units) if shadow.showArea else ""
                full_text = f"{label_name}\n{area_text}" if area_text else label_name
                halo = [patheffects.withStroke(linewidth=2.8, foreground="#ffffff")]
                ax.text(
                    px,
                    py,
                    full_text,
                    transform=ax.transData,
                    ha="center",
                    va="center",
                    fontsize=8.5,
                    fontweight="bold",
                    color=stroke,
                    path_effects=halo,
                    clip_on=True,
                    zorder=5.8,
                )


def fetch_geoboundaries_geojson(
    iso3: str,
    level: str = "ADM1",
    full_vertices: bool = False,
) -> dict[str, Any]:
    """Fetch and repair OSM-derived ADM0/ADM1/ADM2 GeoJSON from geoBoundaries.org."""
    code = iso3.strip().upper()
    adm_level = level.strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", code):
        raise ValueError(f"Invalid ISO-3 country code: {iso3!r}")
    if adm_level not in ("ADM0", "ADM1", "ADM2"):
        raise ValueError(f"Unsupported administrative level: {level!r}")

    meta_url = f"https://www.geoboundaries.org/api/current/gbOpen/{code}/{adm_level}/"
    meta_resp = requests.get(meta_url, timeout=15)
    meta_resp.raise_for_status()
    meta = meta_resp.json()
    gj_url = (
        meta.get("gjDownloadURL") or meta.get("simplifiedGeometryGeoJSON")
        if full_vertices
        else meta.get("simplifiedGeometryGeoJSON") or meta.get("gjDownloadURL")
    )
    if not gj_url:
        raise ValueError(f"geoBoundaries {adm_level} data is not available for {code}.")

    inspected = inspect_geojson(url=gj_url)
    inspected["iso3"] = code
    inspected["admLevel"] = adm_level
    inspected["boundaryName"] = meta.get("boundaryName") or code
    inspected["source"] = meta.get("boundarySource") or "geoBoundaries / OpenStreetMap"
    inspected["url"] = gj_url
    return inspected


def _normalize_geojson_features(raw: Any) -> list[dict[str, Any]]:
    """Coerce FeatureCollection, Feature, or Geometry dicts into a list of Feature dicts."""
    if not isinstance(raw, dict):
        raise ValueError("GeoJSON payload must be a JSON object.")
    gtype = raw.get("type")
    if gtype == "FeatureCollection":
        features = raw.get("features")
        if not isinstance(features, list):
            raise ValueError("FeatureCollection is missing a 'features' array.")
        return [
            f
            for f in features
            if isinstance(f, dict) and f.get("geometry") is not None
        ]
    if gtype == "Feature":
        if raw.get("geometry") is None:
            return []
        return [raw]
    if gtype in _GEOJSON_TYPES:
        return [{"type": "Feature", "geometry": raw, "properties": {}}]
    raise ValueError(f"Unsupported GeoJSON root type: {gtype!r}")


def _load_geojson_gdf(url: str | None, data: dict[str, Any] | None) -> gpd.GeoDataFrame:
    """Load, validate, and repair GeoJSON features into an EPSG:4326 GeoDataFrame."""
    raw = data
    if raw is None:
        if not url:
            raise ValueError("Provide either 'url' or 'data' for GeoJSON inspection.")
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        raw = resp.json()

    features = _normalize_geojson_features(raw)
    if not features:
        return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs="EPSG:4326")

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    gdf["geometry"] = gdf.geometry.make_valid()
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    return gdf


def inspect_geojson(
    url: str | None = None, data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Load, repair invalid geometries, and summarize a GeoJSON source."""
    gdf = _load_geojson_gdf(url=url, data=data)
    feature_count = int(len(gdf))
    if feature_count == 0:
        return {
            "ok": True,
            "featureCount": 0,
            "geometryTypes": [],
            "bounds": None,
            "propertyKeys": [],
            "geojson": {"type": "FeatureCollection", "features": []},
        }

    geometry_types = sorted({str(gt) for gt in gdf.geometry.geom_type.dropna()})
    bounds = [float(val) for val in gdf.total_bounds]
    property_keys = [str(col) for col in gdf.columns if col != "geometry"]
    repaired_geojson = json.loads(gdf.to_json())
    return {
        "ok": True,
        "featureCount": feature_count,
        "geometryTypes": geometry_types,
        "bounds": bounds,
        "propertyKeys": property_keys,
        "geojson": repaired_geojson,
    }


def _partition_geometries(geoms: Any) -> tuple[list[Any], list[Any], list[Point]]:
    """Split Shapely geometries (including GeometryCollections) into polys, lines, points."""
    polys: list[Any] = []
    lines: list[Any] = []
    points: list[Point] = []

    def _collect(geom: Any) -> None:
        if geom is None or geom.is_empty:
            return
        if isinstance(geom, (Polygon, MultiPolygon)):
            polys.append(geom)
        elif isinstance(geom, (LineString, MultiLineString)):
            lines.append(geom)
        elif isinstance(geom, Point):
            points.append(geom)
        elif isinstance(geom, MultiPoint):
            points.extend(pt for pt in geom.geoms if not pt.is_empty)
        elif isinstance(geom, GeometryCollection):
            for sub in geom.geoms:
                _collect(sub)

    for item in geoms:
        _collect(item)
    return polys, lines, points


def _draw_single_geojson_layer(ax: Any, layer: CustomGeoJsonLayer) -> None:
    """Load and render one visible CustomGeoJsonLayer onto ax."""
    gdf = _load_geojson_gdf(url=layer.url, data=layer.data)
    if gdf.empty:
        return

    geodetic = ccrs.PlateCarree()
    color = _valid_color(layer.color, "#222222")
    fill_rgba = to_rgba(color, layer.fillOpacity)
    stroke_rgba = to_rgba(color, 1.0)
    linestyle = "--" if layer.dashed else "-"
    hatch = _HATCH_MAP.get(layer.hatch)

    polys, lines, points = _partition_geometries(gdf.geometry)

    if polys:
        poly_kwargs: dict[str, Any] = {
            "crs": geodetic,
            "facecolor": fill_rgba,
            "edgecolor": stroke_rgba,
            "linewidth": layer.strokeWidth,
            "linestyle": linestyle,
            "zorder": 4.4,
        }
        if hatch:
            poly_kwargs["hatch"] = hatch
        ax.add_geometries(polys, **poly_kwargs)

    if lines:
        ax.add_geometries(
            lines,
            crs=geodetic,
            facecolor="none",
            edgecolor=stroke_rgba,
            linewidth=layer.strokeWidth,
            linestyle=linestyle,
            zorder=4.6,
        )

    if points:
        xs = [pt.x for pt in points]
        ys = [pt.y for pt in points]
        ax.scatter(
            xs,
            ys,
            transform=geodetic,
            s=max(16.0, (layer.strokeWidth * 4.5) ** 2),
            facecolor=fill_rgba,
            edgecolor=stroke_rgba,
            linewidth=max(0.8, layer.strokeWidth * 0.6),
            zorder=4.8,
        )


def _draw_custom_geojson_layers(ax: Any, spec: MapSpec) -> None:
    """Render all visible custom GeoJSON overlay layers safely."""
    for layer in spec.customGeoJsonLayers:
        if not layer.visible:
            continue
        if layer.data is None and not layer.url:
            continue
        try:
            _draw_single_geojson_layer(ax, layer)
        except Exception as exc:
            logger.warning(
                "Skipping custom GeoJSON layer '%s' (%s): %s",
                layer.label or layer.id,
                layer.url or "inline",
                exc,
            )


def _draw_graticule(ax: Any, spec: MapSpec) -> None:
    """Render lat/lon graticule lines with spec.layers.graticuleStepDeg spacing."""
    if not spec.layers.showGraticule:
        return
    step = max(1.0, float(spec.layers.graticuleStepDeg))
    line_color = _valid_color(spec.colors.admin1, "#888888")
    gl = ax.gridlines(
        crs=ccrs.PlateCarree(),
        draw_labels=False,
        linewidth=0.55,
        color=line_color,
        alpha=0.55,
        linestyle="--",
        zorder=6,
    )
    lon_ticks = np.arange(-180.0, 180.0 + 1e-6, step)
    lat_ticks = np.arange(-80.0, 80.0 + 1e-6, step)
    gl.xlocator = mticker.FixedLocator(lon_ticks)
    gl.ylocator = mticker.FixedLocator(lat_ticks)


def _draw_cities(
    fig: Figure,
    ax: Any,
    spec: MapSpec,
    proj: ccrs.Projection,
    limits: tuple[float, float, float, float],
) -> None:
    """Render city markers and pixel-offset haloed labels."""
    if not spec.cities:
        return
    xmin, xmax, ymin, ymax = limits
    geodetic = ccrs.PlateCarree()
    text_color = _valid_color(spec.colors.text, "#111111")
    halo_color = _valid_color(spec.colors.textHalo, "#ffffff")
    global_label_scale = float(spec.layers.cityLabelScale)
    global_icon_scale = float(spec.layers.cityIconScale)

    for city in spec.cities:
        px, py = proj.transform_point(city.lon, city.lat, geodetic)
        if not (math.isfinite(px) and math.isfinite(py)):
            continue
        if not (xmin <= px <= xmax and ymin <= py <= ymax):
            continue

        pin_scale = float(city.scale)
        icon_mult = global_icon_scale * pin_scale
        label_mult = global_label_scale * pin_scale
        min_icon_clear = icon_mult * 1.12 if city.style == "capital" else icon_mult * 0.9
        offset_mult = (
            label_mult
            if city.style == "label_only"
            else max(0.5 * (icon_mult + label_mult), min_icon_clear)
        )

        if city.style == "capital":
            if (
                _valid_color(spec.colors.textHalo, "#ffffff")
                and str(spec.colors.textHalo).lower() != "none"
            ):
                ax.plot(
                    [px],
                    [py],
                    marker="*",
                    markersize=max(4.0, 10.5 * icon_mult),
                    markerfacecolor=halo_color,
                    markeredgecolor=halo_color,
                    markeredgewidth=max(1.0, 2.2 * math.sqrt(icon_mult)),
                    transform=ax.transData,
                    clip_on=True,
                    zorder=7,
                )
            ax.plot(
                [px],
                [py],
                marker="*",
                markersize=max(4.0, 10.5 * icon_mult),
                markerfacecolor=text_color,
                markeredgecolor="none",
                transform=ax.transData,
                clip_on=True,
                zorder=7.1,
            )
        elif city.style == "bullseye":
            ax.plot(
                [px],
                [py],
                marker="o",
                markersize=max(2.0, 6.8 * icon_mult),
                markerfacecolor=halo_color,
                markeredgecolor=text_color,
                markeredgewidth=max(0.6, 1.4 * math.sqrt(icon_mult)),
                transform=ax.transData,
                clip_on=True,
                zorder=7,
            )
            ax.plot(
                [px],
                [py],
                marker="o",
                markersize=max(1.0, 2.6 * icon_mult),
                markerfacecolor=text_color,
                markeredgecolor="none",
                transform=ax.transData,
                clip_on=True,
                zorder=7.1,
            )
        elif city.style == "square":
            ax.plot(
                [px],
                [py],
                marker="s",
                markersize=max(2.0, 4.8 * icon_mult),
                markerfacecolor=text_color,
                markeredgecolor=halo_color,
                markeredgewidth=max(0.5, 0.8 * math.sqrt(icon_mult)),
                transform=ax.transData,
                clip_on=True,
                zorder=7,
            )
        elif city.style == "dot":
            ax.plot(
                [px],
                [py],
                marker="o",
                markersize=max(2.0, 4.8 * icon_mult),
                markerfacecolor=text_color,
                markeredgecolor=halo_color,
                markeredgewidth=max(0.5, 0.8 * math.sqrt(icon_mult)),
                transform=ax.transData,
                clip_on=True,
                zorder=7,
            )

        if city.name:
            if abs(city.dx) < 1.5:
                ha = "center"
            elif city.dx > 0:
                ha = "left"
            else:
                ha = "right"
            city_halo = [
                patheffects.withStroke(
                    linewidth=max(1.0, 2.5 * (label_mult ** 0.75)),
                    foreground=halo_color,
                )
            ]
            label_transform = offset_copy(
                ax.transData,
                fig=fig,
                x=city.dx * offset_mult,
                y=-city.dy * offset_mult,
                units="points",
            )
            ax.text(
                px,
                py,
                city.name,
                transform=label_transform,
                ha=ha,
                va="center",
                fontsize=max(
                    4.0,
                    (9.0 if city.style in ("capital", "bullseye") else 8.0) * label_mult,
                ),
                fontweight="bold" if city.style in ("capital", "bullseye") else "medium",
                color=text_color,
                path_effects=city_halo,
                clip_on=True,
                zorder=7.5,
            )


def _compute_geodesic_scale(
    spec: MapSpec,
    proj: ccrs.Projection,
    limits: tuple[float, float, float, float],
) -> tuple[int, str, float]:
    """Compute (nice_distance, units, axes_width_fraction) using pyproj.Geod."""
    units = spec.ornaments.scaleBar.units
    unit_meters = 1000.0 if units == "km" else 1609.344
    xmin, xmax, ymin, ymax = limits
    x_span = max(xmax - xmin, 1.0)
    geodetic = ccrs.PlateCarree()

    cx, cy = proj.transform_point(spec.center.lon, spec.center.lat, geodetic)
    if not (math.isfinite(cx) and math.isfinite(cy)):
        cx = 0.5 * (xmin + xmax)
        cy = 0.5 * (ymin + ymax)

    probe_dx = 0.125 * x_span
    lon1, lat1 = geodetic.transform_point(cx - probe_dx, cy, proj)
    lon2, lat2 = geodetic.transform_point(cx + probe_dx, cy, proj)

    total_width_m = 0.0
    if all(math.isfinite(v) for v in (lon1, lat1, lon2, lat2)):
        _, _, dist_m = _GEOD.inv(lon1, lat1, lon2, lat2)
        if math.isfinite(dist_m) and dist_m > 0:
            total_width_m = dist_m * 4.0

    if total_width_m <= 0.0:
        _, _, deg_m = _GEOD.inv(
            spec.center.lon - 0.5,
            spec.center.lat,
            spec.center.lon + 0.5,
            spec.center.lat,
        )
        total_width_m = max(1000.0, deg_m * spec.span.lonDeg)

    target_units = max(1.0, (0.22 * total_width_m) / unit_meters)
    nice_val = min(_NICE_SCALE_STEPS, key=lambda v: abs(v - target_units))
    nice_m = nice_val * unit_meters

    bar_frac = nice_m / total_width_m
    try:
        lon_e, lat_e, _ = _GEOD.fwd(spec.center.lon, spec.center.lat, 90.0, nice_m * 0.5)
        lon_w, lat_w, _ = _GEOD.fwd(spec.center.lon, spec.center.lat, 270.0, nice_m * 0.5)
        px_e, py_e = proj.transform_point(lon_e, lat_e, geodetic)
        px_w, py_w = proj.transform_point(lon_w, lat_w, geodetic)
        if all(math.isfinite(v) for v in (px_e, py_e, px_w, py_w)):
            measured_frac = math.hypot(px_e - px_w, py_e - py_w) / x_span
            if 0.03 <= measured_frac <= 0.45:
                bar_frac = measured_frac
    except Exception:
        pass

    bar_frac = max(0.06, min(0.36, bar_frac))
    return int(nice_val), units, bar_frac


def _draw_scale_bar(
    fig: Figure,
    ax: Any,
    spec: MapSpec,
    proj: ccrs.Projection,
    limits: tuple[float, float, float, float],
    has_title: bool,
) -> None:
    """Draw a geodesic two-tone alternating scale bar and label pill in the page corner."""
    if not spec.ornaments.scaleBar.enabled:
        return

    ax.apply_aspect()
    ax_pos = ax.get_position()

    nice_val, units, bar_frac = _compute_geodesic_scale(spec, proj, limits)
    bar_fig_w = max(0.06, min(0.36, bar_frac * ax_pos.width))

    text_color = _valid_color(spec.colors.text, "#111111")
    bg_color = _valid_color(spec.colors.textHalo, "#ffffff")

    pos = spec.ornaments.scaleBar.position
    pad_in = 0.03 * min(spec.page.widthIn, spec.page.heightIn)
    pad_x = pad_in / spec.page.widthIn
    pad_y = pad_in / spec.page.heightIn

    inner_pad_x = 0.10 / spec.page.widthIn
    pill_w = bar_fig_w + 2.0 * inner_pad_x
    pill_h = max(0.042, min(0.07, 0.30 / spec.page.heightIn))

    x0 = pad_x if "left" in pos else (1.0 - pad_x - pill_w)
    if "bottom" in pos:
        y0 = pad_y
    else:
        top_offset = 0.06 if has_title else 0.0
        y0 = 1.0 - pad_y - top_offset - pill_h

    scale_ax = fig.add_axes([x0, y0, pill_w, pill_h], zorder=10)
    scale_ax.set_xlim(0.0, 1.0)
    scale_ax.set_ylim(0.0, 1.0)
    scale_ax.set_axis_off()

    pill = FancyBboxPatch(
        (0.02, 0.05),
        0.96,
        0.90,
        boxstyle="round,pad=0.02,rounding_size=0.12",
        facecolor=bg_color,
        edgecolor=text_color,
        linewidth=0.65,
        alpha=0.88,
        zorder=1,
    )
    scale_ax.add_patch(pill)

    bar_x0 = inner_pad_x / pill_w
    bar_w = bar_fig_w / pill_w
    bar_y0 = 0.20
    bar_h = 0.24
    segments = 4 if (nice_val % 2 == 0 and bar_fig_w >= 0.10) else 2
    seg_w = bar_w / segments
    for idx in range(segments):
        seg_fill = text_color if idx % 2 == 0 else bg_color
        scale_ax.add_patch(
            Rectangle(
                (bar_x0 + idx * seg_w, bar_y0),
                seg_w,
                bar_h,
                facecolor=seg_fill,
                edgecolor=text_color,
                linewidth=0.65,
                zorder=2,
            )
        )

    label_y = bar_y0 + bar_h + 0.10
    scale_ax.text(
        bar_x0,
        label_y,
        "0",
        ha="left",
        va="bottom",
        fontsize=6.8,
        fontweight="bold",
        color=text_color,
        zorder=3,
    )
    if segments == 4 and nice_val >= 2:
        scale_ax.text(
            bar_x0 + 0.5 * bar_w,
            label_y,
            f"{nice_val // 2}",
            ha="center",
            va="bottom",
            fontsize=6.8,
            color=text_color,
            zorder=3,
        )
    scale_ax.text(
        bar_x0 + bar_w,
        label_y,
        f"{nice_val} {units}",
        ha="right",
        va="bottom",
        fontsize=6.8,
        fontweight="bold",
        color=text_color,
        zorder=3,
    )


def _corner_inset_rect(
    spec: MapSpec,
    corner: str,
    side_in: float,
    has_title: bool,
) -> tuple[float, float, float, float]:
    """Compute distortion-free [x0, y0, w, h] in figure coordinates for a corner inset."""
    fig_w = spec.page.widthIn
    fig_h = spec.page.heightIn
    w = side_in / fig_w
    h = side_in / fig_h
    pad_in = 0.03 * min(fig_w, fig_h)
    pad_x = pad_in / fig_w
    pad_y = pad_in / fig_h
    top_title_gap = 0.06 if (has_title and "top" in corner) else 0.0

    x0 = pad_x if "left" in corner else (1.0 - pad_x - w)
    y0 = pad_y if "bottom" in corner else (1.0 - pad_y - top_title_gap - h)
    return (x0, y0, w, h)


def _angular_distance_deg(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Return spherical great-circle angular distance in degrees between two points."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = phi2 - phi1
    d_lam = math.radians(lon2 - lon1)
    a = math.sin(0.5 * d_phi) ** 2 + math.cos(phi1) * math.cos(phi2) * (
        math.sin(0.5 * d_lam) ** 2
    )
    return math.degrees(2.0 * math.asin(min(1.0, math.sqrt(max(0.0, a)))))


def _unwrap_near(lon: float, center_lon: float) -> float:
    """Unwrap longitude into [center_lon - 180, center_lon + 180) near center_lon."""
    return center_lon + ((lon - center_lon + 180.0) % 360.0 - 180.0)


def _estimate_effective_span_deg(spec: MapSpec) -> float:
    """Estimate effective angular viewport span in degrees accounting for page aspect."""
    if spec.projection == "orthographic":
        return max(float(spec.span.lonDeg), float(spec.span.latDeg))
    cos_lat = max(0.15, math.cos(math.radians(float(spec.center.lat))))
    page_aspect = max(1.0, float(spec.page.widthIn)) / max(1.0, float(spec.page.heightIn))
    gc_w = float(spec.span.lonDeg) * cos_lat
    gc_h = float(spec.span.latDeg)
    fitted_w = max(gc_w, gc_h * page_aspect)
    fitted_h = max(gc_h, gc_w / page_aspect)
    return max(fitted_w, fitted_h)


def resolve_locator_globe_zoom(
    spec: MapSpec, max_corner_dist_deg: float = 0.0
) -> float:
    """Compute effective locator globe zoom factor matching site/js/ornaments.js."""
    cfg = spec.ornaments.locatorGlobe
    mode = cfg.zoomMode
    if mode == "hemisphere":
        return 1.0
    if mode == "nearside":
        return 1.8
    if mode == "custom":
        return max(1.0, min(6.0, float(cfg.zoom)))
    base_span = _estimate_effective_span_deg(spec)
    effective_span = (
        max(base_span, max_corner_dist_deg * 2.2)
        if max_corner_dist_deg > 0.0
        else base_span
    )
    return max(1.0, min(4.2, 56.0 / max(6.0, effective_span)))


def _sample_span_perimeter(
    spec: MapSpec, steps: int = 16
) -> tuple[list[float], list[float]]:
    """Sample a clockwise lon/lat rectangle from spec.span as a fallback footprint."""
    dlon = min(float(spec.span.lonDeg) * 0.5, 179.0)
    dlat = min(float(spec.span.latDeg) * 0.5, 85.0)
    lon_w = float(spec.center.lon) - dlon
    lon_e = float(spec.center.lon) + dlon
    lat_s = max(-85.0, float(spec.center.lat) - dlat)
    lat_n = min(85.0, float(spec.center.lat) + dlat)
    if lat_s >= lat_n:
        clamped_c = max(-84.5, min(84.5, float(spec.center.lat)))
        lat_s = clamped_c - 0.5
        lat_n = clamped_c + 0.5

    ring_lons: list[float] = []
    ring_lats: list[float] = []
    for i in range(steps):
        t = i / float(steps)
        ring_lons.append(lon_w + t * (lon_e - lon_w))
        ring_lats.append(lat_n)
    for i in range(steps):
        t = i / float(steps)
        ring_lons.append(lon_e)
        ring_lats.append(lat_n - t * (lat_n - lat_s))
    for i in range(steps):
        t = i / float(steps)
        ring_lons.append(lon_e - t * (lon_e - lon_w))
        ring_lats.append(lat_s)
    for i in range(steps):
        t = i / float(steps)
        ring_lons.append(lon_w)
        ring_lats.append(lat_s + t * (lat_n - lat_s))
    return (ring_lons, ring_lats)


def _compute_viewport_footprint(
    spec: MapSpec,
    proj: ccrs.Projection | None,
    limits: tuple[float, float, float, float] | None,
) -> tuple[list[float], list[float], bool, float]:
    """Invert the rendered map viewport perimeter into geographic lon/lat samples."""
    if proj is None or limits is None:
        ring_lons, ring_lats = _sample_span_perimeter(spec, steps=16)
        can_fill = max(float(spec.span.lonDeg), float(spec.span.latDeg)) < 120.0
        return (
            ring_lons,
            ring_lats,
            can_fill,
            _estimate_effective_span_deg(spec) * 0.5,
        )

    xmin, xmax, ymin, ymax = limits
    xc = 0.5 * (xmin + xmax)
    yc = 0.5 * (ymin + ymax)
    tol = 0.015 * max(abs(xmax - xmin), abs(ymax - ymin), 1.0)
    geodetic = ccrs.PlateCarree()
    center_lon = float(spec.center.lon)
    center_lat = float(spec.center.lat)

    def _invert_valid(px: float, py: float) -> tuple[float, float] | None:
        try:
            lon, lat = geodetic.transform_point(px, py, proj)
        except Exception:
            return None
        if not (math.isfinite(lon) and math.isfinite(lat)):
            return None
        if lat < -89.999 or lat > 89.999:
            return None
        if spec.projection == "orthographic":
            if _angular_distance_deg(lon, lat, center_lon, center_lat) > 88.5:
                return None
        try:
            rx, ry = proj.transform_point(lon, lat, geodetic)
        except Exception:
            return None
        if not (math.isfinite(rx) and math.isfinite(ry)):
            return None
        if math.hypot(rx - px, ry - py) > tol:
            return None
        return (float(lon), float(lat))

    steps = 24
    boundary_pts: list[tuple[float, float]] = []
    for i in range(steps):
        t = i / float(steps)
        boundary_pts.append((xmin + t * (xmax - xmin), ymax))
    for i in range(steps):
        t = i / float(steps)
        boundary_pts.append((xmax, ymax - t * (ymax - ymin)))
    for i in range(steps):
        t = i / float(steps)
        boundary_pts.append((xmax - t * (xmax - xmin), ymin))
    for i in range(steps):
        t = i / float(steps)
        boundary_pts.append((xmin, ymin + t * (ymax - ymin)))

    center_pt = _invert_valid(xc, yc)
    all_samples: list[tuple[float, float]] = []
    unclamped_samples: list[tuple[float, float]] = []
    clamped_count = 0

    for bx, by in boundary_pts:
        pt = _invert_valid(bx, by)
        if pt is not None:
            all_samples.append(pt)
            unclamped_samples.append(pt)
            continue
        clamped_count += 1
        if center_pt is not None:
            lo = 0.0
            hi = 1.0
            best = center_pt
            for _ in range(10):
                mid = 0.5 * (lo + hi)
                cand = _invert_valid(xc + mid * (bx - xc), yc + mid * (by - yc))
                if cand is not None:
                    best = cand
                    lo = mid
                else:
                    hi = mid
            all_samples.append(best)

    if len(all_samples) < 16:
        ring_lons, ring_lats = _sample_span_perimeter(spec, steps=16)
        can_fill = max(float(spec.span.lonDeg), float(spec.span.latDeg)) < 120.0
        return (
            ring_lons,
            ring_lats,
            can_fill,
            _estimate_effective_span_deg(spec) * 0.5,
        )

    ring_lons = [pt[0] for pt in all_samples]
    ring_lats = [pt[1] for pt in all_samples]
    unwrapped_lons = [_unwrap_near(lon, center_lon) for lon in ring_lons]
    vis_lon_span = max(unwrapped_lons) - min(unwrapped_lons)
    vis_lat_span = max(ring_lats) - min(ring_lats)

    dist_samples = (
        unclamped_samples
        if (spec.projection != "orthographic" and unclamped_samples)
        else all_samples
    )
    max_corner_dist_deg = max(
        _angular_distance_deg(lon, lat, center_lon, center_lat)
        for lon, lat in dist_samples
    )

    can_fill = (
        max_corner_dist_deg < 72.0
        and vis_lon_span < 165.0
        and vis_lat_span < 140.0
        and not (spec.projection == "orthographic" and clamped_count >= 92)
    )
    return (ring_lons, ring_lats, can_fill, max_corner_dist_deg)


def _draw_locator_globe(
    fig: Figure,
    spec: MapSpec,
    scale: str,
    has_title: bool,
    proj: ccrs.Projection | None = None,
    limits: tuple[float, float, float, float] | None = None,
) -> None:
    """Render an orthographic or nearside satellite inset globe showing center and extent box."""
    cfg = spec.ornaments.locatorGlobe
    if not cfg.enabled:
        return

    side_in = (cfg.sizePct / 100.0) * min(spec.page.widthIn, spec.page.heightIn)
    x0, y0, w, h = _corner_inset_rect(spec, cfg.position, side_in, has_title)

    ring_lons, ring_lats, can_fill, max_corner_dist_deg = _compute_viewport_footprint(
        spec, proj, limits
    )
    effective_zoom = resolve_locator_globe_zoom(
        spec, max_corner_dist_deg=max_corner_dist_deg
    )
    if effective_zoom <= 1.03:
        globe_proj: ccrs.Projection = ccrs.Orthographic(
            central_longitude=spec.center.lon, central_latitude=spec.center.lat
        )
    else:
        theta_h = math.pi / (2.0 * effective_zoom)
        p_dist = 1.0 / math.cos(theta_h)
        sat_height = max(120_000.0, (p_dist - 1.0) * 6_378_137.0)
        globe_proj = ccrs.NearsidePerspective(
            central_longitude=spec.center.lon,
            central_latitude=spec.center.lat,
            satellite_height=sat_height,
        )
    inset_ax = fig.add_axes([x0, y0, w, h], projection=globe_proj, zorder=9)
    inset_ax.set_global()

    water = _valid_color(spec.colors.water, "#d1cfcf")
    land = _valid_color(spec.colors.land, "#4a4a4a")
    borders = _valid_color(spec.colors.borders, "#ffffff")
    frame_color = _valid_color(spec.colors.text, "#111111")

    inset_ax.set_facecolor(water)
    globe_scale = "50m" if effective_zoom >= 1.35 else "110m"
    _add_ne_layer(inset_ax, "physical", "ocean", globe_scale, facecolor=water, edgecolor="none", zorder=1)
    _add_ne_layer(inset_ax, "physical", "land", globe_scale, facecolor=land, edgecolor="none", zorder=2)
    _add_ne_layer(
        inset_ax,
        "cultural",
        "admin_0_boundary_lines_land",
        globe_scale,
        facecolor="none",
        edgecolor=borders,
        linewidth=0.35,
        alpha=0.8,
        zorder=3,
    )

    if spec.highlightedCountries:
        countries = _load_countries_index(globe_scale)
        for hc in spec.highlightedCountries:
            geoms = _match_country_geometries(hc, countries)
            if geoms:
                inset_ax.add_geometries(
                    geoms,
                    crs=ccrs.PlateCarree(),
                    facecolor=_valid_color(hc.fill, spec.colors.highlightFill),
                    edgecolor="none",
                    zorder=3.5,
                )

    if cfg.showExtentBox and ring_lons:
        closed_lons = np.asarray(ring_lons + [ring_lons[0]], dtype=float)
        closed_lats = np.asarray(ring_lats + [ring_lats[0]], dtype=float)
        pts = globe_proj.transform_points(
            ccrs.PlateCarree(), closed_lons, closed_lats
        )
        xs = pts[:, 0]
        ys = pts[:, 1]
        valid = np.isfinite(xs) & np.isfinite(ys)
        if np.all(valid):
            if can_fill:
                inset_ax.fill(
                    xs[:-1],
                    ys[:-1],
                    facecolor="#dc2626",
                    alpha=0.24,
                    zorder=5,
                )
            inset_ax.plot(
                xs,
                ys,
                color="#dc2626",
                linewidth=1.35,
                zorder=5.5,
            )
            globe_xlim = inset_ax.get_xlim()
            globe_ylim = inset_ax.get_ylim()
            globe_diameter = max(
                abs(globe_xlim[1] - globe_xlim[0]),
                abs(globe_ylim[1] - globe_ylim[0]),
                1.0,
            )
            if max(float(np.ptp(xs)), float(np.ptp(ys))) < 0.04 * globe_diameter:
                cx_g, cy_g = globe_proj.transform_point(
                    spec.center.lon, spec.center.lat, ccrs.PlateCarree()
                )
                if math.isfinite(cx_g) and math.isfinite(cy_g):
                    inset_ax.plot(
                        [cx_g],
                        [cy_g],
                        marker="o",
                        markersize=4.5,
                        markerfacecolor="#dc2626",
                        markeredgecolor="#ffffff",
                        markeredgewidth=0.9,
                        zorder=6,
                    )
        elif np.any(valid):
            # Draw finite contiguous spans without bridging across horizon NaNs
            start = None
            for idx, is_ok in enumerate(valid):
                if is_ok and start is None:
                    start = idx
                elif not is_ok and start is not None:
                    if idx - start >= 2:
                        inset_ax.plot(
                            xs[start:idx],
                            ys[start:idx],
                            color="#dc2626",
                            linewidth=1.35,
                            zorder=5.5,
                        )
                    start = None
            if start is not None and len(valid) - start >= 2:
                inset_ax.plot(
                    xs[start:],
                    ys[start:],
                    color="#dc2626",
                    linewidth=1.35,
                    zorder=5.5,
                )

    inset_ax.spines["geo"].set_edgecolor(frame_color)
    inset_ax.spines["geo"].set_linewidth(1.0)


def _draw_north_arrow(fig: Figure, spec: MapSpec, has_title: bool) -> None:
    """Render a crisp two-tone compass north arrow in the requested corner."""
    cfg = spec.ornaments.northArrow
    if not cfg.enabled:
        return

    side_in = 0.08 * min(spec.page.widthIn, spec.page.heightIn)
    side_in = max(0.32, min(0.6, side_in))
    x0, y0, w, h = _corner_inset_rect(spec, cfg.position, side_in, has_title)

    arrow_ax = fig.add_axes([x0, y0, w, h], zorder=10)
    arrow_ax.set_xlim(-1.0, 1.0)
    arrow_ax.set_ylim(-1.0, 1.0)
    arrow_ax.set_aspect("equal")
    arrow_ax.set_axis_off()

    text_color = _valid_color(spec.colors.text, "#111111")
    bg_color = _valid_color(spec.colors.textHalo, "#ffffff")

    badge = FancyBboxPatch(
        (-0.9, -0.9),
        1.8,
        1.8,
        boxstyle="round,pad=0.05,rounding_size=0.28",
        facecolor=bg_color,
        edgecolor=text_color,
        linewidth=0.8,
        alpha=0.88,
    )
    arrow_ax.add_patch(badge)

    left_half = MplPolygon(
        [(0.0, 0.42), (-0.42, -0.58), (0.0, -0.34)],
        closed=True,
        facecolor=text_color,
        edgecolor=text_color,
        linewidth=0.8,
    )
    right_half = MplPolygon(
        [(0.0, 0.42), (0.42, -0.58), (0.0, -0.34)],
        closed=True,
        facecolor=bg_color,
        edgecolor=text_color,
        linewidth=0.8,
    )
    arrow_ax.add_patch(left_half)
    arrow_ax.add_patch(right_half)
    arrow_ax.text(
        0.0,
        0.64,
        "N",
        ha="center",
        va="center",
        fontsize=8.0,
        fontweight="bold",
        color=text_color,
    )


def _draw_legend(fig: Figure, ax: Any, spec: MapSpec, has_title: bool) -> None:
    """Render an automatic cartographic legend for countries, overlays, and cities."""
    cfg = spec.ornaments.legend
    if not cfg.enabled:
        return

    text_color = _valid_color(spec.colors.text, "#111111")
    bg_color = _valid_color(spec.colors.textHalo, "#ffffff")
    handles: list[Any] = []

    for hc in spec.highlightedCountries:
        fill = _valid_color(hc.fill, _valid_color(spec.colors.highlightFill, "#7a7d7a"))
        stroke = _valid_color(hc.stroke, _valid_color(spec.colors.highlightStroke, "#ffffff"))
        handles.append(
            Patch(
                facecolor=fill,
                edgecolor=stroke if stroke != fill else text_color,
                hatch=_HATCH_MAP.get(hc.hatch),
                linewidth=0.8,
                label=hc.name or hc.id or "Highlighted Area",
            )
        )

    for shadow in spec.regionShadows:
        if not shadow.visible:
            continue
        fill = _valid_color(shadow.fill, "#dc2626")
        stroke = _valid_color(shadow.stroke, "#7f1d1d")
        handles.append(
            Patch(
                facecolor=to_rgba(fill, shadow.opacity),
                edgecolor=stroke,
                linestyle="--" if shadow.dashed else "-",
                hatch=_HATCH_MAP.get(shadow.hatch),
                linewidth=1.0,
                label=f"{shadow.sourceName or shadow.sourceId or 'Region'} (Shadow)",
            )
        )

    for layer in spec.customGeoJsonLayers:
        if not layer.visible:
            continue
        color = _valid_color(layer.color, "#222222")
        handles.append(
            Patch(
                facecolor=to_rgba(color, layer.fillOpacity),
                edgecolor=color,
                linestyle="--" if layer.dashed else "-",
                hatch=_HATCH_MAP.get(layer.hatch),
                linewidth=1.0,
                label=layer.label or layer.id,
            )
        )

    if spec.cities:
        handles.append(
            Line2D(
                [0],
                [0],
                marker="o",
                linestyle="None",
                markerfacecolor=text_color,
                markeredgecolor=bg_color,
                markersize=5.5,
                label="Cities / Points",
            )
        )

    if not handles:
        handles.extend(
            [
                Patch(
                    facecolor=_valid_color(spec.colors.land, "#4a4a4a"),
                    edgecolor=text_color,
                    linewidth=0.5,
                    label="Land",
                ),
                Patch(
                    facecolor=_valid_color(spec.colors.water, "#d1cfcf"),
                    edgecolor=text_color,
                    linewidth=0.5,
                    label="Water",
                ),
            ]
        )

    loc_map = {
        "bottom-left": ("lower left", (0.03, 0.03)),
        "bottom-right": ("lower right", (0.97, 0.03)),
        "top-left": ("upper left", (0.03, 0.905 if has_title else 0.97)),
        "top-right": ("upper right", (0.97, 0.905 if has_title else 0.97)),
    }
    loc, anchor = loc_map.get(cfg.position, ("lower right", (0.97, 0.03)))

    leg = fig.legend(
        handles=handles,
        loc=loc,
        bbox_to_anchor=anchor,
        bbox_transform=fig.transFigure,
        frameon=True,
        facecolor=bg_color,
        edgecolor=text_color,
        framealpha=0.9,
        fontsize=7.2,
        labelcolor=text_color,
        borderpad=0.5,
        handlelength=1.4,
    )
    leg.set_zorder(10)


def _draw_title_banner(fig: Figure, spec: MapSpec) -> bool:
    """Draw a top banner title if enabled and return whether it was drawn."""
    title_text = spec.title.strip()
    if not (spec.showTitle and title_text):
        return False

    text_color = _valid_color(spec.colors.text, "#111111")
    bg_color = _valid_color(spec.colors.textHalo, "#ffffff")
    fig.text(
        0.5,
        0.975,
        title_text,
        ha="center",
        va="top",
        fontsize=11.0,
        fontweight="bold",
        color=text_color,
        bbox={
            "boxstyle": "round,pad=0.35",
            "facecolor": bg_color,
            "edgecolor": text_color,
            "linewidth": 0.85,
            "alpha": 0.92,
        },
        zorder=12,
    )
    return True


def _export_figure(fig: Figure, fmt: str, dpi: int) -> bytes:
    """Render Figure via the requested Matplotlib canvas into raw image/document bytes."""
    fmt_lower = fmt.lower()
    buf = io.BytesIO()

    if fmt_lower == "png":
        FigureCanvasAgg(fig)
        fig.savefig(buf, format="png", dpi=dpi)
        return buf.getvalue()

    if fmt_lower in ("jpeg", "jpg"):
        canvas = FigureCanvasAgg(fig)
        canvas.draw()
        rgba = np.asarray(canvas.buffer_rgba())
        pil_img = Image.fromarray(rgba, mode="RGBA").convert("RGB")
        pil_img.save(buf, format="JPEG", quality=95, dpi=(dpi, dpi))
        return buf.getvalue()

    if fmt_lower == "pdf":
        FigureCanvasPdf(fig)
        fig.savefig(buf, format="pdf", dpi=dpi)
        return buf.getvalue()

    if fmt_lower == "svg":
        FigureCanvasSVG(fig)
        fig.savefig(buf, format="svg")
        return buf.getvalue()

    raise ValueError(f"Unsupported render format: {fmt!r}")


def render_map(spec: MapSpec, fmt: str = "png") -> bytes:
    """Render a MapSpec into PNG, JPEG, PDF, or SVG bytes without using matplotlib.pyplot."""
    fmt_lower = fmt.lower()
    if fmt_lower not in ("png", "jpeg", "jpg", "pdf", "svg"):
        raise ValueError(f"Unsupported export format: {fmt!r}")

    dpi = int(spec.page.dpi)
    if fmt_lower in ("png", "jpeg", "jpg"):
        # Nudge inch dimensions by +0.4 px so Matplotlib's int(inches * dpi) equals exact round().
        target_w_px = int(round(spec.page.widthIn * dpi))
        target_h_px = int(round(spec.page.heightIn * dpi))
        figsize = ((target_w_px + 0.4) / dpi, (target_h_px + 0.4) / dpi)
    else:
        figsize = (spec.page.widthIn, spec.page.heightIn)

    fig = Figure(figsize=figsize, dpi=dpi)
    water_color = _valid_color(spec.colors.water, "#d1cfcf")
    land_color = _valid_color(spec.colors.land, "#4a4a4a")
    border_color = _valid_color(spec.colors.borders, "#ffffff")
    coast_color = _valid_color(spec.colors.coastline, border_color)
    river_color = _valid_color(spec.colors.rivers, water_color)
    admin1_color = _valid_color(spec.colors.admin1, "#737373")
    bathy_color = _valid_color(spec.colors.bathymetry, "#bfbdbd")
    urban_color = _valid_color(spec.colors.urban, "#636363")

    fig.patch.set_facecolor(water_color)
    proj = _build_projection(spec)
    ax = fig.add_axes([0.0, 0.0, 1.0, 1.0], projection=proj)
    ax.set_facecolor(water_color)

    limits = _configure_extent(ax, spec, proj)
    scale = resolve_scale(spec)
    ne_scale = _ne_scale_for(scale)

    # 1. Optional Contextily basemap underlay
    basemap_active = _add_basemap_underlay(ax, spec, proj)

    # 2. Vector base layers (skip opaque ocean/land fills when basemap is active)
    used_gshhs = False
    gshhs_land_geoms: list[Any] = []
    gshhs_lake_geoms: list[Any] = []
    if not basemap_active:
        if ne_scale != "10m":
            _add_ne_layer(
                ax, "physical", "ocean", ne_scale, facecolor=water_color, edgecolor="none", zorder=1
            )
        if spec.layers.showBathymetry:
            _add_ne_layer_bbox(
                ax,
                spec,
                "physical",
                "bathymetry_J_1000",
                "10m",
                facecolor=bathy_color,
                edgecolor="none",
                alpha=0.45,
                zorder=1.4,
            )
            _add_ne_layer_bbox(
                ax,
                spec,
                "physical",
                "bathymetry_K_200",
                "10m",
                facecolor=bathy_color,
                edgecolor="none",
                alpha=0.45,
                zorder=1.5,
            )

        gshhs_scale = _resolve_gshhs_scale(spec, scale)
        if gshhs_scale is not None:
            used_gshhs, gshhs_land_geoms, gshhs_lake_geoms = _draw_gshhs_land_and_lakes(
                ax, spec, gshhs_scale, land_color, water_color, coast_color
            )

        if not used_gshhs:
            _add_ne_layer_bbox(
                ax,
                spec,
                "physical",
                "land",
                ne_scale,
                facecolor=land_color,
                edgecolor="none",
                zorder=2,
            )
            if (
                ne_scale == "10m"
                and spec.layers.showMinorIslands
                and spec.projection != "orthographic"
                and max(spec.span.lonDeg, spec.span.latDeg) <= 95.0
            ):
                _add_ne_layer_bbox(
                    ax,
                    spec,
                    "physical",
                    "minor_islands",
                    "10m",
                    facecolor=land_color,
                    edgecolor=coast_color if spec.layers.showCoastlines else "none",
                    linewidth=spec.layers.coastlineWidth * 0.8 if spec.layers.showCoastlines else 0.0,
                    zorder=2.1,
                )
            if spec.layers.showLakes:
                _add_ne_layer_bbox(
                    ax,
                    spec,
                    "physical",
                    "lakes",
                    ne_scale,
                    facecolor=water_color,
                    edgecolor=coast_color if spec.layers.showCoastlines else "none",
                    linewidth=spec.layers.coastlineWidth * 0.7,
                    zorder=2.5,
                )

    if spec.layers.showUrbanAreas:
        urban_scale = "10m" if ne_scale == "10m" else "50m"
        _add_ne_layer_bbox(
            ax,
            spec,
            "cultural",
            "urban_areas",
            urban_scale,
            facecolor=urban_color,
            edgecolor="none",
            alpha=0.72,
            zorder=2.3,
        )

    if spec.layers.showRivers:
        _add_ne_layer_bbox(
            ax,
            spec,
            "physical",
            "rivers_lake_centerlines",
            ne_scale,
            facecolor="none",
            edgecolor=river_color,
            linewidth=spec.layers.riverWidth,
            zorder=3,
        )

    if spec.layers.showCoastlines and not used_gshhs:
        _add_ne_layer_bbox(
            ax,
            spec,
            "physical",
            "coastline",
            ne_scale,
            facecolor="none",
            edgecolor=coast_color,
            linewidth=spec.layers.coastlineWidth,
            zorder=3.2,
        )

    if spec.layers.showAdmin1:
        admin1_scale = resolve_admin1_scale(spec)
        _add_ne_layer_bbox(
            ax,
            spec,
            "cultural",
            "admin_1_states_provinces_lines",
            admin1_scale,
            facecolor="none",
            edgecolor=admin1_color,
            linewidth=spec.layers.admin1Width,
            linestyle=":",
            alpha=0.85,
            zorder=3.5,
        )

    # 3. Highlighted countries
    _draw_highlighted_countries(
        ax,
        spec,
        ne_scale,
        gshhs_land_geoms=gshhs_land_geoms if used_gshhs else None,
        gshhs_lake_geoms=gshhs_lake_geoms if used_gshhs else None,
    )

    # 4. Custom GeoJSON layers
    _draw_custom_geojson_layers(ax, spec)

    # 5. International borders
    if spec.layers.showBorders:
        _add_ne_layer_bbox(
            ax,
            spec,
            "cultural",
            "admin_0_boundary_lines_land",
            ne_scale,
            facecolor="none",
            edgecolor=border_color,
            linewidth=spec.layers.borderWidth,
            linestyle=_BORDER_STYLE_MAP.get(spec.layers.borderStyle, "-"),
            zorder=5,
        )

    # 5b. True-size geodesic region comparison shadows
    _draw_region_shadows(ax, spec, ne_scale, proj, limits)

    # 6. Graticule
    _draw_graticule(ax, spec)

    # 7. Cities & labels
    _draw_cities(fig, ax, spec, proj, limits)

    # 8. Ornaments & Title Banner
    has_title = _draw_title_banner(fig, spec)
    _draw_scale_bar(fig, ax, spec, proj, limits, has_title)
    _draw_locator_globe(fig, spec, ne_scale, has_title, proj=proj, limits=limits)
    _draw_north_arrow(fig, spec, has_title)
    _draw_legend(fig, ax, spec, has_title)

    # 9. Frame border
    geo_spine = ax.spines.get("geo")
    if geo_spine is not None:
        geo_spine.set_visible(spec.page.showFrameBorder)
        if spec.page.showFrameBorder:
            geo_spine.set_edgecolor(_valid_color(spec.colors.text, "#111111"))
            geo_spine.set_linewidth(1.0)

    return _export_figure(fig, fmt_lower, dpi)
