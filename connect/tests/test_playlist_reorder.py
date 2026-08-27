"""Tests for media/base.py's playlist-reordering helpers — the part of
"replace a playlist's songs with exactly this list" that's identical for
the Jellyfin and Plex bridges (neither server has such a call; both can
move one entry at a time)."""

from itertools import permutations

from media.base import match_entries_to_song_ids, reorder_moves


def apply_moves(current: list[str], moves: list[tuple[str, int, str | None]]) -> list[str]:
    """What the playlist looks like after a server has carried out `moves`
    — each one takes the entry out of where it is and re-inserts it at the
    given index, which is what both servers' move calls do."""
    result = list(current)
    for entry_id, index, _after in moves:
        result.remove(entry_id)
        result.insert(index, entry_id)
    return result


def apply_moves_by_anchor(
    current: list[str], moves: list[tuple[str, int, str | None]]
) -> list[str]:
    """The same moves as Plex carries them out — placing each entry after
    the one named rather than at an index. The two must agree, or a
    reorder would come out right on one backend and wrong on the other."""
    result = list(current)
    for entry_id, _index, after in moves:
        result.remove(entry_id)
        result.insert(0 if after is None else result.index(after) + 1, entry_id)
    return result


def test_already_in_order_moves_nothing():
    assert reorder_moves(["a", "b", "c"], ["a", "b", "c"]) == []


def test_one_song_dragged_down_is_a_single_move():
    # The common case, and the reason for walking left to right rather than
    # rewriting every position: dragging one row must not cost one request
    # per song in the playlist.
    moves = reorder_moves(["a", "b", "c", "d"], ["b", "c", "a", "d"])

    assert len(moves) == 1
    assert apply_moves(["a", "b", "c", "d"], moves) == ["b", "c", "a", "d"]


def test_one_song_dragged_up_is_a_single_move():
    moves = reorder_moves(["a", "b", "c", "d"], ["d", "a", "b", "c"])

    # To the very front, which Plex expresses as "after nothing".
    assert moves == [("d", 0, None)]


def test_a_full_reversal_still_lands_exactly():
    current = ["a", "b", "c", "d", "e"]
    target = ["e", "d", "c", "b", "a"]

    assert apply_moves(current, reorder_moves(current, target)) == target


def test_every_permutation_lands_exactly_both_ways():
    # Brute force over every order of five entries, checked against both
    # move semantics — the index one (Jellyfin) and the anchor one (Plex).
    current = ["a", "b", "c", "d", "e"]
    for target in permutations(current):
        wanted = list(target)
        moves = reorder_moves(current, wanted)
        assert apply_moves(current, moves) == wanted
        assert apply_moves_by_anchor(current, moves) == wanted


def test_no_permutation_needs_more_moves_than_entries_out_of_place():
    # The cost that matters is requests to the media server, and the
    # entries already in the right relative order must not generate any.
    current = ["a", "b", "c", "d", "e"]
    for target in permutations(current):
        moves = reorder_moves(current, list(target))
        assert len(moves) <= len(current) - 1


def test_matching_claims_one_entry_per_wanted_song():
    entries = ["s1", "s2", "s3"]

    assert match_entries_to_song_ids(entries, ["s3", "s1", "s2"]) == [2, 0, 1]


def test_a_song_present_twice_keeps_its_two_entries_apart():
    # Both entries share a song id but are separate playlist entries with
    # separate per-entry ids — claiming the same one twice would move one
    # entry to two places and silently drop the other.
    entries = ["s1", "s2", "s1"]

    matched = match_entries_to_song_ids(entries, ["s2", "s1", "s1"])

    assert matched == [1, 0, 2]
    assert len(set(matched)) == 3


def test_a_song_with_no_entry_left_reports_none():
    # That's the bridge's signal to add it before reordering.
    assert match_entries_to_song_ids(["s1"], ["s1", "s2"]) == [0, None]
    assert match_entries_to_song_ids(["s1"], ["s1", "s1"]) == [0, None]
