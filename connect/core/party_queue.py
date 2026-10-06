"""Guests' wishes while the host casts: kept by connect and applied to the
cast session's own queue, so they work while the host's window sleeps (see
docs/plans/party-mode-server-side.md, step 4). Without a cast the host's
window keeps them, in src/renderer/src/stores/party.ts - the rules here are
that file's, and have to stay the same.

A request is tied to a position in session.state.queue. connect keeps the
positions current through its own inserts and removals; a queue the host's
window replaces (a reorder, a removal, a song added) is matched back up in
sync_requests().
"""

import time
from dataclasses import dataclass, field

from .session import STATUS_EXTRAS, build_status_dict


class Refusal(Exception):
    """A wish or withdrawal refused on purpose, with the code
    routes/party.py's _REFUSALS turns into a status for the guest -
    the same codes stores/party.ts's PartyRefusal carries."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class CastRequest:
    id: str
    song_id: str
    guest_id: str
    guest_name: str
    position: int
    requested_at: float = field(default_factory=time.time)


def wish_insert_index(pending: list[CastRequest], guest_id: str, current_index: int) -> int:
    """Where a guest's next wish goes: after every guest's wish of the same
    round or earlier, so wishes take turns - stores/party.ts's
    wishInsertIndex(), line for line."""
    seen: dict[str, int] = {}
    my_round = sum(1 for r in pending if r.guest_id == guest_id)
    after = current_index
    for request in sorted(pending, key=lambda r: r.position):
        round_ = seen.get(request.guest_id, 0)
        seen[request.guest_id] = round_ + 1
        if round_ <= my_round:
            after = request.position
    return after + 1


def sync_requests(party, st) -> None:
    """Brings the requests' positions up to date with a queue someone else
    changed, and lets go of the ones that have been played. A request
    follows its song to the nearest place it still holds; one whose song is
    gone was removed by the host."""
    if party.cast_queue_seen != st.queue:
        taken: set[int] = set()
        kept = []
        for request in sorted(party.cast_requests, key=lambda r: r.position):
            places = [
                p
                for p, song_id in enumerate(st.queue)
                if song_id == request.song_id and p not in taken
            ]
            if not places:
                continue
            request.position = min(places, key=lambda p: abs(p - request.position))
            taken.add(request.position)
            kept.append(request)
        party.cast_requests = kept
        party.cast_queue_seen = list(st.queue)
    party.cast_requests = [r for r in party.cast_requests if r.position >= st.queue_index]


def _queued(party, st) -> None:
    """After an edit of connect's own: the queue as it now stands is the
    one the positions describe, and a window holding an older one must not
    write it back over the wish. play_seq is what /queue checks for that
    (routes/playback.py's _is_stale_seq), on the same millisecond clock the
    app's own seq uses."""
    party.cast_queue_seen = list(st.queue)


def _supersede_older_queues(session) -> None:
    session.play_seq = max(session.play_seq, int(time.time() * 1000))


def _insert(st, index: int, song_id: str) -> None:
    """stores/playback.ts's insertAt() for one song: into the queue, and
    into the unshuffled order right after the song it follows there."""
    before = st.queue[index - 1] if index > 0 else None
    st.queue.insert(index, song_id)
    if not st.original_queue:
        return
    if before is not None and before in st.original_queue:
        st.original_queue.insert(st.original_queue.index(before) + 1, song_id)
    else:
        st.original_queue.append(song_id)


async def wish(party, session, song_id: str, guest_id: str, guest_name: str, request_id: str):
    async with session.play_lock:
        st = session.state
        party.own_cast_requests(session)
        sync_requests(party, st)
        pending = [r for r in party.cast_requests if r.position > st.queue_index]
        if (
            sum(1 for r in pending if r.guest_id == guest_id)
            >= party.settings.max_pending_per_guest
        ):
            raise Refusal("limit")
        if any(r.song_id == song_id for r in pending):
            raise Refusal("duplicate")

        index = min(wish_insert_index(pending, guest_id, st.queue_index), len(st.queue))
        # A song coming up anyway moves forward to where the wish goes, and
        # stays where it is if it comes sooner than that - never queued
        # twice (stores/party.ts's wishEntry()).
        queued = next(
            (p for p in range(st.queue_index + 1, len(st.queue)) if st.queue[p] == song_id),
            None,
        )
        if queued is None:
            _insert(st, index, song_id)
            for request in party.cast_requests:
                if request.position >= index:
                    request.position += 1
            position = index
        elif queued > index:
            st.queue.insert(index, st.queue.pop(queued))
            for request in party.cast_requests:
                if index <= request.position < queued:
                    request.position += 1
            position = index
        else:
            position = queued

        party.cast_requests.append(
            CastRequest(
                id=request_id,
                song_id=song_id,
                guest_id=guest_id,
                guest_name=guest_name,
                position=position,
            )
        )
        _queued(party, st)
        _supersede_older_queues(session)
        await session.event_bus.broadcast(build_status_dict(session))


async def withdraw(party, session, request_id: str, guest_id: str) -> None:
    async with session.play_lock:
        st = session.state
        party.own_cast_requests(session)
        sync_requests(party, st)
        request = next((r for r in party.cast_requests if r.id == request_id), None)
        if request is None or request.position <= st.queue_index:
            raise Refusal("not-found")
        if request.guest_id != guest_id:
            raise Refusal("forbidden")
        position = request.position
        removed = st.queue.pop(position)
        if removed in st.original_queue:
            st.original_queue.remove(removed)
        party.cast_requests.remove(request)
        for other in party.cast_requests:
            if other.position > position:
                other.position -= 1
        _queued(party, st)
        _supersede_older_queues(session)
        await session.event_bus.broadcast(build_status_dict(session))


def adopt_from_window(party, raw: dict) -> None:
    """The cast has just begun: the wishes the host's window took during
    local playback become connect's, at the positions it named them at
    (its queue is the cast's, see the caller)."""
    party.cast_requests = [
        CastRequest(
            id=str(request.get("id")),
            song_id=str((raw.get("queue") or [])[int(position)].get("id")),
            guest_id=str(request.get("guest_id")),
            guest_name=str(request.get("guest_name")),
            position=int(position),
        )
        for position, request in (raw.get("party_requests") or {}).items()
        if str(position).isdigit() and int(position) < len(raw.get("queue") or [])
    ]


def requests_by_position(party) -> dict[str, dict]:
    """The requests in the shape the window's snapshot names them in
    (party_requests), for PartyState.rebuild()."""
    return {
        str(r.position): {"id": r.id, "guest_id": r.guest_id, "guest_name": r.guest_name}
        for r in party.cast_requests
    }


def requests_for_window(party) -> list[dict]:
    """What the host's window shows of them in its own queue, and takes
    back once the cast ends (see stores/party.ts's castRequests)."""
    return [
        {
            "id": r.id,
            "position": r.position,
            "guest_id": r.guest_id,
            "guest_name": r.guest_name,
            "requested_at": r.requested_at,
        }
        for r in sorted(party.cast_requests, key=lambda r: r.position)
    ]


def _status_extra(session) -> dict:
    """The wishes in the host's cast session status, so the window shows
    them in its queue and takes them back when the cast ends."""
    from .party import party

    if not party.enabled or party.host_cast() is not session or not party.cast_owned:
        return {}
    return {"party_requests": requests_for_window(party)}


STATUS_EXTRAS.append(_status_extra)
