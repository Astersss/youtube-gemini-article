import SYSTEM_PROMPT from '../prompts/system.md';
import { ARTICLE_SCHEMA, CHAPTER_SCHEMA, NAMES_SCHEMA, TITLE_SCHEMA } from './schema.js';
import { SectionStreamer, ChapterStreamer, tryLenientParse } from './stream-render.js';
import { renderPreamble } from './renderer.js';
import { extractNameSnippets } from './extract-names.js';

// Gemini 2.5 Flash/Pro support 1M token context; 300k chars ≈ 75k tokens.
const MAX_TRANSCRIPT_CHARS = 300_000;
const SEP = '━'.repeat(56);

const SAFETY_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

// ── Transcript helpers ────────────────────────────────────────────────────────

const cap = s => s.length > MAX_TRANSCRIPT_CHARS ? s.slice(0, MAX_TRANSCRIPT_CHARS) + '…' : s;

function getChapterLines(lines, chapters, i) {
  const start = chapters[i].startMs;
  const end   = chapters[i + 1]?.startMs ?? Infinity;
  return lines.filter(l => l.startMs >= start && l.startMs < end);
}

function chapterBlock(i, chapters, chLines) {
  const ch = chapters[i];
  const content = cap(chLines.map(l => l.text).join(' '));
  return `\n\n${SEP}\n【第${i + 1}章 / 共${chapters.length}章】${ch.title}\n→ 本段字幕仅产生 chapters[${i}].sections\n${SEP}\n\n${content}`;
}

// ── User-message builders ─────────────────────────────────────────────────────

// ── Names / Title message builders ────────────────────────────────────────────

/**
 * Names-extraction message. Feeds snippet-extracted transcript excerpts
 * (~1-5k chars) plus the chapter list to the model and asks for host_name /
 * guest_name only. Much cheaper than the old full-transcript metadata call.
 */
function buildNamesMsg(lines, chapters) {
  const snippets = extractNameSnippets(lines, chapters);
  return `【任务：从下列片段识别主持人/嘉宾姓名，只输出 host_name 和 guest_name 两个字段】

${snippets}

规则：
- 通读上面的字幕片段，找出主持人（常说"Thanks X""welcome X""X, what do you think"）和嘉宾（常在"my guest is X""嘉宾是X"句中）的名字
- 保留原语言短名，不要音译（英文名用英文短名，中文名用中文全名）
- 实在识别不出就留空字符串，下游会渲染成"主持人"/"嘉宾"`;
}

const INTRO_CHAPTER_PATTERN =
  /introduction|intro|highlights|teaser|preview|recap|开场|预告|精彩看点/i;

/**
 * Title-extraction message. Shows the chapter list (core structural signal)
 * plus the first chapter's transcript IF it looks like an intro/highlights
 * chapter — those usually contain the episode's core thesis in condensed
 * form. Otherwise only the chapter list is sent.
 */
function buildTitleMsg(lines, chapters) {
  const list = chapters.map((c, i) => `${i + 1}. ${c.title}`).join('\n');

  let introBlock = '';
  if (chapters.length > 0 && INTRO_CHAPTER_PATTERN.test(chapters[0].title)) {
    const ch0Lines = getChapterLines(lines, chapters, 0);
    const ch0Text = cap(ch0Lines.map(l => l.text).join(' '));
    introBlock = `\n\n【第 1 章字幕（${chapters[0].title}，含全片核心判断）】\n\n${ch0Text}`;
  }

  return `【任务：只输出 article_title 一个字段】

这期视频是访谈/对话类，共 ${chapters.length} 章，结构如下：

${list}${introBlock}

请按以下规则拟标题：
- 格式必须为："对话{受访者全名}：{凝练的判断性短语}"
- 受访者全名用名+姓（英文）或中文全名，不能只用姓氏
- 判断性短语须有"冲突 / 张力 / 转折 / 立场"，不能是"XX谈AI"这种中性描述
- 【反例】"对话X：AI的未来"（太空泛，没判断）
- 【正例结构】"对话{全名}：{具体领域}的{具体矛盾或判断}"`;
}

/**
 * No-chapter message. Single Gemini call, model sees the full transcript and
 * decides chapter structure itself. This is the only call where teaser/main
 * de-duplication rules apply (since both halves are visible in one prompt) —
 * those rules live here, not in system.md, to keep per-chapter prompts clean.
 */
function buildNoChapterMsg(lines) {
  const fullText = cap(lines.map(l => l.text).join(' '));
  return `这个视频**没有章节标记**，请通读完整字幕后按内容自然话题切分章节，按 schema 输出完整文章。

【字段产出顺序（极其重要）】
**必须**先把 article_title、host_name、guest_name 三个字段写完整，再开始写 chapters。下游流式渲染依赖它们先到位。

【chapters 划分】
- 按内容自然话题切分，每个 chapter 对应一个独立大话题。
- 视频开头若是 Introduction / Highlights / Teaser / Preview 类预览段（嘉宾在没被提问的情况下连续讲了几个不同话题的金句，话题跳跃、点到为止），第 1 个 chapter 视为 teaser 章节，按 SYSTEM_PROMPT【Introduction 章节处理】拆 N 个 teaser sections。
- chapter title 严格按 SYSTEM_PROMPT 的「抽象主题：冲击表述」双栏模板写，**不得**是 article_title 的改写或同义复述。
- sections[].title 是三级标题，使用动态名词短语（见 SYSTEM_PROMPT），**严禁**使用双栏格式（双栏只用于 chapter title）。

【teaser 与正片的去重规则（仅本场景适用——你看得到完整字幕）】
你看得到完整字幕，可能会发现 teaser 里某个话题在后续正片章节又被详细讨论。处理规则：
- **teaser section 一律全部保留**，即使该话题正片还会讲。规则是"剪正片不剪 teaser"。
- 正片和 teaser 的 section title 不能字面重复——正片用体现"多了什么新切面"的标题。
- 若正片某段只是把 teaser 内容换词复述、没有新案例/论据/历史/结论，该正片段跳过不单独成 section。
- 独白型 teaser 在正片找到对应详细讨论时，可以借用正片提问作为该 teaser 的 question 字段，但 section 仍放 chapters[0]，**不得**因为"正片才有完整提问"而把该 teaser 内容移入正片章节。

────────────────────────────────────────
【字幕全文】

${fullText}`;
}

/**
 * Per-chapter message. Receives speaker names from the metadata call + only
 * that chapter's transcript. We deliberately do NOT show article_title here:
 * repeating the H1 text in the prompt primes the model to put it inside the
 * H2 `title` field. Instead we point at the YouTube chapter title as the
 * positive anchor for rewriting.
 */
function buildChapterMsg(i, chapters, chLines, ctx) {
  const ytTitle = chapters[i].title;
  const isTeaser = i === 0 && /introduction|intro|preview|highlights|teaser|recap|开场|预告|精彩看点/i
    .test(ytTitle);
  const teaserNote = isTeaser
    ? '\n- 第 1 章是 Teaser/Introduction，按 SYSTEM_PROMPT【Introduction 章节处理】流程产出 teaser sections。'
    : '';

  return `${ctx.host_name ? `主持人：${ctx.host_name}，` : ''}嘉宾：${ctx.guest_name}

第 ${i + 1} 章 / 共 ${chapters.length} 章——按 schema 输出 title 和 sections。

- title 是本章的 H2 章节小标题，请按 SYSTEM_PROMPT【章节 title 双栏结构】+【双模式选择】要求构造：
  · 以本章 YouTube 原标题「${ytTitle}」为语义锚点，结合本章字幕实际内容改写为"抽象主题：冲击短语/列举"
  · **双模式判断**：
    - 本章主持人只问 1-2 个紧密相关的问题、嘉宾围绕它深度展开 → 单主题章，右半用冲击短语
    - 本章主持人问了 ≥ 3 个跳跃话题（teaser 串联、闪电问答） → 多话题章，右半可用"A、B 与 C"列举
  · **硬约束**：title 里**不得**出现"${ctx.guest_name}"${ctx.host_name && ctx.host_name !== '主持人' ? `、"${ctx.host_name}"` : ''}、"对话"、"访谈"、"专访"等词——章节小标题只描述本章主题，不指代访谈本身
  · **严禁**从任何范本列表里挑选标题；每章都基于该章实际内容现造${teaserNote}
- sections[].title 是 H3 三级标题：10-18 字动态名词短语（含具象对象 + 方向性动词），**严禁**使用「抽象主题：冒号：冲击表述」双栏格式——双栏格式只属于章节 title（H2），section title 不用冒号。
${chapterBlock(i, chapters, chLines)}`;
}

// ── Gemini API layer ──────────────────────────────────────────────────────────

// Retry 503 (overloaded) and 429 (quota) with exponential backoff + jitter.
// These are the only Gemini failures that benefit from waiting; everything
// else (400 schema errors, 401 bad key) is terminal.
const RETRY_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [2000, 5000, 12000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(userMessage, schema, { apiKey, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingBudget: 2048 },
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
    safetySettings: SAFETY_OFF,
  });

  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) return res;

    lastStatus = res.status;
    lastBody = await res.text();

    if (!RETRY_STATUSES.has(res.status) || attempt === RETRY_DELAYS_MS.length) break;

    // Full jitter: delay = random(0, base). Keeps concurrent clients from
    // synchronizing and re-hammering the API at the same moment.
    const base = RETRY_DELAYS_MS[attempt];
    const delay = Math.floor(Math.random() * base);
    console.warn(`[gemini] ${res.status} on attempt ${attempt + 1}, retrying in ${delay}ms`);
    await sleep(delay);
  }

  const mkError = (msg, status) => Object.assign(new Error(msg), { upstreamStatus: status });
  if (lastStatus === 429) throw mkError(
    'Gemini API quota exceeded after retries. Please wait a minute and try again, or enable billing at aistudio.google.com.',
    429,
  );
  if (lastStatus === 503) throw mkError(
    'Gemini model is still overloaded after retries. Please wait a minute and try again.',
    503,
  );
  throw mkError(`Gemini API error ${lastStatus}: ${lastBody}`, lastStatus);
}

/** TransformStream: SSE wire format → inner `parts[].text` strings. */
function sseTextParts() {
  let buf = '';
  const handleLine = (line, controller) => {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') return;
    try {
      const data = JSON.parse(payload);
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.find(p => !p.thought)?.text;
      if (text) controller.enqueue(text);
      const finish = candidate?.finishReason;
      if (finish && finish !== 'STOP') {
        console.warn(`[gemini] stream ended with finishReason=${finish}`, data.usageMetadata ?? '');
      }
    } catch { /* skip malformed SSE */ }
  };
  return new TransformStream({
    transform(chunk, controller) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) handleLine(line, controller);
    },
    flush(controller) {
      if (buf.startsWith('data: ')) handleLine(buf, controller);
    },
  });
}

/** Read a Gemini SSE response and return the accumulated raw JSON text. */
async function readJson(res) {
  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(sseTextParts())
    .getReader();
  let json = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    json += value;
  }
  return json;
}

/**
 * Drain one Gemini SSE response through `streamer`, enqueuing Markdown
 * fragments into `controller` as each piece freezes.
 */
async function drain(res, streamer, controller) {
  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(sseTextParts())
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const md = streamer.push(value);
    if (md) controller.enqueue(md);
  }
  const tail = streamer.finish();
  if (tail) controller.enqueue(tail);
}

/**
 * Wraps an async driver in a ReadableStream<string> that closes/errors based
 * on the driver's resolution.
 */
function makeStream(driver) {
  return new ReadableStream({
    async start(controller) {
      try {
        await driver(controller);
      } catch (err) {
        // HTTP status is already 200 by the time the stream starts, so errors
        // can't propagate via response status. Emit them as in-band Markdown
        // so the client can render them alongside whatever was already streamed.
        console.error('[stream] driver failed:', err?.message, err?.stack);
        const msg = err?.message ?? String(err);
        controller.enqueue(`\n\n## ⚠️ 生成中断\n\n**${msg}**\n\n`);
      }
      controller.close();
    },
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a streaming Markdown article from transcript data.
 *
 * - **No chapters**: a single Gemini call with the full transcript, model
 *   decides article structure on its own.
 * - **With chapters**: one upfront metadata call (full transcript → article_
 *   title + speaker names), then one call per chapter, sequential. Each
 *   chapter call sees only its own transcript slice + the shared metadata
 *   context. This physical isolation eliminates the "+1 chapter offset"
 *   bug and lets speaker names be found wherever they appear in the video.
 *
 * Errors from the metadata call (or, in the no-chapter case, the single
 * call) throw before a stream is returned. Errors from later chapter calls
 * surface as stream errors via the controller.
 *
 * @param {{ lines: {text:string, startMs:number}[], chapters: {title:string, startMs:number}[] }} transcriptData
 * @param {{ apiKey: string, model: string }} config
 * @returns {Promise<ReadableStream<string>>}
 */
export async function streamArticle({ lines, chapters }, config) {
  const fullText = lines.map(l => l.text).join(' ');
  console.log(`[gemini] model: ${config.model}`);
  console.log(`[gemini] transcript: ${lines.length} lines, ${fullText.length} chars`);
  console.log(
    `[gemini] chapters (${chapters.length}):`,
    chapters.map(c => `[${Math.round(c.startMs / 1000)}s] ${c.title}`).join(' | ') || '(none)',
  );

  if (chapters.length === 0) {
    const res = await callGemini(buildNoChapterMsg(lines), ARTICLE_SCHEMA, config);
    return makeStream(controller => drain(res, new SectionStreamer(), controller));
  }

  // Step 1a: Names call (failure is graceful — falls back to 主持人/嘉宾).
  // Sequential before Title so both calls don't hammer Gemini simultaneously.
  console.log(`[gemini/meta] names call`);
  let host_name = '主持人';
  let guest_name = '嘉宾';
  try {
    const namesRes  = await callGemini(buildNamesMsg(lines, chapters), NAMES_SCHEMA, config);
    const namesJson = await readJson(namesRes);
    const namesData = tryLenientParse(namesJson) ?? {};
    const h = (namesData.host_name  ?? '').trim();
    const g = (namesData.guest_name ?? '').trim();
    if (h) host_name  = h;
    if (g) guest_name = g;
  } catch (err) {
    console.warn('[gemini/names] call failed, falling back to 主持人/嘉宾:', err?.message);
  }

  // Step 1b: Title call (failure is terminal — abort before opening the stream).
  console.log(`[gemini/meta] title call`);
  const titleRes  = await callGemini(buildTitleMsg(lines, chapters), TITLE_SCHEMA, config);
  const titleJson = await readJson(titleRes);
  const titleData = tryLenientParse(titleJson) ?? {};
  const article_title = (titleData.article_title ?? '').trim();
  if (!article_title) {
    throw new Error('Title call returned empty article_title');
  }

  // If names call couldn't identify the guest, try parsing from the article title.
  // Title format: "对话{guest_full_name}：{tagline}"
  if (guest_name === '嘉宾') {
    const m = article_title.match(/^对话([^：:]+)[：:]/);
    const guestFromTitle = (m?.[1] ?? '').trim();
    if (guestFromTitle) {
      guest_name = guestFromTitle;
      console.log(`[gemini/meta] guest name extracted from title: "${guest_name}"`);
    }
  }

  const ctx = { article_title, host_name, guest_name };
  console.log(`[gemini/meta] title="${article_title}" host="${host_name}" guest="${guest_name}"`);

  // Step 2: preamble + N per-chapter calls (sequential).
  // interChapterDelayMs (default 0) can be set by the caller to pace requests
  // and avoid 429 rate-limit errors when a video has many chapters.
  const interChapterDelayMs = config.interChapterDelayMs ?? 0;
  return makeStream(async controller => {
    controller.enqueue(renderPreamble({ article_title }));
    for (let i = 0; i < chapters.length; i++) {
      if (i > 0 && interChapterDelayMs > 0) await sleep(interChapterDelayMs);
      console.log(`[gemini/ch${i + 1}] chapter ${i + 1}/${chapters.length}`);
      const res = await callGemini(
        buildChapterMsg(i, chapters, getChapterLines(lines, chapters, i), ctx),
        CHAPTER_SCHEMA,
        config,
      );
      await drain(res, new ChapterStreamer(ctx), controller);
    }
  });
}
