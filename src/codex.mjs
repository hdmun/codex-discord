import spawn from 'cross-spawn';

// `-s workspace-write`는 `resume` 서브커맨드 뒤에 두면 파싱 에러가 난다
// (`codex exec resume --help`에 `-s, --sandbox` 옵션 없음, `--json`/`-c`만 공통).
// 대신 `exec`와 `resume` 사이에 두면 정상 파싱된다: `codex exec -s workspace-write resume <id> ...`.
// 보안 원칙상 ~/.codex/config.toml의 기본값에 기대지 않고 매 호출마다 명시적으로 고정한다.
const SANDBOX_FLAGS = ['-s', 'workspace-write'];
// npm start는 PATH 앞에 nvm bin을 끼워 넣어 다른(구버전) codex가 잡힐 수 있다.
// 데몬이 어떤 셸에서 뜨든 같은 바이너리를 쓰도록 CODEX_BIN으로 고정한다.
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const COMMON_FLAGS = [
  '--json',
  '-c', 'sandbox_workspace_write.network_access=true',
  // CODEX_WORKDIR가 git 저장소가 아닐 수 있으므로 반드시 필요.
  '--skip-git-repo-check',
];

export function parseCodexEvents(jsonl) {
  let threadId = null;
  let reply = null;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
      reply = event.item.text;
    }
  }
  return { threadId, reply };
}

// graceful shutdown 시 SIGKILL 대상: spawn된 codex 자식 프로세스를 모두 추적
const activeChildren = new Set();

export function killActiveCodexChildren() {
  for (const child of activeChildren) {
    child.kill('SIGKILL');
  }
}

export function runCodexTurn({ sessionId, prompt, cwd, timeoutMs = 15 * 60 * 1000 }) {
  const args = sessionId
    ? ['exec', ...SANDBOX_FLAGS, 'resume', sessionId, ...COMMON_FLAGS, '--', prompt]
    : ['exec', ...SANDBOX_FLAGS, ...COMMON_FLAGS, '--', prompt];
  return new Promise((resolve, reject) => {
    // stdin must be closed, not left as an open pipe: `codex exec` reads stdin
    // (to append as a `<stdin>` block) even when a prompt is given as an argument,
    // per `codex exec --help`. An inherited-but-unclosed pipe (spawn's default)
    // makes codex block forever waiting for EOF. Confirmed via smoke test: without
    // this, runCodexTurn hung indefinitely (killed after ~9 minutes).
    const child = spawn(CODEX_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`codex가 ${timeoutMs / 1000}초 안에 끝나지 않아 중단`));
    }, timeoutMs);
    // 청크 경계에서 멀티바이트 문자가 깨지지 않도록 (agy에서 실증된 잠복 버그)
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); activeChildren.delete(child); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      const { threadId, reply } = parseCodexEvents(stdout);
      if (!reply) {
        return reject(new Error(`codex 응답 없음 (exit ${code}): ${stderr.slice(-500)}`));
      }
      resolve({ sessionId: threadId ?? sessionId, reply });
    });
  });
}
