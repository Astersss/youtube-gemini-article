// test/extract-names.spec.js
import { describe, it, expect } from 'vitest';
import { extractNameSnippets } from '../src/services/extract-names.js';

const makeLines = (texts) => texts.map((text, i) => ({ text, startMs: i * 1000 }));

describe('extractNameSnippets', () => {
  it('captures English "thanks X" pattern with ±2 lines of context', () => {
    const lines = makeLines([
      'line A',
      'line B',
      'Thanks, Sam, that was a great overview.',
      'line D',
      'line E',
      'line F',
    ]);
    const out = extractNameSnippets(lines, []);
    expect(out).toContain('line A');
    expect(out).toContain('Thanks, Sam');
    expect(out).toContain('line E');
    // line F is 3 lines away, should be excluded
    expect(out).not.toContain('line F');
  });

  it('captures "my guest today is X" pattern', () => {
    const lines = makeLines([
      'Welcome to the show.',
      'My guest today is Dario Amodei, co-founder of Anthropic.',
      'Let\'s get started.',
    ]);
    const out = extractNameSnippets(lines, []);
    expect(out).toContain('Dario Amodei');
  });

  it('captures "X, what do you think" address pattern', () => {
    const lines = makeLines([
      'So these are fascinating developments.',
      'Mark, what do you think about this?',
      'It is a huge question.',
    ]);
    const out = extractNameSnippets(lines, []);
    expect(out).toContain('Mark, what do you think');
  });

  it('captures Chinese 欢迎/感谢/请到 patterns', () => {
    const lines = makeLines([
      '今天我们的嘉宾是张三。',
      '欢迎张三来到节目。',
      '其他内容。',
    ]);
    const out = extractNameSnippets(lines, []);
    expect(out).toContain('嘉宾是张三');
    expect(out).toContain('欢迎张三');
  });

  it('includes chapter list at the top of the snippet output', () => {
    const lines = makeLines(['irrelevant line']);
    const chapters = [
      { title: 'Introduction', startMs: 0 },
      { title: 'Interview with Dario Amodei', startMs: 1000 },
    ];
    const out = extractNameSnippets(lines, chapters);
    expect(out).toContain('Introduction');
    expect(out).toContain('Interview with Dario Amodei');
  });

  it('falls back to first 1500 + last 1500 chars when no pattern hits', () => {
    const body = 'A'.repeat(2000) + 'B'.repeat(1000) + 'C'.repeat(2000);
    const lines = [{ text: body, startMs: 0 }];
    const out = extractNameSnippets(lines, []);
    expect(out).toContain('A'.repeat(1500));
    expect(out).toContain('C'.repeat(1500));
    // middle B-section should not appear in fallback
    expect(out).not.toContain('B'.repeat(1000));
  });

  it('dedupes overlapping snippet windows', () => {
    const lines = makeLines([
      'Thanks, Sam, welcome back.',
      'line B',
      'Welcome Sam to the show.',
      'line D',
    ]);
    const out = extractNameSnippets(lines, []);
    // "line B" appears once only even though both hits' windows cover it
    const count = out.split('line B').length - 1;
    expect(count).toBe(1);
  });

  it('returns reasonable output size (under 20k chars) on long transcript with sparse hits', () => {
    const filler = Array(5000).fill('the quick brown fox.');
    filler[100]  = 'Thanks Sam for that insight.';
    filler[2500] = 'Welcome back, Sam.';
    const lines = makeLines(filler);
    const out = extractNameSnippets(lines, []);
    expect(out.length).toBeLessThan(20_000);
  });
});
