# Radio stations are global instead of per account - without losing anyone's list

**Status:** open, the migration decided 2026-09-10. Found the same day while
looking into why the station list looks the same after switching servers.

`core/radio_stations.py` keeps one flat list in a single
`radio_stations.json`; `list_stations()`/`create()`/`update()`/`delete()`
take no account at all. In `media/base.py` the parameter of
`get_internet_radio_stations(_params, _media)` is tellingly called `_media`
and never read - **so Jellyfin and Plex share one pot**, and every login on a
connect instance sees the same stations and deletes them for the others.
Navidrome/Subsonic is not affected: there the stations come from the media
server itself (passed through in `routes/proxy.py`), and this list is never
read for a Subsonic session.

What it should look like is right next to it: `core/account_settings.py`
keys its entries by `_account_key(server_type, server_url, username)` in
_one_ JSON object, with the frontend counterpart in `services/accountKey.ts`.
The same pattern fits here.

## The migration - the real reason for this entry

Adding the key and rewriting the file leaves every existing user with an
empty station list; the stations were entered by hand and are stored nowhere
else. Worse, at the time of the migration connect knows no account at all -
the file carries no origin, and accounts only appear when someone signs in.

**Decided (2026-09-10): the existing list stays as a template, and every
account branches off its own copy on first access.** An account without a
list of its own gets a copy of the original; from then on it works only on
its own. Nobody loses anything, the single-user case (the usual one) notices
nothing, and on a multi-user instance everyone starts with what all of them
see today and drifts apart from there. Rejected: "take it over exactly once
and delete the old list" - whoever signs in first wins, and everyone else is
left empty.

Two traps that make the difference between "works" and "deletes people's
stations":

- **"No list of its own yet" is not the same as "the list is empty".**
  Someone who deliberately threw all their stations away would otherwise get
  the whole old list back on the next login - every time. It needs an
  explicit "already branched for this account" marker (an entry with an
  empty list will do, as long as "key missing" and "key there, list empty"
  are told apart), not a length check.
- **Copy on first access, not on the login request.** Otherwise the
  migration hangs on exactly one code path (`/config` in `routes/devices.py`)
  and misses a session that is restored rather than signed in anew.
  Branching inside `radio_stations.list_stations(account_key)` itself covers
  every path.

The old list stays for good afterwards: it is the template for every account
that comes along later. That is deliberate, not forgotten clutter.

## Also to change

The root `README.md` says "_your_ internet radio stations", and lists them
among things that really are per account (language, lyrics provider,
recommendation cache) - it reads as "per account" and is not. Affects the
list under "Mount a volume at `/data`" and the `CONNECT_DATA_DIR` row in the
env table.

Not to be confused with it: the per-station title history goes through
`radio_history.append(self.session_id, ...)`, i.e. the session - a different
axis from the station list, untouched by this.
