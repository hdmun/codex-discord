import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRolloutById, extractAgentMessages, RolloutTail } from '../src/rollout.mjs';

test('실물 픽스처에서 agent_message를 뽑는다', async () => {
  const jsonl = await readFile(new URL('./fixtures/rollout-sample.jsonl', import.meta.url), 'utf8');
  const msgs = extractAgentMessages(jsonl);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].includes('SPIKE_OK'));
});

test('JSON 아닌 줄·다른 타입은 무시', () => {
  const jsonl = [
    'garbage',
    '{"payload":{"type":"user_message","message":"질문"}}',
    '{"payload":{"type":"agent_message","message":"답변1"}}',
  ].join('\n');
  assert.deepEqual(extractAgentMessages(jsonl), ['답변1']);
});

test('findRolloutById: 날짜 트리에서 세션 파일을 찾는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sess-root-'));
  const day = join(root, '2026', '07', '23');
  await mkdir(day, { recursive: true });
  const f = join(day, 'rollout-2026-07-23T00-00-00-abc-123.jsonl');
  await writeFile(f, '');
  assert.equal(await findRolloutById('abc-123', root), f);
  assert.equal(await findRolloutById('없는-세션', root), null);
});

test('RolloutTail: 시작 이후 append된 agent_message만, 줄 경계 분할도 안전', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tail-'));
  const f = join(dir, 'r.jsonl');
  await writeFile(f, '{"payload":{"type":"agent_message","message":"이전 메시지 — 무시돼야 함"}}\n');
  const got = [];
  const tail = new RolloutTail(f, { intervalMs: 50 });
  await tail.start(async (t) => { got.push(t); });
  const line = '{"payload":{"type":"agent_message","message":"새 답변"}}\n';
  await appendFile(f, line.slice(0, 20));           // 줄 중간까지만
  await new Promise((r) => setTimeout(r, 120));
  await appendFile(f, line.slice(20));               // 나머지
  await new Promise((r) => setTimeout(r, 200));
  tail.stop();
  assert.deepEqual(got, ['새 답변']);
});

test('RolloutTail: 파일이 트렁케이트되면 처음부터 다시 따라간다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tail-rot-'));
  const f = join(dir, 'r.jsonl');
  await writeFile(f, '{"payload":{"type":"agent_message","message":"옛 세션 긴 내용 패딩 패딩 패딩"}}\n');
  const got = [];
  const tail = new RolloutTail(f, { intervalMs: 50 });
  await tail.start(async (t) => { got.push(t); });
  await writeFile(f, '{"payload":{"type":"agent_message","message":"새 파일"}}\n'); // 더 짧게 truncate
  await new Promise((r) => setTimeout(r, 200));
  tail.stop();
  assert.deepEqual(got, ['새 파일']);
});
