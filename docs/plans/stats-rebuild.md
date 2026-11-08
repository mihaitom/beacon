# Plan: Stats page rebuild and listening log

Status: built 2026-11-08. The look was agreed on a throwaway mockup. Kept for
the reasoning behind it; the code is the reference for details.

## What it is for

The Stats page is a stack of equal tiles. It should be something people enjoy
opening. It becomes four parts, in this order:

1. **Hero:** a record that fills up with the listener's plays, and under the figures a recessed display with the visualizer, which makes the card read as a deck
2. **Your charts:** top songs, artists, albums, genres
3. **Your listening year:** streak, a year of days, hours of the day
4. **Your collection:** what the library is made of

Achievements (a wall of award records, "almost there"), levels and ranks were
mocked up and dropped as too much. What stayed is the moment when a figure is
passed: see "Milestones".

The media servers only report a total per song (`playCount`, `lastPlayed`), so
part 3 and everything that needs a date requires a log of our own.

## The listening log

### Who writes it

`checkScrobbleThreshold()` in `stores/playback.ts` is the one place that
decides a play counts, and it already excludes radio and previews. It posts
to connect next to the existing `scrobble()` call, not after it: a media server
that refuses a scrobble should not cost the log an entry. This makes the log
the same on Navidrome, Jellyfin and Plex, with no bridge involved.

Only plays through Beacon are logged. Connect stamps the time on arrival, so a
wrong client clock cannot damage the log.

Several Beacon windows can follow one cast. Connect ignores the same song for
the same account within 60 seconds, so that cannot count twice.

### Whose log it is

Every route uses `require_authenticated_session` and takes the account from
the session (`account_server_type`, `account_server_url`, `account_username`),
which `/config` verified against the media server. It must **not** take an
identity from the request the way `routes/account_settings.py` does: those
routes are only gated by the instance-wide `CONNECT_TOKEN`, which is fine for
a language setting and not for a dated record of what somebody listened to.

A session with no verified username (possible on Plex) writes nothing and the
page leaves out the parts that need the log.

### Storage

One SQLite file, `CONNECT_DATA_DIR/play-history/play-history.db`. "log" and
"track" are on ad-blocker lists, which is why neither is in the path.

- `listens`: one row per play, Beacon's own and imported ones told apart by
  `source`. `id` (random, so it stays meaningful on another machine), `ts` (UTC
  seconds), `title`, `artist`, `album`, `song_id`, `artist_id`, `album_id`,
  `cover_art_id`, `genre`, `duration`
- `accounts`: the account's identity, the import state and the milestones seen

Kept indefinitely. Handlers are sync `def`, as in `routes/account_settings.py`,
since they do blocking IO. A first start takes in the plain files an earlier
build wrote per account, and leaves them where they are. Syncing between
installations is planned in `docs/plans/play-history-sync.md`.

### What the frontend gets

`GET /play-history/summary` returns:

- `timestamps`: every listen, UTC. The browser groups these into days and
  hours, because only it knows the listener's time zone
- `top`: songs, artists, albums and genres counted from the log, grouped by id
  or else by normalised artist and title
- `recent_plays`: `song_id` to plays in the last 30 days, Beacon entries only
- `live_since`, `total`

The calculations on `timestamps` go in a tested service under
`services/library/`, not in the view.

## The initial import

Reads the last 371 days (the 53 weeks the listening year shows) from a public
profile, once per account. Runs in connect as a background task, and the page
shows its progress inside the listening year section.

| Names set up for this account | What happens                                 |
| ----------------------------- | -------------------------------------------- |
| One of the two                | Starts by itself on the first visit          |
| Both                          | Waits for a button, which picks the source   |
| None                          | No import, the log starts with the next play |

Last.fm only counts as set up when the installation has its application key
(`stores/lastfm.ts`, `configured`). A name added later triggers the same rule,
as long as no import has finished for the account.

Rules that stop plays from counting twice:

- **Only listens older than the first Beacon entry** (or than now, if there is
  none yet). Whether the media server also forwards to one of these services
  then no longer matters
- **Never both sources.** The same plays would be counted twice

Source details:

- **Last.fm** `user.getRecentTracks`: api key and user, no login, 200 per page,
  `from`/`to` in UTC seconds. Skip the entry marked `nowplaying`. No rate limit
  is published beyond error 29, so it is paced like ListenBrainz
- **ListenBrainz** `/1/user/{name}/listens`: 1000 per request, newest first,
  page with `max_ts` (exclusive). One call per second, already what
  `core/listenbrainz.py` throttles to. Its docs ask not to page through a
  whole history with this endpoint and to use it for bounded queries, which a
  year is

A finished import can be fetched again from a quiet button under the year, from
either profile; the old year stays until the new one has arrived whole.

A failed import can run again, by button only: a private profile would
otherwise be asked on every visit. Nothing is written until the last page has
arrived.

Checked against live accounts: ListenBrainz's listens endpoint needs no token,
and a Last.fm import ran through. Not checked: what a private profile answers
on either service.

## Admins looking at other accounts

A server admin (`session.account_is_admin`) gets a picker on the page with
every account on this server, from `cast_permissions.known_accounts()`. That
list already exists because no server type can be enumerated uniformly. Other
servers on the same Beacon are never offered. The check is in connect; the
picker is only the visible half. On the desktop app there is one account, so
no picker appears.

The servers answer `playCount` for whoever is signed in, so **another
account's view can only come from the log**:

| Part           | Own view                     | Another account's view                        |
| -------------- | ---------------------------- | --------------------------------------------- |
| Hero           | Listening time, all-time     | Their name, plays in the log, since when      |
| Charts         | All-time from `playCount`    | From the log, says "since <date>"             |
| Listening year | Log                          | Log                                           |
| Collection     | Library, favourites, ratings | Library only, favourites and ratings left out |
| Import         | Own account                  | Never started on someone else's behalf        |

An account that has signed in but played nothing shows the empty state.

Listening times being visible to an admin has to be stated where the user can
read it: the privacy sheet (`PrivacyDialog.vue`) and
`docs/help/faq/privacy.md`, along with the import.

## The page

Rebuild of `views/StatsView.vue` in Options API, using `docs/styleguide.md`.
It already serves the phone shell, so it has to work from 320px up with no
separate mobile view.

- **Hero:** the blurred backdrop of the most played album (300px cover, as
  everywhere), in the theme's night. 50 grooves, outermost first; one groove is
  a number of plays that grows with the listener (10 up to 500), grooves
  already filled are quiet, the current one is an amber arc ending at the
  progress. Celebrated plays milestones stay on their groove as a ring of
  silver, gold or foil. Pointing anywhere on the record names the nearest
  groove. The arm lifts on pause, the record only turns while music plays, and
  the label shows what is on
- **Charts:** tabs, a large number one with its cover, then the next seven with
  bars. Up/down arrows compare the all-time rank now with the rank without
  `recent_plays`, and appear once the log has 30 days of Beacon's own entries.
  Imported entries carry no song id and are left out of the arrows
- **Listening year:** streak and record, 53 weeks of days in one amber ramp
  (fewer weeks on a phone), plays by hour. Tooltips on every cell
- **Collection:** the existing composition figures, decades as bars in time
  order, quality as one ordered bar

The opening is one moment and then still: tonearm, grooves, numbers counting
up. Answers `prefers-reduced-motion`. No sound.

All text in the five locales. Colours from theme tokens; the record and the
milestone disc are objects and keep their own (`docs/styleguide.md`).

## Milestones

A figure being passed is one moment on opening the page, own view only: hours
and streaks climb a ladder that spreads out (100 hours up to
10,000, then every 5,000; 7 days up to 1,000, then every 500), bronze to diamond
by height. Several passed since the last visit are one moment, the biggest. The
first visit only sets the baseline,
and so does the visit after an import: a streak arriving with a year of old
plays is nothing to celebrate. What has been seen is stored per account in
connect and only ever goes up, so a second device does not repeat it.

Only records are records: an hours milestone is a tape reel and a streak a
cassette, in the same metals, and each lands on its own figure in the hero
instead of on the record. Nothing about them is collected.

The record gets one more. A record holds 50 grooves and runs to the last one,
and every new record starts again at the first groove. They are ranked as sales
certifications are, and the counts are picked so each is full on a round total:

| Tier     | Records | A groove | Full at (plays in all)    |
| -------- | ------- | -------- | ------------------------- |
| Bronze   | 4       | 10       | 500, 1,000, 1,500, 2,000  |
| Silver   | 3       | 20       | 3,000, 4,000, 5,000       |
| Gold     | 2       | 50       | 7,500, 10,000             |
| Platinum | 3       | 100      | 15,000, 20,000, 25,000    |
| Diamond  | endless | 500      | 50,000, then every 25,000 |

A full record is a "new pressing" and flies onto the shelf under the display (under the record on a phone),
ahead of any other moment since it always lands on a round number of plays.

The shelf is one pile per tier, so it can never get wider than five piles. A
pile shows its newest five with a count above that, and fans out on hover or
tap, each record with its own tooltip.

The shelf needs no storage of its own: which records are full follows from the
plays, and the date comes from counting back through the log, so it is unknown
for a record older than the log. The tooltip says so.

The comparison waits for the whole library: counted on the first pages, the
baseline would be too low and the next visit would celebrate nothing.

The sentence under the headline is one a day out of what the listener's own
numbers can say (`services/library/statsLines.ts`). It started as a flight
comparison, which read the same on every visit and meant nothing at 140 flights.
A line only joins in when its figure is worth saying, and nothing comes from an
outside service.

## Tests

- **Backend, thorough:** only the session's account is written and read; an
  admin can read another account on the same server and a non-admin cannot,
  nor an admin on another server; the 60-second rule; appending under
  concurrency; a corrupt line is skipped; import paging for both sources,
  `nowplaying`, the cut-off, no double run, resuming after failure; the source
  rule for one, two and no names
- **Frontend logic:** days and hours across a time zone and a daylight saving
  change, streaks, milestones, the record's progress, chart arrows, the import
  rule, the other account's view
- **Component behaviour:** the import button, the picker only for admins, the
  empty state
- **Browser layer:** only what jsdom cannot answer: nothing runs off the side
  at phone width, the whole record fits, fewer weeks on a phone

## Decided against

- **Automatic import with both names set:** which history is right is the
  listener's call
- **Importing the whole history:** a year is what the page shows
- **Merging both services, or a recurring sync:** double counting, for plays
  mostly made elsewhere
- **Taking the account from the request:** see "Whose log it is"
