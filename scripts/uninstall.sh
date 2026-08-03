#!/usr/bin/env bash
# codex-discord 브리지 제거 — install.sh 의 대응 제거 경로.
# 데몬·gemini 는 node 직속 job → 안전함. tui 는 tmux 세션을 띄우는 job이므로
# bootout 금지(프로세스 그룹째 킬 위험, 2026-07-31 실측), 세션 종료 + plist 삭제만.
set -euo pipefail
UID_N=$(id -u)

if [[ "${DRY_RUN:-0}" != "1" ]]; then
  launchctl bootout "gui/$UID_N/com.codex-discord.daemon" 2>/dev/null || true
  launchctl bootout "gui/$UID_N/com.codex-discord.gemini" 2>/dev/null || true
  tmux kill-session -t codex-live 2>/dev/null || true
fi
rm -f "$HOME/Library/LaunchAgents/com.codex-discord.daemon.plist" \
      "$HOME/Library/LaunchAgents/com.codex-discord.tui.plist" \
      "$HOME/Library/LaunchAgents/com.codex-discord.gemini.plist"
echo "제거됨: LaunchAgent 3종 (.env*·logs/·data*/ 는 보존)"
