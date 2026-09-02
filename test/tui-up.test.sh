#!/usr/bin/env bash
# tui-up.sh 롤아웃 대기 루프가 CODEX_HOME을 우선해야 한다 — 리다이렉트
# 환경(Orca 등)에서 $HOME/.codex 고정이면 롤아웃을 영원히 못 찾는다.
# Windows 쪽은 db80d88(rollout.mjs)/bridge_win.py에서 이미 수정됨 — 이건 동형 macOS 정정.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
! grep -qE '"\$HOME/\.codex/sessions"' "$DIR/scripts/tui-up.sh" || { echo "FAIL: \$HOME/.codex 하드코딩 잔존"; exit 1; }
grep -qE '\$\{CODEX_HOME:-\$HOME/\.codex\}/sessions' "$DIR/scripts/tui-up.sh" || { echo "FAIL: CODEX_HOME 우선 사용 안 함"; exit 1; }
echo "tui-up.test OK"
