# Metadata Call 拆分 + Per-Chapter Prompt 调优

**Branch:** `feat/structured-json-output`
**Status:** 设计已与用户对齐，待写 implementation plan
**Date:** 2026-04-22

## 背景

feat 分支现行架构：一次 metadata call（全字幕 → `article_title + host_name + guest_name`）+ N 次 per-chapter call。跑起来的痛点：

1. **Metadata call overload 风险高**：为了从中段找出主持人姓名，把整份 300k 字符字幕喂给 Gemini，产出只要 3 个字段，性价比极差，频繁遇到 503
2. **`article_title` 质量平庸**：模型注意力被 300k 字符稀释，拟出的标题缺少判断力
3. **章节 H2 标题不符合 target 风格**：现行 system.md 里有若干规则（如"section title 禁用冒号"、"严禁目录式枚举"）和目标样本冲突，且**没有区分单主题章和多话题章的两种 H2 模式**
4. **Answer 像逐句翻译**：`editor, not transcriber` 原则在 prompt 里语气不够强，模型默认做逐段转写

用户明确范围：**只针对"对话/访谈类"视频**优化；"演讲/独白类"整条路径从 prompt 和 schema 里清理掉。

## 目标（本轮 scope）

| 做 | 不做 |
|---|---|
| 拆分 metadata call 为 Names call + Title call（并发） | 修 overload 的重试/限流策略 |
| 重写 prompt 以匹配 target 样本的结构和风格 | 改 per-chapter 架构（仍然一章一 call）|
| 删除和 target 冲突的规则 | Speaker diarization / 非 LLM 姓名识别 |
| 补上 H2 双模式（单主题 vs 多话题）| 做 section 数量硬上限/下限 |

不做的理由：按用户要求"先修一版看结果再继续"——这些是下一轮的候选。

## 新调用拓扑

```
transcript + chapters
       │
       ├── Names call（新）
       │    · input: extractNameSnippets(lines, chapters) → ~1-5k chars
       │    · schema: NAMES_SCHEMA { host_name, guest_name }
       │    · fallback: LLM 返回空 → 渲染成 "主持人"/"嘉宾"
       │
       ├── Title call（新）
       │    · input: 章节清单 + 第 1 章字幕（仅当第 1 章看起来是 intro/highlights）
       │    · schema: TITLE_SCHEMA { article_title }
       │    · fallback: call 失败 → 抛错，流不开
       │
       └── 并发 fetch（Promise.all）
              │
              ▼
         ctx = { article_title, host_name, guest_name }
              │
              ▼
         renderPreamble(ctx.article_title)
              │
              ▼
         ∀ chapter i: per-chapter call（架构不变，prompt 升级）
              │
              ▼
         ChapterStreamer → Markdown
```

**延迟：** Names call 和 Title call 并发，相比原单 metadata call 延迟基本持平；总 prompt tokens 压缩 ≥ 60×。

**失败矩阵：**

| Names | Title | 处理 |
|---|---|---|
| ✅ | ✅ | 正常 |
| ❌ | ✅ | 用 "主持人"/"嘉宾" fallback，标题照用 |
| ✅ | ❌ | 抛错，流不开 |
| ❌ | ❌ | 抛错，流不开 |

## Names Call 细节

### `extractNameSnippets(lines, chapters)`

对字幕扫以下**称呼/介绍类模式**，每个命中取命中行 ±2 行上下文，去重拼接：

**英文模式**（大小写不敏感）
```
(^|[\s,.])(thanks|thank you)[\s,]+(\w+)
welcome (back )?(\w+)
(my guest|our guest)[\s,]+(today )?(is )?(\w+)
joining (me|us)[\s,]+(today )?(is )?(\w+)
I'm here with (\w+)
(so )?(\w+)[\s,]+(what do you think|your thoughts|how do you see)
over to you[\s,]+(\w+)
```

**中文模式**
```
(谢谢|感谢|欢迎)\s*([\u4e00-\u9fa5A-Za-z]{2,})
我(今天)?(的)?(嘉宾|请到|请来)
([\u4e00-\u9fa5A-Za-z]{2,})[\s，]*(你怎么看|你觉得|你的看法)
```

额外拼接**章节清单**（YouTube 原章节有时含嘉宾名），作为对名字识别的辅助上下文。

**Fallback**：命中 0 条 → 取完整字幕的前 1500 个字符 + 后 1500 个字符拼接（开头常做自我介绍，结尾常有致谢）。

### `buildNamesMsg(lines, chapters)`

```
【任务：从下列片段识别主持人/嘉宾姓名，只输出 host_name 和 guest_name】

【章节列表】
1. Introduction
2. ...

【字幕片段（含称呼/介绍上下文）】
<extractNameSnippets 输出>

规则：
- 保留原语言短名，不要音译
- 实在识别不出就留空字符串（下游会 fallback 成"主持人"/"嘉宾"）
```

### `NAMES_SCHEMA`

```js
{
  type: 'object',
  properties: {
    host_name:  { type: 'string' },
    guest_name: { type: 'string' },
  },
  required: ['host_name', 'guest_name'],
}
```

## Title Call 细节

### 输入构造

- 章节清单（一行一章，原样贴）
- 若第 1 章标题含 `introduction | intro | highlights | teaser | preview | recap | 开场 | 预告 | 精彩看点` 之一 → 把第 1 章字幕贴上（cap 20k chars）
- 否则**仅**给章节清单

### `buildTitleMsg(lines, chapters)`

```
【任务：只输出 article_title 一个字段】

这期视频是访谈/对话类，共 N 章，结构如下：
1. Introduction
2. ...

【第 1 章字幕（intro/highlights，含全片核心判断）】  ← 仅当第 1 章是 intro 时存在
<第 1 章字幕>

请按以下规则拟标题：
- 格式必须为："对话{受访者全名}：{凝练的判断性短语}"
- 受访者名用全名（名+姓 或 中文全名），不能只用姓氏
- 判断性短语须有"冲突 / 张力 / 转折 / 立场"
- 【反例】"对话 X：AI 的未来"（太空泛）
- 【正例结构】"对话 {全名}：{具体领域}的{具体矛盾/判断}"
```

### `TITLE_SCHEMA`

```js
{
  type: 'object',
  properties: {
    article_title: { type: 'string' },
  },
  required: ['article_title'],
}
```

## `system.md` 改动

### 删除

1. **Line 59** 删除"演讲/独白类视频无提问者时，host_name 留空字符串，guest_name 填演讲者名"（全流程只处理对话/访谈类）
2. **Line 88** 删除 "`**严禁**：问号、冒号、破折号（冒号是章节 title 专属格式，section title 不使用双栏结构）`"（target 样本里 section title 就带冒号）

### 放宽

1. **Line 83** "严禁目录式枚举（A、B 与 C）" 改成**分情境**：
   - 单主题章（H2）禁止目录式，必须冲击短语
   - 多话题章（intro / highlights / 闪电问答 / a16z 问答风格）允许"A、B 与 C"，但 A/B/C 每项必须有信息量

### 新增

1. 在【章节 title】block 末尾加【双模式选择】：

```
【双模式选择】
H2 右半部分按本章是否聚焦单主题选：
- 单主题章（一个话题深度展开）→ "冲击短语"（含具象对象 + 方向性动词/对比）
- 多话题章（intro/highlights、多个 teaser 串联、快问快答合集）→ 允许 "A、B 与 C" 列举，但 A/B/C 每项必须带信息量，不得是"讨论/看法/现状"这类空词

识别方法：
- 本章字幕里主持人问了 1-2 个紧密相关的问题、嘉宾深度展开 → 单主题
- 问了 ≥ 3 个跳跃话题（teaser 串联、快问快答合集、多话题汇总）→ 多话题
```

2. 在【回答写作框架】顶部（line 10 之前）加强 "editor, not transcriber"：

```
**核心原则：editor, not transcriber**
你的任务是把嘉宾原话提炼成高信息密度的段落，不是翻译或转写。
每段 100-350 字，去掉任何不影响核心判断的铺陈/客套/重复。
判断每句是否合格：删掉它，本节核心判断还成立吗？成立 → 删；不成立 → 留。
```

## `buildChapterMsg` 改动

在现有 user message 里加一行 H2 双模式提示：

```
- 本章看是单主题还是多话题：
  · 主持人在本章问 1-2 个紧密相关的问题、嘉宾围绕它展开 → 单主题章，H2 用"抽象词：冲击短语"
  · 问了 ≥ 3 个跳跃话题 → 多话题章，H2 可用"抽象词：A、B 与 C"
```

## Schema 改动

- 删除 `METADATA_SCHEMA`
- 新增 `NAMES_SCHEMA`（见上）
- 新增 `TITLE_SCHEMA`（见上）
- `ARTICLE_SCHEMA` / `CHAPTER_SCHEMA` / `SECTION_ITEM` 不动

## `streamArticle` 改动

伪代码：

```js
export async function streamArticle({ lines, chapters }, config) {
  if (chapters.length === 0) {
    // no-chapter 分支不变（单 call 全字幕）
  }

  // Step 1: Names + Title 并发
  const [namesRes, titleRes] = await Promise.allSettled([
    callGemini(buildNamesMsg(lines, chapters), NAMES_SCHEMA, config),
    callGemini(buildTitleMsg(lines, chapters), TITLE_SCHEMA, config),
  ]);

  // Title 失败 → 抛错
  if (titleRes.status === 'rejected') {
    throw new Error(`Title call failed: ${titleRes.reason.message}`);
  }
  const title = (await readJson(titleRes.value))?.article_title ?? '';

  // Names 失败 → 空名
  let host_name = '', guest_name = '';
  if (namesRes.status === 'fulfilled') {
    const names = tryLenientParse(await readJson(namesRes.value)) ?? {};
    host_name  = names.host_name  ?? '';
    guest_name = names.guest_name ?? '';
  }

  const ctx = { article_title: title, host_name, guest_name };

  // Step 2: preamble + N per-chapter calls（和现在一样）
  return makeStream(async controller => {
    controller.enqueue(renderPreamble({ article_title: title }));
    for (let i = 0; i < chapters.length; i++) {
      const res = await callGemini(
        buildChapterMsg(i, chapters, getChapterLines(lines, chapters, i), ctx),
        CHAPTER_SCHEMA,
        config,
      );
      await drain(res, new ChapterStreamer(ctx), controller);
    }
  });
}
```

## 测试

**新增单测：**

- `extractNameSnippets`：覆盖英文称呼、中文称呼、无命中回退到前后各 1500 字
- `buildNamesMsg` / `buildTitleMsg`：输入输出快照
- `streamArticle` 在 `Promise.allSettled` 下的 4 种失败组合：
  - Names ✅ Title ✅：正常流程
  - Names ❌ Title ✅：host/guest 空字符串下游渲染
  - Names ✅ Title ❌：抛错
  - Names ❌ Title ❌：抛错

**不改的单测：**
- `test/stream-render.spec.js` / `test/renderer.spec.js` / `test/schema.spec.js` 中非 metadata 相关的测试不变
- 删除任何引用 `METADATA_SCHEMA` 的断言

## 显式不做

- **Schema 层的硬约束**（maxItems / minItems）：Gemini responseSchema 对这类约束支持不稳定，易触发生成失败而非优雅降级
- **Section 数量上下限硬规则**：target 样本表明单主题章就是 1 section，强加下限反而会让模型瞎切
- **Answer 长度硬上限**：依赖"editor, not transcriber" 原则 + 段长软引导
- **混合 regex + LLM 拿名字**：pure regex 准确率 ~70%，对 intro synthetic Q&A 的视觉影响大，保留 LLM 保底

## 未解决 / 下一轮再看

- Overload 的重试策略是否需要调整（当前 2/5/12s 指数退避 + full jitter 是否够用）
- 跑出新版后如看到的"坏样本"需要对比 target 重新定位 prompt 问题
- 是否需要 serial fallback（Title call 等 Names call 完成后再发，让 Title 看到名字）
