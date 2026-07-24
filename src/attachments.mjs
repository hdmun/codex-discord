import { realpath, stat, mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve, sep, basename, extname } from 'node:path';

// codex 답변 속 첨부 마커: [[첨부: 경로]] — 경로는 워크스페이스 기준 상대 경로
const MARKER_RE = /\[\[첨부:\s*([^\]]+?)\s*\]\]/g;

const ATTACH_MAX_BYTES = 10 * 1024 * 1024;   // 봇 → Discord 업로드 상한
const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024; // Discord → 디스크 다운로드 상한

// 답변 텍스트에서 첨부 마커를 걷어내고 경로 목록을 돌려준다.
// 마커만 있던 줄은 통째로 제거해 빈 줄을 남기지 않는다.
export function extractAttachmentMarkers(text) {
  const paths = [];
  const lines = [];
  for (const line of String(text).split('\n')) {
    let had = false;
    const rest = line.replace(MARKER_RE, (_, p) => {
      had = true;
      paths.push(p.trim());
      return '';
    });
    if (had && rest.trim() === '') continue;
    lines.push(had ? rest.trimEnd() : line);
  }
  return { text: lines.join('\n'), paths };
}

// codex가 지목한 경로를 검증한다: 워크스페이스 안(심링크 탈출 포함 차단)·실존 파일·크기 상한.
// 통과 시 절대 경로 반환, 실패 시 한국어 사유로 throw.
export async function resolveUploadPath(path, workdir, { maxBytes = ATTACH_MAX_BYTES } = {}) {
  const root = await realpath(workdir);
  const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`워크스페이스 밖 경로는 첨부할 수 없음: ${path}`);
  }
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    throw new Error(`파일을 찾지 못함: ${path}`);
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`워크스페이스 밖 경로는 첨부할 수 없음: ${path}`);
  }
  const st = await stat(real);
  if (!st.isFile()) throw new Error(`파일이 아님: ${path}`);
  if (st.size > maxBytes) {
    throw new Error(`크기 상한(${Math.round(maxBytes / 1024 / 1024)}MB) 초과: ${path}`);
  }
  return real;
}

function sanitizeName(name) {
  const cleaned = basename(String(name)).replace(/[\u0000-\u001f]/g, "").trim();
  return cleaned || 'file';
}

async function uniqueName(dir, name) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; ; i++) {
    try {
      await access(join(dir, candidate));
      candidate = `${stem}-${i}${ext}`;
    } catch {
      return candidate;
    }
  }
}

// Discord 첨부([{name, url, size}])를 workdir/uploads/에 저장하고
// { saved: ['uploads/파일'], errors: ['이름: 사유'] }를 돌려준다.
export async function saveIncomingAttachments(attachments, workdir, { maxBytes = DOWNLOAD_MAX_BYTES, fetchImpl = fetch } = {}) {
  const saved = [];
  const errors = [];
  const dir = join(workdir, 'uploads');
  await mkdir(dir, { recursive: true });
  for (const att of attachments) {
    if (att.size > maxBytes) {
      errors.push(`${att.name}: 크기 상한(${Math.round(maxBytes / 1024 / 1024)}MB) 초과`);
      continue;
    }
    try {
      const res = await fetchImpl(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const file = await uniqueName(dir, sanitizeName(att.name));
      await writeFile(join(dir, file), buf);
      saved.push(`uploads/${file}`);
    } catch (err) {
      errors.push(`${att.name}: ${err.message}`);
    }
  }
  return { saved, errors };
}
