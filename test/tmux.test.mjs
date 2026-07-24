import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSessionId, sanitizeForPaste } from '../src/tmux.mjs';

test('상태바 텍스트에서 마지막 UUID를 뽑는다', () => {
  const paneText = [
    '│ >_ OpenAI Codex (v0.145.0)                     │',
    '› Implement {feature}',
    '  gpt-5.6-sol high · ~/ai-folder/codex-discord-workspace · Context 0% used · 019f8a59-2df3-7001-bc41-34e0a66edf1c',
  ].join('\n');
  assert.equal(extractSessionId(paneText), '019f8a59-2df3-7001-bc41-34e0a66edf1c');
});

test('UUID가 여럿이면 마지막 것 (상태바가 화면 하단)', () => {
  const t = 'aaaaaaaa-1111-2222-3333-444444444444 그리고 bbbbbbbb-5555-6666-7777-888888888888';
  assert.equal(extractSessionId(t), 'bbbbbbbb-5555-6666-7777-888888888888');
});

test('UUID가 없으면 null', () => {
  assert.equal(extractSessionId('codex TUI가 아직 안 떴다'), null);
});

test('sanitizeForPaste: 제어문자는 지우고 개행·탭은 보존', () => {
  assert.equal(sanitizeForPaste('a\x1b[201~b\nc\td\x7f'), 'a[201~b\nc\td');
});
