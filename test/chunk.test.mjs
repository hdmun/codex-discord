import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMessage } from '../src/chunk.mjs';

test('짧은 텍스트는 그대로 한 조각', () => {
  assert.deepEqual(chunkMessage('hello'), ['hello']);
});

test('빈 입력은 빈 배열', () => {
  assert.deepEqual(chunkMessage(''), []);
  assert.deepEqual(chunkMessage(null), []);
});

test('한도 초과 시 분할되고 각 조각이 한도 이하', () => {
  const text = 'a'.repeat(4500);
  const chunks = chunkMessage(text, 2000);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= 2000);
  assert.equal(chunks.join(''), text);
});

test('줄바꿈 경계를 우선해서 자른다', () => {
  const line = 'x'.repeat(1500);
  const text = `${line}\n${line}`;
  const chunks = chunkMessage(text, 2000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], line);
  assert.equal(chunks[1].replace(/^\n/, ''), line);
});
