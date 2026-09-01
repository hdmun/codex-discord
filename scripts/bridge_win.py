#!/usr/bin/env python3
"""codex-discord 브리지 Windows 진입점 — scripts/install.sh·tui-up.sh 병행본 (B2-4).

macOS bash 정본(install.sh·tui-up.sh·tui-restart.sh)은 한 줄도 건드리지 않는다
(재정박 9'). launchd plist 자리는 schtasks(ADR-0002, 관리자 권한 필요), tmux pane
자리는 orca terminal(ADR-0001) — 백엔드 판정 로직은 src/pane.orca.mjs와 짝이다
(docs/pane-mjs-design.md 참고, 특히 §5.1 bracketed paste·§5.4 판정·§9 실측).

orca CLI 헬퍼(orca_bin/orca_json/runtime_ready/ensure_runtime/worktree_selector 등)와
schtasks·프로세스 판정 헬퍼는 discord-multiagent/scripts/bot_win.py 및
folder-bot/.../botctl_win.py에서 가져온 것과 동형이다(플랜 재사용 목록).

launchd KeepAlive의 대체물은 별도 감시자 프로세스(_watchdog)다 — bot_win.py의
spawn_watcher와 같은 구조: 프로세스로 분리해 데몬이 죽어도 독립적으로 재기동한다.

사용:
  python bridge_win.py install [env파일]
  python bridge_win.py up [env파일]
  python bridge_win.py stop [env파일]
  python bridge_win.py restart [env파일]
  python bridge_win.py tui-up [env파일]
  python bridge_win.py tui-restart [env파일]
  python bridge_win.py autostart-install [env파일]
  python bridge_win.py autostart-remove [env파일]
  python bridge_win.py autostart-boot [env파일]
"""
from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

if sys.platform == "win32":
    # 콘솔 기본 코드페이지(cp949)는 로그의 한글·em-dash를 못 담아 죽는다(bot_win.py 승계).
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT_DIR = Path(__file__).resolve().parent.parent
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259
WATCHDOG_INTERVAL_SEC = 15  # macOS ThrottleInterval과 동일 값


def log(msg: str) -> None:
    print(f"[bridge-win {time.strftime('%F %T')}] {msg}")


def fail(msg: str) -> None:
    sys.exit(f"오류: {msg}")


# ---------------------------------------------------------------- .env 로딩

def env_path(env_file: str) -> Path:
    p = Path(env_file)
    return p if p.is_absolute() else PROJECT_DIR / env_file


def parse_env_file(path: Path) -> dict:
    """node --env-file과 동등한 단순 KEY=VALUE 파서. export·변수치환 없음
    (.env.example이 그 형태로만 쓰인다 — dotenv 문법 확장은 지원하지 않는다)."""
    if not path.exists():
        fail(f"{path} 없음 — .env.example을 복사해 채운 뒤 다시 실행하세요")
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def data_dir_for(env: dict) -> Path:
    return PROJECT_DIR / env.get("DATA_DIR", "data")


def instance_suffix(env_file: str) -> str | None:
    name = Path(env_file).name
    if name in (".env", "env"):
        return None
    return name[len(".env."):] if name.startswith(".env.") else name


def task_name_for(env_file: str) -> str:
    """schtasks 태스크 이름 — plist Label(com.codex-discord.<이름>)의 짝. 인스턴스별로
    나뉘어야 folder-bot 등 다중 봇이 서로의 자동 기동 등록을 덮어쓰지 않는다."""
    suffix = instance_suffix(env_file)
    return "CodexDiscordBridgeWin" if suffix is None else f"CodexDiscordBridgeWin-{suffix}"


def daemon_log_for(env_file: str) -> Path:
    """기본 .env는 logs/daemon.log(기존 계약 — install.sh 종료부 grep 대상과 동일 경로),
    인스턴스 env(.env.<이름>)는 logs/daemon-<이름>.log로 분리."""
    suffix = instance_suffix(env_file)
    return PROJECT_DIR / "logs" / ("daemon.log" if suffix is None else f"daemon-{suffix}.log")


# ---------------------------------------------------------------- 전제조건

def node_bin() -> str:
    found = shutil.which("node")
    if not found:
        fail("node를 찾을 수 없음 (Node 22+ 필요)")
    r = subprocess.run([found, "--version"], capture_output=True, text=True)
    major = int(r.stdout.strip().lstrip("v").split(".")[0])
    if major < 22:
        fail(f"Node 22+ 필요 (현재: {r.stdout.strip()})")
    return found


def codex_bin(env: dict) -> str:
    b = env.get("CODEX_BIN") or shutil.which("codex")
    if not b:
        fail("codex를 찾을 수 없음 — .env에 CODEX_BIN을 지정하거나 PATH에 codex를 두세요")
    return b


def preflight(env_file: str) -> dict:
    env = parse_env_file(env_path(env_file))
    for key in ("DISCORD_TOKEN", "ALLOWED_USER_IDS", "CODEX_WORKDIR"):
        if not env.get(key):
            fail(f"{env_file}에 {key} 필요")
    node_bin()
    codex_bin(env)
    return env


def tui_on(env: dict) -> bool:
    return bool(env.get("TUI_PANE") and env.get("TUI_CHANNEL_ID"))


# ---------------------------------------------------------------- pid 판정 (bot_win.py:111-125)

def pid_alive(pid: int) -> bool:
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def read_pidfile(pidfile: Path) -> int | None:
    try:
        return int(pidfile.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- orca CLI 연동
# (discord-multiagent/scripts/bot_win.py:220-259 및 pane-mjs-design.md §5.2/5.3과 동형)

def orca_bin() -> str:
    return os.environ.get("ORCA_CLI_COMMAND") or "orca"


def orca_json(*args, timeout=30):
    r = subprocess.run([orca_bin(), *args, "--json"], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    try:
        data = json.loads(r.stdout) if r.stdout.strip() else {}
    except ValueError:
        data = {}
    return r.returncode, data


def runtime_ready() -> bool:
    rc, data = orca_json("status")
    runtime = data.get("result", {}).get("runtime", {})
    return rc == 0 and runtime.get("state") == "ready" and runtime.get("reachable") is True


def ensure_runtime(timeout: int = 90) -> None:
    if runtime_ready():
        return
    log("orca 런타임 미기동 — orca serve로 헤드리스 기동 시도")
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([orca_bin(), "serve"], stdin=subprocess.DEVNULL,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                      close_fds=True, **kwargs)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if runtime_ready():
            return
        time.sleep(2)
    fail(f"orca 런타임이 {timeout}초 안에 기동하지 않음 — orca 수동 실행 후 재시도")


def worktree_selector(folder: Path) -> str:
    """orca terminal은 등록된 worktree(레포 루트)에만 붙는다(실측, pane-mjs-design.md
    §5.3·§9) — codex-discord 레포 루트를 selector로 쓴다. 미등록이면 아래에서
    selector_not_found로 명시 실패한다."""
    return f"path:{folder.as_posix()}"


def orca_terminal_list(folder: Path) -> list:
    rc, data = orca_json("terminal", "list", "--worktree", worktree_selector(folder))
    if rc != 0:
        return []
    return data.get("result", {}).get("terminals", [])


def orca_terminal_create(folder: Path, command: str, title: str):
    rc, data = orca_json("terminal", "create", "--worktree", worktree_selector(folder),
                         "--title", title, "--command", command)
    if rc != 0:
        fail(f"orca terminal create 실패({title}) — {data}\n"
             f"'{folder}'가 orca에 worktree로 등록돼 있는지 확인하세요 (orca repo add)")
    term = data.get("result", {}).get("terminal", {})
    return term.get("handle")


def orca_terminal_read(handle: str, limit: int = 200) -> dict:
    rc, data = orca_json("terminal", "read", "--terminal", handle, "--limit", str(limit))
    if rc != 0:
        return {}
    return data.get("result", {}).get("terminal", data.get("result", {}))


def orca_terminal_close(handle: str) -> None:
    orca_json("terminal", "close", "--terminal", handle)


def _ps_quote(arg: str) -> str:
    return "'" + str(arg).replace("'", "''") + "'"


CODEX_TUI_SIGNATURE = ("OpenAI Codex", "Ask Codex")


def _tail_text(term: dict) -> str:
    return "\n".join(term.get("tail") or [])


def _looks_like_codex(term: dict) -> bool:
    if term.get("status") != "running" or not term.get("connected") or term.get("orphaned"):
        return False
    tail = _tail_text(term)
    if not any(sig in tail for sig in CODEX_TUI_SIGNATURE):
        return False
    lines = [l for l in tail.splitlines() if l.strip()]
    if lines and lines[-1].lstrip().startswith("PS ") and lines[-1].rstrip().endswith(">"):
        return False  # 셸 프롬프트로 끝남 = codex가 이미 죽음(§5.4 신호 3)
    return True


# ---------------------------------------------------------------- 감시자 (launchd KeepAlive 대체, bot_win.py:178-215 동형)

def watchdog_pidfile_for(env: dict) -> Path:
    return data_dir_for(env) / "watchdog.pid"


def spawn_watchdog(env_file: str, env: dict) -> None:
    """감시자 중복 스폰 방지 — 이미 살아있으면 건너뛴다(restart 반복 호출 시
    감시자가 계속 쌓이는 것을 막는다). 감시자 자신의 pid는 daemon.pid와 별도로
    watchdog.pid에 기록해 stop/restart가 정확히 이 프로세스를 죽일 수 있게 한다."""
    wf = watchdog_pidfile_for(env)
    existing = read_pidfile(wf)
    if existing and pid_alive(existing):
        return
    args = [sys.executable, str(Path(__file__).resolve()), "_watchdog", env_file]
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, close_fds=True, **kwargs)
    wf.parent.mkdir(parents=True, exist_ok=True)
    wf.write_text(str(p.pid), encoding="utf-8")


def spawn_daemon(env_file: str, env: dict) -> int:
    node = node_bin()
    log_path = daemon_log_for(env_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logf = open(log_path, "a", encoding="utf-8", errors="replace")
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    proc_env = dict(os.environ)
    for extra in (env.get("CODEX_BIN"),):
        if extra:
            proc_env["PATH"] = f"{Path(extra).parent};{proc_env.get('PATH', '')}"
    p = subprocess.Popen([node, f"--env-file={env_path(env_file)}", "src/index.mjs"],
                         cwd=PROJECT_DIR, stdin=subprocess.DEVNULL, stdout=logf, stderr=logf,
                         env=proc_env, close_fds=True, **kwargs)
    logf.close()
    return p.pid


def cmd_watchdog(argv: list) -> None:
    """`_watchdog` 서브커맨드 — spawn_watchdog이 띄우는 실제 감시자 본체.
    사용자가 직접 부르지 않는다. index.mjs가 자기 pidfile(data/daemon.pid)을 쓰므로
    그걸 그대로 신뢰의 원천으로 쓴다 — 이 감시자는 별도 pid 상태를 두지 않는다."""
    env_file = argv[0] if argv else ".env"
    while True:
        time.sleep(WATCHDOG_INTERVAL_SEC)
        env = parse_env_file(env_path(env_file))
        pidfile = data_dir_for(env) / "daemon.pid"
        pid = read_pidfile(pidfile)
        if pid and pid_alive(pid):
            continue
        log(f"데몬({env_file}) 죽음 감지 — 재기동")
        try:
            spawn_daemon(env_file, env)
        except Exception as err:  # noqa: BLE001 — 감시자는 죽으면 안 된다
            log(f"재기동 실패: {err}")


# ---------------------------------------------------------------- up / restart / stop

def cmd_up(argv: list) -> None:
    env_file = argv[0] if argv else ".env"
    env = preflight(env_file)
    pidfile = data_dir_for(env) / "daemon.pid"
    pid = read_pidfile(pidfile)
    if pid and pid_alive(pid):
        log(f"이미 실행 중 (PID {pid})")
        spawn_watchdog(env_file, env)  # 감시자만 죽어있는 경우 대비
        return
    new_pid = spawn_daemon(env_file, env)
    spawn_watchdog(env_file, env)
    log(f"데몬 기동 (PID {new_pid}) — 로그: {daemon_log_for(env_file)}")


def _kill_daemon_and_watchdog(env: dict) -> None:
    """Windows Node는 SIGTERM 핸들러를 실행하지 않고 즉시 종료한다(실측 지식) —
    index.mjs의 정리(pidfile 삭제 등)가 못 돈다. 강제 종료 후 우리가 직접 치운다.
    감시자를 먼저 죽이지 않으면 데몬이 죽은 지 15초 안에 감시자가 되살린다."""
    wf = watchdog_pidfile_for(env)
    wpid = read_pidfile(wf)
    if wpid and pid_alive(wpid):
        subprocess.run(["taskkill", "/PID", str(wpid), "/T", "/F"], capture_output=True)
        try:
            wf.unlink()
        except OSError:
            pass
        log(f"감시자(PID {wpid}) 종료")

    pidfile = data_dir_for(env) / "daemon.pid"
    pid = read_pidfile(pidfile)
    if pid and pid_alive(pid):
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
        try:
            pidfile.unlink()
        except OSError:
            pass
        log(f"데몬(PID {pid}) 종료")


def cmd_restart(argv: list) -> None:
    env_file = argv[0] if argv else ".env"
    env = preflight(env_file)
    _kill_daemon_and_watchdog(env)
    cmd_up([env_file])


def cmd_stop(argv: list) -> None:
    env_file = argv[0] if argv else ".env"
    env = preflight(env_file)
    _kill_daemon_and_watchdog(env)
    if not tui_on(env):
        return
    title = env.get("TUI_PANE", "codex-live:0.0").split(":")[0]
    terms = orca_terminal_list(PROJECT_DIR)
    existing = next((t for t in terms if t.get("title") == title), None)
    if existing:
        orca_terminal_close(existing["handle"])
        log(f"TUI 터미널 종료: {title}")
    else:
        log(f"TUI 터미널 없음: {title}")


# ---------------------------------------------------------------- tui-up (tui-up.sh 병행본)

def cmd_tui_up(argv: list) -> None:
    env_file = argv[0] if argv else ".env"
    env = preflight(env_file)
    if not tui_on(env):
        log("TUI_PANE/TUI_CHANNEL_ID 미설정 — TUI 기동 건너뜀")
        return
    pane = env.get("TUI_PANE", "codex-live:0.0")
    title = pane.split(":")[0]
    workdir = env["CODEX_WORKDIR"]
    ensure_runtime()

    terms = orca_terminal_list(PROJECT_DIR)
    existing = next((t for t in terms if t.get("title") == title and t.get("connected")
                     and not t.get("orphaned")), None)
    if existing:
        term = orca_terminal_read(existing["handle"])
        if _looks_like_codex(term):
            log(f"codex 이미 실행 중 ({title}) — 종료")
            return
        log(f"터미널은 있으나 codex 아님({title}) — 재생성")
        orca_terminal_close(existing["handle"])

    codex_cmd = f"{_ps_quote(codex_bin(env))} -s workspace-write -c sandbox_workspace_write.network_access=true"
    command = (f"Set-Location -LiteralPath {_ps_quote(workdir)}; "
               f"& {codex_cmd}")
    handle = orca_terminal_create(PROJECT_DIR, command, title=title)
    log(f"codex TUI 직접 기동: 터미널 {handle}")

    # 준비 대기 — 최대 180초(부팅 직후 지연 감안, tui-up.sh와 동일 상한)
    ready = False
    for _ in range(180):
        time.sleep(1)
        term = orca_terminal_read(handle)
        tail = _tail_text(term)
        if any(sig in tail for sig in CODEX_TUI_SIGNATURE) or "›" in tail:
            ready = True
            break
    if not ready:
        fail("180초 내 TUI 미기동 — 터미널 화면 확인 필요")
    log("TUI 준비 확인")

    # 더미 턴 — bracketed paste 수동 래핑(design §5.1). 본문과 Enter를 분리 전송해야
    # 제출된다(실측: 함께 보내면 미제출).
    time.sleep(2)
    body = "Boot check. Reply with one short line."
    payload = f"\x1b[200~{body}\x1b[201~"
    orca_json("terminal", "send", "--terminal", handle, "--text", payload)
    sleep_ms = 200 + min(800, len(body) // 50)
    time.sleep(sleep_ms / 1000)
    orca_json("terminal", "send", "--terminal", handle, "--enter")
    log("더미 턴 전송")

    # 롤아웃 파일 대기 — 문자열 grep 금지, json.loads 후 payload.cwd 비교(함정 2 회피)
    # CODEX_HOME이 설정돼 있으면 그쪽 우선(Orca가 codex 프로세스를 자체 관리 홈으로
    # 리다이렉트하는 사례 실측 — 2026-09-01, 하드코딩 시 롤아웃을 영원히 못 찾음)
    codex_home = os.environ.get("CODEX_HOME")
    sessions_root = Path(codex_home) / "sessions" if codex_home else Path.home() / ".codex" / "sessions"
    stamp = time.time()
    found = None
    for i in range(180):
        time.sleep(1)
        for f in sessions_root.glob("**/rollout-*.jsonl") if sessions_root.is_dir() else []:
            try:
                if f.stat().st_mtime < stamp:
                    continue
                with f.open("r", encoding="utf-8", errors="ignore") as fh:
                    first_line = fh.readline()
                payload = json.loads(first_line).get("payload", {})
            except (OSError, ValueError):
                continue
            if payload.get("cwd") == workdir:
                found = f
                break
        if found:
            break
        if i % 10 == 9:
            term = orca_terminal_read(handle)
            tail_lines = [l for l in _tail_text(term).splitlines() if "›" in l]
            if tail_lines and body in tail_lines[-1]:
                orca_json("terminal", "send", "--terminal", handle, "--enter")
                log("더미 턴 미제출 감지 — Enter 재전송")
    if found:
        log(f"codex 세션 감지(롤아웃): {found}")
        log("준비 완료")
    else:
        log("경고: cwd 일치 롤아웃 파일 180초 내 미생성 — 첫 호명 시 Discord 경고가 뜨면 "
            "TUI에 메시지 한 번 보낼 것")


# ---------------------------------------------------------------- tui-restart (tui-restart.sh 병행본)
# codex 자신이 "세션 마감하고 재시작해"를 받아 호출한다(folder-bot codex 지침 블록,
# B2-5). tmux 서버 위탁 대신 detach된 자기 자신을 한 번 더 스폰해 즉시 반환한다 —
# 지금 이 터미널을 닫는 명령이 자기 자신을 죽이기 전에 반환해야 하기 때문이다.

def _webhook_url() -> str | None:
    env_val = os.environ.get("BOT_RESTART_WEBHOOK")
    if env_val:
        return env_val
    for cfg in (home_config("folder-bot", "config.json"), home_config("usage-coach", "discord.json")):
        try:
            data = json.loads(cfg.read_text(encoding="utf-8"))
            url = data.get("webhook_url")
            if url:
                return url
        except (OSError, ValueError):
            continue
    return None


def home_config(app: str, filename: str) -> Path:
    return Path(os.environ.get("HOME") or os.environ["USERPROFILE"]) / ".config" / app / filename


def _notify(title: str, message: str) -> None:
    url = _webhook_url()
    if not url:
        return
    try:
        import urllib.request
        body = json.dumps({"content": f"♻️ {title} — {message}"}).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15).close()
    except Exception:  # noqa: BLE001 — 통지 실패는 재시작 판정에 영향 주면 안 된다
        pass


def cmd_tui_restart(argv: list) -> None:
    env_file = argv[0] if argv else ".env"
    if os.environ.get("TUI_RESTART_DETACHED") != "1":
        args = [sys.executable, str(Path(__file__).resolve()), "tui-restart", env_file]
        child_env = dict(os.environ, TUI_RESTART_DETACHED="1")
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        log_path = PROJECT_DIR / "logs" / "tui-restart.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        logf = open(log_path, "a", encoding="utf-8", errors="replace")
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=logf, stderr=logf,
                         env=child_env, close_fds=True, **kwargs)
        print(f"재시작 예약됨: {env_file} (몇 초 뒤 TUI 교체, 로그: {log_path})")
        return

    env = preflight(env_file)
    pane = env.get("TUI_PANE", "codex-live:0.0")
    title = pane.split(":")[0]
    log(f"=== {title} 재시작 시작 ({env_file}) ===")
    time.sleep(8)  # codex의 마지막 디스코드 답장(롤아웃 relay)이 나갈 시간
    terms = orca_terminal_list(PROJECT_DIR)
    existing = next((t for t in terms if t.get("title") == title), None)
    if existing:
        orca_terminal_close(existing["handle"])
    try:
        cmd_tui_up([env_file])
        log("판정: 준비 완료")
        _notify(title, "준비 완료 — 이어서하자로 재정박")
    except SystemExit:
        log("판정: tui-up 실패")
        _notify(title, "실패 — 터미널 확인 필요")
        raise
    log(f"=== {title} 재시작 종료 ===")


# ---------------------------------------------------------------- schtasks (plist 대체, ADR-0002)

def pythonw_bin() -> str:
    exe = Path(sys.executable)
    pw = exe.with_name("pythonw.exe")
    return str(pw) if pw.exists() else str(exe)


def cmd_autostart_install(argv: list) -> None:
    env_file = argv[0] if argv else ".env"
    tn = task_name_for(env_file)
    script = Path(__file__).resolve()
    tr = subprocess.list2cmdline([pythonw_bin(), str(script), "autostart-boot", env_file])
    r = subprocess.run(["schtasks", "/create", "/sc", "onlogon", "/tn", tn,
                        "/tr", tr, "/f"], capture_output=True, text=True,
                       encoding="mbcs", errors="replace")
    if r.returncode != 0:
        fail(f"schtasks 등록 실패 — {(r.stderr or r.stdout).strip()}\n"
             "참고: onlogon 트리거 등록에 관리자 권한이 필요할 수 있음(ADR-0002 2026-08-29 정정)")
    log(f"자동 기동 등록 완료: {tn} (다음 로그온부터 적용)")


def cmd_autostart_remove(argv: list) -> None:
    env_file = argv[0] if argv else ".env"
    tn = task_name_for(env_file)
    check = subprocess.run(["schtasks", "/query", "/tn", tn], capture_output=True)
    if check.returncode != 0:
        log(f"자동 기동 미등록 — 건너뜀: {tn}")
        return
    r = subprocess.run(["schtasks", "/delete", "/tn", tn, "/f"], capture_output=True)
    if r.returncode != 0:
        fail(f"schtasks 제거 실패(exit {r.returncode})")
    log(f"자동 기동 제거: {tn}")


def cmd_autostart_boot(argv: list) -> None:
    """schtasks onlogon이 부르는 무인 부트스트랩 — 사용자가 직접 부르지 않는다."""
    env_file = argv[0] if argv else ".env"
    env = preflight(env_file)
    if tui_on(env):
        ensure_runtime()
    cmd_up([env_file])
    if tui_on(env):
        cmd_tui_up([env_file])


# ---------------------------------------------------------------- install (install.sh 병행본)

def cmd_install(argv: list) -> None:
    env_file = argv[0] if argv else ".env"
    env = preflight(env_file)
    on = tui_on(env)
    log(f"node={node_bin()} / codex={codex_bin(env)} / TUI={'켬' if on else '끔'}")

    if not (PROJECT_DIR / "node_modules").is_dir():
        log("npm install")
        r = subprocess.run("npm install --omit=dev", cwd=PROJECT_DIR, shell=True)
        if r.returncode != 0:
            fail("npm install 실패")

    (PROJECT_DIR / "logs").mkdir(parents=True, exist_ok=True)
    workdir = Path(env["CODEX_WORKDIR"])
    workdir.mkdir(parents=True, exist_ok=True)
    agents_md = workdir / "AGENTS.md"
    if not agents_md.exists():
        agents_md.write_text((PROJECT_DIR / "templates" / "AGENTS.md").read_text(encoding="utf-8"),
                              encoding="utf-8")
        log(f"워크스페이스 AGENTS.md 설치: {agents_md}")
    else:
        log("워크스페이스 AGENTS.md 이미 존재 — 유지")

    cmd_autostart_install([env_file])
    cmd_up([env_file])
    if on:
        cmd_tui_up([env_file])

    time.sleep(5)
    dlog = daemon_log_for(env_file)
    text = dlog.read_text(encoding="utf-8", errors="ignore") if dlog.exists() else ""
    line = next((l for l in reversed(text.splitlines()) if "로그인:" in l), None)
    if line:
        log(f"데몬 로그인 확인: {line}")
    else:
        log(f"데몬 로그인 로그 아직 없음 — {dlog}를 확인하세요 (토큰 오류면 여기 찍힘)")
    log(f"설치 끝. 수동 복구: python {Path(__file__).name} restart / tui-up")


# ---------------------------------------------------------------- CLI

def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    cmd, rest = sys.argv[1], sys.argv[2:]
    table = {
        "install": cmd_install,
        "up": cmd_up,
        "stop": cmd_stop,
        "restart": cmd_restart,
        "tui-up": cmd_tui_up,
        "tui-restart": cmd_tui_restart,
        "autostart-install": cmd_autostart_install,
        "autostart-remove": cmd_autostart_remove,
        "autostart-boot": cmd_autostart_boot,
        "_watchdog": cmd_watchdog,
    }
    fn = table.get(cmd)
    if not fn:
        print(f"bridge_win.py: 미구현 서브커맨드 '{cmd}'", file=sys.stderr)
        sys.exit(2)
    fn(rest)


if __name__ == "__main__":
    main()
