// test/schema.spec.js
import { describe, it, expect } from 'vitest';
import { ARTICLE_SCHEMA, CHAPTER_SCHEMA, NAMES_SCHEMA, TITLE_SCHEMA } from '../src/services/schema.js';

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

describe('CHAPTER_SCHEMA', () => {
  it('requires title and sections, no preamble fields', () => {
    expect(CHAPTER_SCHEMA.type).toBe('object');
    expect(CHAPTER_SCHEMA.required).toEqual(
      expect.arrayContaining(['title', 'sections'])
    );
    expect(Object.keys(CHAPTER_SCHEMA.properties)).not.toContain('article_title');
    expect(Object.keys(CHAPTER_SCHEMA.properties)).not.toContain('host_name');
  });

  it('shares the same section item shape as ARTICLE_SCHEMA', () => {
    const chapSecItem = CHAPTER_SCHEMA.properties.sections.items;
    const artSecItem  = ARTICLE_SCHEMA.properties.chapters.items.properties.sections.items;
    expect(chapSecItem.required).toEqual(artSecItem.required);
    expect(Object.keys(chapSecItem.properties)).toEqual(Object.keys(artSecItem.properties));
  });
});

describe('NAMES_SCHEMA', () => {
  it('requires only host_name and guest_name (both strings)', () => {
    expect(NAMES_SCHEMA.type).toBe('object');
    expect(NAMES_SCHEMA.required).toEqual(
      expect.arrayContaining(['host_name', 'guest_name'])
    );
    expect(Object.keys(NAMES_SCHEMA.properties).sort()).toEqual(['guest_name', 'host_name']);
    expect(NAMES_SCHEMA.properties.host_name.type).toBe('string');
    expect(NAMES_SCHEMA.properties.guest_name.type).toBe('string');
  });
});

describe('TITLE_SCHEMA', () => {
  it('requires only article_title (string)', () => {
    expect(TITLE_SCHEMA.type).toBe('object');
    expect(TITLE_SCHEMA.required).toEqual(['article_title']);
    expect(Object.keys(TITLE_SCHEMA.properties)).toEqual(['article_title']);
    expect(TITLE_SCHEMA.properties.article_title.type).toBe('string');
  });
});
