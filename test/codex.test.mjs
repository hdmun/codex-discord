import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCodexEvents } from '../src/codex.mjs';

test('실물 픽스처에서 threadId와 최종 응답을 뽑는다', async () => {
  const jsonl = await readFile(new URL('./fixtures/exec-events.jsonl', import.meta.url), 'utf8');
  const { threadId, reply } = parseCodexEvents(jsonl);
  assert.ok(threadId, 'threadId가 있어야 한다');
  assert.ok(reply.includes('BRIDGE_SMOKE_OK'));
});

test('JSON 아닌 줄과 빈 줄은 무시한다', () => {
  const jsonl = [
    'garbage not json',
    '',
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
  ].join('\n');
  const { threadId, reply } = parseCodexEvents(jsonl);
  assert.equal(threadId, 't-1');
  assert.equal(reply, 'final');
});

test('응답 이벤트가 없으면 reply는 null', () => {
  const { threadId, reply } = parseCodexEvents('{"type":"thread.started","thread_id":"t-2"}');
  assert.equal(threadId, 't-2');
  assert.equal(reply, null);
});

test('item.completed의 error 타입 이벤트는 reply로 취급하지 않는다', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"t-3"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"some warning"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"actual reply"}}',
  ].join('\n');
  const { threadId, reply } = parseCodexEvents(jsonl);
  assert.equal(threadId, 't-3');
  assert.equal(reply, 'actual reply');
});
