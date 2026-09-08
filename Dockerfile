# --- Build frontend
FROM node:26-alpine AS frontend-builder

WORKDIR /app

# corepack is no longer bundled with the Node image as of node:26 (it built
# and ran fine on node:24) — installing it explicitly via npm works
# regardless of whether the base image happens to ship it.
RUN npm install -g corepack && corepack enable && corepack prepare pnpm@11.5.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# This stage only ever runs `pnpm run build:web` below (a Vite build) — it
# never launches Electron itself, so the ~100MB Electron binary the
# `electron` package's own postinstall otherwise downloads from GitHub
# Releases is pure waste here: slower installs, and a real point of
# failure in build environments with restricted/unreliable egress to
# GitHub's CDN (seen as a "socket hang up" mid-download). Skipping it is
# safe precisely because this stage has no other use for it.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install

# Only what `pnpm run build:web` actually touches — an unrelated repo change
# (e.g. in connect/) shouldn't bust this layer and trigger a needless rebuild.
COPY src ./src
COPY CHANGELOG.md web.vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./

RUN pnpm run build:web


# --- Build minimal ffmpeg (audio-only, statically linked)
#
# A distribution ffmpeg brings ~130MB of codecs and libraries nothing here
# ever touches (AV1/H.264/H.265 encoders, Vulkan shader compilation,
# X11/Wayland/SDL, Blu-ray, webcam capture). Building only what connect
# actually reaches gets that to ~10MB with no runtime dependencies at all.
# Which formats that is, and why each one is on the list, is documented in
# build/ffmpeg/configure-flags — read that before changing a format
# anywhere in the app.
FROM alpine:3.24 AS ffmpeg-builder

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

# libopus from source, because Alpine has no static build of it: `opus-dev`
# ships only libopus.so, there is no opus-static package, and this ffmpeg is
# linked fully static so a shared library is of no use. Five lines here beat
# the alternatives — a Debian builder would bring the static library as a
# package but produce a glibc binary whose getaddrinfo() needs dlopen'd NSS
# modules that a static link leaves out, i.e. an ffmpeg that cannot resolve
# a hostname, and ffmpeg's input here is http(s) URLs. Prebuilt images
# (mwader/static-ffmpeg, jrottenberg/ffmpeg) solve it too, at ~118MB
# compressed against the ~10MB this produces, and with every video codec
# back in.
#
# --prefix=/usr/local is enough for ffmpeg's configure to find it: Alpine's
# pkg-config already searches /usr/local/lib/pkgconfig first.
#
# Versions and configure flags come from build/ffmpeg/, shared with the
# desktop app's own build of the same thing (scripts/build-ffmpeg.sh) so the
# two can't drift apart — see build/ffmpeg/README.md.
COPY build/ffmpeg/versions build/ffmpeg/configure-flags /build/ffmpeg/

RUN . /build/ffmpeg/versions \
    && curl -fsSL -4 --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 10 \
        -o opus.tar.gz "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" \
    && tar xf opus.tar.gz \
    && cd "opus-$OPUS_VERSION" \
    && ./configure --disable-shared --enable-static --disable-doc --disable-extra-programs \
        --prefix=/usr/local \
    && make -j$(nproc) \
    && make install

# ffmpeg.org's own server is occasionally flaky under CI load — retry with
# backoff, and force IPv4 to sidestep the SSL handshake failures observed
# over broken IPv6 paths on some CI/hosting networks.
RUN . /build/ffmpeg/versions \
    && curl -fsSL -4 --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 10 \
        -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
    && tar xf ffmpeg.tar.xz \
    && mv "ffmpeg-$FFMPEG_VERSION" ffmpeg-src

WORKDIR /build/ffmpeg-src

# Before the ten minutes of compiling: every name in the recipe has to be
# one this ffmpeg version knows, or configure drops it without a word (see
# scripts/check-ffmpeg-recipe.sh — this is the check that would have caught
# `--enable-parser=mp3`).
COPY scripts/check-ffmpeg-recipe.sh /build/
RUN sh /build/check-ffmpeg-recipe.sh /build/ffmpeg-src /build/ffmpeg/configure-flags

# What goes into this build and why is in build/ffmpeg/configure-flags,
# which the desktop app's own build reads too. Only the two flags that
# depend on *this* build being an Alpine/musl one are here: linking fully
# static (which is what makes the result a single file with no runtime
# dependencies to copy into the final stage) and telling pkg-config to
# report static link lines to match.
RUN ./configure \
        $(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' /build/ffmpeg/configure-flags) \
        --extra-ldflags="-static" \
        --pkg-config-flags="--static" \
    && make -j$(nproc) \
    && make install

# A build that succeeded is not yet a build that contains what connect asks
# for: configure warns about a name it doesn't know only when *nothing* else
# in the same comma list matched, so one wrong entry among a dozen right ones
# passes silently and surfaces as a track that won't play. Every such miss so
# far has been found in production. Copied after the build rather than
# alongside the flags so that editing the contract re-runs the check without
# rebuilding ffmpeg itself.
COPY build/ffmpeg/required-components /build/ffmpeg/
COPY scripts/verify-ffmpeg.sh /build/
RUN sh /build/verify-ffmpeg.sh /usr/local/bin/ffmpeg /build/ffmpeg/required-components


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
ENV WEB_PORT=7070 PORT=7071

EXPOSE 7070

# Goes through nginx to /api/health, so it fails if either nginx or the
# Python backend is down/unresponsive. Uses $WEB_PORT (not the 7070 default
# baked into EXPOSE above, which is only documentation) so the healthcheck
# still hits the right port when it's overridden — see start.sh.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${WEB_PORT}/api/health" || exit 1

CMD ["/start.sh"]
