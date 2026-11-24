// ページ側（MAIN world）で動くスクリプト。
// YouTube の字幕ファイル（timedtext）は、プレイヤーが付ける確認用の値（pot）がないと空で返ってくる。
// そこでプレイヤーが字幕を読み込むときの URL を覚えておき、言語だけ差し替えて使えるようにする。
(() => {
  "use strict";
  const seen = new Map(); // videoId → pot 付きの timedtext URL

  function remember(url) {
    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.endsWith("/api/timedtext") || !u.searchParams.has("pot")) return;
      const v = u.searchParams.get("v");
      if (v) seen.set(v, u.toString());
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
    for (const e of performance.getEntriesByType("resource")) remember(e.name);
    return seen.get(videoId);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function potUrl(videoId, fresh) {
    // 前の URL で空が返ったときは取り直す（古い URL は使わない）
    const stale = fresh ? seen.get(videoId) || null : null;
    if (fresh) seen.delete(videoId);
    else if (seen.get(videoId) || fromPerformance(videoId)) return seen.get(videoId);
    const p = document.getElementById("movie_player");
    if (!p?.getVideoData || p.getVideoData().video_id !== videoId) throw new Error("プレイヤーが別の動画です");
    // 字幕を一瞬だけオンにして、プレイヤーに字幕ファイルを読み込ませる
    let before = null;
    try { before = p.getOption("captions", "track"); } catch {}
    const wasOn = !!before?.languageCode;
    let setTo = null;
    try {
      p.loadModule?.("captions");
      if (!wasOn) {
        const list = p.getOption("captions", "tracklist") || [];
        // モジュールの読み込み直後は一覧が空のことがあるので、動画情報の字幕一覧も見る
        const code = p.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0]?.languageCode;
        const first = list[0] || (code ? { languageCode: code } : null);
        if (first) { p.setOption("captions", "track", first); setTo = first.languageCode; }
      } else {
        p.setOption("captions", "reload", true);
      }
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const got = fresh ? seen.get(videoId) : seen.get(videoId) || fromPerformance(videoId);
        if (got && got !== stale) break;
      }
    } finally {
      // 自分でオンにしたときだけ戻す。待っている間に動画が変わったり、ユーザーが字幕を切り替えたりしていたら触らない
      let now = null;
      try { now = p.getOption("captions", "track")?.languageCode || null; } catch {}
      const same = p.getVideoData?.().video_id === videoId;
      if (!wasOn && setTo && same && now === setTo) {
        try { p.setOption("captions", "track", {}); } catch {}
        try { p.unloadModule?.("captions"); } catch {}
      }
    }
    const url = seen.get(videoId);
    if (!url || url === stale) throw new Error("プレイヤーから字幕の URL を取れませんでした");
    return url;
  }

  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.src !== "youyakun-cs" || d.type !== "potUrl") return;
    let reply;
    try { reply = { url: await potUrl(d.videoId, !!d.fresh) }; } catch (e) { reply = { error: e.message }; }
    window.postMessage({ src: "youyakun-page", nonce: d.nonce, ...reply }, location.origin);
  });
})();
