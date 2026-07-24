#!/bin/bash
# codex-discord 설치 스크립트 (macOS).
# .env를 읽어 경로를 자동 탐지하고 LaunchAgent 2개를 생성·등록한다.
# 멱등: 재실행하면 기존 등록을 내리고 다시 등록한다.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LABEL_DAEMON=com.codex-discord.daemon
LABEL_TUI=com.codex-discord.tui

fail() { echo "오류: $*" >&2; exit 1; }
log() { echo "==> $*"; }

# ---- 사전 점검 ----
[[ "$(uname)" == "Darwin" ]] || fail "macOS 전용입니다 (launchd 사용)"
[[ -f "$PROJECT_DIR/.env" ]] || fail "$PROJECT_DIR/.env 없음 — .env.example을 복사해 채운 뒤 다시 실행하세요"
set -a; source "$PROJECT_DIR/.env"; set +a
[[ -n "${DISCORD_TOKEN:-}" ]] || fail ".env에 DISCORD_TOKEN 필요"
[[ -n "${ALLOWED_USER_IDS:-}" ]] || fail ".env에 ALLOWED_USER_IDS 필요"
[[ -n "${CODEX_WORKDIR:-}" ]] || fail ".env에 CODEX_WORKDIR 필요"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
[[ -n "$CODEX_BIN" && -x "$CODEX_BIN" ]] || fail "codex를 찾을 수 없음 — .env에 CODEX_BIN을 지정하거나 PATH에 codex를 두세요"

NODE_BIN=$(command -v node) || fail "node를 찾을 수 없음 (Node 22+ 필요)"
NODE_MAJOR=$("$NODE_BIN" --version | sed 's/^v\([0-9]*\).*/\1/')
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node 22+ 필요 (현재: $("$NODE_BIN" --version))"

TMUX_BIN=$(command -v tmux || true)
[[ -z "$TMUX_BIN" && -x /opt/homebrew/bin/tmux ]] && TMUX_BIN=/opt/homebrew/bin/tmux
[[ -z "$TMUX_BIN" && -x /usr/local/bin/tmux ]] && TMUX_BIN=/usr/local/bin/tmux
[[ -n "$TMUX_BIN" ]] || fail "tmux를 찾을 수 없음 — brew install tmux"

log "node=$NODE_BIN / tmux=$TMUX_BIN / codex=$CODEX_BIN"

# ---- 의존성·폴더 준비 ----
if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
  log "npm install"
  (cd "$PROJECT_DIR" && npm install --omit=dev)
fi
mkdir -p "$PROJECT_DIR/logs" "$CODEX_WORKDIR"
if [[ ! -f "$CODEX_WORKDIR/AGENTS.md" ]]; then
  cp "$PROJECT_DIR/templates/AGENTS.md" "$CODEX_WORKDIR/AGENTS.md"
  log "워크스페이스 AGENTS.md 설치: $CODEX_WORKDIR/AGENTS.md"
else
  log "워크스페이스 AGENTS.md 이미 존재 — 유지"
fi

# ---- plist 생성 ----
# /usr/sbin은 agy(Antigravity CLI)가 내부에서 sysctl을 호출할 때 필요
PATH_LINE="$(dirname "$NODE_BIN"):$(dirname "$TMUX_BIN"):$(dirname "$CODEX_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$AGENTS_DIR"

cat > "$AGENTS_DIR/$LABEL_TUI.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL_TUI</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$PROJECT_DIR/scripts/tui-up.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/tui-up.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/tui-up.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$PATH_LINE</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
    </dict>
</dict>
</plist>
EOF

cat > "$AGENTS_DIR/$LABEL_DAEMON.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL_DAEMON</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>--env-file=.env</string>
        <string>src/index.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>15</integer>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/daemon.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$PATH_LINE</string>
    </dict>
</dict>
</plist>
EOF
log "plist 생성: $AGENTS_DIR/{$LABEL_TUI,$LABEL_DAEMON}.plist"

# ---- Gemini(agy) 인스턴스 (.env.gemini 있을 때만) ----
LABEL_GEMINI=com.codex-discord.gemini
if [[ -f "$PROJECT_DIR/.env.gemini" ]]; then
  AGY_PATH=$(command -v agy || true)
  [[ -z "$AGY_PATH" && -x "$HOME/.local/bin/agy" ]] && AGY_PATH="$HOME/.local/bin/agy"
  [[ -n "$AGY_PATH" ]] || fail ".env.gemini가 있으나 agy를 찾을 수 없음 — Antigravity CLI를 설치하세요"
  # gemini 인스턴스 워크스페이스에도 AGENTS.md 설치
  GEMINI_WORKDIR=$(set -a; source "$PROJECT_DIR/.env.gemini"; set +a; echo "$CODEX_WORKDIR")
  if [[ -n "$GEMINI_WORKDIR" ]]; then
    mkdir -p "$GEMINI_WORKDIR"
    [[ -f "$GEMINI_WORKDIR/AGENTS.md" ]] || cp "$PROJECT_DIR/templates/AGENTS.md" "$GEMINI_WORKDIR/AGENTS.md"
  fi
  cat > "$AGENTS_DIR/$LABEL_GEMINI.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL_GEMINI</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>--env-file=.env.gemini</string>
        <string>src/index.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>15</integer>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/daemon-gemini.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/daemon-gemini.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$AGY_PATH"):$PATH_LINE</string>
    </dict>
</dict>
</plist>
EOF
  log "plist 생성: $AGENTS_DIR/$LABEL_GEMINI.plist (Gemini 인스턴스)"
fi

# ---- 등록 (재실행 대비 bootout 후 bootstrap) ----
UID_N=$(id -u)
launchctl bootout "gui/$UID_N/$LABEL_TUI" 2>/dev/null || true
launchctl bootout "gui/$UID_N/$LABEL_DAEMON" 2>/dev/null || true
launchctl bootout "gui/$UID_N/$LABEL_GEMINI" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$AGENTS_DIR/$LABEL_TUI.plist"
launchctl bootstrap "gui/$UID_N" "$AGENTS_DIR/$LABEL_DAEMON.plist"
if [[ -f "$PROJECT_DIR/.env.gemini" && -f "$AGENTS_DIR/$LABEL_GEMINI.plist" ]]; then
  launchctl bootstrap "gui/$UID_N" "$AGENTS_DIR/$LABEL_GEMINI.plist"
fi
log "LaunchAgent 등록 완료 (로그인 시 자동 기동)"

# ---- 확인 ----
sleep 5
if grep -q "로그인:" "$PROJECT_DIR/logs/daemon.log" 2>/dev/null; then
  log "데몬 로그인 확인: $(grep '로그인:' "$PROJECT_DIR/logs/daemon.log" | tail -1)"
else
  log "데몬 로그인 로그 아직 없음 — logs/daemon.log를 확인하세요 (토큰 오류면 여기 찍힘)"
fi
log "설치 끝. TUI 구경: tmux attach -t \${TUI_PANE%%:*} / 수동 복구: npm run tui:up"
