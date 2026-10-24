---
order: 3
---

# Party mode over the internet

Guests on the same Wi-Fi as Beacon need nothing more than the QR code. For
anyone else - guests on mobile data, and **every guest of an online party**,
who by definition are not on your network - Beacon has to be reachable from
the internet, which means putting the Docker image (`WEB_PORT` 7070 by
default) behind a reverse proxy with a public hostname and a certificate.
Without that, an online party has nobody who can join it. Whichever proxy it
is:

- **`/party` and `/party/` have to get past the login in front of Beacon.**
  If Beacon sits behind Authentik, Authelia or another forward-auth, that
  path has to be let through without it - the setups below show how for
  each. Without a forward-auth, an ordinary proxy host is enough and nothing
  else changes: `/party/` is the only part a guest can use without Beacon's
  own login. The online party's stream is part of it (`/party/api/listen`),
  so nothing else needs opening for it.
- **The `Host` header goes through unchanged.** Changing requests are
  checked against it (see "Browser hardening" under [Security model](#security-model)). All the proxies below
  do that by default.
- **No response buffering.** The page's live updates and the online party's
  audio are long-running streams. Beacon sends `X-Accel-Buffering: no`,
  which nginx (Nginx Proxy Manager too) honours, and Caddy and Traefik pass
  such a stream through as it comes.
- **Start the party with Beacon open under the public address**
  (`https://beacon.example.com`), not under its LAN address: the QR code and
  the link point at the address the party was started from.

Then set `TRUSTED_PROXIES` as described under
[Client addresses](#client-addresses).

## Testing the setup

With an online party running, the party dialog has a "Test setup" button.
The Beacon server then opens the party's own link the way a guest would -
proxy, certificate, the login in front, the route to `/party/` - and says
what it found at each step, down to a proxy missing from `TRUSTED_PROXIES`.
It looks the name up twice: on the server, and in public DNS, by asking
Cloudflare's resolver (1.1.1.1) - the only thing it sends there is the name.
That catches the most common reason guests on mobile data get nowhere: a
name only your own DNS knows, which works at home and nowhere else. Where
public DNS has a different address than your own DNS (split DNS, or
Cloudflare's proxy in front), the test also reaches the party through that
address, which is the way guests come in. One thing it cannot tell from
inside: a router that does not let devices at home reach its own public
address makes a working setup look unreachable, and the test says when that
could be the case. The final word is the link on a phone with Wi-Fi switched
off.

## Example setups

Each one opens `/party` to guests and leaves the rest of Beacon behind your
login. Without a login in front of Beacon, any of them shortened to the
plain proxy host does the job.

<!-- tabs -->

### Traefik (Docker labels)

Give `/party` its own router without the forward-auth middleware and a
higher priority than the protected one:

```yaml
labels:
  # The protected app, as before
  - traefik.http.routers.beacon.rule=Host(`beacon.example.com`)
  - traefik.http.routers.beacon.middlewares=authentik@docker
  # Party guests, past the login
  - traefik.http.routers.beacon-party.rule=Host(`beacon.example.com`) && (Path(`/party`) || PathPrefix(`/party/`))
  - traefik.http.routers.beacon-party.priority=100
  - traefik.http.routers.beacon-party.service=beacon
```

With Authelia the middleware is `authelia@docker` instead, the rest is the
same. Use `PathPrefix(`/party/`)` with the trailing slash. Without it,
Traefik also matches any other path that happens to start with `/party`.

### Traefik (file provider)

The same two routers in Traefik's dynamic configuration, for a Traefik that
reads its routes from a file rather than from container labels:

```yaml
http:
  routers:
    # The protected app, as before
    beacon:
      rule: Host(`beacon.example.com`)
      entryPoints: [websecure]
      middlewares: [authentik]
      service: beacon
      tls:
        certResolver: letsencrypt
    # Party guests, past the login
    beacon-party:
      rule: Host(`beacon.example.com`) && (Path(`/party`) || PathPrefix(`/party/`))
      entryPoints: [websecure]
      priority: 100
      service: beacon
      tls:
        certResolver: letsencrypt
  services:
    beacon:
      loadBalancer:
        servers:
          - url: http://192.168.1.10:7070
```

`authentik` is whatever your forward-auth middleware is called in that file
(`authelia` for Authelia), and `websecure`/`letsencrypt` stand for your own
entry point and certificate resolver. If Traefik reaches Beacon over a
Docker network rather than the LAN, the URL is the container's
(`http://beacon:7070`).

### Nginx Proxy Manager

The proxy host points at Beacon as usual (Details tab: `http`, Beacon's
address, port `7070`). The guides for Authentik and Authelia both put a
`location /` block with `auth_request` into the Advanced tab. Add these two
locations next to it, in the same Advanced tab - they are matched ahead of
`/` and carry no `auth_request`:

```nginx
# Party guests, past the login
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

Without a login in front, none of this is needed: an ordinary proxy host
with an SSL certificate is all.

### Caddy

A named matcher for the party path, handled before the protected rest:

```caddy
beacon.example.com {
	@party path /party /party/*

	# Party guests, past the login
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
`X-Forwarded-For` and `X-Forwarded-Proto` on its own. With Authelia, the
`forward_auth` block is the one from Authelia's guide for Caddy; the
`@party` handle stays as it is. Without a login in front,
`reverse_proxy 192.168.1.10:7070` alone is the whole site block.

### Authelia

Whichever proxy sits in front, Authelia can let the party through on its
own: a `bypass` rule for the path, above the rule that protects the rest of
Beacon. Authelia uses the first rule that matches, so the order matters.

```yaml
access_control:
  rules:
    # Party guests, past the login
    - domain: beacon.example.com
      resources:
        - '^/party([/?].*)?$'
      policy: bypass
    # The rest of Beacon, as before
    - domain: beacon.example.com
      policy: one_factor
```

The expression matches `/party` and everything under `/party/`, but not
another path that happens to start with `/party`. With this rule in place,
the proxy needs no route of its own for the party: the forward-auth in
front of Beacon asks Authelia, and Authelia waves `/party` through.

<!-- /tabs -->

## Client addresses

Joining is limited per client address. Beacon only trusts an
`X-Forwarded-For` header from a proxy listed in `TRUSTED_PROXIES`
(comma-separated addresses or networks, default `127.0.0.1/32,::1/128`, which
is the nginx inside the container). Add the address your proxy reaches Beacon
from, or every guest counts as the proxy and they all share the join
limits:

| Proxy                                                         | Add, for example                       |
| ------------------------------------------------------------- | -------------------------------------- |
| In a Docker network on the same host (Traefik, NPM, Caddy)    | `172.16.0.0/12`, Docker's networks     |
| On another machine                                            | That machine's address, `192.168.1.5`  |
| On the same host, outside Docker or with `network_mode: host` | Nothing, `127.0.0.1` is already listed |

For example `TRUSTED_PROXIES=127.0.0.1/32,::1/128,172.16.0.0/12`. The
same list decides whether `X-Forwarded-Proto: https` is believed when the
cookie is marked `Secure`.

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
  tries in ten minutes, and an address can join at most twenty times in ten
  minutes. Everything after joining counts per guest, not per address, so
  guests sharing one (an office, a venue) don't share limits: wishes,
  withdrawals, votes, searches and covers are rate-limited per guest, live
  connections are capped per guest and in total, and a party holds at most
  100 guests.
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
