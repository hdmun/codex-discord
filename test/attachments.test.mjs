import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  extractAttachmentMarkers,
  resolveUploadPath,
  saveIncomingAttachments,
} from '../src/attachments.mjs';

// ---------- extractAttachmentMarkers ----------

test('마커 없는 텍스트는 그대로, paths는 빈 배열', () => {
  const { text, paths } = extractAttachmentMarkers('그냥 답변입니다.');
  assert.equal(text, '그냥 답변입니다.');
  assert.deepEqual(paths, []);
});

test('마커를 제거하고 경로를 수집한다', () => {
  const { text, paths } = extractAttachmentMarkers('여기 파일입니다.\n[[첨부: uploads/a.pdf]]');
  assert.equal(text, '여기 파일입니다.');
  assert.deepEqual(paths, ['uploads/a.pdf']);
});

test('여러 마커, 공백 없는 표기도 처리', () => {
  const { text, paths } = extractAttachmentMarkers('결과:\n[[첨부:a.csv]]\n중간 설명\n[[첨부: b/c.png]]');
  assert.equal(text, '결과:\n중간 설명');
  assert.deepEqual(paths, ['a.csv', 'b/c.png']);
});

// ---------- resolveUploadPath ----------

async function makeWorkdir() {
  const dir = await mkdtemp(join(tmpdir(), 'attach-test-'));
  await writeFile(join(dir, 'ok.txt'), 'hello');
  return dir;
}

test('워크스페이스 안 상대 경로는 절대 경로로 통과', async () => {
  const dir = await makeWorkdir();
  const abs = await resolveUploadPath('ok.txt', dir);
  assert.equal(await readFile(abs, 'utf8'), 'hello');
});

test('.. 탈출 경로는 거부', async () => {
  const dir = await makeWorkdir();
  await assert.rejects(() => resolveUploadPath('../escape.txt', dir), /워크스페이스/);
});

test('워크스페이스 밖 절대 경로는 거부', async () => {
  const dir = await makeWorkdir();
  await assert.rejects(() => resolveUploadPath('/etc/hosts', dir), /워크스페이스/);
});

test('심링크로 밖을 가리키면 거부', async () => {
  const dir = await makeWorkdir();
  await symlink('/etc/hosts', join(dir, 'sneaky'));
  await assert.rejects(() => resolveUploadPath('sneaky', dir), /워크스페이스/);
});

test('없는 파일은 거부', async () => {
  const dir = await makeWorkdir();
  await assert.rejects(() => resolveUploadPath('nope.txt', dir), /없|찾지 못/);
});

test('크기 상한 초과는 거부', async () => {
  const dir = await makeWorkdir();
  await assert.rejects(() => resolveUploadPath('ok.txt', dir, { maxBytes: 3 }), /초과/);
});

// ---------- saveIncomingAttachments ----------

function serveOnce(body) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => res.end(body));
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/f`, close: () => server.close() });
    });
  });
}

test('첨부를 uploads/에 저장하고 상대 경로를 돌려준다', async () => {
  const dir = await makeWorkdir();
  const { url, close } = await serveOnce('csv,data');
  try {
    const result = await saveIncomingAttachments([{ name: 'data.csv', url, size: 8 }], dir);
    assert.deepEqual(result.saved, ['uploads/data.csv']);
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(join(dir, 'uploads/data.csv'), 'utf8'), 'csv,data');
  } finally {
    close();
  }
});

test('파일명은 경로 구분자를 제거해 새니타이즈한다', async () => {
  const dir = await makeWorkdir();
  const { url, close } = await serveOnce('x');
  try {
    const result = await saveIncomingAttachments([{ name: '../../evil.sh', url, size: 1 }], dir);
    assert.deepEqual(result.saved, ['uploads/evil.sh']);
  } finally {
    close();
  }
});

test('이름 충돌 시 접미사를 붙인다', async () => {
  const dir = await makeWorkdir();
  await mkdir(join(dir, 'uploads'), { recursive: true });
  await writeFile(join(dir, 'uploads/a.txt'), 'old');
  const { url, close } = await serveOnce('new');
  try {
    const result = await saveIncomingAttachments([{ name: 'a.txt', url, size: 3 }], dir);
    assert.deepEqual(result.saved, ['uploads/a-1.txt']);
    assert.equal(await readFile(join(dir, 'uploads/a.txt'), 'utf8'), 'old');
  } finally {
    close();
  }
});

test('크기 상한 초과 첨부는 저장하지 않고 errors로 보고', async () => {
  const dir = await makeWorkdir();
  const result = await saveIncomingAttachments(
    [{ name: 'big.bin', url: 'http://unused.invalid/', size: 999 }],
    dir,
    { maxBytes: 10 },
  );
  assert.deepEqual(result.saved, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /big\.bin/);
});
