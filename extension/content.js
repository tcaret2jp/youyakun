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
  .title { font-weight:700; flex:1; min-width:0; }
  .head { gap:4px !important; }
  select, .icon { font:inherit; color:var(--ink); background:var(--bg2); border:0; border-radius:10px; padding:4px 8px; cursor:pointer; }
  .icon { width:30px; height:30px; padding:0; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; flex:none; }
  .icon.primary { background:var(--accent); color:var(--accent-ink); }
  .icon:hover:not(:disabled) { filter:brightness(.93); }
  .env, .trbar { display:flex; gap:6px; }
  .pick { display:flex; align-items:center; gap:4px; flex:1; min-width:0; background:var(--bg2); border-radius:10px; padding:0 0 0 8px; color:var(--sub); }
  .pick select { flex:1; min-width:0; font-size:12px; background:transparent; padding:5px 6px 5px 2px; }
  .pick select:disabled { opacity:.6; }
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
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); }
  .tab { font:inherit; font-size:13px; font-weight:500; background:none; border:0; color:var(--sub); cursor:pointer;
         padding:6px 12px; border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tab.on { color:var(--ink); border-bottom-color:var(--accent); }
  .tab .cnt { color:var(--sub); font-weight:400; margin-left:4px; font-size:12px; }
  .pane { display:flex; flex-direction:column; gap:10px; }
  .pane[hidden] { display:none; }
  .tstatus { color:var(--sub); font-size:12px; white-space:pre-wrap; }
  .tstatus.err { color:#cc0000; }
  .segs { max-height:520px; overflow:auto; }
  .empty { color:var(--sub); font-size:13px; padding:8px 0; }
  .seg { display:flex; gap:8px; padding:2px 0; }
  .seg.ch { font-weight:700; margin-top:6px; }
  .yk-ts { color:var(--accent); text-decoration:none; font-variant-numeric:tabular-nums; cursor:pointer; }
  .seg .yk-ts { flex:none; width:52px; }
  .chat { display:flex; flex-direction:column; gap:10px; max-height:520px; overflow:auto; }
  .chat:empty::before { content:"「Claude で要約」を押すか、下の欄から質問してください"; color:var(--sub); font-size:13px; }
  .msg { border-radius:10px; padding:8px 12px; overflow-wrap:anywhere; }
  .msg.user { background:var(--bg2); align-self:flex-end; max-width:85%; white-space:pre-wrap; }
  .msg.ai { border:1px solid var(--line); }
  .msg.ai p { margin:.3em 0; } .msg.ai ul,.msg.ai ol { margin:.3em 0; padding-left:1.4em; }
  .msg.ai h3,.msg.ai h4,.msg.ai h5,.msg.ai h6 { margin:.6em 0 .2em; font-size:15px; }
  .msg.ai pre { background:var(--bg2); padding:8px; border-radius:4px; overflow:auto; }
  .msg.ai code { font-family: ui-monospace, monospace; font-size:13px; }
  .typing::after { content:"▍"; animation: blink 1s steps(1) infinite; color:var(--accent); }
  @keyframes blink { 50% { opacity:0; } }
  .sbar { display:flex; gap:8px; align-items:center; }
  .sbar select { flex:1; min-width:0; font-size:12px; }
  button.small { padding:4px 12px; font-size:12px; }
  .ask { display:flex; gap:8px; align-items:flex-end; }
  textarea { flex:1; font:inherit; color:var(--ink); background:var(--bg2); border:0; border-radius:10px; padding:8px 10px; resize:vertical; min-height:38px; max-height:200px; }
  .sess { display:flex; flex-wrap:wrap; gap:8px; align-items:center; color:var(--sub); font-size:12px; }
  .sess:empty { display:none; }
  .link { background:none; border:0; color:var(--accent); cursor:pointer; font:inherit; padding:0; }
  `;

  // パネルのアイコン（線のみ・currentColor）
  const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    summary: svg('<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="19" cy="17" r="2.5"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    down: svg('<path d="M6 15l6-6 6 6"/>'),
    up: svg('<path d="M6 9l6 6 6-6"/>'),
    server: svg('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>'),
    lang: svg('<path d="M4 5h9M8.5 3v2M6 5c.5 3 2.5 5.5 5.5 7M11 5c-.8 3.5-3 6.5-6 8"/><path d="M13 21l4-9 4 9M14.5 18h5"/>'),
  };

  let root, els, state;
  const resetState = (videoId) => ({
    videoId, sessions: [], loadingSaved: false, profileId: "", profileUrl: "", dirs: [], pickDir: "", info: null, transcript: null, trackIndex: null, sessionId: "", workdir: "",
    messages: [], busy: false, port: null,
  });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const videoIdNow = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);
  const isDark = () => document.documentElement.hasAttribute("dark");
  const store = chrome.storage.local;
  const PR = globalThis.YouyakunProfiles;
  // 会話は「接続先 × 動画」ごとに保存する（セッションはブリッジのマシンにあるため）
  // URL も鍵に含める：同じ接続先の URL を別のマシンに変えたら、前のマシンのセッションは使わない
  const keyOf = (st, id = st.videoId) => `video:${st.profileId}|${st.profileUrl}:${id}`;
  const key = (id) => keyOf(state, id);

  // ---------- 画面 ----------
  function build() {
    const host = document.createElement("div");
    host.id = "youyakun-root";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>${CSS}</style>
      <div class="yk">
        <div class="head">
          <span class="logo"></span><span class="title">youyakun</span>
          <button class="icon copy" title="字幕をコピー">${ICON.copy}</button>
          <button class="icon copyts" title="時刻つきで字幕をコピー">${ICON.clock}</button>
          <button class="icon primary sum" title="Claude で要約">${ICON.summary}</button>
          <button class="icon gear" title="設定">${ICON.gear}</button>
          <button class="icon fold" title="たたむ">${ICON.down}</button>
        </div>
        <div class="body">
          <div class="env">
            <label class="pick" title="接続先（Claude Code が動くマシン）">${ICON.server}<select class="prof"></select></label>
            <label class="pick" title="作業フォルダ（Claude Code を動かすフォルダ。その CLAUDE.md が読み込まれます）">${ICON.folder}<select class="dir"></select></label>
          </div>
          <div class="status"></div>
          <div class="tabs">
            <button class="tab on" data-tab="chat">チャット</button>
            <button class="tab" data-tab="tr">字幕<span class="cnt"></span></button>
          </div>
          <div class="pane pane-chat">
            <div class="sbar">
              <select class="ssel" title="この動画での会話"></select>
              <button class="icon snew" title="新しい会話">${ICON.plus}</button>
            </div>
            <div class="chat"></div>
            <div class="ask">
              <textarea rows="1" placeholder="この動画について質問（Enter で送信）"></textarea>
              <button class="icon primary send" title="送信">${ICON.send}</button>
            </div>
            <div class="sess"></div>
          </div>
          <div class="pane pane-tr" hidden>
            <div class="trbar">
              <label class="pick" title="字幕の言語">${ICON.lang}<select class="lang"></select></label>
            </div>
            <div class="tstatus"></div>
            <div class="segs"></div>
          </div>
        </div>
      </div>`;
    const q = (s) => sh.querySelector(s);
    els = {
      host, box: q(".yk"), lang: q(".lang"), prof: q(".prof"), status: q(".status"), segs: q(".segs"), tstatus: q(".tstatus"), cnt: q(".tab .cnt"),
      tabs: [...sh.querySelectorAll(".tab")], paneChat: q(".pane-chat"), paneTr: q(".pane-tr"),
      chat: q(".chat"), input: q("textarea"), dir: q(".dir"), ssel: q(".ssel"), snew: q(".snew"), send: q(".send"), sess: q(".sess"),
      copy: q(".copy"), copyts: q(".copyts"), sum: q(".sum"), fold: q(".fold"), gear: q(".gear"),
    };
    els.copy.onclick = () => copy(false);
    els.copyts.onclick = () => copy(true);
    els.sum.onclick = () => summarize();
    els.send.onclick = () => onSend();
    els.gear.onclick = () => chrome.runtime.sendMessage({ type: "openOptions" });
    els.fold.onclick = () => {
      const c = els.box.classList.toggle("collapsed");
      els.fold.innerHTML = c ? ICON.up : ICON.down;
      els.fold.title = c ? "ひらく" : "たたむ";
      store.set({ collapsed: c });
    };
    els.prof.onchange = () => {
      if (els.prof.value === "__add") { // 設定画面を開く
        els.prof.value = [...els.prof.options].some((o) => o.value === state.profileId) ? state.profileId : "";
        chrome.runtime.sendMessage({ type: "openOptions" });
        return;
      }
      if (state.busy || !state.videoId) { els.prof.value = state.profileId; return; }
      state.switching = true; // 切り替えが反映されるまで送信しない
      setBusyControls();
      PR.setActive(els.prof.value).then(() => syncProfile()); // 反映して、会話とフォルダを読み直す
    };
    els.snew.onclick = () => newConversation();
    els.ssel.onchange = () => switchSession(els.ssel.value);
    els.dir.onchange = () => {
      if (state.busy || state.loadingSaved || state.dirsLoading || state.switching || !state.videoId) { renderDirs(); return; }
      state.pickDir = els.dir.value;
      store.set({ ["workdir:" + state.profileId]: state.pickDir });
      // 会話の途中でフォルダを変えたら、そのフォルダで新しい会話にする（セッションはフォルダごとに保存されるため）
      if (state.sessionId && state.workdir !== state.pickDir) {
        useEntry(null);
        save();
        setStatus("作業フォルダを変えたので、新しい会話にしました（前の会話はメニューから戻れます）");
      }
    };
    for (const t of els.tabs) t.onclick = () => showTab(t.dataset.tab, true);
    els.lang.onchange = () => {
      state.trackIndex = Number(els.lang.value); state.transcript = null;
      els.segs.innerHTML = ""; // 前の言語の行は消す
      loadTranscript();
    };
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
    store.get("tab").then(({ tab }) => { if (tab === "tr") showTab("tr"); });
    store.get("collapsed").then(({ collapsed }) => {
      if (collapsed) { els.box.classList.add("collapsed"); els.fold.innerHTML = ICON.up; els.fold.title = "ひらく"; }
    });
    return host;
  }

  function setStatus(text, err = false) {
    els.status.textContent = text || "";
    els.status.classList.toggle("err", err);
  }

  // 返答中・切り替え中に触れないものを止める
  function setBusyControls() {
    if (!els || !state) return;
    const lock = !!(state.busy || state.switching);
    els.prof.disabled = lock;
    els.dir.disabled = lock || !!(state.loadingSaved || state.dirsLoading);
    els.sum.disabled = lock;
  }

  function setBusy(b) {
    state.busy = b;
    els.sum.disabled = b;
    els.send.innerHTML = b ? ICON.stop : ICON.send;
    els.send.title = b ? "止める" : "送信";
    setBusyControls();
    if (els.ssel) { els.ssel.disabled = b || els.ssel.options.length < 2; els.snew.disabled = b || !state.sessionId; }
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
      <button class="link cli">ターミナルで続けるコマンドをコピー</button>`;
    els.sess.querySelector(".cli").onclick = async () => {
      const dir = state.workdir ? `'${state.workdir.replace(/'/g, "'\\''")}'` : "~/.local/share/youyakun/work";
      const cmd = `cd ${dir} && claude --resume ${state.sessionId}`;
      await navigator.clipboard.writeText(cmd);
      setStatus("コピーしました: " + cmd);
    };
  }

  // ---------- 動画ごとの会話（セッション）の一覧 ----------
  // 保存形式: { current: セッション ID（"" は未送信の新しい会話）, sessions: [{ sid, workdir, messages, title, at }] }
  const MAX_SESSIONS = 20;

  function sessionTitle(x) {
    const d = new Date(x.at || Date.now());
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `${(x.title || "会話").slice(0, 24)}（${when}）`;
  }

  function renderSessions() {
    const list = state.sessions || [];
    const opts = list.map((x) => `<option value="${MD.esc(x.sid)}">${MD.esc(sessionTitle(x))}</option>`);
    if (!state.sessionId) opts.push(`<option value="">新しい会話（まだ送っていません）</option>`);
    els.ssel.innerHTML = opts.join("");
    els.ssel.value = state.sessionId || "";
    els.ssel.disabled = state.busy || state.loadingSaved || opts.length < 2;
    els.snew.disabled = state.busy || state.loadingSaved || !state.sessionId; // すでに新しい会話なら押せない
  }

  function useEntry(x) {
    state.sessionId = x ? x.sid : "";
    state.workdir = x ? x.workdir || "" : "";
    state.messages = x ? (x.messages || []).slice() : [];
    renderChat(); renderDirs(); renderSessions();
  }

  function newConversation() {
    if (state.busy || state.loadingSaved || !state.sessionId) return;
    useEntry(null);
    save();
    setStatus("新しい会話にしました（前の会話は上のメニューから戻れます）");
  }

  function switchSession(sid) {
    if (state.busy || state.loadingSaved) { renderSessions(); return; }
    const x = (state.sessions || []).find((e) => e.sid === sid);
    if (!x) { renderSessions(); return; }
    useEntry(x);
    save();
  }

  async function renderProfiles() {
    const { profiles, activeProfile } = await PR.load();
    els.prof.innerHTML = profiles.map((p) => `<option value="${MD.esc(p.id)}">${MD.esc(p.name || "（名前なし）")}</option>`).join("")
      + (profiles.length ? "" : `<option value="">接続先が未設定です</option>`)
      + `<option value="__add">＋ 接続先を追加・編集…</option>`;
    els.prof.value = profiles.some((p) => p.id === activeProfile) ? activeProfile : "";
    return profiles.find((p) => p.id === activeProfile) || { id: "", url: "" };
  }

  // 今使っている接続先の会話を読み込む。待っている間に動画や接続先が変わったら捨てる
  async function loadSaved() {
    const st = state;
    st.loadingSaved = true; // 読み込み中は送信・会話の切り替えをしない
    renderSessions();
    const id = state.videoId;
    const k = key(id);
    const saved = (await store.get(k))[k];
    if (state.videoId !== id || key(id) !== k) return;
    if (state !== st) return;
    const { sessions, current } = readSaved(saved);
    state.sessions = sessions;
    useEntry(sessions.find((x) => x.sid === current) || null);
    state.loadingSaved = false;
    renderSessions();
  }

  function readSaved(saved) {
    let sessions = Array.isArray(saved?.sessions) ? saved.sessions : [];
    let current = saved?.current ?? "";
    if (!saved?.sessions && UUID_RE.test(saved?.sessionId || "")) {
      // 1 動画 1 会話だった頃の保存形式から移す
      const first = (saved.messages || []).find((m) => m.role === "user");
      sessions = [{ sid: saved.sessionId, workdir: saved.workdir || "", messages: saved.messages || [], title: first?.display || first?.text || "会話", at: saved.at || Date.now() }];
      current = saved.sessionId;
    }
    return { sessions: sessions.filter((x) => UUID_RE.test(x?.sid || "")), current };
  }

  // 作業フォルダ：会話中はそのセッションのフォルダを表示して固定、新しい会話のときだけ選べる
  function renderDirs() {
    const dirs = state.dirs || [];
    const locked = !!state.sessionId;
    const want = locked ? state.workdir : state.pickDir;
    const opts = dirs.slice();
    if (want && !opts.some((d) => d.path === want)) opts.push({ name: want, path: want });
    // 作業フォルダを記録していない古い会話：ブリッジが覚えているフォルダで続ける
    if (locked && !want) opts.unshift({ name: "この会話のフォルダ（記録なし）", path: "" });
    if (!opts.length) opts.push({ name: "既定（youyakun 専用）", path: "" });
    els.dir.innerHTML = opts.map((d) => `<option value="${MD.esc(d.path)}">${MD.esc(d.name)}</option>`).join("");
    els.dir.value = opts.some((d) => d.path === want) ? want : opts[0].path;
    els.dir.disabled = !!(state.busy || state.loadingSaved || state.dirsLoading || state.switching);
    els.dir.title = locked
      ? "この会話の作業フォルダ。変えると、そのフォルダで新しい会話になります"
      : "Claude Code を動かすフォルダ（その CLAUDE.md が読み込まれます）";
  }

  function loadDirs() {
    // 送信時に待てるよう、読み込み中の Promise を持っておく
    state.dirsReady = loadDirsNow();
    return state.dirsReady;
  }

  async function loadDirsNow() {
    const st = state;
    st.dirsLoading = true;
    renderDirs();
    const pid = state.profileId, purl = state.profileUrl;
    state.dirs = []; state.pickDir = ""; // 前の接続先の選択を持ち越さない
    const [r, picked] = await Promise.all([
      chrome.runtime.sendMessage({ type: "workdirs", profileId: pid }).catch(() => null),
      store.get("workdir:" + pid),
    ]);
    if (state !== st || st.profileId !== pid || st.profileUrl !== purl) return; // 古い読み込み結果は使わない
    st.dirsLoading = false;
    state.dirs = r?.ok ? r.workdirs : [];
    const p = picked["workdir:" + pid] || "";
    state.pickDir = state.dirs.some((d) => d.path === p) ? p : state.dirs[0]?.path || "";
    renderDirs();
  }

  // 表示中の接続先を、設定の「使用中」に合わせる。返答中は切り替えず、終わったときにもう一度呼ぶ
  async function syncProfile(announce = true) {
    if (!els || !state?.videoId) return;
    const p = await renderProfiles();
    if (state.busy) { els.prof.value = state.profileId; return; }
    const st = state;
    if (p.id === st.profileId && (p.url || "") === st.profileUrl) { st.switching = false; setBusyControls(); return; }
    st.profileId = p.id;
    st.profileUrl = p.url || "";
    st.dirs = []; st.pickDir = ""; renderDirs(); // 前の接続先のフォルダ候補は消す
    const dirsDone = loadDirs();
    await loadSaved();
    await dirsDone;
    if (state !== st) return;
    st.switching = false;
    setBusyControls();
    if (announce) setStatus(`接続先を「${els.prof.selectedOptions[0]?.textContent || ""}」にしました`);
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && (ch.profiles || ch.activeProfile)) syncProfile();
  });

  // 保存は 1 本ずつ順番に行い、毎回ストレージの最新を読んでから、この会話の分だけ書き換える
  // （同じ動画を別のタブで開いていても、ほかの会話を消さないため）
  let saveChain = Promise.resolve();
  function save(st = state) {
    if (!st.videoId) return;
    const k = keyOf(st);
    const sid = st.sessionId;
    const entry = sid ? { sid, workdir: st.workdir, messages: st.messages.slice(-40) } : null;
    saveChain = saveChain.then(async () => {
      const { sessions: list } = readSaved((await store.get(k))[k]);
      if (entry) {
        let x = list.find((e) => e.sid === sid);
        if (!x) {
          const first = entry.messages.find((m) => m.role === "user");
          x = { sid, title: first?.display || first?.text || "会話" };
          list.push(x);
          while (list.length > MAX_SESSIONS) list.shift(); // 古いものから消す
        }
        Object.assign(x, { workdir: entry.workdir, messages: entry.messages, at: Date.now() });
      }
      await store.set({ [k]: { current: sid, sessions: list } });
      if (state === st && keyOf(st) === k) { st.sessions = list; renderSessions(); }
    }).catch((e) => {
      if (state === st) setStatus("会話を保存できませんでした（ブラウザの保存容量を確認してください）: " + e.message, true);
    });
    return saveChain;
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
      if (info.tracks.length && state.trackIndex == null) {
        state.trackIndex = T.defaultTrackIndex(info.tracks); // 日本語を既定にする
      }
      if (state.trackIndex != null) els.lang.value = String(state.trackIndex);
      if (!info.tracks.length) setStatus("この動画には字幕がないようです（ページの「文字起こし」パネルから取得を試みます）");
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // チャット／字幕のタブ。字幕タブを開いたら（失敗していても）読み込み直す
  function showTab(name, remember = false) {
    for (const t of els.tabs) t.classList.toggle("on", t.dataset.tab === name);
    els.paneChat.hidden = name !== "chat";
    els.paneTr.hidden = name !== "tr";
    if (name === "tr" && state?.videoId && !state.transcript) loadTranscript();
    // 字幕タブを見ている間に届いた返答も、チャットに戻ったら末尾を見せる
    if (name === "chat") els.chat.scrollTop = els.chat.scrollHeight;
    if (remember) store.set({ tab: name });
  }

  // 字幕の読み込み状態は字幕タブに出す（Claude の返答中の表示を上書きしないため）
  function setTStatus(text, err = false, count = "") {
    els.tstatus.textContent = text;
    els.tstatus.classList.toggle("err", err);
    els.cnt.textContent = count;
  }

  // 言語が決まっていなければ先に決める（日本語を既定に）
  async function ensureTrackIndex(st) {
    if (st.trackIndex != null) return;
    const info = await T.getInfo(st.videoId).catch(() => null);
    if (state === st && st.trackIndex == null && info?.tracks.length) st.trackIndex = T.defaultTrackIndex(info.tracks);
  }

  // 今選ばれている言語の字幕を読む。同時に呼ばれても（自動読み込みとボタン）、取得は 1 回にまとめる
  async function loadTranscript() {
    const st = state;
    if (st.transcript) return st.transcript;
    await ensureTrackIndex(st);
    if (state !== st) return null;
    if (st.transcript) return st.transcript;
    const ti = st.trackIndex;
    const key = String(ti);
    if (st.loading?.key !== key) {
      const p = loadTranscriptNow(st, ti).finally(() => { if (st.loading?.p === p) st.loading = null; });
      st.loading = { key, p };
    }
    return st.loading.p;
  }

  async function loadTranscriptNow(st, ti) {
    setTStatus("字幕を読み込んでいます…");
    try {
      const tr = await T.getTranscript(st.videoId, ti);
      // 待っている間に動画や言語が変わったら、古い結果は捨てる（表示も触らない）
      if (state !== st || st.trackIndex !== ti) return null;
      st.transcript = tr;
      const chars = tr.segments.reduce((a, x) => a + x.text.length, 0);
      setTStatus(`${tr.segments.length} 行・${chars.toLocaleString()} 文字（取得方法: ${tr.source}）`, false, String(tr.segments.length));
      renderSegments();
      return tr;
    } catch (e) {
      if (state === st && st.trackIndex === ti) {
        setTStatus(`字幕を読み込めませんでした（このタブを開き直すと再試行します）\n${e.message}`, true, "!");
        if (!st.busy) setStatus("字幕を読み込めませんでした（詳しくは「字幕」タブ）", true);
      }
      return null;
    }
  }

  // ボタン操作用：途中で言語が変わったら、新しい言語の字幕を待ち直す
  async function currentTranscript() {
    const st = state;
    for (let i = 0; i < 4; i++) {
      const ti = st.trackIndex;
      const tr = await loadTranscript();
      if (state !== st) return null;
      if (tr && st.trackIndex === ti) return tr;
      if (st.trackIndex === ti) return null; // 本当に取れなかった
    }
    return null;
  }

  async function copy(timestamps) {
    const st = state;
    const tr = await currentTranscript();
    if (!tr || state !== st) return;
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
    const st = state;
    const sid = st.sessionId, k = keyOf(st);
    const { promptTemplate } = await chrome.storage.local.get("promptTemplate");
    // 待っている間に動画・接続先・会話が変わったら送らない
    if (state !== st || !st.videoId || st.sessionId !== sid || keyOf(st) !== k) return;
    ask(promptTemplate || DEFAULT_PROMPT, "要約して");
  }

  function onSend() {
    if (state.busy) { state.stop?.(); return; }
    const text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    // 送れなかったとき（字幕が取れないなど）は、入力を戻す
    ask(text, text).then((ok) => { if (ok === false && !els.input.value) els.input.value = text; });
  }

  async function ask(instruction, display) {
    if (state.busy || state.loadingSaved || state.switching || !state.videoId) return false;
    showTab("chat");
    setBusy(true); // 字幕の読み込み中に二重に送られないよう、先に立てる
    const st = state;
    // 送る準備（フォルダ一覧・字幕）の間に「止める」が押されたら、送らずに終える
    let cancelled = false;
    st.stop = () => { cancelled = true; if (state === st) { setBusy(false); setStatus("止めました"); } };
    const id = st.videoId;
    let message = instruction;
    if (!st.sessionId) {
      // 最初の 1 通にだけ字幕を付ける。あとはセッションが覚えている
      setStatus("字幕を読み込んでいます…");
      if (!st.sessionId) await st.dirsReady; // 作業フォルダの一覧が届く前に送らない
      if (state !== st || cancelled) return false;
      const tr = await currentTranscript();
      if (state !== st || cancelled) return false; // 別の動画へ移った／止めた
      if (!tr) { setBusy(false); setStatus("字幕を取得できなかったので送れませんでした（「字幕」タブを開くと再試行します）", true); return false; }
      message = `${instruction}\n\n${contextBlock(tr)}`;
    }
    const resumeId = st.sessionId;
    let newId = "";
    const userMsg = { role: "user", text: instruction, display };
    state.messages.push(userMsg);
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
      if (st.port !== port) return;
      st.port = null;
      bubble.classList.remove("typing");
      if (!ai.text) st.messages.splice(st.messages.indexOf(ai), 1);
      if (!resumeId && !st.sessionId) {
        // 新しい会話の 1 通目が失敗した：その試行は履歴に残さない（次の会話に混ざらないように）
        const i = st.messages.indexOf(userMsg);
        if (i >= 0) st.messages.splice(i);
      } else {
        save(st); // 返答の途中で動画を移っても、始めた会話に保存する
      }
      if (state === st) { setBusy(false); renderChat(); setStatus(statusText, err); }
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
          if (sid) st.sessionId = sid;
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
    // 視聴ページ以外では「動画なし」の状態にする（null にすると、途中の処理が state を読んで落ちるため）
    if (!id) { state?.stop?.(); state = resetState(null); root?.remove(); return; }
    if (!root) root = build();
    if (!state || state.videoId !== id) {  // 新しい動画
      state?.stop?.();
      state = resetState(id);
      els.chat.innerHTML = ""; els.segs.innerHTML = ""; els.lang.innerHTML = ""; setStatus(""); setBusy(false);
      renderSessions(); // 前の動画の会話一覧を消す
      setTStatus("");
      els.box.classList.toggle("dark", isDark());
      await syncProfile(false);
      // 動画を開いたら字幕も読み込んでおく（「字幕を見る」を開いたときにすぐ出るように）
      loadInfo().then(() => { if (state.videoId === id) loadTranscript(); });
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
