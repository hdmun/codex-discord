import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractConversationId } from '../src/agy.mjs';

test('extractConversationId: Print mode 줄에서 UUID를 뽑는다', () => {
  const log = [
    'I0724 09:18:32.030726 43206 printmode.go:108] Print mode: starting (promptLength=22, model="", conversationID="")',
    'I0724 09:18:34.645302 43206 server.go:917] Created conversation a6e31af8-3cae-40be-a7d0-4d4788d994b6',
    'I0724 09:18:34.646921 43206 printmode.go:216] Print mode: conversation=a6e31af8-3cae-40be-a7d0-4d4788d994b6, sending message',
  ].join('\n');
  assert.equal(extractConversationId(log), 'a6e31af8-3cae-40be-a7d0-4d4788d994b6');
});

test('extractConversationId: 재개 세션 로그에서도 동일 패턴', () => {
  const log = 'I0724 ... printmode.go:216] Print mode: conversation=dfe0e753-b581-4940-a055-060210141ef6, sending message';
  assert.equal(extractConversationId(log), 'dfe0e753-b581-4940-a055-060210141ef6');
});

test('extractConversationId: ID 줄이 없으면 null', () => {
  assert.equal(extractConversationId('Print mode: starting (conversationID="")'), null);
  assert.equal(extractConversationId(''), null);
});

test('extractConversationId: 잘린 UUID는 무시한다', () => {
  // GetConversationDetail 줄은 UUID가 잘려 기록되는 경우가 있음 — Print mode 줄만 신뢰
  const log = 'ConversationDetail: found conversation dfe0e753-b581-4940-a055-060210141';
  assert.equal(extractConversationId(log), null);
});
