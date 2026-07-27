/**
 * Open a URL that must first be fetched (e.g. a short-lived signed proof URL)
 * WITHOUT tripping the browser's popup blocker.
 *
 * The blocker allows `window.open` only during the synchronous handling of a
 * user gesture. Because the signed URL is fetched with `await` first, opening
 * afterwards is treated as programmatic and blocked. The fix: open a blank tab
 * synchronously on click, then redirect it once the URL resolves.
 *
 * Returns 'opened' when a URL was produced and shown, or 'none' when the
 * fetcher reported no URL (e.g. no proof uploaded yet). Throws if the fetch
 * itself fails.
 */
export async function openFetchedUrl(
  fetchUrl: () => Promise<{ url: string | null }>,
): Promise<'opened' | 'none'> {
  // Opened synchronously (no `noopener`, so we keep a handle to redirect it).
  const tab = window.open('about:blank', '_blank')
  if (tab) {
    // Sever the opener link so the proof page can't reach back into the app.
    try {
      tab.opener = null
    } catch {
      // Some browsers disallow setting opener; harmless.
    }
  }

  try {
    const { url } = await fetchUrl()
    if (!url) {
      tab?.close()
      return 'none'
    }
    if (tab) tab.location.href = url
    // Fallback if the synchronous open was blocked anyway.
    else window.open(url, '_blank', 'noopener')
    return 'opened'
  } catch (err) {
    tab?.close()
    throw err
  }
}
