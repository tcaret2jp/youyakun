"use strict";
const P = globalThis.YouyakunProfiles;
const $ = (id) => document.getElementById(id);
const say = (el, t, err = false) => { el.textContent = t; el.className = "msg" + (err ? " err" : ""); };

let profiles = [];
let activeProfile = "";
let selected = ""; // 画面で編集している接続先

const savedCount = () => profiles.filter((p) => p.saved !== false).length;

function render() {
  const tabs = $("tabs");
  tabs.innerHTML = "";
  for (const p of profiles) {
    const t = document.createElement("span");
    t.className = "tab" + (p.id === selected ? " sel" : "") + (p.id === activeProfile ? " active" : "");
    t.innerHTML = '<span class="dot"></span>';
    t.append(p.name || "（名前なし）");
    t.onclick = () => { selected = p.id; render(); };
    tabs.append(t);
  }
  const add = document.createElement("span");
  add.className = "tab";
  add.textContent = "＋ 追加";
  add.onclick = () => {
    const p = { id: P.newId(), name: `接続先 ${profiles.length + 1}`, url: "", token: "", model: "", saved: false };
    profiles.push(p);
    selected = p.id;
    render();
    say($("msg"), "入力して「保存」を押すと追加されます");
  };
  tabs.append(add);

  const p = profiles.find((x) => x.id === selected);
  $("card").hidden = !p;
  if (!p) return;
  $("name").value = p.name || "";
  $("url").value = p.url || "";
  $("token").value = p.token || "";
  $("model").value = p.model || "";
  $("use").disabled = p.id === activeProfile || p.saved === false;
  $("use").textContent = p.id === activeProfile ? "使用中" : "この接続先を使う";
  $("del").disabled = p.saved !== false && savedCount() <= 1;
  say($("msg"), "");
}

function readForm() {
  return {
    name: $("name").value.trim() || "（名前なし）",
    url: ($("url").value.trim() || P.DEFAULT_URL).replace(/\/+$/, ""),
    token: $("token").value.trim(),
    model: $("model").value.trim(),
  };
}

// ブリッジのアドレスへの通信許可をもらう（ボタンを押したときにしか聞けない）
async function grant(url) {
  let origin;
  try { origin = new URL(url).origin + "/*"; } catch { throw new Error("URL の形式が正しくありません"); }
  const ok = await chrome.permissions.request({ origins: [origin] });
  if (!ok) throw new Error("ブリッジへの接続が許可されませんでした");
}

// 保存していない「＋ 追加」は残さない。使用中は、パネル側で切り替えられているかもしれないので保存直前に読み直す
async function persist(newActive) {
  const list = profiles.filter((p) => p.saved !== false);
  if (!list.length) throw new Error("接続先が 1 つもなくなるため保存できません");
  const cur = (await P.load()).activeProfile;
  let act = newActive || cur;
  if (!list.some((p) => p.id === act)) act = list[0].id;
  activeProfile = act;
  await P.save(list, act);
}

$("save").onclick = async () => {
  const v = readForm();
  try {
    await grant(v.url);
    const p = profiles.find((x) => x.id === selected);
    Object.assign(p, v);
    delete p.saved;
    await persist();
    render();
    say($("msg"), "保存しました");
  } catch (e) { say($("msg"), e.message, true); }
};

$("test").onclick = async () => {
  const v = readForm();
  try {
    await grant(v.url);
    say($("msg"), "確かめています…");
    const r = await chrome.runtime.sendMessage({ type: "health", override: { bridgeUrl: v.url, token: v.token } });
    say($("msg"), r.ok ? `つながりました（作業フォルダ: ${r.workdir}）` : r.error, !r.ok);
  } catch (e) { say($("msg"), e.message, true); }
};

$("use").onclick = async () => {
  await persist(selected);
  render();
  say($("msg"), "この接続先を使います");
};

$("del").onclick = async () => {
  const p = profiles.find((x) => x.id === selected);
  if (!p) return;
  if (p.saved === false) { // 未保存の下書きは消すだけ
    profiles = profiles.filter((x) => x.id !== selected);
    selected = activeProfile;
    render();
    return;
  }
  if (savedCount() <= 1) { say($("msg"), "最後の接続先は削除できません", true); return; }
  if (!confirm(`接続先「${p.name}」を削除しますか？`)) return;
  profiles = profiles.filter((x) => x.id !== selected);
  await persist(activeProfile === selected ? null : undefined);
  selected = activeProfile;
  render();
};

$("savePrompt").onclick = async () => {
  await chrome.storage.local.set({ promptTemplate: $("promptTemplate").value.trim() });
  say($("msg2"), "保存しました");
};

(async () => {
  ({ profiles, activeProfile } = await P.load());
  selected = activeProfile;
  $("promptTemplate").value = (await chrome.storage.local.get("promptTemplate")).promptTemplate || "";
  render();
})();
