# Beacon style guide

What the app is supposed to look like, in one place. It exists because the
same four lines of "panel" CSS had been written five times with three
different radii, and each new dialog started by copying whichever one its
author happened to have open - which is how a sheet ends up looking almost,
but not quite, like the page behind it.

The shared classes in `src/renderer/src/assets/base.css` are the actual
source of truth; this file says when to reach for which, and records the
decisions that are not obvious from reading the CSS. If a rule here and the
code disagree, the code is right and this file is stale - fix it.

**To look at it rather than read it:** open `docs/styleguide.html` in a
browser. It loads that same `base.css`, so every panel, heading and row on it
is drawn by the rules the app actually uses and cannot drift from them.
`node scripts/render-styleguide.mjs` turns that page into a PNG and a PDF
(into `dist/styleguide/`, which is git-ignored on purpose - the picture goes
stale, the page does not).

Two standing rules that predate the rest:

- **No Vuetify utility classes in templates.** `d-flex`, `align-center`,
  `w-100`, `mb-4` and friends do not appear in Beacon's markup. Layout goes
  in a scoped `<style>` block, where it can carry a name and a comment.
  Vuetify's _type_ classes (`text-body-small`, `text-medium-emphasis`) are
  the exception - they are the app's type scale, not layout.
- **Every rule earns a comment when the reason isn't visible.** The number
  is rarely the interesting part; why that number is.
- **Look for the Vuetify component before building the behaviour.** Beacon
  ships Vuetify already; a component from it arrives tested, keyboard- and
  screen-reader-aware, and maintained by someone else. Build our own only
  where none fits, and say in a comment which one was considered and why it
  did not. The scrolling shelves are the standing example of getting this
  wrong: `AlbumShelf`/`CardShelf` hand-roll the row, the chevrons and the
  logic that dims them at each end (`shelfScrollEdges.ts`), all of which
  `v-slide-group` does out of the box - it has `show-arrows`, its own
  overflow detection and a `--disabled` state per arrow. What it does not
  have is the grid toggle and the heading row, which is the only part that
  was ever ours to write.

---

## Palette

The Vuetify theme (`main.ts`, theme name `beacon`) is dark only. There is no
light theme, so a hard-coded `rgba(255, 255, 255, x)` is legitimate.

| Token                                    | Value                                         | What it is                                   |
| ---------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `background`                             | `#12141C`                                     | The page                                     |
| `surface`                                | `#1A1D27`                                     | Cards, dialogs, menus                        |
| `surface-bright`                         | `#232733`                                     | A surface on a surface                       |
| `primary`                                | `#F5A94E`                                     | The beacon's amber. Signal, never decoration |
| `secondary`                              | `#5B84B1`                                     | The cool counterpart, used sparingly         |
| `error` / `warning` / `info` / `success` | `#E5484D` / `#F2A93B` / `#5B84B1` / `#5FB489` | States                                       |

Plus the chrome tokens in `base.css`:

| Token                        | Value                      | What it is                                                                                                  |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--beacon-chrome`            | `#0b0d13`                  | The always-visible frame (nav rail, app bar, phone tab bar) - one shade _darker_ than the content behind it |
| `--beacon-hairline`          | `rgba(245, 169, 78, 0.14)` | Every border and divider in the app                                                                         |
| `--beacon-hover`             | `rgba(245, 169, 78, 0.07)` | The one hover tint for list rows                                                                            |
| `--beacon-player-bar-height` | `88px`                     | Must match PlayerBar's own `height`                                                                         |

Amber is the app's signal colour: an active nav item, a selected segment, an
eyebrow, a divider. It is not a fill - nothing large is amber.

## Type

| Class            | Face                                      | Where                                                |
| ---------------- | ----------------------------------------- | ---------------------------------------------------- |
| `.display-title` | Georgia serif, 600                        | Hero moments only (HeroBand, a dialog's subject)     |
| `.detail-title`  | Georgia serif, 600, 2.25rem               | The name at the top of an album/artist/playlist page |
| `.page-title`    | Inter, 1.5rem, 600                        | A view's own name                                    |
| `.section-title` | Inter, 1.15rem, 600, **lit mark**         | A section _of a page_                                |
| `.panel-title`   | `.eyebrow-label` type + trailing hairline | A section _inside_ a panel or dialog                 |
| `.eyebrow-label` | 0.72rem, 700, 0.12em, amber               | The small label above a title                        |

Body text stays on Vuetify's scale: `text-body-medium`, `text-body-small`,
`text-medium-emphasis` for the quieter line.

The serif face is the app's signature and is rationed deliberately - two or
three per screen at most, never for a label or a row.

### Column headings

A song table's column labels wear the same small-label shape as
`.eyebrow-label` - upper case, tracked, 700 - but in muted white, not amber.
Amber is the signal colour and there are eight of these; it goes to the one
heading that is actually saying something, the column the list is sorted by.
Sentence case at body size, which is what these were, makes the header read
as one more row of the list.

Watch the control: each heading is a `<button>`, and a form control inherits
neither `text-transform` nor `letter-spacing` (the UA stylesheet resets both,
and `font: inherit` covers neither). Both have to be handed down explicitly -
see `SongTableHeader.vue` and its layout test.

### The two section headings

`.section-title`'s little lit mark is the same beacon-glow as the nav rail's
active indicator. It marks a section of a **page**. `.panel-title` is the
second level, for a group of fields **inside** a surface: the amber eyebrow
with a hairline carrying it to the far edge.

```html
<h2 class="section-title">Playback</h2>
<!-- a page's section -->
<h3 class="eyebrow-label panel-title">Audio</h3>
<!-- a panel's section -->
```

Giving every group of four fields a lit mark is what would drain the mark of
meaning, which is why the dialog level is a different, quieter thing rather
than the same heading at a smaller size.

## Surfaces

```html
<div class="beacon-panel">…</div>
<!-- padded -->
<dl class="beacon-panel beacon-panel--flush">…</dl>
<!-- rows bring their own padding -->
```

`.beacon-panel` is 18px/20px of padding, a 14px radius, a `--beacon-hairline`
border and a 2% white fill. A panel reads as a slightly raised area of the
same surface, not as a second colour. `--flush` drops the padding and clips
the corners, for a list of rows whose separators have to run edge to edge.

Radius ladder, so a sheet reads as the container of its parts:

| Radius | Where                                                     |
| ------ | --------------------------------------------------------- |
| 16px   | a dialog card                                             |
| 14px   | a panel (12px on a phone, where padding tightens to 14px) |
| 12px   | a tile, a station card, a segmented control               |
| 8px    | a small element _inside_ a surface                        |
| 4px    | cover art and any other image, everywhere in the app      |
| 0      | mobile list rows - a stack of rounded cards is not a list |

The 8px step is the one that keeps getting invented on the spot - it had
been written as 6, 7, 8 and 10 in different files. It is for the parts a
surface is made of rather than for a surface: a toast's icon badge and its
close button, a `kbd`, the caption pill over the lightbox, a row inside a
panel. Anything that is itself a surface takes one of the steps above it.

## Dividers

One rule: `1px solid var(--beacon-hairline)`, drawn **between siblings only**,
never after the last one - there it underlines the end of a list instead of
separating anything.

```css
.setting + .setting {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--beacon-hairline);
}
```

In a two-column grid there is no `+` to use, since each row is two cells:
draw the border on both cells and clear it on the first row
(`> :nth-child(-n + 2)`). See `SongInfoDialog.vue`.

Resist a second, quieter divider colour for "there are a lot of these" - it
was tried in the track-info dialog and only made that dialog the one place
with two kinds of hairline.

## Context menus

Every right-click menu is cut into the same four sections, in this order,
each introduced by a `<context-menu-section>` heading. A menu simply leaves
out the sections it has nothing for - it never reorders them.

The heading is `.eyebrow-label` + `.panel-title`, the same pair a section
inside a panel wears, so it brings its own hairline and there is no
`<v-divider />` beside it: titling a section costs the menu no height it was
not already spending on a separator.

| Section    | What belongs in it                              | Entries today                                                       |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Playback   | What comes out of the speakers, and when        | Play / Play all, Play next, Add to queue, Song Radio / Artist Radio |
| Library    | What is still true tomorrow                     | Add to playlist, Rename, Delete                                     |
| Navigation | Somewhere else in the app                       | Go to album, Go to artist                                           |
| Dialogs    | Opens something over the page instead of acting | Show image, Info                                                    |

Within Playback the order is when it plays: now, next, at the end - and then
the Radio entry, which is the one that conjures a queue rather than adding to
the one there is.

The split that keeps getting redrawn by hand is Add to queue vs. Add to
playlist. They sound alike and belong in different sections: the queue is
undone by playing something else, a playlist is not.

## The artwork backdrop

Beacon's one hero effect: the artwork of whatever the surface is about,
blurred past recognition behind it. Same recipe everywhere (HeroBand,
DetailHeader, NowPlayingView, SongInfoDialog):

```css
inset: -20px; /* real image at the edges */
filter: blur(38px) saturate(1.4) brightness(0.55);
transform: scale(1.15);
```

over a two-stop scrim that keeps text readable and lands the amber on the
far side:

```css
linear-gradient(120deg, rgba(18,20,28,.94), rgba(18,20,28,.74) 48%, rgba(245,169,78,.18)),
linear-gradient(to bottom, transparent 55%, rgba(18,20,28,.55))
```

Ask the server for the cover at **300px** (`client().coverArtUrl(id, 300)`):
it is about to be blurred, and every other backdrop in the app asks for that
size, so it stays one cached image rather than a private resolution per
caller.

Where the backdrop can _change_ while the surface stays (navigating from one
album to the next, the next track starting), it needs two stacked layers and
`services/crossfadeBackdrop.ts` - `background-image` cannot transition. A
dialog that is built fresh each time it opens does not need this. The fade is
0.6s everywhere.

## Lists

Phone list rows are one primitive, `.mobile-row` in `base.css`: 60px tall,
48px of artwork (`MOBILE_ROW_ART_SIZE`, kept equal to the CSS), two lines of
text, a hairline under every row but the last, no radius. Queue, Library,
Playlists and Radio all use it - what a row _carries_ differs, how tall it is
does not.

Desktop rows get their hover from `--beacon-hover`; a plain `v-list` opts in
with `.beacon-list` on its container.

`.mobile-row__text` clips both of its lines itself - a row is a fixed 60px,
so a long title has nowhere to wrap to. No list component says
`text-truncate` on its own lines.

Two more shared classes serve the library pages, for the same reason
`.beacon-panel` does - they had been copied into six views each:

| Class             | What it is                                                     |
| ----------------- | -------------------------------------------------------------- |
| `.library-search` | The search box above a grid: 320px wide, with the gap under it |
| `.view-notice`    | The error banner or spinner shown in place of that grid        |

Scrollbars are hidden app-wide (`base.css`) - scrolling still works, only the
chrome is gone. A scroll region therefore has to look scrollable on its own.

## Overriding a child component's own styles

A class you put on a child component lands on that component's **root
element**, alongside its own classes - and scoped CSS adds one attribute
selector to each side, so `.my-class[data-v-parent]` and
`.child-class[data-v-child]` tie on specificity. Which one wins is then
decided by stylesheet order, which is not something to build on.

Name both classes:

```css
.artwork-lightbox__art.cover-art {
  background: transparent;
}
```

`:deep()` does not help here - it targets descendants, and the root element
is not one. The same pattern is in `NowPlayingView.vue`
(`.radio-cover-art--transparent.cover-art`).

The recurring case is `CoverArt.vue`'s faint placeholder fill, which is
right in a grid (a cover reads as a tile before it arrives) and wrong
wherever the picture is `contain`ed inside a square box: what is left over
then shows as grey bars beside a portrait photo or above a wide logo.

## Chips

A chip is for a **tag** - one of a set the reader scans rather than reads:
the genres and moods on a track, the "can be switched off" marker in the
privacy sheet. `size="small" variant="tonal" color="primary"`, laid out in a
wrapping flex row with a 6px gap.

Not for a value that happens to be short. A bitrate, a format or a year is
one fact and stays plain text - chipping those turns a spec sheet into
confetti. A list of identifiers (ISRC) stays text too: it is there to be
copied, not scanned.

## Dialogs

### How big

Width, by what the dialog is for:

| `max-width` | For                                                      |
| ----------- | -------------------------------------------------------- |
| 400-420     | a form or a confirmation - a rename, a delete, a pairing |
| 560-720     | something to read - shortcuts, privacy, a track's fields |
| 820-920     | a list or a long document - Discover, release notes      |

Height is **one value, not a judgement call**: a dialog whose content can be
arbitrarily long wears `.beacon-dialog`, which caps it at
`--beacon-dialog-max-height` (70vh) and scrolls the body inside that cap.

```html
<v-card class="beacon-dialog">…</v-card>
```

Why capped at all: Vuetify lets a card grow to roughly 90% of the viewport,
at which point the app behind it is a sliver at the top and bottom and the
dialog reads as a takeover of the page. At 70vh the app bar and the player
bar stay in view, so it reads as something opened _in_ Beacon. Four dialogs
had each picked their own answer to this (68, 70, 70 and 76vh, and one with
no cap at all), which is exactly the drift the class exists to stop.

Two things the class deliberately does **not** apply to:

- **Small dialogs** - a rename form, a confirmation. Their content is a fixed
  few lines; a cap there only invents a scroll region nobody needs.
- **A fullscreen phone dialog** (`:fullscreen="compact"`), where the dialog
  _is_ the page. `RadioDiscoverDialog.vue` shows the shape: the shared class
  on the windowed branch, `--beacon-chrome` on the phone one.

`ArtworkLightbox.vue`'s `72vh` is not a dialog cap and must not be folded in

- it is the size of the _picture_, sharing the window with a caption beneath
  it. The phone's bottom sheets (50-60vh) are their own family too.

### The cap has to scroll, not clip

`max-height` alone is a bug: measured in a real browser, v-dialog's own
`scrollable` left `.v-card-text` at `overflow-y: visible`, so the card
clipped at the cap and everything past it was unreachable. The privacy sheet
shipped that way once. `.beacon-dialog` carries the flex column and the
`overflow-y: auto` that actually make it scroll, and
`PrivacyDialog.layout.browser.test.ts` is the test that holds that down for
every dialog wearing the class - including the assertion that the _card_
does not scroll, which is what "the cap is clipping" looks like.

### The rest

- `scrollable` on the `v-dialog`, and never a second scroll region nested
  inside the body.
- Close: an `mdi-close` icon button at the top right, and/or a text button in
  `v-card-actions`. A dialog with a picture-backed header uses the icon only,
  since the footer button would sit under a header that already offers one.

## Motion

Two speeds carry almost everything, and a new component should reach for one
of them before anything else:

| Duration | For                                                                 |
| -------- | ------------------------------------------------------------------- |
| 0.15s    | A hover, a colour, an opacity - feedback on something being touched |
| 0.6s     | The artwork backdrop crossfade (and RankedList's bars filling)      |

0.15s is used about three dozen times and is the default answer. The rest of
what the app does is not drift - each of these is a different _kind_ of
movement, and they are listed here so the next one reuses a duration instead
of inventing a neighbouring one:

| Duration           | Where                                        | Why not 0.15s                                                                       |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0.1s               | Device rows in the cast pickers              | A dense list; the standard speed reads as lag when the pointer crosses several rows |
| 0.3s in / 0.2s out | Toasts, queue rows entering and leaving      | Something arriving should be noticed, something leaving should get out of the way   |
| 0.2s               | The login form swapping between server types | A whole panel changing, not one control                                             |
| 0.25s              | Lyrics lines, a queue row being cleared      | Reads as the line changing rather than blinking                                     |
| 0.26s              | The login card's own height                  | Paired with the 0.2s form swap inside it                                            |
| 0.35s / 0.45s      | The lyrics column opening beside the artwork | A layout change, and the artwork drifts sideways with it                            |
| 0.4s               | The visualizer row's height                  | Same: layout, not feedback                                                          |
| 0.5s               | A queue row landing after a drag             | Confirms a drop the person made themselves                                          |
| 0.7s               | Now Playing's flip card (artwork <-> lyrics) | The one deliberate showpiece; it is meant to be watched                             |
| 0.9s               | The release-notes icon                       | A one-off flourish on a dialog seen once per version                                |
| 1.2s               | Now Playing's scrim and glow                 | Follows the colour extracted from the cover; a fast change reads as a flicker       |

Loops are their own thing - they show a state rather than a change, so they
are slow enough not to nag: 1.8s for the page loader, 2.4s for radio's "on
air" pulse, 3.5s for the beacon on the sign-in screen.

**Every loop and every showpiece above answers `prefers-reduced-motion`**
with `animation: none` or `transition: none` - the page loader, the radio
pulse, the sign-in beacon, the flip card, the lyrics lines, the genre grid,
the search box and the visualizer. A new one is expected to do the same.
