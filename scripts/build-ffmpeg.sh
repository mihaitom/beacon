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

# What the app ships has to run on a machine that has none of this build's
# tooling on it. Nothing in verify-ffmpeg.sh can see that — it asks a binary
# that is standing next to its own libraries — so it is asked here, per
# platform, before the stamp. The first macOS build failed exactly this way:
# every component present, every command shape working, and four Homebrew
# dylibs in the load commands.
check_self_contained() {
    case "$(uname -s)" in
        Linux)
            # Fully static: musl, openssl and the codec libraries are all in
            # the file, so there is no interpreter to name.
            if ! file "$output" | grep -q "static"; then
                echo "[ffmpeg] ERROR: not statically linked:" >&2
                ldd "$output" >&2 || true
                exit 1
            fi
            ;;
        Darwin)
            # System frameworks and /usr/lib are on every Mac; anything from
            # a package manager's prefix is not.
            foreign="$(otool -L "$output" | tail -n +2 | awk '{print $1}' |
                grep -Ev '^(/usr/lib/|/System/Library/)' || true)"
            if [ -n "$foreign" ]; then
                echo "[ffmpeg] ERROR: links libraries that a user's Mac won't have:" >&2
                echo "$foreign" | sed 's/^/    /' >&2
                exit 1
            fi
            ;;
        MINGW* | MSYS*)
            # Same idea: the mingw runtime and the codec libraries have to be
            # inside the .exe, leaving only Windows' own DLLs.
            foreign="$(objdump -p "$output" | awk '/DLL Name:/ { print tolower($3) }' |
                grep -Ev '^(kernel32|kernelbase|msvcrt|user32|advapi32|shell32|ole32|oleaut32|ws2_32|bcrypt|crypt32|secur32|gdi32|winmm|psapi|shlwapi|version|imm32|setupapi|cfgmgr32|powrprof|dwmapi|uxtheme)\.dll$' || true)"
            if [ -n "$foreign" ]; then
                echo "[ffmpeg] ERROR: needs DLLs that would have to ship alongside it:" >&2
                echo "$foreign" | sed 's/^/    /' >&2
                exit 1
            fi
            ;;
    esac
    echo "[ffmpeg] Self-contained: no libraries to ship beside it"
}


# Checked even when nothing is rebuilt, which is the case that matters most
# in CI: the publish workflow restores this binary from a cache, and a
# component added to required-components since it was built has to fail here
# rather than reach a release.
if [ -x "$output" ] && [ "$(cat "$stamp_file" 2>/dev/null || true)" = "$(build_stamp)" ]; then
    echo "[ffmpeg] Up to date: $output"
    check_self_contained
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

# Homebrew ships a static library beside every dylib, and on macOS the
# linker takes the dylib whenever both are in the same directory — so
# pointing -L at Homebrew's own lib directory produces a binary that loads
# libmp3lame, libopus and libssl from /opt/homebrew at startup and refuses
# to run anywhere else. Measured on the first CI build, 2026-09-08.
#
# So the dependencies are staged into a directory that holds only the static
# archives, and configure is pointed at that: with no dylib in reach there is
# nothing else for the linker to pick. The .pc files come along with their
# prefix rewritten, or pkg-config would hand back Homebrew's paths again.
stage_macos_deps() {
    deps="$work/deps"
    mkdir -p "$deps/lib/pkgconfig" "$deps/include"
    for formula in lame opus openssl@3; do
        prefix="$(brew --prefix "$formula")"
        cp "$prefix"/lib/*.a "$deps/lib/" 2>/dev/null || true
        cp -R "$prefix"/include/. "$deps/include/" 2>/dev/null || true
        for pc in "$prefix"/lib/pkgconfig/*.pc; do
            [ -f "$pc" ] || continue
            sed "s|^prefix=.*|prefix=$deps|" "$pc" > "$deps/lib/pkgconfig/$(basename "$pc")"
        done
    done
    echo "[ffmpeg] Staged static dependencies: $(ls "$deps/lib"/*.a | tr '\n' ' ')"
}

build_macos() {
    echo "[ffmpeg] Installing build dependencies via Homebrew"
    brew install --quiet nasm pkg-config lame opus openssl@3
    fetch_ffmpeg_source
    stage_macos_deps
    cd "$work/ffmpeg-src"
    # shellcheck disable=SC2046  # word splitting is what turns the file into flags
    PKG_CONFIG_PATH="$deps/lib/pkgconfig" PKG_CONFIG_LIBDIR="$deps/lib/pkgconfig" ./configure \
        $(configure_flags) \
        --pkg-config-flags="--static" \
        --extra-cflags="-I$deps/include" \
        --extra-ldflags="-L$deps/lib"
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
check_self_contained
verify
build_stamp > "$stamp_file"
"$output" -hide_banner -version | head -1
echo "[ffmpeg] Built $output ($(du -h "$output" | cut -f1))"
