// 字幕の取得。YouTube の仕様変更に備えて 3 つの方法を順に試す。
//  1. innertube の get_transcript（YouTube の「文字起こし」パネルと同じ API）
//  2. timedtext（字幕ファイル）の json3
//  3. ページ上の「文字起こし」パネルを開いて読み取る
(() => {
  "use strict";

  // marker の直後にある JSON オブジェクトを、括弧の対応を数えて切り出す
  function extractJson(text, marker) {
    let i = text.indexOf(marker);
    if (i < 0) return null;
    i = text.indexOf("{", i + marker.length);
    if (i < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  // オブジェクトの中から key を持つ値をすべて集める（構造が少し変わっても拾えるように）
  function findAll(obj, key, out = []) {
    if (!obj || typeof obj !== "object") return out;
    if (Array.isArray(obj)) { for (const v of obj) findAll(v, key, out); return out; }
    for (const k in obj) {
      if (k === key) out.push(obj[k]);
      findAll(obj[k], key, out);
    }
    return out;
  }

  const textOf = (t) => {
    if (!t) return "";
    if (typeof t === "string") return t;
    if (t.simpleText) return t.simpleText;
    if (t.runs) return t.runs.map((r) => r.text || "").join("");
    if (t.content) return t.content;
    return "";
  };

  async function loadWatchData(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: "omit",
    });
    if (!res.ok) throw new Error(`視聴ページの取得に失敗しました（${res.status}）`);
    const html = await res.text();
    const player = extractJson(html, "ytInitialPlayerResponse = ") || extractJson(html, "ytInitialPlayerResponse=");
    const initialData = extractJson(html, "ytInitialData = ") || extractJson(html, "ytInitialData=");
    const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || "";
    const context = extractJson(html, '"INNERTUBE_CONTEXT":');
    return { player, initialData, apiKey, context };
  }

  function listTracks(player) {
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return tracks.map((t) => ({
      languageCode: t.languageCode,
      vssId: t.vssId || "",
      name: textOf(t.name) || t.languageCode,
      auto: t.kind === "asr",
      baseUrl: t.baseUrl,
    }));
  }

  function parseInnertube(json) {
    const segments = [];
    // 構造の深さに関係なく、出てきた順に拾う
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.transcriptSegmentRenderer) {
        const s = o.transcriptSegmentRenderer;
        const text = textOf(s.snippet).replace(/\s+/g, " ").trim();
        if (text) segments.push({ startMs: Number(s.startMs) || 0, text });
        return;
      }
      if (o.transcriptSectionHeaderRenderer) {
        const h = o.transcriptSectionHeaderRenderer;
        const title = textOf(h.snippet || h.sectionHeader?.sectionHeaderViewModel?.headline);
        if (title) segments.push({ startMs: Number(h.startMs) || 0, text: title, chapter: true });
        return;
      }
      for (const k in o) walk(o[k]);
    })(json);
    const menus = [];
    for (const items of findAll(json, "subMenuItems")) {
      for (const it of items || []) {
        const params = it?.continuation?.reloadContinuationData?.continuation;
        if (params) menus.push({ title: it.title, selected: !!it.selected, params });
      }
    }
    return { segments, menus };
  }

  async function callGetTranscript(data, params) {
    const url = `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false${data.apiKey ? "&key=" + data.apiKey : ""}`;
    const res = await fetch(url, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: data.context, params }),
    });
    if (!res.ok) throw new Error(`get_transcript ${res.status}`);
    return parseInnertube(await res.json());
  }

  async function viaInnertube(data, track) {
    const ep = findAll(data.initialData, "getTranscriptEndpoint")[0];
    if (!ep?.params || !data.context) throw new Error("文字起こしの入口が見つかりません");
    let r = await callGetTranscript(data, ep.params);
    if (track && r.menus.length) {
      const cur = r.menus.find((m) => m.selected);
      const want = r.menus.find((m) => m.title === track.name);
      if (want && (!cur || cur.title !== want.title)) r = await callGetTranscript(data, want.params);
      else if (!want) throw new Error("指定の言語が文字起こしメニューにありません");
    }
    if (!r.segments.length) throw new Error("文字起こしが空でした");
    return r.segments;
  }

  async function viaTimedtext(track) {
    if (!track?.baseUrl) throw new Error("字幕ファイルの URL がありません");
    const u = new URL(track.baseUrl, location.origin);
    u.searchParams.set("fmt", "json3");
    const res = await fetch(u.toString(), { credentials: "omit" });
    return parseJson3(res.ok ? await res.text() : "");
  }

  function parseJson3(body) {
    if (!body) throw new Error("字幕ファイルが空でした");
    const json = JSON.parse(body);
    const segments = [];
    for (const ev of json.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const prev = segments[segments.length - 1];
      if (prev && prev.text === text) continue; // 自動字幕の重複行
      segments.push({ startMs: ev.tStartMs || 0, text });
    }
    if (!segments.length) throw new Error("字幕ファイルに文がありません");
    return segments;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parseClock(s) {
    const m = (s || "").match(/(\d+:)?\d+:\d{2}/);
    const p = (m ? m[0] : "").split(":").map(Number);
    if (p.some(isNaN)) return 0;
    return p.reduce((a, b) => a * 60 + b, 0) * 1000;
  }

  function readDomSegments() {
    const nodes = document.querySelectorAll(
      "ytd-transcript-segment-renderer, transcript-segment-view-model, ytd-transcript-section-header-renderer"
    );
    const segments = [];
    for (const n of nodes) {
      const isHeader = n.tagName.toLowerCase().includes("header");
      const ts = n.querySelector(".segment-timestamp, [class*='timestamp']")?.textContent || "";
      const textEl = n.querySelector(".segment-text, yt-formatted-string, [class*='text']");
      const text = (textEl?.textContent || n.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      segments.push({ startMs: parseClock(ts), text: isHeader ? text : text.replace(ts.trim(), "").trim(), chapter: isHeader });
    }
    return segments.filter((s) => s.text);
  }

  // YouTube の文字起こしパネルは開かない（サイドバーに出てしまうため）。すでに開いているときだけ読む
  async function viaDom() {
    const segs = readDomSegments();
    if (!segs.length) throw new Error("文字起こしパネルは開いていません");
    return segs;
  }

  // ページ側（page.js）から、プレイヤーが使った字幕の URL をもらう
  function askPage(videoId, fresh = false) {
    return new Promise((resolve, reject) => {
      const nonce = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { window.removeEventListener("message", onMsg); reject(new Error("ページから応答がありません")); }, 9000);
      function onMsg(ev) {
        const d = ev.data;
        if (ev.source !== window || !d || d.src !== "youyakun-page" || d.nonce !== nonce) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        d.url ? resolve(d.url) : reject(new Error(d.error || "字幕の URL がありません"));
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ src: "youyakun-cs", type: "potUrl", videoId, nonce, fresh }, location.origin);
    });
  }

  // プレイヤーの字幕 URL の言語だけ差し替えて、好きな言語の字幕を読む
  async function viaPlayer(videoId, track) {
    if (!track) throw new Error("字幕の言語がありません");
    const once = async (fresh) => {
      const u = new URL(await askPage(videoId, fresh));
      // ページ側の応答は信用しきらない：YouTube の字幕ファイルで、この動画のものだけ使う
      if (u.origin !== "https://www.youtube.com" || u.pathname !== "/api/timedtext" || u.searchParams.get("v") !== videoId) {
        throw new Error("字幕の URL が不正です");
      }
      u.searchParams.set("lang", track.languageCode);
      if (track.auto) u.searchParams.set("kind", "asr");
      else u.searchParams.delete("kind");
      u.searchParams.delete("tlang");
      u.searchParams.set("fmt", "json3");
      return parseJson3(await (await fetch(u.toString())).text());
    };
    try {
      return await once(false);
    } catch {
      return await once(true); // URL の期限切れなどで空なら、プレイヤーに読み込み直させてもう一度
    }
  }

  // 公開する関数 ------------------------------------------------------------
  const cache = new Map();

  async function getInfo(videoId) {
    if (cache.has(videoId)) return cache.get(videoId);
    const p = loadWatchData(videoId).then((data) => {
      const vd = data.player?.videoDetails || {};
      return {
        data,
        videoId,
        title: vd.title || document.title.replace(/ - YouTube$/, ""),
        channel: vd.author || "",
        lengthSec: Number(vd.lengthSeconds) || 0,
        tracks: listTracks(data.player),
      };
    });
    cache.set(videoId, p);
    p.catch(() => cache.delete(videoId));
    return p;
  }

  // 既定の字幕：日本語（手動）→ 日本語（自動生成）→ 先頭
  function defaultTrackIndex(tracks) {
    const i = tracks.findIndex((t) => t.languageCode.startsWith("ja") && !t.auto);
    if (i >= 0) return i;
    const j = tracks.findIndex((t) => t.languageCode.startsWith("ja"));
    return j >= 0 ? j : 0;
  }

  async function getTranscript(videoId, trackIndex = null) {
    const errors = [];
    const onPage = new URLSearchParams(location.search).get("v") === videoId;
    let info;
    try {
      info = await getInfo(videoId);
    } catch (e) {
      // 視聴ページを読めなくても、表示中の動画ならページの文字起こしパネルから取れる
      if (!onPage) throw e;
      errors.push(`watch: ${e.message}`);
      info = { data: {}, videoId, title: document.title.replace(/ - YouTube$/, ""), channel: "", lengthSec: 0, tracks: [] };
    }
    if (trackIndex == null) trackIndex = defaultTrackIndex(info.tracks);
    const track = info.tracks[trackIndex];
    const tries = [];
    if (onPage && track) tries.push(["player", () => viaPlayer(videoId, track)]);
    if (info.data.player) {
      tries.push(["innertube", () => viaInnertube(info.data, track)]);
      tries.push(["timedtext", () => viaTimedtext(track)]);
    }
    // ページのパネルは表示中の動画のときだけ使える（言語はパネルで選ばれているもの）
    if (onPage) tries.push(["dom", viaDom]);
    for (const [source, fn] of tries) {
      try {
        const segments = await fn();
        return { ...info, segments, source, track: source === "dom" ? null : track };
      } catch (e) {
        errors.push(`${source}: ${e.message}`);
      }
    }
    if (!info.tracks.length && info.data.player) throw new Error("この動画には字幕がありません");
    throw new Error("字幕を取得できませんでした\n" + errors.join("\n"));
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function toText(segments, { timestamps = false } = {}) {
    if (timestamps) {
      return segments.map((s) => (s.chapter ? `\n## ${s.text}` : `[${fmtTime(s.startMs)}] ${s.text}`)).join("\n").trim();
    }
    return segments.map((s) => (s.chapter ? `\n## ${s.text}\n` : s.text)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  globalThis.YouyakunTranscript = { getInfo, getTranscript, defaultTrackIndex, toText, fmtTime, parseClock };
})();
