// 接続先（ブリッジ）の一覧。設定画面・裏側・パネルで共有する。
//   profiles: [{ id, name, url, token, model }]
//   activeProfile: 使う接続先の id
(() => {
  "use strict";
  const DEFAULT_URL = "http://127.0.0.1:8765";
  const newId = () => Math.random().toString(36).slice(2, 10);

  async function load() {
    const s = await chrome.storage.local.get(["profiles", "activeProfile", "bridgeUrl", "token", "model"]);
    let profiles = Array.isArray(s.profiles) ? s.profiles : null;
    let activeProfile = s.activeProfile;
    if (!profiles) {
      // v0.1 の 1 件だけの設定から移す
      profiles = [{ id: newId(), name: "接続先 1", url: s.bridgeUrl || DEFAULT_URL, token: s.token || "", model: s.model || "" }];
      activeProfile = profiles[0].id;
      await chrome.storage.local.set({ profiles, activeProfile });
      await chrome.storage.local.remove(["bridgeUrl", "token", "model"]);
    }
    if (!profiles.some((p) => p.id === activeProfile)) activeProfile = profiles[0]?.id;
    return { profiles, activeProfile };
  }

  async function active() {
    const { profiles, activeProfile } = await load();
    return profiles.find((p) => p.id === activeProfile) || null;
  }

  async function setActive(id) {
    await chrome.storage.local.set({ activeProfile: id });
  }

  async function save(profiles, activeProfile) {
    await chrome.storage.local.set({ profiles, activeProfile });
  }

  globalThis.YouyakunProfiles = { load, active, setActive, save, newId, DEFAULT_URL };
})();
