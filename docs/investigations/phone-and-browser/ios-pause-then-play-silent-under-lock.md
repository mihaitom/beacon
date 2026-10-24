# Pause, then play from an iPhone's lock screen stays silent (home-screen app)

**Status: OPEN - a WebKit bug, not Beacon's (2026-10-10).** Plays in a Safari
tab; fails in the same build installed to the home screen. Nothing changed in
Beacon for it.

## Symptom

On an iPhone, Beacon installed to the home screen: pause on the lock screen,
press play a few seconds later. No sound, while the lock screen's timer runs
on; pressing pause again puts the timer back where it was. Unlocking the phone
sometimes starts the sound by itself, sometimes finds it paused. "Original"
and transcodes alike.

## What the phone actually does

A temporary trace (every lock-screen action, every `<audio>` event, every
`play()` call, posted into connect's log with the phone's own clock) showed:

```
+20.9s hidden  action pause     -> el pause    t=131.9
+22.9s hidden  action play      -> play() -> el playing t=131.9
+26.9s hidden  previoustrack    -> new src, loadstart ... no canplay
+29.7s hidden  nexttrack        -> loadstart ... +34.0s el stalled
+36.2s visible                  -> canplay + playing in the same 0.1s
```

- The lock-screen actions reach the page's handlers at once, and the handlers
  do the right thing: `play()` is called, the element reports `playing`.
- After that the element's clock stands still (11 s at the same position in an
  earlier run), and a new source is not even loaded until the page is visible
  again. Before the pause, the same hidden page seeked and loaded the next
  track without trouble.
- The trace lines arrived in the log on time, so the page's JavaScript was
  running throughout. It is the media pipeline that is held.
- A play that is stuck like this goes through the moment the app is unlocked,
  which is the "sometimes starts by itself".

This is [WebKit bug 243258](https://bugs.webkit.org/show_bug.cgi?id=243258)
(open since 2022): a home-screen web app whose media was paused in the
background cannot be resumed until it is in the foreground again. The Apple
developer forum has the same report (thread 762582). In our trace two seconds
of pause were enough; the reports speak of five to thirty.

## Ruled out

- **`navigator.audioSession.type = 'playback'`** (added the same day for a
  queue stopping under the lock screen, and removed again). WebKit already
  gives a playing `<audio>` element the media-playback audio category
  (`MediaSessionManagerCocoa::updateSessionState`), and that element already
  ignores the silent switch, so the declaration did nothing for Beacon; the
  only thing it changed was keeping the category set while paused. Removing
  it did not change the symptom.
- **Registering the lock-screen handlers again on every start** (what puts
  previous/next on the lock screen instead of skip-10-seconds). Doing it only
  once did not change the symptom either; the trace shows the handlers working.
- **Anything in Beacon's own pause/resume path.** It is the same in a Safari
  tab, where it works, and it has not changed since 1.6.0. 1.6.0 "working" was
  tested in Safari.

## If it is ever worked around

There is no clean way from the page. The only lever is not letting the element
pause in the background at all (keep it running, silent, while Beacon shows
"paused"), which costs battery, moves the element's position on, and is
exactly the kind of fake state the rest of the player avoids. Not done.

## Why the test suite did not catch it

It is how one WebKit configuration (a standalone web app) schedules media in
the background. Neither jsdom nor the Chromium browser tests have that state.
