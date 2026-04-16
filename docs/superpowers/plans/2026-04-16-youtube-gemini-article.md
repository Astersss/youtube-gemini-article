# YouTube Subtitle → AI Article Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Worker that takes a YouTube URL, extracts subtitles, streams them through Gemini AI Studio to produce a formatted Chinese dialogue article, and renders it live in the browser.

**Architecture:** Single Worker with four modules — router (`index.js`), YouTube transcript extractor (`services/youtube.js`), Gemini streaming client (`services/gemini.js`), and HTML template (`templates/ui.js`). All validation happens before streaming begins; the Gemini SSE stream is piped directly to the browser with a thin TransformStream that strips the SSE envelope.

**Tech Stack:** Cloudflare Workers (ES Modules, V8 runtime) · Gemini AI Studio REST API (`gemini-1.5-flash`, SSE streaming) · Vanilla JS frontend (no CDN, no npm runtime deps)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/index.js` | Router: `GET /` → HTML page, `GET /api/article?url=` → streaming pipeline |
| Create | `src/services/youtube.js` | `extractVideoId(url)`, `fetchTranscript(videoId)` |
| Create | `src/services/gemini.js` | `streamArticle(transcript, apiKey)` → ReadableStream\<string\> of markdown |
| Create | `src/templates/ui.js` | `renderPage()` → complete HTML/CSS/JS as template literal string |
| Modify | `wrangler.jsonc` | Add `[vars]` comment block noting `GEMINI_API_KEY` secret requirement |

---

## Task 1: YouTube Service — extract video ID and fetch transcript

**Files:**
- Create: `src/services/youtube.js`

- [ ] **Step 1.1: Create the file with `extractVideoId`**

```js
// src/services/youtube.js

/**
 * Extracts the 11-character video ID from any standard YouTube URL.
 * Handles: watch?v=, youtu.be/, embed/
 */
export function extractVideoId(url) {
  const m = url.match(/(?:[?&]v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
```

- [ ] **Step 1.2: Add `fetchTranscript` — fetch the watch page and extract caption URL**

Append to `src/services/youtube.js`:

```js
/**
 * Fetches the plain-text transcript for a YouTube video.
 * 1. Fetches the watch page with browser-like headers to avoid bot detection.
 * 2. Regex-extracts the first captionTracks baseUrl from ytInitialPlayerResponse.
 * 3. Fetches the timedtext XML and parses it to a single plain-text string.
 *
 * @param {string} videoId
 * @returns {Promise<string>} Full transcript as a space-joined plain text
 * @throws {Error} If the page fetch fails, captions are absent, or XML fetch fails
 */
export async function fetchTranscript(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!pageRes.ok) {
    throw new Error(`YouTube fetch failed with status ${pageRes.status}`);
  }

  const html = await pageRes.text();

  // Pull the first captionTracks entry's baseUrl out of the embedded JSON blob
  const m = html.match(/"captionTracks":\[.*?"baseUrl":"([^"]+)"/);
  if (!m) {
    throw new Error('No subtitles found. The video may have captions disabled.');
  }

  // YouTube escapes & as \u0026 in the JSON — unescape it
  const captionUrl = m[1].replace(/\\u0026/g, '&');

  const xmlRes = await fetch(captionUrl);
  if (!xmlRes.ok) {
    throw new Error(`Transcript fetch failed with status ${xmlRes.status}`);
  }

  const xml = await xmlRes.text();
  return parseTimedText(xml);
}

/**
 * Parses YouTube timedtext XML into plain text.
 * Each <text> element may contain HTML entities; we decode the common ones.
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
```

- [ ] **Step 1.3: Commit**

```bash
git add src/services/youtube.js
git commit -m "feat: add YouTube transcript extractor"
```

---

## Task 2: Gemini Service — stream markdown article

**Files:**
- Create: `src/services/gemini.js`

- [ ] **Step 2.1: Create the file with the system prompt and `streamArticle`**

```js
// src/services/gemini.js

const API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=';

const SYSTEM_PROMPT = `你是一位资深的科技媒体编辑，擅长将英文访谈视频字幕整理成高质量的中文对话体文章。

请将以下原始字幕整理成一篇结构清晰、语言流畅的中文文章，严格遵循以下规范：

结构要求：
- 第一行：提炼视频核心主题作为大标题（# 标题），风格类似「对话X：Y之问」
- 按对话逻辑拆分 3-6 个小节，每节含吸引人的小标题（## 小节标题）

内容要求：
- 以对话体呈现，使用 说话人姓名: 格式标注发言人（如 Mark: Jen:）
- 自动从字幕中识别说话人姓名
- 将英文翻译为中文，去除口语化语气词（呃、啊、就是），进行书面化润色
- 保留原意，确保关键观点完整传达，内容要详尽不要过度精简

格式要求：
- 仅输出 Markdown 正文，不添加任何说明、前言、代码块标记或总结
- 不要在开头或结尾加任何解释性文字

字幕内容：
`;

/**
 * Calls Gemini streamGenerateContent and returns a ReadableStream of plain markdown text.
 * The SSE envelope (data: {...} lines) is stripped by extractGeminiText().
 *
 * @param {string} transcript - Plain-text transcript from YouTube
 * @param {string} apiKey     - Gemini AI Studio API key
 * @returns {Promise<ReadableStream<string>>}
 * @throws {Error} If the Gemini API returns a non-2xx status
 */
export async function streamArticle(transcript, apiKey) {
  const res = await fetch(API_URL + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: SYSTEM_PROMPT + transcript }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${body}`);
  }

  // Pipeline: raw bytes → decoded text → SSE text stripped → plain markdown text
  return res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(extractGeminiText());
}

/**
 * TransformStream that parses Gemini SSE lines and emits only the text content.
 * Input:  string chunks (potentially spanning multiple SSE lines)
 * Output: string chunks of markdown text
 */
function extractGeminiText() {
  let buffer = '';
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // hold incomplete last line for next chunk

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') continue;
        try {
          const data = JSON.parse(json);
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) controller.enqueue(text);
        } catch {
          // skip malformed SSE chunks
        }
      }
    },
    flush(controller) {
      // Process anything left in the buffer after stream ends
      if (buffer.startsWith('data: ')) {
        try {
          const data = JSON.parse(buffer.slice(6));
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) controller.enqueue(text);
        } catch { /* ignore */ }
      }
    },
  });
}
```

- [ ] **Step 2.2: Commit**

```bash
git add src/services/gemini.js
git commit -m "feat: add Gemini SSE streaming client"
```

---

## Task 3: UI Template — single-file editorial HTML page

**Files:**
- Create: `src/templates/ui.js`

- [ ] **Step 3.1: Create the template**

The page must have no external dependencies. It includes all CSS and JS inline. The `md2html` function is a minimal inline converter (no library) — it handles `#`, `##`, `###`, `**bold**`, `*italic*`, and paragraphs with XSS-safe HTML escaping.

```js
// src/templates/ui.js

/**
 * Returns the complete single-page HTML application as a string.
 * No external CDN dependencies — all CSS and JS is inlined.
 */
export function renderPage() {
  return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI 编辑室 · 视频转文章</title>
  <style>
    :root {
      --ink: #1a1a1a;
      --muted: #6b6b6b;
      --accent: #c0392b;
      --bg: #fafaf8;
      --surface: #ffffff;
      --border: #e8e8e4;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100vh;
    }

    /* ── Header ── */
    header {
      border-bottom: 2px solid var(--ink);
      padding: 1.25rem 0;
      margin-bottom: 3rem;
    }
    .header-inner {
      max-width: 760px;
      margin: 0 auto;
      padding: 0 1.5rem;
      display: flex;
      align-items: baseline;
      gap: 1rem;
    }
    .logo { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    .tagline { font-size: 0.875rem; color: var(--muted); }

    /* ── Container ── */
    .container { max-width: 760px; margin: 0 auto; padding: 0 1.5rem 5rem; }

    /* ── Input card ── */
    .input-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 2.5rem;
    }
    .input-label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; }
    .input-row { display: flex; gap: 0.5rem; }
    .url-input {
      flex: 1;
      padding: 0.625rem 0.875rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.9375rem;
      outline: none;
      transition: border-color 0.15s;
      font-family: inherit;
    }
    .url-input:focus { border-color: var(--ink); }
    .submit-btn {
      padding: 0.625rem 1.25rem;
      background: var(--ink);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 0.9375rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
      transition: opacity 0.15s;
    }
    .submit-btn:hover { opacity: 0.75; }
    .submit-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* ── Status ── */
    .status { display: none; align-items: center; gap: 0.5rem; margin-top: 0.875rem; font-size: 0.875rem; color: var(--muted); }
    .status.visible { display: flex; }
    .spinner {
      width: 14px; height: 14px; flex-shrink: 0;
      border: 2px solid var(--border);
      border-top-color: var(--ink);
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Article typography ── */
    #article {
      font-family: Georgia, 'Songti SC', 'SimSun', 'STSong', serif;
      font-size: 1.0625rem;
      line-height: 1.85;
      color: var(--ink);
    }
    #article h1 {
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      font-size: 1.875rem;
      font-weight: 700;
      line-height: 1.25;
      letter-spacing: -0.02em;
      margin-bottom: 0.375rem;
    }
    #article h2 {
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      font-size: 1.125rem;
      font-weight: 700;
      margin-top: 2.5rem;
      margin-bottom: 0.75rem;
      padding-bottom: 0.375rem;
      border-bottom: 1px solid var(--border);
    }
    #article h3 {
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      font-size: 1rem;
      font-weight: 600;
      margin-top: 1.5rem;
      margin-bottom: 0.5rem;
    }
    #article p { margin-bottom: 1rem; }
    #article strong { color: var(--accent); font-weight: 700; }
    #article em { font-style: italic; }

    /* ── Blinking cursor while streaming ── */
    .cursor {
      display: inline-block;
      width: 2px; height: 1.1em;
      background: var(--ink);
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }

    /* ── Error state ── */
    .error {
      background: #fff5f5;
      border: 1px solid #fecaca;
      border-radius: 6px;
      padding: 1rem 1.25rem;
      color: #b91c1c;
      font-size: 0.9375rem;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <span class="logo">AI 编辑室</span>
      <span class="tagline">YouTube 字幕 · 智能转文章</span>
    </div>
  </header>
  <div class="container">
    <div class="input-card">
      <label class="input-label" for="urlInput">输入 YouTube 视频链接</label>
      <div class="input-row">
        <input class="url-input" id="urlInput" type="url"
          placeholder="https://www.youtube.com/watch?v=..." />
        <button class="submit-btn" id="submitBtn">生成文章</button>
      </div>
      <div class="status" id="status">
        <div class="spinner"></div>
        <span id="statusText">处理中…</span>
      </div>
    </div>
    <div id="article"></div>
  </div>

  <script>
    const urlInput  = document.getElementById('urlInput');
    const submitBtn = document.getElementById('submitBtn');
    const status    = document.getElementById('status');
    const statusText= document.getElementById('statusText');
    const article   = document.getElementById('article');

    submitBtn.addEventListener('click', generate);
    urlInput.addEventListener('keydown', e => e.key === 'Enter' && generate());

    async function generate() {
      const url = urlInput.value.trim();
      if (!url) return;

      setLoading(true, '正在提取字幕…');
      article.innerHTML = '';

      try {
        const res = await fetch('/api/article?url=' + encodeURIComponent(url));

        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(error);
        }

        setLoading(true, 'AI 正在生成文章…');

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          article.innerHTML = md2html(raw) + '<span class="cursor"></span>';
          article.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        article.innerHTML = md2html(raw);
      } catch (err) {
        article.innerHTML = '<div class="error">' + escHtml(err.message) + '</div>';
      } finally {
        setLoading(false);
      }
    }

    function setLoading(on, text = '') {
      submitBtn.disabled = on;
      status.classList.toggle('visible', on);
      if (text) statusText.textContent = text;
    }

    /* ── Minimal streaming-safe Markdown → HTML ── */
    function md2html(md) {
      const out = [];
      let para  = [];

      const flushPara = () => {
        if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; }
      };

      for (const raw of md.split('\\n')) {
        const line = raw.trim();
        if (!line)               { flushPara(); continue; }
        if (line.startsWith('# '))   { flushPara(); out.push('<h1>' + inl(line.slice(2))  + '</h1>'); continue; }
        if (line.startsWith('## '))  { flushPara(); out.push('<h2>' + inl(line.slice(3))  + '</h2>'); continue; }
        if (line.startsWith('### ')) { flushPara(); out.push('<h3>' + inl(line.slice(4))  + '</h3>'); continue; }
        para.push(inl(line));
      }
      flushPara();
      return out.join('\\n');
    }

    /* Inline markdown: escape HTML first, then apply bold/italic */
    function inl(t) {
      return escHtml(t)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g,     '<em>$1</em>');
    }

    function escHtml(t) {
      return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
  </script>
</body>
</html>`;
}
```

- [ ] **Step 3.2: Commit**

```bash
git add src/templates/ui.js
git commit -m "feat: add editorial HTML/CSS/JS template"
```

---

## Task 4: Router — wire everything together in `index.js`

**Files:**
- Modify: `src/index.js`

- [ ] **Step 4.1: Replace the stub with the full router**

```js
// src/index.js
import { extractVideoId, fetchTranscript } from './services/youtube.js';
import { streamArticle }                   from './services/gemini.js';
import { renderPage }                      from './templates/ui.js';

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (pathname === '/')            return serveUI();
    if (pathname === '/api/article') return handleArticle(searchParams, env);

    return new Response('Not Found', { status: 404 });
  },
};

function serveUI() {
  return new Response(renderPage(), {
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

async function handleArticle(searchParams, env) {
  const youtubeUrl = searchParams.get('url');
  if (!youtubeUrl) {
    return jsonError('Missing ?url= parameter', 400);
  }

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    return jsonError('Invalid YouTube URL', 400);
  }

  let transcript;
  try {
    transcript = await fetchTranscript(videoId);
  } catch (err) {
    return jsonError(err.message, 502);
  }

  let textStream;
  try {
    textStream = await streamArticle(transcript, env.GEMINI_API_KEY);
  } catch (err) {
    return jsonError(err.message, 502);
  }

  // Stream plain markdown text to the browser; encode string chunks to bytes
  return new Response(textStream.pipeThrough(new TextEncoderStream()), {
    headers: {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 4.2: Commit**

```bash
git add src/index.js
git commit -m "feat: add router and wire streaming pipeline"
```

---

## Task 5: Update `AGENTS.md` with project-specific rules

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 5.1: Replace the generic Cloudflare docs AGENTS.md with project rules**

Overwrite `AGENTS.md` entirely:

```markdown
# AI Coding Instructions — youtube-gemini-article

## Project Context
- **Runtime:** Cloudflare Workers (ES Modules, V8 isolates) — no Node.js built-ins (`fs`, `path`)
- **Purpose:** Stream a Gemini-generated Chinese article from a YouTube video URL
- **Constraint:** Zero npm runtime dependencies — use only Web Standard APIs

## Module Layout
| File | Role |
|------|------|
| `src/index.js` | Router: `GET /` → HTML, `GET /api/article?url=` → streaming pipeline |
| `src/services/youtube.js` | `extractVideoId(url)`, `fetchTranscript(videoId)` |
| `src/services/gemini.js` | `streamArticle(transcript, apiKey)` → ReadableStream\<string\> of markdown |
| `src/templates/ui.js` | `renderPage()` → complete HTML/CSS/JS as a template literal |

## Technical Rules
1. **Secrets via `env`** — access `env.GEMINI_API_KEY`, never `process.env`
2. **Error before stream** — all validation and external API calls must complete successfully *before* returning the streaming `Response`. Once a streaming response starts, HTTP status cannot change.
3. **Streaming pipeline** — Gemini SSE → `extractGeminiText()` TransformStream → plain text → `TextEncoderStream` → `Response`
4. **Markdown output** — Gemini outputs Markdown; the frontend `md2html()` converts to HTML client-side. Never stream raw HTML fragments.
5. **No external libraries** — use `fetch`, `RegExp`, `TransformStream`, `TextEncoderStream`, `TextDecoderStream`

## Gemini API
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key={KEY}`
- SSE line format: `data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}`
- API key is stored as a Worker secret: `npx wrangler secret put GEMINI_API_KEY`

## YouTube Subtitle Extraction
- Fetch `https://www.youtube.com/watch?v={id}` with browser-like `User-Agent` + `Accept-Language` headers
- Regex `/"captionTracks":\[.*?"baseUrl":"([^"]+)"/` finds the first caption track URL
- Unescape `\\u0026` → `&` before fetching the URL
- Parse `<text>` elements from the XML, decode HTML entities, join with spaces
```

- [ ] **Step 5.2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md with project-specific AI coding rules"
```

---

## Task 6: Local smoke test and deploy

**Files:** none (run commands only)

- [ ] **Step 6.1: Create the local `.dev.vars` file for the API key**

Create a file named `.dev.vars` at the project root (already git-ignored by Wrangler):

```
GEMINI_API_KEY=your_actual_key_here
```

Get the key from [https://aistudio.google.com](https://aistudio.google.com) → "Get API key".

- [ ] **Step 6.2: Start local dev server**

```bash
npx wrangler dev
```

Expected: server starts at `http://localhost:8787`

- [ ] **Step 6.3: Smoke test in browser**

Open `http://localhost:8787` — should see the "AI 编辑室" UI.

Paste `https://www.youtube.com/watch?v=xRh2sVcNXQ8` → click "生成文章".

Expected:
1. Status shows "正在提取字幕…" then "AI 正在生成文章…"
2. Article streams in live, line by line
3. Final article has `h1` title, `h2` section headers, speaker names in red (`var(--accent)`)

- [ ] **Step 6.4: Set the production secret and deploy**

```bash
npx wrangler secret put GEMINI_API_KEY
# paste key when prompted

npm run deploy
```

Expected output includes a live URL like `https://youtube-gemini-article.<your-subdomain>.workers.dev`

- [ ] **Step 6.5: Final commit**

```bash
git add .dev.vars   # only if you want to note its existence; it's git-ignored
git commit --allow-empty -m "chore: deploy to Cloudflare Workers"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** YouTube extraction ✓ · Gemini streaming ✓ · Frontend live render ✓ · Error handling (before stream) ✓ · Chinese output ✓ · No external deps ✓
- [x] **No placeholders:** All steps include complete, runnable code
- [x] **Type consistency:** `extractVideoId` / `fetchTranscript` used in Task 1 and Task 4; `streamArticle` used in Task 2 and Task 4; `renderPage` used in Task 3 and Task 4 — all match
- [x] **YAGNI:** No auth, no caching, no multi-language selection — out of scope per spec
