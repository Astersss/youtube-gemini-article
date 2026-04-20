# 结构化 JSON 输出（branch: `feat/structured-json-output`）

## 解决的问题

main 分支让 Gemini **直接生成 Markdown**，跑下来三个痛点：

1. **结构不可靠**：要求 5 章经常变成 4 章或 6 章；Q&A 答案被切碎成多段；偶尔漏字段。
2. **格式飘忽**：`#` `##` `**` 用法每次不一样，前端样式难统一。
3. **难测试**：输出是一坨自由文本，没法对单个模块做单元测试。

## 思路

把 LLM 的职责从「写 Markdown」收窄到「填 JSON」，Markdown 由代码生成。

```
YouTube transcript
  ① Gemini metadata 调用（responseSchema=METADATA_SCHEMA） → {title, host, guest}
  ② Gemini 逐章调用（responseSchema=CHAPTER_SCHEMA）       → JSON SSE
  ③ SectionStreamer 边收边宽容解析，section "冻结" 即触发渲染
  ④ renderer.js 纯函数 JSON → Markdown 片段
  ⑤ 流式返回前端
```

**关键技巧**：JSON 输出通常意味着要等整段拿完才能用，会牺牲流式体验。这里用了一个 **lenient partial-JSON parser**——对未闭合的 JSON 文本做容错解析，在第 N+1 个 section 开始出现时，判定第 N 个 section 已"冻结"，立即 render 并 push 给前端。所以**虽然 LLM 输出 JSON，用户看到的仍是逐段流式出现的文章**。

## 模块拆分

| 文件 | 职责 |
|---|---|
| `src/services/schema.js` | 三个 responseSchema：metadata / chapter / article |
| `src/services/gemini.js` | 调 Gemini，按章节编排多次调用 |
| `src/services/stream-render.js` | partial-JSON 解析 + section 冻结检测 |
| `src/services/renderer.js` | 纯函数：JSON 节点 → Markdown 字符串 |
| `test/*.spec.js` | 每个模块独立单测 |

## 收益

- **结构有保障**：schema 强制 chapters / sections / Q&A 字段齐全
- **格式稳定**：Markdown 规则集中在 `renderer.js`，可读、可测、可改
- **流式体验保留**：section 粒度推送，用户不需要等整篇生成完
- **可测试**：schema、renderer、parser 全是纯函数，单测覆盖

## 在线对比

| 版本 | URL |
|---|---|
| main（自由 Markdown） | `youtube-gemini-article.astersun719.workers.dev` |
| 本分支（结构化 JSON） | `youtube-gemini-article-v2.astersun719.workers.dev` |
