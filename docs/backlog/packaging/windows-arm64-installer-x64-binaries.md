# The Windows arm64 installer carries x64 binaries

**Status:** open, found reviewing the 1.2.1 draft (2026-09-09). Not a
release blocker - 1.2.1 went out with it. The point is to decide it once
instead of finding it again at every release.

`Beacon-<version>-win-arm64.exe` carries an x64 `ffmpeg.exe` and an x64
`connect-server.exe`, because both are built on the x64 runner and neither
can cross-compile. On Windows on ARM they run emulated - it works, but costs
speed exactly where it hurts (transcoding for casting and local playback).

Why there is an arm64 package at all: `electron-builder.yml` lists both
architectures under `win.target`, and that wins over the `--x64` in
`publish:win`. Visible in the v1.2.1 publish log - `packaging platform=win32
arch=x64` is followed by `packaging platform=win32 arch=arm64`, from the same
job.

Not new, only bigger: the backend binary was always x64 there, since 1.2.1
ffmpeg joins it. For macOS the consequence was drawn and the target set to
arm64 only, with exactly this reason in the comment in
`electron-builder.yml`; for Windows never.

## Two ways, neither weighed yet

- **Drop the arm64 target.** ARM users take the x64 installer, where
  Electron runs emulated too - slower, but consistent and without pretending
  to be a native package. One line in `electron-builder.yml` plus the then
  pointless `publish:win-arm64` in `package.json`.
- **Build natively on `windows-11-arm`.** GitHub offers the runner now. Needs
  a matrix leg of its own in `_publish-electron.yml`, and first to check:
  whether MSYS2 CLANGARM64 has the three packages `scripts/build-ffmpeg.sh`
  installs in its Windows branch (`mingw-w64-x86_64-lame/opus/openssl` would
  have other names there), and whether PyInstaller runs on Windows arm64.
