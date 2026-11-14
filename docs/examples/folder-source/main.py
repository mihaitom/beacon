#!/usr/bin/env python3
"""Start the folder source: `uv run main.py /path/to/music`."""

import logging
import sys

import uvicorn

from folder_source.app import create_app
from folder_source.config import load


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s"
    )
    config = load(sys.argv)
    logging.getLogger("folder_source").info(
        f'Serving {config.music_dir} as "{config.name}" on port {config.port}'
        + ("" if config.token else " (no token set)")
    )
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="warning")


if __name__ == "__main__":
    main()
