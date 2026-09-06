"""core/radio_ads.py — telling a station's advertising apart from its music.

Sampled live from mangoradio (laut.fm) on 2026-09-06, in the order they
arrived:

    Years & Years - Eyes Shut
    vodafone.de - Ein bisschen Verbraucherinformationen ...
    Aronchupa, Little Sis Nora - Little Swing
    ...
    booking.com - ...  gleich geht's los mit laut.fm/mangoradio ...
    booking.com - ...  zweite Halbzeit ...
    booking.com - ...  schon fast die Hälfte geschafft ...
    booking.com - Ein bisschen Verbraucherinformationen ...

The station puts its ad breaks through the very same ICY field as its
music, and the field that carries the artist for a song carries the
*advertiser's domain* for an ad. That is the whole signal this module uses:
an artist that is a bare domain and nothing else. It is not a guess about
what the text means — it is a shape no artist name has.

Deliberately *only* that shape. Two rules that suggest themselves from the
same sample were considered and left out:

- The leading and trailing "..." on the ad copy. Stations also truncate
  genuinely long song titles with an ellipsis, so this would drop real
  songs, and it adds nothing here — every one of these lines is already
  caught by its domain.
- The tight clustering in time (four of the above landed within the same
  minute). A station playing a short jingle between two songs looks exactly
  like that, and so does a listener joining mid-break.

What this does *not* catch is an ad written as ordinary text with an
ordinary-looking artist, and there is no way to catch that without also
dropping songs. core/session.py's own _record_radio_title() has the longer
version of that argument: a station's programme name, its slogan and a news
item all arrive through this same field, and the slogan carries the exact
"Artist - Title" shape a song does. This module narrows that "keep
everything" rule by exactly one unambiguous case rather than replacing it.

An artist name is checked against real ones that also carry dots — sampled
from the same logs, "BUNT., MALOU", "D.O.D, IZZY BIZU", "G. CLUB, BANDA
SONORA, FUNKAGENDA" and "JAN BLOMQVIST, RODRIGUEZ JR." are all in there,
and none of them is domain-shaped: a space or a comma anywhere, or a final
piece that is not a plausible TLD, is enough to be a name rather than a
host.
"""

import re

# The separator ICY titles conventionally use, and the same one the
# frontend splits on (see RadioTitleLog.vue). Spaces around the dash are
# required for the same reason there: hyphenated words are not separators.
_SEPARATOR = " - "

# label(.label)*.tld — no spaces, no commas, at least one dot, and a final
# label of letters only. "booking.com" and "vodafone.de" match;
# "RODRIGUEZ JR." (space, and a final piece that is not letters after the
# dot), "D.O.D, IZZY BIZU" (comma, space) and "BUNT., MALOU" do not.
_DOMAIN = re.compile(r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}$", re.IGNORECASE)


def looks_like_advert(title: str) -> bool:
    """True for an ICY title whose artist half is a bare domain — see this
    module's own docstring for why that is the only rule, and for what it
    knowingly does not catch."""
    at = title.find(_SEPARATOR)
    if at <= 0:
        return False
    return bool(_DOMAIN.match(title[:at].strip()))
