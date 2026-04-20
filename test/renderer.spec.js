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
