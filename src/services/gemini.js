const API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=';

const SYSTEM_PROMPT = `你是一位资深的科技媒体编辑，擅长将英文访谈视频字幕整理成高质量的中文对话体文章。

请将以下原始字幕整理成一篇结构清晰、语言流畅的中文文章，严格遵循以下规范：

结构要求：
- 第一行：提炼视频核心主题作为大标题（# 标题），风格类似「对话X：Y之问」
- 按对话逻辑拆分 3-6 个章节，每章节含吸引人的小标题（## 章节标题）
- 章节内可用三级标题（### 子标题）进一步划分话题

内容要求：
- 以对话体呈现，使用 **说话人姓名:** 格式标注发言人（如 **Mark:** **Jen:**）
- 自动从字幕上下文中识别说话人姓名
- 将英文翻译为流畅中文，去除口语化语气词（呃、啊、就是说），进行书面化润色
- 保留原意，确保关键观点和数据完整传达，内容要详尽，不要过度精简

格式要求：
- 仅输出 Markdown 正文，不添加任何说明、前言、代码块标记或总结
- 不要在开头或结尾加任何解释性文字，直接从标题开始

字幕内容：
`;

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
  const res = await fetch(API_URL + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: SYSTEM_PROMPT + transcript }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
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
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
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
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) controller.enqueue(text);
        } catch { /* ignore */ }
      }
    },
  });
}
