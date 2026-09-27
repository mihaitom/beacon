"""The integration key (core/integration_key.py) and how routes/remote.py
accepts it next to the phone password."""

import os
import stat
import sys

import pytest
from fastapi.testclient import TestClient

from core import integration_key
from core.remote import remote
from main import app


@pytest.fixture
def unauthed():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _restart():
    integration_key.forget_cached()


# ── core/integration_key.py ─────────────────────────────────────────────────


def test_no_key_by_default():
    assert integration_key.get() == ""
    assert not integration_key.matches("")
    assert not integration_key.matches(None)


def test_generated_key_survives_a_restart():
    key = integration_key.generate()
    _restart()
    assert integration_key.get() == key
    assert integration_key.matches(key)


def test_generating_again_replaces_the_old_key():
    old = integration_key.generate()
    new = integration_key.generate()
    assert new != old
    assert not integration_key.matches(old)


def test_revoked_key_stays_revoked_after_a_restart():
    key = integration_key.generate()
    integration_key.revoke()
    _restart()
    assert not integration_key.matches(key)


def test_revoke_without_a_key_is_harmless():
    integration_key.revoke()
    assert integration_key.get() == ""


def test_non_ascii_input_is_rejected_rather_than_raising():
    integration_key.generate()
    assert not integration_key.matches("schlüssel")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_key_file_is_readable_by_its_owner_only():
    integration_key.generate()
    mode = stat.S_IMODE(os.stat(integration_key._path()).st_mode)
    assert mode == 0o600


def test_generate_raises_when_it_cannot_save(monkeypatch, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("")
    monkeypatch.setattr(integration_key, "_DATA_DIR", str(blocker / "sub"))
    with pytest.raises(OSError):
        integration_key.generate()
    assert integration_key.get() == ""


# ── routes: managing the key (CONNECT_TOKEN) ────────────────────────────────


def test_key_endpoints_require_the_connect_token(unauthed):
    assert unauthed.post("/remote/integration-key").status_code == 401
    assert unauthed.delete("/remote/integration-key").status_code == 401


def test_generate_returns_the_key_and_address(client):
    body = client.post("/remote/integration-key").json()
    assert integration_key.matches(body["key"])
    assert body["port"] > 0
    assert body["lan_ip"]


def test_generate_answers_500_when_the_key_cannot_be_saved(client, monkeypatch, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("")
    monkeypatch.setattr(integration_key, "_DATA_DIR", str(blocker / "sub"))
    assert client.post("/remote/integration-key").status_code == 500


def test_status_says_whether_a_key_exists(client):
    assert client.get("/remote/status").json()["integration"] is False
    client.post("/remote/integration-key")
    assert client.get("/remote/status").json()["integration"] is True
    client.delete("/remote/integration-key")
    assert client.get("/remote/status").json()["integration"] is False


def test_status_never_returns_the_key(client):
    key = client.post("/remote/integration-key").json()["key"]
    assert key not in client.get("/remote/status").text


# ── routes: using the key on the phone endpoints ────────────────────────────


def test_key_works_while_phone_remote_is_off(unauthed):
    key = integration_key.generate()
    remote.renderer_connected = True
    remote.snapshot = {"playing": True}
    resp = unauthed.get("/remote/state", headers={"X-Remote-Password": key})
    assert resp.status_code == 200
    assert resp.json() == {"playing": True}


def test_key_works_as_query_param(unauthed):
    key = integration_key.generate()
    remote.renderer_connected = True
    assert unauthed.get(f"/remote/state?password={key}").status_code == 200


def test_key_answers_503_while_the_app_is_not_connected(unauthed):
    key = integration_key.generate()
    remote.renderer_connected = False
    resp = unauthed.get("/remote/state", headers={"X-Remote-Password": key})
    assert resp.status_code == 503


def test_revoked_key_no_longer_works(client, unauthed):
    key = client.post("/remote/integration-key").json()["key"]
    client.delete("/remote/integration-key")
    remote.renderer_connected = True
    resp = unauthed.get("/remote/state", headers={"X-Remote-Password": key})
    assert resp.status_code == 404


def test_wrong_key_while_phone_remote_is_on_is_401(client, unauthed):
    integration_key.generate()
    client.post("/remote/enable")
    remote.renderer_connected = True
    resp = unauthed.get("/remote/state", headers={"X-Remote-Password": "nope"})
    assert resp.status_code == 401


def test_phone_password_still_works_next_to_a_key(client, unauthed):
    integration_key.generate()
    password = client.post("/remote/enable").json()["password"]
    resp = unauthed.get("/remote/state", headers={"X-Remote-Password": password})
    assert resp.status_code == 200


def test_switching_phones_off_keeps_the_integration_connected(client, unauthed):
    key = integration_key.generate()
    client.post("/remote/enable")
    remote.renderer_connected = True
    client.post("/remote/disable")
    resp = unauthed.get("/remote/state", headers={"X-Remote-Password": key})
    assert resp.status_code == 200


def test_phone_password_is_not_accepted_as_the_key_once_phones_are_off(client, unauthed):
    integration_key.generate()
    password = client.post("/remote/enable").json()["password"]
    client.post("/remote/disable")
    remote.renderer_connected = True
    resp = unauthed.get("/remote/state", headers={"X-Remote-Password": password})
    assert resp.status_code == 404


async def test_an_integration_stream_is_not_counted_as_a_phone():
    """The desktop shows the phone count on its button and closes the
    pairing dialog when it rises — Home Assistant connecting must do
    neither."""
    import asyncio

    from routes.remote import phone_events

    agent_queue = remote.command_bus.subscribe()
    resp = await phone_events(is_integration=True)
    gen = resp.body_iterator
    try:
        await gen.__anext__()
        assert await asyncio.wait_for(agent_queue.get(), timeout=1.0) == {
            "kind": "phones",
            "count": 0,
        }
    finally:
        await gen.aclose()
    assert await asyncio.wait_for(agent_queue.get(), timeout=1.0) == {"kind": "phones", "count": 0}
    assert remote.integration_streams == 0
    remote.command_bus.unsubscribe(agent_queue)
