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
    const body = res.ok ? await res.text() : "";
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
    const p = (s || "").trim().split(":").map(Number);
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

  async function viaDom() {
    let segs = readDomSegments();
    if (segs.length) return segs;
    // 概要欄を開いてから「文字起こしを表示」ボタンを押す
    document.querySelector("tp-yt-paper-button#expand, #description-inline-expander #expand")?.click();
    await sleep(300);
    const btn =
      document.querySelector("ytd-video-description-transcript-section-renderer button") ||
      [...document.querySelectorAll("button, ytd-button-renderer")].find((b) =>
        /文字起こし|transcript/i.test(b.textContent || b.getAttribute("aria-label") || "")
      );
    if (!btn) throw new Error("「文字起こしを表示」ボタンが見つかりません");
    btn.click();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      segs = readDomSegments();
      if (segs.length) return segs;
    }
    throw new Error("文字起こしパネルが読み込めません");
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

  async function getTranscript(videoId, trackIndex = 0) {
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
    const track = info.tracks[trackIndex];
    const tries = [];
    if (info.data.player) {
      tries.push(["innertube", () => viaInnertube(info.data, trackIndex === 0 ? null : track)]);
      tries.push(["timedtext", () => viaTimedtext(track)]);
    }
    // ページのパネルは表示中の動画のときだけ使える（言語はパネルで選ばれているもの）
    if (onPage) tries.push(["dom", viaDom]);
    for (const [source, fn] of tries) {
      try {
        const segments = await fn();
        return { ...info, segments, source, track: source === "dom" && trackIndex !== 0 ? null : track };
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

  globalThis.YouyakunTranscript = { getInfo, getTranscript, toText, fmtTime, parseClock };
})();
