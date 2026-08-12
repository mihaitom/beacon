# --- Build frontend
FROM node:24-alpine AS frontend-builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install

# Only what `pnpm run build:web` actually touches — an unrelated repo change
# (e.g. in connect/) shouldn't bust this layer and trigger a needless rebuild.
COPY src ./src
COPY CHANGELOG.md web.vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./

RUN pnpm run build:web


# --- Build minimal ffmpeg (audio-only, statically linked)
#
# connect/core/streamer.py only ever runs
# `ffmpeg -i <url> -vn -acodec libmp3lame ... -f mp3 pipe:1` — video is
# always explicitly disabled (-vn). Alpine's `ffmpeg` apk package pulls in
# ~130MB of codecs/libraries never touched here (AV1/H.264/H.265 encoders,
# Vulkan shader compilation, X11/Wayland/SDL, Blu-ray, webcam capture...).
# Building just what's needed — decode for common library formats, HTTPS
# input, MP3 encode — gets that down to ~8MB with zero runtime dependencies
# (fully static binary, just COPY it into the final stage below).
FROM alpine:3.22 AS ffmpeg-builder

RUN apk add --no-cache \
    build-base \
    coreutils \
    curl \
    lame-dev \
    nasm \
    openssl-dev \
    openssl-libs-static \
    tar \
    xz \
    zlib-dev \
    zlib-static

WORKDIR /build

# ffmpeg.org's own server is occasionally flaky under CI load — retry with
# backoff, and force IPv4 to sidestep the SSL handshake failures observed
# over broken IPv6 paths on some CI/hosting networks.
RUN curl -fsSL -4 --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 10 \
        -o ffmpeg-8.1.2.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz \
    && tar xf ffmpeg-8.1.2.tar.xz

WORKDIR /build/ffmpeg-8.1.2

RUN ./configure \
    --disable-everything \
    --disable-doc \
    --disable-debug \
    --disable-avdevice \
    --disable-swscale \
    --enable-protocol=file,http,https,tls,tcp,udp,pipe \
    --enable-openssl \
    --enable-demuxer=mp3,flac,ogg,wav,aac,mov,matroska,asf,ape,aiff \
    --enable-decoder=mp3,mp3float,flac,vorbis,opus,aac,aac_latm,pcm_s16le,pcm_s16be,pcm_u8,pcm_f32le,alac,wmav1,wmav2,ape \
    --enable-parser=mp3,aac,flac,opus,vorbis \
    --enable-encoder=libmp3lame \
    --enable-muxer=mp3 \
    --enable-libmp3lame \
    --enable-swresample \
    --enable-filter=aresample,anull,aformat \
    --disable-shared \
    --enable-static \
    --extra-ldflags="-static" \
    --pkg-config-flags="--static" \
    && make -j$(nproc) \
    && make install


# --- Build Python venv
#
# `miniaudio` (a pyatv/AirPlay dependency) has no musllinux wheel for arm64 —
# only for x86_64, on every released version (checked directly against
# PyPI's file listing) — so `uv sync` must compile it from source on arm64,
# which needs a C++ compiler. Isolating that into its own stage means the
# compiler toolchain doesn't have to live in the final image either — only
# the resulting .venv is copied over. On amd64, where a prebuilt wheel
# exists, this stage still runs (harmlessly) — uv just installs the wheel
# instead of building anything.
FROM ghcr.io/astral-sh/uv:python3.14-alpine AS python-builder

WORKDIR /app

RUN apk add --no-cache build-base

COPY connect/pyproject.toml connect/uv.lock ./
# --no-dev: pyinstaller/pytest/ruff (see pyproject.toml's dev group) are
# build/test-only tooling with no purpose in a running container — skipping
# them keeps the venv copied into the final stage smaller.
RUN uv sync --locked --no-dev


# --- Final image
FROM ghcr.io/astral-sh/uv:python3.14-alpine

WORKDIR /app

RUN apk add --no-cache nginx gettext
COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --chown=nginx:nginx --from=frontend-builder /app/out/web /usr/share/nginx/html
COPY --chown=nginx:nginx ./settings.js.template /etc/nginx/templates/settings.js.template
COPY --chown=nginx:nginx ng.conf.template /etc/nginx/templates/default.conf.template

COPY connect/pyproject.toml ./
COPY connect/uv.lock ./
COPY --from=python-builder /app/.venv /app/.venv
COPY connect/. .

COPY start.sh /start.sh
RUN chmod +x /start.sh

ENV SERVER_INTERNAL_URL="" CONNECT_TOKEN="" CONNECT_URL=/api
ENV WEB_PORT=9180 PORT=9181

EXPOSE 9180

# Goes through nginx to /api/health, so it fails if either nginx or the
# Python backend is down/unresponsive. Uses $WEB_PORT (not the 9180 default
# baked into EXPOSE above, which is only documentation) so the healthcheck
# still hits the right port when it's overridden — see start.sh.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${WEB_PORT}/api/health" || exit 1

CMD ["/start.sh"]
