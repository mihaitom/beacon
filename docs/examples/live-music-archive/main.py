#!/usr/bin/env python3
"""Start the Live Music Archive source: `uv run main.py`."""

import logging

import uvicorn

from live_music_archive.app import create_app
from live_music_archive.config import load


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s"
    )
    config = load()
    logging.getLogger("live_music_archive").info(
        f'Serving "{config.name}" on port {config.port}'
        + ("" if config.token else " (no token set)")
    )
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="warning")


if __name__ == "__main__":
    main()
