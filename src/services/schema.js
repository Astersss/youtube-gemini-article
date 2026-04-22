// src/services/schema.js

/**
 * Shared section item — reused by both ARTICLE_SCHEMA and CHAPTER_SCHEMA so
 * the required-field constraint (`question`, `answer_paragraphs`, `title`) is
 * defined in exactly one place.
 */
const SECTION_ITEM = {
  type: 'object',
  properties: {
    title:             { type: 'string' },
    question:          { type: 'string' },
    answer_paragraphs: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'question', 'answer_paragraphs'],
};

/**
 * Full-article schema.
 * Used for: (a) no-chapter single call, (b) the first per-chapter call.
 *
 * Shape:
 *   { article_title, host_name, guest_name,
 *     chapters: [{ title, sections: [SectionItem] }] }
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
          title:    { type: 'string' },
          sections: { type: 'array', items: SECTION_ITEM },
        },
        required: ['title', 'sections'],
      },
    },
  },
  required: ['article_title', 'host_name', 'guest_name', 'chapters'],
};

/**
 * Single-chapter schema.
 * Used for per-chapter calls.  article_title / host_name / guest_name are
 * extracted by a dedicated metadata call (see METADATA_SCHEMA) and passed
 * back as user-message context, not re-requested per chapter.
 *
 * Shape: { title, sections: [SectionItem] }
 */
export const CHAPTER_SCHEMA = {
  type: 'object',
  properties: {
    title:    { type: 'string' },
    sections: { type: 'array', items: SECTION_ITEM },
  },
  required: ['title', 'sections'],
};

/**
 * Names-only schema for the parallel name-extraction call.
 * Input is snippet-extracted transcript excerpts (~1-5k chars), not the full
 * transcript.
 *
 * Shape: { host_name, guest_name }
 */
export const NAMES_SCHEMA = {
  type: 'object',
  properties: {
    host_name:  { type: 'string' },
    guest_name: { type: 'string' },
  },
  required: ['host_name', 'guest_name'],
};

/**
 * Title-only schema for the parallel title-extraction call.
 * Input is the chapter list + (optionally) the first chapter's transcript
 * when it looks like an intro/highlights chapter.
 *
 * Shape: { article_title }
 */
export const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    article_title: { type: 'string' },
  },
  required: ['article_title'],
};
