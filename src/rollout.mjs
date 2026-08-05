import { stat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');

async function listSorted(dir) {
  return (await readdir(dir)).sort().reverse(); // 최근(큰 값) 우선
}

export async function findRolloutById(sessionId, root = SESSIONS_ROOT) {
  try {
    for (const y of await listSorted(root))
      for (const m of await listSorted(join(root, y)))
        for (const d of await listSorted(join(root, y, m)))
          for (const f of await readdir(join(root, y, m, d)))
            if (f.includes(sessionId)) return join(root, y, m, d, f);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return null;
}

async function readSessionMeta(file) {
  // session_meta 첫 줄은 instructions가 실려 수십 KB에 달한다(2026-08-05 실측
  // 18,450B — 4KB 고정 읽기는 잘린 JSON 파싱 실패로 전 파일을 건너뛰었다).
  // 개행이 나올 때까지 읽고(상한 4MB), 멀티바이트 경계 안전하게 마지막에 디코드.
  let fh;
  try {
    fh = await open(file, 'r');
    const bufs = [];
    let pos = 0;
    while (pos < 4 * 1024 * 1024) {
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const view = buf.subarray(0, bytesRead);
      const nl = view.indexOf(0x0a);
      if (nl !== -1) {
        bufs.push(view.subarray(0, nl));
        break;
      }
      bufs.push(view);
      pos += bytesRead;
    }
    return JSON.parse(Buffer.concat(bufs).toString('utf8')).payload ?? null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

// codex v0.146.0 기본 설정은 세션 UUID를 화면에 표시하지 않는다(2026-08-05 E2E
// 실측 — 표시 여부는 버전·로컬 설정에 따라 흔들린다). 화면 스크레이핑 대신
// 롤아웃 첫 줄 session_meta(cwd·session_id)로 세션을 특정하는 안정 검출원.
// 최신 파일 우선 — 같은 cwd의 옛 세션이 남아 있어도 현재 세션이 이긴다
// (tui-up.sh가 기동 직후 더미 턴으로 현재 세션의 롤아웃 존재를 보장한다).
export async function findRolloutByCwd(cwd, root = SESSIONS_ROOT) {
  try {
    for (const y of await listSorted(root))
      for (const m of await listSorted(join(root, y)))
        for (const d of await listSorted(join(root, y, m)))
          for (const f of (await readdir(join(root, y, m, d))).sort().reverse()) {
            const file = join(root, y, m, d, f);
            const meta = await readSessionMeta(file);
            if (meta?.cwd === cwd) return { file, sid: meta.session_id ?? meta.id ?? null };
          }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return null;
}

export function extractAgentMessages(jsonlChunk) {
  const out = [];
  for (const line of jsonlChunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let d;
    try { d = JSON.parse(trimmed); } catch { continue; }
    const p = d.payload ?? {};
    if (p.type === 'agent_message' && p.message) out.push(p.message);
  }
  return out;
}

export class RolloutTail {
  constructor(filePath, { intervalMs = 700 } = {}) {
    this.filePath = filePath;
    this.intervalMs = intervalMs;
    this.offset = 0;
    this.remainder = '';
    this.timer = null;
    this.stopped = false;
  }

  async start(onAgentMessage) {
    this.offset = (await stat(this.filePath)).size; // 시작 시점 이후의 새 메시지만
    const poll = async () => {
      if (this.stopped) return;
      try {
        const size = (await stat(this.filePath)).size;
        if (size < this.offset) {
          // 파일이 로테이션/트렁케이트됨 — 처음부터 다시 따라간다
          this.offset = 0;
          this.remainder = '';
        }
        if (size > this.offset) {
          const fh = await open(this.filePath, 'r');
          let buf;
          try {
            buf = Buffer.alloc(size - this.offset);
            await fh.read(buf, 0, buf.length, this.offset);
          } finally {
            await fh.close();
          }
          this.offset = size;
          const text = this.remainder + buf.toString('utf8');
          const lastNl = text.lastIndexOf('\n');
          const complete = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
          this.remainder = lastNl === -1 ? text : text.slice(lastNl + 1);
          for (const msg of extractAgentMessages(complete)) await onAgentMessage(msg);
        }
      } catch {
        // 일시적 stat/read 실패는 다음 폴에서 재시도
      }
      if (!this.stopped) this.timer = setTimeout(poll, this.intervalMs);
    };
    await poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
