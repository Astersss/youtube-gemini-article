import SYSTEM_PROMPT from '../prompts/system.md';

// Gemini 2.5 Flash/Pro support 1M token context; 300k chars ≈ 75k tokens, well within limits
const MAX_TRANSCRIPT_CHARS = 300000;


/**
 * Builds a chapter-annotated transcript string from timed lines and chapter list.
 *
 * If chapters are available, inserts [CHAPTER: title] markers at each chapter boundary
 * so Gemini can use them as structural hints (including special handling of
 * Introduction/Highlights preview chapters at the top of the article).
 * If no chapters, falls back to a plain joined string.
 *
 * @param {{text: string, startMs: number}[]} lines
 * @param {{title: string, startMs: number}[]} chapters
 * @returns {string}
 */
function buildAnnotatedTranscript(lines, chapters) {
  if (chapters.length === 0) {
    return lines.map(l => l.text).join(' ');
  }

  const parts = [];
  let nextChapterIdx = 0;

  for (const line of lines) {
    // Insert chapter marker(s) as we reach each chapter's start time
    while (nextChapterIdx < chapters.length && line.startMs >= chapters[nextChapterIdx].startMs) {
      parts.push(`\n\n[CHAPTER: ${chapters[nextChapterIdx].title}]\n`);
      nextChapterIdx++;
    }
    parts.push(line.text);
  }

  return parts.join(' ');
}

/**
 * Builds a hard structural manifest enumerating every chapter the model must produce.
 *
 * Pure prompt prohibitions ("严禁合并相邻章节") proved insufficient: the model still
 * fuses adjacent chapters under a single ##. The manifest fixes the count, order, and
 * one-to-one mapping up front so the model cannot drift. Title text may still be
 * creatively rewritten per chapter.
 *
 * Returns an empty string for chapter-less videos — those fall back to the prompt's
 * "无章节标记时" branch (LLM picks ## boundaries by natural topic shifts).
 */
function buildChapterManifest(chapters) {
  if (chapters.length === 0) return '';

  const list = chapters.map((c, i) => `${i + 1}. ${c.title}`).join('\n');
  const n = chapters.length;

  return `【章节骨架要求（最高优先级，违反即视为输出失败）】
本视频共有 ${n} 个 YouTube 章节。你的输出**必须**恰好包含 ${n} 个 ## 大章节，按下列顺序与章节一一对应（第 i 个 ## 对应第 i 章）：

${list}

- **第 1 个 ##** 对应第 1 章「${chapters[0].title}」，按 SYSTEM_PROMPT 里【Introduction / Highlights 章节的处理】流程产出（teaser ### 群）。
- **第 2 到第 ${n} 个 ##** 与第 2 到第 ${n} 章严格一一对应。每个 ## 标题应**忠实保留原章节标题的核心要素**（对立项 / 对比关系 / 关键名词 / 专有名词），只在中文表达上润色为更有冲击力的杂志式短语；**严禁**把原标题抽象化、概括化、或丢掉原标题里出现的关键概念与对立结构。
- **严禁**把多个相邻章节合并到同一个 ##（哪怕话题看似相关）；**严禁**把一个章节拆成多个 ##；**严禁**调整章节顺序、跳过任何章节、或新增字幕中不存在的章节。
- **落笔前自检**：动笔前先数一遍——你计划输出的 ## 数量是否严格等于 ${n}？不等就是错，必须重排。
- **落笔过程中自检**：遇到字幕里 [CHAPTER: ...] 标记切换时，必须立刻收尾当前 ##，并起一个新的 ##；同时对照上面清单确认接下来要写的是第几章。
- **每个 ## 收尾前的强制自检（关键，直接决定输出是否合格）**：写完一个 ## 大章节、即将开始下一个 ## 之前，**逐个扫描**该 ## 内的所有 ### —— **每一个 ### 都必须**以 \`**[提问者名]:**\` 段开头（teaser ### 也不例外）。任何只有 \`**[嘉宾名]:**\` 而没有 \`**[提问者名]:**\` 的 ###（即字幕里此处提问者并未真正换新问题、仅仅是嘉宾连续回答的话题延续），**必须**把它合并回上一个 ###——把 \`**[嘉宾名]:**\` 标注去掉，让这段内容作为上一个 ### 嘉宾回答的下一段（第二段及之后不重复姓名标注）。这一步不可省略，跳过即视为输出失败。

> 注：上述自检对应的完整 Q&A 配对硬约束（"每个 ### 必须有提问段 + 回答段"、"嘉宾跨话题继续讲不另起 ###"等）由 SYSTEM_PROMPT 的【Q&A 结构】section 详细规定，本骨架只负责强制执行自检动作，不复述规则。

────────────────────────────────────────
【字幕原文（含 [CHAPTER:] 标记）】

`;
}

/**
 * Calls Gemini streamGenerateContent and returns a ReadableStream of plain markdown text.
 * The SSE envelope is stripped by the extractGeminiText TransformStream.
 *
 * Pipeline: res.body → TextDecoderStream → extractGeminiText → ReadableStream<string>
 *
 * @param {{lines: {text: string, startMs: number}[], chapters: {title: string, startMs: number}[]}} transcriptData
 * @param {{apiKey: string, model: string}} config - apiKey from env.GEMINI_API_KEY, model from env.GEMINI_MODEL (e.g. 'gemini-2.5-flash')
 * @returns {Promise<ReadableStream<string>>} Stream of markdown text chunks
 * @throws {Error} If Gemini returns a non-2xx status (thrown before streaming starts)
 */
export async function streamArticle({ lines, chapters }, { apiKey, model }) {
  const full = buildAnnotatedTranscript(lines, chapters);
  const capped = full.length > MAX_TRANSCRIPT_CHARS
    ? full.slice(0, MAX_TRANSCRIPT_CHARS) + '…'
    : full;

  const manifest = buildChapterManifest(chapters);
  const userMessage = manifest + capped;

  // Diagnostic: log chapter structure to terminal so we can see what Gemini receives
  console.log(`[gemini] model: ${model}`);
  console.log(`[gemini] transcript stats: ${lines.length} lines, ${full.length} chars (capped: ${capped.length})`);
  console.log(`[gemini] chapters (${chapters.length}):`, chapters.map(c => `[${Math.round(c.startMs / 1000)}s] ${c.title}`).join(' | ') || '(none)');
  console.log(`[gemini] manifest: ${manifest ? `enforcing ${chapters.length} ## sections` : 'none (no chapters → freeform structure)'}`);

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 32768,
        // -1 = dynamic thinking budget (model decides). Pro doesn't support 0.
        thinkingConfig: { thinkingBudget: -1 },
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      throw new Error('Gemini API quota exceeded. Please wait a minute and try again, or enable billing at aistudio.google.com.');
    }
    if (res.status === 503) {
      throw new Error('Gemini model is temporarily overloaded. Please wait a minute and try again.');
    }
    throw new Error(`Gemini API error ${res.status}: ${body}`);
  }

  return res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(extractGeminiText());
}

/**
 * TransformStream that parses Gemini SSE lines and emits only the text content.
 *
 * Input:  string chunks (may span multiple SSE "data: {...}" lines)
 * Output: string chunks of raw markdown text
 *
 * Gemini SSE line format:
 *   data: {"candidates":[{"content":{"parts":[{"text":"..."}],"role":"model"}},...]}
 */
function extractGeminiText() {
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep the last incomplete line for the next chunk

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') continue;
        try {
          const data = JSON.parse(json);
          const candidate = data.candidates?.[0];
          const parts = candidate?.content?.parts ?? [];
          const text = parts.find(p => !p.thought)?.text;
          if (text) controller.enqueue(text);
          // Warn on any non-STOP finish (MAX_TOKENS, SAFETY, RECITATION, OTHER, etc.)
          const finish = candidate?.finishReason;
          if (finish && finish !== 'STOP') {
            console.warn(`[gemini] stream ended with finishReason=${finish}`, data.usageMetadata ?? '');
          }
        } catch {
          // skip malformed SSE chunks silently
        }
      }
    },

    flush(controller) {
      // process any text left in the buffer when the stream closes
      if (buffer.startsWith('data: ')) {
        try {
          const data = JSON.parse(buffer.slice(6));
          const parts = data.candidates?.[0]?.content?.parts ?? [];
          const text = parts.find(p => !p.thought)?.text;
          if (text) controller.enqueue(text);
        } catch { /* ignore */ }
      }
    },
  });
}
