"""core/client_cert.py — the client certificate for a media server behind mTLS.

A reverse proxy in front of Navidrome, Jellyfin or Plex can require every
client to present a certificate before it lets a request through (nginx's
`ssl_verify_client`, Traefik's `clientAuth`, Caddy's `client_auth`). None
of the media servers do this themselves, so it is purely a TLS matter and
works the same for all three.

Everything connect fetches from the media server has to carry it: the
pooled httpx clients (proxy, bridges, media adapters, AirPlay) through
`ssl_context()`, and every ffmpeg that opens a track itself through
`ffmpeg_args()`. Speakers that load cover art straight from the media
server cannot present one; that stays a documented limitation.

Read once at import, like every other setting in this backend.
"""

import logging
import os
import ssl

import certifi

logger = logging.getLogger("connect.client_cert")

CERT_FILE = os.getenv("MEDIA_SERVER_CLIENT_CERT", "").strip()
# Optional: a PEM holding both certificate and key needs only the first.
KEY_FILE = os.getenv("MEDIA_SERVER_CLIENT_KEY", "").strip()


def configured() -> bool:
    return bool(CERT_FILE)


def ssl_context() -> ssl.SSLContext | bool:
    """What to hand httpx as `verify=`: a context carrying the certificate,
    or True (httpx's own default) when none is configured.

    Trusts the same CA bundle httpx would on its own — SSL_CERT_FILE when
    set, which is also how a private CA for the proxy's server certificate
    gets in, otherwise certifi. Raises on a certificate that cannot be
    loaded; check_at_startup() is where that gets said out loud."""
    if not configured():
        return True
    ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or certifi.where())
    ctx.load_cert_chain(CERT_FILE, KEY_FILE or None)
    return ctx


def ffmpeg_args(url: str) -> list[str]:
    """Input options for an ffmpeg reading `url`, to go before its `-i`.

    Only for https: there is no TLS handshake to present anything in
    otherwise. ffmpeg's http protocol passes these on to the tls layer
    underneath it."""
    if not configured() or not url.lower().startswith("https://"):
        return []
    return ["-cert_file", CERT_FILE, "-key_file", KEY_FILE or CERT_FILE]


def check_at_startup() -> None:
    """Logs whether the configured certificate loads, naming the setting —
    the handshake errors every request would fail with otherwise never
    mention the file. Logged rather than raised, like a missing ffmpeg: a
    backend that does not start at all is harder to diagnose in the desktop
    app than one that says what is wrong."""
    if not configured():
        return
    try:
        ssl_context()
    except (OSError, ssl.SSLError) as e:
        logger.error(
            f"❌ MEDIA_SERVER_CLIENT_CERT/MEDIA_SERVER_CLIENT_KEY could not be loaded: {e}"
        )
        return
    logger.info(f"✅ Presenting client certificate {CERT_FILE} to the media server")
