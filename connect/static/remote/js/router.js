// router.js — minimal hash router. Each route renders into #view-root and
// returns an optional cleanup function, called before the next route mounts
// (e.g. to close a SSE-derived subscription or clear an interval).

const routes = new Map();
let cleanup = null;
let currentPath = null;

export function registerRoute(path, render) {
  routes.set(path, render);
}

function matchRoute(hash) {
  const path = (hash.replace(/^#/, '') || '/now-playing').split('?')[0];
  const params = new URLSearchParams(hash.split('?')[1] || '');
  for (const [pattern, render] of routes) {
    const patternParts = pattern.split('/').filter(Boolean);
    const pathParts = path.split('/').filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const routeParams = {};
    const isMatch = patternParts.every((part, i) => {
      if (part.startsWith(':')) {
        routeParams[part.slice(1)] = decodeURIComponent(pathParts[i]);
        return true;
      }
      return part === pathParts[i];
    });
    if (isMatch) return { render, path, routeParams, queryParams: params };
  }
  return null;
}

function renderRoute() {
  const match = matchRoute(location.hash);
  if (!match) return;

  if (cleanup) {
    cleanup();
    cleanup = null;
  }

  currentPath = match.path;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === `#${match.path}`);
  });

  const root = document.getElementById('view-root');
  root.innerHTML = '';
  cleanup = match.render(root, match.routeParams, match.queryParams) || null;
}

export function navigate(path) {
  location.hash = path;
}

export function startRouter() {
  window.addEventListener('hashchange', renderRoute);
  renderRoute();
}

export function getCurrentPath() {
  return currentPath;
}
