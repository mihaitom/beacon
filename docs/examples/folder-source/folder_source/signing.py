"""Signatures for the addresses Beacon fetches without a header.

They never expire on purpose: Beacon tells songs apart by their audio
address, so an address that changed every day would turn every replay into
a new song in its history."""

import base64
import hashlib
import hmac


def sign(secret: bytes, kind: str, item_id: str) -> str:
    digest = hmac.new(secret, f"{kind}:{item_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest[:16]).decode().rstrip("=")


def verify(secret: bytes, kind: str, item_id: str, signature: str) -> bool:
    # Bytes: compare_digest refuses a str with non-ASCII in it.
    return hmac.compare_digest(sign(secret, kind, item_id).encode(), signature.encode())
