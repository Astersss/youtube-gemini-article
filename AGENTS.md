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
| `src/services/gemini.js` | `streamArticle(transcript, apiKey)` → `ReadableStream<string>` of markdown |
| `src/templates/ui.js` | `renderPage()` → complete HTML/CSS/JS as a template literal string |

## Technical Rules
1. **Secrets via `env`** — access `env.GEMINI_API_KEY`, never `process.env`
2. **Error before stream** — all validation and external API calls must complete *before* returning the streaming `Response`. Once a streaming response starts, HTTP status cannot change.
3. **Streaming pipeline** — Gemini SSE → `extractGeminiText()` TransformStream → plain text string chunks → `TextEncoderStream` → `Response`
4. **Markdown output** — Gemini outputs Markdown; the frontend `md2html()` converts to HTML client-side. Never stream raw HTML fragments from the server.
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
