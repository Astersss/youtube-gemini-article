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
 * Strategy: try InnerTube first (free, unlimited, gives us chapters from ytInitialData).
 * If YouTube soft-blocks the egress IP (common on Cloudflare Workers), fall back to
 * supadata.ai for the transcript, and best-effort fetch chapters from the same provider's
 * video metadata endpoint by parsing the "Timestamps:" block out of the description.
 */
export async function fetchTranscript(videoId, env) {
  try {
    return await fetchViaInnerTube(videoId);
  } catch (err) {
    const looksBlocked = /HTTP 429|blocking this IP|No subtitles found/.test(err.message);
    if (!looksBlocked || !env?.SUPADATA_API_KEY) {
      throw err;
    }
    console.warn('[youtube] InnerTube failed, falling back to supadata:', err.message);
    // Serial calls with 1.1s gap — Supadata's free plan has a burst rate limit
    // (parallel calls trigger HTTP 429 limit-exceeded). Chapters are best-effort.
    const lines = await fetchViaSupadata(videoId, env.SUPADATA_API_KEY);
    await new Promise(r => setTimeout(r, 1100));
    let chapters = [];
    try {
      chapters = await fetchSupadataChapters(videoId, env.SUPADATA_API_KEY);
    } catch (e) {
      console.warn('[youtube] supadata chapters fetch failed:', e.message);
    }
    console.log(`[youtube] supadata fallback: ${lines.length} lines, ${chapters.length} chapters`);
    return { lines, chapters };
  }
}

/**
 * InnerTube path:
 * 1. Fetch the watch page — extracts InnerTube API key + chapter data (ytInitialData).
 * 2. POST to /youtubei/v1/player with ANDROID client — gets captionTracks URLs.
 *    (ANDROID client returns timedtext URLs that work server-side, unlike WEB client.)
 * 3. Fetch the timedtext XML — parse into {text, startMs} pairs preserving timestamps.
 * 4. Chapters are optional: empty array if the video has none.
 */
async function fetchViaInnerTube(videoId) {
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
  if (tracks.length === 0) {
    // Diagnostic: distinguish "real no-captions" from YouTube soft-block on shared IPs (Cloudflare).
    const ps = playerData?.playabilityStatus;
    console.warn('[youtube] empty captionTracks', JSON.stringify({
      videoId,
      playabilityStatus: ps?.status,
      playabilityReason: ps?.reason,
      playabilitySubreason: ps?.errorScreen?.playerErrorMessageRenderer?.subreason?.simpleText,
      hasCaptionsField: Boolean(playerData?.captions),
      videoDetailsTitle: playerData?.videoDetails?.title,
      streamingDataPresent: Boolean(playerData?.streamingData),
    }));
    throw new Error('No subtitles found. The video may have captions disabled, or YouTube is blocking this IP.');
  }

  // Prefer English, fall back to first available track
  const track = tracks.find(t => t.languageCode === 'en') ?? tracks[0];

  const xmlRes = await fetch(track.baseUrl);
  if (!xmlRes.ok) throw new Error(`Timedtext fetch failed: HTTP ${xmlRes.status}`);

  const xml = await xmlRes.text();
  if (!xml) throw new Error('Timedtext returned empty response.');

  const lines = parseTimedtextXml(xml);
  if (lines.length === 0) throw new Error('No subtitles found. The video may have captions disabled.');

  return { lines, chapters };
}

/**
 * Supadata.ai fallback. Free tier ~100 req/month.
 * Docs: https://supadata.ai/documentation/youtube/get-transcript
 *
 * Response shape: { content: [{ text, offset (ms), duration }], lang, availableLangs }
 */
async function fetchViaSupadata(videoId, apiKey) {
  const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=false&lang=en`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supadata fetch failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const segments = data?.content ?? [];
  if (segments.length === 0) throw new Error('Supadata returned empty transcript.');

  return segments
    .map(s => ({ text: String(s.text ?? '').trim(), startMs: Number(s.offset ?? 0) }))
    .filter(l => l.text);
}

/**
 * Supadata video metadata fallback for chapters.
 *
 * When InnerTube is blocked (HTTP 429), we can't reach the YouTube watch page to
 * read the native chapter list. As a workaround, we hit Supadata's video metadata
 * endpoint (https://api.supadata.ai/v1/youtube/video?id=...) and parse chapter
 * timestamps out of the description field — YouTube creators commonly include a
 * "Timestamps:" block there, and that block is the same source YouTube itself
 * uses to render native chapter markers.
 *
 * Returns [] if the description has no parseable timestamps (best-effort).
 */
async function fetchSupadataChapters(videoId, apiKey) {
  const url = `https://api.supadata.ai/v1/youtube/video?id=${videoId}`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supadata video fetch failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return parseChaptersFromDescription(data?.description ?? '');
}

/**
 * Parses chapter timestamps from a YouTube video description.
 *
 * Matches lines like:
 *   0:00 — Introduction
 *   1:51 — What Inning Are We In? How Early the AI Shift Really Is
 *   1:08:44 — Jobs, Labor & How Society Adopts AI at Scale
 *   00:00 - Intro
 *   0:00 Intro
 *
 * Separator between time and title is permissive: any combination of whitespace,
 * em/en/ASCII dash, colon, or pipe (at least one character).
 *
 * Returns [{title, startMs}] sorted by startMs, or [] if no timestamps found.
 */
function parseChaptersFromDescription(description) {
  if (!description) return [];
  const re = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[\s—–\-:|]+(.+?)\s*$/gm;
  const chapters = [];
  let m;
  while ((m = re.exec(description)) !== null) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const s = parseInt(m[3], 10);
    chapters.push({
      title: m[4].trim(),
      startMs: (h * 3600 + min * 60 + s) * 1000,
    });
  }
  return chapters.sort((a, b) => a.startMs - b.startMs);
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
