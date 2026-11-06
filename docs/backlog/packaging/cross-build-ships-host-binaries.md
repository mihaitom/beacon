# A Windows or Mac build made on Linux ships Linux binaries

**Status:** open, found 2026-11-05 while checking discussion #79. Seen in a
real build; no such package has been released, since CI builds each platform on
its own runner.

On Linux, `electron-builder --win --dir` and `--mac --dir` exit 0. The result
has a `Beacon.exe` or `Beacon.app`, but `connect-server` and `ffmpeg` inside it
are Linux ELF files, because neither can be cross-compiled and the build simply
takes what is there. The app would start without a backend, and nothing reports
it. `publish:win` and `publish:mac` run the same steps and would upload the
result; that was deduced from the scripts, not tried.

## What to do

Fail the build when the bundled binaries do not match the target platform, for
example in an electron-builder `afterPack` hook that checks the file format.
`test-package.yml` already looks at the package, but only on native runners,
where this cannot happen.

Related: [the Windows arm64 installer carries x64 binaries](windows-arm64-installer-x64-binaries.md),
which a check that also compares the architecture would catch too.
