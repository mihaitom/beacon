"""Tests for core/log_redaction.py — credentials out of log lines (#56)."""

import pytest

from core.log_redaction import redact

# Shaped like the real "[ffmpeg] Command:" line, with made-up credentials.
_FFMPEG_COMMAND = (
    "[ffmpeg] Command: ffmpeg -hide_banner -i http://10.0.0.5:4533/rest/stream.view"
    "?id=2Wsod2MUlrHnrCGZrU9SCx&u=admin&t=0123456789abcdef0123456789abcdef"
    "&s=a1b2c3d4e5f6&v=1.16.1&c=beacon&f=json -vn -acodec copy -f mp3 pipe:1"
)


def test_the_subsonic_credentials_in_an_ffmpeg_command_are_masked():
    line = redact(_FFMPEG_COMMAND)

    assert "admin" not in line
    assert "0123456789abcdef" not in line
    assert "a1b2c3d4e5f6" not in line
    assert "&u=***&t=***&s=***&" in line


def test_everything_else_in_the_line_is_left_as_it_was():
    line = redact(_FFMPEG_COMMAND)

    assert "?id=2Wsod2MUlrHnrCGZrU9SCx&" in line
    assert "&v=1.16.1&c=beacon&f=json -vn -acodec copy -f mp3 pipe:1" in line


@pytest.mark.parametrize(
    ("url", "secret"),
    [
        ("http://nav/rest/ping.view?u=me&p=enc:6869646465", "enc:6869646465"),
        ("http://nav/rest/ping.view?apiKey=k3y-v4lue&f=json", "k3y-v4lue"),
        ("http://jf/Audio/1/stream?api_key=jfsecret&ApiKey=jfsecret", "jfsecret"),
        ("http://plex/library/parts/1/file.flac?X-Plex-Token=plexsecret", "plexsecret"),
        ("http://beacon/events?token=connectsecret", "connectsecret"),
        ("http://beacon/remote/events?password=remotesecret", "remotesecret"),
        ("http://user:hunter2@nav/rest/stream.view", "hunter2"),
    ],
)
def test_each_kind_of_credential_is_masked(url, secret):
    assert secret not in redact(url)


def test_a_url_quoted_inside_a_message_ends_at_the_quote():
    line = redact("Server error '503' for url 'https://nav/rest/x?id=1&t=abc'. Retrying")

    assert "t=***'. Retrying" in line


def test_a_url_percent_encoded_inside_another_url_is_masked_too():
    line = redact("GET /proxy?url=http%3A%2F%2Fnav%2Frest%3Fu%3Dadmin%26t%3Dabc%26id%3D7 200")

    assert "admin" not in line
    assert "abc" not in line
    assert "%26id%3D7 200" in line


@pytest.mark.parametrize(
    "line",
    [
        "Study: device=7.00s wall=8.37s delta=-1.37s offset_before=-1.11s",
        "bytes 0-8975218/8975219 (unpaced)",
        "subscribed to Study's avtransport events",
    ],
)
def test_ordinary_log_lines_pass_through_unchanged(line):
    assert redact(line) == line
