#!/bin/bash
# codex TUI 기동 스크립트 — 부팅(LaunchAgent) 및 수동 복구(npm run tui:up) 공용.
# 전용 tmux 세션에 codex TUI를 띄우고, 롤아웃 파일 생성을 위한 더미 턴 1회를 보낸다.
# 규칙 각인은 워크스페이스 AGENTS.md가 담당하므로 여기서는 아무 한마디면 된다.
# 설정은 전부 프로젝트 루트 .env에서 읽는다 (CODEX_BIN, CODEX_WORKDIR, TUI_PANE).
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "오류: $PROJECT_DIR/.env 없음 — .env.example을 복사해 채우세요" >&2
  exit 1
fi
set -a; source "$PROJECT_DIR/.env"; set +a

# tmux 탐지: PATH → Apple Silicon → Intel 순 (변수명 TMUX는 tmux의 소켓 경로 예약 변수라 금지)
TMUX_BIN=$(command -v tmux || true)
[[ -z "$TMUX_BIN" && -x /opt/homebrew/bin/tmux ]] && TMUX_BIN=/opt/homebrew/bin/tmux
[[ -z "$TMUX_BIN" && -x /usr/local/bin/tmux ]] && TMUX_BIN=/usr/local/bin/tmux
if [[ -z "$TMUX_BIN" ]]; then
  echo "오류: tmux를 찾을 수 없음 — brew install tmux" >&2
  exit 1
fi

CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
if [[ -z "$CODEX_BIN" || ! -x "$CODEX_BIN" ]]; then
  echo "오류: codex를 찾을 수 없음 — .env에 CODEX_BIN을 지정하거나 PATH에 codex를 두세요" >&2
  exit 1
fi
: "${CODEX_WORKDIR:?오류: .env에 CODEX_WORKDIR 필요}"
PANE="${TUI_PANE:-codex-live:0.0}"
SESSION="${PANE%%:*}"
CODEX_CMD="$CODEX_BIN -s workspace-write -c sandbox_workspace_write.network_access=true"

log() { echo "[$(date '+%F %T')] $*"; }

# 이미 codex가 떠 있으면 아무것도 하지 않는다 (멱등)
if $TMUX_BIN has-session -t "$SESSION" 2>/dev/null; then
  cmd=$($TMUX_BIN display-message -p -t "$PANE" '#{pane_current_command}' 2>/dev/null || true)
  if [[ "$cmd" == *codex* ]]; then
    log "codex 이미 실행 중 ($SESSION) — 종료"
    exit 0
  fi
  log "세션은 있으나 codex 아님($cmd) — 세션 재생성"
  $TMUX_BIN kill-session -t "$SESSION"
fi

$TMUX_BIN new-session -d -s "$SESSION" -c "$CODEX_WORKDIR" -x 200 -y 50
# 스파이크 검증(2026-07-23): 텍스트와 Enter는 분리 전송
$TMUX_BIN send-keys -t "$PANE" "$CODEX_CMD"
$TMUX_BIN send-keys -t "$PANE" Enter
log "codex TUI 실행 커맨드 전송"

# TUI 상태바에 세션 UUID가 뜰 때까지 대기 (최대 60초)
SID=""
for _ in $(seq 1 60); do
  sleep 1
  SID=$($TMUX_BIN capture-pane -p -t "$PANE" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1 || true)
  [[ -n "$SID" ]] && break
done
if [[ -z "$SID" ]]; then
  log "실패: 60초 내 codex 세션 ID 미검출 — pane 화면 확인 필요"
  exit 1
fi
log "codex 세션 감지: $SID"

# 더미 턴 1회 — 롤아웃 파일은 첫 턴 이후에 생성된다
sleep 2
$TMUX_BIN send-keys -t "$PANE" "Boot check. Reply with one short line."
sleep 1  # 텍스트 처리 전 Enter가 도착하면 제출되지 않음 (pasteToPane와 동일한 이유)
$TMUX_BIN send-keys -t "$PANE" Enter
log "더미 턴 전송"

# 롤아웃 파일 생성 확인 (최대 90초)
for _ in $(seq 1 90); do
  sleep 1
  FILE=$(find "$HOME/.codex/sessions" -name "*$SID*" -type f 2>/dev/null | head -1)
  if [[ -n "$FILE" ]]; then
    log "롤아웃 파일 확인: $FILE"
    log "준비 완료"
    exit 0
  fi
done
log "경고: 롤아웃 파일 90초 내 미생성 — 첫 호명 시 Discord 경고가 뜨면 TUI에 메시지 한 번 보낼 것"
exit 1
