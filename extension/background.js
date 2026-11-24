// ブリッジ（Claude Code を動かすサーバー）との通信はここで行う。
// YouTube のページ（https）から http のブリッジへは直接つなげないため、拡張の裏側が中継する。
"use strict";
importScripts("profiles.js");
const P = globalThis.YouyakunProfiles;

// 接続先を { bridgeUrl, token, model } の形で返す。id を指定するとその接続先、なければ今使っている接続先
async function settings(profileId) {
  const { profiles, activeProfile } = await P.load();
  const p = profiles.find((x) => x.id === (profileId || activeProfile));
  if (!p) return null;
  return { bridgeUrl: p.url || P.DEFAULT_URL, token: p.token || "", model: p.model || "", name: p.name };
}

const base = (u) => u.replace(/\/+$/, "");

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "health") {
    (async () => {
      const s = { ...(await settings()), ...(msg.override || {}) };
      if (!s.bridgeUrl) return reply({ ok: false, error: "接続先がありません" });
      try {
        const res = await fetch(base(s.bridgeUrl) + "/health", { headers: { Authorization: "Bearer " + s.token } });
        const body = await res.json().catch(() => ({}));
        reply(res.ok ? { ok: true, ...body } : { ok: false, error: body.error || `HTTP ${res.status}` });
      } catch (e) {
        // 既定の 127.0.0.1 は「このマシン自身」。Mac から Pi につなぐときによく残ったままになる
        const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(s.bridgeUrl);
        const hint = local ? "\n127.0.0.1 はこのマシン自身です。別のマシン（Pi など）のブリッジなら、その Tailscale の IP を入れてください" : "";
        reply({ ok: false, error: `ブリッジにつながりません（${base(s.bridgeUrl)}）: ${e.message}${hint}` });
      }
    })();
    return true;
  }
  if (msg?.type === "workdirs") {
    (async () => {
      const s = await settings(msg.profileId);
      if (!s?.token) return reply({ ok: false, error: "トークンが未設定です" });
      try {
        const res = await fetch(base(s.bridgeUrl) + "/workdirs", { headers: { Authorization: "Bearer " + s.token } });
        const body = await res.json().catch(() => ({}));
        reply(res.ok ? { ok: true, workdirs: body.workdirs || [] } : { ok: false, error: body.error || `HTTP ${res.status}` });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg?.type === "openOptions") chrome.runtime.openOptionsPage();
});

// content.js から port で 1 回分の会話を受け取り、返答を少しずつ返す
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat") return;
  const ctrl = new AbortController();
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; ctrl.abort(); });
  const send = (m) => { if (!closed) port.postMessage(m); };

  port.onMessage.addListener(async (req) => {
    const s = await settings(req.profileId);
    if (!s) {
      send({ type: "error", message: "この会話の接続先が見つかりません。「新しい会話にする」を押してください" });
      return;
    }
    // パネルが表示している接続先と、設定の今の URL が食い違ったら送らない（送る途中で設定画面から変えられたとき）
    if (req.profileUrl != null && base(req.profileUrl || P.DEFAULT_URL) !== base(s.bridgeUrl)) {
      send({ type: "error", message: "送る途中で接続先の URL が変わったので送りませんでした。もう一度送ってください" });
      return;
    }
    if (!s.token) {
      send({ type: "error", message: `接続先「${s.name}」のトークンを設定画面で入れてください`, needsSetup: true });
      return;
    }
    try {
      const res = await fetch(base(s.bridgeUrl) + "/chat", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.token },
        body: JSON.stringify({
          session_id: req.session_id || "",
          message: req.message,
          name: req.name || "",
          workdir: req.workdir || "",
          model: s.model || "",
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        send({ type: "error", message: body.error || `HTTP ${res.status}` });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { send(JSON.parse(line)); } catch { /* 壊れた行は捨てる */ }
        }
      }
      send({ type: "closed" });
    } catch (e) {
      if (!closed) send({ type: "error", message: "ブリッジにつながりません: " + e.message });
    }
  });
});
