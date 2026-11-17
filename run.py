"""CLI launcher for Dusty's Map Studio Python Cartopy Pro backend."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import uvicorn

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def main() -> None:
    """Parse CLI arguments, print startup instructions, and start Uvicorn."""
    parser = argparse.ArgumentParser(
        description="Run Dusty's Map Studio (Cartopy + GeoPandas Pro Backend)."
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind host address (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Bind TCP port (default: 8000)",
    )
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}"
    print("=" * 64)
    print("  Dusty's Map Studio — Cartopy + GeoPandas Pro Engine")
    print("=" * 64)
    print(f"  Studio UI   : {base_url}/")
    print(f"  Health Check: {base_url}/api/health")
    print(f"  API Docs    : {base_url}/docs")
    print("  Press CTRL+C to stop the server.")
    print("=" * 64)

    uvicorn.run("backend.app:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
