#!/usr/bin/env python3
"""youyakun bridge: ブラウザ拡張から Claude Code CLI を呼び出すための小さな HTTP サーバー。

- POST /chat   字幕つきで新しいセッションを始める／session_id を渡すと続きを話す
               応答は NDJSON（1行1イベント）でストリーミングする
- GET  /health 疎通確認（トークン必須）

標準ライブラリだけで動く。設定は ~/.config/youyakun/config.json。
"""
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("YOUYAKUN_CONFIG_DIR", Path.home() / ".config" / "youyakun"))
CONFIG_PATH = CONFIG_DIR / "config.json"
DEFAULT_WORKDIR = Path.home() / ".local" / "share" / "youyakun" / "work"
MAX_BODY = 8 * 1024 * 1024  # 字幕は長くても数百KB。余裕を持って 8MB まで
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

DEFAULT_SYSTEM = (
    "あなたは YouTube 動画の内容を整理して伝えるアシスタントです。"
    "ユーザーから渡される字幕は自動生成の場合があり、誤字や聞き間違いを含みます。"
    "字幕に書かれていないことを事実のように補わないでください。"
    "動画内の位置に触れるときは [mm:ss] または [h:mm:ss] の形式で時刻を添えてください。"
)

_session_locks = {}
_session_locks_guard = threading.Lock()


def load_config():
    cfg = {}
    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    changed = False
    if not cfg.get("token"):
        cfg["token"] = secrets.token_urlsafe(24)
        changed = True
    cfg.setdefault("hosts", ["127.0.0.1"])
    cfg.setdefault("port", 8765)
    cfg.setdefault("workdir", str(DEFAULT_WORKDIR))
    cfg.setdefault("claude", shutil.which("claude") or str(Path.home() / ".local" / "bin" / "claude"))
    cfg.setdefault("model", "")
    cfg.setdefault("system_prompt", DEFAULT_SYSTEM)
    # 拡張から選べる作業フォルダ。roots の直下のフォルダと extra を一覧に出す（これ以外の場所は指定できない）
    docs = Path.home() / "Documents"
    cfg.setdefault("workdir_roots", [str(docs / "01_Project"), str(docs / "02_Area"), str(docs / "03_Resource")])
    cfg.setdefault("workdir_extra", [str(docs / "00_cc")])
    if changed or not CONFIG_PATH.exists():
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(CONFIG_PATH, 0o600)
    return cfg


CFG = load_config()


def list_workdirs():
    """選べる作業フォルダ [{name, path}]。毎回読み直すので、フォルダを増やせばすぐ出る"""
    home_docs = Path.home() / "Documents"
    out = [{"name": "youyakun 専用（既定）", "path": str(Path(CFG["workdir"]).expanduser())}]

    def add(path, root=None):
        p = Path(path).expanduser()
        # シンボリックリンクは載せない（一覧の外の場所を指せてしまうため）
        if p.is_symlink() or not p.is_dir():
            return
        p = p.resolve()
        if root is not None and p.parent != root:
            return
        if any(x["path"] == str(p) for x in out):
            return
        try:
            name = str(p.relative_to(home_docs))
        except ValueError:
            name = str(p)
        out.append({"name": name, "path": str(p)})

    for e in CFG.get("workdir_extra", []):
        add(e)
    for r in CFG.get("workdir_roots", []):
        root = Path(r).expanduser()
        try:
            if not root.is_dir():
                continue
            root = root.resolve()
            children = sorted(root.iterdir(), key=lambda c: c.name)
        except OSError:
            continue  # 読めないフォルダは飛ばす
        for child in children:
            if not child.name.startswith("."):
                try:
                    add(child, root)
                except OSError:
                    pass
    return out


def resolve_workdir(requested):
    """拡張から来たパスが一覧にあるときだけ使う。空なら既定"""
    if not requested:
        return Path(CFG["workdir"]).expanduser()
    for d in list_workdirs():
        if d["path"] == requested:
            return Path(d["path"])
    return None


# セッション ID → 作業フォルダ。続きを話すときに別のフォルダで --resume しないよう、ブリッジ側でも覚えておく
SESSIONS_PATH = CONFIG_DIR / "sessions.json"
_sessions_guard = threading.Lock()


def _read_sessions():
    try:
        return json.loads(SESSIONS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def session_workdir(sid):
    with _sessions_guard:
        return _read_sessions().get(sid)


def remember_session(sid, workdir):
    with _sessions_guard:
        data = _read_sessions()
        data[sid] = str(workdir)
        tmp = SESSIONS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(SESSIONS_PATH)


def session_lock(sid):
    with _session_locks_guard:
        return _session_locks.setdefault(sid, threading.Lock())


def build_command(session_id, resume, name, model):
    cmd = [
        CFG["claude"], "-p",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        # ネットワーク越しに呼ばれるので、ファイル操作やコマンド実行の道具は渡さない
        "--tools", "",
        "--permission-prompts", "none",
    ]
    if resume:
        cmd += ["--resume", session_id]
    else:
        cmd += ["--session-id", session_id, "--append-system-prompt", CFG["system_prompt"]]
        if name:
            cmd += ["--name", name[:80]]
    m = model or CFG.get("model")
    if m:
        cmd += ["--model", m]
    return cmd


class LimitedServer(ThreadingHTTPServer):
    """同時接続数に上限をつける（ヘッダーを送らずに居座る接続で埋まらないように）"""
    daemon_threads = True
    max_conns = 16

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._slots = threading.BoundedSemaphore(self.max_conns)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "youyakun-bridge/0.1"
    timeout = 20  # ヘッダー・本文の受信が 20 秒止まったら切る
    protocol_version = "HTTP/1.0"  # 長さを決めずに流し、最後に接続を閉じる

    # ---- 共通 ----
    def log_message(self, fmt, *args):
        sys.stderr.write("[bridge] %s %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        origin = self.headers.get("Origin", "")
        # 拡張機能（chrome-extension://）からだけ受け付ける。ブラウザのページからの呼び出しは通さない
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        return secrets.compare_digest(auth, "Bearer " + CFG["token"])

    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path not in ("/health", "/workdirs"):
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(401, {"error": "トークンが違います"})
        if self.path == "/workdirs":
            return self._json(200, {"workdirs": list_workdirs()})
        return self._json(200, {"ok": True, "version": self.server_version, "workdir": CFG["workdir"]})

    # ---- 本体 ----
    def do_POST(self):
        if self.path != "/chat":
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(401, {"error": "トークンが違います"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "本文が空か大きすぎます"})
        try:
            req = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return self._json(400, {"error": "JSON が読めません"})

        message = (req.get("message") or "").strip()
        if not message:
            return self._json(400, {"error": "message が空です"})
        sid = req.get("session_id") or ""
        resume = bool(sid)
        if resume and not UUID_RE.match(sid):
            return self._json(400, {"error": "session_id の形式が違います"})
        if not resume:
            sid = str(uuid.uuid4())
        known = session_workdir(sid) if resume else None
        if known:
            # 続きは、セッションを始めたフォルダでしか話せない
            if req.get("workdir") and req.get("workdir") != known:
                return self._json(400, {"error": "このセッションは別の作業フォルダで始めたものです。「新しい会話にする」を押してください"})
            workdir = Path(known)
        else:
            workdir = resolve_workdir(req.get("workdir") or "")
            if workdir is None:
                return self._json(400, {"error": "その作業フォルダは選べません（ブリッジの設定の一覧にありません）"})
        model = req.get("model") or ""
        if model and not re.match(r"^[A-Za-z0-9._\-\[\]]+$", model):
            return self._json(400, {"error": "model の形式が違います"})

        lock = session_lock(sid)
        if not lock.acquire(blocking=False):
            return self._json(409, {"error": "このセッションはまだ返答中です"})
        try:
            self._run_claude(sid, resume, message, req.get("name") or "", model, workdir)
        finally:
            lock.release()

    def _emit(self, obj):
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
        with self._wlock:
            self.wfile.write(data)
            self.wfile.flush()

    def _run_claude(self, sid, resume, message, name, model, workdir):
        # セッションは作業フォルダごとに保存されるので、続きを話すときは同じフォルダで動かす必要がある
        workdir.mkdir(parents=True, exist_ok=True)
        cmd = build_command(sid, resume, name, model)

        self._wlock = threading.Lock()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            proc = subprocess.Popen(
                cmd, cwd=workdir, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, start_new_session=True,
            )
        except OSError as e:
            self._emit({"type": "error", "message": f"claude を起動できません: {e}"})
            return

        # 字幕は長いので引数ではなく標準入力で渡す
        def feed():
            try:
                proc.stdin.write(message.encode())
                proc.stdin.close()
            except BrokenPipeError:
                pass
        threading.Thread(target=feed, daemon=True).start()
        stderr_chunks = []
        threading.Thread(target=lambda: stderr_chunks.append(proc.stderr.read()), daemon=True).start()

        # 返答の最初の文字が出るまで時間がかかることがあるので、10 秒ごとに生存通知を送る
        # （拡張のバックグラウンドが途中で止められないようにするため）
        finished = threading.Event()

        def stop_proc():
            # まず SIGTERM、5 秒たっても終わらなければ SIGKILL
            if proc.poll() is not None:
                return
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(proc.pid, sig)
                except ProcessLookupError:
                    return
                try:
                    proc.wait(timeout=5)
                    return
                except subprocess.TimeoutExpired:
                    continue

        def keepalive():
            while not finished.wait(10):
                try:
                    self._emit({"type": "ping"})
                except OSError:
                    # 拡張側が切った。返答待ちで止まっていても Claude を終わらせる
                    stop_proc()
                    return
        threading.Thread(target=keepalive, daemon=True).start()

        got_result = False
        try:
            self._emit({"type": "start", "session_id": sid, "resume": resume, "workdir": str(workdir)})
            for raw in proc.stdout:
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                t = ev.get("type")
                if t == "stream_event":
                    e = ev.get("event") or {}
                    d = e.get("delta") or {}
                    if e.get("type") == "content_block_delta" and d.get("type") == "text_delta":
                        self._emit({"type": "delta", "text": d.get("text", "")})
                elif t == "result":
                    got_result = True
                    if not resume and not ev.get("is_error"):
                        remember_session(sid, workdir)
                    self._emit({
                        "type": "done",
                        "session_id": ev.get("session_id") or sid,
                        "is_error": bool(ev.get("is_error")),
                        "result": ev.get("result") or "",
                        "cost_usd": ev.get("total_cost_usd"),
                    })
            proc.wait()
            if not got_result:
                err = b"".join(c for c in stderr_chunks if c).decode(errors="replace").strip()
                self._emit({"type": "error", "message": err[-2000:] or f"claude が終了しました（コード {proc.returncode}）"})
        except OSError:
            # 拡張側で止めた・タブを閉じた（BrokenPipe / ConnectionReset / タイムアウト）
            pass
        finally:
            finished.set()
            stop_proc()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--print-token":
        print(CFG["token"])
        return
    servers = []
    for host in CFG["hosts"]:
        try:
            srv = LimitedServer((host, int(CFG["port"])), Handler)
        except OSError as e:
            # Tailscale の起動前などで失敗したら、一度終了して systemd に再起動してもらう
            sys.stderr.write(f"[bridge] {host}:{CFG['port']} で待ち受けできません: {e}\n")
            for s in servers:
                s.shutdown()
            sys.exit(1)
        srv.daemon_threads = True
        servers.append(srv)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        sys.stderr.write(f"[bridge] listening on http://{host}:{CFG['port']}\n")
    if not servers:
        sys.exit(1)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    for s in servers:
        s.shutdown()


if __name__ == "__main__":
    main()
