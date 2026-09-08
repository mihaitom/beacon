#!/usr/bin/env bash
# Builds the ffmpeg the desktop app ships, into build/ffmpeg/ — see
# build/ffmpeg/README.md. Run by `pnpm run package:ffmpeg`, which every
# packaging script depends on, and by the publish workflow (with the result
# cached between runs).
#
# Recipe and versions come from build/ffmpeg/configure-flags and
# build/ffmpeg/versions, which the Docker image's own ffmpeg is built from
# too. Only how to link and where to find libraries differs per platform,
# and that is all this file adds.
#
# Whatever comes out is then checked against build/ffmpeg/required-components
# by scripts/verify-ffmpeg.sh — see that file for why a build that succeeded
# is not yet a build that contains what the app asks for.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ffmpeg_dir="$repo_root/build/ffmpeg"
# shellcheck source=../build/ffmpeg/versions
. "$ffmpeg_dir/versions"

configure_flags() {
    sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$ffmpeg_dir/configure-flags"
}

# What a built binary is stamped with, so a rebuild only happens when the
# recipe or a version actually changed — the CI cache key is this same
# string. Any edit to the flags file changes the hash and invalidates both.
build_stamp() {
    printf '%s' "ffmpeg-$FFMPEG_VERSION opus-$OPUS_VERSION $(configure_flags | cksum)"
}

exe_name="ffmpeg"
case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) exe_name="ffmpeg.exe" ;;
esac
output="$ffmpeg_dir/$exe_name"
stamp_file="$ffmpeg_dir/.built"

verify() {
    sh "$repo_root/scripts/verify-ffmpeg.sh" "$output" "$ffmpeg_dir/required-components"
}

# Checked even when nothing is rebuilt, which is the case that matters most
# in CI: the publish workflow restores this binary from a cache, and a
# component added to required-components since it was built has to fail here
# rather than reach a release.
if [ -x "$output" ] && [ "$(cat "$stamp_file" 2>/dev/null || true)" = "$(build_stamp)" ]; then
    echo "[ffmpeg] Up to date: $output"
    verify
    exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ffmpeg.org's own server is occasionally flaky under CI load — retry with
# backoff, and force IPv4 to sidestep the SSL handshake failures seen over
# broken IPv6 paths on some CI networks. Same arguments as the Dockerfile's.
fetch() {
    curl -fsSL -4 --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 10 -o "$1" "$2"
}

fetch_ffmpeg_source() {
    echo "[ffmpeg] Fetching ffmpeg $FFMPEG_VERSION"
    fetch "$work/ffmpeg.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
    tar xf "$work/ffmpeg.tar.xz" -C "$work"
    mv "$work/ffmpeg-$FFMPEG_VERSION" "$work/ffmpeg-src"
    # Every name in the recipe has to be one this version knows, before the
    # long part starts. The Linux build gets this from the Dockerfile's own
    # stage instead, which is where its configure runs.
    sh "$repo_root/scripts/check-ffmpeg-recipe.sh" "$work/ffmpeg-src" "$ffmpeg_dir/configure-flags"
}

# Linux goes through the Docker image's own builder stage rather than
# building against the host: a glibc ffmpeg linked statically cannot resolve
# a hostname (getaddrinfo needs NSS modules a static link leaves out) and
# ffmpeg's input here is http(s) URLs, while linking dynamically instead
# would tie the AppImage to the glibc of whichever runner built it. The
# Alpine/musl build has neither problem, and is the exact binary the server
# image already runs.
build_linux() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "[ffmpeg] ERROR: docker is required to build the Linux binary" >&2
        exit 1
    fi
    echo "[ffmpeg] Building via the Dockerfile's ffmpeg-builder stage"
    docker build --target ffmpeg-builder -t beacon-ffmpeg-build "$repo_root"
    container="$(docker create beacon-ffmpeg-build)"
    trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
    docker cp "$container:/usr/local/bin/ffmpeg" "$output"
}

# Homebrew's lame/opus/openssl each ship a static library alongside the
# dylib, so only the system frameworks end up linked dynamically — which is
# as static as a macOS binary gets, and enough to be self-contained inside
# the app bundle.
build_macos() {
    echo "[ffmpeg] Installing build dependencies via Homebrew"
    brew install --quiet nasm pkg-config lame opus openssl@3
    local prefix
    prefix="$(brew --prefix)"
    fetch_ffmpeg_source
    cd "$work/ffmpeg-src"
    # shellcheck disable=SC2046  # word splitting is what turns the file into flags
    PKG_CONFIG_PATH="$prefix/opt/openssl@3/lib/pkgconfig:$prefix/lib/pkgconfig" ./configure \
        $(configure_flags) \
        --pkg-config-flags="--static" \
        --extra-cflags="-I$prefix/include" \
        --extra-ldflags="-L$prefix/lib"
    make -j"$(sysctl -n hw.ncpu)"
    cp ffmpeg "$output"
}

# MSYS2's mingw64 packages are static libraries, and -static drags in
# libgcc/libstdc++/winpthread so the result needs nothing from the MSYS2
# installation it was built in.
build_windows() {
    echo "[ffmpeg] Installing build dependencies via pacman"
    pacman -S --needed --noconfirm \
        mingw-w64-x86_64-gcc \
        mingw-w64-x86_64-lame \
        mingw-w64-x86_64-opus \
        mingw-w64-x86_64-openssl \
        mingw-w64-x86_64-pkgconf \
        mingw-w64-x86_64-nasm \
        make diffutils tar xz curl
    fetch_ffmpeg_source
    cd "$work/ffmpeg-src"
    # shellcheck disable=SC2046  # word splitting is what turns the file into flags
    ./configure \
        $(configure_flags) \
        --pkg-config-flags="--static" \
        --extra-ldflags="-static"
    make -j"$(nproc)"
    cp ffmpeg.exe "$output"
}

mkdir -p "$ffmpeg_dir"
case "$(uname -s)" in
    Linux) build_linux ;;
    Darwin) build_macos ;;
    MINGW* | MSYS*) build_windows ;;
    *)
        echo "[ffmpeg] ERROR: don't know how to build for $(uname -s)" >&2
        exit 1
        ;;
esac

chmod +x "$output"
# Before the stamp on purpose: a binary that came out short must not be
# recorded as up to date, or the next build skips it and packages it anyway.
verify
build_stamp > "$stamp_file"
"$output" -hide_banner -version | head -1
echo "[ffmpeg] Built $output ($(du -h "$output" | cut -f1))"
