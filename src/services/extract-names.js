// src/services/extract-names.js

/**
 * Extracts snippets of the transcript likely to contain host/guest names,
 * for use by the Names call. Scans for addressing / introduction patterns
 * and pulls ±2 lines of context around each hit. When no pattern matches,
 * falls back to the first 1500 chars + last 1500 chars of the joined
 * transcript (speakers commonly introduce themselves at the start and
 * thank each other at the end).
 *
 * Also prepends the chapter list — YouTube chapter titles sometimes
 * contain the guest's name ("Interview with X"), giving the LLM a
 * direct answer.
 *
 * @param {{text: string, startMs: number}[]} lines
 * @param {{title: string, startMs: number}[]} chapters
 * @returns {string}
 */
export function extractNameSnippets(lines, chapters) {
  const chapterBlock = chapters.length
    ? `【章节列表】\n${chapters.map((c, i) => `${i + 1}. ${c.title}`).join('\n')}\n\n`
    : '';

  const hits = findHits(lines);
  const snippetBlock = hits.length
    ? `【字幕片段】\n${renderSnippets(lines, hits)}`
    : `【字幕片段（无命中，取首尾兜底）】\n${renderFallback(lines)}`;

  return chapterBlock + snippetBlock;
}

// Regex list. Each pattern is applied independently per line.
const PATTERNS = [
  // English — addressing / greeting
  /\b(thanks|thank you)[\s,]+[A-Z][a-z]+/i,
  /\bwelcome\b[^.]{0,40}\b[A-Z][a-z]+/i,
  /\b(my|our)\s+guest\b[^.]{0,40}/i,
  /\bjoining (me|us)\b[^.]{0,40}/i,
  /\bi'?m here with\b[^.]{0,40}/i,
  /\b[A-Z][a-z]+[\s,]+(what do you think|your thoughts|how do you see)/,
  /\bover to you[\s,]+[A-Z][a-z]+/i,
  // Chinese
  /(谢谢|感谢|欢迎)\s*[\u4e00-\u9fa5A-Za-z]{2,}/,
  /我(今天)?(的)?(嘉宾|请到|请来)/,
  /[\u4e00-\u9fa5A-Za-z]{2,}[\s，]*(你怎么看|你觉得|你的看法)/,
];

function findHits(lines) {
  const hits = new Set();
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    if (PATTERNS.some(re => re.test(text))) hits.add(i);
  }
  return [...hits];
}

function renderSnippets(lines, hits) {
  // Expand each hit index to ±2 line range, then merge overlapping ranges.
  const ranges = hits
    .map(i => [Math.max(0, i - 2), Math.min(lines.length - 1, i + 2)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of ranges) {
    if (merged.length && s <= merged[merged.length - 1][1] + 1) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged
    .map(([s, e]) => lines.slice(s, e + 1).map(l => l.text).join(' '))
    .join('\n---\n');
}

function renderFallback(lines) {
  const full = lines.map(l => l.text).join(' ');
  if (full.length <= 3000) return full;
  return full.slice(0, 1500) + '\n---\n' + full.slice(-1500);
}
