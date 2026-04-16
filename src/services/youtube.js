/**
 * Extracts the 11-character video ID from any standard YouTube URL.
 * Handles: watch?v=, youtu.be/, embed/
 *
 * @param {string} url
 * @returns {string|null}
 */
export function extractVideoId(url) {
  const m = url.match(/(?:[?&]v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

/**
 * Fetches the plain-text transcript for a YouTube video.
 *
 * Strategy:
 * 1. Fetch the watch page with browser-like headers to avoid bot blocks.
 * 2. Regex-extract the first captionTracks baseUrl from the embedded JSON.
 * 3. Fetch the timedtext XML and parse <text> elements into a plain string.
 *
 * @param {string} videoId
 * @returns {Promise<string>} Full transcript as space-joined plain text
 * @throws {Error} If the page fetch fails, captions are absent, or XML fetch fails
 */
export async function fetchTranscript(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!pageRes.ok) {
    throw new Error(`YouTube fetch failed: HTTP ${pageRes.status}`);
  }

  const html = await pageRes.text();

  // Pull the first captionTracks entry's baseUrl out of the embedded JSON blob.
  // YouTube escapes & as \u0026 inside the JSON string — we unescape it after.
  const m = html.match(/"captionTracks":\[.*?"baseUrl":"([^"]+)"/);
  if (!m) {
    throw new Error('No subtitles found. The video may have captions disabled.');
  }

  const captionUrl = m[1].replace(/\\u0026/g, '&');

  const xmlRes = await fetch(captionUrl);
  if (!xmlRes.ok) {
    throw new Error(`Transcript fetch failed: HTTP ${xmlRes.status}`);
  }

  return parseTimedText(await xmlRes.text());
}

/**
 * Parses YouTube timedtext XML into a single plain-text string.
 * Each <text> element may contain HTML entities; we decode the common ones.
 *
 * @param {string} xml
 * @returns {string}
 */
function parseTimedText(xml) {
  return [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map(([, raw]) =>
      raw
        .replace(/\n/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim()
    )
    .filter(Boolean)
    .join(' ');
}
