"""Tests for routes/pairing.py — /pair/airplay/start concurrency.

Regression coverage for a race where concurrent /start requests for the same
device (e.g. a frontend bug that re-fired the pairing dialog's start effect)
each independently began a fresh pyatv HAP pair-setup handshake against the
same physical device. The device can only track one pending handshake, so the
losing request(s) got an incomplete response and pyatv failed with a bare
KeyError (e.g. "<TlvValue.Salt: 2>").
"""

import asyncio
from unittest.mock import MagicMock, patch

import httpx
import pytest

from main import app


class _FakeDeviceConfig:
    def __init__(self, name: str):
        self.name = name


class _FakePairing:
    def __init__(self, device_provides_pin: bool = True):
        self.device_provides_pin = device_provides_pin
        self.service = MagicMock(credentials="creds")
        self.begin_calls = 0

    async def begin(self) -> None:
        self.begin_calls += 1
        # Slow enough that a second concurrent /start call is guaranteed to
        # arrive while this one is still "talking to the device".
        await asyncio.sleep(0.05)

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_concurrent_start_requests_only_pair_once(client, default_session):
    device = _FakeDeviceConfig("TestDevice")
    fake_pairing = _FakePairing()
    pair_call_count = 0

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        nonlocal pair_call_count
        pair_call_count += 1
        return fake_pairing

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(base_url="http://test", transport=transport) as ac:
            results = await asyncio.gather(
                ac.post(
                    "/pair/airplay/start",
                    headers=client.headers,
                    json={"name": "TestDevice"},
                ),
                ac.post(
                    "/pair/airplay/start",
                    headers=client.headers,
                    json={"name": "TestDevice"},
                ),
            )

    # Only one of the two concurrent requests actually talked to the device —
    # the other waited for it and reused the session it created.
    assert pair_call_count == 1
    assert fake_pairing.begin_calls == 1
    for r in results:
        assert r.status_code == 200
        assert r.json() == {"device_provides_pin": True, "name": "TestDevice"}


def test_sequential_start_calls_reuse_session(client, default_session):
    device = _FakeDeviceConfig("TestDevice2")
    fake_pairing = _FakePairing()
    pair_call_count = 0

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        nonlocal pair_call_count
        pair_call_count += 1
        return fake_pairing

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r1 = client.post("/pair/airplay/start", json={"name": "TestDevice2"})
        r2 = client.post("/pair/airplay/start", json={"name": "TestDevice2"})

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert pair_call_count == 1
