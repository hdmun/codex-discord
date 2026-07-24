# Claude 세션 쪽 3자 대화 규칙 (claude-discord 세션의 CLAUDE.md에 추가할 블록)

TUI 모드 E2E 시작 전에 claude-discord 세션의 CLAUDE.md에 아래 블록을 붙여넣는다.

```markdown
## Discord 3자 대화 규칙 (codex-and-claude 채널)
- 이 채널에서는 @멘션으로 호명될 때만 응답한다.
- 응답 전 반드시 fetch_messages로 최근 채널 히스토리를 확인해
  codex-bridge(봇)와 사용자의 발언 맥락을 파악한 뒤 답한다.
- codex-bridge를 멘션하거나 그 봇에게 직접 지시하지 않는다 (봇 간 루프 방지).
```

배경: Claude Code 채널스는 서버 채널에서 멘션된 메시지만 세션에 전달한다(2026-07-23 실측).
codex-bridge의 발언(봇 메시지)은 push로 안 오므로 fetch_messages로 당겨와야 3자 맥락이 잡힌다.
