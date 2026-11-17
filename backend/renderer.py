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

from backend.schemas import CustomGeoJsonLayer, HighlightedCountry, MapSpec

logger = logging.getLogger(__name__)

_NE_LOCK = threading.RLock()
_WARMED_NE_FEATURES: set[tuple[str, str, str]] = set()
_COUNTRIES_CACHE: dict[str, tuple[tuple[Any, dict[str, str]], ...]] = {}

_EARTH_RADIUS_M = 6_370_997.0
_SCALE_FALLBACK_ORDER: dict[str, tuple[str, ...]] = {
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
    """Resolve Natural Earth dataset scale ('10m', '50m', or '110m') from MapSpec."""
    if spec.detailLevel in ("10m", "50m", "110m"):
        return spec.detailLevel
    max_span = max(spec.span.lonDeg, spec.span.latDeg)
    if max_span <= 22.0 and spec.projection != "orthographic":
        return "10m"
    if max_span <= 90.0:
        return "50m"
    return "110m"


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
        "Esri.WorldShadedRelief": cx.providers.Esri.WorldShadedRelief,
        "Esri.WorldImagery": cx.providers.Esri.WorldImagery,
    }
    return providers.get(name)


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


def _draw_highlighted_countries(ax: Any, spec: MapSpec, scale: str) -> None:
    """Render highlighted country fills, strokes, and hatches."""
    if not spec.highlightedCountries:
        return
    countries = _load_countries_index(scale)
    if not countries:
        return

    geodetic = ccrs.PlateCarree()
    target_proj = ax.projection
    for hc in spec.highlightedCountries:
        geoms = _match_country_geometries(hc, countries)
        if not geoms:
            continue
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
        if spec.projection != "orthographic":
            try:
                projected = []
                for g in geoms:
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

        ax.add_geometries(geoms, **kwargs)


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
    halo_effect = [patheffects.withStroke(linewidth=2.5, foreground=halo_color)]

    for city in spec.cities:
        px, py = proj.transform_point(city.lon, city.lat, geodetic)
        if not (math.isfinite(px) and math.isfinite(py)):
            continue
        if not (xmin <= px <= xmax and ymin <= py <= ymax):
            continue

        if city.style == "capital":
            ax.plot(
                [px],
                [py],
                marker="o",
                markersize=6.8,
                markerfacecolor=halo_color,
                markeredgecolor=text_color,
                markeredgewidth=1.4,
                transform=ax.transData,
                clip_on=True,
                zorder=7,
            )
            ax.plot(
                [px],
                [py],
                marker="o",
                markersize=2.6,
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
                markersize=4.8,
                markerfacecolor=text_color,
                markeredgecolor=halo_color,
                markeredgewidth=0.8,
                transform=ax.transData,
                clip_on=True,
                zorder=7,
            )
        elif city.style == "dot":
            ax.plot(
                [px],
                [py],
                marker="o",
                markersize=4.8,
                markerfacecolor=text_color,
                markeredgecolor=halo_color,
                markeredgewidth=0.8,
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
            label_transform = offset_copy(
                ax.transData, fig=fig, x=city.dx, y=-city.dy, units="points"
            )
            ax.text(
                px,
                py,
                city.name,
                transform=label_transform,
                ha=ha,
                va="center",
                fontsize=9.0 if city.style == "capital" else 8.0,
                fontweight="bold" if city.style == "capital" else "medium",
                color=text_color,
                path_effects=halo_effect,
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


def resolve_locator_globe_zoom(spec: MapSpec) -> float:
    """Compute effective locator globe zoom factor matching site/js/ornaments.js."""
    cfg = spec.ornaments.locatorGlobe
    mode = cfg.zoomMode
    if mode == "hemisphere":
        return 1.0
    if mode == "nearside":
        return 1.8
    if mode == "custom":
        return max(1.0, min(6.0, float(cfg.zoom)))
    max_span = max(float(spec.span.lonDeg), float(spec.span.latDeg))
    return max(1.0, min(4.2, 56.0 / max(6.0, max_span)))


def _draw_locator_globe(
    fig: Figure, spec: MapSpec, scale: str, has_title: bool
) -> None:
    """Render an orthographic or nearside satellite inset globe showing center and extent box."""
    cfg = spec.ornaments.locatorGlobe
    if not cfg.enabled:
        return

    side_in = (cfg.sizePct / 100.0) * min(spec.page.widthIn, spec.page.heightIn)
    x0, y0, w, h = _corner_inset_rect(spec, cfg.position, side_in, has_title)

    effective_zoom = resolve_locator_globe_zoom(spec)
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

    if cfg.showExtentBox:
        dlon = min(spec.span.lonDeg * 0.5, 179.0)
        dlat = min(spec.span.latDeg * 0.5, 85.0)
        lon_w = spec.center.lon - dlon
        lon_e = spec.center.lon + dlon
        lat_s = max(-85.0, spec.center.lat - dlat)
        lat_n = min(85.0, spec.center.lat + dlat)

        # Sample polygon perimeter so great-circle edges curve accurately on the globe
        steps = 12
        ring_lons: list[float] = []
        ring_lats: list[float] = []
        for t in np.linspace(0.0, 1.0, steps, endpoint=False):
            ring_lons.append(lon_w + t * (lon_e - lon_w))
            ring_lats.append(lat_s)
        for t in np.linspace(0.0, 1.0, steps, endpoint=False):
            ring_lons.append(lon_e)
            ring_lats.append(lat_s + t * (lat_n - lat_s))
        for t in np.linspace(0.0, 1.0, steps, endpoint=False):
            ring_lons.append(lon_e - t * (lon_e - lon_w))
            ring_lats.append(lat_n)
        for t in np.linspace(0.0, 1.0, steps, endpoint=False):
            ring_lons.append(lon_w)
            ring_lats.append(lat_n - t * (lat_n - lat_s))

        if max(spec.span.lonDeg, spec.span.latDeg) < 120.0:
            try:
                inset_ax.fill(
                    ring_lons,
                    ring_lats,
                    transform=ccrs.Geodetic(),
                    facecolor="#e11d48",
                    alpha=0.25,
                    zorder=5,
                )
                inset_ax.plot(
                    ring_lons + [ring_lons[0]],
                    ring_lats + [ring_lats[0]],
                    transform=ccrs.Geodetic(),
                    color="#e11d48",
                    linewidth=1.35,
                    zorder=5.5,
                )
            except Exception as exc:
                logger.debug("Geodetic extent box fallback on locator globe: %s", exc)
                pts = globe_proj.transform_points(
                    ccrs.PlateCarree(),
                    np.asarray(ring_lons + [ring_lons[0]], dtype=float),
                    np.asarray(ring_lats + [ring_lats[0]], dtype=float),
                )
                xs = pts[:, 0]
                ys = pts[:, 1]
                valid = np.isfinite(xs) & np.isfinite(ys)
                if np.all(valid):
                    inset_ax.fill(
                        xs[:-1],
                        ys[:-1],
                        facecolor="#e11d48",
                        alpha=0.25,
                        zorder=5,
                    )
                    inset_ax.plot(
                        xs,
                        ys,
                        color="#e11d48",
                        linewidth=1.35,
                        zorder=5.5,
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
                                    color="#e11d48",
                                    linewidth=1.35,
                                    zorder=5.5,
                                )
                            start = None
                    if start is not None and len(valid) - start >= 2:
                        inset_ax.plot(
                            xs[start:],
                            ys[start:],
                            color="#e11d48",
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

    fig.patch.set_facecolor(water_color)
    proj = _build_projection(spec)
    ax = fig.add_axes([0.0, 0.0, 1.0, 1.0], projection=proj)
    ax.set_facecolor(water_color)

    limits = _configure_extent(ax, spec, proj)
    scale = resolve_scale(spec)

    # 1. Optional Contextily basemap underlay
    basemap_active = _add_basemap_underlay(ax, spec, proj)

    # 2. Vector base layers (skip opaque ocean/land fills when basemap is active)
    if not basemap_active:
        _add_ne_layer(
            ax, "physical", "ocean", scale, facecolor=water_color, edgecolor="none", zorder=1
        )
        _add_ne_layer(
            ax, "physical", "land", scale, facecolor=land_color, edgecolor="none", zorder=2
        )
        if spec.layers.showLakes:
            _add_ne_layer(
                ax,
                "physical",
                "lakes",
                scale,
                facecolor=water_color,
                edgecolor=coast_color if spec.layers.showCoastlines else "none",
                linewidth=spec.layers.coastlineWidth * 0.7,
                zorder=2.5,
            )

    if spec.layers.showRivers:
        _add_ne_layer(
            ax,
            "physical",
            "rivers_lake_centerlines",
            scale,
            facecolor="none",
            edgecolor=river_color,
            linewidth=spec.layers.riverWidth,
            zorder=3,
        )

    if spec.layers.showCoastlines:
        _add_ne_layer(
            ax,
            "physical",
            "coastline",
            scale,
            facecolor="none",
            edgecolor=coast_color,
            linewidth=spec.layers.coastlineWidth,
            zorder=3.2,
        )

    if spec.layers.showAdmin1:
        _add_ne_layer(
            ax,
            "cultural",
            "admin_1_states_provinces_lines",
            scale,
            facecolor="none",
            edgecolor=admin1_color,
            linewidth=0.6,
            linestyle=":",
            alpha=0.85,
            zorder=3.5,
        )

    # 3. Highlighted countries
    _draw_highlighted_countries(ax, spec, scale)

    # 4. Custom GeoJSON layers
    _draw_custom_geojson_layers(ax, spec)

    # 5. International borders
    if spec.layers.showBorders:
        _add_ne_layer(
            ax,
            "cultural",
            "admin_0_boundary_lines_land",
            scale,
            facecolor="none",
            edgecolor=border_color,
            linewidth=spec.layers.borderWidth,
            linestyle=_BORDER_STYLE_MAP.get(spec.layers.borderStyle, "-"),
            zorder=5,
        )

    # 6. Graticule
    _draw_graticule(ax, spec)

    # 7. Cities & labels
    _draw_cities(fig, ax, spec, proj, limits)

    # 8. Ornaments & Title Banner
    has_title = _draw_title_banner(fig, spec)
    _draw_scale_bar(fig, ax, spec, proj, limits, has_title)
    _draw_locator_globe(fig, spec, scale, has_title)
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
