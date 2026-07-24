import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bufferSeq = 0;

// 붙여넣기 전 제어문자 제거 — bracketed paste 종료 마커(ESC[201~) 조기 종료 방지.
// \n(0x0a)과 \t(0x09)는 보존.
export function sanitizeForPaste(text) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// 스파이크 검증(2026-07-23): 텍스트와 Enter를 한 호출로 보내면 TUI가 제출하지 않고,
// send-keys로 보낸 줄바꿈은 Enter로 해석돼 중간 제출된다. 그래서
// (1) bracketed paste(-p)로 본문을 붙여넣고 (2) 잠시 후 Enter를 별도 전송한다.
export async function pasteToPane(pane, text) {
  const clean = sanitizeForPaste(text);
  const buf = `codex-bridge-${process.pid}-${++bufferSeq}`;
  await run('tmux', ['set-buffer', '-b', buf, '--', clean]);
  await run('tmux', ['paste-buffer', '-p', '-d', '-b', buf, '-t', pane]);
  await sleep(200 + Math.min(800, Math.floor(clean.length / 50)));
  await run('tmux', ['send-keys', '-t', pane, 'Enter']);
}

export async function paneCurrentCommand(pane) {
  const { stdout } = await run('tmux', ['display-message', '-p', '-t', pane, '#{pane_current_command}']);
  return stdout.trim();
}

export async function capturePane(pane) {
  const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', pane]);
  return stdout;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function extractSessionId(paneText) {
  const m = paneText.match(UUID_RE);
  return m ? m[m.length - 1] : null;
}
