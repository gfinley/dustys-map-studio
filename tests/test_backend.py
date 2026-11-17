"""Integration tests for Dusty's Map Studio FastAPI + Cartopy backend."""

from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET
import zipfile

from fastapi.testclient import TestClient
from matplotlib.figure import Figure
from PIL import Image

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app import app  # noqa: E402
from backend.renderer import (  # noqa: E402
    _build_projection,
    _compute_viewport_footprint,
    _configure_extent,
    _draw_cities,
    _unwrap_near,
    render_map,
)
from backend.schemas import BatchRenderRequest, MapSpec  # noqa: E402


def build_ukraine_briefing_spec() -> MapSpec:
    """Build Dusty's canonical 4.6 x 7.0 inch, 300 DPI Ukraine briefing specification."""
    return MapSpec.model_validate(
        {
            "version": 1,
            "title": "Ukraine Briefing Map",
            "showTitle": False,
            "projection": "mercator",
            "detailLevel": "auto",
            "center": {"lat": 48.5, "lon": 31.2},
            "span": {"lonDeg": 24.0, "latDeg": 14.0},
            "page": {
                "preset": "book_4_6x7",
                "widthIn": 4.6,
                "heightIn": 7.0,
                "dpi": 300,
                "showFrameBorder": True,
            },
            "theme": "dusty_prime",
            "highlightedCountries": [
                {
                    "id": "804",
                    "name": "Ukraine",
                    "fill": "#7a7d7a",
                    "stroke": "#ffffff",
                    "hatch": "none",
                }
            ],
            "cities": [
                {"id": "kyiv", "name": "Kyiv", "lat": 50.4501, "lon": 30.5234, "style": "capital", "dx": 6, "dy": -6},
                {"id": "lviv", "name": "Lviv", "lat": 49.8397, "lon": 24.0297, "style": "dot", "dx": 6, "dy": -5},
                {"id": "odesa", "name": "Odesa", "lat": 46.4825, "lon": 30.7233, "style": "dot", "dx": 6, "dy": 8},
                {"id": "kharkiv", "name": "Kharkiv", "lat": 49.9935, "lon": 36.2304, "style": "dot", "dx": 6, "dy": -5},
            ],
            "ornaments": {
                "scaleBar": {"enabled": True, "units": "km", "position": "bottom-left"},
                "locatorGlobe": {"enabled": True, "position": "top-right", "sizePct": 22.0, "showExtentBox": True},
                "northArrow": {"enabled": False, "position": "top-left"},
                "legend": {"enabled": False, "position": "bottom-right"},
            },
        }
    )


class TestBackendAPI(unittest.TestCase):
    """End-to-end API tests against backend.app:app."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._client_cm = TestClient(app)
        cls.client = cls._client_cm.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._client_cm.__exit__(None, None, None)

    def test_health_endpoint(self) -> None:
        """GET /api/health reports operational status and Cartopy engine identity."""
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("status"), "ok")
        self.assertEqual(payload.get("engine"), "cartopy-geopandas")

    def test_serves_static_site_root(self) -> None:
        """GET / serves the static browser studio HTML."""
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers.get("content-type", ""))
        self.assertTrue("Dusty" in response.text or "Map" in response.text)

    def test_render_ukraine_png_300dpi(self) -> None:
        """Ukraine briefing PNG renders at exact 1380x2100 pixel dimensions and 300 DPI."""
        spec = build_ukraine_briefing_spec()
        response = self.client.post("/api/render?format=png", json=spec.model_dump())
        self.assertEqual(response.status_code, 200)

        with Image.open(BytesIO(response.content)) as img:
            self.assertEqual(img.format, "PNG")
            self.assertEqual(img.size, (1380, 2100))
            dpi = img.info.get("dpi")
            self.assertIsNotNone(dpi)
            self.assertEqual(round(dpi[0]), 300)
            self.assertEqual(round(dpi[1]), 300)

    def test_render_alaska_russia_dateline_jpeg(self) -> None:
        """Anti-meridian Bering/Alaska-Russia view renders cleanly to 150 DPI JPEG."""
        spec = MapSpec.model_validate(
            {
                "title": "Alaska-Russia Dateline",
                "center": {"lat": 60.0, "lon": -168.6},
                "span": {"lonDeg": 80.0, "latDeg": 25.0},
                "page": {
                    "preset": "book_landscape",
                    "widthIn": 7.0,
                    "heightIn": 4.6,
                    "dpi": 150,
                },
            }
        )
        response = self.client.post("/api/render?format=jpeg", json=spec.model_dump())
        self.assertEqual(response.status_code, 200)

        with Image.open(BytesIO(response.content)) as img:
            self.assertEqual(img.format, "JPEG")
            self.assertEqual(img.size, (1050, 690))
            dpi = img.info.get("dpi")
            self.assertIsNotNone(dpi)
            self.assertEqual(round(dpi[0]), 150)
            self.assertEqual(round(dpi[1]), 150)

    def test_render_pdf_and_svg(self) -> None:
        """Default MapSpec exports valid vector PDF and SVG documents."""
        payload = MapSpec().model_dump()

        pdf_resp = self.client.post("/api/render?format=pdf", json=payload)
        self.assertEqual(pdf_resp.status_code, 200)
        self.assertTrue(pdf_resp.content.startswith(b"%PDF-"))

        svg_resp = self.client.post("/api/render?format=svg", json=payload)
        self.assertEqual(svg_resp.status_code, 200)
        self.assertIn("<svg", svg_resp.text)

    def test_render_custom_geojson_invalid_polygon_repair(self) -> None:
        """Self-intersecting bowtie GeoJSON polygons are repaired via make_valid without crashing."""
        bowtie_geojson = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"name": "Bowtie Polygon"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [28.0, 47.0],
                                [34.0, 50.0],
                                [34.0, 47.0],
                                [28.0, 50.0],
                                [28.0, 47.0],
                            ]
                        ],
                    },
                }
            ],
        }
        spec = MapSpec.model_validate(
            {
                "page": {"widthIn": 4.6, "heightIn": 7.0, "dpi": 100},
                "customGeoJsonLayers": [
                    {
                        "id": "bowtie",
                        "label": "Bowtie Overlay",
                        "data": bowtie_geojson,
                        "visible": True,
                        "color": "#cc3300",
                        "fillOpacity": 0.4,
                        "strokeWidth": 1.5,
                    }
                ],
            }
        )
        response = self.client.post("/api/render?format=png", json=spec.model_dump())
        self.assertEqual(response.status_code, 200)
        with Image.open(BytesIO(response.content)) as img:
            self.assertEqual(img.format, "PNG")
            self.assertEqual(img.size, (460, 700))

    def test_render_batch_border_pair_zip(self) -> None:
        """POST /api/render-batch with includeBorderPair=True returns a ZIP with 2 PNGs and JSON sidecar(s)."""
        batch_spec = MapSpec.model_validate(
            {
                "title": "Ukraine Pair",
                "page": {"widthIn": 4.6, "heightIn": 7.0, "dpi": 100},
            }
        )
        req = BatchRenderRequest(format="png", includeBorderPair=True, spec=batch_spec)
        response = self.client.post("/api/render-batch", json=req.model_dump())
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/zip", response.headers.get("content-type", ""))

        with zipfile.ZipFile(BytesIO(response.content), "r") as zf:
            names = zf.namelist()
            png_names = [name for name in names if name.lower().endswith(".png")]
            json_names = [name for name in names if name.lower().endswith(".json")]

            self.assertEqual(len(png_names), 2, f"Expected 2 PNGs in ZIP, got: {names}")
            self.assertTrue(
                any("with_borders" in name for name in png_names),
                f"Expected a 'with_borders' PNG in {png_names}",
            )
            self.assertTrue(
                any("no_borders" in name for name in png_names),
                f"Expected a 'no_borders' PNG in {png_names}",
            )
            self.assertGreaterEqual(len(json_names), 1, f"Expected JSON sidecar(s) in {names}")

            for png_name in png_names:
                with Image.open(BytesIO(zf.read(png_name))) as img:
                    self.assertEqual(img.format, "PNG")
                    self.assertEqual(img.size, (460, 700))

            for json_name in json_names:
                parsed = json.loads(zf.read(json_name).decode("utf-8"))
                self.assertIsInstance(parsed, (dict, list))

    def test_high_latitude_portrait_viewport_footprint_and_antimeridian(self) -> None:
        """Portrait high-latitude viewport footprint captures aspect expansion and antimeridian renders cleanly."""
        alaska_spec = MapSpec.model_validate(
            {
                "title": "Portrait Alaska",
                "projection": "mercator",
                "center": {"lat": 61.5, "lon": -154.0},
                "span": {"lonDeg": 15.0, "latDeg": 18.0},
                "page": {"widthIn": 4.6, "heightIn": 7.0, "dpi": 100},
            }
        )
        fig = Figure(figsize=(alaska_spec.page.widthIn, alaska_spec.page.heightIn), dpi=100)
        proj = _build_projection(alaska_spec)
        ax = fig.add_axes([0.0, 0.0, 1.0, 1.0], projection=proj)
        limits = _configure_extent(ax, alaska_spec, proj)
        ring_lons, ring_lats, can_fill, _ = _compute_viewport_footprint(
            alaska_spec, proj, limits
        )
        unwrapped = [_unwrap_near(lon, alaska_spec.center.lon) for lon in ring_lons]
        self.assertGreater(max(unwrapped) - min(unwrapped), 24.0)
        self.assertTrue(can_fill)
        self.assertEqual(len(ring_lons), len(ring_lats))

        alaska_png = render_map(alaska_spec, "png")
        self.assertTrue(alaska_png.startswith(b"\x89PNG"))

        bering_spec = MapSpec.model_validate(
            {
                "title": "Bering Strait Antimeridian",
                "projection": "mercator",
                "center": {"lat": 63.0, "lon": -172.0},
                "span": {"lonDeg": 18.0, "latDeg": 16.0},
                "page": {"widthIn": 4.6, "heightIn": 7.0, "dpi": 100},
                "ornaments": {"locatorGlobe": {"enabled": True, "showExtentBox": True}},
            }
        )
        bering_png = render_map(bering_spec, "png")
        self.assertTrue(bering_png.startswith(b"\x89PNG"))

    def test_city_label_and_icon_scaling_render(self) -> None:
        """PNG and SVG render cleanly with global cityLabelScale/cityIconScale and per-city scale."""
        spec = MapSpec.model_validate(
            {
                "title": "Scaled City Labels and Icons",
                "projection": "mercator",
                "center": {"lat": 48.5, "lon": 31.2},
                "span": {"lonDeg": 24.0, "latDeg": 14.0},
                "page": {"widthIn": 4.6, "heightIn": 7.0, "dpi": 100},
                "layers": {"cityLabelScale": 2.2, "cityIconScale": 2.0},
                "cities": [
                    {
                        "id": "kyiv",
                        "name": "Kyiv",
                        "lat": 50.4501,
                        "lon": 30.5234,
                        "style": "capital",
                        "dx": 6,
                        "dy": -6,
                        "scale": 1.5,
                    },
                    {
                        "id": "lviv",
                        "name": "Lviv",
                        "lat": 49.8397,
                        "lon": 24.0297,
                        "style": "dot",
                        "dx": 6,
                        "dy": -5,
                        "scale": 0.6,
                    },
                    {
                        "id": "odesa",
                        "name": "Odesa",
                        "lat": 46.4825,
                        "lon": 30.7233,
                        "style": "bullseye",
                        "dx": 6,
                        "dy": 8,
                        "scale": 1.0,
                    },
                ],
            }
        )

        # Verify scaled marker and text artist sizes directly
        fig = Figure(figsize=(spec.page.widthIn, spec.page.heightIn), dpi=100)
        proj = _build_projection(spec)
        ax = fig.add_axes([0.0, 0.0, 1.0, 1.0], projection=proj)
        limits = _configure_extent(ax, spec, proj)
        _draw_cities(fig, ax, spec, proj, limits)

        self.assertEqual([t.get_text() for t in ax.texts], ["Kyiv", "Lviv", "Odesa"])
        self.assertAlmostEqual(ax.texts[0].get_fontsize(), 9.0 * 2.2 * 1.5)
        self.assertEqual(ax.texts[0].get_fontweight(), "bold")
        self.assertAlmostEqual(ax.texts[1].get_fontsize(), 8.0 * 2.2 * 0.6)
        self.assertEqual(ax.texts[1].get_fontweight(), "medium")
        self.assertAlmostEqual(ax.texts[2].get_fontsize(), 9.0 * 2.2 * 1.0)
        self.assertEqual(ax.texts[2].get_fontweight(), "bold")
        self.assertEqual(len(ax.lines), 5)
        self.assertEqual(ax.lines[0].get_marker(), "*")
        self.assertEqual(ax.lines[1].get_marker(), "*")
        self.assertAlmostEqual(ax.lines[0].get_markersize(), 10.5 * 2.0 * 1.5)
        self.assertAlmostEqual(ax.lines[1].get_markersize(), 10.5 * 2.0 * 1.5)
        self.assertEqual(ax.lines[2].get_marker(), "o")
        self.assertAlmostEqual(ax.lines[2].get_markersize(), 4.8 * 2.0 * 0.6)
        self.assertEqual(ax.lines[3].get_marker(), "o")
        self.assertEqual(ax.lines[4].get_marker(), "o")
        self.assertAlmostEqual(ax.lines[3].get_markersize(), 6.8 * 2.0 * 1.0)
        self.assertAlmostEqual(ax.lines[4].get_markersize(), 2.6 * 2.0 * 1.0)

        # Verify PNG export header and pixel dimensions
        png_bytes = render_map(spec, "png")
        self.assertTrue(png_bytes.startswith(b"\x89PNG"))
        with Image.open(BytesIO(png_bytes)) as img:
            self.assertEqual(img.format, "PNG")
            self.assertEqual(img.size, (460, 700))

        # Verify valid <svg XML and city label vector text groups (Matplotlib renders
        # haloed path_effects text as <g id="text_N"> <path/> groups rather than <text> tags)
        svg_bytes = render_map(spec, "svg")
        svg_text = svg_bytes.decode("utf-8")
        self.assertIn("<svg", svg_text)
        svg_root = ET.fromstring(svg_bytes)
        self.assertTrue(svg_root.tag.endswith("svg"))

        text_groups = [
            el for el in svg_root.iter() if (el.attrib.get("id") or "").startswith("text_")
        ]
        baseline_svg = render_map(spec.model_copy(update={"cities": []}), "svg")
        baseline_root = ET.fromstring(baseline_svg)
        baseline_text_groups = [
            el for el in baseline_root.iter() if (el.attrib.get("id") or "").startswith("text_")
        ]
        self.assertEqual(len(text_groups), len(baseline_text_groups) + len(spec.cities))
        for city_group_id in ("text_1", "text_2", "text_3"):
            group_el = svg_root.find(f".//*[@id='{city_group_id}']")
            self.assertIsNotNone(group_el, f"Missing city label SVG group {city_group_id}")
            self.assertTrue(
                any(child.tag.endswith("path") for child in group_el.iter()),
                f"Expected vector path glyphs inside {city_group_id}",
            )


if __name__ == "__main__":
    unittest.main()
