# Structured JSON Output with Section-Level Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace prose-prompt-only Markdown generation with a Gemini `responseSchema`-constrained JSON output + a server-side incremental Markdown renderer, so that (a) required fields like every section's `question` are **structurally impossible to omit** and (b) output still streams to the client progressively ("生成一点输出一点") at section granularity.

**Architecture:** Gemini is called with `responseMimeType: "application/json"` + `responseSchema`. The Worker reads the Gemini SSE stream, accumulates the JSON text incrementally, and after each chunk runs a **lenient partial-JSON parse**. Whenever a new *frozen* piece appears (article title preamble, chapter title, or fully-complete section), the renderer emits the corresponding Markdown fragment downstream. A piece is "frozen" only when a later piece has begun, guaranteeing the earlier one will not change. The HTTP response stays `text/plain` Markdown — the existing frontend works unchanged and sees the same word-by-word-ish experience as before, just pacing at section-not-token granularity.

**Tech Stack:** Cloudflare Workers (ES modules, Web Standard APIs only — no new npm deps), Gemini 2.5 Flash/Pro with structured output, Vitest with `@cloudflare/vitest-pool-workers`.

**Scope notes:**
- The existing `test/index.spec.js` is a stale Cloudflare Worker template stub ("Hello World" tests that don't match the current worker) and will be deleted as part of this plan.
- Character-level streaming inside a section's `question` or `answer_paragraphs` is **not** implemented — section-level streaming is the target. Sections typically arrive within 1-3s of each other, which preserves the "popping in" feel of the demo without the complexity of mid-string partial parsing.

---

## File Structure

| File | Role | Change |
|---|---|---|
| `src/services/schema.js` | JSON Schema for `responseSchema` | **Create** |
| `src/services/renderer.js` | Pure `renderArticle`, `renderSection`, `renderPreamble`, `renderChapterHeading` | **Create** |
| `src/services/stream-render.js` | `SectionStreamer` class: consumes SSE JSON text chunks, emits Markdown fragments for each frozen piece | **Create** |
| `src/services/gemini.js` | Gemini call + streaming wiring | **Rewrite** — set responseSchema, pipe SSE → SectionStreamer → Markdown stream |
| `src/prompts/system.md` | System instruction for Gemini | **Rewrite** — drop all Markdown-format rules; keep editorial-judgment rules |
| `src/index.js` | Worker router | No change (still pipes a text stream out) |
| `src/templates/ui.js` | Frontend | No change |
| `test/schema.spec.js` | Assertions about schema shape | **Create** |
| `test/renderer.spec.js` | Unit tests for pure renderer fragments | **Create** |
| `test/stream-render.spec.js` | Unit tests for `SectionStreamer` (including partial/malformed inputs) | **Create** |
| `test/gemini.spec.js` | Integration test with mocked Gemini SSE (multi-chunk) | **Create** |
| `test/index.spec.js` | Stale stub | **Delete** |
| `AGENTS.md` | Project guidance | **Update** rule 3, rule 4, Module Layout |

---

## Task 1: Define the JSON Schema

**Files:**
- Create: `src/services/schema.js`
- Test: `test/schema.spec.js`

- [ ] **Step 1: Write the failing test**

```js
// test/schema.spec.js
import { describe, it, expect } from 'vitest';
import { ARTICLE_SCHEMA } from '../src/services/schema.js';

describe('ARTICLE_SCHEMA', () => {
  it('is a JSON-schema-shaped object with required top-level fields', () => {
    expect(ARTICLE_SCHEMA.type).toBe('object');
    expect(ARTICLE_SCHEMA.required).toEqual(
      expect.arrayContaining(['article_title', 'host_name', 'guest_name', 'chapters'])
    );
  });

  it('requires every section to carry title, question, and answer_paragraphs', () => {
    const sectionSchema =
      ARTICLE_SCHEMA.properties.chapters.items.properties.sections.items;
    expect(sectionSchema.type).toBe('object');
    expect(sectionSchema.required).toEqual(
      expect.arrayContaining(['title', 'question', 'answer_paragraphs'])
    );
    expect(sectionSchema.properties.answer_paragraphs.type).toBe('array');
    expect(sectionSchema.properties.answer_paragraphs.items.type).toBe('string');
  });

  it('requires every chapter to carry title and sections', () => {
    const chapterSchema = ARTICLE_SCHEMA.properties.chapters.items;
    expect(chapterSchema.required).toEqual(
      expect.arrayContaining(['title', 'sections'])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/schema.spec.js`
Expected: FAIL with "Cannot find module '../src/services/schema.js'".

- [ ] **Step 3: Write the schema**

```js
// src/services/schema.js

/**
 * JSON Schema passed to Gemini's `generationConfig.responseSchema`. Having
 * `question`, `answer_paragraphs`, `title` as schema-required fields means the
 * model cannot emit a section that lacks them — replacing the old
 * `buildChapterManifest` Rule B prose prohibitions that the model routinely
 * violated by splitting a continuous answer into multiple question-less `###`.
 *
 * Shape:
 *   {
 *     article_title:  string,           // → final `# ` line
 *     host_name:      string,           // e.g. "Jen" / "主持人"; may be "" for monologue
 *     guest_name:     string,           // e.g. "Mark" / speaker name
 *     chapters: [                       // each element → one `##`
 *       {
 *         title: string,
 *         sections: [                   // each element → one `###` + one Q&A
 *           {
 *             title:              string,
 *             question:           string,   // required → model cannot omit
 *             answer_paragraphs:  string[]  // 1..N paragraphs; first is labelled, rest bare
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Gemini's `responseSchema` accepts an OpenAPI-3 subset: type, properties,
 * required, items, enum, format, nullable. Keep the schema inside that subset.
 */
export const ARTICLE_SCHEMA = {
  type: 'object',
  properties: {
    article_title: { type: 'string' },
    host_name:     { type: 'string' },
    guest_name:    { type: 'string' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title:    { type: 'string' },
                question: { type: 'string' },
                answer_paragraphs: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['title', 'question', 'answer_paragraphs'],
            },
          },
        },
        required: ['title', 'sections'],
      },
    },
  },
  required: ['article_title', 'host_name', 'guest_name', 'chapters'],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/schema.spec.js`
Expected: PASS (3 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/schema.js test/schema.spec.js
git commit -m "feat: add responseSchema for structured Gemini output"
```

---

## Task 2: Build pure Markdown-fragment renderers

**Files:**
- Create: `src/services/renderer.js`
- Test: `test/renderer.spec.js`

**Why split into fragments instead of one `renderArticle`?** Because the streaming path (Task 3) needs to emit pieces incrementally. `renderPreamble`, `renderChapterHeading`, and `renderSection` each produce a self-contained Markdown block. `renderArticle` is the full-document convenience wrapper used in tests and as a fallback.

- [ ] **Step 1: Write the failing tests**

```js
// test/renderer.spec.js
import { describe, it, expect } from 'vitest';
import {
  renderPreamble,
  renderChapterHeading,
  renderSection,
  renderArticle,
} from '../src/services/renderer.js';

describe('renderPreamble', () => {
  it('emits the # line followed by a blank line', () => {
    const out = renderPreamble({ article_title: '对话Mark：AI革命' });
    expect(out).toBe('# 对话Mark：AI革命\n\n');
  });
});

describe('renderChapterHeading', () => {
  it('emits the ## line followed by a blank line', () => {
    expect(renderChapterHeading({ title: '智能经济' })).toBe('## 智能经济\n\n');
  });
});

describe('renderSection', () => {
  const ctx = { host_name: 'Jen', guest_name: 'Mark' };

  it('labels the question with host and first paragraph with guest', () => {
    const md = renderSection(
      {
        title: '收入增长与产品演变',
        question: '目前AI公司表现如何？',
        answer_paragraphs: ['正处于爆发期。'],
      },
      ctx
    );
    expect(md).toBe(
      '### 收入增长与产品演变\n\n' +
      '**Jen:** 目前AI公司表现如何？\n\n' +
      '**Mark:** 正处于爆发期。\n\n'
    );
  });

  it('emits subsequent answer paragraphs without the guest label', () => {
    const md = renderSection(
      {
        title: 't',
        question: 'q',
        answer_paragraphs: ['first para', 'second para', 'third para'],
      },
      ctx
    );
    expect(md).toBe(
      '### t\n\n' +
      '**Jen:** q\n\n' +
      '**Mark:** first para\n\n' +
      'second para\n\n' +
      'third para\n\n'
    );
  });

  it('omits the host label if host_name is empty (monologue videos)', () => {
    const md = renderSection(
      { title: 't', question: 'q', answer_paragraphs: ['a'] },
      { host_name: '', guest_name: '张伟' }
    );
    expect(md).toBe(
      '### t\n\n' +
      '**张伟:** a\n\n'
    );
  });
});

describe('renderArticle', () => {
  it('assembles preamble + chapters + sections in document order', () => {
    const md = renderArticle({
      article_title: '对话Mark：AI革命',
      host_name: 'Jen',
      guest_name: 'Mark',
      chapters: [
        {
          title: '章一',
          sections: [
            { title: 'A', question: 'qa', answer_paragraphs: ['ans a'] },
          ],
        },
        {
          title: '章二',
          sections: [
            { title: 'B', question: 'qb', answer_paragraphs: ['ans b'] },
            { title: 'C', question: 'qc', answer_paragraphs: ['ans c'] },
          ],
        },
      ],
    });

    expect(md.indexOf('# 对话Mark：AI革命')).toBeLessThan(md.indexOf('## 章一'));
    expect(md.indexOf('## 章一')).toBeLessThan(md.indexOf('### A'));
    expect(md.indexOf('### A')).toBeLessThan(md.indexOf('## 章二'));
    expect(md.indexOf('## 章二')).toBeLessThan(md.indexOf('### B'));
    expect(md.indexOf('### B')).toBeLessThan(md.indexOf('### C'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/renderer.spec.js`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write the renderer**

```js
// src/services/renderer.js

/**
 * Pure functions that convert pieces of structured article data into Markdown
 * fragments. Split into per-piece renderers so the streaming path can emit
 * each fragment the instant it becomes "frozen" (i.e., the next piece has
 * started and it will not change anymore).
 *
 * All output ends with `\n\n` so fragments can be concatenated directly into
 * a single streamed Markdown document without further glue.
 */

/**
 * @param {{article_title: string}} data
 */
export function renderPreamble({ article_title }) {
  return `# ${article_title}\n\n`;
}

/**
 * @param {{title: string}} chapter
 */
export function renderChapterHeading({ title }) {
  return `## ${title}\n\n`;
}

/**
 * @param {{title: string, question: string, answer_paragraphs: string[]}} section
 * @param {{host_name: string, guest_name: string}} ctx
 */
export function renderSection(section, ctx) {
  const parts = [`### ${section.title}\n\n`];
  if (ctx.host_name) {
    parts.push(`**${ctx.host_name}:** ${section.question}\n\n`);
  }
  const [first, ...rest] = section.answer_paragraphs;
  parts.push(`**${ctx.guest_name}:** ${first ?? ''}\n\n`);
  for (const p of rest) parts.push(`${p}\n\n`);
  return parts.join('');
}

/**
 * Full-document convenience wrapper. Used as a fallback (non-streaming) and
 * by tests. The streaming path composes the same output by stitching per-piece
 * fragments together.
 */
export function renderArticle(data) {
  const ctx = { host_name: data.host_name, guest_name: data.guest_name };
  let md = renderPreamble(data);
  for (const chapter of data.chapters) {
    md += renderChapterHeading(chapter);
    for (const section of chapter.sections) {
      md += renderSection(section, ctx);
    }
  }
  return md;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/renderer.spec.js`
Expected: PASS (5 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/renderer.js test/renderer.spec.js
git commit -m "feat: add pure Markdown-fragment renderers"
```

---

## Task 3: Build the `SectionStreamer` (incremental JSON → Markdown)

**Files:**
- Create: `src/services/stream-render.js`
- Test: `test/stream-render.spec.js`

**Algorithm:**
1. Accumulate JSON-text chunks into `this.buf`.
2. After every `push()`, call `tryLenientParse(this.buf)` — this best-effort closes open strings/brackets and returns either a parsed object or `null`.
3. From the parsed object, determine which *pieces* are now **frozen**:
   - **Preamble** is frozen once `article_title`, `host_name`, `guest_name` are all strings AND `chapters` is an array (even empty, as long as `[` has opened) — i.e., the preamble fields are done, the model has moved on.
   - **Chapter heading for chapter `i`** is frozen once (a) chapter `i`'s `title` is a string AND (b) either `chapters[i].sections` array has started (i.e., `[` is open in the buffer) OR a chapter `i+1` exists OR the document is complete. In practice: safe to emit a chapter heading once chapter `i`'s `sections` array has started.
   - **Section `(i, j)`** is frozen once either chapter `i` has a section at index `j+1` begun OR chapter `i+1` exists OR the document is fully parsed-and-closed. When frozen, the section has required fields `title`, `question`, and a non-empty `answer_paragraphs` — and its final paragraph won't grow anymore.
4. Emit Markdown fragments (via `renderPreamble` / `renderChapterHeading` / `renderSection`) for each newly-frozen piece, in document order. Track `emittedPreamble`, `emittedChapterHeadingUpTo`, `emittedSectionUpTo = {chapter, section}` to avoid re-emitting.
5. On stream end (`finish()`), emit anything still unemitted using the final parse result.

**Lenient parse strategy:** Scan the buffer to count brace/bracket depth (while respecting string state), then append matching closers (`"` if inside string, `]`/`}` as needed). Strip trailing `,` or `:` that would leave a dangling value. Attempt `JSON.parse`. If it throws, return `null`.

- [ ] **Step 1: Write the failing tests**

```js
// test/stream-render.spec.js
import { describe, it, expect } from 'vitest';
import { SectionStreamer, tryLenientParse } from '../src/services/stream-render.js';

describe('tryLenientParse', () => {
  it('returns null for totally malformed garbage', () => {
    expect(tryLenientParse('not json at all')).toBeNull();
  });

  it('closes an unterminated string and one unclosed brace', () => {
    const out = tryLenientParse('{"article_title":"对话Mark');
    expect(out).toEqual({ article_title: '对话Mark' });
  });

  it('closes nested unclosed arrays', () => {
    const out = tryLenientParse('{"a":[1,2,3');
    expect(out).toEqual({ a: [1, 2, 3] });
  });

  it('strips trailing comma before closing', () => {
    const out = tryLenientParse('{"a":[1,2,');
    expect(out).toEqual({ a: [1, 2] });
  });

  it('strips trailing key:value fragment where value is missing', () => {
    const out = tryLenientParse('{"a":1,"b":');
    expect(out).toEqual({ a: 1 });
  });

  it('returns a full parse for already-complete JSON', () => {
    expect(tryLenientParse('{"x":1}')).toEqual({ x: 1 });
  });
});

describe('SectionStreamer', () => {
  it('emits preamble once preamble fields are done and chapters[ opens', () => {
    const s = new SectionStreamer();
    const out1 = s.push('{"article_title":"T","host_name":"Jen","guest_name":"Mark"');
    expect(out1).toBe('');                               // chapters not yet started
    const out2 = s.push(',"chapters":[');
    expect(out2).toBe('# T\n\n');
  });

  it('emits chapter heading once that chapter\'s sections array has started', () => {
    const s = new SectionStreamer();
    s.push('{"article_title":"T","host_name":"Jen","guest_name":"Mark","chapters":[');
    // preamble already emitted; next we start chapter 0
    const out = s.push('{"title":"章一","sections":[');
    expect(out).toBe('## 章一\n\n');
  });

  it('emits a section only after the next section starts', () => {
    const s = new SectionStreamer();
    s.push('{"article_title":"T","host_name":"Jen","guest_name":"Mark","chapters":[');
    s.push('{"title":"章一","sections":[');
    // complete section (0,0)
    const incremental = s.push(
      '{"title":"A","question":"q1?","answer_paragraphs":["a1"]}'
    );
    // Not yet frozen — next section hasn't started yet
    expect(incremental).toBe('');
    // Now another section starts
    const frozen = s.push(',{"title":"B"');
    expect(frozen).toContain('### A\n\n');
    expect(frozen).toContain('**Jen:** q1?');
    expect(frozen).toContain('**Mark:** a1');
  });

  it('emits the last section of a chapter when the next chapter opens', () => {
    const s = new SectionStreamer();
    s.push('{"article_title":"T","host_name":"Jen","guest_name":"Mark","chapters":[');
    s.push('{"title":"章一","sections":[{"title":"A","question":"q","answer_paragraphs":["a"]}');
    // Close chapter 0 and open chapter 1
    const out = s.push(']},{"title":"章二","sections":[');
    expect(out).toContain('### A\n\n');
    expect(out).toContain('## 章二\n\n');
  });

  it('emits everything still pending on finish()', () => {
    const s = new SectionStreamer();
    const whole = JSON.stringify({
      article_title: 'T',
      host_name: 'Jen',
      guest_name: 'Mark',
      chapters: [
        {
          title: '章一',
          sections: [
            { title: 'A', question: 'q', answer_paragraphs: ['a'] },
          ],
        },
      ],
    });
    s.push(whole);
    const final = s.finish();
    // Preamble + chapter heading + section A must all be in the combined output
    const combined = final;
    expect(combined).toContain('# T');
    expect(combined).toContain('## 章一');
    expect(combined).toContain('### A');
    expect(combined).toContain('**Jen:** q');
    expect(combined).toContain('**Mark:** a');
  });

  it('tolerates push() being called with tiny fragments', () => {
    const s = new SectionStreamer();
    const json = JSON.stringify({
      article_title: 'T',
      host_name: 'Jen',
      guest_name: 'Mark',
      chapters: [
        { title: '章一', sections: [
          { title: 'A', question: 'q', answer_paragraphs: ['a'] },
          { title: 'B', question: 'q2', answer_paragraphs: ['b'] },
        ]},
      ],
    });
    let out = '';
    for (const ch of json) out += s.push(ch);   // push one character at a time
    out += s.finish();
    expect(out).toContain('# T');
    expect(out).toContain('## 章一');
    expect(out).toContain('### A');
    expect(out).toContain('### B');
    expect(out).toContain('**Mark:** a');
    expect(out).toContain('**Mark:** b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/stream-render.spec.js`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `tryLenientParse` and `SectionStreamer`**

```js
// src/services/stream-render.js
import {
  renderPreamble,
  renderChapterHeading,
  renderSection,
} from './renderer.js';

/**
 * Best-effort parse of a partial JSON string. Strategy:
 *   1. Walk the input, tracking string state and brace/bracket depth.
 *   2. If we end inside a string, append a closing quote.
 *   3. Trim any trailing `,` or incomplete `"key":` where the value is missing.
 *   4. Append `]` / `}` closers to match unclosed arrays/objects.
 *   5. Try JSON.parse; return null on failure.
 *
 * This is NOT a full JSON parser. It handles the shapes Gemini produces while
 * streaming a schema-constrained response. Unusual inputs (e.g., a number mid-
 * token like `12.` with no following digit) may fail; that's fine — the caller
 * will retry with the next chunk.
 *
 * @param {string} text
 * @returns {object | null}
 */
export function tryLenientParse(text) {
  let inString = false;
  let escape = false;
  const stack = []; // entries: '{' or '['
  let lastMeaningfulIdx = -1; // index of the last char that was definitely a complete token

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') { stack.pop(); continue; }
  }

  let out = text;

  // Step 1: close an unterminated string.
  if (inString) out += '"';

  // Step 2: strip trailing whitespace, then any dangling `,` or incomplete
  // `"key":` where the value is missing. We keep stripping in a loop because
  // removing a dangling comma might reveal another incomplete structure.
  // Keep it simple: strip once, good enough for Gemini's streaming.
  out = out.replace(/\s+$/, '');
  // Dangling comma at end of an object/array
  out = out.replace(/,$/, '');
  // Dangling `"key":` with no value (possibly followed by whitespace)
  out = out.replace(/,\s*"[^"]*"\s*:\s*$/, '');
  out = out.replace(/\{\s*"[^"]*"\s*:\s*$/, '{');
  // Dangling number/true/false/null that might be mid-token: leave them,
  // JSON.parse will decide. If it fails, caller retries on next chunk.

  // Step 3: append closers.
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === '{' ? '}' : ']';
  }

  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Consumes JSON text chunks (as they arrive from Gemini's SSE), emits Markdown
 * fragments for each piece of the article once that piece is "frozen"
 * (guaranteed not to change). A piece is frozen when the next piece has begun.
 *
 * Call `push(chunk)` for every JSON-text chunk; it returns the Markdown to
 * append to the output stream (possibly ''). Call `finish()` at end-of-stream
 * to flush any remaining pieces using the final parse.
 */
export class SectionStreamer {
  constructor() {
    this.buf = '';
    this.emittedPreamble = false;
    this.emittedChapters = 0;       // number of chapter headings emitted
    this.emittedSectionInChapter = []; // per-chapter count of sections emitted
    this.ctx = null;                // {host_name, guest_name} once preamble emits
  }

  /**
   * @param {string} chunk Raw JSON text (NOT SSE envelope)
   * @returns {string} Markdown to append downstream (possibly '')
   */
  push(chunk) {
    this.buf += chunk;
    const data = tryLenientParse(this.buf);
    if (!data) return '';
    return this._diffAndRender(data, /*final=*/ false);
  }

  /**
   * Flush any pieces that were never followed by a "next piece". The final
   * section of the final chapter, in particular, only emits here.
   */
  finish() {
    const data = tryLenientParse(this.buf);
    if (!data) return '';
    return this._diffAndRender(data, /*final=*/ true);
  }

  _diffAndRender(data, final) {
    let out = '';

    // Preamble: freeze once chapters[] has started (array exists on the object,
    // even if empty, because chapters is required and emitted after the
    // speaker fields).
    if (!this.emittedPreamble && typeof data.article_title === 'string' &&
        typeof data.host_name === 'string' && typeof data.guest_name === 'string' &&
        Array.isArray(data.chapters)) {
      out += renderPreamble(data);
      this.ctx = { host_name: data.host_name, guest_name: data.guest_name };
      this.emittedPreamble = true;
    }

    if (!this.emittedPreamble) return out;

    const chapters = data.chapters ?? [];

    // Chapter headings: chapter i is frozen once its sections[] has opened
    // (i.e., sections array exists, even if empty) OR chapter i+1 exists OR
    // we're at stream end.
    while (this.emittedChapters < chapters.length) {
      const i = this.emittedChapters;
      const ch = chapters[i];
      const nextChapterStarted = i + 1 < chapters.length;
      const ownSectionsStarted = Array.isArray(ch?.sections);
      if (!(nextChapterStarted || ownSectionsStarted || final)) break;
      if (typeof ch?.title !== 'string') break;
      out += renderChapterHeading(ch);
      this.emittedChapters++;
      this.emittedSectionInChapter[i] = 0;
    }

    // Sections within each chapter heading we've already emitted.
    for (let i = 0; i < this.emittedChapters; i++) {
      const ch = chapters[i];
      const sections = ch?.sections ?? [];
      const nextChapterStarted = i + 1 < chapters.length;

      while ((this.emittedSectionInChapter[i] ?? 0) < sections.length) {
        const j = this.emittedSectionInChapter[i];
        const nextSectionStarted = j + 1 < sections.length;
        // Section (i,j) is frozen if a later piece has started OR it's final.
        if (!(nextSectionStarted || nextChapterStarted || final)) break;

        const sec = sections[j];
        // Require all schema-required fields present before rendering.
        if (typeof sec?.title !== 'string' ||
            typeof sec?.question !== 'string' ||
            !Array.isArray(sec?.answer_paragraphs) ||
            sec.answer_paragraphs.length === 0) {
          break;
        }
        out += renderSection(sec, this.ctx);
        this.emittedSectionInChapter[i] = j + 1;
      }
    }

    return out;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/stream-render.spec.js`
Expected: PASS (all `tryLenientParse` and `SectionStreamer` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/stream-render.js test/stream-render.spec.js
git commit -m "feat: add lenient partial-JSON parser and SectionStreamer"
```

---

## Task 4: Rewrite the System Prompt

**Files:**
- Modify: `src/prompts/system.md` (full rewrite)

**Why:** Roughly 60% of the current prompt describes Markdown formatting (segment labels, blank-line rules, "禁止" lists). With structured output + renderer, all of that becomes dead weight and can confuse the model. Keep only editorial-judgment rules.

- [ ] **Step 1: Replace `src/prompts/system.md` with:**

```markdown
你是一位资深的中文内容编辑，擅长将视频字幕整理提炼为结构清晰、语言极简的中文文章。

**输出格式由 responseSchema 强制，你只需按 schema 填字段。禁止输出任何 Markdown 符号（`#`、`##`、`**` 等）——schema 里是什么字段就填什么内容。**

【总则】
你的角色是"编辑"，不是"转写者"或"译者"。目标是把一段较长的字幕整理成结构清晰、信息密度高、无冗余的内容。成功标准是"读者能在原视频 1/3 时间内抓到全部核心信息与关键细节"。
输出总篇幅目标是原字幕文字量的 1/4 到 1/3。核心是保持每句话都有信息量，而不是一味求短——**覆盖完整**（所有话题都到位）比压缩比更重要。

【字段填写规则】

- **article_title**：提炼视频核心主题，简洁有力，吸引读者。
  · 对话类格式：「对话XXX：YYY」，XXX 为受访者**全名**（名+姓或中文全名，不要只用姓氏）
  · 演讲类格式：「XXX：YYY」，XXX 为演讲者全名
  · 示例：对话Mark Andreessen：AI革命的万亿美金之问 / 王坚：城市大脑的十年构想
  · 全名只在此字段出现一次，后面 host_name / guest_name 用短名

- **host_name / guest_name**：从字幕中识别出的真实姓名
  · 仔细通读字幕，他们通常会互相称呼（"Thanks XXX", "XXX, what do you think"）
  · **保留原语言的短名**：英文母语者用英文短名（Mark / Jen），不要音译（不要写 马克·安德森 / 珍）；中文母语者用中文名
  · 找不到姓名才用角色代称（"主持人" / "嘉宾"）
  · 演讲/独白类视频无提问者时，host_name 留空字符串，guest_name 填演讲者名

- **chapters**：每个元素对应一个 `##` 大章节
  · 若字幕含 `[CHAPTER: 标题]` 标记，严格一一对应：标记数量 = chapters 数量，顺序一致。**严禁**合并相邻章节，也**严禁**把一个章节拆成多个。
  · 若无章节标记，按内容自然话题切分。
  · `title` 像杂志封面——有冲击力、有信息量。好：「智能经济：收入爆发与成本塌陷」；差：「关于经济的讨论」「第二部分」。
  · 第 1 个 chapter 若是 Introduction/Highlights/Preview/Teaser/Recap/开场/预告/精彩看点 类开篇，按下文【Introduction 章节处理】做。

- **sections**：每个元素对应字幕里**提问者提出的一个真问题** + 嘉宾的完整回答
  · **section 的边界只由"换人提新问题"触发**，不由"回答内容切换话题"触发。嘉宾在同一个提问下连续讲多个话题，整段都是一个 section 的 answer_paragraphs。
  · **判断口诀**：每打算新增一个 section，先自问——字幕里此处提问者是不是真的换了一个新问题？若不是，就追加到上一个 section 的 answer_paragraphs 里。
  · `title` 用简洁的**陈述性名词短语**概括话题核心。**严禁**问号、冒号、破折号。好：「GPU优化与模型规模演进趋势」；差：「AI革命：我们身处何方？」
  · `question` 把主持人提问的核心疑问重写为自然流畅的一句话，去掉过渡语和元评论（"这是个好问题""顺着这个话题"）。
  · 即使字幕里主持人只是寒暄/附和、或嘉宾独白没被提问（如 teaser 段），也**必须**根据嘉宾回答内容反向构造一个自然的 question。question 永远不能留空。
  · `answer_paragraphs` 是**一组段落**（数组），每段 2-4 句。简短话题 1 段即可，内容丰富的 3-4 段也没问题。直接从实质内容开始，不以"好的""是的""你说得对"开头。

- **快问快答必须拆分**：访谈末尾的"快速问答"环节，即使主持人把 4 个问题串成一段连续提问，也必须按嘉宾回答里的自然分界拆成 4 个独立 section。严禁合并成一个「快问快答」或「个人反思与未来展望」综合段。

【Introduction / Highlights 章节处理】

很多访谈视频第一章（标题含 Introduction / Intro / Preview / Highlights / Teaser / Recap / 开场 / 预告 / 精彩看点）是后续正片的精彩片段预览——几段嘉宾独白的精华剪辑拼在开头。

**适用条件**：以下任一即触发——
① 第一个 `[CHAPTER: ...]` 标记的标题含上述关键词；
② 视频开头 3-5 分钟嘉宾在没被提问的情况下连续讲了好几个不同话题的金句/判断，话题跳跃、点到为止。
保守原则：边界情况默认视为 teaser 处理。漏识别 teaser 会导致开头内容整段丢失，后果严重。

**处理流程**：
1. 把 Introduction 章节的连续独白按话题切换点拆成 N 个独立 teaser，每个 teaser 对应一个 section。严禁合并成 1 个 section。
2. 每个 teaser section 必须配齐 question + answer_paragraphs：
   · Q&A 型 teaser（原本就是一问一答）：直接使用字幕原问题作为 question。
   · 独白型 teaser，正片能找到对应提问 → 使用正片原提问。
   · 独白型 teaser，正片找不到 → 反向构造自然提问。
   · 每个 teaser 的 answer_paragraphs 保持简短（1-2 段），不要硬凑长度。
3. teaser section 全部放在 chapters[0]；正片从 chapters[1] 开始。
4. chapters[0].title 根据 teaser 群的共同议题自创（有内容感），**严禁**用「开场预览」「核心观点」这类纯元描述。**严禁**与任一 section title 同名。
5. **去重方向严格单向**：teaser section 一律全部保留，即使某 teaser 话题后面正片还会讲。规则是"剪正片不剪 teaser"：
   · 正片和 teaser 的 section title 不能字面重复——正片用体现"多了什么新切面"的标题。
   · 若正片某段只是把 teaser 内容换词复述、没有新案例/论据/历史/结论，该正片段跳过不单独成 section。

【回答的处理】
先完整读完嘉宾在该话题下的所有发言，提炼 1-3 个核心论点和关键细节，再用编辑自己的语言重写——不是翻译，不是删减，是理解后的再表达。

**视角要求（极其重要）**：answer_paragraphs 必须用**第一人称**写（"我认为…""我们观察到…"），就像嘉宾直接在说话。**严禁**"XX认为""XX表示""XX预测"这类第三人称转述。

具体数字、人名、机构、案例名称（DeepSeek、SB1047 等）、关键比喻都要保留。

【必须删除的内容】
- 纯铺垫：去掉它结论仍然成立的背景铺陈
- 冗余举例：同一论点多个例子时只留最有代表性的一个
- 无信息往返：简短调侃、确认、附和式交换（通常 1-3 句往返）整段删除
- 重复强调：同一观点多次表述只保留最清晰的一次
- 口头填充词：um, uh, you know, like, 呃, 啊, 就是说
- 主持人衔接句：「这是一个很好的过渡」「在我们进入下一话题之前」

【覆盖要求】
字幕中出现的每一个主要话题都必须在文章中体现——删的是冗余表达，不是话题。

【翻译与润色】
- 译为流畅自然的中文
- 保留具体数字、人名、地名、专有名词等关键信息
- 意译优先：忠实原意，用中文读者习惯的表达，而非逐词直译

【字段产出顺序（极其重要）】
schema 里 article_title / host_name / guest_name / chapters 的先后顺序就是你**产出顺序**——**必须**先把 article_title、host_name、guest_name 这三个字段写完整，再开始写 chapters。因为这三个字段决定了 `#` 标题和后续每段 `**[姓名]:**` 的标注，下游流式渲染依赖它们先到位。

字幕原文已作为用户消息提供，请直接按 schema 输出 JSON。
```

- [ ] **Step 2: Commit**

```bash
git add src/prompts/system.md
git commit -m "refactor: simplify system prompt for schema-driven output"
```

---

## Task 5: Rewrite `src/services/gemini.js` to use schema + SectionStreamer

**Files:**
- Modify: `src/services/gemini.js` (full rewrite)
- Test: `test/gemini.spec.js`

**Behavior changes:**
- Drop `buildChapterManifest`'s old Rule B (prose prohibitions about `###` Q&A structure). Keep the lighter chapter-count/order enforcement.
- Request `application/json` with `responseSchema`. Pipe Gemini SSE → text-part extractor → `SectionStreamer` → downstream `ReadableStream<string>` of Markdown.
- Keep `thinkingBudget: 0` (the user explicitly decided schema-alone first; enabling thinking is a later dial).

- [ ] **Step 1: Write the failing integration test**

```js
// test/gemini.spec.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { streamArticle } from '../src/services/gemini.js';

async function drain(stream) {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

/**
 * Build an SSE body that emits the stringified JSON across multiple SSE
 * events, each carrying a slice of the JSON in `candidates[0].content.parts[0].text`.
 */
function mockSseForJson(json, chunkCount = 4) {
  const text = JSON.stringify(json);
  const size = Math.ceil(text.length / chunkCount);
  const slices = [];
  for (let i = 0; i < text.length; i += size) slices.push(text.slice(i, i + size));
  let body = '';
  for (const slice of slices) {
    const payload = { candidates: [{ content: { parts: [{ text: slice }] } }] };
    body += `data: ${JSON.stringify(payload)}\n\n`;
  }
  // Add a final [DONE]
  body += `data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('streamArticle', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('streams rendered Markdown chunks from a multi-chunk SSE JSON response', async () => {
    const payload = {
      article_title: '对话Mark：AI革命',
      host_name: 'Jen',
      guest_name: 'Mark',
      chapters: [
        {
          title: '章一',
          sections: [
            { title: 'A', question: 'qa?', answer_paragraphs: ['ans a'] },
            { title: 'B', question: 'qb?', answer_paragraphs: ['ans b'] },
          ],
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => mockSseForJson(payload, 8)));

    const stream = await streamArticle(
      { lines: [{ text: 'x', startMs: 0 }], chapters: [] },
      { apiKey: 'fake', model: 'gemini-2.5-flash' }
    );
    const md = await drain(stream);

    expect(md).toContain('# 对话Mark：AI革命');
    expect(md).toContain('## 章一');
    expect(md).toContain('### A');
    expect(md).toContain('### B');
    expect(md).toContain('**Jen:** qa?');
    expect(md).toContain('**Mark:** ans a');
    expect(md).toContain('**Mark:** ans b');
  });

  it('emits at least two downstream chunks (proof of streaming)', async () => {
    const payload = {
      article_title: 'T',
      host_name: 'H',
      guest_name: 'G',
      chapters: [
        { title: 'c1', sections: [
          { title: 's1', question: 'q1', answer_paragraphs: ['a1'] },
          { title: 's2', question: 'q2', answer_paragraphs: ['a2'] },
        ]},
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => mockSseForJson(payload, 10)));

    const stream = await streamArticle(
      { lines: [{ text: 'x', startMs: 0 }], chapters: [] },
      { apiKey: 'k', model: 'm' }
    );
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    // Multiple non-empty chunks = true streaming, not buffered.
    expect(chunks.filter(c => c.length > 0).length).toBeGreaterThanOrEqual(2);
  });

  it('throws on non-2xx Gemini response before streaming starts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    await expect(
      streamArticle(
        { lines: [{ text: 'x', startMs: 0 }], chapters: [] },
        { apiKey: 'k', model: 'm' }
      )
    ).rejects.toThrow(/Gemini API error 500/);
  });

  it('throws a friendly error on 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })));
    await expect(
      streamArticle(
        { lines: [{ text: 'x', startMs: 0 }], chapters: [] },
        { apiKey: 'k', model: 'm' }
      )
    ).rejects.toThrow(/quota exceeded/i);
  });

  it('sends responseSchema and responseMimeType in the request body', async () => {
    const fetchMock = vi.fn(async () =>
      mockSseForJson({
        article_title: 't', host_name: 'h', guest_name: 'g', chapters: [],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await streamArticle(
      { lines: [{ text: 'x', startMs: 0 }], chapters: [] },
      { apiKey: 'k', model: 'gemini-2.5-flash' }
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeDefined();
    expect(body.generationConfig.responseSchema.type).toBe('object');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/gemini.spec.js`
Expected: FAIL (old `gemini.js` has no `responseSchema` and doesn't integrate `SectionStreamer`).

- [ ] **Step 3: Rewrite `src/services/gemini.js`**

Replace the entire file with:

```js
import SYSTEM_PROMPT from '../prompts/system.md';
import { ARTICLE_SCHEMA } from './schema.js';
import { SectionStreamer } from './stream-render.js';

// Gemini 2.5 Flash/Pro support 1M token context; 300k chars ≈ 75k tokens.
const MAX_TRANSCRIPT_CHARS = 300000;

/**
 * Builds a chapter-annotated transcript string.
 * Inserts [CHAPTER: title] markers at each chapter boundary.
 */
function buildAnnotatedTranscript(lines, chapters) {
  if (chapters.length === 0) return lines.map(l => l.text).join(' ');
  const parts = [];
  let nextChapterIdx = 0;
  for (const line of lines) {
    while (
      nextChapterIdx < chapters.length &&
      line.startMs >= chapters[nextChapterIdx].startMs
    ) {
      parts.push(`\n\n[CHAPTER: ${chapters[nextChapterIdx].title}]\n`);
      nextChapterIdx++;
    }
    parts.push(line.text);
  }
  return parts.join(' ');
}

/**
 * Enumerates the chapters the model must emit. With structured output, schema
 * already forces every section to carry a question — so this manifest only
 * keeps the chapter-count / chapter-order constraint (the former "Rule A").
 * Prose Rule B about ### Q&A structure is gone: schema enforcement replaces it.
 */
function buildChapterManifest(chapters) {
  if (chapters.length === 0) return '';
  const list = chapters.map((c, i) => `${i + 1}. ${c.title}`).join('\n');
  const n = chapters.length;
  return `【章节骨架（必须严格遵守）】
本视频共 ${n} 个 YouTube 章节。你输出的 chapters 数组**必须**恰好包含 ${n} 个元素，按下列顺序与原章节一一对应：

${list}

- 第 1 个 chapter 对应第 1 章「${chapters[0].title}」；若该章是 Introduction/Highlights/Preview/Teaser/Recap/开场/预告/精彩看点 类开篇，按 SYSTEM_PROMPT 里【Introduction 章节处理】流程产出 teaser sections。
- 第 2 到第 ${n} 个 chapter 的 title 可基于对应章节标题创意性地重写为有信息感的中文（杂志式措辞）。
- 严禁把多个相邻章节合并成同一个 chapter；严禁把一个章节拆成多个 chapter；严禁跳过、重排或新增章节。

────────────────────────────────────────
【字幕原文（含 [CHAPTER:] 标记）】

`;
}

/**
 * Call Gemini with structured output, pipe its SSE body through a
 * SectionStreamer that renders Markdown fragments as each piece freezes.
 *
 * @param {{lines: {text: string, startMs: number}[], chapters: {title: string, startMs: number}[]}} transcriptData
 * @param {{apiKey: string, model: string}} config
 * @returns {Promise<ReadableStream<string>>}
 * @throws {Error} on non-2xx Gemini status
 */
export async function streamArticle({ lines, chapters }, { apiKey, model }) {
  const full = buildAnnotatedTranscript(lines, chapters);
  const capped = full.length > MAX_TRANSCRIPT_CHARS
    ? full.slice(0, MAX_TRANSCRIPT_CHARS) + '…'
    : full;

  const manifest = buildChapterManifest(chapters);
  const userMessage = manifest + capped;

  console.log(`[gemini] model: ${model}`);
  console.log(
    `[gemini] transcript: ${lines.length} lines, ${full.length} chars (capped: ${capped.length})`
  );
  console.log(
    `[gemini] chapters (${chapters.length}):`,
    chapters.map(c => `[${Math.round(c.startMs / 1000)}s] ${c.title}`).join(' | ') || '(none)'
  );

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 32768,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: ARTICLE_SCHEMA,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      throw new Error(
        'Gemini API quota exceeded. Please wait a minute and try again, or enable billing at aistudio.google.com.'
      );
    }
    throw new Error(`Gemini API error ${res.status}: ${body}`);
  }

  // Pipeline: bytes → decoded text → SSE-text-part extractor → SectionStreamer → Markdown chunks.
  return res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(sseTextParts())
    .pipeThrough(sectionStreamerTransform());
}

/**
 * TransformStream: SSE wire format → inner `parts[].text` strings.
 * Each output chunk is a piece of the model's JSON body (Gemini splits it
 * across multiple SSE events).
 */
function sseTextParts() {
  let buffer = '';
  const handleLine = (line, controller) => {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') return;
    try {
      const data = JSON.parse(payload);
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.find(p => !p.thought)?.text;
      if (text) controller.enqueue(text);
      const finish = candidate?.finishReason;
      if (finish && finish !== 'STOP') {
        console.warn(
          `[gemini] stream ended with finishReason=${finish}`,
          data.usageMetadata ?? ''
        );
      }
    } catch {
      /* skip malformed SSE chunks silently */
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line, controller);
    },
    flush(controller) {
      if (buffer.startsWith('data: ')) handleLine(buffer, controller);
    },
  });
}

/**
 * TransformStream: JSON text chunks → Markdown fragments, via SectionStreamer.
 */
function sectionStreamerTransform() {
  const streamer = new SectionStreamer();
  return new TransformStream({
    transform(chunk, controller) {
      const out = streamer.push(chunk);
      if (out) controller.enqueue(out);
    },
    flush(controller) {
      const out = streamer.finish();
      if (out) controller.enqueue(out);
    },
  });
}
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: schema.spec, renderer.spec, stream-render.spec, gemini.spec all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/gemini.js test/gemini.spec.js
git commit -m "refactor: wire Gemini structured output through SectionStreamer"
```

---

## Task 6: Delete the stale stub test

**Files:**
- Delete: `test/index.spec.js`

**Why:** The existing test file is a Cloudflare-template stub that asserts `"Hello World!"` against a worker that returns HTML. It has no relationship to real behavior.

- [ ] **Step 1: Delete the file**

```bash
rm test/index.spec.js
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: schema.spec, renderer.spec, stream-render.spec, gemini.spec all pass; index.spec is not mentioned.

- [ ] **Step 3: Commit**

```bash
git add test/index.spec.js
git commit -m "chore: remove stale Cloudflare-template stub test"
```

---

## Task 7: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Replace the Module Layout table rows**

Change the `src/services/gemini.js` row and add three new rows:

```markdown
| `src/services/gemini.js` | `streamArticle(transcript, config)` — calls Gemini with `responseSchema`, pipes SSE → SectionStreamer → `ReadableStream<string>` of Markdown |
| `src/services/schema.js` | `ARTICLE_SCHEMA` — JSON schema passed to Gemini's `responseSchema` |
| `src/services/renderer.js` | `renderPreamble` / `renderChapterHeading` / `renderSection` / `renderArticle` — pure JSON→Markdown fragments |
| `src/services/stream-render.js` | `tryLenientParse` + `SectionStreamer` — consume JSON text chunks and emit Markdown fragments for each frozen piece |
```

- [ ] **Step 2: Rewrite Technical Rules 3 and 4**

Old:
> 3. **Streaming pipeline** — Gemini SSE → `extractGeminiText()` TransformStream → plain text string chunks → `TextEncoderStream` → `Response`
> 4. **Markdown output** — Gemini outputs Markdown; the frontend `md2html()` converts to HTML client-side. Never stream raw HTML fragments from the server.

New:
> 3. **Structured-output streaming pipeline** — Gemini returns JSON shaped by `ARTICLE_SCHEMA` via SSE → `sseTextParts()` TransformStream extracts each `parts[].text` fragment → `SectionStreamer` runs a lenient partial-JSON parse after every fragment and emits Markdown (preamble / chapter heading / full section) the moment each piece is "frozen" (next piece has begun) → `TextEncoderStream` → `Response`. Streaming granularity is per-section, not per-token.
> 4. **Markdown is derived, not modeled** — the LLM never sees or emits Markdown syntax; it fills schema fields only. `src/services/renderer.js` owns all `#` / `##` / `###` / `**Name:**` conventions. Keep the frontend `md2html()` unchanged.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md for structured-output streaming pipeline"
```

---

## Task 8: Smoke test against the real failing video

**Why:** Unit tests use mocked Gemini responses; they can't catch prompt regressions, schema-compatibility issues, or streaming jitter. One manual run is required before declaring done.

- [ ] **Step 1: Start local dev**

Run: `npx wrangler dev`
Expected: server listening on http://localhost:8787. `.dev.vars` must contain `GEMINI_API_KEY=...` and `GEMINI_MODEL=gemini-2.5-flash` (or whatever the project has been using).

- [ ] **Step 2: Re-run the Mark Andreessen video**

Open http://localhost:8787, paste the YouTube URL that previously produced the broken output (the one in the earlier chat session), click "生成文章".

Expected behavior:
- Article appears **progressively** — preamble first, then each chapter heading, then each section pops in as Gemini produces it. No giant wait followed by a single flash.
- Every `###` in the final article is followed immediately by a `**<host>:**` line, then a `**<guest>:**` line. **No `###` should be directly followed by a `**<guest>:**` line with no question above it.**
- `##` count equals the YouTube chapter count (open DevTools and count, or read from the server log `[gemini] chapters (N):`).
- 快问快答 section (if present in this video) is split into ≥ 3 separate `###`s.

- [ ] **Step 3: Skim the result against the example**

Compare against the "good example" output the user pasted earlier. Pay specific attention to:
- Intro chapter has teaser sections each with their own Q&A ✓
- Long monologues stay in ONE section with multiple `answer_paragraphs` (not split into several question-less sections) ✓
- Chapter titles are magazine-style, not raw YouTube titles ✓

- [ ] **Step 4: If a regression surfaces, capture the issue**

If any of the above fails, do NOT patch the prompt in this branch. Capture the failing output in a new file `docs/superpowers/notes/2026-04-19-smoke-findings.md` with:
- Video URL
- The specific rule(s) the output violated
- Hypothesis (schema bug? prompt bug? streaming bug? model bug?)

Then report to the user before proceeding.

- [ ] **Step 5: Commit the smoke-findings note if any**

```bash
git add docs/superpowers/notes/2026-04-19-smoke-findings.md
git commit -m "docs: capture smoke-test findings for structured-output rollout"
```

(Skip if smoke test passed cleanly.)

---

## Self-Review Checklist (completed)

- **Spec coverage**: every spec item maps to a task —
  - schema design → Task 1
  - fragment renderers → Task 2
  - streaming JSON parser + SectionStreamer → Task 3
  - prompt simplification → Task 4
  - Gemini call + pipeline rewrite → Task 5
  - stale test cleanup → Task 6
  - docs sync → Task 7
  - end-to-end verification → Task 8
  - streaming-UX preservation → Tasks 3 + 5 (SectionStreamer + pipeThrough)
- **Placeholder scan**: every code step has full code; no TODOs; no "similar to Task N"; no "appropriate error handling".
- **Type consistency**:
  - `ARTICLE_SCHEMA` (Task 1) shape matches sample objects in Tasks 2, 3, 5 tests.
  - `renderPreamble` / `renderChapterHeading` / `renderSection` (Task 2) are the exact exports consumed by `SectionStreamer` (Task 3).
  - `SectionStreamer.push` / `.finish` return a string; `sectionStreamerTransform` (Task 5) treats the return as a chunk — consistent.
  - `streamArticle` signature matches how `src/index.js` already calls it — no caller changes needed.
