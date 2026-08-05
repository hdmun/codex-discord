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

test('좁은 pane에서 말줄임으로 잘린 UUID는 접두어로 뽑는다 (2026-08-03 실측)', () => {
  const t = '  gpt-5.6-sol high · ~/ai-folder/codex-discord-workspace · Context 0% used · 019fc493-1b7a-7480-bc45-203c…';
  assert.equal(extractSessionId(t), '019fc493-1b7a-7480-bc45-203c');
});

test('잘린 UUID: 마지막 그룹이 통째로 잘려도 앞 4그룹이면 매칭', () => {
  const t = 'Context 0% used · 019fc493-1b7a-7480-bc45…';
  assert.equal(extractSessionId(t), '019fc493-1b7a-7480-bc45');
});

test('4그룹 미만으로 잘리면 오매칭 위험 — null', () => {
  const t = 'Context 0% used · 019fc493-1b7a…';
  assert.equal(extractSessionId(t), null);
});

test('전체 UUID가 있으면 잘린 접두어보다 우선', () => {
  const t = '019fc493-1b7a-7480-bc45-203c… 그리고 aaaaaaaa-1111-2222-3333-444444444444';
  assert.equal(extractSessionId(t), 'aaaaaaaa-1111-2222-3333-444444444444');
});

test('sanitizeForPaste: 제어문자는 지우고 개행·탭은 보존', () => {
  assert.equal(sanitizeForPaste('a\x1b[201~b\nc\td\x7f'), 'a[201~b\nc\td');
});

test('treeHasCodex: npm 런처 — pane이 node여도 자손에 codex 바이너리가 있으면 참 (2026-08-05 E2E 실측)', async () => {
  const { treeHasCodex } = await import('../src/tmux.mjs');
  const ps = [
    ' 5325     1 node /Users/t/.local/bin/codex -s workspace-write',
    ' 5400  5325 /Users/t/.local/lib/node_modules/@openai/codex/vendor/codex-aarch64-apple-darwin exec',
    ' 9999     1 node /Users/t/some/other/app.js',
  ].join('\n');
  assert.equal(treeHasCodex(ps, '5325'), true);
});

test('treeHasCodex: 런처만 있고 네이티브 자식이 없어도 node <경로>/codex 형태면 참', async () => {
  const { treeHasCodex } = await import('../src/tmux.mjs');
  const ps = ' 5325     1 node /Users/t/.local/bin/codex -s workspace-write';
  assert.equal(treeHasCodex(ps, '5325'), true);
});

test('treeHasCodex: 트리에 codex가 없으면 거짓 (맨 zsh — 죽은 TUI)', async () => {
  const { treeHasCodex } = await import('../src/tmux.mjs');
  const ps = [
    '  964     1 zsh',
    ' 9999     1 node /Users/t/some/other/app.js',
  ].join('\n');
  assert.equal(treeHasCodex(ps, '964'), false);
});

test('treeHasCodex: 다른 트리의 codex는 무시 (pane 자손만 판정)', async () => {
  const { treeHasCodex } = await import('../src/tmux.mjs');
  const ps = [
    '  964     1 zsh',
    ' 7777     1 codex -s workspace-write',
  ].join('\n');
  assert.equal(treeHasCodex(ps, '964'), false);
});
