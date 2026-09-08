#!/bin/sh
# Checks a freshly built ffmpeg against build/ffmpeg/required-components and
# runs the command shapes connect actually uses. Run by both builds of it —
# the Dockerfile's ffmpeg-builder stage and scripts/build-ffmpeg.sh — so a
# recipe that came out short fails the build rather than a listener's track.
#
# It exists because "it compiled" has never meant "it is in there": ffmpeg's
# configure builds one alternation out of a whole comma list and warns only
# when *nothing* in it matched, so one wrong name among five correct ones
# passes silently. Every such miss so far has surfaced in production, on
# whichever setting happened to reach the missing piece — ReplayGain, AAC
# casting, a 32-bit AIFF.
#
# POSIX sh on purpose: the Alpine builder stage has no bash.
#
# Usage: verify-ffmpeg.sh <ffmpeg binary> <required-components file>
set -eu

bin="${1:?usage: verify-ffmpeg.sh <ffmpeg binary> <required-components file>}"
required="${2:?usage: verify-ffmpeg.sh <ffmpeg binary> <required-components file>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

fail() {
    echo "[verify-ffmpeg] MISSING: $*" >&2
    failures=$((failures + 1))
}

# --- Part one: is every component the code can name actually in there? ---

# ffmpeg prints each list as a legend, a row of dashes, then one component
# per line with its flags first and its name second. A format that reports
# several names ("matroska,webm") is split so any one of them matches.
names_after_the_dashes() {
    awk 'body { n = split($2, parts, ","); for (i = 1; i <= n; i++) print parts[i] }
         /^ *-+ *$/ { body = 1 }'
}

list_names() {
    case "$1" in
        filter)   "$bin" -hide_banner -filters   2>/dev/null | names_after_the_dashes ;;
        encoder)  "$bin" -hide_banner -encoders  2>/dev/null | names_after_the_dashes ;;
        decoder)  "$bin" -hide_banner -decoders  2>/dev/null | names_after_the_dashes ;;
        muxer)    "$bin" -hide_banner -muxers    2>/dev/null | names_after_the_dashes ;;
        demuxer)  "$bin" -hide_banner -demuxers  2>/dev/null | names_after_the_dashes ;;
        # No legend here — an indented single word under Input:/Output:.
        protocol) "$bin" -hide_banner -protocols 2>/dev/null | awk 'NF == 1 && /^ / { print $1 }' ;;
        *)        echo "[verify-ffmpeg] unknown component kind '$1' in $required" >&2; exit 2 ;;
    esac
}

# One ffmpeg call per kind rather than one per component: the same list gets
# asked for a few dozen names.
for kind in filter protocol encoder muxer demuxer decoder; do
    wanted="$(awk -v k="$kind" '!/^#/ && $1 == k { print $2 }' "$required")"
    [ -n "$wanted" ] || continue
    list_names "$kind" | sort -u > "$work/have"
    for name in $wanted; do
        grep -qxF "$name" "$work/have" || fail "$kind $name"
    done
done

# --- Part two: do the real command shapes run? ---
#
# A component being listed and the command line connect builds around it
# working are not the same claim — the -ss/flac combination below produced
# "invalid block size: 8" with everything present and correct.

# A second of noise as 44.1kHz mono 16-bit WAV, written by hand because this
# ffmpeg has no signal generator in it (lavfi is not built) and no raw PCM
# demuxer to read one back. 44-byte canonical header, then the samples: the
# two size fields are the payload (88200 = 1s * 44100 * 2 bytes) and that
# plus the 36 header bytes after the RIFF field itself (88236), both
# little-endian.
make_tone() {
    printf 'RIFF\254\130\001\000WAVEfmt \020\000\000\000\001\000\001\000\104\254\000\000\210\130\001\000\002\000\020\000data\210\130\001\000' > "$work/tone.wav"
    head -c 88200 /dev/urandom >> "$work/tone.wav"
}

# Named for the log, then the arguments verbatim. Anything ffmpeg writes on
# a failure is the error message worth having, so it is kept and shown.
#
# An ffmpeg command line ends in its output file, so that is what gets
# checked for content — read off the arguments rather than assumed, so a
# check writing somewhere else still reports on what it actually wrote.
smoke() {
    label="$1"
    shift
    for output in "$@"; do :; done
    if "$bin" -hide_banner -loglevel error -y "$@" > "$work/stdout" 2> "$work/stderr"; then
        if [ -s "$output" ]; then
            echo "[verify-ffmpeg]   ok: $label"
        else
            echo "[verify-ffmpeg] EMPTY OUTPUT: $label" >&2
            failures=$((failures + 1))
        fi
    else
        echo "[verify-ffmpeg] FAILED: $label" >&2
        sed 's/^/[verify-ffmpeg]     /' "$work/stderr" >&2
        failures=$((failures + 1))
    fi
    rm -f "$output"
}

make_tone
t="$work/tone.wav"

# core/streamer.py's probe: no output file, read off stderr, exit code
# ignored — so this checks what that function actually parses.
if ! "$bin" -hide_banner -i "$t" 2>&1 | grep -q 'Audio:'; then
    echo "[verify-ffmpeg] FAILED: probe reports no Audio stream" >&2
    failures=$((failures + 1))
fi

# core/waveform.py and core/audio_analysis.py, the latter with ReplayGain
# and a mid-track start.
smoke "decode to s16le"        -i "$t" -vn -ac 1 -ar 11025 -f s16le "$work/out"
smoke "decode with ReplayGain" -ss 0.2 -i "$t" -vn -af volume=0.7 -ac 1 -ar 11025 -f s16le "$work/out"

# The three lossy tiers, exactly as lossy_encode_args() builds them, and the
# lossless re-wrap from lossless_encode_args() — with the -ss that once made
# the flac encoder refuse to start.
smoke "encode mp3"   -i "$t" -vn -acodec libmp3lame -b:a 192k -ar 44100 -f mp3   "$work/out"
smoke "encode aac"   -i "$t" -vn -acodec aac        -b:a 192k -ar 44100 -f adts  "$work/out"
smoke "encode opus"  -i "$t" -vn -acodec libopus    -b:a 128k -ar 48000 -vbr constrained -f ogg "$work/out"
smoke "encode flac"  -ss 0.2 -i "$t" -vn -acodec flac -frame_size 4096 -f flac   "$work/out"

# Sources for the copy tier, built with the encoders just checked. Reported
# like any other failure rather than left to `set -e`, which would end the
# run here and take the collected results with it — including the MISSING
# list from part one, which is usually the reason this failed at all. A
# source that didn't get written leaves its own copy check to fail too, with
# its own message; both name the same missing piece from different sides.
make_source() {
    label="$1"
    output="$2"
    shift 2
    if ! "$bin" -hide_banner -loglevel error -y "$@" "$output" 2> "$work/stderr"; then
        echo "[verify-ffmpeg] FAILED: $label" >&2
        sed 's/^/[verify-ffmpeg]     /' "$work/stderr" >&2
        failures=$((failures + 1))
    fi
}

make_source "source mp3"  "$work/src.mp3"  -i "$t" -acodec libmp3lame -b:a 192k -f mp3
make_source "source aac"  "$work/src.aac"  -i "$t" -acodec aac        -b:a 192k -f adts
make_source "source flac" "$work/src.flac" -i "$t" -acodec flac       -f flac
make_source "source opus" "$work/src.opus" -i "$t" -acodec libopus -ar 48000 -f ogg

# resolve_output_format()'s copy tier: no decode, straight into a container.
smoke "copy mp3"  -i "$work/src.mp3"  -vn -acodec copy -f mp3  "$work/out"
smoke "copy aac"  -i "$work/src.aac"  -vn -acodec copy -f adts "$work/out"
smoke "copy flac" -i "$work/src.flac" -vn -acodec copy -f flac "$work/out"
# Not a copy tier (Opus is deliberately excluded there) — this is the ogg
# demuxer and the opus decoder, which the radio relay reaches for an Ogg
# station and local playback for an .opus file.
smoke "decode opus" -i "$work/src.opus" -vn -ac 1 -ar 11025 -f s16le "$work/out"

# core/radio_relay.py: a station's bytes arrive on stdin, paced by ffmpeg.
if "$bin" -hide_banner -loglevel error -y -fflags nobuffer -readrate 1 \
    -readrate_initial_burst 15 -i pipe:0 -vn -map 0:a -acodec copy -f mp3 \
    -flush_packets 1 "$work/relay.mp3" < "$work/src.mp3" 2> "$work/stderr"; then
    echo "[verify-ffmpeg]   ok: relay from pipe:0"
else
    echo "[verify-ffmpeg] FAILED: relay from pipe:0" >&2
    sed 's/^/[verify-ffmpeg]     /' "$work/stderr" >&2
    failures=$((failures + 1))
fi
rm -f "$work/relay.mp3"

# routes/debug.py's test station, for the two mp3 muxer options it needs to
# look like a real Icecast stream rather than a file.
smoke "test station mp3" -re -i "$t" -vn -ac 2 -ar 44100 -b:a 128k \
    -write_xing 0 -id3v2_version 0 -f mp3 "$work/out"

if [ "$failures" -ne 0 ]; then
    echo "[verify-ffmpeg] $failures check(s) failed — see build/ffmpeg/required-components" >&2
    exit 1
fi

echo "[verify-ffmpeg] All checks passed"
