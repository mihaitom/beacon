"""core/ffmpeg.py — which ffmpeg this process runs.

Every module that shells out to ffmpeg takes its executable from here
rather than naming "ffmpeg" itself, so there is one place to point
somewhere else. `FFMPEG_PATH` is what the desktop app sets when it ships
its own build (see src/main/index.ts's startConnectServer()); the Docker
image and a development checkout set nothing and get the PATH lookup that
has always happened.

Read once at import, like every other setting in this backend — see
main.py's load_dotenv() note on why that ordering matters.
"""

import os
import shutil

import certifi

FFMPEG_BIN = os.getenv("FFMPEG_PATH") or "ffmpeg"


def trust_what_connect_trusts() -> None:
    """Points ffmpeg's TLS at the same CA bundle connect's own requests use.

    ffmpeg verifies certificates by default, against the CA directory its
    OpenSSL was compiled with. For the bundled Windows and macOS builds that
    is a path on the build machine (MSYS2, Homebrew), so on a user's machine
    every https media server or station failed with "certificate verify
    failed" while connect itself reached it fine. OpenSSL reads SSL_CERT_FILE
    instead when it is set, and every ffmpeg started from this process
    inherits it. An explicit SSL_CERT_FILE wins."""
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())


trust_what_connect_trusts()


def ffmpeg_available() -> bool:
    """Whether FFMPEG_BIN can actually be run. shutil.which() answers for an
    absolute path too, executable bit included, so a configured path that
    doesn't exist reports missing rather than failing at the first stream."""
    return bool(shutil.which(FFMPEG_BIN))
