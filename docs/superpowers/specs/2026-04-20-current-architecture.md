# Current Architecture: YouTube → AI Article Generator

**Date:** 2026-04-20
**Status:** Reflects the implementation as of commit `72b81a5`. Supersedes [`2026-04-16-youtube-gemini-article-design.md`](./2026-04-16-youtube-gemini-article-design.md), which documents the original v1 design.
**Stack:** Cloudflare Workers (ES Modules) · Gemini AI Studio API (configurable model, default `gemini-2.5-flash`) · Vanilla JS frontend

---

## What Changed Since v1

| Area | v1 (2026-04-16) | Current |
|------|------|---------|
| Model | Hard-coded `gemini-2.5-flash` | Configurable via `env.GEMINI_MODEL` (default `gemini-2.5-flash`) |
| Transcript fetch | Single regex on watch-page HTML | InnerTube `youtubei/v1/player` (ANDROID client); Supadata.ai fallback when IP-blocked |
| Transcript shape | Plain `string` | `{lines: [{text, startMs}], chapters: [{title, startMs}]}` |
| Chapter handling | None | Extracted from `ytInitialData`; `[CHAPTER:]` markers injected into transcript |
| Structural enforcement | Prose rules in system prompt only | Hard "chapter manifest" prepended to user message — pins `##` count and 1:1 mapping |
| System prompt | Inline string in `gemini.js` | `src/prompts/system.md`, imported via `wrangler.jsonc` Text rule |
| Output filtering | None | Skips Gemini "thought" parts; warns on non-`STOP` `finishReason` |

Driver for each: model config externalized for cost/quality tuning; InnerTube switch fixed Cloudflare IP getting blocked; chapter manifest fixed adjacent-chapter fusion that prose rules couldn't prevent.

---

## Pipeline

```
Browser
  ├── GET /                          → renderPage() (single-file HTML, no CDN)
  └── GET /api/article?url=<youtube>
        ┌─ extractVideoId(url) ──────────────────── 400 if invalid
        ├─ fetchTranscript(videoId, env) ────────── 502 if both paths fail
        │     ├─ InnerTube                     (primary)
        │     │     watch page → INNERTUBE_API_KEY + ytInitialData chapters
        │     │     POST youtubei/v1/player (ANDROID) → captionTracks
        │     │     fetch timedtext XML → parse <p t><s>…</s></p> (or <text start>)
        │     └─ Supadata.ai                   (fallback if 429 / IP-blocked / no captions)
        │           transcript endpoint → {text, offset} segments
        │           video endpoint → parse "Timestamps:" lines from description
        ├─ buildAnnotatedTranscript(lines, chapters)
        │     join lines; insert "\n\n[CHAPTER: title]\n" at each chapter boundary
        ├─ buildChapterManifest(chapters)
        │     prepend hard structural directive (chapter count + 1:1 mapping rules)
        ├─ streamArticle({lines, chapters}, {apiKey, model})
        │     POST gemini streamGenerateContent?alt=sse
        │     503 / 429 / non-2xx → 502 with mapped error message
        └─ res.body
              → TextDecoderStream
              → extractGeminiText()        (strip SSE envelope, drop thought parts)
              → TextEncoderStream
              → Response (text/plain; charset=UTF-8)
```

**Invariant:** all validation and external calls complete before the streaming `Response` is opened. Status code can't change after the first byte.

---

## Module Boundaries

| File | Responsibility |
|------|----------------|
| `src/index.js` | Routing, error→JSON mapping, stream encoding |
| `src/services/youtube.js` | Transcript + chapter sourcing across two providers; XML/JSON parsing |
| `src/services/gemini.js` | Annotated-transcript construction, manifest synthesis, Gemini SSE stream + filtering |
| `src/templates/ui.js` | Single-file HTML/CSS/JS — input form, status indicator, streaming `md2html` renderer |
| `src/prompts/system.md` | Chinese editorial system prompt (≈24KB) — bundled as text |

---

## Configuration Surface

| Name | Type | Default | Purpose |
|------|------|---------|---------|
| `GEMINI_API_KEY` | secret | — (required) | Gemini AI Studio key |
| `GEMINI_MODEL` | var | `gemini-2.5-flash` | Model id passed into the streamGenerateContent URL |
| `SUPADATA_API_KEY` | secret | — (optional) | Enables fallback path; without it, InnerTube failures surface as 502 |

`wrangler.jsonc` also registers `**/*.md` as a Text bundling rule (with `fallthrough: true`) so prompt files import as strings.

---

## Error Handling

| Failure | Response |
|---------|----------|
| Missing/invalid URL | 400 JSON `{error}` |
| Both transcript paths fail | 502 JSON `{error}` (InnerTube error message preserved) |
| Gemini 429 | 502 with quota-exhausted message |
| Gemini 503 | 502 with overload message |
| Other Gemini non-2xx | 502 with raw status + body |
| Mid-stream `finishReason ≠ STOP` | Warning logged; partial output still flushed (HTTP status already sent) |

---

## Out of Scope (unchanged from v1)

- Auth / rate limiting / per-user quotas
- Multi-language subtitle selection (defaults to `en`, falls back to first track)
- Caching of transcripts or generated articles
- TypeScript

---

## Known Constraints

- Supadata free tier rate-limits parallel calls — transcript and chapters fetches must be serialized with a ~1.1s gap.
- Description-derived chapters depend on creators using a "Timestamps:" block; no fallback when absent.
- Chapter manifest is best-effort: the model still occasionally drifts on long videos (>30 chapters); detection would require a post-stream parse, which is out of scope.
- Transcript hard-capped at 300,000 chars (~75k tokens) — well within Gemini 2.5 Flash's 1M context but may truncate very long lectures.
