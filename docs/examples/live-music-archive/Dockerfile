FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY main.py ./
COPY live_music_archive ./live_music_archive

RUN useradd --system --uid 1000 --home-dir /data lma \
    && mkdir -p /data && chown lma /data
USER lma

ENV DATA_DIR=/data PORT=8801 PATH="/app/.venv/bin:$PATH"
VOLUME /data
EXPOSE 8801
HEALTHCHECK --interval=60s --timeout=5s \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health', timeout=4)"

CMD ["python", "main.py"]
