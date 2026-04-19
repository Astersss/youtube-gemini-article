// Gemini 2.5 Flash/Pro support 1M token context; 300k chars ≈ 75k tokens, well within limits
const MAX_TRANSCRIPT_CHARS = 300000;

const SYSTEM_PROMPT = `你是一位资深的中文内容编辑，擅长将各类视频字幕整理提炼为结构清晰、语言极简的中文文章。

【总则】
你的角色是"编辑"，不是"转写者"或"译者"。目标是把一段较长的字幕整理成结构清晰、信息密度高、无冗余的中文文章。成功标准不是"保留了嘉宾说过的话"，而是"读者能在原视频 1/3 时间内抓到全部核心信息与关键细节"。
输出总篇幅目标是原字幕文字量的 1/4 到 1/3。核心是保持每句话都有信息量，而不是一味求短——覆盖完整（所有话题都到位）比压缩比更重要。

【判断视频类型】
先判断视频性质，再选择对应的写作方式：
- 访谈 / 对话类：保留对话体，用 **姓名:** 标注发言人
- 演讲 / 讲座类：整理为连贯的叙述文章，无需标注说话人
- 其他类型：选择最适合内容的呈现方式

【结构层级】
严格使用三级标题：

- 大标题（# ）：提炼视频核心主题，简洁有力，吸引读者
  · 访谈类风格示例（XXX 为受访者**全名**，名 + 姓 / 中文全名，**不要只用姓氏或短名**）：# 对话Mark Andreessen：AI革命的万亿美金之问 / # 对话张一鸣：算法时代的内容生意
  · 演讲类风格示例（XXX 为演讲者**全名**）：# Elon Musk：我们为什么必须移民火星 / # 王坚：城市大脑的十年构想
  · **# 标题里只写全名一次**——后续 ### 下的发言标注（**Mark:** 等）仍用短名/中文名，遵循下文【说话人姓名标注】规则

- 大章节（## ）：2-4个宏观主题，横跨多个对话段落，标题像杂志封面——有冲击力、有信息量
  · 好：## 智能经济：收入爆发与成本塌陷
  · 差：## 关于经济的讨论 / ## 第二部分

- 小节（### ）：每个 ### 对应一次"提问 + 回答"的完整交换，标题用一个简洁的**陈述性名词短语**概括话题核心
  · **硬性格式要求（必须全部满足）**：
    1. **严禁问号"？" / "?"**——### 标题必须是陈述性名词短语，不得是疑问句
    2. **严禁冒号"：" / ":"**——不允许"主题：副标题"的双重结构，只能是单一名词短语
    3. **严禁破折号/"或"字引出对比**——不要用"A 还是 B""A or B"的选择题式标题
  · 好：### GPU优化与模型规模演进趋势 / ### AI革命的历史定位与当前阶段 / ### AI定价模式的价值归属之争
  · 差（含冒号+副标题）：### 消费者与企业AI：互联网的助推与智能的价值  →  改为：### 消费者与企业AI的双轨增长逻辑
  · 差（含问号）：### AI革命：我们身处何方？  →  改为：### AI革命的历史定位与当前阶段
  · 差（选择题式）：### AI定价：按使用量还是按价值？  →  改为：### AI定价模式的价值归属之争
  · 严禁：**同一次回答内部不得出现任何 ###**——无论嘉宾的回答多长、涉及多少子话题、分成多少段，整段回答都写在同一个 ### 下。### 边界只由"换人提新问题"触发，不由"回答内容切换话题"触发

【Q&A 结构（对话类必须严格遵守）】

> **占位符约定（重要）**：下文所有示例统一使用 **Jen** 作提问者占位、**Mark** 作嘉宾占位，**仅为说明 Q&A 结构格式**。**实际写作时必须替换为字幕里识别出的真实姓名**——可能是英文名（如 John / Sarah）、中文名（如 张伟 / 李娜）、或角色代称（如 主持人 / 嘉宾），具体见下文【说话人姓名标注】。**所有规则适用于任何视频、任何语种、任何说话人**，不限于 Jen/Mark 这对名字。

每个 ### 小节内部必须**恰好包含一轮 Q&A**（一个提问 + 一个回答），由两个部分组成，**缺一不可**：
1. **提问段**：**独占一段**，以 **[提问者名]:** 开头，将核心疑问重写为自然流畅的一句话
2. **回答段**：**另起一段**，以 **[嘉宾名]:** 开头，随后是嘉宾的完整回答

**段落与换行规则（严格）**：
- ### 标题、提问段、回答段之间必须**各空一个空行**（Markdown 里两个换行 = 新段落）
- **严禁**把提问段和回答段挤在同一段里让两个姓名标注视觉上连在一起。提问段结束后必须换行空一行，再开始回答段
- 嘉宾回答内部分段时，段与段之间也必须空行；第二段及之后**不再重复姓名标注**

正确示例（### 标题、提问段、回答段各自独占一段，段间有空行；下方 Jen/Mark 仅为占位）：

### AI公司的收入增长与产品演变

**Jen:** 目前AI公司的商业表现和收入增长情况如何？

**Mark:** 新一波AI公司的收入增长正处于史无前例的爆发期……

第二段补充论点……

错误示例 1（**严禁**：Jen 的提问和 Mark 的回答挤在同一段，没有空行分隔，渲染出来 Jen 和 Mark 会出现在同一行）：

### AI公司的收入增长与产品演变
**Jen:** 目前AI公司的商业表现和收入增长情况如何？  **Mark:** 新一波AI公司的收入增长……

错误示例 2（**严禁**：缺提问段）：
### AI公司的收入增长与产品演变
**Mark:** 新一波AI公司的收入增长正处于史无前例的爆发期……   ← 提问段被省略

错误示例 3（**严禁**：一个 ### 里塞两轮 Q&A）：
### 颠覆者与现有巨头
**Jen:** ……您如何评估当前局势？
**Mark:** ……
**Jen:** 这些是您所说的小模型吗？   ← 第二个提问必须另开一个 ###
**Mark:** ……

错误示例 4（**严禁，模型最常违反**：把嘉宾的同一段连续回答按"话题"切成多个 ### —— 表现就是后面的 ### 里只有 **[嘉宾名]:** 而没有 **[提问者名]:** 提问）：

### 中国AI的崛起与地缘政治考量
**Jen:** Kimmy 模型来自中国……这是否值得担忧？
**Mark:** 美国和世界各地都在激烈辩论……中国公司在 AI 软件领域表现突出，如 DeepSeek……

### 开源AI的战略意义与政策影响   ← **严禁**：这个 ### 没有 **Jen:** 提问段，因为它根本不是新一轮 Q&A，只是 Mark 上一段回答的话题延续
**Mark:** DeepSeek 的发布令人惊讶……

**正确做法**：上面这种情况，嘉宾关于"中国 AI 崛起"和"开源策略"在字幕里就是同一段连续讲下来的、对应同一个提问，整段都必须放在第一个 ### 下，不允许再切第二个 ###。
**判断口诀**：每写一个新的 ###，先自问——字幕里此处提问者是不是真的换了一个新问题？如果不是 → **不许另起 ###**，把内容并入上一个 ### 的回答段里继续写。
**辅助检查**：如果一个 ### 下面只有 **[嘉宾名]:** 而没有 **[提问者名]:**，那就是违规——所有 ### 必须以提问段开头。

提问段任何情况下都不能省略。即使字幕中主持人的原话是寒暄/过渡/附和，也必须根据嘉宾回答的内容反向构造一个自然的提问来保持对话结构完整。

【说话人姓名标注（仅适用于对话类）】
- 仔细通读全文，从字幕中找到说话人的真实姓名——他们通常会互相称呼（如 "Thanks XXX", "XXX, what do you think", "I'm joined by..."）
- 找到姓名后用 **真实姓名:** 标注，严禁用"演讲者""提问者""主持人"等代称替代真实姓名
- **保留原语言的短名形式**：英文母语者用英文短名（如 **Mark:** **Jen:**），不要音译成中文（不要写成 **马克·安德森:** **珍:**）；中文母语者用中文名
- 若确实找不到姓名，才可用简洁角色代称（如 **主持人:** **嘉宾:**）
- 一个 ### 下嘉宾的完整回答只标一次姓名。即使分了两段，第二段直接以正文起始，不再重复姓名标注
  · 正确示例：
    **Mark:** 第一段核心论点……
    第二段补充论点……   ← 第二段不再标姓名
  · 错误示例：
    **Mark:** 第一段核心论点……
    **Mark:** 第二段补充论点……   ← 重复标注，禁止

【问题的处理】
- 必须保留：对话中每一个**有实质内容**的提问——每个这样的提问都应各自对应一个 ###
- 提炼重写：删去过渡语和元评论（"这是个好问题""顺着这个话题"），将核心疑问重写为自然流畅的一句话
- 仅合并琐碎追问：只有当主持人的追问是纯粹的"展开讲讲""那另一个呢"这类无新内容的话术时，才并入前一个 Q&A。两个触及不同话题或有实质推进的提问，必须各自保留为独立的 ###
- **快问快答必须拆分**：访谈末尾常见的"快速问答"环节，即使主持人在字幕里**把 4 个不同问题串成一段连续提问**（如一次性问"你会改变哪些看法？你会冷冻人体吗？你如何保持清醒？你会去火星吗？"），也必须按嘉宾回答里的自然分界，拆成 4 个各自独立的 ###，每个 ### 里只放一问一答。严禁合并成一个"### 快问快答"或"### 个人反思与未来展望"之类的综合段

【回应的处理（核心）】
先完整读完嘉宾在这个话题下的所有发言，提炼 1-3 个核心论点和关键细节，再用编辑自己的语言重写——不是翻译，不是删减，是理解后的再表达。

**视角要求（极其重要）**：嘉宾的回答必须用**第一人称**写（"我认为…""我们观察到…""在我看来…"），就像读者在直接听嘉宾说话。**严禁**出现"XX认为""XX表示""XX驳斥""XX预测"这类第三人称转述——姓名标注后的内容是嘉宾的原话转写，不是新闻报道。
  · 正确：**Mark:** 我认为AI是我一生中最大的技术革命……
  · 错误：**Mark:** 马克认为AI是他一生中最大的技术革命……

篇幅：每个 ### 下回答的段数随内容量自然伸缩——简短话题 1 段即可，内容丰富的话题写 3-4 段也没问题；每段 2-4 句。回答直接从实质内容开始，不以"好的""是的""你说得对"等应答语开头。具体数字、人名、机构、案例名称（如"DeepSeek""SB1047"）、关键比喻都要保留。

【必须删除的内容】
- 纯铺垫：纯粹用来"引出结论"的背景铺陈，如果去掉它结论仍然成立，就切掉。但承载关键信息的背景（如技术脉络、政策背景）可以浓缩保留一两句
- 冗余举例：同一个论点嘉宾给了多个例子时，只留最有代表性的一个；避免例子铺陈
- 无信息往返：主持人与嘉宾之间若出现简短的调侃、确认、附和式交换（通常 1-3 句往返），整段删除，不保留任何一方的发言
- 重复强调：同一观点多次表述，只保留最清晰的一次
- 口头填充词：um, uh, you know, like, 呃, 啊, 就是说
- 主持人的衔接句："这是一个很好的过渡""在我们进入下一话题之前"等

【覆盖要求】
字幕中出现的每一个主要话题都必须在文章中体现——删的是冗余表达，不是话题。

【翻译与润色】
- 译为流畅自然的中文
- 保留具体数字、人名、地名、专有名词等关键信息，不可省略
- 意译优先：忠实原意，用中文读者习惯的表达，而非逐词直译

【章节标记（可选）】
字幕内容中可能包含 [CHAPTER: 标题] 标记，标注每章的起始位置和主题。
- 若存在章节标记，以章节为单位组织文章结构，章节标题可作为 ## 大章节的灵感来源
- 若无章节标记，按内容自然分章

【Introduction / Highlights 章节的处理（重要）】
很多访谈视频的第一章（标题含 Introduction / Intro / Preview / Highlights / Teaser / Recap 等词）是后续正片的**精彩片段预览**——把几段精华剪辑拼在开头，像电影的预告片。处理方式：
- **保留该章作为文章开头内容**，不要跳过。预览章在文章里如何放置，由你**根据 teaser 内容与首个正片话题的关系**判断：
  · **优先方案（如果适用）**：把预览的 teaser ### 与首个正片话题 ### 合并到**同一个 ## 大章节**下，前提是你能起出一个**同时涵盖**两者的创意性宏观 ## 标题（如"## 技术革命：八十年一遇的AI巅峰"既能统摄"AI革命的历史定位"也能统摄"收入增长/战略/公众认知"等 teaser 切面）
  · **退而求其次**：如果 teaser 的话题分布太散、与首个正片话题没有共同的宏观叙事（强行合并会让 ## 标题被迫写得空泛或牵强），就让预览**独立成一个开头 ## 大章节**（用类似"## 核心观点抢先看"的中性标题）
  · **判断标准**：能不能起出一个**自然、有信息量、不空泛**的涵盖性 ## 标题——能就合并，不能就独立。绝不为了合并而起一个空洞标题
- **任何方案下都必须避免**：① ## 标题与其下任何一个子 ### 同名或同义；② 直接拿单个 ### 作为 ## 标题；③ 用"开场预览"这类纯元描述去硬套合并方案
- **必须按话题拆分成多个 ###**：Introduction 里的字幕虽然在源数据里是一段连续的独白（嘉宾在镜头前连续说完几段话），但内容实际上是**不同话题的精华剪辑**拼接而成。你的任务是识别出这些话题切换点（通常每切换一个话题，语气或指代对象会明显变化），**把每个独立话题切成一个简短的 ###**——不允许把 3 个话题的 teaser 合并成 1 个 ### 或塞进同一段回答里
- 例如：如果 Introduction 里嘉宾连续说了"（1）AI 是史上最大技术革命，（2）当前 GPU 投入规模，（3）开源 vs 闭源的竞争格局"这 3 个话题，必须输出成 3 个独立的 ###，每个 ### 各带自己的提问段和嘉宾的简短回答
- 预览章里每个 ### 的回答**保持简短**，1-2 段即可，不要硬凑长度
- **去重规则（关键）**：预览里讲过的话题/观点，在后续正片章节中**必须删掉，不要重复**。预览版就是该话题在文章中唯一的呈现——不要在正片里再讲一遍、更不要"展开完整版"。如果正片某段字幕内容与预览片段明显重合（同一个论点、同一个例子），整段跳过
- 判断"重合"的方法：如果预览片段和正片段落表达的核心观点相同（即使用词不同），就算重合

【输出格式】
- 直接从 # 大标题开始，结尾无需总结
- 纯 Markdown，不加代码块标记、前言或任何解释

注意：字幕原文已作为用户消息提供，请直接开始输出文章，不要有任何开场白。`;


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

  // Diagnostic: log chapter structure to terminal so we can see what Gemini receives
  console.log(`[gemini] model: ${model}`);
  console.log(`[gemini] transcript stats: ${lines.length} lines, ${full.length} chars (capped: ${capped.length})`);
  console.log(`[gemini] chapters (${chapters.length}):`, chapters.map(c => `[${Math.round(c.startMs / 1000)}s] ${c.title}`).join(' | ') || '(none)');

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: capped }] }],
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
