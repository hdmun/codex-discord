import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeForPaste } from './pane.tmux.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORCA_BIN = () => process.env.ORCA_CLI_COMMAND || 'orca';

// title(=`.env`의 TUI_PANE 콜론 앞부분) → handle 메모. 생성마다 바뀌는 handle을
// 매 호출 재해석하지 않기 위한 캐시일 뿐 — 실패 시 1회 재해석 후 포기한다.
const handleCache = new Map();

async function orcaJson(args) {
  const { stdout } = await run(ORCA_BIN(), [...args, '--json'], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

function paneName(pane) {
  return pane.split(':')[0];
}

async function resolveHandle(pane) {
  if (pane.startsWith('term_')) return pane;
  const name = paneName(pane);
  if (handleCache.has(name)) return handleCache.get(name);
  const handle = await lookupHandle(name);
  handleCache.set(name, handle);
  return handle;
}

async function lookupHandle(name) {
  const list = await orcaJson(['terminal', 'list']);
  const terminals = list?.terminals ?? [];
  const candidates = terminals.filter((t) => t.connected && !t.orphaned && t.title === name);
  if (candidates.length === 0) {
    throw new Error(`orca 터미널 '${name}'을 찾지 못함 — bridge_win.py tui-up 먼저 실행`);
  }
  candidates.sort((a, b) => (b.lastOutputAt ?? '').localeCompare(a.lastOutputAt ?? ''));
  return candidates[0].handle;
}

// 캐시된 handle이 죽었으면 1회만 재해석한다. 그래도 실패하면 던진다.
async function withHandle(pane, fn) {
  const name = pane.startsWith('term_') ? null : paneName(pane);
  let handle = await resolveHandle(pane);
  try {
    return await fn(handle);
  } catch (err) {
    if (name && isTerminalNotFound(err)) {
      handleCache.delete(name);
      handle = await lookupHandle(name);
      handleCache.set(name, handle);
      return await fn(handle);
    }
    throw err;
  }
}

function isTerminalNotFound(err) {
  const msg = String(err?.message ?? '');
  return msg.includes('terminal_not_found') || msg.includes('selector_not_found');
}

function sleepMsFor(cleanLength) {
  return 200 + Math.min(800, Math.floor(cleanLength / 50));
}

export async function pasteToPane(pane, text) {
  const clean = sanitizeForPaste(text);
  const payload = `\x1b[200~${clean}\x1b[201~`;
  const expectedBytes = Buffer.byteLength(payload, 'utf8');
  await withHandle(pane, async (handle) => {
    const res = await orcaJson(['terminal', 'send', '--terminal', handle, '--text', payload]);
    const written = res?.result?.send?.bytesWritten;
    if (written !== expectedBytes) {
      throw new Error(`orca terminal send: bytesWritten 불일치(기대 ${expectedBytes}, 실제 ${written}) — 전송 잘림`);
    }
  });
  await sleep(sleepMsFor(clean.length));
  await withHandle(pane, (handle) => orcaJson(['terminal', 'send', '--terminal', handle, '--enter']));
}

// terminal read: {handle, status, tail[], truncated, limited, oldestCursor, nextCursor, latestCursor, returnedLineCount} (§9 실측)
async function readTail(pane) {
  return withHandle(pane, (handle) => orcaJson(['terminal', 'read', '--terminal', handle, '--limit', '200']));
}

// terminal show: list 항목과 같은 필드(§9) — connected/orphaned는 여기서만 나온다.
async function showTerminal(handle) {
  return orcaJson(['terminal', 'show', '--terminal', handle]);
}

export async function capturePane(pane) {
  const res = await readTail(pane);
  return (res?.tail ?? []).join('\n');
}

// 화면 서명 실측(§9): codex TUI 배너/입력 프롬프트/상태바 조각.
const CODEX_SIGNATURE_RE = /OpenAI Codex|› Ask Codex|esc to interrupt|Context \d+% (?:left|used)/;
// pwsh 프롬프트: `PS <경로>>` 형태로 tail이 끝난다.
const SHELL_PROMPT_TAIL_RE = /PS [^\r\n]*>\s*$/;

// 순수 판정부 — macOS판 treeHasCodex와 동형(§8 T-4).
export function tailHasCodexSignature(tailText) {
  if (!tailText) return false;
  if (SHELL_PROMPT_TAIL_RE.test(tailText.trimEnd())) return false;
  return CODEX_SIGNATURE_RE.test(tailText);
}

export async function paneCurrentCommand(pane) {
  let res;
  try {
    res = await readTail(pane);
  } catch {
    return 'unknown';
  }
  if (res?.status !== 'running') return 'exited';
  const tail = (res?.tail ?? []).join('\n');
  if (tailHasCodexSignature(tail)) return 'codex';
  if (SHELL_PROMPT_TAIL_RE.test(tail.trimEnd())) return 'pwsh';
  return 'unknown';
}

// fail-closed: 판정에 필요한 정보를 못 얻으면(오류·빈 tail·JSON 파싱 실패) 거짓.
export async function paneHasCodex(pane) {
  let handle;
  let readRes;
  let showRes;
  try {
    handle = await resolveHandle(pane);
    [readRes, showRes] = await Promise.all([readTail(pane), showTerminal(handle)]);
  } catch {
    return false;
  }
  const alive = readRes?.status === 'running' && showRes?.connected === true && showRes?.orphaned === false;
  if (!alive) return false;
  const tail = (readRes?.tail ?? []).join('\n');
  return tailHasCodexSignature(tail);
}
