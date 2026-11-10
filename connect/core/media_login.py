"""core/media_login.py - a media server login a device key carries.

Browsing and starting music for an app need the media server, and on a
server nobody may be signed in when the app asks: a session lives in memory
and ends half an hour after its last tab. So a key with the library right
keeps the login of the session that made it - what that session itself
holds: Jellyfin's and Plex's access token, or Subsonic's prebuilt token
query, which is as good as the password for as long as the password stands.

Sealed with a key derived from the device key's own secret. The database
holds only that secret's hash, so the login opens only while an app presents
its key: a copy of the database, or a backup of it, gives nothing away.
"""

import json
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from media import JellyfinClient, PlexClient, SubsonicClient
from media.base import MediaClient

_NONCE_BYTES = 12
_INFO = b"beacon device key media login"


def build_client(
    server_type: str,
    url: str,
    credential: str,
    user_id: str = "",
    machine_identifier: str = "",
) -> JellyfinClient | PlexClient | SubsonicClient:
    """The client for one login, as /config builds it.

    NAVIDROME_INTERNAL_URL and JELLYFIN_INTERNAL_URL are deliberately
    separate: one shared variable once sent a Jellyfin session's ping to
    Navidrome's address. Plex has none, its address comes from Plex's own
    discovery, which already prefers a local connection."""
    server_type = server_type.lower()
    if server_type == "jellyfin":
        return JellyfinClient(
            url,
            token=credential,
            user_id=user_id,
            internal_url=os.getenv("JELLYFIN_INTERNAL_URL", ""),
        )
    if server_type == "plex":
        return PlexClient(url, token=credential, machine_identifier=machine_identifier)
    return SubsonicClient(
        url, credential=credential, internal_url=os.getenv("NAVIDROME_INTERNAL_URL", "")
    )


def capture(media: MediaClient) -> dict:
    """What build_client() needs to make `media` again."""
    if isinstance(media, JellyfinClient):
        return {
            "server_type": "jellyfin",
            "url": media.base_url,
            "credential": media.token,
            "user_id": media.user_id,
        }
    if isinstance(media, PlexClient):
        return {
            "server_type": "plex",
            "url": media.base_url,
            "credential": media.token,
            "machine_identifier": media.machine_identifier,
        }
    return {"server_type": "subsonic", "url": media.base_url, "credential": media._credential}


def client_for(login: dict) -> MediaClient:
    return build_client(
        login["server_type"],
        login["url"],
        login["credential"],
        login.get("user_id", ""),
        login.get("machine_identifier", ""),
    )


def _cipher(key_id: str, secret: str) -> AESGCM:
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=key_id.encode(), info=_INFO).derive(
        secret.encode()
    )
    return AESGCM(derived)


def seal(login: dict, key_id: str, secret: str) -> bytes:
    nonce = os.urandom(_NONCE_BYTES)
    # The key id as associated data: a sealed login moved to another row
    # does not open there.
    sealed = _cipher(key_id, secret).encrypt(nonce, json.dumps(login).encode(), key_id.encode())
    return nonce + sealed


def unseal(blob: bytes, key_id: str, secret: str) -> dict | None:
    """None for a login sealed with something else."""
    try:
        plain = _cipher(key_id, secret).decrypt(
            blob[:_NONCE_BYTES], blob[_NONCE_BYTES:], key_id.encode()
        )
    except (InvalidTag, ValueError):
        return None
    return json.loads(plain)
