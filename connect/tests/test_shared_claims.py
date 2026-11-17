"""Speakers shared between a desktop app and its server: core/claims.py's
remote sets, core/shared_claims.py on both sides, and the server's routes
(docs/plans/shared-speaker-claims.md)."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from core import device_keys, play_history, server_link, shared_claims
from core.claims import REMOTE_TTL_SECONDS, ClaimRegistry, claims, remote_holder_id
from core.play_history import Account
from core.session import SessionState, check_claims, holder_name, registry
from main import app
from routes import device_link

ALICE = Account("subsonic", "srv-id", "alice")
SERVER = remote_holder_id(shared_claims.SERVER_SOURCE)
DEN = {"type": "sonos", "name": "Den", "label": "bob"}


@pytest.fixture(autouse=True)
def _isolated(tmp_path):
    device_link.limiter.clear()
    with patch.object(play_history, "_DIR", str(tmp_path / "history")):
        yield


@pytest.fixture
def public():
    with TestClient(app) as c:
        yield c


def key(*scopes: str) -> str:
    return device_keys.create(ALICE, "Laptop", None, scopes=scopes or ("sync",))["key"]


def auth(presented: str) -> dict:
    return {server_link.KEY_HEADER: presented}


def session(session_id: str, name: str) -> SessionState:
    made = SessionState(session_id)
    made.display_name = name
    registry._sessions[session_id] = made
    return made


# ── core/claims.py ───────────────────────────────────────────────────────


async def test_a_remote_claim_is_in_the_way_like_a_local_one():
    claims.set_remote(shared_claims.SERVER_SOURCE, [DEN])
    assert await claims.claim("sonos", "Den", "mine") == SERVER
    assert claims.holder_of("sonos", "Den") == SERVER
    assert holder_name(SERVER, "sonos", "Den") == "bob"


async def test_the_conflict_names_whoever_holds_it_on_the_other_side():
    claims.set_remote(shared_claims.SERVER_SOURCE, [DEN])
    with patch("core.session.list_target_pairs", return_value=[("sonos", "Den")]):
        error, _ = await check_claims(object(), SessionState("mine"))
    assert error["error"] == "device_in_use"
    assert error["owner"] == "bob"


async def test_device_events_still_go_to_local_sessions_only():
    claims.set_remote(shared_claims.SERVER_SOURCE, [DEN])
    assert claims.owner_of("sonos", "Den") is None


async def test_a_remote_set_lapses_when_it_is_not_refreshed():
    registry_ = ClaimRegistry()
    registry_.set_remote("server", [DEN], now=0.0)
    assert registry_.holder_of("sonos", "Den") is None
    registry_.touch_remote("server")
    assert registry_.holder_of("sonos", "Den") == SERVER
    assert REMOTE_TTL_SECONDS > 2 * shared_claims.PUSH_EVERY_SECONDS


async def test_a_remote_set_is_replaced_as_a_whole():
    claims.set_remote("server", [DEN])
    claims.set_remote("server", [{"type": "dlna", "name": "Hall", "label": "bob"}])
    assert claims.holder_of("sonos", "Den") is None
    assert claims.holder_of("dlna", "Hall") == SERVER


@pytest.mark.parametrize("how", ["claim", "claim_many", "force_claim_many"])
async def test_taking_over_a_remote_holders_speaker_is_reported(how):
    reported = []
    registry_ = ClaimRegistry()
    registry_.on_remote_taken = lambda *taken: reported.append(taken)
    registry_.set_remote("server", [DEN])
    if how == "claim":
        await registry_.claim("sonos", "Den", "mine", force=True)
    elif how == "claim_many":
        await registry_.claim_many([("sonos", "Den")], "mine", force=True)
    else:
        await registry_.force_claim_many([("sonos", "Den")], "mine")
    assert reported == [("server", "sonos", "Den")]
    assert registry_.holder_of("sonos", "Den") == "mine"
    assert registry_.remote_claims() == []


async def test_a_refused_claim_reports_nothing():
    reported = []
    registry_ = ClaimRegistry()
    registry_.on_remote_taken = lambda *taken: reported.append(taken)
    registry_.set_remote("server", [DEN])
    await registry_.claim("sonos", "Den", "mine")
    assert reported == []


# ── On the server ────────────────────────────────────────────────────────


def test_a_desktop_reports_its_speakers_under_its_account_and_host(public):
    response = public.put(
        "/device-link/claims",
        json={"host": "desk", "claims": [{"type": "sonos", "name": "Den"}]},
        headers=auth(key()),
    )
    assert response.status_code == 200
    assert claims.remote_claims() == [{"type": "sonos", "name": "Den", "label": "alice on desk"}]


@pytest.mark.parametrize("path", ["/device-link/claims", "/device-link/claims/taken"])
def test_only_a_desktops_key_takes_part(public, path):
    body = {"type": "sonos", "name": "Den"} if path.endswith("taken") else {"claims": []}
    method = public.post if path.endswith("taken") else public.put
    assert method(path, json=body, headers=auth(key("control"))).status_code == 403


def test_an_unknown_speaker_type_is_refused(public):
    response = public.put(
        "/device-link/claims",
        json={"claims": [{"type": "radio", "name": "Den"}]},
        headers=auth(key()),
    )
    assert response.status_code == 422


async def test_a_desktop_is_shown_the_servers_speakers_and_other_desktops_never_its_own():
    session("browser", "bob")
    await claims.claim("sonos", "Den", "browser")
    mine = device_keys.resolve(key())
    claims.set_remote(shared_claims.key_source(mine.key_id), [{**DEN, "name": "Mine"}])
    claims.set_remote("key:other", [{"type": "dlna", "name": "Hall", "label": "carol on pc"}])
    assert sorted(shared_claims.snapshot_for(mine), key=lambda c: c["name"]) == [
        {"type": "sonos", "name": "Den", "label": "bob"},
        {"type": "dlna", "name": "Hall", "label": "carol on pc"},
    ]


async def test_the_stream_sends_the_claims_then_a_takeover(monkeypatch):
    monkeypatch.setattr(device_link, "_NOW_PLAYING_POLL_SECONDS", 0)
    presented = key()
    owner = device_keys.resolve(presented)
    stream = device_link._claims_events(presented, owner)
    assert await anext(stream) == "retry: 2000\n\n"
    assert json.loads((await anext(stream))[5:]) == {"claims": []}
    claims.set_remote(shared_claims.key_source(owner.key_id), [DEN])
    session("browser", "bob")
    await claims.claim("sonos", "Den", "browser", force=True)
    events = [json.loads((await anext(stream))[5:]) for _ in range(2)]
    assert {"taken": {"type": "sonos", "name": "Den"}} in events


async def test_a_desktop_taking_over_stops_the_servers_own_cast():
    holder = session("browser", "bob")
    await claims.claim("sonos", "Den", "browser")
    owner = device_keys.resolve(key())
    with patch.object(shared_claims, "displace_target", AsyncMock()) as displace:
        await shared_claims.taken_by(owner, "sonos", "Den")
    displace.assert_awaited_once_with(holder, "sonos", "Den")
    assert claims.holder_of("sonos", "Den") is None


async def test_a_desktop_taking_over_from_another_desktop_tells_that_one():
    owner = device_keys.resolve(key())
    claims.set_remote("key:other", [DEN])
    await shared_claims.taken_by(owner, "sonos", "Den")
    other = device_keys.KeyOwner("other", ALICE, None)
    assert shared_claims.take_notices(other) == [{"type": "sonos", "name": "Den"}]


async def test_a_desktop_does_not_take_its_own_speaker_from_itself():
    owner = device_keys.resolve(key())
    claims.set_remote(shared_claims.key_source(owner.key_id), [DEN])
    await shared_claims.taken_by(owner, "sonos", "Den")
    assert claims.holder_of("sonos", "Den") is not None


# ── On a desktop ─────────────────────────────────────────────────────────

LINK = {"url": "https://beacon.example", "key": "the-key"}


@pytest.fixture
def linked(monkeypatch):
    sent = []
    monkeypatch.setattr(server_link, "current", lambda: LINK)
    monkeypatch.setattr(
        server_link,
        "call",
        lambda link, method, path, body, timeout: sent.append((method, path, body)),
    )
    return sent


async def test_the_desktop_sends_its_speakers_when_they_change(linked):
    await claims.claim("sonos", "Den", "window")
    await shared_claims.push_once()
    assert linked[-1][:2] == ("PUT", "/claims")
    assert linked[-1][2]["claims"] == [{"type": "sonos", "name": "Den"}]
    await shared_claims.push_once()
    assert len(linked) == 1
    await claims.release("sonos", "Den")
    await shared_claims.push_once()
    assert linked[-1][2]["claims"] == []


async def test_unpairing_frees_the_desktops_speakers_on_the_server(linked):
    await claims.claim("sonos", "Den", "window")
    await shared_claims.push_once()
    shared_claims.withdraw()
    assert linked[-1][:2] == ("PUT", "/claims")
    assert linked[-1][2]["claims"] == []


async def test_unpairing_with_nothing_sent_sends_nothing(linked):
    shared_claims.withdraw()
    assert linked == []


async def test_the_desktop_says_so_again_before_it_would_lapse(linked, monkeypatch):
    await claims.claim("sonos", "Den", "window")
    await shared_claims.push_once()
    monkeypatch.setattr(shared_claims, "_pushed_at", -shared_claims.PUSH_EVERY_SECONDS)
    await shared_claims.push_once()
    assert len(linked) == 2


async def test_a_desktop_with_nothing_to_say_says_nothing(linked):
    await shared_claims.push_once()
    claims.set_remote(shared_claims.SERVER_SOURCE, [DEN])
    await shared_claims.push_once()
    assert linked == []


async def test_a_server_that_cannot_take_them_is_tried_again(monkeypatch):
    monkeypatch.setattr(server_link, "current", lambda: LINK)

    def refuse(*args):
        raise server_link.LinkError(server_link.UNREACHABLE)

    monkeypatch.setattr(server_link, "call", refuse)
    await claims.claim("sonos", "Den", "window")
    assert await shared_claims.push_once() is False


async def test_the_servers_speakers_show_on_the_desktop():
    await shared_claims.apply_event({"claims": [DEN, {"type": "dlna"}]})
    assert claims.holder_of("sonos", "Den") == SERVER
    assert claims.remote_claims() == [DEN]


async def test_a_takeover_on_the_server_stops_only_that_speaker_here():
    holder = session("window", "alice")
    await claims.claim("sonos", "Den", "window")
    await claims.claim("dlna", "Hall", "window")
    with patch.object(shared_claims, "displace_target", AsyncMock()) as displace:
        await shared_claims.apply_event({"taken": {"type": "sonos", "name": "Den"}})
    displace.assert_awaited_once_with(holder, "sonos", "Den")
    assert claims.holder_of("sonos", "Den") is None
    assert claims.holder_of("dlna", "Hall") == "window"


async def test_taking_over_the_servers_speaker_tells_the_server(linked):
    claims.set_remote(shared_claims.SERVER_SOURCE, [DEN])
    await claims.claim("sonos", "Den", "window", force=True)
    await asyncio.sleep(0.05)
    assert ("POST", "/claims/taken", {"type": "sonos", "name": "Den"}) in linked


async def test_the_desktop_follows_the_servers_stream(monkeypatch):
    monkeypatch.setattr(server_link, "current", lambda: LINK)
    body = b'retry: 2000\n\ndata: {"claims": [{"type": "sonos", "name": "Den", "label": "bob"}]}\n\n: keepalive\n\n'

    def answer(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/device-link/claims/events"
        assert request.headers[server_link.KEY_HEADER] == "the-key"
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(server_link, "_async_transport", httpx.MockTransport(answer))
    await shared_claims.follow_once()
    assert claims.holder_of("sonos", "Den") == SERVER


async def test_a_quiet_stream_keeps_the_servers_speakers_held(monkeypatch):
    """No change on the server sends only keepalives; they must not lapse."""
    claims.set_remote(shared_claims.SERVER_SOURCE, [DEN], now=time.time() - REMOTE_TTL_SECONDS - 1)
    monkeypatch.setattr(server_link, "current", lambda: LINK)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, content=b": keepalive\n\n", headers={"content-type": "text/event-stream"}
        )
    )
    monkeypatch.setattr(server_link, "_async_transport", transport)
    await shared_claims.follow_once()
    assert claims.holder_of("sonos", "Den") == SERVER


async def test_unpairing_ends_the_stream_from_the_server(monkeypatch):
    """The key stays valid there, so the stream would go on by itself."""
    links = iter([LINK, None])
    monkeypatch.setattr(server_link, "current", lambda: next(links, None))
    body = b'data: {"claims": [{"type": "sonos", "name": "Den", "label": "bob"}]}\n\n'
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, content=body, headers={"content-type": "text/event-stream"}
        )
    )
    monkeypatch.setattr(server_link, "_async_transport", transport)
    await shared_claims.follow_once()
    assert claims.holder_of("sonos", "Den") is None


async def test_an_older_server_is_told_apart(monkeypatch):
    monkeypatch.setattr(server_link, "current", lambda: LINK)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, text="<html>", headers={"content-type": "text/html"})
    )
    monkeypatch.setattr(server_link, "_async_transport", transport)
    with pytest.raises(server_link.LinkError) as refused:
        await shared_claims.follow_once()
    assert refused.value.state == server_link.SERVER_TOO_OLD


async def test_unpairing_forgets_the_servers_speakers(monkeypatch):
    claims.set_remote(shared_claims.SERVER_SOURCE, [DEN])
    monkeypatch.setattr(server_link, "current", lambda: None)
    await shared_claims.follow_once()
    assert claims.holder_of("sonos", "Den") is None
