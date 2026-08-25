import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRolloutById, extractAgentMessages, RolloutTail } from '../src/rollout.mjs';

test('실물 픽스처에서 assistant 메시지를 뽑는다 (구포맷 event_msg 공존해도 중복 없음)', async () => {
  const jsonl = await readFile(new URL('./fixtures/rollout-sample.jsonl', import.meta.url), 'utf8');
  const msgs = extractAgentMessages(jsonl);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].includes('SPIKE_OK'));
});

test('JSON 아닌 줄·다른 타입·구포맷 event_msg는 무시', () => {
  const jsonl = [
    'garbage',
    '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"output_text","text":"질문"}]}}',
    '{"type":"event_msg","payload":{"type":"agent_message","message":"답변1"}}',
    '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"답변1"}]}}',
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
  const mk = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
  await writeFile(f, mk('이전 메시지 — 무시돼야 함'));
  const got = [];
  const tail = new RolloutTail(f, { intervalMs: 50 });
  await tail.start(async (t) => { got.push(t); });
  const line = mk('새 답변');
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
  const mk = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
  await writeFile(f, mk('옛 세션 긴 내용 패딩 패딩 패딩 패딩 패딩 패딩'));
  const got = [];
  const tail = new RolloutTail(f, { intervalMs: 50 });
  await tail.start(async (t) => { got.push(t); });
  await writeFile(f, mk('새 파일')); // 더 짧게 truncate
  await new Promise((r) => setTimeout(r, 200));
  tail.stop();
  assert.deepEqual(got, ['새 파일']);
});

test('findRolloutByCwd: session_meta.cwd 일치 최신 파일에서 sid를 얻는다 (v0.146.0 화면 무표시 대응)', async () => {
  const { findRolloutByCwd } = await import('../src/rollout.mjs');
  const root = await mkdtemp(join(tmpdir(), 'sess-root-'));
  const day = join(root, '2026', '08', '05');
  await mkdir(day, { recursive: true });
  const meta = (sid, cwd) => JSON.stringify({ type: 'session_meta', payload: { session_id: sid, cwd } }) + '\n';
  await writeFile(join(day, 'rollout-2026-08-05T10-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
    meta('aaaaaaaa-1111-2222-3333-444444444444', '/work/chat'));
  await writeFile(join(day, 'rollout-2026-08-05T12-00-00-bbbbbbbb-5555-6666-7777-888888888888.jsonl'),
    meta('bbbbbbbb-5555-6666-7777-888888888888', '/work/codex-discord-workspace'));
  const hit = await findRolloutByCwd('/work/codex-discord-workspace', root);
  assert.equal(hit.sid, 'bbbbbbbb-5555-6666-7777-888888888888');
  assert.ok(hit.file.endsWith('888888888888.jsonl'));
});

test('findRolloutByCwd: 같은 cwd가 여럿이면 최신(파일명 시각 역순) 우선', async () => {
  const { findRolloutByCwd } = await import('../src/rollout.mjs');
  const root = await mkdtemp(join(tmpdir(), 'sess-root-'));
  const day = join(root, '2026', '08', '05');
  await mkdir(day, { recursive: true });
  const meta = (sid) => JSON.stringify({ type: 'session_meta', payload: { session_id: sid, cwd: '/w' } }) + '\n';
  await writeFile(join(day, 'rollout-2026-08-05T09-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl'), meta('aaaaaaaa-1111-2222-3333-444444444444'));
  await writeFile(join(day, 'rollout-2026-08-05T13-00-00-cccccccc-9999-aaaa-bbbb-cccccccccccc.jsonl'), meta('cccccccc-9999-aaaa-bbbb-cccccccccccc'));
  const hit = await findRolloutByCwd('/w', root);
  assert.equal(hit.sid, 'cccccccc-9999-aaaa-bbbb-cccccccccccc');
});

test('findRolloutByCwd: 일치 없으면 null', async () => {
  const { findRolloutByCwd } = await import('../src/rollout.mjs');
  const root = await mkdtemp(join(tmpdir(), 'sess-root-'));
  await mkdir(join(root, '2026', '08', '05'), { recursive: true });
  assert.equal(await findRolloutByCwd('/nope', root), null);
});

test('findRolloutByCwd: session_meta 첫 줄이 4KB를 넘어도 파싱한다 (2026-08-05 실측 18KB — instructions 포함)', async () => {
  const { findRolloutByCwd } = await import('../src/rollout.mjs');
  const root = await mkdtemp(join(tmpdir(), 'sess-root-'));
  const day = join(root, '2026', '08', '05');
  await mkdir(day, { recursive: true });
  const line = JSON.stringify({ type: 'session_meta', payload: {
    session_id: 'dddddddd-1111-2222-3333-444444444444', cwd: '/big/work',
    instructions: 'x'.repeat(20000) } }) + '\n';
  await writeFile(join(day, 'rollout-2026-08-05T12-00-00-dddddddd-1111-2222-3333-444444444444.jsonl'), line);
  const hit = await findRolloutByCwd('/big/work', root);
  assert.equal(hit?.sid, 'dddddddd-1111-2222-3333-444444444444');
});
