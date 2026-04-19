/**
 * Returns the complete single-page HTML application as a string.
 * No external CDN dependencies — all CSS and JS is inlined.
 *
 * @returns {string} Full HTML document
 */
export function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI 编辑室 · 视频转文章</title>
  <style>
    :root {
      --ink:     #1a1a1a;
      --muted:   #6b6b6b;
      --accent:  #c0392b;
      --bg:      #fafaf8;
      --surface: #ffffff;
      --border:  #e8e8e4;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100vh;
    }

    /* ── Header ─────────────────────────────────── */
    header {
      border-bottom: 2px solid var(--ink);
      padding: 1.25rem 0;
      margin-bottom: 3rem;
    }
    .header-inner {
      max-width: 760px;
      margin: 0 auto;
      padding: 0 1.5rem;
      display: flex;
      align-items: baseline;
      gap: 1rem;
    }
    .logo    { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    .tagline { font-size: 0.875rem; color: var(--muted); }

    /* ── Layout ──────────────────────────────────── */
    .container { max-width: 760px; margin: 0 auto; padding: 0 1.5rem 5rem; }

    /* ── Input card ──────────────────────────────── */
    .input-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 2.5rem;
    }
    .input-label {
      display: block;
      font-size: 0.875rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .input-row { display: flex; gap: 0.5rem; }

    .url-input {
      flex: 1;
      padding: 0.625rem 0.875rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.9375rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
    }
    .url-input:focus { border-color: var(--ink); }

    .submit-btn {
      padding: 0.625rem 1.25rem;
      background: var(--ink);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 0.9375rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s;
    }
    .submit-btn:hover    { opacity: 0.75; }
    .submit-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* ── Status indicator ────────────────────────── */
    .status {
      display: none;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.875rem;
      font-size: 0.875rem;
      color: var(--muted);
    }
    .status.visible { display: flex; }

    .spinner {
      width: 14px; height: 14px; flex-shrink: 0;
      border: 2px solid var(--border);
      border-top-color: var(--ink);
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Article typography ──────────────────────── */
    #article {
      font-family: Georgia, 'Songti SC', 'SimSun', 'STSong', serif;
      font-size: 1.0625rem;
      line-height: 1.85;
      color: var(--ink);
    }

    #article h1 {
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      font-size: 1.875rem;
      font-weight: 700;
      line-height: 1.25;
      letter-spacing: -0.02em;
      margin-bottom: 0.375rem;
    }
    #article h2 {
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      font-size: 1.125rem;
      font-weight: 700;
      margin-top: 2.5rem;
      margin-bottom: 0.75rem;
      padding-bottom: 0.375rem;
      border-bottom: 1px solid var(--border);
    }
    #article h3 {
      font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
      font-size: 1rem;
      font-weight: 600;
      margin-top: 1.5rem;
      margin-bottom: 0.5rem;
    }

    #article p      { margin-bottom: 1rem; }
    #article strong { color: var(--accent); font-weight: 700; }
    #article em     { font-style: italic; }

    /* ── Streaming cursor ────────────────────────── */
    .cursor {
      display: inline-block;
      width: 2px; height: 1.1em;
      background: var(--ink);
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }

    /* ── Error card ──────────────────────────────── */
    .error {
      background: #fff5f5;
      border: 1px solid #fecaca;
      border-radius: 6px;
      padding: 1rem 1.25rem;
      color: #b91c1c;
      font-size: 0.9375rem;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <span class="logo">AI 编辑室</span>
      <span class="tagline">YouTube 字幕 · 智能转文章</span>
    </div>
  </header>

  <div class="container">
    <div class="input-card">
      <label class="input-label" for="urlInput">输入 YouTube 视频链接</label>
      <div class="input-row">
        <input
          class="url-input"
          id="urlInput"
          type="url"
          placeholder="https://www.youtube.com/watch?v=..."
        />
        <button class="submit-btn" id="submitBtn">生成文章</button>
      </div>
      <div class="status" id="status">
        <div class="spinner"></div>
        <span id="statusText">处理中…</span>
      </div>
    </div>

    <div id="article"></div>
  </div>

  <script>
    const urlInput   = document.getElementById('urlInput');
    const submitBtn  = document.getElementById('submitBtn');
    const statusEl   = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const article    = document.getElementById('article');

    submitBtn.addEventListener('click', generate);
    urlInput.addEventListener('keydown', e => e.key === 'Enter' && generate());

    async function generate() {
      const url = urlInput.value.trim();
      if (!url) return;

      setLoading(true, '正在提取字幕…');
      article.innerHTML = '';

      try {
        const res = await fetch('/api/article?url=' + encodeURIComponent(url));

        if (!res.ok) {
          const payload = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(payload.error || res.statusText);
        }

        setLoading(true, 'AI 正在思考…');

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        let firstChunk = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          if (firstChunk && raw.trim()) {
            firstChunk = false;
            setLoading(true, 'AI 正在生成文章…');
          }
          article.innerHTML = md2html(raw) + '<span class="cursor"></span>';
          article.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // Final render — remove cursor
        article.innerHTML = md2html(raw);
      } catch (err) {
        article.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
      } finally {
        setLoading(false);
      }
    }

    function setLoading(on, text) {
      submitBtn.disabled = on;
      statusEl.classList.toggle('visible', on);
      if (text) statusText.textContent = text;
    }

    /* ── Minimal streaming-safe Markdown → HTML converter ── */
    function md2html(md) {
      const out  = [];
      let   para = [];

      const flushPara = () => {
        if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; }
      };

      for (const raw of md.split('\\n')) {
        const line = raw.trim();
        if (!line)                   { flushPara(); continue; }
        if (line.startsWith('# '))   { flushPara(); out.push('<h1>' + inl(line.slice(2))  + '</h1>'); continue; }
        if (line.startsWith('## '))  { flushPara(); out.push('<h2>' + inl(line.slice(3))  + '</h2>'); continue; }
        if (line.startsWith('### ')) { flushPara(); out.push('<h3>' + inl(line.slice(4))  + '</h3>'); continue; }
        para.push(inl(line));
      }
      flushPara();
      return out.join('\\n');
    }

    // Inline markdown: escape HTML first, then apply **bold** and *italic*
    function inl(t) {
      return esc(t)
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.+?)\\*/g,      '<em>$1</em>');
    }

    function esc(t) {
      return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  </script>
</body>
</html>`;
}
