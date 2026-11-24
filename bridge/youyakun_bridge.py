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
    if changed or not CONFIG_PATH.exists():
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(CONFIG_PATH, 0o600)
    return cfg


CFG = load_config()


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
        if self.path != "/health":
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(401, {"error": "トークンが違います"})
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
        model = req.get("model") or ""
        if model and not re.match(r"^[A-Za-z0-9._\-\[\]]+$", model):
            return self._json(400, {"error": "model の形式が違います"})

        lock = session_lock(sid)
        if not lock.acquire(blocking=False):
            return self._json(409, {"error": "このセッションはまだ返答中です"})
        try:
            self._run_claude(sid, resume, message, req.get("name") or "", model)
        finally:
            lock.release()

    def _emit(self, obj):
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
        with self._wlock:
            self.wfile.write(data)
            self.wfile.flush()

    def _run_claude(self, sid, resume, message, name, model):
        workdir = Path(CFG["workdir"])
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
