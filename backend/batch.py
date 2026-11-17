"""Concurrent batch map rendering and ZIP bundling for Dusty's Map Studio."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import io
import os
import zipfile

from backend.renderer import render_map, sanitize_filename
from backend.schemas import BatchRenderRequest, MapSpec

_MAX_BATCH_WORKERS = 4
_KNOWN_EXTS = {".png", ".jpeg", ".jpg", ".pdf", ".svg"}


def _clone_with_borders(spec: MapSpec, show_borders: bool) -> MapSpec:
    """Return a deep copy of spec with layers.showBorders set explicitly."""
    cloned = spec.model_copy(deep=True)
    cloned.layers.showBorders = show_borders
    return cloned


def _strip_image_ext(name: str) -> str:
    """Remove a trailing image extension so format suffixes never double up."""
    root, ext = os.path.splitext(name.strip())
    if ext.lower() in _KNOWN_EXTS and root:
        return root
    return name


def _unique_stem(stem: str, used: set[str]) -> str:
    """Return a unique filename stem within a ZIP archive."""
    if stem not in used:
        used.add(stem)
        return stem
    idx = 2
    while f"{stem}_{idx}" in used:
        idx += 1
    unique = f"{stem}_{idx}"
    used.add(unique)
    return unique


def _build_render_jobs(req: BatchRenderRequest) -> list[tuple[str, MapSpec]]:
    """Expand BatchRenderRequest into ordered (filename_stem, MapSpec) render jobs."""
    jobs: list[tuple[str, MapSpec]] = []
    used_stems: set[str] = set()

    if req.includeBorderPair and req.spec is not None and not req.items:
        base = sanitize_filename(req.spec.title)
        jobs.append((_unique_stem(f"{base}_with_borders", used_stems), _clone_with_borders(req.spec, True)))
        jobs.append((_unique_stem(f"{base}_no_borders", used_stems), _clone_with_borders(req.spec, False)))
        return jobs

    if req.items:
        for idx, item in enumerate(req.items):
            raw_name = item.filename or item.spec.title or f"map_{idx + 1}"
            base = sanitize_filename(_strip_image_ext(raw_name), fallback=f"map_{idx + 1}")
            if req.includeBorderPair:
                jobs.append((_unique_stem(f"{base}_with_borders", used_stems), _clone_with_borders(item.spec, True)))
                jobs.append((_unique_stem(f"{base}_no_borders", used_stems), _clone_with_borders(item.spec, False)))
            else:
                jobs.append((_unique_stem(base, used_stems), item.spec))
        return jobs

    if req.spec is not None:
        base = sanitize_filename(req.spec.title)
        if req.includeBorderPair:
            jobs.append((_unique_stem(f"{base}_with_borders", used_stems), _clone_with_borders(req.spec, True)))
            jobs.append((_unique_stem(f"{base}_no_borders", used_stems), _clone_with_borders(req.spec, False)))
        else:
            jobs.append((_unique_stem(base, used_stems), req.spec))
        return jobs

    raise ValueError("BatchRenderRequest requires either 'items' or 'spec'.")


def render_batch_zip(req: BatchRenderRequest) -> bytes:
    """Render all requested maps concurrently and bundle images + spec JSONs into a ZIP."""
    jobs = _build_render_jobs(req)
    fmt = req.format
    ext = fmt

    def _render_one(job: tuple[str, MapSpec]) -> tuple[str, bytes, bytes]:
        stem, item_spec = job
        image_bytes = render_map(item_spec, fmt=fmt)
        spec_bytes = item_spec.model_dump_json(indent=2).encode("utf-8")
        return stem, image_bytes, spec_bytes

    worker_count = min(_MAX_BATCH_WORKERS, max(1, len(jobs)))
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        results = list(pool.map(_render_one, jobs))

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for stem, image_bytes, spec_bytes in results:
            zf.writestr(f"{stem}.{ext}", image_bytes)
            zf.writestr(f"{stem}.spec.json", spec_bytes)

    return zip_buf.getvalue()
