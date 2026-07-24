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
