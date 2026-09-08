#!/bin/sh
# Checks build/ffmpeg/configure-flags against the ffmpeg source tree it is
# about to configure: every component name it asks for has to be one this
# ffmpeg version actually knows.
#
# The companion to scripts/verify-ffmpeg.sh, from the other end. That one
# asks the finished binary what is in it, which is the stronger check but
# can only cover what the binary can list — and ffmpeg lists no parsers at
# all. `--enable-parser=mp3` therefore did nothing for a year: the parser is
# called `mpegaudio`, configure ignored the name, and nothing anywhere
# noticed. `./configure --list-parsers` is the only place that says
# otherwise, so it gets asked here, before the ten minutes of compiling
# rather than after.
#
# POSIX sh: the Alpine builder stage has no bash.
#
# Usage: check-ffmpeg-recipe.sh <ffmpeg source dir> <configure-flags file>
set -eu

src="${1:?usage: check-ffmpeg-recipe.sh <ffmpeg source dir> <configure-flags file>}"
flags="${2:?usage: check-ffmpeg-recipe.sh <ffmpeg source dir> <configure-flags file>}"

flags="$(cd "$(dirname "$flags")" && pwd)/$(basename "$flags")"
cd "$src"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

# Every kind the recipe can enable by name. configure spells the query in
# the plural ("--list-decoders") and the flag in the singular
# ("--enable-decoder="), the same split verify-ffmpeg.sh deals with.
for kind in protocol demuxer decoder parser encoder muxer filter bsf; do
    wanted="$(sed 's/#.*//' "$flags" | sed -n "s/^--enable-$kind=//p" | tr ',' ' ')"
    [ -n "$wanted" ] || continue

    # A list configure itself doesn't offer is a mistake in this loop, not
    # in the recipe — say so rather than passing the kind silently.
    if ! ./configure "--list-${kind}s" > "$work/known" 2>/dev/null; then
        echo "[check-recipe] ffmpeg has no --list-${kind}s" >&2
        failures=$((failures + 1))
        continue
    fi
    tr ' \t' '\n\n' < "$work/known" | sed '/^$/d' | sort -u > "$work/names"

    for name in $wanted; do
        grep -qxF "$name" "$work/names" ||
            {
                echo "[check-recipe] UNKNOWN: --enable-$kind=$name is not a $kind this ffmpeg has" >&2
                failures=$((failures + 1))
            }
    done
done

# The flags that are not component lists — --disable-everything,
# --enable-openssl, --disable-xlib and friends. configure rejects an option
# it doesn't have outright, so these fail loudly on their own; the point of
# checking them here is that an ffmpeg version bump says so in one line
# instead of at the end of a configure run on four platforms. --help spells
# each feature one way only (--disable-swresample, never --enable-), so both
# spellings are matched against the bare name.
./configure --help > "$work/help" 2>/dev/null || true
sed -n 's/.*--\(enable\|disable\)-\([a-zA-Z0-9_-]*\).*/\2/p' "$work/help" | sort -u > "$work/options"

for flag in $(sed 's/#.*//' "$flags" | sed -n 's/^--\(enable\|disable\)-\([a-zA-Z0-9_-]*\)$/\2/p'); do
    grep -qxF "$flag" "$work/options" ||
        {
            echo "[check-recipe] UNKNOWN: --enable/--disable-$flag is not an option this ffmpeg has" >&2
            failures=$((failures + 1))
        }
done

if [ "$failures" -ne 0 ]; then
    echo "[check-recipe] $failures name(s) in build/ffmpeg/configure-flags would be ignored" >&2
    exit 1
fi

echo "[check-recipe] Every name in the recipe is one this ffmpeg knows"
