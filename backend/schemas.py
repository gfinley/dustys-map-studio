"""Pydantic v2 models matching site/js/schema.js 1:1."""

from __future__ import annotations

from typing import Any, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field


ProjectionLiteral = Literal[
    "mercator",
    "equal_earth",
    "orthographic",
    "albers",
    "azimuthal_equidistant",
    "robinson",
]
DetailLevelLiteral = Literal["auto", "ultra", "10m", "50m", "110m"]
HatchLiteral = Literal["none", "diagonal", "backdiagonal", "cross", "dots"]
BorderStyleLiteral = Literal["solid", "dashed", "dotted"]
PinStyleLiteral = Literal["dot", "capital", "bullseye", "square", "label_only"]
CornerLiteral = Literal["bottom-left", "bottom-right", "top-left", "top-right"]
ShadowSourceLiteral = Literal["country", "admin1"]
CoastlineEngineLiteral = Literal["auto", "natural_earth", "gshhs_high", "gshhs_full"]
BasemapLiteral = Literal[
    "none",
    "CartoDB.VoyagerNoLabels",
    "CartoDB.PositronNoLabels",
    "CartoDB.DarkMatterNoLabels",
    "Esri.WorldShadedRelief",
    "Esri.WorldTerrain",
    "Esri.OceanBasemap",
    "Esri.WorldImagery",
    "OpenTopoMap",
]


class _BaseSpecModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class CenterSpec(_BaseSpecModel):
    lat: float = Field(default=48.5, ge=-89.5, le=89.5)
    lon: float = Field(default=31.2, ge=-180.0, le=180.0)


class SpanSpec(_BaseSpecModel):
    lonDeg: float = Field(default=24.0, ge=0.05, le=360.0)
    latDeg: float = Field(default=14.0, ge=0.05, le=175.0)


class PageSpec(_BaseSpecModel):
    preset: str = "book_4_6x7"
    widthIn: float = Field(default=4.6, ge=1.0, le=40.0)
    heightIn: float = Field(default=7.0, ge=1.0, le=40.0)
    dpi: int = Field(default=300, ge=72, le=1200)
    showFrameBorder: bool = True


class ColorsSpec(_BaseSpecModel):
    land: str = "#4a4a4a"
    water: str = "#d1cfcf"
    borders: str = "#ffffff"
    coastline: str = "none"
    rivers: str = "#d1cfcf"
    admin1: str = "#737373"
    bathymetry: str = "#bfbdbd"
    urban: str = "#636363"
    highlightFill: str = "#7a7d7a"
    highlightStroke: str = "#ffffff"
    text: str = "#111111"
    textHalo: str = "#d1cfcf"


class LayersSpec(_BaseSpecModel):
    showBorders: bool = True
    borderWidth: float = Field(default=1.0, ge=0.1, le=8.0)
    borderStyle: BorderStyleLiteral = "solid"
    showCoastlines: bool = False
    coastlineWidth: float = Field(default=0.75, ge=0.1, le=8.0)
    showMinorIslands: bool = True
    showLakes: bool = True
    showRivers: bool = False
    riverWidth: float = Field(default=0.75, ge=0.1, le=8.0)
    showBathymetry: bool = False
    showUrbanAreas: bool = False
    showAdmin1: bool = False
    admin1Width: float = Field(default=0.7, ge=0.1, le=8.0)
    admin1Scale: Literal["auto", "50m", "10m"] = "auto"
    showGraticule: bool = False
    graticuleStepDeg: float = Field(default=10.0, ge=1.0, le=60.0)
    cityLabelScale: float = Field(default=1.0, ge=0.4, le=3.5)
    cityIconScale: float = Field(default=1.0, ge=0.4, le=3.5)


class HighlightedCountry(_BaseSpecModel):
    id: str = ""
    name: str = ""
    fill: str = "#7a7d7a"
    stroke: str = "#ffffff"
    hatch: HatchLiteral = "none"


class RegionShadow(_BaseSpecModel):
    id: str = ""
    sourceType: ShadowSourceLiteral = "country"
    sourceId: str = ""
    sourceName: str = ""
    targetLat: float = Field(default=0.0, ge=-85.0, le=85.0)
    targetLon: float = Field(default=0.0, ge=-180.0, le=180.0)
    rotationDeg: float = Field(default=0.0, ge=-180.0, le=180.0)
    fill: str = "#dc2626"
    stroke: str = "#7f1d1d"
    opacity: float = Field(default=0.35, ge=0.05, le=0.95)
    strokeWidth: float = Field(default=1.6, ge=0.3, le=8.0)
    dashed: bool = True
    hatch: HatchLiteral = "none"
    showLabel: bool = True
    showArea: bool = True
    visible: bool = True


class CityPin(_BaseSpecModel):
    id: str = ""
    name: str = "Point"
    lat: float = Field(default=0.0, ge=-90.0, le=90.0)
    lon: float = Field(default=0.0, ge=-180.0, le=180.0)
    style: PinStyleLiteral = "dot"
    dx: float = 6.0
    dy: float = -5.0
    scale: float = Field(default=1.0, ge=0.4, le=3.0)


class CustomGeoJsonLayer(_BaseSpecModel):
    id: str = "layer"
    label: str = "Overlay"
    url: Optional[str] = None
    data: Optional[dict[str, Any]] = None
    visible: bool = True
    color: str = "#222222"
    fillOpacity: float = Field(default=0.45, ge=0.0, le=1.0)
    strokeWidth: float = Field(default=1.5, ge=0.2, le=8.0)
    dashed: bool = False
    hatch: HatchLiteral = "none"


class ScaleBarSpec(_BaseSpecModel):
    enabled: bool = True
    units: Literal["km", "mi"] = "km"
    position: CornerLiteral = "bottom-left"


class LocatorGlobeSpec(_BaseSpecModel):
    enabled: bool = True
    position: CornerLiteral = "top-right"
    sizePct: float = Field(default=22.0, ge=10.0, le=40.0)
    showExtentBox: bool = True
    zoomMode: Literal["auto", "nearside", "hemisphere", "custom"] = "auto"
    zoom: float = Field(default=2.0, ge=1.0, le=6.0)


class NorthArrowSpec(_BaseSpecModel):
    enabled: bool = False
    position: CornerLiteral = "top-left"


class LegendSpec(_BaseSpecModel):
    enabled: bool = False
    position: CornerLiteral = "bottom-right"


class OrnamentsSpec(_BaseSpecModel):
    scaleBar: ScaleBarSpec = Field(default_factory=ScaleBarSpec)
    locatorGlobe: LocatorGlobeSpec = Field(default_factory=LocatorGlobeSpec)
    northArrow: NorthArrowSpec = Field(default_factory=NorthArrowSpec)
    legend: LegendSpec = Field(default_factory=LegendSpec)


class ProOptionsSpec(_BaseSpecModel):
    basemapProvider: BasemapLiteral = "none"
    basemapOpacity: float = Field(default=0.85, ge=0.1, le=1.0)
    coastlineEngine: CoastlineEngineLiteral = "auto"


class MapSpec(_BaseSpecModel):
    version: int = 1
    title: str = "Ukraine Briefing Map"
    showTitle: bool = False
    projection: ProjectionLiteral = "mercator"
    detailLevel: DetailLevelLiteral = "auto"
    center: CenterSpec = Field(default_factory=CenterSpec)
    span: SpanSpec = Field(default_factory=SpanSpec)
    page: PageSpec = Field(default_factory=PageSpec)
    theme: str = "dusty_prime"
    colors: ColorsSpec = Field(default_factory=ColorsSpec)
    layers: LayersSpec = Field(default_factory=LayersSpec)
    highlightedCountries: list[HighlightedCountry] = Field(default_factory=list)
    regionShadows: list[RegionShadow] = Field(default_factory=list)
    cities: list[CityPin] = Field(default_factory=list)
    customGeoJsonLayers: list[CustomGeoJsonLayer] = Field(default_factory=list)
    ornaments: OrnamentsSpec = Field(default_factory=OrnamentsSpec)
    pro: ProOptionsSpec = Field(default_factory=ProOptionsSpec)


class BatchRenderItem(_BaseSpecModel):
    filename: Optional[str] = None
    spec: MapSpec


class BatchRenderRequest(_BaseSpecModel):
    format: Literal["png", "jpeg", "pdf", "svg"] = "png"
    includeBorderPair: bool = False
    items: list[BatchRenderItem] = Field(default_factory=list)
    spec: Optional[MapSpec] = None
