"""Schema contract, relative-asset, and DPI metadata tests for Dusty's Map Studio."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import re
import sys
import unittest

from PIL import Image

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.schemas import BatchRenderRequest, MapSpec  # noqa: E402


SITE_DIR = ROOT_DIR / "site"
SCHEMA_JS_PATH = SITE_DIR / "js" / "schema.js"
INDEX_HTML_PATH = SITE_DIR / "index.html"


def inspect_image_dpi(image_bytes: bytes) -> tuple[str | None, tuple[int, int], tuple[int, int] | None]:
    """Read image format, pixel size, and rounded (x, y) DPI from encoded bytes."""
    with Image.open(BytesIO(image_bytes)) as img:
        raw_dpi = img.info.get("dpi")
        rounded_dpi = (round(raw_dpi[0]), round(raw_dpi[1])) if raw_dpi else None
        return img.format, img.size, rounded_dpi


class TestSchemaAndStaticAssets(unittest.TestCase):
    """Verify JS/Python schema parity, GitHub Pages relative paths, and DPI round-tripping."""

    def test_map_spec_defaults(self) -> None:
        """Default MapSpec matches Dusty's 4.6 x 7.0 inch, 300 DPI Ukraine baseline."""
        spec = MapSpec()
        self.assertEqual(spec.version, 1)
        self.assertEqual(spec.title, "Ukraine Briefing Map")
        self.assertEqual(spec.projection, "mercator")
        self.assertAlmostEqual(spec.center.lat, 48.5)
        self.assertAlmostEqual(spec.center.lon, 31.2)
        self.assertAlmostEqual(spec.span.lonDeg, 24.0)
        self.assertAlmostEqual(spec.span.latDeg, 14.0)
        self.assertEqual(spec.page.preset, "book_4_6x7")
        self.assertAlmostEqual(spec.page.widthIn, 4.6)
        self.assertAlmostEqual(spec.page.heightIn, 7.0)
        self.assertEqual(spec.page.dpi, 300)
        self.assertTrue(spec.layers.showBorders)
        self.assertAlmostEqual(spec.layers.cityLabelScale, 1.0)
        self.assertAlmostEqual(spec.layers.cityIconScale, 1.0)
        self.assertTrue(spec.ornaments.scaleBar.enabled)
        self.assertEqual(spec.ornaments.scaleBar.units, "km")
        self.assertTrue(spec.ornaments.locatorGlobe.enabled)
        self.assertEqual(spec.ornaments.locatorGlobe.position, "top-right")

    def test_map_spec_camelcase_payload_parsing(self) -> None:
        """CamelCase JSON payloads from site/js/schema.js validate cleanly into MapSpec."""
        payload = {
            "version": 1,
            "title": "Ukraine Briefing Map",
            "showTitle": True,
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
                    "hatch": "diagonal",
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
                "locatorGlobe": {"enabled": True, "position": "top-right", "sizePct": 22, "showExtentBox": True},
                "northArrow": {"enabled": True, "position": "top-left"},
                "legend": {"enabled": False, "position": "bottom-right"},
            },
            "unknownFutureField": "ignored-safely",
        }

        spec = MapSpec.model_validate(payload)
        self.assertTrue(spec.showTitle)
        self.assertAlmostEqual(spec.page.widthIn, 4.6)
        self.assertAlmostEqual(spec.page.heightIn, 7.0)
        self.assertEqual(spec.page.dpi, 300)
        self.assertEqual(len(spec.highlightedCountries), 1)
        self.assertEqual(spec.highlightedCountries[0].name, "Ukraine")
        self.assertEqual(spec.highlightedCountries[0].hatch, "diagonal")
        self.assertEqual([c.name for c in spec.cities], ["Kyiv", "Lviv", "Odesa", "Kharkiv"])
        self.assertEqual(spec.cities[0].style, "capital")
        self.assertAlmostEqual(spec.cities[0].scale, 1.0)
        self.assertTrue(spec.ornaments.northArrow.enabled)

        batch_req = BatchRenderRequest.model_validate(
            {"format": "png", "includeBorderPair": True, "spec": payload}
        )
        self.assertTrue(batch_req.includeBorderPair)
        self.assertIsNotNone(batch_req.spec)

    def test_city_label_and_icon_scale_validation(self) -> None:
        """cityLabelScale, cityIconScale, and cities[].scale default to 1.0 and validate custom values."""
        default_spec = MapSpec.model_validate(
            {
                "cities": [
                    {
                        "id": "kyiv",
                        "name": "Kyiv",
                        "lat": 50.4501,
                        "lon": 30.5234,
                        "style": "capital",
                    }
                ]
            }
        )
        self.assertAlmostEqual(default_spec.layers.cityLabelScale, 1.0)
        self.assertAlmostEqual(default_spec.layers.cityIconScale, 1.0)
        self.assertAlmostEqual(default_spec.cities[0].scale, 1.0)

        custom_spec = MapSpec.model_validate(
            {
                "layers": {"cityLabelScale": 2.2, "cityIconScale": 1.8},
                "cities": [
                    {
                        "id": "kyiv",
                        "name": "Kyiv",
                        "lat": 50.4501,
                        "lon": 30.5234,
                        "style": "capital",
                        "scale": 1.5,
                    },
                    {
                        "id": "odesa",
                        "name": "Odesa",
                        "lat": 46.4825,
                        "lon": 30.7233,
                        "style": "bullseye",
                        "scale": 1.0,
                    },
                ],
            }
        )
        self.assertAlmostEqual(custom_spec.layers.cityLabelScale, 2.2)
        self.assertAlmostEqual(custom_spec.layers.cityIconScale, 1.8)
        self.assertAlmostEqual(custom_spec.cities[0].scale, 1.5)
        self.assertEqual(custom_spec.cities[0].style, "capital")
        self.assertEqual(custom_spec.cities[1].style, "bullseye")
        self.assertAlmostEqual(custom_spec.cities[1].scale, 1.0)

    def test_schema_js_exists_and_exports_contract(self) -> None:
        """site/js/schema.js exists and exports the shared presets, themes, and codec."""
        self.assertTrue(SCHEMA_JS_PATH.is_file(), f"Missing {SCHEMA_JS_PATH}")
        content = SCHEMA_JS_PATH.read_text(encoding="utf-8")

        expected_exports = [
            "export const PAGE_PRESETS",
            "export const COLOR_THEMES",
            "export function createDefaultMapSpec",
            "export function encodeSpecToHash",
            "export function decodeSpecFromHash",
        ]
        for symbol in expected_exports:
            self.assertIn(symbol, content)

        self.assertIn("widthIn: 4.6", content)
        self.assertIn("heightIn: 7.0", content)
        self.assertIn("dpi: 300", content)

    def test_index_html_uses_relative_paths(self) -> None:
        """site/index.html uses relative ./ asset paths compatible with GitHub Pages subpaths."""
        self.assertTrue(INDEX_HTML_PATH.is_file(), f"Missing {INDEX_HTML_PATH}")
        html = INDEX_HTML_PATH.read_text(encoding="utf-8")

        self.assertIn("./styles/main.css", html)
        self.assertIn("./js/app.js", html)

        root_relative_matches = re.findall(r"""["'](/(?:styles|js)/[^"']*)["']""", html)
        self.assertEqual(
            root_relative_matches,
            [],
            f"Found root-relative asset paths that break GitHub Pages subpaths: {root_relative_matches}",
        )

    def test_pil_png_and_jpeg_300dpi_metadata_roundtrip(self) -> None:
        """Saving PNG and JPEG via PIL preserves 300 DPI metadata and exact pixel size."""
        width_px = round(4.6 * 300)
        height_px = round(7.0 * 300)
        canvas = Image.new("RGB", (width_px, height_px), color=(74, 74, 74))

        for fmt in ("PNG", "JPEG"):
            with self.subTest(format=fmt):
                buf = BytesIO()
                canvas.save(buf, format=fmt, dpi=(300, 300))
                detected_fmt, size, dpi = inspect_image_dpi(buf.getvalue())
                self.assertEqual(detected_fmt, fmt)
                self.assertEqual(size, (1380, 2100))
                self.assertEqual(dpi, (300, 300))

    def test_fidelity_and_region_shadow_schema_validation(self) -> None:
        """Ultra detail level, GSHHS coastline engine, fidelity layers, and regionShadows validate cleanly."""
        spec = MapSpec.model_validate(
            {
                "detailLevel": "ultra",
                "layers": {
                    "showMinorIslands": True,
                    "showBathymetry": True,
                    "showUrbanAreas": True,
                },
                "pro": {
                    "coastlineEngine": "gshhs_high",
                    "basemapProvider": "OpenTopoMap",
                    "basemapOpacity": 0.75,
                },
                "regionShadows": [
                    {
                        "id": "shadow_ukr_over_tx",
                        "sourceType": "country",
                        "sourceId": "804",
                        "sourceName": "Ukraine",
                        "targetLat": 31.2,
                        "targetLon": -99.5,
                        "rotationDeg": 15.0,
                        "fill": "#dc2626",
                        "stroke": "#7f1d1d",
                        "opacity": 0.4,
                        "dashed": True,
                        "hatch": "diagonal",
                        "showLabel": True,
                        "showArea": True,
                    },
                    {
                        "id": "shadow_tx_over_ukr",
                        "sourceType": "admin1",
                        "sourceId": "US-TX",
                        "sourceName": "Texas",
                        "targetLat": 48.5,
                        "targetLon": 31.2,
                        "rotationDeg": -20.0,
                    },
                ],
            }
        )
        self.assertEqual(spec.detailLevel, "ultra")
        self.assertTrue(spec.layers.showMinorIslands)
        self.assertTrue(spec.layers.showBathymetry)
        self.assertTrue(spec.layers.showUrbanAreas)
        self.assertEqual(spec.pro.coastlineEngine, "gshhs_high")
        self.assertEqual(spec.pro.basemapProvider, "OpenTopoMap")
        self.assertEqual(len(spec.regionShadows), 2)
        self.assertEqual(spec.regionShadows[0].sourceName, "Ukraine")
        self.assertAlmostEqual(spec.regionShadows[0].rotationDeg, 15.0)
        self.assertEqual(spec.regionShadows[1].sourceType, "admin1")
        self.assertEqual(spec.regionShadows[1].sourceName, "Texas")

    def test_shadow_js_exists_and_exports_contract(self) -> None:
        """site/js/shadow.js exists and exports spherical rotation and hit-test utilities."""
        shadow_js = SITE_DIR / "js" / "shadow.js"
        self.assertTrue(shadow_js.is_file(), f"Missing {shadow_js}")
        content = shadow_js.read_text(encoding="utf-8")
        for symbol in (
            "export function buildSphericalRotationMatrix",
            "export function computeRegionAreaKm2",
            "export function buildTransformedShadow",
            "export function hitTestShadow",
            "export function findUnderlyingCountryAt",
        ):
            self.assertIn(symbol, content)

    def test_1941_airfields_geojson_layers_and_presets(self) -> None:
        """1941 SE Asia & Western Pacific land airfield GeoJSON files are valid, disjoint, and wired into presets."""
        import json

        data_dir = SITE_DIR / "data"
        combined_path = data_dir / "airfields_1941_se_asia_western_pacific.geojson"
        military_path = data_dir / "airfields_1941_se_asia_western_pacific_military.geojson"
        civilian_path = data_dir / "airfields_1941_se_asia_western_pacific_civilian.geojson"

        for path in (combined_path, military_path, civilian_path):
            self.assertTrue(path.is_file(), f"Missing GeoJSON dataset: {path}")

        combined = json.loads(combined_path.read_text(encoding="utf-8"))
        military = json.loads(military_path.read_text(encoding="utf-8"))
        civilian = json.loads(civilian_path.read_text(encoding="utf-8"))

        for fc in (combined, military, civilian):
            self.assertEqual(fc.get("type"), "FeatureCollection")
            self.assertIsInstance(fc.get("features"), list)
            self.assertGreater(len(fc["features"]), 0)

        mil_ids = {f["id"] for f in military["features"]}
        civ_ids = {f["id"] for f in civilian["features"]}
        all_ids = {f["id"] for f in combined["features"]}

        self.assertEqual(mil_ids & civ_ids, set(), "Military and civilian layers must be disjoint")
        self.assertEqual(mil_ids | civ_ids, all_ids, "Military + civilian layers must equal combined dataset")
        self.assertEqual(len(military["features"]) + len(civilian["features"]), len(combined["features"]))

        expected_regions = {
            "Philippines",
            "Malaya & Singapore",
            "Borneo",
            "Dutch East Indies",
            "French Indochina",
            "Thailand",
        }
        seen_regions = set()
        for feat in combined["features"]:
            self.assertEqual(feat.get("type"), "Feature")
            geom = feat["geometry"]
            self.assertEqual(geom["type"], "Point")
            lon, lat = geom["coordinates"]
            self.assertTrue(94.0 <= lon <= 136.0, f"Unexpected lon for {feat['id']}: {lon}")
            self.assertTrue(-12.0 <= lat <= 23.0, f"Unexpected lat for {feat['id']}: {lat}")
            props = feat["properties"]
            self.assertEqual(props["airfield_type"], "land_airfield")
            self.assertIn(props["category"], {"military", "civilian"})
            seen_regions.add(props["region"])

        self.assertEqual(seen_regions, expected_regions)

        presets_js = (SITE_DIR / "js" / "presets.js").read_text(encoding="utf-8")
        self.assertIn("./data/airfields_1941_se_asia_western_pacific.geojson", presets_js)
        self.assertIn("./data/airfields_1941_se_asia_western_pacific_military.geojson", presets_js)
        self.assertIn("./data/airfields_1941_se_asia_western_pacific_civilian.geojson", presets_js)

    def test_interactive_feature_hover_and_info_card_contract(self) -> None:
        """Interactive GeoJSON point hover tooltip and info card hooks exist across JS and HTML."""
        cartography_js = (SITE_DIR / "js" / "cartography.js").read_text(encoding="utf-8")
        self.assertIn("export function hitTestGeoJsonPoint", cartography_js)

        app_js = (SITE_DIR / "js" / "app.js").read_text(encoding="utf-8")
        for symbol in ("hitTestGeoJsonPoint", "showFeatureHover", "showFeatureInfoCard"):
            self.assertIn(symbol, app_js)

        html = INDEX_HTML_PATH.read_text(encoding="utf-8")
        for elem_id in ("feature-hover-ring", "feature-hover-tooltip", "feature-info-card"):
            self.assertIn(f'id="{elem_id}"', html)

    def test_1942_1945_philippines_railways_and_historical_tab(self) -> None:
        """1942-1945 Philippines railway layers are valid and consolidated with 1941 airfields in the Historical tab."""
        import json

        rail_dir = SITE_DIR / "data" / "philippines_railways_1942_1945"
        expected_files = (
            "mrr_main_lines.geojson",
            "japanese_sudipen_extension.geojson",
            "mrr_branch_lines.geojson",
            "prc_panay_cebu.geojson",
            "manila_tranvia.geojson",
            "negros_industrial.geojson",
            "major_stations.geojson",
        )
        total_features = 0
        for fname in expected_files:
            fpath = rail_dir / fname
            self.assertTrue(fpath.is_file(), f"Missing railway GeoJSON: {fpath}")
            fc = json.loads(fpath.read_text(encoding="utf-8"))
            self.assertEqual(fc.get("type"), "FeatureCollection")
            self.assertGreater(len(fc.get("features", [])), 0)
            total_features += len(fc["features"])

        self.assertEqual(total_features, 129)

        presets_js = (SITE_DIR / "js" / "presets.js").read_text(encoding="utf-8")
        for symbol in (
            "export const AIRFIELD_1941_LAYERS",
            "export const PHILIPPINES_RAIL_1942_LAYERS",
            "philippines_railways_1942_1945",
            "philippines_wwii_combined",
        ):
            self.assertIn(symbol, presets_js)

        html = INDEX_HTML_PATH.read_text(encoding="utf-8")
        for elem_id in (
            "tab-historical",
            "airfield-1941-layers-list",
            "ph-rail-layers-list",
            "airfield-master-size",
            "ph-rail-master-width",
        ):
            self.assertIn(f'id="{elem_id}"', html)

    def test_alaska_baseline_preset(self) -> None:
        """Standalone Alaska baseline preset exists in presets.js and validates cleanly against MapSpec."""
        presets_js = (SITE_DIR / "js" / "presets.js").read_text(encoding="utf-8")
        self.assertIn("id: 'alaska'", presets_js)
        self.assertIn("label: 'Alaska'", presets_js)
        self.assertIn("id: 'alaska_russia_dateline'", presets_js)
        self.assertLess(
            presets_js.index("id: 'alaska'"),
            presets_js.index("id: 'alaska_russia_dateline'"),
        )

        alaska_spec = MapSpec.model_validate(
            {
                "version": 1,
                "title": "Alaska",
                "showTitle": False,
                "projection": "albers",
                "detailLevel": "auto",
                "center": {"lat": 61.8, "lon": -157.5},
                "span": {"lonDeg": 59.0, "latDeg": 24.0},
                "page": {
                    "preset": "book_landscape",
                    "widthIn": 7.0,
                    "heightIn": 4.6,
                    "dpi": 300,
                    "showFrameBorder": True,
                },
                "theme": "dusty_prime",
                "highlightedCountries": [
                    {
                        "id": "840",
                        "name": "United States of America",
                        "fill": "#7a7d7a",
                        "stroke": "#ffffff",
                        "hatch": "none",
                    }
                ],
                "cities": [
                    {"id": "juneau", "name": "Juneau", "lat": 58.3019, "lon": -134.4197, "style": "capital", "dx": 7, "dy": -4},
                    {"id": "anchorage", "name": "Anchorage", "lat": 61.2181, "lon": -149.9003, "style": "dot", "dx": 6, "dy": 6},
                    {"id": "fairbanks", "name": "Fairbanks", "lat": 64.8378, "lon": -147.7164, "style": "dot", "dx": 6, "dy": -5},
                    {"id": "nome", "name": "Nome", "lat": 64.5011, "lon": -165.4064, "style": "dot", "dx": -8, "dy": 6},
                ],
                "ornaments": {
                    "scaleBar": {"enabled": True, "units": "mi", "position": "bottom-left"},
                    "locatorGlobe": {"enabled": True, "position": "top-right", "sizePct": 22, "showExtentBox": True},
                },
            }
        )
        self.assertEqual(alaska_spec.projection, "albers")
        self.assertEqual(alaska_spec.page.preset, "book_landscape")
        self.assertEqual(len(alaska_spec.highlightedCountries), 1)
        self.assertEqual(alaska_spec.highlightedCountries[0].id, "840")
        self.assertEqual([c.name for c in alaska_spec.cities], ["Juneau", "Anchorage", "Fairbanks", "Nome"])


if __name__ == "__main__":
    unittest.main()
