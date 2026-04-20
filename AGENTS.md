# AI Coding Instructions — youtube-gemini-article

## Project Context
- **Runtime:** Cloudflare Workers (ES Modules, V8 isolates) — `nodejs_compat` flag enabled
- **Purpose:** Stream a Gemini-generated Chinese article from a YouTube video URL
- **Constraint:** Zero npm runtime dependencies — use only Web Standard APIs

## Module Layout
| File | Role |
|------|------|
| `src/index.js` | Router: `GET /` → HTML page, `GET /api/article?url=` → streaming pipeline |
| `src/services/youtube.js` | `extractVideoId(url)`, `fetchTranscript(videoId, env)` → `{lines, chapters}` (InnerTube primary, Supadata fallback) |
| `src/services/gemini.js` | `streamArticle({lines, chapters}, {apiKey, model})` → `ReadableStream<string>` of markdown |
| `src/templates/ui.js` | `renderPage()` → complete HTML/CSS/JS as a template literal string |
| `src/prompts/system.md` | Long-form Chinese system prompt, imported as text via the `wrangler.jsonc` Text rule |

## Technical Rules
1. **Secrets via `env`** — access `env.GEMINI_API_KEY` / `env.SUPADATA_API_KEY` / `env.GEMINI_MODEL`, never `process.env`
2. **Error before stream** — all validation and external API calls must complete *before* returning the streaming `Response`. Once a streaming response starts, HTTP status cannot change.
3. **Streaming pipeline** — Gemini SSE → `TextDecoderStream` → `extractGeminiText()` TransformStream → plain text string chunks → `TextEncoderStream` → `Response`
4. **Markdown output** — Gemini outputs Markdown; the frontend `md2html()` converts to HTML client-side. Never stream raw HTML fragments from the server.
5. **No external libraries** — use `fetch`, `RegExp`, `TransformStream`, `TextEncoderStream`, `TextDecoderStream` only
6. **Prompt as text import** — the system prompt lives in `src/prompts/system.md` and is imported as a string. The `rules` block in `wrangler.jsonc` registers `**/*.md` as Text. Don't inline large prompts into `.js` files.

## Gemini API
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key={KEY}`
- Model is configurable via `env.GEMINI_MODEL` (default `gemini-2.5-flash` from `wrangler.jsonc` `vars`)
- SSE line format: `data: {"candidates":[{"content":{"parts":[{"text":"..."}],"role":"model"}}]}`
- API key stored as a Worker secret: `npx wrangler secret put GEMINI_API_KEY`
- For local dev: store in `.dev.vars` as `GEMINI_API_KEY=your_key_here`
- Filter parts by `!p.thought` — Gemini may emit thinking tokens that should not stream to the client
- Watch `finishReason` — log a warning for any value other than `STOP` (e.g. `MAX_TOKENS`, `SAFETY`)

## YouTube Transcript & Chapters
- **Primary path (InnerTube):**
  1. Fetch `https://www.youtube.com/watch?v={id}` with browser-like `User-Agent` + `Accept-Language` headers
  2. Extract `INNERTUBE_API_KEY` from the page HTML
  3. Extract chapter list from `ytInitialData` → `playerOverlays.…multiMarkersPlayerBarRenderer.markersMap` (`DESCRIPTION_CHAPTERS` entry)
  4. POST `youtubei/v1/player` with `clientName: 'ANDROID'` (returns timedtext URLs that work server-side)
  5. Parse the timedtext XML — primary format is word-level `<p t="…"><s>word</s></p>`, fallback to `<text start="…">…</text>`
  6. Return `{lines: [{text, startMs}], chapters: [{title, startMs}]}`
- **Fallback (Supadata.ai):** triggered when InnerTube error message matches `/HTTP 429|blocking this IP|No subtitles found/` AND `env.SUPADATA_API_KEY` is set
  - Transcript: `GET https://api.supadata.ai/v1/youtube/transcript?videoId=…&text=false&lang=en` — must wait ~1.1s before the next call (free-tier burst limit)
  - Chapters (best-effort): `GET https://api.supadata.ai/v1/youtube/video?id=…` then parse "Timestamps:" lines from the description with `parseChaptersFromDescription`

## Chapter Manifest
- `buildChapterManifest()` in `src/services/gemini.js` prepends a hard structural directive to the user message when chapters exist, pinning `##` count and 1:1 mapping to YouTube chapters
- Reason: pure prompt prohibitions in `system.md` proved insufficient — the model still fused adjacent chapters under a single `##`
- Chapter-less videos skip the manifest and fall back to the prompt's "无章节标记时" branch (LLM picks `##` boundaries by natural topic shifts)

## Local Development
```bash
echo 'GEMINI_API_KEY=your_key_here' > .dev.vars
echo 'SUPADATA_API_KEY=your_key_here' >> .dev.vars   # optional
npm run dev      # http://localhost:8787
npm test         # vitest with @cloudflare/vitest-pool-workers
```

## Deployment
```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SUPADATA_API_KEY
npm run deploy
```
