#!/usr/bin/env node
/**
 * Diagnoses chapter boundary alignment for a YouTube video.
 *
 * Usage:
 *   node scripts/diagnose-chapters.js <youtube-url>
 *
 * Reads SUPADATA_API_KEY from .dev.vars, fetches transcript + chapters,
 * then shows:
 *   1. Raw chapter boundaries
 *   2. Lines in the ±60s window around each boundary
 *   3. The adjusted boundaries after adjustChapterBoundaries()
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Read .dev.vars ────────────────────────────────────────────────────────
function readDevVars() {
  const vars = {};
  try {
    const raw = readFileSync(resolve(ROOT, '.dev.vars'), 'utf8');
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    console.error('Could not read .dev.vars');
  }
  return vars;
}

// ─── YouTube helpers (mirrors src/services/youtube.js) ────────────────────
function extractVideoId(url) {
  const m = url.match(/(?:[?&]v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function parseTimedtextXml(xml) {
  const lines = [];
  const pRegex = /<p\b[^>]*\bt="(\d+)"[^>]*>(.*?)<\/p>/gs;
  const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const startMs = parseInt(pMatch[1], 10);
    const words = [];
    let sMatch;
    while ((sMatch = sRegex.exec(pMatch[2])) !== null) words.push(sMatch[1]);
    sRegex.lastIndex = 0;
    const text = decodeEntities(words.join('').trim());
    if (text) lines.push({ text, startMs });
  }
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

function extractChapters(html) {
  try {
    const match = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;/s);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const markersMap =
      data?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer
        ?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap ?? [];
    const entry = markersMap.find(m => m.key === 'DESCRIPTION_CHAPTERS');
    return (entry?.value?.chapters ?? []).map(c => ({
      title: c.chapterRenderer.title.simpleText,
      startMs: c.chapterRenderer.timeRangeStartMillis,
    }));
  } catch { return []; }
}

function parseChaptersFromDescription(description) {
  if (!description) return [];
  const re = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[\s—–\-:|]+(.+?)\s*$/gm;
  const chapters = [];
  let m;
  while ((m = re.exec(description)) !== null) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    chapters.push({
      title: m[4].trim(),
      startMs: (h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000,
    });
  }
  return chapters.sort((a, b) => a.startMs - b.startMs);
}

async function fetchViaInnerTube(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!pageRes.ok) throw new Error(`YouTube fetch failed: HTTP ${pageRes.status}`);
  const html = await pageRes.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
  if (!apiKey) throw new Error('Could not extract InnerTube API key');
  const chapters = extractChapters(html);
  const playerRes = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
      videoId,
    }),
  });
  if (!playerRes.ok) throw new Error(`InnerTube player failed: HTTP ${playerRes.status}`);
  const playerData = await playerRes.json();
  const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) throw new Error('No subtitles found / IP blocked');
  const track = tracks.find(t => t.languageCode === 'en') ?? tracks[0];
  const xmlRes = await fetch(track.baseUrl);
  const lines = parseTimedtextXml(await xmlRes.text());
  return { lines, chapters };
}

async function fetchViaSupadata(videoId, apiKey) {
  const res = await fetch(
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=false&lang=en`,
    { headers: { 'x-api-key': apiKey } }
  );
  if (!res.ok) throw new Error(`Supadata transcript failed: HTTP ${res.status}`);
  const data = await res.json();
  const lines = (data?.content ?? [])
    .map(s => ({ text: String(s.text ?? '').trim(), startMs: Number(s.offset ?? 0) }))
    .filter(l => l.text);

  await new Promise(r => setTimeout(r, 1100));

  const vRes = await fetch(
    `https://api.supadata.ai/v1/youtube/video?id=${videoId}`,
    { headers: { 'x-api-key': apiKey } }
  );
  const vData = vRes.ok ? await vRes.json() : {};
  const chapters = parseChaptersFromDescription(vData?.description ?? '');
  return { lines, chapters };
}

// ─── adjustChapterBoundaries (mirrors gemini.js) ─────────────────────────
function adjustChapterBoundaries(chapters, lines, windowMs = 90_000) {
  if (chapters.length <= 1) return chapters;
  const adjusted = chapters.map(c => ({ ...c }));
  for (let i = 1; i < chapters.length; i++) {
    const originalMs = adjusted[i].startMs;
    const prevBoundaryMs = adjusted[i - 1].startMs;
    const searchStart = Math.max(originalMs - windowMs, prevBoundaryMs + 1);
    let firstQuestion = null;
    for (const line of lines) {
      if (line.startMs < searchStart) continue;
      if (line.startMs >= originalMs) break;
      if (line.text.includes('?')) { firstQuestion = line; break; }
    }
    if (firstQuestion && originalMs - firstQuestion.startMs >= 5_000) {
      adjusted[i].startMs = firstQuestion.startMs;
    }
  }
  return adjusted;
}

// ─── Formatting helpers ────────────────────────────────────────────────────
const fmt = ms => {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0
    ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${m}:${String(s % 60).padStart(2, '0')}`;
};

function linesNear(lines, targetMs, windowMs = 60_000) {
  return lines.filter(
    l => l.startMs >= targetMs - windowMs && l.startMs <= targetMs + windowMs
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────
const url = process.argv[2];
if (!url) { console.error('Usage: node scripts/diagnose-chapters.js <youtube-url>'); process.exit(1); }

const videoId = extractVideoId(url);
if (!videoId) { console.error('Could not extract video ID from URL'); process.exit(1); }

const env = readDevVars();
console.log(`\nVideo ID: ${videoId}\n`);

let transcript;
try {
  console.log('Trying InnerTube...');
  transcript = await fetchViaInnerTube(videoId);
  console.log('InnerTube succeeded.');
} catch (err) {
  console.warn(`InnerTube failed (${err.message}), trying Supadata...`);
  if (!env.SUPADATA_API_KEY) { console.error('No SUPADATA_API_KEY in .dev.vars'); process.exit(1); }
  transcript = await fetchViaSupadata(videoId, env.SUPADATA_API_KEY);
  console.log('Supadata succeeded.');
}

const { lines, chapters } = transcript;
console.log(`\nTranscript: ${lines.length} lines, last line at ${fmt(lines.at(-1)?.startMs ?? 0)}`);
console.log(`Chapters:   ${chapters.length} found\n`);

if (chapters.length === 0) {
  console.log('No chapters found — nothing to diagnose.');
  process.exit(0);
}

const adjusted = adjustChapterBoundaries(chapters, lines);

// ─── Print boundary report ─────────────────────────────────────────────────
console.log('═'.repeat(70));
console.log('CHAPTER BOUNDARY REPORT');
console.log('═'.repeat(70));

for (let i = 0; i < chapters.length; i++) {
  const orig = chapters[i];
  const adj = adjusted[i];
  const shifted = adj.startMs !== orig.startMs;

  console.log(`\n── Chapter ${i + 1}: "${orig.title}"`);
  console.log(`   Original boundary: ${fmt(orig.startMs)} (${orig.startMs} ms)`);
  if (shifted) {
    console.log(`   Adjusted boundary: ${fmt(adj.startMs)} (${adj.startMs} ms)  ← shifted ${Math.round((orig.startMs - adj.startMs) / 1000)}s earlier`);
  } else {
    console.log(`   Adjusted boundary: (no change)`);
  }

  if (i === 0) continue; // First chapter has no "before" to show

  // Show lines in the ±60s window around the ORIGINAL boundary
  const window = linesNear(lines, orig.startMs, 60_000);
  if (window.length === 0) {
    console.log('   (no transcript lines near this boundary)');
    continue;
  }

  console.log(`\n   Lines around original boundary (±60s):`);
  for (const line of window) {
    const marker =
      line.startMs >= orig.startMs       ? '  [NEW]  ' :
      line.startMs === adj.startMs       ? '  [ADJ→] ' :
      line.startMs >= adj.startMs        ? '  [SHIFT] ' :
      '          ';
    const q = line.text.includes('?') ? ' ?' : '  ';
    console.log(`   ${fmt(line.startMs).padStart(7)}${q} ${marker}${line.text.slice(0, 80)}`);
  }
}

console.log('\n' + '═'.repeat(70));
console.log('SUMMARY');
console.log('═'.repeat(70));
for (let i = 0; i < chapters.length; i++) {
  const orig = chapters[i];
  const adj = adjusted[i];
  const delta = orig.startMs - adj.startMs;
  const deltaStr = delta > 0 ? ` (shifted ${Math.round(delta / 1000)}s earlier)` : '';
  console.log(`  Ch${i + 1} ${fmt(adj.startMs).padStart(7)} "${orig.title}"${deltaStr}`);
}
