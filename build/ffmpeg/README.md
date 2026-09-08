# The bundled ffmpeg

The desktop app ships its own ffmpeg. This directory holds the recipe; the
binary itself is built here and is not in git.

## Why it is bundled

connect shells out to ffmpeg for almost everything it does - preparing the
stream a Sonos/Chromecast/DLNA speaker pulls, this device's own playback of
anything a browser cannot decode, seeking inside a converted track, the radio
relay, the seek-bar waveform, the visualizer's analysis. Without it, an
install starts and then fails at the first track.

The Docker image has always built its own. A desktop install used to need one
on the system PATH, which meant a Windows or macOS user had to go and install
ffmpeg by hand before Beacon worked at all - and if they did, Beacon ran
against whatever build they happened to have.

## What it is

An audio-only ffmpeg: no video encoders, no X11/Wayland/SDL, no Blu-ray or
capture support, decoders only for formats a music library actually holds -
which is every format Navidrome, Jellyfin and Plex index, since the app hands
connect anything the browser cannot play. That is ~10MB instead of the ~130MB
a distribution build costs, and it is the same binary the server image runs.

`configure-flags` is the whole recipe and says why each format is on the list.
`versions` pins ffmpeg and libopus. Both are read by the Dockerfile's
`ffmpeg-builder` stage *and* by `scripts/build-ffmpeg.sh`, so the container
and the desktop app can never end up on builds that behave differently.

## Why the build is checked afterwards

**A build that succeeded is not a build that contains what the app asks
for.** ffmpeg's configure turns a whole comma list into one alternation and
warns only when *nothing* in it matched, so one wrong name among a dozen
right ones changes nothing visible - the build finishes, the binary is a few
KB smaller, and a listener finds out. That has happened repeatedly: a missing
`volume` filter meant every track failed while ReplayGain was on, a missing
`aac` encoder broke AAC casting, a missing `pcm_s32be` decoder broke 32-bit
AIFF, and `--enable-parser=mp3` did nothing at all because the parser is
called `mpegaudio`.

So there are two lists, on purpose:

- `configure-flags` is what the **build** is told to produce.
- `required-components` is what the **app** needs to exist, in the names the
  finished binary reports - which differ in a few places (`pcm_s16le` muxer
  reports as `s16le`, the `shorten` demuxer as `shn`, and `.dff` has no
  demuxer of its own, it is part of `iff`).

`scripts/check-ffmpeg-recipe.sh` catches the same class one step earlier,
before anything is compiled: it asks the ffmpeg source tree itself
(`./configure --list-parsers` and friends) whether every name in
`configure-flags` is one this version knows. That is the only check that can
cover parsers at all — a finished binary lists none, which is why
`--enable-parser=mp3` went unnoticed for a year.

`scripts/verify-ffmpeg.sh` checks the second against the first after every
build - including a build that was skipped or restored from CI's cache - and
then runs the actual command shapes connect uses, down to the `-ss` plus
`-frame_size` combination that once made the FLAC encoder refuse to start.
Anything missing fails the build.

`connect/tests/test_ffmpeg_contract.py` closes the same loop from the other
end, so `required-components` cannot fall behind the code either.

**Adding a format to the app means adding it to `required-components` first.**
The backend suite then fails until it is listed, and the build fails until
`configure-flags` can actually produce it.

## Building it

```bash
pnpm run package:ffmpeg
```

Runs automatically as part of every `package`/`publish` script, and skips
immediately when the binary already matches the recipe. Per platform it needs:

| Platform | Needs                                                            |
| -------- | ---------------------------------------------------------------- |
| Linux    | Docker - the build runs in the Dockerfile's own `ffmpeg-builder` |
| macOS    | Homebrew (the script installs nasm, lame, opus, openssl)          |
| Windows  | an MSYS2 shell (the script installs the mingw64 packages)         |

Linux goes through Docker rather than building against the host for two
reasons: a statically linked glibc ffmpeg cannot resolve a hostname, and a
dynamically linked one would tie the AppImage to the glibc of whichever
machine built it. The Alpine/musl build has neither problem.

Like the PyInstaller backend binary next to it, this cannot cross-compile -
each platform's package needs a binary built on that platform.

## How the app finds it

electron-builder copies it to `resources/ffmpeg/` (see `extraResources` in
`electron-builder.yml`), and `startConnectServer()` in `src/main/index.ts`
passes the path to the backend as `FFMPEG_PATH`. connect resolves it in
`core/ffmpeg.py`: `FFMPEG_PATH` if set, otherwise `ffmpeg` from PATH.

Both fallbacks still work. A build packaged without a binary here, a
development checkout, and the Docker image all use PATH exactly as before,
and an `FFMPEG_PATH` already set in the environment wins over the bundled
copy - which is how someone with their own build points Beacon at it.
