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
