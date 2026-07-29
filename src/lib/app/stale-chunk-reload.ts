/**
 * Recover from stale route chunks after a deploy.
 *
 * Route components are lazily imported, and every build stamps a new content
 * hash into the asset filenames. A tab left open across a deploy is still
 * running the old build, so the moment it navigates to a route it has not
 * loaded yet it requests a chunk the production alias no longer serves. The
 * dynamic import rejects and the router surfaces it as
 * "Failed to fetch dynamically imported module", which no amount of retrying
 * inside the old build can fix — the tab has to pick up the new build.
 *
 * Vite fires `vite:preloadError` for exactly this case, so reload once to do
 * that. The cooldown stops a reload loop if the chunk is genuinely missing
 * (a broken deploy) rather than merely stale, in which case the user still
 * gets the router's error screen.
 */
const RELOAD_AT_KEY = 'rush-tracker:chunk-reload-at'
const RELOAD_COOLDOWN_MS = 10_000

function recentlyReloaded(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_AT_KEY) ?? 0)
    return Date.now() - last < RELOAD_COOLDOWN_MS
  } catch {
    // Private-mode / blocked storage: treat as "already tried" so a failure
    // to read never turns into an unbounded reload loop.
    return true
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()))
  } catch {
    // Ignore — recentlyReloaded() already fails closed.
  }
}

export function installStaleChunkReload(): () => void {
  if (typeof window === 'undefined') return () => {}

  const onPreloadError = (event: Event) => {
    if (recentlyReloaded()) return
    // Suppress Vite's default rethrow so the reload wins the race against the
    // router's error boundary.
    event.preventDefault()
    markReloaded()
    window.location.reload()
  }

  window.addEventListener('vite:preloadError', onPreloadError)
  return () => window.removeEventListener('vite:preloadError', onPreloadError)
}
