// src/services/stream-render.js
import {
  renderPreamble,
  renderChapterHeading,
  renderSection,
} from './renderer.js';

/**
 * A section is "ready" when every schema-required field is fully present.
 * The freeze heuristic decides *when* to render a section; this predicate
 * decides *whether* a section can be rendered at all.
 */
function sectionReady(sec) {
  return typeof sec?.title === 'string' &&
         typeof sec?.question === 'string' &&
         Array.isArray(sec?.answer_paragraphs) &&
         sec.answer_paragraphs.length > 0;
}

/**
 * Streams a single chapter's JSON (`{ title, sections }`) into Markdown.
 * Used for per-chapter calls 2..N, where host/guest names are already known
 * from the first call and only the chapter content is being generated.
 *
 * Mirrors SectionStreamer's freeze heuristic: a section is rendered once the
 * next one has started (or finish() is called), preventing half-written
 * sections from being emitted.
 */
export class ChapterStreamer {
  /**
   * @param {{ host_name: string, guest_name: string }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.buf = '';
    this.headingEmitted = false;
    this.emittedSections = 0;
  }

  /** @param {string} chunk  @returns {string} */
  push(chunk) {
    this.buf += chunk;
    return this._render(tryLenientParse(this.buf), false);
  }

  /** @returns {string} */
  finish() {
    return this._render(tryLenientParse(this.buf), true);
  }

  _render(data, final) {
    if (!data) return '';
    let out = '';

    // Emit chapter heading once title + sections array are both visible.
    if (!this.headingEmitted &&
        typeof data.title === 'string' &&
        Array.isArray(data.sections)) {
      out += renderChapterHeading(data);
      this.headingEmitted = true;
    }
    if (!this.headingEmitted) return out;

    const sections = data.sections;
    while (this.emittedSections < sections.length) {
      const j = this.emittedSections;
      // Freeze heuristic: render section j only once j+1 has started, or on finish.
      if (!(j + 1 < sections.length || final)) break;
      const sec = sections[j];
      if (!sectionReady(sec)) break;
      out += renderSection(sec, this.ctx);
      this.emittedSections++;
    }

    return out;
  }
}

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

  // Close an unterminated string.
  if (inString) out += '"';

  // Strip trailing whitespace, dangling comma, or incomplete "key": with no value.
  out = out.replace(/\s+$/, '');
  out = out.replace(/,$/, '');
  out = out.replace(/,\s*"[^"]*"\s*:\s*$/, '');
  out = out.replace(/\{\s*"[^"]*"\s*:\s*$/, '{');

  // Append closers for unclosed arrays/objects.
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
    this.emittedChapters = 0;
    this.emittedSectionInChapter = [];
    this.ctx = null;
  }

  /**
   * @param {string} chunk Raw JSON text (NOT SSE envelope)
   * @returns {string} Markdown to append downstream (possibly '')
   */
  push(chunk) {
    this.buf += chunk;
    const data = tryLenientParse(this.buf);
    if (!data) return '';
    return this._diffAndRender(data, false);
  }

  /**
   * Flush any pieces that were never followed by a "next piece".
   */
  finish() {
    const data = tryLenientParse(this.buf);
    if (!data) return '';
    return this._diffAndRender(data, true);
  }

  _diffAndRender(data, final) {
    let out = '';

    // Preamble: freeze once chapters[] has started.
    if (!this.emittedPreamble &&
        typeof data.article_title === 'string' &&
        typeof data.host_name === 'string' &&
        typeof data.guest_name === 'string' &&
        Array.isArray(data.chapters)) {
      out += renderPreamble(data);
      this.ctx = { host_name: data.host_name, guest_name: data.guest_name };
      this.emittedPreamble = true;
    }

    if (!this.emittedPreamble) return out;

    const chapters = data.chapters ?? [];

    // Chapter headings: frozen once its sections[] has opened OR next chapter exists OR final.
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

    // Sections within each emitted chapter.
    for (let i = 0; i < this.emittedChapters; i++) {
      const ch = chapters[i];
      const sections = ch?.sections ?? [];
      const nextChapterStarted = i + 1 < chapters.length;

      while ((this.emittedSectionInChapter[i] ?? 0) < sections.length) {
        const j = this.emittedSectionInChapter[i];
        const nextSectionStarted = j + 1 < sections.length;
        if (!(nextSectionStarted || nextChapterStarted || final)) break;

        const sec = sections[j];
        if (!sectionReady(sec)) break;
        out += renderSection(sec, this.ctx);
        this.emittedSectionInChapter[i] = j + 1;
      }
    }

    return out;
  }
}
