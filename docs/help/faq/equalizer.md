---
order: 5
---

# Equalizer

## Where do I find the equalizer?

Behind the slider icon in the player bar. It always opens the equalizer for what is playing right now: the speaker you are casting to, or this device when you are not casting. Casting to several speakers at once, you pick which one to set at the top, and each keeps its own curve. On a phone the button is in the bar at the top, and only while casting.

To change a band, drag its point up or down - anywhere in its column works, it does not have to be the point itself. A double click puts a band back to 0, and with the keyboard a point moves with the arrow keys.

## Why does my phone have no equalizer of its own?

On phones and tablets Beacon plays straight through the browser, so that the music keeps going while the screen is locked - the same reason there is no ReplayGain there. The equalizer needs to sit in the path of the sound, and that path is exactly what is left out. While casting from a phone, the speaker's equalizer works as usual, since the Beacon server applies it.

## Why does it take a while before I hear a change on a speaker?

A speaker is always sent about 15 seconds of music ahead, which it holds in reserve so that a hiccup in the Wi-Fi is never heard. What has already been sent cannot be changed, so a change reaches your ears once those seconds have played.

With gapless or crossfade on (Settings, Playback, Transitions), every change arrives without a break, after those 15 seconds. Without them, a change applies from the next song. Either way "Hear it now" (or "Apply now") restarts the song where it is with the new curve, at the cost of a short pause.

## Why does it get quieter when I turn a band up?

So that it never distorts. A boost raises the loudest moments of a song too, and most music is already mastered right up to the maximum level - one more decibel would clip. So Beacon lowers the whole curve by as much as its highest point rises: turn the bass up by 6 dB, and everything else goes 6 dB down instead. The difference between bass and the rest is what you hear as more bass; turn the volume up a little to make up for the rest.

## Does the equalizer cost sound quality?

Very little, but a speaker can no longer be sent the original file untouched, because the sound has to change on the way. A lossless file stays lossless where the speaker plays FLAC; otherwise it is converted to a high-quality format the speaker plays. With a flat curve, or the equalizer switched off, nothing is changed. Which format a speaker gets, and why, is in [What gets converted, and why](../reference/transcoding-decisions.md).

## Does it work with the radio?

Not while casting. A station is sent to every speaker as one stream, usually exactly as the station sends it, so there is no stream per speaker to put a curve in. On a computer playing the station itself, this device's equalizer works.

## Are my curves and presets kept?

A speaker's curve and the presets you save follow your account, so they are the same on every device you cast from. This device's own curve stays on this device, since it is about the headphones or speakers plugged in here. Saving a preset under a name that already exists replaces it.
