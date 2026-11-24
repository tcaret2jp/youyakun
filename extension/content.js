// YouTube の視聴ページに youyakun のパネルを出す。
(() => {
  "use strict";
  const T = globalThis.YouyakunTranscript;
  const MD = globalThis.YouyakunMarkdown;

  const DEFAULT_PROMPT = [
    "以下の YouTube 動画の字幕を読んで、日本語で要約してください。",
    "- 最初に、全体の要点を 3 行で",
    "- 次に、話の流れに沿って見出しごとに要点を（見出しには開始時刻 [mm:ss] を付ける）",
    "- 最後に、視聴者が覚えておくべきこと・実践できること",
  ].join("\n");

  const CSS = `
  :host { all: initial; }
  .yk { --accent:#127475; --accent-ink:#fff; --bg:#fff; --bg2:#f2f2f2; --ink:#0f0f0f; --sub:#606060; --line:#e5e5e5;
        font: 14px/1.6 "Roboto","Noto Sans JP",system-ui,sans-serif; color:var(--ink); background:var(--bg);
        border:1px solid var(--line); border-radius:20px; margin:0 0 16px; overflow:hidden; }
  .yk.dark { --accent:#0fb2bb; --accent-ink:#0b1416; --bg:#0f0f0f; --bg2:#272727; --ink:#f1f1f1; --sub:#aaa; --line:#3f3f3f; }
  .head { display:flex; align-items:center; gap:8px; padding:10px 14px; }
  .logo { width:12px; height:12px; border-radius:50%; background:var(--accent); box-shadow: 8px 0 0 #f1eb35; margin-right:10px; }
  .title { font-weight:700; flex:1; }
  select, .icon { font:inherit; color:var(--ink); background:var(--bg2); border:0; border-radius:10px; padding:4px 8px; cursor:pointer; }
  .icon { width:30px; height:30px; padding:0; border-radius:50%; }
  .body { padding:0 14px 14px; display:flex; flex-direction:column; gap:10px; }
  .collapsed .body { display:none; }
  .row { display:flex; flex-wrap:wrap; gap:8px; }
  button.btn { font:inherit; font-weight:500; border:0; border-radius:999px; padding:7px 14px; cursor:pointer;
               background:var(--bg2); color:var(--ink); }
  button.btn:hover { filter:brightness(.95); }
  button.primary { background:var(--accent); color:var(--accent-ink); }
  button:disabled { opacity:.5; cursor:default; }
  .status { color:var(--sub); font-size:12px; white-space:pre-wrap; }
  .status.err { color:#cc0000; }
  details { background:var(--bg2); border-radius:10px; padding:6px 10px; }
  summary { cursor:pointer; color:var(--sub); font-size:13px; }
  .segs { max-height:260px; overflow:auto; margin-top:6px; }
  .seg { display:flex; gap:8px; padding:2px 0; }
  .seg.ch { font-weight:700; margin-top:6px; }
  .yk-ts { color:var(--accent); text-decoration:none; font-variant-numeric:tabular-nums; cursor:pointer; }
  .seg .yk-ts { flex:none; width:52px; }
  .chat { display:flex; flex-direction:column; gap:10px; max-height:520px; overflow:auto; }
  .chat:empty { display:none; }
  .msg { border-radius:10px; padding:8px 12px; overflow-wrap:anywhere; }
  .msg.user { background:var(--bg2); align-self:flex-end; max-width:85%; white-space:pre-wrap; }
  .msg.ai { border:1px solid var(--line); }
  .msg.ai p { margin:.3em 0; } .msg.ai ul,.msg.ai ol { margin:.3em 0; padding-left:1.4em; }
  .msg.ai h3,.msg.ai h4,.msg.ai h5,.msg.ai h6 { margin:.6em 0 .2em; font-size:15px; }
  .msg.ai pre { background:var(--bg2); padding:8px; border-radius:4px; overflow:auto; }
  .msg.ai code { font-family: ui-monospace, monospace; font-size:13px; }
  .typing::after { content:"▍"; animation: blink 1s steps(1) infinite; color:var(--accent); }
  @keyframes blink { 50% { opacity:0; } }
  .wd { display:flex; gap:8px; align-items:center; color:var(--sub); font-size:12px; }
  .wd select { flex:1; min-width:0; font-size:12px; }
  .ask { display:flex; gap:8px; align-items:flex-end; }
  textarea { flex:1; font:inherit; color:var(--ink); background:var(--bg2); border:0; border-radius:10px; padding:8px 10px; resize:vertical; min-height:38px; max-height:200px; }
  .sess { display:flex; flex-wrap:wrap; gap:8px; align-items:center; color:var(--sub); font-size:12px; }
  .sess:empty { display:none; }
  .link { background:none; border:0; color:var(--accent); cursor:pointer; font:inherit; padding:0; }
  `;

  let root, els, state;
  const resetState = (videoId) => ({
    videoId, profileId: "", profileUrl: "", dirs: [], pickDir: "", info: null, transcript: null, trackIndex: 0, sessionId: "", workdir: "",
    messages: [], busy: false, port: null,
  });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const videoIdNow = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);
  const isDark = () => document.documentElement.hasAttribute("dark");
  const store = chrome.storage.local;
  const PR = globalThis.YouyakunProfiles;
  // 会話は「接続先 × 動画」ごとに保存する（セッションはブリッジのマシンにあるため）
  // URL も鍵に含める：同じ接続先の URL を別のマシンに変えたら、前のマシンのセッションは使わない
  const key = (id) => `video:${state.profileId}|${state.profileUrl}:${id}`;

  // ---------- 画面 ----------
  function build() {
    const host = document.createElement("div");
    host.id = "youyakun-root";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>${CSS}</style>
      <div class="yk">
        <div class="head">
          <span class="logo"></span><span class="title">youyakun</span>
          <select class="prof" title="接続先（Claude Code が動くマシン）"></select>
          <select class="lang" title="字幕の言語"></select>
          <button class="icon gear" title="設定">⚙</button>
          <button class="icon fold" title="たたむ">–</button>
        </div>
        <div class="body">
          <div class="row">
            <button class="btn copy">字幕をコピー</button>
            <button class="btn copyts">時刻つきでコピー</button>
            <button class="btn primary sum">Claude で要約</button>
          </div>
          <div class="status"></div>
          <details class="tview"><summary>字幕を見る</summary><div class="segs"></div></details>
          <div class="chat"></div>
          <div class="wd"><span>作業フォルダ</span><select class="dir"></select></div>
          <div class="ask">
            <textarea rows="1" placeholder="この動画について Claude に質問（Enter で送信、Shift+Enter で改行）"></textarea>
            <button class="btn send">送信</button>
          </div>
          <div class="sess"></div>
        </div>
      </div>`;
    const q = (s) => sh.querySelector(s);
    els = {
      host, box: q(".yk"), lang: q(".lang"), prof: q(".prof"), status: q(".status"), segs: q(".segs"), tview: q(".tview"),
      chat: q(".chat"), input: q("textarea"), dir: q(".dir"), send: q(".send"), sess: q(".sess"),
      copy: q(".copy"), copyts: q(".copyts"), sum: q(".sum"), fold: q(".fold"), gear: q(".gear"),
    };
    els.copy.onclick = () => copy(false);
    els.copyts.onclick = () => copy(true);
    els.sum.onclick = () => summarize();
    els.send.onclick = () => onSend();
    els.gear.onclick = () => chrome.runtime.sendMessage({ type: "openOptions" });
    els.fold.onclick = () => {
      const c = els.box.classList.toggle("collapsed");
      els.fold.textContent = c ? "+" : "–";
      store.set({ collapsed: c });
    };
    els.prof.onchange = () => {
      if (state.busy) { els.prof.value = state.profileId; return; }
      PR.setActive(els.prof.value); // storage.onChanged で切り替わる
    };
    els.dir.onchange = () => {
      if (state.sessionId || state.busy) return;
      state.pickDir = els.dir.value;
      store.set({ ["workdir:" + state.profileId]: state.pickDir });
    };
    els.lang.onchange = () => { state.trackIndex = Number(els.lang.value); state.transcript = null; loadTranscript(); };
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSend(); }
    });
    // 時刻リンクで動画の位置へ飛ぶ
    sh.addEventListener("click", (e) => {
      const a = e.target.closest?.(".yk-ts");
      if (!a) return;
      e.preventDefault();
      const v = document.querySelector("video.html5-main-video, video");
      if (v) { v.currentTime = Number(a.dataset.t); v.play?.(); }
    });
    store.get("collapsed").then(({ collapsed }) => {
      if (collapsed) { els.box.classList.add("collapsed"); els.fold.textContent = "+"; }
    });
    return host;
  }

  function setStatus(text, err = false) {
    els.status.textContent = text || "";
    els.status.classList.toggle("err", err);
  }

  function setBusy(b) {
    state.busy = b;
    els.sum.disabled = b;
    els.send.textContent = b ? "停止" : "送信";
    if (els.dir) els.dir.disabled = b || !!state.sessionId;
    if (!b) { renderDirs(); syncProfile(false); } // 返答中に切り替えられていたら、ここで反映する
  }

  function renderSegments() {
    const segs = state.transcript?.segments || [];
    els.segs.innerHTML = segs
      .map((s) => `<div class="seg${s.chapter ? " ch" : ""}"><a href="#" class="yk-ts" data-t="${Math.floor(s.startMs / 1000)}">${T.fmtTime(s.startMs)}</a><span>${MD.esc(s.text)}</span></div>`)
      .join("");
  }

  function renderChat() {
    els.chat.innerHTML = state.messages
      .map((m) => (m.role === "user" ? `<div class="msg user">${MD.esc(m.display || m.text)}</div>` : `<div class="msg ai">${MD.render(m.text)}</div>`))
      .join("");
    els.chat.scrollTop = els.chat.scrollHeight;
    renderSession();
  }

  function renderSession() {
    if (!state.sessionId) { els.sess.innerHTML = ""; return; }
    els.sess.innerHTML = `<span>セッション ${state.sessionId.slice(0, 8)}</span>
      <button class="link cli">ターミナルで続けるコマンドをコピー</button>
      <button class="link reset">新しい会話にする</button>`;
    els.sess.querySelector(".cli").onclick = async () => {
      const dir = state.workdir ? `'${state.workdir.replace(/'/g, "'\\''")}'` : "~/.local/share/youyakun/work";
      const cmd = `cd ${dir} && claude --resume ${state.sessionId}`;
      await navigator.clipboard.writeText(cmd);
      setStatus("コピーしました: " + cmd);
    };
    els.sess.querySelector(".reset").onclick = () => {
      if (state.busy) return;
      state.sessionId = ""; state.messages = [];
      save(); renderChat(); renderDirs();
      setStatus("新しい会話にしました");
    };
  }

  async function renderProfiles() {
    const { profiles, activeProfile } = await PR.load();
    els.prof.innerHTML = profiles.map((p) => `<option value="${MD.esc(p.id)}">${MD.esc(p.name || "（名前なし）")}</option>`).join("");
    els.prof.value = activeProfile;
    els.prof.hidden = profiles.length < 2; // 1 件だけなら出さない
    return profiles.find((p) => p.id === activeProfile) || { id: "", url: "" };
  }

  // 今使っている接続先の会話を読み込む。待っている間に動画や接続先が変わったら捨てる
  async function loadSaved() {
    const id = state.videoId;
    const k = key(id);
    const saved = (await store.get(k))[k];
    if (state.videoId !== id || key(id) !== k) return;
    state.sessionId = UUID_RE.test(saved?.sessionId || "") ? saved.sessionId : "";
    state.workdir = saved?.workdir || "";
    state.messages = saved?.messages || [];
    renderChat();
    renderDirs();
  }

  // 作業フォルダ：会話中はそのセッションのフォルダを表示して固定、新しい会話のときだけ選べる
  function renderDirs() {
    const dirs = state.dirs || [];
    const locked = !!state.sessionId;
    const want = locked ? state.workdir : state.pickDir;
    const opts = dirs.slice();
    if (want && !opts.some((d) => d.path === want)) opts.push({ name: want, path: want });
    if (!opts.length) opts.push({ name: "既定（youyakun 専用）", path: "" });
    els.dir.innerHTML = opts.map((d) => `<option value="${MD.esc(d.path)}">${MD.esc(d.name)}</option>`).join("");
    els.dir.value = want && opts.some((d) => d.path === want) ? want : opts[0].path;
    els.dir.disabled = locked || state.busy;
    els.dir.title = locked ? "会話中は変えられません。「新しい会話にする」と選べます" : "Claude Code を動かすフォルダ（その CLAUDE.md が読み込まれます）";
  }

  function loadDirs() {
    // 送信時に待てるよう、読み込み中の Promise を持っておく
    state.dirsReady = loadDirsNow();
    return state.dirsReady;
  }

  async function loadDirsNow() {
    const pid = state.profileId;
    state.dirs = []; state.pickDir = ""; // 前の接続先の選択を持ち越さない
    const [r, picked] = await Promise.all([
      chrome.runtime.sendMessage({ type: "workdirs", profileId: pid }).catch(() => null),
      store.get("workdir:" + pid),
    ]);
    if (state.profileId !== pid) return;
    state.dirs = r?.ok ? r.workdirs : [];
    const p = picked["workdir:" + pid] || "";
    state.pickDir = state.dirs.some((d) => d.path === p) ? p : state.dirs[0]?.path || "";
    renderDirs();
  }

  // 表示中の接続先を、設定の「使用中」に合わせる。返答中は切り替えず、終わったときにもう一度呼ぶ
  async function syncProfile(announce = true) {
    if (!els || !state) return;
    const p = await renderProfiles();
    if (state.busy) { els.prof.value = state.profileId; return; }
    if (p.id === state.profileId && (p.url || "") === state.profileUrl) return;
    state.profileId = p.id;
    state.profileUrl = p.url || "";
    await loadSaved();
    loadDirs();
    if (announce) setStatus(`接続先を「${els.prof.selectedOptions[0]?.textContent || ""}」にしました`);
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && (ch.profiles || ch.activeProfile)) syncProfile();
  });

  function save() {
    store.set({ [key(state.videoId)]: { sessionId: state.sessionId, workdir: state.workdir, messages: state.messages.slice(-40), at: Date.now() } });
  }

  // ---------- 字幕 ----------
  async function loadInfo() {
    const id = state.videoId;
    try {
      const info = await T.getInfo(id);
      if (state.videoId !== id) return;
      state.info = info;
      els.lang.innerHTML = info.tracks.length
        ? info.tracks.map((t, i) => `<option value="${i}">${MD.esc(t.name)}${t.auto ? "（自動）" : ""}</option>`).join("")
        : `<option>字幕なし</option>`;
      els.lang.disabled = !info.tracks.length;
      if (!info.tracks.length) setStatus("この動画には字幕がないようです（ページの「文字起こし」パネルから取得を試みます）");
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function loadTranscript() {
    if (state.transcript) return state.transcript;
    const id = state.videoId, ti = state.trackIndex;
    setStatus("字幕を読み込んでいます…");
    try {
      const tr = await T.getTranscript(id, ti);
      // 待っている間に動画や言語が変わったら、古い結果は捨てる
      if (state.videoId !== id || state.trackIndex !== ti) return null;
      state.transcript = tr;
      const chars = tr.segments.reduce((a, s) => a + s.text.length, 0);
      setStatus(`字幕 ${tr.segments.length} 行・${chars.toLocaleString()} 文字（取得方法: ${tr.source}）`);
      els.tview.querySelector("summary").textContent = `字幕を見る（${tr.segments.length} 行）`;
      renderSegments();
      return tr;
    } catch (e) {
      if (state.videoId === id) setStatus(e.message, true);
      return null;
    }
  }

  async function copy(timestamps) {
    const tr = await loadTranscript();
    if (!tr) return;
    const header = `${tr.title}\n${location.origin}/watch?v=${tr.videoId}\n\n`;
    await navigator.clipboard.writeText(header + T.toText(tr.segments, { timestamps }));
    setStatus(`コピーしました（${timestamps ? "時刻つき" : "本文のみ"}・${tr.segments.length} 行）`);
  }

  function contextBlock(tr) {
    const track = tr.track;
    return [
      "<video>",
      `タイトル: ${tr.title}`,
      tr.channel ? `チャンネル: ${tr.channel}` : null,
      `URL: https://www.youtube.com/watch?v=${tr.videoId}`,
      tr.lengthSec ? `長さ: ${T.fmtTime(tr.lengthSec * 1000)}` : null,
      track ? `字幕: ${track.name}${track.auto ? "（自動生成）" : ""}` : null,
      "</video>",
      "",
      "<transcript>",
      T.toText(tr.segments, { timestamps: true }),
      "</transcript>",
    ].filter((x) => x != null).join("\n");
  }

  // ---------- Claude ----------
  async function summarize() {
    const { promptTemplate } = await chrome.storage.local.get("promptTemplate");
    ask(promptTemplate || DEFAULT_PROMPT, "要約して");
  }

  function onSend() {
    if (state.busy) { state.stop?.(); return; }
    const text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    ask(text, text);
  }

  async function ask(instruction, display) {
    if (state.busy) return;
    setBusy(true); // 字幕の読み込み中に二重に送られないよう、先に立てる
    const id = state.videoId;
    let message = instruction;
    if (!state.sessionId) {
      // 最初の 1 通にだけ字幕を付ける。あとはセッションが覚えている
      const tr = await loadTranscript();
      if (!tr || state.videoId !== id) { if (state.videoId === id) setBusy(false); return; }
      message = `${instruction}\n\n${contextBlock(tr)}`;
    }
    const resumeId = state.sessionId;
    if (!resumeId) await state.dirsReady; // 作業フォルダの一覧が届く前に送らない
    if (state.videoId !== id) return;
    let newId = "";
    state.messages.push({ role: "user", text: instruction, display });
    const ai = { role: "ai", text: "" };
    state.messages.push(ai);
    renderChat();
    const bubble = els.chat.lastElementChild;
    bubble.classList.add("typing");
    setBusy(true);
    setStatus(state.sessionId ? "Claude が考えています…" : "Claude Code のセッションを始めています…");

    const port = chrome.runtime.connect({ name: "chat" });
    state.port = port;
    let raf = 0;
    const paint = () => { raf = 0; bubble.innerHTML = MD.render(ai.text); els.chat.scrollTop = els.chat.scrollHeight; };
    const finish = (statusText, err) => {
      if (state.port !== port) return;
      state.port = null;
      bubble.classList.remove("typing");
      if (!ai.text) state.messages.splice(state.messages.indexOf(ai), 1);
      setBusy(false);
      if (state.videoId === id) { save(); renderChat(); setStatus(statusText, err); }
      try { port.disconnect(); } catch {}
    };
    port.onMessage.addListener((m) => {
      if (m.type === "start") {
        // 新しいセッションの ID は、返答が最後まで成功してから保存する
        if (!resumeId && UUID_RE.test(m.session_id || "")) newId = m.session_id;
        state.workdir = m.workdir || state.workdir;
        setStatus("Claude が書いています…");
      } else if (m.type === "delta") {
        ai.text += m.text;
        if (!raf) raf = requestAnimationFrame(paint);
      } else if (m.type === "done") {
        if (m.result && m.result.length >= ai.text.length) ai.text = m.result;
        if (!m.is_error && !resumeId) {
          const sid = UUID_RE.test(m.session_id || "") ? m.session_id : newId;
          if (sid && state.videoId === id) state.sessionId = sid;
        }
        const cost = m.cost_usd != null ? `（$${Number(m.cost_usd).toFixed(3)}）` : "";
        finish(m.is_error ? "Claude がエラーを返しました" : `完了 ${cost}`, m.is_error);
      } else if (m.type === "error") {
        finish(m.message, true);
      } else if (m.type === "closed") {
        finish(ai.text ? "完了" : "返答がありませんでした", !ai.text);
      }
    });
    port.onDisconnect.addListener(() => finish(ai.text ? "接続が切れました" : "中断しました", !ai.text));
    // 自分から disconnect したときは onDisconnect が来ないので、止める処理を別に持つ
    state.stop = () => finish("止めました", false);
    port.postMessage({ profileId: state.profileId, session_id: resumeId, workdir: resumeId ? state.workdir : state.pickDir, message, name: `youyakun: ${state.info?.title || id}`.slice(0, 80) });
  }

  // ---------- 差し込み ----------
  function findSlot() {
    const sec = document.querySelector("ytd-watch-flexy #secondary-inner");
    if (sec && sec.offsetParent) return { el: sec, where: "prepend" };
    const below = document.querySelector("ytd-watch-flexy #below");
    if (below) return { el: below, where: "prepend" };
    return null;
  }

  async function mount() {
    const id = videoIdNow();
    if (!id) { state?.stop?.(); root?.remove(); return; }
    if (!root) root = build();
    if (!state || state.videoId !== id) {
      state?.stop?.();
      state = resetState(id);
      els.chat.innerHTML = ""; els.segs.innerHTML = ""; els.lang.innerHTML = ""; setStatus(""); setBusy(false);
      els.tview.querySelector("summary").textContent = "字幕を見る";
      els.box.classList.toggle("dark", isDark());
      await syncProfile(false);
      loadInfo();
    }
    for (let i = 0; i < 40 && videoIdNow() === id; i++) {
      const slot = findSlot();
      if (slot) {
        if (root.parentElement !== slot.el) slot.el.prepend(root);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  document.addEventListener("yt-navigate-finish", mount);
  // YouTube が要素を作り直してパネルが外れたときに戻す
  setInterval(() => {
    if (videoIdNow() && (!root || !root.isConnected)) mount();
    if (root && els) els.box.classList.toggle("dark", isDark());
  }, 1500);
  mount();
})();
