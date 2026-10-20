"""core/log_redaction.py — credentials out of every log line.

Media-server URLs carry their credentials in the query string: Subsonic's
u/t/s (or p, or apiKey), Jellyfin's api_key, Plex's X-Plex-Token, and
Beacon's own ?token= / ?password= fallbacks for EventSource. Those URLs
end up in log lines - the ffmpeg command, its stderr, httpx at TRACE - and
logs get attached to public issues. A Subsonic token and salt are as good
as the password for as long as the password stays the same (#56).

main.py's formatter runs every finished line through redact(), so this
covers our own loggers, the third-party ones and tracebacks alike.
"""

import re

_MASK = "***"

_SECRET_PARAMS = (
    "u",
    "p",
    "t",
    "s",
    "apiKey",
    "api_key",
    "X-Plex-Token",
    "token",
    "password",
    "access_token",
)
_NAMES = "|".join(re.escape(name) for name in _SECRET_PARAMS)

# name=value right after ? or &. The value ends where the query string's
# next parameter, the fragment, or the surrounding text (whitespace, a
# quote, a closing bracket) begins.
_PLAIN_PARAM = re.compile(rf"(?<=[?&])({_NAMES})=[^&#\s'\"<>)\]]*", re.IGNORECASE)
# The same, percent-encoded inside another URL's query (?url=...%3Fu%3D...).
_ENCODED_PARAM = re.compile(rf"(%3F|%26)({_NAMES})%3D.*?(?=%26|[&#\s'\"<>)\]]|$)", re.IGNORECASE)
# http://user:password@host
_USERINFO = re.compile(r"(?<=://)[^/\s@:]+:[^/\s@]+@")


def redact(text: str) -> str:
    text = _PLAIN_PARAM.sub(lambda m: f"{m.group(1)}={_MASK}", text)
    text = _ENCODED_PARAM.sub(lambda m: f"{m.group(1)}{m.group(2)}%3D{_MASK}", text)
    return _USERINFO.sub(f"{_MASK}@", text)
