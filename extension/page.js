// ページ側（MAIN world）で動くスクリプト。
// YouTube の字幕ファイル（timedtext）は、プレイヤーが付ける確認用の値（pot）がないと空で返ってくる。
// そこでプレイヤーが字幕を読み込むときの URL を覚えておき、言語だけ差し替えて使えるようにする。
(() => {
  "use strict";
  const seen = new Map(); // videoId → { url: pot 付きの timedtext URL, at: 拾った時刻 }

  function remember(url) {
    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.endsWith("/api/timedtext") || !u.searchParams.has("pot")) return;
      const v = u.searchParams.get("v");
      if (v) seen.set(v, { url: u.toString(), at: performance.now() });
    } catch {}
  }

  // プレイヤーの通信（fetch / XHR）から字幕の URL を拾う
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try { remember(typeof input === "string" ? input : input?.url); } catch {}
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { remember(String(url)); } catch {}
    return origOpen.apply(this, arguments);
  };

  function fromPerformance(videoId) {
    // performance の記録は時刻を持たないので、まだ拾っていない動画のときだけ使う
    if (!seen.has(videoId)) for (const e of performance.getEntriesByType("resource")) remember(e.name);
    return seen.get(videoId);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // プレイヤーの字幕設定（オン／オフと言語）は YouTube がここに覚えている。字幕を一瞬オンにすると書き換わるので、元に戻す
  const PREF_KEYS = ["yt-player-caption-persistence", "yt-player-caption-sticky-language"];
  const snapshotPrefs = () => PREF_KEYS.map((k) => [k, localStorage.getItem(k)]);
  const restorePrefs = (snap) => {
    for (const [k, v] of snap) {
      try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
    }
  };

  // 字幕を一瞬オンにする間、画面には出さない
  function hideCaptions(on) {
    let st = document.getElementById("youyakun-hide-cc");
    if (on && !st) {
      st = document.createElement("style");
      st.id = "youyakun-hide-cc";
      st.textContent = ".ytp-caption-window-container{visibility:hidden!important}";
      document.documentElement.append(st);
    } else if (!on && st) st.remove();
  }

  let busy = null; // 同時に 2 回動かさない
  let pendingPrefs = null; // 字幕を一瞬オンにしている間の元の設定
  // 途中で別の動画へ移るときは、次の動画が読み込まれる前に設定を戻す
  let navGen = 0; // 動画を移るたびに増える。途中で移ったら字幕には触らない
  document.addEventListener("yt-navigate-start", () => {
    navGen++;
    if (pendingPrefs) { restorePrefs(pendingPrefs); pendingPrefs = null; } // 次の動画が読み込まれる前に一度だけ戻す
  }, true);

  async function potUrl(videoId, fresh, deadline) {
    while (busy) await busy.catch(() => {});
    if (Date.now() > deadline - 20000) throw new Error("時間切れ"); // 待っている間に依頼元があきらめた
    const run = potUrlInner(videoId, fresh, deadline);
    busy = run;
    try { return await run; } finally { if (busy === run) busy = null; }
  }

  async function potUrlInner(videoId, fresh, deadline) {
    const gen = navGen;
    const alive = () => navGen === gen && Date.now() < deadline;
    // 前の URL で空が返ったときは取り直す。URL の文字列は同じことがあるので、拾った時刻で新しさを見る
    const startedAt = performance.now();
    if (!fresh && (seen.get(videoId) || fromPerformance(videoId))) return seen.get(videoId).url;
    const fresher = () => {
      const got = fresh ? seen.get(videoId) : seen.get(videoId) || fromPerformance(videoId);
      return got && (!fresh || got.at > startedAt) ? got.url : null;
    };

    // 開いた直後はプレイヤーがまだないことがあるので待つ
    let p = null;
    for (let i = 0; i < 50; i++) {
      p = document.getElementById("movie_player");
      if (p?.getVideoData && p.getVideoData().video_id === videoId) break;
      p = null;
      await sleep(200);
    }
    if (!p) throw new Error("プレイヤーの準備ができていません");
    const sameVideo = () => alive() && p.getVideoData?.().video_id === videoId;
    const adShowing = () => p.classList.contains("ad-showing");
    const curTrack = () => { try { return p.getOption("captions", "track")?.languageCode || null; } catch { return null; } };

    // 広告の間は本編の字幕を触らない
    while (adShowing() && sameVideo()) await sleep(200);
    if (!sameVideo()) throw new Error("動画が切り替わったか、時間切れです");
    const wasOn = !!curTrack();
    if (wasOn) {
      // ユーザーが字幕をオンにしている：同じ字幕を読み込み直してもらうだけ（設定は変わらない）
      for (let i = 0; i < 50 && !fresher() && sameVideo(); i++) {
        if (i % 15 === 0 && !adShowing()) { try { p.setOption("captions", "reload", true); } catch {} }
        await sleep(200);
      }
    } else {
      // 字幕はオフ：画面に出さずに一瞬オンにし、URL が取れたらすぐオフに戻す
      const prefs = snapshotPrefs();
      pendingPrefs = prefs;
      let setTo = null;
      hideCaptions(true);
      try {
        try { p.loadModule?.("captions"); } catch {}
        // 開いた直後のプレイヤーは pot なしの URL で一度読み込んでしまい（中身は空）、それを使い回す。
        // そこで字幕を外して付け直し、pot 付きで読み込み直させる（取れるまで 2.4 秒ごと、最大 15 秒）
        for (let i = 0; i < 75 && !fresher() && sameVideo(); i++) {
          const cur = curTrack();
          if (setTo && cur && cur !== setTo) break; // ユーザーが自分で字幕を選んだ
          const list = (() => { try { return p.getOption("captions", "tracklist") || []; } catch { return []; } })();
          if (adShowing()) {
            // 広告の間は何もしない
          } else if (!list.length) {
            // プレイヤーの準備ができる（字幕の一覧が出る）までは指示しても無視される
            if (i % 10 === 0) { try { p.loadModule?.("captions"); } catch {} }
          } else if (!setTo || i % 12 === 0) {
            try {
              if (cur) { p.setOption("captions", "track", {}); await sleep(150); }
              if (!sameVideo()) break; // 待っている間に動画が変わった
              p.setOption("captions", "track", list[0]);
              setTo = list[0].languageCode;
            } catch {}
          }
          await sleep(200);
        }
      } finally {
        // 自分でオンにした字幕だけ消す。遅れて反映されることがあるので、しばらく見張る
        const userPicked = () => { const c = curTrack(); return setTo && c && c !== setTo; };
        // 途中で動画を移ったときは、移るときに設定を戻し済みなので、ここでは何もしない
        if (navGen === gen && !userPicked()) {
          for (let i = 0; i < 20; i++) { // 4 秒見張る
            if (navGen !== gen || p.getVideoData?.().video_id !== videoId || userPicked()) break;
            if (curTrack()) {
              try { p.setOption("captions", "track", {}); } catch {}
              try { p.unloadModule?.("captions"); } catch {}
            }
            await sleep(200);
          }
          restorePrefs(prefs);
        }
        if (pendingPrefs === prefs) pendingPrefs = null;
        hideCaptions(false);
      }
    }
    const url = fresher();
    if (!url) throw new Error("プレイヤーから字幕の URL を取れませんでした");
    return url;
  }

  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.src !== "youyakun-cs" || d.type !== "potUrl") return;
    let reply;
    try { reply = { url: await potUrl(d.videoId, !!d.fresh, d.deadline || Date.now() + 30000) }; } catch (e) { reply = { error: e.message }; }
    window.postMessage({ src: "youyakun-page", nonce: d.nonce, ...reply }, location.origin);
  });
})();
