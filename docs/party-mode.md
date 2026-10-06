# Party mode

Guests open a link or scan a QR code and get a page of their own in the app's
look: Now Playing as the app shows it with the artwork hidden - the artist's
Fanart.tv background, the song in a card in the bottom-left corner, the
lyrics beside it (on a phone, on the back of the card, as in the mobile
app). The large cover, the lyrics and the visualizer are each a toggle the
guest's device remembers; without an artist background the large cover shows
on its own. The artist background is only darkened behind the large cover,
a guest can step through the artist's backgrounds, and the page's accent
colour follows the picture as in the app. A radio station shows with its
logo and the title it is currently playing. On a computer, what's next and the
search sit in a side panel; on a phone,
the mobile layout with a tab bar. The lyrics are the host's, with the match
and sync offset the host chose, and while the host casts, the visualizer runs
on the guests' screens too. They cannot pause, skip on their own, reorder or
remove anything, pick a speaker or change the volume. The host starts it from
the party button in the player bar, in the desktop app and in the web build
alike.

## What a guest can do

| Can                                                | Cannot                                     |
| -------------------------------------------------- | ------------------------------------------ |
| See the current song and the next 100 in the queue | Control playback, volume or speakers       |
| Search songs and albums and wish for a song        | Remove or move anything but their own wish |
| Withdraw their own wish until it starts playing    | See who other guests are beyond a name     |
| Vote to skip the current song                      | Reach anything outside `/party/`           |

Wishes go into a block right after the current song, taking turns between
guests: three wishes from Anna and then one from Ben play as Anna, Ben, Anna,
Anna. Each guest has a limit of open wishes (default 3), and a song already
wished for can't be wished for twice. A song that is coming up anyway is moved
forward to where the wish would go instead of being queued a second time, and
stays put if it comes sooner than that. A skip needs the chosen share of the
guests who have the page open (default half), rounded up: with a third and a
single guest, that guest's vote is enough. The host skips with the app's own
controls.

While a radio station plays there is no queue to wish into: what's next and
the search make way for a note saying so, and a wish that arrives anyway is
refused.

## Security model

Everything a guest touches is under `/party/`, and nothing else is: the page,
its scripts and fonts, the API and the cover art. The host's controls live
under `/party-host/` (in the web build `/api/party-host/`), protected by the
app's own token like the rest of the API. That split is what lets a reverse
proxy open `/party/` to the outside without opening anything else.

- **Invitation.** The QR code holds a link of the form
  `https://host/party/#t=<token>`. The token sits in the fragment, which
  browsers never send to a server, so it shows up in no proxy or access log.
  The page removes it from the address bar as soon as it has read it.
- **Session.** Joining exchanges the token for a session cookie: random,
  `HttpOnly`, `SameSite=Strict`, limited to `/party`, `Secure` over HTTPS, and
  expiring with the party. Every later request, the live updates included,
  carries only that cookie. The token is accepted at the join endpoint and
  nowhere else.
- **Lifetime.** A party ends after its set duration (default 12 hours), when
  the host ends it, or when the app hosting it goes away. "Renew link" issues a
  new token and signs every guest out. A single guest can be removed from the
  host's dialog. While no party runs, everything under `/party/` answers 404.
- **Fixed actions.** Guests never send a command of their own choosing. Each
  endpoint triggers exactly one action (wish, withdraw, vote), and a skip is
  only sent once the vote threshold is reached.
- **Limits.** Joining with a wrong token locks the address out after ten
  tries in ten minutes. Wishes, withdrawals, votes, searches and covers are
  rate-limited per guest, open live connections per address and in total,
  and a party holds at most 100 guests.
- **Nothing leaks.** Guests get a filtered view of the player: no session
  ids, no speakers, no volume, no stream details, and other guests appear by
  name only. Covers are served as image bytes by Beacon itself (never a
  redirect to the media server, whose cover URLs carry credentials), and only
  for artwork the guest has been shown. A radio station's logo comes the
  same way, and only for the station that is playing: guests never see its
  homepage or stream address.
- **Browser hardening.** Every answer under `/party/` carries a strict
  Content-Security-Policy (no inline script, nothing from other origins),
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and no CORS headers.
  Requests that change something are refused when their `Origin` is another
  site.
- **Names.** A guest's name is trimmed to 24 characters with control and
  text-direction characters removed, and is only ever displayed as text.

## Over the internet

Guests on the venue's Wi-Fi need nothing more than the QR code. For guests
on mobile data, put Beacon (the Docker image, `WEB_PORT` 7070 by default)
behind your reverse proxy. Whichever proxy it is:

- **`/party` and `/party/` have to get past the login in front of Beacon.**
  If Beacon sits behind Authentik or another forward-auth, give that path a
  route of its own without it - the examples below do exactly that. Without a
  forward-auth, an ordinary proxy host is enough and nothing else changes:
  `/party/` is the only part a guest can use without Beacon's own login.
- **The `Host` header goes through unchanged.** Changing requests are
  checked against it (see "Browser hardening" above). All three proxies
  below do that by default.
- **No response buffering.** The page's live updates are a long-running
  event stream. Beacon sends `X-Accel-Buffering: no`, which nginx (Nginx
  Proxy Manager too) honours, and Caddy and Traefik pass such a stream
  through as it comes.
- **Start the party with Beacon open under the public address**
  (`https://beacon.example.com`), not under its LAN address: the QR code
  points at the address the party was started from.

Then set `TRUSTED_PROXIES` as described under
[Client addresses](#client-addresses).

### Traefik + Authentik

Give `/party` its own router without the Authentik middleware and a higher
priority than the protected one:

```yaml
labels:
  # The protected app, as before
  - traefik.http.routers.beacon.rule=Host(`beacon.example.com`)
  - traefik.http.routers.beacon.middlewares=authentik@docker
  # Party guests, past Authentik
  - traefik.http.routers.beacon-party.rule=Host(`beacon.example.com`) && (Path(`/party`) || PathPrefix(`/party/`))
  - traefik.http.routers.beacon-party.priority=100
  - traefik.http.routers.beacon-party.service=beacon
```

Use `PathPrefix(`/party/`)` with the trailing slash. Without it, Traefik also
matches any other path that happens to start with `/party`.

### Nginx Proxy Manager + Authentik

The proxy host points at Beacon as usual (Details tab: `http`, Beacon's
address, port `7070`). Authentik's own guide for Nginx Proxy Manager puts a
`location /` block with `auth_request` into the Advanced tab. Add these two
locations next to it, in the same Advanced tab - they are matched ahead of
`/` and carry no `auth_request`:

```nginx
# Party guests, past Authentik
location = /party {
    proxy_pass $forward_scheme://$server:$port;
    proxy_set_header Host $host;
}

location /party/ {
    proxy_pass $forward_scheme://$server:$port;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`$forward_scheme`, `$server` and `$port` are what the Details tab says, so
the address only lives in one place. Locations added in the Advanced tab
don't get the headers Nginx Proxy Manager adds on its own, which is why
they are set here.

Without Authentik, none of this is needed: an ordinary proxy host with an SSL
certificate is all.

### Caddy + Authentik

A named matcher for the party path, handled before the protected rest:

```caddy
beacon.example.com {
	@party path /party /party/*

	# Party guests, past Authentik
	handle @party {
		reverse_proxy 192.168.1.10:7070
	}

	# Everything else, as in Authentik's guide for Caddy
	handle {
		route {
			reverse_proxy /outpost.goauthentik.io/* http://authentik-server:9000
			forward_auth http://authentik-server:9000 {
				uri /outpost.goauthentik.io/auth/caddy
				copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid
				trusted_proxies private_ranges
			}
			reverse_proxy 192.168.1.10:7070
		}
	}
}
```

`path /party /party/*` rather than `/party*`, which would also match any
other path starting with `/party`. Caddy keeps the `Host` header and sets
`X-Forwarded-For` and `X-Forwarded-Proto` on its own. Without Authentik,
`reverse_proxy 192.168.1.10:7070` alone is the whole site block.

### Client addresses

The rate limits work per client address. Beacon only trusts an
`X-Forwarded-For` header from a proxy listed in `TRUSTED_PROXIES`
(comma-separated addresses or networks, default `127.0.0.1/32,::1/128`, which
is the nginx inside the container). Add the address your proxy reaches Beacon
from, or every guest counts as the proxy and they all share one set of
limits:

| Proxy                                                         | Add, for example                       |
| ------------------------------------------------------------- | -------------------------------------- |
| In a Docker network on the same host (Traefik, NPM, Caddy)    | `172.16.0.0/12`, Docker's networks     |
| On another machine                                            | That machine's address, `192.168.1.5`  |
| On the same host, outside Docker or with `network_mode: host` | Nothing, `127.0.0.1` is already listed |

For example `TRUSTED_PROXIES=127.0.0.1/32,::1/128,172.16.0.0/12`. The
same list decides whether `X-Forwarded-Proto: https` is believed when the
cookie is marked `Secure`.

## How the page is built

The guest page is a Vue app of its own (`src/renderer/src/party/`), built
with `pnpm build:party` into `connect/static/party/`, which connect serves.
`pnpm dev` keeps it built while you work, `pnpm package:connect` and the
Docker image build it themselves. It reuses the app's theme, translations
and the parts of Now Playing that know no store (backdrop, lyrics lines,
visualizer bars), so it looks the same without carrying the app's playback
code along.

Vuetify writes its theme into a `<style>` element at runtime. Instead of
allowing inline styles, connect puts a fresh nonce into every page it serves
and allows only the style element carrying it.

The visualizer only runs while casting: connect analyses what the speakers
play then. During local playback the analyser lives in the host's browser,
and guests see no bars.

## Things to know

- The party runs in the window that started it. In the web build, another
  browser tab can take it over from the party dialog, and only one tab answers
  guests at a time: the one that gave it up lets go within about ten seconds.
  When that window goes quiet - closed, or asleep - the party ends after about
  a minute and a half, unless the host is casting. Then the Beacon server
  keeps the party going and shows guests what plays while that window sleeps
  (a locked phone) or, in the web build, after the tab is closed. Searching
  works then too, answered by the music server itself; wishing and skipping
  still need the window for now, and while it sleeps guests are told Beacon
  isn't answering. Quitting the desktop app stops its Beacon server, and the
  party with it. See `docs/plans/party-mode-server-side.md`.
- Taking a party over, or reloading the window that hosts it, keeps the link:
  the window gets it back from the Beacon server, and guests already there
  stay in. Only "Renew link" makes a new one and signs everyone out.
- A wish is an ordinary queue entry. The host can move or remove it like any
  other, and that is what the guests then see.
