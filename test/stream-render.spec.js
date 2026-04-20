// test/stream-render.spec.js
import { describe, it, expect } from 'vitest';
import { SectionStreamer, ChapterStreamer, tryLenientParse } from '../src/services/stream-render.js';

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
    expect(out1).toBe('');
    const out2 = s.push(',"chapters":[');
    expect(out2).toBe('# T\n\n');
  });

  it('emits chapter heading once that chapter\'s sections array has started', () => {
    const s = new SectionStreamer();
    s.push('{"article_title":"T","host_name":"Jen","guest_name":"Mark","chapters":[');
    const out = s.push('{"title":"章一","sections":[');
    expect(out).toBe('## 章一\n\n');
  });

  it('emits a section only after the next section starts', () => {
    const s = new SectionStreamer();
    s.push('{"article_title":"T","host_name":"Jen","guest_name":"Mark","chapters":[');
    s.push('{"title":"章一","sections":[');
    const incremental = s.push(
      '{"title":"A","question":"q1?","answer_paragraphs":["a1"]}'
    );
    expect(incremental).toBe('');
    const frozen = s.push(',{"title":"B"');
    expect(frozen).toContain('### A\n\n');
    expect(frozen).toContain('**Jen:** q1?');
    expect(frozen).toContain('**Mark:** a1');
  });

  it('emits the last section of a chapter when the next chapter opens', () => {
    const s = new SectionStreamer();
    s.push('{"article_title":"T","host_name":"Jen","guest_name":"Mark","chapters":[');
    s.push('{"title":"章一","sections":[{"title":"A","question":"q","answer_paragraphs":["a"]}');
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
    // Preamble + chapter heading emit during push(); last section flushes in finish().
    // Combined output must contain all pieces.
    const combined = s.push(whole) + s.finish();
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
    for (const ch of json) out += s.push(ch);
    out += s.finish();
    expect(out).toContain('# T');
    expect(out).toContain('## 章一');
    expect(out).toContain('### A');
    expect(out).toContain('### B');
    expect(out).toContain('**Mark:** a');
    expect(out).toContain('**Mark:** b');
  });
});

describe('ChapterStreamer', () => {
  const ctx = { host_name: 'Jen', guest_name: 'Mark' };

  it('emits chapter heading once title and sections array are both visible', () => {
    const s = new ChapterStreamer(ctx);
    expect(s.push('{"title":"AI革命"')).toBe('');
    const out = s.push(',"sections":[');
    expect(out).toBe('## AI革命\n\n');
  });

  it('emits a section only after the next section starts (freeze heuristic)', () => {
    const s = new ChapterStreamer(ctx);
    s.push('{"title":"Ch","sections":[');
    const incremental = s.push('{"title":"A","question":"q?","answer_paragraphs":["ans"]}');
    expect(incremental).toBe('');
    const frozen = s.push(',{"title":"B"');
    expect(frozen).toContain('### A\n\n');
    expect(frozen).toContain('**Jen:** q?');
    expect(frozen).toContain('**Mark:** ans');
  });

  it('emits the last section on finish()', () => {
    const s = new ChapterStreamer(ctx);
    const json = JSON.stringify({
      title: '章',
      sections: [{ title: 'S', question: 'q', answer_paragraphs: ['a'] }],
    });
    const combined = s.push(json) + s.finish();
    expect(combined).toContain('## 章\n\n');
    expect(combined).toContain('### S\n\n');
    expect(combined).toContain('**Jen:** q');
    expect(combined).toContain('**Mark:** a');
  });

  it('uses ctx host_name / guest_name for attribution', () => {
    const s = new ChapterStreamer({ host_name: 'Host', guest_name: 'Guest' });
    const json = JSON.stringify({
      title: 'T',
      sections: [{ title: 'S', question: 'q', answer_paragraphs: ['a'] }],
    });
    const out = s.push(json) + s.finish();
    expect(out).toContain('**Host:** q');
    expect(out).toContain('**Guest:** a');
    expect(out).not.toContain('**Jen:**');
  });

  it('tolerates tiny fragments', () => {
    const s = new ChapterStreamer(ctx);
    const json = JSON.stringify({
      title: 'T',
      sections: [
        { title: 'A', question: 'qa', answer_paragraphs: ['aa'] },
        { title: 'B', question: 'qb', answer_paragraphs: ['ab'] },
      ],
    });
    let out = '';
    for (const ch of json) out += s.push(ch);
    out += s.finish();
    expect(out).toContain('## T');
    expect(out).toContain('### A');
    expect(out).toContain('### B');
    expect(out).toContain('**Mark:** aa');
    expect(out).toContain('**Mark:** ab');
  });
});
