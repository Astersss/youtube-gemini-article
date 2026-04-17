/**
 * Extracts the 11-character video ID from any standard YouTube URL.
 * Handles: watch?v=, youtu.be/, embed/
 */
export function extractVideoId(url) {
  const m = url.match(/(?:[?&]v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

/**
 * Fetches transcript lines (with timestamps) and chapter list for a YouTube video.
 *
 * Returns: { lines: [{text, startMs}], chapters: [{title, startMs}] }
 *
 * Strategy:
 * 1. Fetch the watch page — extracts InnerTube API key + chapter data (ytInitialData).
 * 2. POST to /youtubei/v1/player with ANDROID client — gets captionTracks URLs.
 *    (ANDROID client returns timedtext URLs that work server-side, unlike WEB client.)
 * 3. Fetch the timedtext XML — parse into {text, startMs} pairs preserving timestamps.
 * 4. Chapters are optional: empty array if the video has none.
 */
export async function fetchTranscript(videoId) {
  // Step 1 — fetch page, extract API key and chapter data
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!pageRes.ok) throw new Error(`YouTube fetch failed: HTTP ${pageRes.status}`);

  const html = await pageRes.text();

  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const apiKey = apiKeyMatch?.[1];
  if (!apiKey) throw new Error('Could not extract InnerTube API key from YouTube page.');

  const chapters = extractChapters(html);

  // Step 2 — call /player with ANDROID context to get captionTracks URLs
  const playerRes = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
        videoId,
      }),
    }
  );
  if (!playerRes.ok) throw new Error(`InnerTube player request failed: HTTP ${playerRes.status}`);

  const playerData = await playerRes.json();
  const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) throw new Error('No subtitles found. The video may have captions disabled.');

  // Prefer English, fall back to first available track
  const track = tracks.find(t => t.languageCode === 'en') ?? tracks[0];

  // Step 3 — fetch the timedtext XML
  const xmlRes = await fetch(track.baseUrl);
  if (!xmlRes.ok) throw new Error(`Timedtext fetch failed: HTTP ${xmlRes.status}`);

  const xml = await xmlRes.text();
  if (!xml) throw new Error('Timedtext returned empty response.');

  // Step 4 — parse XML into {text, startMs} pairs
  const lines = parseTimedtextXml(xml);
  if (lines.length === 0) throw new Error('No subtitles found. The video may have captions disabled.');

  return { lines, chapters };
}

/**
 * Extracts YouTube chapter list from the ytInitialData blob embedded in the watch page.
 * Returns [{title, startMs}] sorted by startMs, or [] if the video has no chapters.
 */
function extractChapters(html) {
  try {
    const match = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;/s);
    if (!match) return [];
    const data = JSON.parse(match[1]);

    const markersMap =
      data?.playerOverlays
          ?.playerOverlayRenderer
          ?.decoratedPlayerBarRenderer
          ?.decoratedPlayerBarRenderer
          ?.playerBar
          ?.multiMarkersPlayerBarRenderer
          ?.markersMap ?? [];

    const entry = markersMap.find(m => m.key === 'DESCRIPTION_CHAPTERS');
    const raw = entry?.value?.chapters ?? [];

    return raw.map(c => ({
      title: c.chapterRenderer.title.simpleText,
      startMs: c.chapterRenderer.timeRangeStartMillis,
    }));
  } catch {
    return [];
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * Parses timedtext XML into an array of {text, startMs} objects.
 *
 * ANDROID format — word-level <s> elements inside timed <p> cues:
 *   <p t="160" d="3600"><s>this</s><s t="160"> new</s></p>
 *
 * Fallback — simple <text start="0.16" dur="..."> format.
 */
function parseTimedtextXml(xml) {
  const lines = [];

  // Primary: <p t="..."> / <s> word-level format
  const pRegex = /<p\b[^>]*\bt="(\d+)"[^>]*>(.*?)<\/p>/gs;
  const sRegex = /<s[^>]*>([^<]*)<\/s>/g;

  let pMatch;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const startMs = parseInt(pMatch[1], 10);
    const pContent = pMatch[2];
    const words = [];
    let sMatch;
    while ((sMatch = sRegex.exec(pContent)) !== null) {
      words.push(sMatch[1]);
    }
    sRegex.lastIndex = 0;
    const text = decodeEntities(words.join('').trim());
    if (text) lines.push({ text, startMs });
  }

  // Fallback: <text start="0.16"> simple format
  if (lines.length === 0) {
    const textRegex = /<text\b[^>]*\bstart="([^"]+)"[^>]*>([^<]*)<\/text>/g;
    let m;
    while ((m = textRegex.exec(xml)) !== null) {
      const startMs = Math.round(parseFloat(m[1]) * 1000);
      const text = decodeEntities(m[2].trim());
      if (text) lines.push({ text, startMs });
    }
  }

  return lines;
}
