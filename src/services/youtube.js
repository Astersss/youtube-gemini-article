/**
 * Extracts the 11-character video ID from any standard YouTube URL.
 * Handles: watch?v=, youtu.be/, embed/
 */
export function extractVideoId(url) {
  const m = url.match(/(?:[?&]v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

/**
 * Fetches the plain-text transcript for a YouTube video.
 *
 * Strategy:
 * 1. Fetch the watch page to extract the InnerTube API key.
 * 2. POST to /youtubei/v1/player with ANDROID client context to get captionTracks.
 * 3. Fetch the timedtext XML URL from the player response.
 * 4. Parse the XML into plain text.
 *
 * Using the ANDROID client is key: it returns timedtext URLs that work server-side,
 * unlike the signed URLs returned by the WEB client (which return 200 with empty body
 * when fetched outside a real browser session).
 */
export async function fetchTranscript(videoId) {
  // Step 1 — fetch page and extract InnerTube API key
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
  const timedtextUrl = track.baseUrl;

  // Step 3 — fetch the timedtext XML
  const xmlRes = await fetch(timedtextUrl);
  if (!xmlRes.ok) throw new Error(`Timedtext fetch failed: HTTP ${xmlRes.status}`);

  const xml = await xmlRes.text();
  if (!xml) throw new Error('Timedtext returned empty response.');

  // Step 4 — parse XML into plain text
  return parseTimedtextXml(xml);
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
 * Parses the timedtext XML returned by the ANDROID player endpoint into plain text.
 *
 * The ANDROID format uses word-level <s> elements inside <p> cues:
 *   <p t="160" d="3600"><s>this</s><s t="160"> new</s><s t="640"> wave</s></p>
 *
 * Older auto-generated captions also use the basic <text> element format.
 */
function parseTimedtextXml(xml) {
  const lines = [];

  // Try word-level format first (<p>/<s> elements)
  const pRegex = /<p[^>]*>(.*?)<\/p>/gs;
  const sRegex = /<s[^>]*>([^<]*)<\/s>/g;

  let pMatch;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pContent = pMatch[1];
    const words = [];
    let sMatch;
    while ((sMatch = sRegex.exec(pContent)) !== null) {
      words.push(sMatch[1]);
    }
    sRegex.lastIndex = 0;
    const text = decodeEntities(words.join('').trim());
    if (text) lines.push(text);
  }

  // Fall back to simple <text> element format
  if (lines.length === 0) {
    const textRegex = /<text[^>]*>([^<]*)<\/text>/g;
    let m;
    while ((m = textRegex.exec(xml)) !== null) {
      const text = m[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (text) lines.push(text);
    }
  }

  return lines.join(' ') || null;
}
