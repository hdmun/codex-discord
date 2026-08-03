#!/usr/bin/env bash
# uninstall.sh 오프라인 테스트 — DRY_RUN 경로만 (launchctl/tmux 무접촉)
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/Library/LaunchAgents"
for L in com.codex-discord.daemon com.codex-discord.tui com.codex-discord.gemini; do
  echo plist > "$TMP/Library/LaunchAgents/$L.plist"
done
HOME="$TMP" DRY_RUN=1 bash "$DIR/scripts/uninstall.sh"
for L in com.codex-discord.daemon com.codex-discord.tui com.codex-discord.gemini; do
  [[ ! -f "$TMP/Library/LaunchAgents/$L.plist" ]] || { echo "FAIL: $L.plist 남음"; exit 1; }
done
# tui 는 bootout 금지 — 스크립트 소스에서 tui 라벨이 bootout 대상에 없는지 정적 확인
! grep -E 'bootout.*tui' "$DIR/scripts/uninstall.sh" || { echo "FAIL: tui 에 bootout 사용"; exit 1; }
echo "uninstall.test OK"
