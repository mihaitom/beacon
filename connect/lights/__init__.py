"""lights/ — room lights that play along with the music.

Philips Hue only for now, through its Entertainment API: a DTLS stream of
colours straight to the bridge, the one mechanism a light maker offers for
this. hue.py talks to the bridge, analysis.py (with beats.py) turns a song into its
beats and a loudness curve, show.py turns those into colours, controller.py
decides when and for which playback the show runs, and config.py keeps the
pairing and the choices across restarts.
"""
