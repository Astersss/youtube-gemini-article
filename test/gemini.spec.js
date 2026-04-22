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
  let body = '';
  for (let i = 0; i < text.length; i += size) {
    const slice = text.slice(i, i + size);
    const payload = { candidates: [{ content: { parts: [{ text: slice }] } }] };
    body += `data: ${JSON.stringify(payload)}\n\n`;
  }
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
    // Mock Math.random so retry delays are 0ms (avoids flaky timeouts).
    vi.spyOn(Math, 'random').mockReturnValue(0);
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

describe('streamArticle (multi-chapter: serial names → title, then per-chapter calls)', () => {
  beforeEach(() => vi.restoreAllMocks());

  const transcript = {
    lines: [
      { text: 'intro line',  startMs:     0 },
      { text: 'first body',  startMs: 10_000 },
      { text: 'second body', startMs: 20_000 },
    ],
    chapters: [
      { title: 'Introduction', startMs:     0 },
      { title: '硬件',         startMs: 10_000 },
      { title: '中国',         startMs: 20_000 },
    ],
  };

  const namesPayload = { host_name: 'Jen',               guest_name: 'Mark' };
  const titlePayload = { article_title: '对话Mark：AI革命' };
  const ch1Payload   = { title: '开场速览', sections: [{ title: 'T1',  question: 'q1', answer_paragraphs: ['a1'] }] };
  const ch2Payload   = { title: '硬件革命', sections: [{ title: 'GPU', question: 'q2', answer_paragraphs: ['a2'] }] };
  const ch3Payload   = { title: '中国格局', sections: [{ title: '芯片', question: 'q3', answer_paragraphs: ['a3'] }] };

  // Helper: stub 5 calls by index (names, title, ch1, ch2, ch3).
  const stubFive = () => {
    const responses = [
      mockSseForJson(namesPayload),
      mockSseForJson(titlePayload),
      mockSseForJson(ch1Payload),
      mockSseForJson(ch2Payload),
      mockSseForJson(ch3Payload),
    ];
    let callIdx = 0;
    vi.stubGlobal('fetch', vi.fn(async () => responses[callIdx++]));
  };

  it('makes 2 serial metadata calls + N chapter calls (total = 2 + N)', async () => {
    stubFive();
    const stream = await streamArticle(transcript, { apiKey: 'k', model: 'm' });
    const md = await drain(stream);

    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
    expect(md).toContain('# 对话Mark：AI革命');
    expect(md).toContain('## 开场速览');
    expect(md).toContain('### T1');
    expect(md).toContain('## 硬件革命');
    expect(md).toContain('### GPU');
    expect(md).toContain('## 中国格局');
    expect(md).toContain('### 芯片');
    expect(md.indexOf('## 开场速览')).toBeLessThan(md.indexOf('## 硬件革命'));
    expect(md.indexOf('## 硬件革命')).toBeLessThan(md.indexOf('## 中国格局'));
  });

  it('names call uses NAMES_SCHEMA, title call uses TITLE_SCHEMA, chapter calls use CHAPTER_SCHEMA', async () => {
    stubFive();
    await drain(await streamArticle(transcript, { apiKey: 'k', model: 'm' }));

    const schemaOf = i => JSON.parse(globalThis.fetch.mock.calls[i][1].body).generationConfig.responseSchema;
    const propsOf  = i => Object.keys(schemaOf(i).properties).sort().join(',');

    // Serial: call 0 is always Names, call 1 is always Title.
    expect(propsOf(0)).toBe('guest_name,host_name');
    expect(propsOf(1)).toBe('article_title');

    // Calls 2..4 are chapter calls.
    expect(propsOf(2)).toBe('sections,title');
    expect(propsOf(3)).toBe('sections,title');
    expect(propsOf(4)).toBe('sections,title');
  });

  it('title call failure throws before stream opens', async () => {
    const responses = [
      mockSseForJson(namesPayload),
      new Response('overloaded', { status: 503 }),
    ];
    let callIdx = 0;
    vi.stubGlobal('fetch', vi.fn(async () => responses[callIdx++]));

    await expect(
      streamArticle(transcript, { apiKey: 'k', model: 'm' })
    ).rejects.toThrow();
  });

  it('names call failure falls back to "主持人"/"嘉宾" and stream continues', async () => {
    // Mock Math.random so retry delays are 0ms (avoids test timeouts).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let chapterCallCount = 0;
    const chapterPayloads = [ch1Payload, ch2Payload, ch3Payload];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const props = Object.keys(body.generationConfig.responseSchema.properties).sort().join(',');
      if (props === 'guest_name,host_name') return new Response('overloaded', { status: 503 });
      if (props === 'article_title')        return mockSseForJson(titlePayload);
      return mockSseForJson(chapterPayloads[chapterCallCount++]);
    }));

    const stream = await streamArticle(transcript, { apiKey: 'k', model: 'm' });
    const md = await drain(stream);

    expect(md).toContain('# 对话Mark：AI革命');
    expect(md).toContain('**主持人:** q1');
    expect(md).toContain('**嘉宾:** a1');
  });

  it('chapter-call HTTP failure surfaces in-stream (after names+title succeed)', async () => {
    // Mock Math.random so retry delays are 0ms (avoids test timeouts).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const props = Object.keys(body.generationConfig.responseSchema.properties).sort().join(',');
      if (props === 'guest_name,host_name') return mockSseForJson(namesPayload);
      if (props === 'article_title')        return mockSseForJson(titlePayload);
      return new Response('overloaded', { status: 503 }); // all chapter calls fail
    }));

    const stream = await streamArticle(transcript, { apiKey: 'k', model: 'm' });
    const out = await drain(stream);
    expect(out).toMatch(/## ⚠️ 生成中断/);
    expect(out).toMatch(/overloaded/i);
  });

  it('throws on title-call HTTP 500 before stream opens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(
      streamArticle(transcript, { apiKey: 'k', model: 'm' })
    ).rejects.toThrow(/Gemini API error 500/);
  });

  it('chapter calls carry speaker names + YouTube chapter title, no article_title', async () => {
    stubFive();
    await drain(await streamArticle(transcript, { apiKey: 'k', model: 'm' }));

    const userMsgOf = i => JSON.parse(globalThis.fetch.mock.calls[i][1].body).contents[0].parts[0].text;
    const ytTitles = ['Introduction', '硬件', '中国'];
    for (let i = 0; i < 3; i++) {
      const msg = userMsgOf(i + 2); // chapter calls start at index 2
      expect(msg).toContain('主持人：Jen');
      expect(msg).toContain('嘉宾：Mark');
      expect(msg).toContain(ytTitles[i]);
      expect(msg).not.toContain('对话Mark：AI革命');
    }
  });
});
