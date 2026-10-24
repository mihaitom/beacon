---
order: 7
---

# Reporting a problem

## Which log level do I need?

Set the log level in Settings > Advanced, or with `LOG_LEVEL` (see the environment variables in the README) if the app never comes up far enough to reach Settings:

- **Debug** covers Beacon's own code. Enough for most problems, and it also turns on the cast panel below.
- **Trace** also turns on the SoCo/pyatv/HTTP libraries actually talking to the device, which is normally what you need for a casting issue. Expect a lot of output.

The setting takes effect immediately and survives a restart, so remember to put it back afterwards.

## What does the panel in Now Playing show while casting?

With the log level at Debug, Now Playing shows a small panel while casting: what was sent and how far into the song it reaches, whether the speaker is still reading (`STALLED` once it has stopped), how many seconds it has ahead, and what it asked for. The `?` on the panel explains each line. Copying it needs the page to be served over HTTPS; on plain HTTP, select the text and copy it by hand.

## What should a report contain?

- What you did, what you expected and what happened instead, with the time it happened.
- The log around that time, at Debug or Trace.
- For a casting problem: the kind and model of speaker, and the panel's reading from the moment it went wrong.
- For a network problem: whether Beacon and the speaker are in the same network, and whether the server has more than one network connection. [Networking](../guides/networking.md#when-a-speaker-stops-or-starts-over) has a checklist worth going through first.

Logs can be shared as they are: the media server login, tokens and API keys in addresses are masked.
