"""ReplayGain for the songs connect moves on to by itself.

The app works out the gain for the song it starts (/play's `gain`). The
songs after it are started by connect - auto-advance, a party skip, a jump
from an app with no window open - and those need their own, worked out the
same way as the app's services/replayGain.ts does it.
"""

from typing import Literal

from media.base import ReplayGain, Track

ReplayGainMode = Literal["off", "song", "album"]


def multiplier(replay_gain: ReplayGain | None, mode: str) -> float:
    """Linear amplitude multiplier (1 = no change) for a song under `mode`.
    Falls back to the other of song/album gain when the preferred one is
    missing, and is held below the song's peak so it can't be pushed into
    clipping - both exactly as services/replayGain.ts does it."""
    if mode not in ("song", "album") or replay_gain is None:
        return 1.0
    rg = replay_gain
    if mode == "song":
        gain = rg.track_gain if rg.track_gain is not None else rg.album_gain
        peak = rg.track_peak if rg.track_peak is not None else rg.album_peak
    else:
        gain = rg.album_gain if rg.album_gain is not None else rg.track_gain
        peak = rg.album_peak if rg.album_peak is not None else rg.track_peak
    if gain is None:
        return 1.0
    try:
        factor = 10 ** (gain / 20)
    except OverflowError:
        return 1.0
    return min(factor, 1 / peak) if peak else factor


def gain_for(state, track: Track) -> float:
    """The gain for `track` in this session: the app's own number when it
    sent one for this song (see routes/mix_cast.py's SongHint), otherwise
    worked out from the song's ReplayGain under the session's mode."""
    hint = state.song_hints.get(track.id)
    if hint and "gain" in hint:
        return hint["gain"]
    return multiplier(track.replay_gain, state.replay_gain_mode)
