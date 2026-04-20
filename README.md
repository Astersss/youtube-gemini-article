# youtube-gemini-article

Stream a Gemini-generated Chinese editorial article from any YouTube video URL — runs as a single Cloudflare Worker with zero npm runtime dependencies.

Paste a YouTube URL → the Worker pulls the captions (and chapter list, when available), feeds them to Gemini with a long structured prompt, and streams the resulting Markdown back to the browser as it's generated. The frontend renders it live with a streaming-safe `md2html` converter.

## Architecture

```
Browser
  ├── GET /                          → single-file HTML page (no CDN)
  └── GET /api/article?url=<youtube> → streaming pipeline:
        1. extractVideoId(url)
        2. fetchTranscript(videoId, env)         ← InnerTube; Supadata fallback
        3. buildAnnotatedTranscript + manifest   ← inject [CHAPTER:] markers
        4. POST Gemini streamGenerateContent (SSE)
        5. extractGeminiText() TransformStream   ← strip SSE envelope
        6. TextEncoderStream → Response
```

All validation and external API calls run **before** the streaming `Response` is returned — once a stream starts, HTTP status cannot change.

## Module Layout

| File | Role |
|------|------|
| `src/index.js` | Router: `GET /` → HTML, `GET /api/article?url=` → streaming pipeline |
| `src/services/youtube.js` | `extractVideoId(url)`, `fetchTranscript(videoId, env)` — InnerTube primary, Supadata fallback, chapter extraction |
| `src/services/gemini.js` | `streamArticle({lines, chapters}, {apiKey, model})` → `ReadableStream<string>` of markdown; builds the chapter-annotated transcript and the structural manifest |
| `src/templates/ui.js` | `renderPage()` → complete HTML/CSS/JS as a single template literal string |
| `src/prompts/system.md` | Long-form Chinese system prompt, bundled as text via `wrangler.jsonc` rule |

## Setup

Get a Gemini API key at [aistudio.google.com](https://aistudio.google.com) → "Get API key".

```bash
# 1. Local secrets — git-ignored, picked up by wrangler dev
echo 'GEMINI_API_KEY=your_key_here' > .dev.vars

# Optional: enables the Supadata.ai fallback when YouTube soft-blocks the egress IP
echo 'SUPADATA_API_KEY=your_supadata_key' >> .dev.vars

# 2. Start local dev server
npm run dev    # → http://localhost:8787

# 3. Run tests
npm test
```

## Configuration

| Name | Where | Purpose |
|------|-------|---------|
| `GEMINI_API_KEY` | secret (`wrangler secret put`) / `.dev.vars` | Gemini AI Studio key |
| `SUPADATA_API_KEY` | secret / `.dev.vars` (optional) | Transcript + chapter fallback when InnerTube is blocked |
| `GEMINI_MODEL` | `vars` in `wrangler.jsonc` | Model id (default `gemini-2.5-flash`) |

## Deployment

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SUPADATA_API_KEY    # optional
npm run deploy
```

## Implementation Notes

- **Transcript fetch** — InnerTube is tried first (ANDROID client returns timedtext URLs that work server-side). On HTTP 429 / "blocking this IP" / "no subtitles" errors, falls back to [supadata.ai](https://supadata.ai) if `SUPADATA_API_KEY` is set. Chapter list comes from `ytInitialData` (InnerTube) or is parsed best-effort from the description's "Timestamps:" block (Supadata).
- **Chapter manifest** — when chapters are present, `buildChapterManifest()` prepends a hard structural directive to the user message that pins the `##` count, order, and 1:1 mapping. Pure prompt prohibitions weren't enough; the model would still fuse adjacent chapters.
- **Markdown over HTML** — Gemini outputs Markdown. The frontend `md2html()` converts to HTML client-side. The server never streams raw HTML fragments.
- **Zero runtime dependencies** — only Web Standard APIs (`fetch`, `RegExp`, `TransformStream`, `TextEncoderStream`, `TextDecoderStream`).

## Stack

Cloudflare Workers (ES Modules, V8) · Gemini AI Studio REST API (SSE streaming) · Vanilla JS frontend · Vitest with `@cloudflare/vitest-pool-workers`.
