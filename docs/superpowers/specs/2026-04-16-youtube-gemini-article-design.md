# Design: YouTube Subtitle → AI Article Generator

**Date:** 2026-04-16  
**Stack:** Cloudflare Workers (ES Modules) · Gemini AI Studio free API · Vanilla JS frontend

---

## Overview

A single Cloudflare Worker that accepts a YouTube URL, extracts its subtitles, streams them through Gemini to produce a formatted Chinese editorial article, and renders it live in the browser.

---

## Architecture

```
Browser
  ├── GET /          → HTML page (single-file, no CDN dependencies)
  └── GET /api/article?url=<youtube-url>
        → Worker pipeline:
            1. Extract video ID from URL
            2. Fetch YouTube watch page → regex captionTracks baseUrl
            3. Fetch timedtext XML → parse to plain transcript text
            4. POST to Gemini streamGenerateContent?alt=sse
            5. TransformStream: strip SSE wrapper → emit raw markdown text
            6. TextEncoderStream → stream to browser
```

---

## Module Layout

| File | Role |
|------|------|
| `src/index.js` | Router: `GET /` → HTML, `GET /api/article` → streaming pipeline |
| `src/services/youtube.js` | `extractVideoId(url)`, `fetchTranscript(videoId)` |
| `src/services/gemini.js` | `streamArticle(transcript, apiKey)` → ReadableStream of markdown text |
| `src/templates/ui.js` | `renderPage()` → full HTML/CSS/JS as template literal |

---

## Data Flow Detail

### YouTube Subtitle Extraction
1. `GET https://www.youtube.com/watch?v={id}` with browser-like headers (`User-Agent`, `Accept-Language`)
2. Regex `/"captionTracks":\[.*?"baseUrl":"([^"]+)"/` extracts first caption track URL
3. Unescape `\\u0026` → `&` in the URL
4. Fetch the XML; parse `<text>` elements, decode HTML entities, join into plain text

### Gemini Streaming
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key={KEY}`
- System prompt: Senior tech editor persona. Output Markdown only (`#`, `##`, `**Speaker:**` format). No preamble or code fences.
- `extractGeminiText()` TransformStream: buffers lines, finds `data: {...}` SSE events, emits `candidates[0].content.parts[0].text`
- Pipeline: `res.body → TextDecoderStream → extractGeminiText → TextEncoderStream → Response`

### Frontend Streaming Render
- `fetch('/api/article?url=...')` → `response.body.getReader()`
- Each chunk appended to `rawText` buffer
- On each chunk: `article.innerHTML = md2html(rawText) + cursorSpan`
- On done: final render without cursor
- `md2html()`: inline converter (~30 lines) handling `#`, `##`, `###`, `**bold**`, `*italic*`, paragraphs — with HTML escaping for XSS safety

---

## UI Design

- **Style:** Clean editorial, no CDN dependencies
- **Fonts:** Sans-serif UI chrome; serif (`Georgia`) for article body
- **Colors:** Near-black ink `#1a1a1a`, muted grey `#6b6b6b`, accent red `#c0392b` for speaker names
- **States:** Spinner with status text ("正在提取字幕..." → "AI 正在生成文章..."), blinking cursor during stream, error card on failure
- **Scroll:** `scrollIntoView({ behavior: 'smooth' })` on each chunk to follow generation

---

## Error Handling

- Invalid/missing URL → 400 before any streaming starts
- No captions found → 500 with clear message before streaming starts
- Gemini API error → 500 with message before streaming starts
- All errors surface as `{ error: string }` JSON (status ≠ 200), rendered as a styled error card in the UI

**Key constraint:** All validation and API checks happen *before* the streaming `Response` is opened — once streaming starts, HTTP status cannot change.

---

## Configuration

- `GEMINI_API_KEY` — stored as Cloudflare Worker secret (`npx wrangler secret put GEMINI_API_KEY`)
- No other secrets or environment variables required
- `nodejs_compat` flag already enabled in `wrangler.jsonc`

---

## Out of Scope

- Authentication / rate limiting (interview project)
- Multi-language subtitle selection (defaults to first available track)
- Caching of transcripts or articles
- TypeScript (vanilla JS per design decision)
