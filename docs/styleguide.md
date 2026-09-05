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
| 12px   | a tile, a station card                                    |
| 4px    | cover art, everywhere in the app                          |
| 0      | mobile list rows - a stack of rounded cards is not a list |

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

Scrollbars are hidden app-wide (`base.css`) - scrolling still works, only the
chrome is gone. A scroll region therefore has to look scrollable on its own.

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

- `max-width` ladder in use: **400-420** for a form or a confirmation,
  **560-720** for something to read, **820-920** for a list or release notes.
- `scrollable` puts the scroll on `v-card-text`; never nest a second scroll
  region inside it.
- A dialog that is a screen on a phone goes `:fullscreen="compact"` and wears
  `--beacon-chrome`, so it reads as the app rather than as a panel floating
  over nothing.
- Close: an `mdi-close` icon button at the top right, and/or a text button in
  `v-card-actions`. A dialog with a picture-backed header uses the icon only,
  since the footer button would sit under a header that already offers one.
- Cap the height (`max-height: 76vh` in the sheets that do) when the dialog
  is something read _next to_ the app rather than instead of it - it leaves
  the player bar visible.

## Motion

0.15s for a hover or an opacity change, 0.6s for a backdrop crossfade. There
is no third speed; if something needs one, it probably needs a reason first.
