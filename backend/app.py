"""FastAPI application serving Dusty's Map Studio Pro Cartopy backend & static UI."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import anyio
from fastapi import Body, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import requests

from backend.batch import render_batch_zip
from backend.renderer import inspect_geojson, render_map, sanitize_filename
from backend.schemas import BatchRenderRequest, MapSpec

_MIME_TYPES: dict[str, str] = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "pdf": "application/pdf",
    "svg": "image/svg+xml",
}
_GEOJSON_ROOT_TYPES = {
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

app = FastAPI(
    title="Dusty's Map Studio Pro Engine",
    version="1.0.0",
    description="High-DPI Cartopy + GeoPandas map rendering backend.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health_check() -> dict[str, Any]:
    """Report backend readiness and supported export formats."""
    return {
        "status": "ok",
        "engine": "cartopy-geopandas",
        "formats": ["png", "jpeg", "pdf", "svg"],
    }


@app.post("/api/render")
async def render_single_map(
    spec: MapSpec,
    format: Literal["png", "jpeg", "pdf", "svg"] = Query(default="png"),
) -> Response:
    """Render a single MapSpec to PNG, JPEG, PDF, or SVG."""
    try:
        payload = await anyio.to_thread.run_sync(render_map, spec, format)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Map render failed: {exc}") from exc

    stem = sanitize_filename(spec.title)
    filename = f"{stem}.{format}"
    return Response(
        content=payload,
        media_type=_MIME_TYPES[format],
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Map-Width-Px": str(round(spec.page.widthIn * spec.page.dpi)),
            "X-Map-Height-Px": str(round(spec.page.heightIn * spec.page.dpi)),
        },
    )


@app.post("/api/render-batch")
async def render_batch_maps(req: BatchRenderRequest) -> Response:
    """Render a batch or border-pair of MapSpecs concurrently into a ZIP archive."""
    try:
        zip_bytes = await anyio.to_thread.run_sync(render_batch_zip, req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Batch render failed: {exc}") from exc

    stem = sanitize_filename(req.spec.title) if req.spec is not None else "dusty_maps_batch"
    filename = f"{stem}_batch.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/geojson-inspect")
async def geojson_inspect_endpoint(body: dict[str, Any] = Body(...)) -> JSONResponse:
    """Load, repair invalid geometries, and return metadata + repaired GeoJSON."""
    url: str | None = body.get("url") if isinstance(body.get("url"), str) else None
    data: dict[str, Any] | None = None
    if isinstance(body.get("data"), dict):
        data = body["data"]
    elif isinstance(body.get("geojson"), dict):
        data = body["geojson"]
    elif body.get("type") in _GEOJSON_ROOT_TYPES:
        data = body

    try:
        result = await anyio.to_thread.run_sync(inspect_geojson, url, data)
        return JSONResponse(status_code=200, content=result)
    except (ValueError, requests.RequestException) as exc:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "detail": str(exc)},
        )
    except Exception as exc:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "detail": f"GeoJSON inspection failed: {exc}"},
        )


SITE_DIR = Path(__file__).resolve().parent.parent / "site"
if SITE_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(SITE_DIR), html=True), name="site")
