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

describe('streamArticle (multi-chapter: metadata call + one call per chapter)', () => {
  beforeEach(() => vi.restoreAllMocks());

  const transcript = {
    lines: [
      { text: 'intro line',  startMs:     0 },
      { text: 'first body',  startMs: 10_000 },
      { text: 'second body', startMs: 20_000 },
    ],
    chapters: [
      { title: '开场预览', startMs:     0 },
      { title: '硬件',     startMs: 10_000 },
      { title: '中国',     startMs: 20_000 },
    ],
  };

  // Call 0: METADATA_SCHEMA shape (no chapters/sections).
  const metaPayload = {
    article_title: '对话Mark：AI革命',
    host_name:     'Jen',
    guest_name:    'Mark',
  };
  // Calls 1..N: CHAPTER_SCHEMA shape.
  const ch1Payload = { title: '开场速览', sections: [{ title: 'T1',  question: 'q1', answer_paragraphs: ['a1'] }] };
  const ch2Payload = { title: '硬件革命', sections: [{ title: 'GPU', question: 'q2', answer_paragraphs: ['a2'] }] };
  const ch3Payload = { title: '中国格局', sections: [{ title: '芯片', question: 'q3', answer_paragraphs: ['a3'] }] };

  const stubFour = () => vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(mockSseForJson(metaPayload))
    .mockResolvedValueOnce(mockSseForJson(ch1Payload))
    .mockResolvedValueOnce(mockSseForJson(ch2Payload))
    .mockResolvedValueOnce(mockSseForJson(ch3Payload)));

  it('makes 1 metadata call + N chapter calls and assembles the document', async () => {
    stubFour();
    const stream = await streamArticle(transcript, { apiKey: 'k', model: 'm' });
    const md = await drain(stream);

    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(md).toContain('# 对话Mark：AI革命');
    expect(md).toContain('## 开场速览');
    expect(md).toContain('### T1');
    expect(md).toContain('## 硬件革命');
    expect(md).toContain('### GPU');
    expect(md).toContain('## 中国格局');
    expect(md).toContain('### 芯片');
    // Document order matches call order.
    expect(md.indexOf('## 开场速览')).toBeLessThan(md.indexOf('## 硬件革命'));
    expect(md.indexOf('## 硬件革命')).toBeLessThan(md.indexOf('## 中国格局'));
  });

  it('first call uses METADATA_SCHEMA; chapter calls use CHAPTER_SCHEMA', async () => {
    stubFour();
    await drain(await streamArticle(transcript, { apiKey: 'k', model: 'm' }));

    const schemaOf = i => JSON.parse(globalThis.fetch.mock.calls[i][1].body).generationConfig.responseSchema;
    // Metadata: only the 3 preamble fields, no chapters.
    expect(schemaOf(0).required).toEqual(
      expect.arrayContaining(['article_title', 'host_name', 'guest_name'])
    );
    expect(Object.keys(schemaOf(0).properties)).not.toContain('chapters');
    // Chapter calls: only title + sections.
    expect(schemaOf(1).required).toEqual(expect.arrayContaining(['title', 'sections']));
    expect(Object.keys(schemaOf(1).properties)).not.toContain('article_title');
    expect(schemaOf(3).required).toEqual(expect.arrayContaining(['title', 'sections']));
  });

  it('chapter calls carry speaker names + YouTube chapter title, but NOT article_title', async () => {
    stubFour();
    await drain(await streamArticle(transcript, { apiKey: 'k', model: 'm' }));

    const userMsgOf = i => JSON.parse(globalThis.fetch.mock.calls[i][1].body).contents[0].parts[0].text;
    // Metadata call: full transcript, IS the preamble extractor.
    expect(userMsgOf(0)).toContain('article_title');
    // Chapter calls 1..3: speaker names + YouTube chapter title as positive anchor.
    // Article_title is intentionally OMITTED — repeating the H1 text in chapter
    // prompts primes the model to emit it inside the H2 title field.
    const ytTitles = ['开场预览', '硬件', '中国'];
    for (const i of [1, 2, 3]) {
      expect(userMsgOf(i)).toContain('主持人：Jen');
      expect(userMsgOf(i)).toContain('嘉宾：Mark');
      expect(userMsgOf(i)).toContain(ytTitles[i - 1]);
      expect(userMsgOf(i)).not.toContain('对话Mark：AI革命');
    }
  });

  it('throws (does not return a stream) on metadata-call HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(
      streamArticle(transcript, { apiKey: 'k', model: 'm' })
    ).rejects.toThrow(/Gemini API error 500/);
  });

  it('emits an in-stream error block on chapter-call HTTP failure (HTTP 200 already sent, must surface in-band)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockSseForJson(metaPayload))
      .mockResolvedValueOnce(new Response('overloaded', { status: 503 }))
    );
    const stream = await streamArticle(transcript, { apiKey: 'k', model: 'm' });
    const out = await drain(stream);
    expect(out).toMatch(/## ⚠️ 生成中断/);
    expect(out).toMatch(/overloaded/i);
  });
});
