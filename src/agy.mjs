import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Antigravity CLI(agy) 엔진 — codex.mjs와 동일한 인터페이스.
// 스모크 검증(2026-07-24):
// - 응답은 stdout 그대로 (JSONL 파싱 불필요)
// - 대화 ID는 --log-file에 "Print mode: conversation=<uuid>"로 기록됨 (신규/재개 공통)
// - 도구는 프로세스 cwd가 아니라 agy 프로젝트 워크스페이스에서 실행됨 →
//   첫 턴에 --new-project로 cwd를 워크스페이스로 잡고, 이후엔 대화가 프로젝트를 기억함
// - headless는 도구 승인 프롬프트를 띄울 수 없어 자동 거부됨 →
//   --sandbox(터미널 제한) 안에서 --dangerously-skip-permissions로 자동 승인 (codex -s workspace-write와 같은 철학)
const AGY_BIN = process.env.AGY_BIN ?? 'agy';
const COMMON_FLAGS = ['--sandbox', '--dangerously-skip-permissions'];

// agy는 내부에서 sysctl(/usr/sbin)을 호출한다 — 데몬 PATH에 없으면 기동 실패
function agyEnv() {
  const path = process.env.PATH ?? '';
  return { ...process.env, PATH: path.includes('/usr/sbin') ? path : `${path}:/usr/sbin:/sbin` };
}

const CONVERSATION_RE = /Print mode: conversation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export function extractConversationId(logText) {
  const m = logText.match(CONVERSATION_RE);
  return m ? m[1] : null;
}

// graceful shutdown 시 SIGKILL 대상
const activeChildren = new Set();

export function killActiveAgyChildren() {
  for (const child of activeChildren) {
    child.kill('SIGKILL');
  }
}

let logSeq = 0;

export function runAgyTurn({ sessionId, prompt, cwd, timeoutMs = 15 * 60 * 1000 }) {
  const logPath = join(tmpdir(), `agy-bridge-${process.pid}-${++logSeq}.log`);
  const args = sessionId
    ? ['--conversation', sessionId, ...COMMON_FLAGS, '--log-file', logPath, '-p', prompt]
    : ['--new-project', ...COMMON_FLAGS, '--log-file', logPath, '-p', prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(AGY_BIN, args, { cwd, env: agyEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agy가 ${timeoutMs / 1000}초 안에 끝나지 않아 중단`));
    }, timeoutMs);
    // setEncoding 없이 Buffer를 문자열로 이어붙이면 청크 경계에서 잘린
    // 멀티바이트 문자(한글 등)가 �로 깨진다 — 실사용에서 확인(2026-07-24)
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); activeChildren.delete(child); reject(err); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      let conversationId = null;
      try {
        conversationId = extractConversationId(await readFile(logPath, 'utf8'));
      } catch { /* 로그 없으면 기존 sessionId 유지 */ }
      unlink(logPath).catch(() => {});
      const reply = stdout.trim();
      if (!reply) {
        return reject(new Error(`agy 응답 없음 (exit ${code}): ${stderr.slice(-500)}`));
      }
      resolve({ sessionId: conversationId ?? sessionId, reply });
    });
  });
}
