import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeForPaste } from './pane.tmux.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORCA_BIN = () => process.env.ORCA_CLI_COMMAND || 'orca';

// title(=`.env`의 TUI_PANE 콜론 앞부분) → handle 메모. 생성마다 바뀌는 handle을
// 매 호출 재해석하지 않기 위한 캐시일 뿐 — 실패 시 1회 재해석 후 포기한다.
const handleCache = new Map();

// ok:false는 종료코드 0으로 돌아올 수 있으므로 여기서 예외로 승격한다 —
// 호출부는 exception 경로 하나만 보면 된다(§5.3 "ok:false를 내면 재해석").
async function orcaJson(args) {
  const { stdout } = await run(ORCA_BIN(), [...args, '--json'], { encoding: 'utf8' });
  const res = JSON.parse(stdout);
  if (res?.ok === false) {
    throw new Error(res.error ?? 'orca CLI: ok:false');
  }
  return res;
}

function paneName(pane) {
  return pane.split(':')[0];
}

// name → handle을 다시 조회해 캐시에 채운다. 최초 조회(resolveHandle의 캐시미스)와
// stale handle 재시도(withHandle의 catch) 둘 다 이 한 곳을 거친다.
async function refreshHandle(name) {
  const handle = await lookupHandle(name);
  handleCache.set(name, handle);
  return handle;
}

async function resolveHandle(pane) {
  if (pane.startsWith('term_')) return pane;
  const name = paneName(pane);
  if (handleCache.has(name)) return handleCache.get(name);
  return refreshHandle(name);
}

async function lookupHandle(name) {
  const list = await orcaJson(['terminal', 'list']);
  const terminals = list?.terminals ?? [];
  const candidates = terminals.filter((t) => t.connected && !t.orphaned && t.title === name);
  if (candidates.length === 0) {
    throw new Error(`orca 터미널 '${name}'을 찾지 못함 — bridge_win.py tui-up 먼저 실행`);
  }
  // lastOutputAt은 숫자(epoch ms) — 문자열 비교(localeCompare)를 쓰면 동일 제목
  // 후보가 2개 이상일 때 항상 TypeError로 터진다(2026-09-01 실측: 좀비 터미널
  // 누적으로 재현, 응답이 조용히 소실되는 것처럼 보였음)
  candidates.sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0));
  return candidates[0].handle;
}

// 캐시된 handle이 죽었으면 1회만 재해석한다. 그래도 실패하면 던진다.
async function withHandle(pane, fn) {
  const name = pane.startsWith('term_') ? null : paneName(pane);
  const handle = await resolveHandle(pane);
  try {
    return await fn(handle);
  } catch (err) {
    if (name && isTerminalNotFound(err)) {
      handleCache.delete(name);
      return fn(await refreshHandle(name));
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

// terminal show: list 항목과 같은 필드(§9). list/show 둘 다 connected/orphaned를
// 갖지만(§5.4), 여기서는 이미 해석된 handle로 단건 조회하려고 show를 쓴다.
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
