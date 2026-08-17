// art.js — shared cover-art/favicon element builder.
//
// Real <img> elements, not CSS background-image — matches the desktop
// app's own CoverArt.vue, which always renders through a real <img>
// (Vuetify's v-img) rather than a background-image div. Some radio
// stations' SVG favicons were showing up colorless here specifically
// because of that difference (an SVG referenced from a CSS background can
// render its fill colors differently, or lose them entirely, compared to
// the same file loaded as a real image) — an <img> also gets a proper
// error event to fall back to the placeholder icon on a broken/404 URL,
// which the old background-image version had no way to detect at all.

export function setArt(container, url, fallbackIconClass) {
  container.innerHTML = '';
  if (!url) {
    if (fallbackIconClass) container.innerHTML = `<i class="mdi ${fallbackIconClass}"></i>`;
    return;
  }
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.addEventListener('error', () => {
    container.innerHTML = fallbackIconClass ? `<i class="mdi ${fallbackIconClass}"></i>` : '';
  });
  container.appendChild(img);
}

export function createArt(url, fallbackIconClass, className = 'row-art') {
  const art = document.createElement('div');
  art.className = className;
  setArt(art, url, fallbackIconClass);
  return art;
}
