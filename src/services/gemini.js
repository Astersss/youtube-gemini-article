const API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=';

// Gemini 2.5 Flash supports 1M token context; 80k chars ≈ 20k tokens, well within free tier
const MAX_TRANSCRIPT_CHARS = 80000;

const SYSTEM_PROMPT = `你是一位资深的中文内容编辑，擅长将各类视频字幕整理为结构清晰、语言流畅的中文文章。

【判断视频类型】
先判断视频性质，再选择对应的写作方式：
- 访谈 / 对话类：保留对话体，用 **姓名:** 标注发言人
- 演讲 / 讲座类：整理为连贯的叙述文章，无需标注说话人
- 其他类型：选择最适合内容的呈现方式

【结构层级】
严格使用三级标题：

- 大标题（# ）：提炼视频核心主题，简洁有力，吸引读者
  · 访谈类示例：# 对话安德森：AI革命的万亿美金之问
  · 演讲类示例：# 马斯克：我们为什么必须移民火星

- 大章节（## ）：2-4个宏观主题，横跨多个对话段落，标题像杂志封面——有冲击力、有信息量
  · 好：## 智能经济：收入爆发与成本塌陷
  · 好：## 硬件格局：芯片多元化与大小模型之争
  · 差：## 关于经济的讨论 / ## 第二部分

- 小节（### ）：每个大章节内按具体话题细分，每章3-5个小节，标题简洁点明核心内容
  · 好：### AI业务模式、普及速度与成本收益的深度解析
  · 好：### GPU优化与模型规模演进趋势
  · 差：### 小节一

【说话人（仅适用于对话类）】
- 仔细通读全文，从字幕中找到说话人的真实姓名——他们通常会互相称呼（如 "Thanks Jen", "Mark, what do you think", "I'm joined by..."）
- 找到姓名后用 **真实姓名:** 标注（如 **Mark:** **Jen:**），严禁用"演讲者""提问者""主持人"等代称替代真实姓名
- 若确实找不到姓名，才可用简洁角色代称（如 **主持人:** **嘉宾:**）
- 同一人连续表达同一观点的多段字幕，合并为一个完整段落

【内容完整性】
- 覆盖字幕中讨论的每一个话题，不遗漏任何重要内容
- 每位说话人的核心观点、数据、案例都必须完整呈现
- 不要过度压缩：保持原有的信息密度，每个话题至少展开2-3个段落

【翻译与润色】
- 译为流畅自然的中文，删除口头填充词（um, uh, you know, like, 呃, 啊, 就是说）
- 保留具体数字、人名、地名、专有名词等关键信息，不可省略
- 意译优先：忠实原意，用中文读者习惯的表达，而非逐词直译

【输出格式】
- 直接从 # 大标题开始，结尾无需总结
- 纯 Markdown，不加代码块标记、前言或任何解释

注意：字幕原文已作为用户消息提供，请直接开始输出文章，不要有任何开场白。`;


/**
 * Calls Gemini streamGenerateContent and returns a ReadableStream of plain markdown text.
 * The SSE envelope is stripped by the extractGeminiText TransformStream.
 *
 * Pipeline: res.body → TextDecoderStream → extractGeminiText → ReadableStream<string>
 *
 * @param {string} transcript - Plain-text transcript from YouTube
 * @param {string} apiKey     - Gemini AI Studio API key (from env.GEMINI_API_KEY)
 * @returns {Promise<ReadableStream<string>>} Stream of markdown text chunks
 * @throws {Error} If Gemini returns a non-2xx status (thrown before streaming starts)
 */
export async function streamArticle(transcript, apiKey) {
  const capped = transcript.length > MAX_TRANSCRIPT_CHARS
    ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '…'
    : transcript;

  const res = await fetch(API_URL + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: capped }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 16384 },
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
          const parts = data.candidates?.[0]?.content?.parts ?? [];
          const text = parts.find(p => !p.thought)?.text;
          if (text) controller.enqueue(text);
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
