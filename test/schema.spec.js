// test/schema.spec.js
import { describe, it, expect } from 'vitest';
import { ARTICLE_SCHEMA, CHAPTER_SCHEMA, METADATA_SCHEMA } from '../src/services/schema.js';

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

describe('METADATA_SCHEMA', () => {
  it('only requires the three preamble fields and exposes no chapter content', () => {
    expect(METADATA_SCHEMA.type).toBe('object');
    expect(METADATA_SCHEMA.required).toEqual(
      expect.arrayContaining(['article_title', 'host_name', 'guest_name'])
    );
    expect(Object.keys(METADATA_SCHEMA.properties)).not.toContain('chapters');
    expect(Object.keys(METADATA_SCHEMA.properties)).not.toContain('sections');
  });
});
