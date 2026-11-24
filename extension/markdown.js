// Claude の返答（Markdown）を安全に HTML にする小さな変換器。
// まず全体をエスケープしてから、見出し・箇条書き・太字・コード・時刻リンクだけを戻す。
(() => {
  "use strict";
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // [12:34] / [1:02:03] / 12:34 単体 → 動画の位置へ飛ぶリンク
    s = s.replace(/\[?\b((?:\d{1,2}:)?\d{1,2}:\d{2})\b\]?/g, (m, t) => {
      const sec = t.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
      return `<a href="#" class="yk-ts" data-t="${sec}">${m}</a>`;
    });
    return s;
  }

  function render(md) {
    const lines = (md || "").replace(/\r/g, "").split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let code = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of lines) {
      if (line.startsWith("```")) {
        if (code === null) { closeList(); code = []; }
        else { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; }
        continue;
      }
      if (code !== null) { code.push(line); continue; }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        closeList();
        const lv = Math.min(m[1].length + 2, 6);
        out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      } else if ((m = line.match(/^\s*[-*・]\s+(.*)$/))) {
        if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
        closeList(); out.push("<hr>");
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList(); out.push(`<p>${inline(line)}</p>`);
      }
    }
    if (code !== null) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    closeList();
    return out.join("");
  }

  globalThis.YouyakunMarkdown = { render, esc };
})();
