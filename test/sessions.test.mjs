import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SessionStore } from '../src/sessions.mjs';

async function freshPath() {
  const dir = await mkdtemp(join(tmpdir(), 'sess-'));
  return join(dir, 'nested', 'sessions.json');
}

test('파일이 없으면 빈 상태로 load된다', async () => {
  const store = new SessionStore(await freshPath());
  await store.load();
  assert.equal(store.get('ch1'), null);
});

test('set 후 get, 파일에도 persist된다', async () => {
  const path = await freshPath();
  const store = new SessionStore(path);
  await store.load();
  await store.set('ch1', 'sess-abc');
  assert.equal(store.get('ch1'), 'sess-abc');
  const onDisk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(onDisk.ch1, 'sess-abc');
});

test('재시작(새 인스턴스 load) 후에도 매핑 복구', async () => {
  const path = await freshPath();
  const a = new SessionStore(path);
  await a.load();
  await a.set('ch2', 'sess-xyz');
  const b = new SessionStore(path);
  await b.load();
  assert.equal(b.get('ch2'), 'sess-xyz');
});

test('손상된 파일은 .bad로 옮기고 빈 매핑으로 load된다', async () => {
  const path = await freshPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{corrupt');
  const store = new SessionStore(path);
  await store.load();
  assert.equal(store.get('ch1'), null);
  const badContent = await readFile(`${path}.bad`, 'utf8');
  assert.equal(badContent, '{corrupt');
});
