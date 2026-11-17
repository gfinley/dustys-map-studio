"""Integration tests for Dusty's Map Studio FastAPI + Cartopy backend."""

from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import sys
import unittest
import zipfile

from fastapi.testclient import TestClient
from PIL import Image

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app import app  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
