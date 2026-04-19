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

  return `【硬性骨架要求（最高优先级，违反即视为输出失败）】
本视频共有 ${n} 个 YouTube 章节。你的输出**必须**恰好包含 ${n} 个 ## 大章节，按下列顺序与章节一一对应（第 i 个 ## 对应第 i 章）：

${list}

规则 A —— ## 大章节（不可协商）：
- **第 1 个 ##** 对应第 1 章「${chapters[0].title}」，按 SYSTEM_PROMPT 里【Introduction / Highlights 章节的处理】流程产出（teaser ### 群）。
- **第 2 到第 ${n} 个 ##** 与第 2 到第 ${n} 章严格一一对应。每个 ## 标题可基于对应章节标题**创意性地重写为有信息感的中文（杂志式措辞）**，但：
  · **严禁**把多个相邻章节合并到同一个 ##（哪怕话题看似相关）
  · **严禁**把一个章节拆成多个 ##
  · **严禁**调整章节顺序、跳过任何章节、或新增字幕中不存在的章节
- **落笔前自检**：动笔前先数一遍——你计划输出的 ## 数量是否严格等于 ${n}？不等就是错，必须重排。
- **落笔过程中自检**：每写完一个 ## 大章节，对照上面清单确认下一个该写哪一章；遇到字幕里 [CHAPTER: ...] 标记切换时，必须立刻收尾当前 ## 并起一个新的 ##。

规则 B —— ### 小节（同样不可协商，模型最常违反）：
- **每个 ### 必须以一段 \`**[提问者名]:** ...\` 开头，紧接一段 \`**[嘉宾名]:** ...\` 的回答**。两段都缺一不可。
- **严禁**把嘉宾在同一个提问下的连续回答按"话题/段落"切成多个 ###——表现就是后面的 ### 里只有 \`**[嘉宾名]:**\` 而没有 \`**[提问者名]:**\`。这是错误。
- 判断口诀：每打算起一个新 ###，先自问——**字幕里此处提问者是不是真的换了一个新问题？** 若不是 → **不许另起 ###**，把这部分内容并入上一个 ### 的回答段里，作为新的一段继续写（嘉宾回答可以多段，第二段及之后**不再重复姓名标注**）。
- 这条规则在 ## 内部**必须**和 SYSTEM_PROMPT 的 Q&A 结构要求叠加生效；它的优先级**高于**"切多一些 ### 看起来更结构化"的冲动。
- **每个 ## 收尾前自检**：把刚写完的 ## 里所有 ### 扫一遍，**每一个 ### 都必须**有 \`**[提问者名]:**\` 段，否则要么补提问、要么把它合并回上一个 ###。即便是 teaser ###（第 1 个 ## 内部），也**必须**反向构造提问段。

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
        thinkingConfig: { thinkingBudget: 0 },
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
