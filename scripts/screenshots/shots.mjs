// What the README screenshots show. Edit this file, then run
// `pnpm screenshots` (all of them) or `pnpm screenshots home artist`.
//
// Every shot starts in a fresh, logged-in browser and plays `song` first,
// so the player bar, waveform and visualizer have something to show.
// `position` is in seconds. Songs are looked up by artist + title on the
// server from connect/.env (or SCREENSHOT_* - see take.mjs).
//
// Per shot:
// - `theme`, as in Settings > Appearance: 'beacon', 'graphite', 'paper',
//   'glacier', or 'custom' with `custom: { background: '#1B1F24', primary:
//   '#E07A5F' }`. `adaptiveAccent` lets Now Playing tint the app in the
//   artist background's colour. Left out: the app's default.
// - `fanart`, which Fanart.tv images an artist gets, by artist name:
//   `{ banner: 2, background: 1 }`, or just a number or string for the
//   background. The banner is Home's hero, the background the artist page's
//   and Now Playing's. A number is the position in the list (1 = Fanart.tv's
//   best), a string a piece of the image URL. Every run prints each artist's
//   lists with the chosen ones starred. Anything not set is picked at
//   random, as in the app.

/** @type {import('./take.mjs').ScreenshotConfig} */
export default {
  outDir: 'docs/screenshots',
  // WebP quality, 0-1.
  quality: 0.9,
  // Player volume, 0-1 (the slider in the player bar).
  volume: 0.35,
  // How long to let a view settle after it opened (artwork, fanart,
  // waveform, visualizer) before the picture is taken, in ms.
  settle: 4000,

  shots: [
    {
      name: 'home',
      device: 'desktop',
      theme: { theme: 'beacon', adaptiveAccent: true },
      fanart: { deadmau5: { banner: 1 } },
      song: {
        artist: 'deadmau5',
        title: 'Ghosts ’n’ Stuff',
        position: 236,
      },
      open: { route: '/' },
    },
    {
      name: 'now-playing',
      device: 'desktop',
      theme: { theme: 'glacier', adaptiveAccent: true },
      fanart: { Gorillaz: 2 },
      song: { artist: 'Gorillaz', title: 'Feel Good Inc.', position: 170 },
      // lyrics: the lyrics panel open next to Now Playing.
      open: { route: '/now-playing', lyrics: true },
    },
    {
      name: 'artist',
      device: 'desktop',
      theme: { theme: 'graphite', adaptiveAccent: true },
      fanart: { Fergie: 9 },
      song: { artist: 'Fergie', title: 'Fergalicious', position: 60 },
      open: { artist: 'Fergie' },
    },
    {
      name: 'remote',
      // The phone Remote Control, steering a desktop Beacon playing `song`.
      // It draws in that Beacon's theme.
      device: 'phone',
      remote: true,
      theme: { theme: 'graphite', adaptiveAccent: true },
      song: { artist: 'Yeah Yeah Yeahs', title: 'Heads Will Roll', position: 260 },
    },
    {
      name: 'mobile-web',
      device: 'phone',
      theme: { theme: 'glacier', adaptiveAccent: true },
      fanart: { 'Daft Punk': 4 },
      song: { artist: 'Daft Punk', title: 'The Grid', position: 231 },
      open: { route: '/m/now-playing' },
    },
  ],
}
