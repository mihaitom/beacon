"""Tests for routes/pairing.py — the /pair/airplay/{start,finish} HAP pairing
flow, plus GET (list)/DELETE (unpair).

Includes regression coverage for a race where concurrent /start requests for
the same device (e.g. a frontend bug that re-fired the pairing dialog's start
effect) each independently began a fresh pyatv HAP pair-setup handshake
against the same physical device. The device can only track one pending
handshake, so the losing request(s) got an incomplete response and pyatv
failed with a bare KeyError (e.g. "<TlvValue.Salt: 2>").
"""

import asyncio
import time
from unittest.mock import MagicMock, patch

import httpx
import pytest

import routes.pairing as routes_pairing
from delivery import credentials
from main import app


class _FakeDeviceConfig:
    def __init__(self, name: str):
        self.name = name


class _FakePairing:
    def __init__(
        self,
        device_provides_pin: bool = True,
        credentials: str | None = "creds",
        begin_error: Exception | None = None,
        finish_error: Exception | None = None,
        close_error: Exception | None = None,
    ):
        self.device_provides_pin = device_provides_pin
        self.service = MagicMock(credentials=credentials)
        self.begin_calls = 0
        self.finish_calls = 0
        self.close_calls = 0
        self.pinned: int | None = None
        self._begin_error = begin_error
        self._finish_error = finish_error
        self._close_error = close_error

    async def begin(self) -> None:
        self.begin_calls += 1
        # Slow enough that a second concurrent /start call is guaranteed to
        # arrive while this one is still "talking to the device".
        await asyncio.sleep(0.05)
        if self._begin_error:
            raise self._begin_error

    def pin(self, pin: int) -> None:  # synchronous, like the real pyatv API
        self.pinned = pin

    async def finish(self) -> None:
        self.finish_calls += 1
        if self._finish_error:
            raise self._finish_error

    async def close(self) -> None:
        self.close_calls += 1
        if self._close_error:
            raise self._close_error


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


# ── /start error handling ────────────────────────────────────────────────────


def test_start_device_not_found_lists_available_devices(client, default_session):
    async def fake_scan(*args, **kwargs):
        return [_FakeDeviceConfig("Living Room"), _FakeDeviceConfig("Kitchen")]

    with patch("pyatv.scan", side_effect=fake_scan):
        r = client.post("/pair/airplay/start", json={"name": "Bedroom"})

    assert r.status_code == 404
    assert r.json() == {
        "error": "Device 'Bedroom' not found. Available: ['Living Room', 'Kitchen']"
    }


def test_start_surfaces_a_friendly_message_for_a_pending_tlv_rejection(client, default_session):
    """pyatv raises a bare KeyError (e.g. '<TlvValue.Salt: 2>') when the
    device still considers an earlier attempt pending — must not leak that
    raw KeyError to the frontend."""
    device = _FakeDeviceConfig("TlvDevice")

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        raise KeyError("<TlvValue.Salt: 2>")

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r = client.post("/pair/airplay/start", json={"name": "TlvDevice"})

    assert r.status_code == 500
    assert "power-cycle" in r.json()["error"]
    assert "TlvDevice" not in _sessions_snapshot()  # nothing left dangling


def test_start_surfaces_a_friendly_message_for_a_470_response(client, default_session):
    device = _FakeDeviceConfig("MfiDevice")

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        raise RuntimeError("470 Connection Authorization Required")

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r = client.post("/pair/airplay/start", json={"name": "MfiDevice"})

    assert r.status_code == 500
    assert "Sonos" in r.json()["error"]


def test_start_falls_back_to_the_raw_message_for_an_unrecognized_error(client, default_session):
    device = _FakeDeviceConfig("GenericErrorDevice")

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        raise RuntimeError("network unreachable")

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r = client.post("/pair/airplay/start", json={"name": "GenericErrorDevice"})

    assert r.status_code == 500
    assert r.json() == {"error": "network unreachable"}


def test_start_closes_the_pairing_object_when_begin_fails_after_pair_succeeded(
    client, default_session
):
    device = _FakeDeviceConfig("BeginFailsDevice")
    fake_pairing = _FakePairing(begin_error=RuntimeError("device went away"))

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        return fake_pairing

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r = client.post("/pair/airplay/start", json={"name": "BeginFailsDevice"})

    assert r.status_code == 500
    assert fake_pairing.close_calls == 1
    assert "BeginFailsDevice" not in _sessions_snapshot()


def test_start_swallows_a_close_error_on_the_failed_pairing_object(client, default_session):
    """close() itself failing while cleaning up after a failed begin() must
    not shadow the real error / crash the response."""
    device = _FakeDeviceConfig("CloseErrorDevice")
    fake_pairing = _FakePairing(
        begin_error=RuntimeError("device went away"),
        close_error=RuntimeError("close also failed"),
    )

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        return fake_pairing

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r = client.post("/pair/airplay/start", json={"name": "CloseErrorDevice"})

    assert r.status_code == 500
    assert r.json() == {"error": "device went away"}


def test_start_with_force_closes_a_still_fresh_existing_session_before_restarting(
    client, default_session
):
    device = _FakeDeviceConfig("ForceDevice")
    old_pairing = _FakePairing()
    routes_pairing._sessions["ForceDevice"] = (old_pairing, time.monotonic())
    new_pairing = _FakePairing()

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        return new_pairing

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r = client.post("/pair/airplay/start", json={"name": "ForceDevice", "force": True})

    assert r.status_code == 200
    assert old_pairing.close_calls == 1
    assert routes_pairing._sessions["ForceDevice"][0] is new_pairing


def test_start_ignores_a_close_error_on_the_old_session_being_replaced(client, default_session):
    device = _FakeDeviceConfig("OldCloseErrorDevice")
    old_pairing = _FakePairing(close_error=RuntimeError("boom"))
    routes_pairing._sessions["OldCloseErrorDevice"] = (old_pairing, time.monotonic())
    new_pairing = _FakePairing()

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        return new_pairing

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r = client.post(
            "/pair/airplay/start", json={"name": "OldCloseErrorDevice", "force": True}
        )

    assert r.status_code == 200


def test_start_re_pairs_once_the_existing_session_has_expired(client, default_session):
    """A session older than _SESSION_TTL must not be reused — the device
    itself will have already timed out the pending pairing by then."""
    device = _FakeDeviceConfig("ExpiredDevice")
    old_pairing = _FakePairing()
    stale_start = time.monotonic() - (routes_pairing._SESSION_TTL + 1)
    routes_pairing._sessions["ExpiredDevice"] = (old_pairing, stale_start)
    new_pairing = _FakePairing()
    pair_call_count = 0

    async def fake_scan(*args, **kwargs):
        return [device]

    async def fake_pair(*args, **kwargs):
        nonlocal pair_call_count
        pair_call_count += 1
        return new_pairing

    with (
        patch("pyatv.scan", side_effect=fake_scan),
        patch("pyatv.pair", side_effect=fake_pair),
    ):
        r = client.post("/pair/airplay/start", json={"name": "ExpiredDevice"})

    assert r.status_code == 200
    assert pair_call_count == 1  # a fresh handshake, not the stale session reused
    assert routes_pairing._sessions["ExpiredDevice"][0] is new_pairing


def _sessions_snapshot() -> dict:
    return routes_pairing._sessions


# ── /finish ───────────────────────────────────────────────────────────────


def test_finish_without_a_prior_start_is_rejected(client, default_session):
    r = client.post("/pair/airplay/finish", json={"name": "NeverStarted"})

    assert r.status_code == 400
    assert "Call /start first" in r.json()["error"]


def test_finish_success_saves_credentials_and_clears_the_session(client, default_session, tmp_path):
    fake_pairing = _FakePairing(credentials="s3cr3t-creds")
    routes_pairing._sessions["FinishOk"] = (fake_pairing, time.monotonic())

    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        r = client.post("/pair/airplay/finish", json={"name": "FinishOk", "pin": 1234})

        assert r.status_code == 200
        assert r.json() == {"success": True, "name": "FinishOk"}
        assert credentials.get("FinishOk") == "s3cr3t-creds"

    assert fake_pairing.pinned == 1234
    assert fake_pairing.finish_calls == 1
    assert fake_pairing.close_calls == 1
    assert "FinishOk" not in routes_pairing._sessions


def test_finish_without_a_pin_skips_pin_entry(client, default_session, tmp_path):
    """Some devices supply their own PIN (device_provides_pin) — the
    frontend then submits no `pin` at all, and pairing.pin() must not be
    called with a bogus value."""
    fake_pairing = _FakePairing(credentials="creds")
    routes_pairing._sessions["FinishNoPin"] = (fake_pairing, time.monotonic())

    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        r = client.post("/pair/airplay/finish", json={"name": "FinishNoPin"})

    assert r.status_code == 200
    assert fake_pairing.pinned is None


def test_finish_reports_a_wrong_pin_as_a_friendly_message(client, default_session, tmp_path):
    fake_pairing = _FakePairing(finish_error=RuntimeError("470 Connection Authorization Required"))
    routes_pairing._sessions["WrongPin"] = (fake_pairing, time.monotonic())

    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        r = client.post("/pair/airplay/finish", json={"name": "WrongPin", "pin": 1111})

    assert r.status_code == 500
    assert "Incorrect PIN" in r.json()["error"]
    assert fake_pairing.close_calls == 1
    assert "WrongPin" not in routes_pairing._sessions


def test_finish_falls_back_to_the_raw_message_for_an_unrecognized_finish_error(
    client, default_session, tmp_path
):
    fake_pairing = _FakePairing(finish_error=RuntimeError("device disconnected"))
    routes_pairing._sessions["FinishGenericError"] = (fake_pairing, time.monotonic())

    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        r = client.post("/pair/airplay/finish", json={"name": "FinishGenericError", "pin": 1111})

    assert r.status_code == 500
    assert r.json() == {"error": "device disconnected"}


def test_finish_swallows_a_close_error_after_a_failed_finish(client, default_session, tmp_path):
    fake_pairing = _FakePairing(
        finish_error=RuntimeError("470 Connection Authorization Required"),
        close_error=RuntimeError("close also failed"),
    )
    routes_pairing._sessions["FinishCloseError"] = (fake_pairing, time.monotonic())

    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        r = client.post("/pair/airplay/finish", json={"name": "FinishCloseError", "pin": 1111})

    assert r.status_code == 500
    assert "Incorrect PIN" in r.json()["error"]


def test_finish_reports_when_pairing_completes_without_credentials(
    client, default_session, tmp_path
):
    fake_pairing = _FakePairing(credentials=None)
    routes_pairing._sessions["NoCreds"] = (fake_pairing, time.monotonic())

    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        r = client.post("/pair/airplay/finish", json={"name": "NoCreds", "pin": 1234})

    assert r.status_code == 500
    assert r.json() == {"error": "Pairing completed but no credentials received."}
    # The (empty) session must still be torn down, not left dangling.
    assert "NoCreds" not in routes_pairing._sessions


def test_finish_swallows_a_close_error_on_the_success_path(client, default_session, tmp_path):
    fake_pairing = _FakePairing(credentials="creds", close_error=RuntimeError("boom"))
    routes_pairing._sessions["FinishSuccessCloseError"] = (fake_pairing, time.monotonic())

    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        r = client.post(
            "/pair/airplay/finish", json={"name": "FinishSuccessCloseError", "pin": 1234}
        )

    assert r.status_code == 200


# ── /pair/airplay (list) and DELETE /pair/airplay/{name} ────────────────────


def test_list_paired_reflects_saved_credentials(client, default_session, tmp_path):
    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        credentials.save("ListedDevice", "creds")
        r = client.get("/pair/airplay")

    assert r.json() == {"paired": ["ListedDevice"]}


def test_unpair_removes_a_paired_device(client, default_session, tmp_path):
    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        credentials.save("UnpairMe", "creds")
        r = client.delete("/pair/airplay/UnpairMe")

        assert r.status_code == 200
        assert r.json() == {"success": True, "name": "UnpairMe"}
        assert credentials.get("UnpairMe") is None


def test_unpair_a_device_that_was_never_paired_reports_404(client, default_session, tmp_path):
    with patch.object(credentials, "_PATH", str(tmp_path / "creds.json")):
        r = client.delete("/pair/airplay/NeverPaired")

    assert r.status_code == 404
    assert r.json() == {"error": "'NeverPaired' was not paired."}


# ── reap_stale_pairings ──────────────────────────────────────────────────────
# Regression coverage: a user who starts a pairing and then just gives up
# (closes the dialog, never calls /finish or /start again) used to leave the
# pyatv handshake/connection sitting in _sessions forever — /start's own TTL
# check only ever noticed it on a *later* /start for the same device.


async def test_reap_stale_pairings_once_closes_and_removes_expired_sessions(default_session):
    fresh_pairing = _FakePairing()
    stale_pairing = _FakePairing()
    routes_pairing._sessions["FreshDevice"] = (fresh_pairing, time.monotonic())
    routes_pairing._sessions["StaleDevice"] = (
        stale_pairing,
        time.monotonic() - (routes_pairing._SESSION_TTL + 1),
    )

    reaped = await routes_pairing.reap_stale_pairings_once()

    assert reaped == ["StaleDevice"]
    assert "StaleDevice" not in routes_pairing._sessions
    assert stale_pairing.close_calls == 1
    # The still-fresh session is untouched.
    assert routes_pairing._sessions["FreshDevice"][0] is fresh_pairing
    assert fresh_pairing.close_calls == 0


async def test_reap_stale_pairings_once_is_a_no_op_with_nothing_stale(default_session):
    fresh_pairing = _FakePairing()
    routes_pairing._sessions["FreshDevice"] = (fresh_pairing, time.monotonic())

    reaped = await routes_pairing.reap_stale_pairings_once()

    assert reaped == []
    assert fresh_pairing.close_calls == 0


async def test_reap_stale_pairings_once_swallows_a_close_error(default_session):
    """A device that errors on close() must still be forgotten — same
    'best-effort cleanup' reasoning as /start's own old-session cleanup."""
    stale_pairing = _FakePairing(close_error=RuntimeError("already gone"))
    routes_pairing._sessions["StaleDevice"] = (
        stale_pairing,
        time.monotonic() - (routes_pairing._SESSION_TTL + 1),
    )

    reaped = await routes_pairing.reap_stale_pairings_once()

    assert reaped == ["StaleDevice"]
    assert "StaleDevice" not in routes_pairing._sessions


async def test_reap_stale_pairings_once_drops_the_devices_lock_when_idle(default_session):
    stale_pairing = _FakePairing()
    routes_pairing._sessions["StaleDevice"] = (
        stale_pairing,
        time.monotonic() - (routes_pairing._SESSION_TTL + 1),
    )
    routes_pairing._locks["StaleDevice"] = asyncio.Lock()

    await routes_pairing.reap_stale_pairings_once()

    assert "StaleDevice" not in routes_pairing._locks


async def test_reap_stale_pairings_once_keeps_a_lock_currently_held(default_session):
    """Must never pull a lock out from under a concurrent /start that's
    about to acquire it — only ever cleaned up once nothing holds it."""
    stale_pairing = _FakePairing()
    routes_pairing._sessions["StaleDevice"] = (
        stale_pairing,
        time.monotonic() - (routes_pairing._SESSION_TTL + 1),
    )
    lock = asyncio.Lock()
    routes_pairing._locks["StaleDevice"] = lock

    async with lock:
        await routes_pairing.reap_stale_pairings_once()
        assert "StaleDevice" in routes_pairing._locks


async def test_reap_stale_pairings_calls_reap_once_after_the_interval():
    from unittest.mock import AsyncMock

    with (
        patch(
            "routes.pairing.asyncio.sleep", side_effect=[None, asyncio.CancelledError()]
        ),
        patch.object(
            routes_pairing, "reap_stale_pairings_once", new=AsyncMock()
        ) as reap_once_mock,
    ):
        task = asyncio.create_task(routes_pairing.reap_stale_pairings())
        try:
            await task
        except asyncio.CancelledError:
            pass

    reap_once_mock.assert_awaited_once()
