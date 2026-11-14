FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY main.py ./
COPY folder_source ./folder_source

RUN useradd --system --uid 1000 --home-dir /data folder \
    && mkdir -p /data && chown folder /data
USER folder

ENV MUSIC_DIR=/music DATA_DIR=/data PORT=8800 PATH="/app/.venv/bin:$PATH"
VOLUME /data
EXPOSE 8800
HEALTHCHECK --interval=60s --timeout=5s \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health', timeout=4)"

CMD ["python", "main.py"]
