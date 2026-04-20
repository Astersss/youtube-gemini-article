# AI Coding Instructions — youtube-gemini-article

## Project Context
- **Runtime:** Cloudflare Workers (ES Modules, V8 isolates) — `nodejs_compat` flag enabled
- **Purpose:** Stream a Gemini-generated Chinese article from a YouTube video URL
- **Constraint:** Zero npm runtime dependencies — use only Web Standard APIs

## Module Layout
| File | Role |
|------|------|
| `src/index.js` | Router: `GET /` → HTML page, `GET /api/article?url=` → streaming pipeline |
| `src/services/youtube.js` | `extractVideoId(url)`, `fetchTranscript(videoId)` |
| `src/services/gemini.js` | `streamArticle(transcript, config)` — calls Gemini with `responseSchema`, pipes SSE → SectionStreamer → `ReadableStream<string>` of Markdown |
| `src/services/schema.js` | `ARTICLE_SCHEMA` — JSON schema passed to Gemini's `responseSchema` |
| `src/services/renderer.js` | `renderPreamble` / `renderChapterHeading` / `renderSection` / `renderArticle` — pure JSON→Markdown fragments |
| `src/services/stream-render.js` | `tryLenientParse` + `SectionStreamer` — consume JSON text chunks and emit Markdown fragments for each frozen piece |
| `src/templates/ui.js` | `renderPage()` → complete HTML/CSS/JS as a template literal string |

## Technical Rules
1. **Secrets via `env`** — access `env.GEMINI_API_KEY`, never `process.env`
2. **Error before stream** — all validation and external API calls must complete *before* returning the streaming `Response`. Once a streaming response starts, HTTP status cannot change.
3. **Structured-output streaming pipeline** — Gemini returns JSON shaped by `ARTICLE_SCHEMA` via SSE → `sseTextParts()` TransformStream extracts each `parts[].text` fragment → `SectionStreamer` runs a lenient partial-JSON parse after every fragment and emits Markdown (preamble / chapter heading / full section) the moment each piece is "frozen" (next piece has begun) → `TextEncoderStream` → `Response`. Streaming granularity is per-section, not per-token.
4. **Markdown is derived, not modeled** — the LLM never sees or emits Markdown syntax; it fills schema fields only. `src/services/renderer.js` owns all `#` / `##` / `###` / `**Name:**` conventions. Keep the frontend `md2html()` unchanged.
5. **No external libraries** — use `fetch`, `RegExp`, `TransformStream`, `TextEncoderStream`, `TextDecoderStream` only

## Gemini API
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key={KEY}`
- SSE line format: `data: {"candidates":[{"content":{"parts":[{"text":"..."}],"role":"model"}}]}`
- API key stored as a Worker secret: `npx wrangler secret put GEMINI_API_KEY`
- For local dev: store in `.dev.vars` as `GEMINI_API_KEY=your_key_here`

## YouTube Subtitle Extraction
- Fetch `https://www.youtube.com/watch?v={id}` with browser-like `User-Agent` + `Accept-Language` headers
- Regex `/"captionTracks":\[.*?"baseUrl":"([^"]+)"/` extracts the first caption track URL
- Unescape `\\u0026` → `&` before fetching the URL
- Parse `<text>` elements from the timedtext XML, decode HTML entities, join with spaces

## Local Development
```bash
# 1. Create .dev.vars at project root (git-ignored by Wrangler)
echo 'GEMINI_API_KEY=your_key_here' > .dev.vars

# 2. Start local dev server
npx wrangler dev

# 3. Open http://localhost:8787
```

## Deployment
```bash
npx wrangler secret put GEMINI_API_KEY   # paste key when prompted
npm run deploy
```
