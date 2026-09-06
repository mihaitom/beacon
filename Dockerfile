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
# connect/core/streamer.py only ever transcodes audio — video is always
# explicitly disabled (-vn). Alpine's `ffmpeg` apk package pulls in ~130MB
# of codecs/libraries never touched here (AV1/H.264/H.265 encoders, Vulkan
# shader compilation, X11/Wayland/SDL, Blu-ray, webcam capture...). Building
# just what's needed — decode for common library formats, HTTPS input, and
# the encoders below — gets that down to ~8MB with zero runtime dependencies
# (fully static binary, just COPY it into the final stage below).
#
# The decoder list is the other half of the same rule, from the input side:
# a library holds whatever the person put in it. The PCM entries are all of
# the depths a WAV or AIFF can carry, not just 16-bit — this app reads and
# displays a source's real bit depth (see core/streamer.py's own note on
# probing it), so 24- and 32-bit files are expected rather than exotic, and
# a missing decoder there is a track that simply refuses to play.
#
# The encoder list has to cover every format the app can actually ask for,
# which is not the same as every format it usually uses. `aac` is in it
# because Beacon offers AAC as a cast quality (streamQuality.ts's
# CAST_FORMATS, reached through lossy_encode_args()); without it that
# setting failed here with "Unknown encoder 'aac'" while working fine on the
# desktop build, which uses the system ffmpeg rather than this one. Nothing
# checks at startup which encoders exist, so an option offered in Settings
# and an encoder missing here is a combination that fails at the moment the
# user casts. Adding a format to CAST_FORMATS or LOCAL_FORMATS means adding
# its encoder (and muxer) here too.
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
# compressed against the ~8MB this produces, and with every video codec
# back in.
#
# --prefix=/usr/local is enough for ffmpeg's configure to find it: Alpine's
# pkg-config already searches /usr/local/lib/pkgconfig first.
RUN curl -fsSL -4 --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 10 \
        -o opus-1.6.1.tar.gz https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz \
    && tar xf opus-1.6.1.tar.gz \
    && cd opus-1.6.1 \
    && ./configure --disable-shared --enable-static --disable-doc --disable-extra-programs \
        --prefix=/usr/local \
    && make -j$(nproc) \
    && make install

# ffmpeg.org's own server is occasionally flaky under CI load — retry with
# backoff, and force IPv4 to sidestep the SSL handshake failures observed
# over broken IPv6 paths on some CI/hosting networks.
RUN curl -fsSL -4 --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 10 \
        -o ffmpeg-8.1.2.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz \
    && tar xf ffmpeg-8.1.2.tar.xz

WORKDIR /build/ffmpeg-8.1.2

# core/audio_analysis.py's live FFT visualizer and core/waveform.py's
# seek-bar peaks both decode to raw PCM via ffmpeg's "-f s16le" — which
# needs BOTH the pcm_s16le *muxer* (the container/output-format) AND the
# pcm_s16le *encoder* (ffmpeg still needs a registered encoder component to
# write into that container, even though "encoding" raw PCM is really just
# a passthrough) enabled below, or ffmpeg rejects it: missing the muxer is
# "Unknown output format", missing the encoder is "Automatic encoder
# selection failed ... probably disabled". Note the *configure-time* muxer
# name has a pcm_ prefix the runtime `-f`/`-muxers` name doesn't —
# `./configure --list-muxers` lists it as pcm_s16le, `ffmpeg -muxers` shows
# the same thing as just "s16le" — and configure silently ignores an
# unrecognized name instead of erroring, so getting this wrong doesn't fail
# the build, it just quietly omits the muxer. Without both, both features
# silently produce nothing in a build using this Dockerfile, even though
# the same commands work fine against a system ffmpeg (which has every
# muxer/encoder built in) — that's the whole reason this was easy to miss
# locally and only show up once actually deployed.
# core/streamer.py's resolve_output_format() prefers stream-copying a
# track's source codec straight through over always re-encoding to MP3 —
# flac/mp3/aac/vorbis sources each need their matching *muxer* below (copy
# needs an output container, not an encoder). Opus is deliberately NOT in
# that copy tier despite ffmpeg supporting an opus-in-ogg copy — a real
# Sonos speaker accepts the URI but produces no audio for it (Sonos' own
# published format list has no Opus entry, only Ogg Vorbis) — so the ogg
# muxer below exists for Vorbis only. flac is also the universal re-encode
# target for other lossless sources (alac, WAV/AIFF PCM, ape), which — same
# pcm_s16le gotcha as above — needs both the flac muxer AND the flac
# encoder, not just one. adts (AAC) and ogg (Vorbis) are copy-only here, so
# they need only their muxer, no encoder.
RUN ./configure \
    --disable-everything \
    --disable-doc \
    --disable-debug \
    --disable-avdevice \
    --disable-swscale \
    --enable-protocol=file,http,https,tls,tcp,udp,pipe \
    --enable-openssl \
    --enable-demuxer=mp3,flac,ogg,wav,aac,mov,matroska,asf,ape,aiff \
    --enable-decoder=mp3,mp3float,flac,vorbis,opus,aac,aac_latm,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_u8,pcm_f32le,pcm_f64le,alac,wmav1,wmav2,ape \
    --enable-parser=mp3,aac,flac,opus,vorbis \
    --enable-encoder=aac,libmp3lame,libopus,pcm_s16le,flac \
    --enable-muxer=mp3,pcm_s16le,flac,adts,ogg \
    --enable-libmp3lame \
    --enable-libopus \
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
ENV WEB_PORT=7070 PORT=7071

EXPOSE 7070

# Goes through nginx to /api/health, so it fails if either nginx or the
# Python backend is down/unresponsive. Uses $WEB_PORT (not the 7070 default
# baked into EXPOSE above, which is only documentation) so the healthcheck
# still hits the right port when it's overridden — see start.sh.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${WEB_PORT}/api/health" || exit 1

CMD ["/start.sh"]
