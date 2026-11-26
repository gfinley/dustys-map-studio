#!/usr/bin/env python3
"""Build and validate year-by-year Alaska airfield GeoJSON layers (1939-1945) from master CSV.

Single source of truth:
    ``site/data/alaska_airfields_1939_1945/alaska_airfields_1939_1945.csv``

Generated outputs in ``site/data/alaska_airfields_1939_1945/``:
    - ``alaska_airfields_YYYY.geojson``          (Combined active operational airfields, YYYY=1939..1945)
    - ``alaska_airfields_YYYY_military.geojson`` (Military & dual-use active airfields, disjoint)
    - ``alaska_airfields_YYYY_civilian.geojson`` (Civilian-only active airfields, disjoint)
    - ``manifest.json``                          (Year-by-year progression summary & metadata)
    - ``PROOF_DOSSIER.md``                       (Human-review proof dossier generated from CSV)
"""

from __future__ import annotations

from collections import Counter
import csv
import json
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "site" / "data" / "alaska_airfields_1939_1945"
CSV_PATH = DATA_DIR / "alaska_airfields_1939_1945.csv"

YEARS = [1939, 1940, 1941, 1942, 1943, 1944, 1945]
VALID_STATUSES = {"none", "construction", "civilian", "dual_use", "military", "closed"}
ACTIVE_STATUSES = {"civilian", "dual_use", "military"}
VALID_FACILITY_TYPES = {"land_airfield", "amphibious_airstation", "seaplane_base"}
VALID_ORIGINS = {"civilian", "military", "dual_use"}
VALID_CONFIDENCE = {"verified", "high", "medium", "low"}

MARKER_COLORS = {
    "military": "#b91c1c",      # Crimson red
    "dual_use": "#d97706",      # Amber / gold
    "civilian": "#1d4ed8",      # Cobalt blue
    "construction": "#64748b",  # Slate
}


def _parse_int_or_none(val: str) -> int | None:
    raw = (val or "").strip()
    if not raw:
        return None
    return int(raw)


def _split_semicolon(val: str) -> list[str]:
    return [item.strip() for item in (val or "").split(";") if item.strip()]


def load_and_validate_csv(csv_path: Path = CSV_PATH) -> list[dict[str, Any]]:
    """Read and rigorously validate every row of the Alaska airfields master CSV."""
    if not csv_path.is_file():
        raise FileNotFoundError(f"Master CSV not found: {csv_path}")

    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        required_cols = {
            "id",
            "name",
            "latitude",
            "longitude",
            "region",
            "facility_type",
            "origin_category",
            "opened_date",
            "opened_year",
            "operator_1939_1945",
            "surface_wartime",
            "runway_specs",
            "strategic_role",
            "transition_notes",
            "modern_equivalent",
            "proof_summary",
            "primary_sources",
            "source_url",
            "confidence",
            *(f"status_{y}" for y in YEARS),
        }
        missing_cols = required_cols - set(reader.fieldnames or [])
        if missing_cols:
            raise ValueError(f"CSV missing required columns: {sorted(missing_cols)}")

        for line_num, raw in enumerate(reader, start=2):
            fid = (raw["id"] or "").strip()
            if not fid:
                raise ValueError(f"Row {line_num}: empty id")
            if fid in seen_ids:
                raise ValueError(f"Row {line_num}: duplicate id '{fid}'")
            seen_ids.add(fid)

            lat = float(raw["latitude"])
            lon = float(raw["longitude"])
            if not (51.0 <= lat <= 71.6):
                raise ValueError(f"{fid}: latitude {lat} outside Alaska bounds (51.0..71.6)")
            if not ((-180.0 <= lon <= -129.9) or (172.0 <= lon <= 180.0)):
                raise ValueError(
                    f"{fid}: longitude {lon} outside Alaska/Aleutian bounds (-180..-129.9 or 172..180)"
                )

            facility_type = raw["facility_type"].strip()
            if facility_type not in VALID_FACILITY_TYPES:
                raise ValueError(f"{fid}: invalid facility_type '{facility_type}'")

            origin_cat = raw["origin_category"].strip()
            if origin_cat not in VALID_ORIGINS:
                raise ValueError(f"{fid}: invalid origin_category '{origin_cat}'")

            confidence = raw["confidence"].strip()
            if confidence not in VALID_CONFIDENCE:
                raise ValueError(f"{fid}: invalid confidence '{confidence}'")

            if not raw["proof_summary"].strip():
                raise ValueError(f"{fid}: missing proof_summary")
            if not raw["primary_sources"].strip():
                raise ValueError(f"{fid}: missing primary_sources")

            statuses: dict[int, str] = {}
            for y in YEARS:
                st = (raw[f"status_{y}"] or "").strip()
                if st not in VALID_STATUSES:
                    raise ValueError(f"{fid}: invalid status_{y}='{st}'")
                statuses[y] = st

            rows.append(
                {
                    "id": fid,
                    "name": raw["name"].strip(),
                    "alternate_names": _split_semicolon(raw.get("alternate_names", "")),
                    "latitude": round(lat, 4),
                    "longitude": round(lon, 4),
                    "region": raw["region"].strip(),
                    "facility_type": facility_type,
                    "origin_category": origin_cat,
                    "opened_date": raw["opened_date"].strip(),
                    "opened_year": _parse_int_or_none(raw["opened_year"]),
                    "military_start_year": _parse_int_or_none(raw.get("military_start_year", "")),
                    "closed_year": _parse_int_or_none(raw.get("closed_year", "")),
                    "statuses": statuses,
                    "operator_1939_1945": raw["operator_1939_1945"].strip(),
                    "surface_wartime": raw["surface_wartime"].strip(),
                    "runway_specs": raw["runway_specs"].strip(),
                    "strategic_role": raw["strategic_role"].strip(),
                    "transition_notes": raw["transition_notes"].strip(),
                    "modern_equivalent": raw["modern_equivalent"].strip(),
                    "proof_summary": raw["proof_summary"].strip(),
                    "primary_sources": _split_semicolon(raw["primary_sources"]),
                    "source_url": raw["source_url"].strip(),
                    "confidence": confidence,
                }
            )

    return rows


def build_feature_for_year(record: dict[str, Any], year: int) -> dict[str, Any]:
    """Convert one CSV record into an RFC 7946 GeoJSON Feature for a given snapshot year."""
    year_status = record["statuses"][year]
    prev_status = record["statuses"].get(year - 1, "none")

    is_dual = year_status == "dual_use"
    category = "military" if year_status in {"military", "dual_use"} else "civilian"
    is_new_operational = (
        year > YEARS[0]
        and year_status in ACTIVE_STATUSES
        and prev_status not in ACTIVE_STATUSES
    )
    is_new_military = (
        year > YEARS[0]
        and year_status in {"military", "dual_use"}
        and prev_status not in {"military", "dual_use"}
    )

    timeline_summary = " · ".join(
        f"{str(y)[2:]}:{record['statuses'][y]}" for y in YEARS if record["statuses"][y] != "none"
    )

    props: dict[str, Any] = {
        "id": record["id"],
        "name": record["name"],
        "alternate_names": record["alternate_names"],
        "dataset": "alaska_airfields_1939_1945",
        "snapshot_year": year,
        "year_status": year_status,
        "category": category,
        "dual_use": is_dual,
        "airfield_type": record["facility_type"],
        "origin_category": record["origin_category"],
        "region": record["region"],
        "territory": "Territory of Alaska (USA)",
        "opened_date": record["opened_date"],
        "opened_year": record["opened_year"],
        "military_start_year": record["military_start_year"],
        "closed_year": record["closed_year"],
        "is_new_in_year": is_new_operational,
        "is_new_military_in_year": is_new_military,
        "operator_1939_1945": record["operator_1939_1945"],
        "surface_wartime": record["surface_wartime"],
        "runway_specs": record["runway_specs"],
        "strategic_role": record["strategic_role"],
        "timeline_1939_1945": timeline_summary,
        "notes": record["transition_notes"],
        "modern_equivalent": record["modern_equivalent"],
        "proof_summary": record["proof_summary"],
        "primary_sources": record["primary_sources"],
        "source_url": record["source_url"],
        "source_confidence": record["confidence"],
        "title": record["name"],
        "marker-color": MARKER_COLORS.get(year_status, "#1d4ed8"),
        "marker-symbol": "airport",
        "marker-size": "medium" if year_status == "military" else "small",
    }
    for y in YEARS:
        props[f"status_{y}"] = record["statuses"][y]

    return {
        "type": "Feature",
        "id": record["id"],
        "geometry": {
            "type": "Point",
            "coordinates": [record["longitude"], record["latitude"]],
        },
        "properties": props,
    }


def write_geojson(path: Path, features: list[dict[str, Any]], metadata: dict[str, Any]) -> None:
    fc = {
        "type": "FeatureCollection",
        "name": path.stem,
        "metadata": metadata,
        "features": features,
    }
    path.write_text(json.dumps(fc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_proof_dossier(rows: list[dict[str, Any]], year_summaries: dict[int, dict[str, int]]) -> None:
    """Write a human-readable Markdown proof dossier synced directly from the CSV."""
    lines: list[str] = [
        "# Alaska Airfields Progression (1939–1945) — Documentary Proof Dossier",
        "",
        f"Generated directly from [`alaska_airfields_1939_1945.csv`](alaska_airfields_1939_1945.csv) ({len(rows)} documented military, dual-use, and civilian airfields across 7 regions of Alaska).",
        "",
        "> **Interactive Visual Verification Workbench:** Open `site/review/alaska-airfields.html` (unlisted human-review console with satellite/topo tile inspection, locator pins, status approval, and Print-to-PDF export).",
        "",
        "## Annual Progression Summary (1939–1945)",
        "",
        "| Year | Total Active | Military | Dual-Use | Military + Dual | Civilian Only | Under Const. | Newly Active | Newly Military/Dual |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for y in YEARS:
        s = year_summaries[y]
        lines.append(
            f"| **{y}** | **{s['total_active']}** | {s['military_only']} | {s['dual_use']} "
            f"| {s['military_plus_dual']} | {s['civilian_only']} | {s['construction']} "
            f"| +{s['new_active']} | +{s['new_military']} |"
        )

    lines.extend(
        [
            "",
            "## Airfield-by-Airfield Verification Table",
            "",
            "| Airfield | Region | Coordinates | 39 | 40 | 41 | 42 | 43 | 44 | 45 | Conf. | Proof Summary & Sources |",
            "| --- | --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |",
        ]
    )

    short_code = {
        "none": "—",
        "construction": "Bld",
        "civilian": "Civ",
        "dual_use": "Dual",
        "military": "Mil",
        "closed": "Cls",
    }

    for r in rows:
        st_cells = " | ".join(short_code[r["statuses"][y]] for y in YEARS)
        coord_str = f"`{r['latitude']:.4f}, {r['longitude']:.4f}`"
        sources_str = "; ".join(r["primary_sources"])
        proof_cell = f"{r['proof_summary']} *(Sources: {sources_str})*".replace("|", "/")
        lines.append(
            f"| **{r['name']}** (`{r['id']}`) | {r['region']} | {coord_str} | {st_cells} "
            f"| `{r['confidence']}` | {proof_cell} |"
        )

    lines.append("")
    (DATA_DIR / "PROOF_DOSSIER.md").write_text("\n".join(lines), encoding="utf-8")


def build_all() -> dict[str, Any]:
    rows = load_and_validate_csv(CSV_PATH)
    year_summaries: dict[int, dict[str, int]] = {}
    region_counts = Counter(r["region"] for r in rows)

    for year in YEARS:
        combined_feats: list[dict[str, Any]] = []
        mil_feats: list[dict[str, Any]] = []
        civ_feats: list[dict[str, Any]] = []

        counts = Counter()
        for r in rows:
            st = r["statuses"][year]
            prev = r["statuses"].get(year - 1, "none")
            counts[st] += 1
            if st in ACTIVE_STATUSES:
                feat = build_feature_for_year(r, year)
                combined_feats.append(feat)
                if st in {"military", "dual_use"}:
                    mil_feats.append(feat)
                else:
                    civ_feats.append(feat)
                if year > YEARS[0] and prev not in ACTIVE_STATUSES:
                    counts["new_active"] += 1
                if year > YEARS[0] and st in {"military", "dual_use"} and prev not in {"military", "dual_use"}:
                    counts["new_military"] += 1

        # Verify disjointness
        mil_ids = {f["id"] for f in mil_feats}
        civ_ids = {f["id"] for f in civ_feats}
        assert not (mil_ids & civ_ids), f"Year {year}: overlapping military/civilian ids"
        assert len(mil_feats) + len(civ_feats) == len(combined_feats)

        summary = {
            "year": year,
            "total_active": len(combined_feats),
            "military_only": counts["military"],
            "dual_use": counts["dual_use"],
            "military_plus_dual": len(mil_feats),
            "civilian_only": len(civ_feats),
            "construction": counts["construction"],
            "closed": counts["closed"],
            "new_active": counts["new_active"],
            "new_military": counts["new_military"],
        }
        year_summaries[year] = summary

        base_meta = {
            "dataset": "Alaska Airfields Progression (1939-1945)",
            "snapshot_year": year,
            "source_csv": "alaska_airfields_1939_1945.csv",
            "crs": "EPSG:4326 (WGS84, RFC 7946 [longitude, latitude])",
            "counts": summary,
        }

        write_geojson(
            DATA_DIR / f"alaska_airfields_{year}.geojson",
            combined_feats,
            {**base_meta, "subset": "combined_active"},
        )
        write_geojson(
            DATA_DIR / f"alaska_airfields_{year}_military.geojson",
            mil_feats,
            {**base_meta, "subset": "military_and_dual_use"},
        )
        write_geojson(
            DATA_DIR / f"alaska_airfields_{year}_civilian.geojson",
            civ_feats,
            {**base_meta, "subset": "civilian_only"},
        )

    manifest = {
        "dataset_id": "alaska_airfields_1939_1945",
        "title": "Alaska Airfields Progression (1939–1945)",
        "source_csv": "alaska_airfields_1939_1945.csv",
        "total_records": len(rows),
        "years": YEARS,
        "regions": dict(sorted(region_counts.items())),
        "annual_summary": [year_summaries[y] for y in YEARS],
        "files": {
            str(y): {
                "combined": f"alaska_airfields_{y}.geojson",
                "military": f"alaska_airfields_{y}_military.geojson",
                "civilian": f"alaska_airfields_{y}_civilian.geojson",
            }
            for y in YEARS
        },
    }
    (DATA_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    write_proof_dossier(rows, year_summaries)
    return manifest


if __name__ == "__main__":
    result = build_all()
    print(f"Validated {result['total_records']} Alaska airfields from {CSV_PATH.name}.")
    for row in result["annual_summary"]:
        print(
            f"  {row['year']}: {row['total_active']:2d} active "
            f"({row['military_only']:2d} mil, {row['dual_use']:2d} dual, {row['civilian_only']:2d} civ; "
            f"{row['construction']:2d} under construction; +{row['new_active']} new active)"
        )
