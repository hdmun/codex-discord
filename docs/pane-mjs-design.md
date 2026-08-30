# `src/pane.mjs` 설계 — tmux/orca 플랫폼 분기 (B2-3)

- 작성: 2026-08-30
- 상태: 설계 확정, 구현 대기
- 정본 플랜: `discord-harness-installer/docs/superpowers/plans/2026-08-29-windows-2nd-slice.md` (B2-3)
- 범위: 설계만. 이 문서를 쓴 세션은 코드를 고치지 않았다.

## 1. 문제

`src/tmux.mjs`는 codex TUI를 tmux pane으로 조작한다. Windows에는 tmux가 없고,
대체재는 orca terminal이다(ADR-0001). 공개 인터페이스
(`pasteToPane` / `capturePane` / `paneCurrentCommand` / `paneHasCodex` /
`extractSessionId` / `UUID_RE`)는 그대로 두고 내부만 분기해야 한다.

**성공 기준은 "Windows가 된다"가 아니라 "macOS가 안 변한다"다.** 지금 mac 장비가
없어 회귀를 실측으로 검증할 수 없다. 따라서 macOS 무변경은 테스트가 아니라
**설계 구조로 보장**해야 하고, 그 보장은 mac 없이도 기계적으로 확인 가능해야 한다.

## 2. 결정 요약

| # | 결정 | 근거 |
|---|---|---|
| D1 | 파일 3분할: `pane.mjs`(디스패처) / `pane.tmux.mjs` / `pane.orca.mjs` | macOS가 실행하는 코드를 **바이트 단위로 불변**하게 만들 수 있는 유일한 구조 |
| D2 | `pane.tmux.mjs`는 `git mv src/tmux.mjs`의 결과물 — 내용 0줄 변경 | 무변경 근거를 `diff` 한 줄로 증명 |
| D3 | 백엔드 선택은 정적 import 후 바인딩 재수출 | 래퍼 함수 없음. macOS에서 함수 객체가 종전과 동일 |
| D4 | Windows pane 식별자 = orca terminal **title** | handle은 생성마다 바뀌어 `.env`에 못 박는다 |
| D5 | `TUI_PANE` 키를 **재해석**한다 (새 키 없음) | macOS `.env` 호환 유지 + `index.mjs` 게이트 무수정 (§6) |
| D6 | Windows 붙여넣기 = `ESC[200~` … `ESC[201~` 수동 래핑 + 별도 Enter | 실측으로 동작 확인, tmux `paste-buffer -p`와 동일 의미 (§5.1) |
| D7 | Windows `paneHasCodex`는 프로세스 트리가 아니라 **화면 서명 + 터미널 생존**으로 판정 | orca는 터미널→PID 매핑을 제공하지 않는다 (§5.4, 실측) |

## 3. 파일 구조

```
src/pane.mjs        (신설, ~25줄)  공개 표면. 플랫폼 선택 + 재수출.
src/pane.tmux.mjs   (git mv)      기존 tmux.mjs 그대로. macOS/Linux 백엔드.
src/pane.orca.mjs   (신설)        Windows 백엔드. orca CLI 호출.
```

`src/index.mjs:10`은 **import 지정자 한 곳만** 바뀐다. 구조분해 목록은 동일하다.

```js
// before
import { pasteToPane, capturePane, extractSessionId, paneCurrentCommand, paneHasCodex, UUID_RE } from './tmux.mjs';
// after
import { pasteToPane, capturePane, extractSessionId, paneCurrentCommand, paneHasCodex, UUID_RE } from './pane.mjs';
```

`src/tmux.mjs` 재수출 셔임은 두지 않는다. 한 대상에 이름이 둘 남으면 다음 세션이
어느 쪽을 고쳐야 하는지 헷갈린다. 대신 `index.mjs` 1줄 변경을 감수한다
(플랜 Phase 2 Files 항목이 `src/index.mjs(import 경로만)`으로 이 변경을 이미 허가한다).

### `pane.mjs` 골격

```js
import * as tmuxBackend from './pane.tmux.mjs';
import * as orcaBackend from './pane.orca.mjs';

// 순수 함수라 테스트에서 플랫폼과 무관하게 검증 가능해야 한다
export function selectBackendName(platform) {
  return platform === 'win32' ? 'orca' : 'tmux';
}

const backend = selectBackendName(process.platform) === 'orca' ? orcaBackend : tmuxBackend;

// I/O 4종 — 플랫폼 분기 대상
export const pasteToPane = backend.pasteToPane;
export const capturePane = backend.capturePane;
export const paneCurrentCommand = backend.paneCurrentCommand;
export const paneHasCodex = backend.paneHasCodex;

// 순수 함수 — 플랫폼과 무관. 항상 tmux 백엔드(=원본 파일)에서 가져온다.
export { UUID_RE, extractSessionId, sanitizeForPaste, treeHasCodex } from './pane.tmux.mjs';
```

래퍼(`(pane, text) => backend.pasteToPane(pane, text)`)를 쓰지 않는 이유: macOS에서
`pane.mjs`가 내보내는 함수가 **종전과 같은 함수 객체**여야 "동작이 같다"가 아니라
"같은 코드다"라고 말할 수 있다. `.length` / `.name` / 스택 트레이스도 보존된다.

**불변식: 두 백엔드 모두 top-level 부작용이 없어야 한다.** `pane.orca.mjs`는
macOS에서도 파싱·평가된다. top-level에서 프로세스를 띄우거나 `await`하거나
환경을 검사해 던지면 macOS가 깨진다. 이 불변식은 §8의 테스트로 봉인한다.

## 4. 공개 인터페이스 (불변)

| 시그니처 | 반환 | 의미 |
|---|---|---|
| `pasteToPane(pane: string, text: string): Promise<void>` | — | 본문을 붙여넣고 잠시 뒤 Enter를 따로 보낸다 |
| `capturePane(pane: string): Promise<string>` | 화면/최근 출력 텍스트 | `extractSessionId`의 입력 |
| `paneCurrentCommand(pane: string): Promise<string>` | 짧은 명령 라벨 | 오류 메시지 문구에만 쓰인다 (`index.mjs:140-141`) |
| `paneHasCodex(pane: string): Promise<boolean>` | 판정 | **안전 게이트** — 거짓이면 붙여넣기를 중단한다 |
| `extractSessionId(paneText: string): string \| null` | 세션 UUID | 순수 함수 |
| `UUID_RE: RegExp` | — | 전역 플래그 정규식 |

테스트가 함께 의존하는 표면: `sanitizeForPaste`, `treeHasCodex`
(`test/tmux.test.mjs`). 둘 다 순수 함수이므로 `pane.mjs`가 플랫폼과 무관하게 tmux
백엔드에서 재수출한다 — Windows에서도 import가 성립해야 테스트가 양쪽에서 돈다.

`pane` 인자의 **타입은 안 바뀌고 의미만 플랫폼별로 해석된다**(§6). 호출부는
`.env`에서 읽은 문자열을 그대로 넘기므로 영향이 없다.

## 5. 플랫폼별 구현 매핑

| 공개 함수 | macOS/Linux (`pane.tmux.mjs`, 무변경) | Windows (`pane.orca.mjs`, 신설) |
|---|---|---|
| `pasteToPane` | `tmux set-buffer -b <buf> -- <clean>` → `tmux paste-buffer -p -d -b <buf> -t <pane>` → sleep → `tmux send-keys -t <pane> Enter` | title→handle 해석 → `orca terminal send --terminal <h> --text "ESC[200~<clean>ESC[201~"` → **동일 sleep 공식** → `orca terminal send --terminal <h> --enter` |
| `capturePane` | `tmux capture-pane -p -t <pane>` (현재 화면) | `orca terminal read --terminal <h> --limit 200 --json` → `result.terminal.tail.join('\n')` (최근 스크롤백) |
| `paneCurrentCommand` | `tmux display-message -p -t <pane> '#{pane_current_command}'` | `read`의 `status` + tail 서명에서 합성한 라벨: `codex` / `pwsh` / `exited` / `unknown` |
| `paneHasCodex` | 현재 명령에 `codex` 포함이면 참, 아니면 `#{pane_pid}` + `ps -axo pid=,ppid=,command=` → `treeHasCodex` | 터미널 생존(`status==="running"` && `connected` && `!orphaned`) **AND** 최근 tail에 codex TUI 서명 **AND** tail 끝이 셸 프롬프트가 아님 |
| `extractSessionId` / `UUID_RE` / `sanitizeForPaste` | 순수 — 그대로 | **같은 함수를 그대로 쓴다** (분기 없음) |

### 5.1 붙여넣기 — 수동 bracketed paste

tmux의 `paste-buffer -p`가 하던 일(본문을 `ESC[200~`/`ESC[201~`로 감싸 TUI가 한
덩어리로 받게 함)을 Windows에서는 우리가 직접 문자열로 만든다.
`orca terminal send --text`는 페이로드를 **PTY에 원문 그대로** 쓴다.

실측 (2026-08-30, orca 1.4.184, codex 0.150.1, Windows 11):

- `--text "ESC[200~첫째 줄\n둘째 줄\n셋째 줄ESC[201~"` → codex 입력창에 3줄이
  들어가고 **제출되지 않음**. 상태는 `Ready` 유지. `bytesWritten: 62`.
- 이어서 `--text` 없이 `--enter`만 → `bytesWritten: 1`(=`\r`), 턴 제출됨.

따라서 tmux판의 2단계 구조(본문 붙여넣기 → sleep → Enter 별도 전송)와 sleep 공식
`200 + min(800, floor(clean.length / 50))`을 **그대로 승계**한다. tmux판 주석의
근거(텍스트와 Enter를 한 번에 보내면 제출되지 않고, 본문 속 줄바꿈이 Enter로
해석돼 중간 제출된다)가 orca에서도 동일하게 성립한다.

**안전성은 `sanitizeForPaste`가 이미 보장한다.** 이 함수는 `\x00-\x08`,
`\x0b-\x1f`, `\x7f`를 지우므로 `ESC`(0x1b)가 포함된다 — 사용자 본문이 종료 마커
`ESC[201~`를 위조할 수 없다. **반드시 sanitize 후에 래핑한다.** (순서를 뒤집으면
우리가 붙인 마커까지 지워진다.)

**무결성 검사:** `send` 응답의 `result.send.bytesWritten`이
`Buffer.byteLength(payload, 'utf8')`와 다르면 전송이 잘린 것이므로 던진다.
실측에서 인용부호·역슬래시·백틱·달러·개행이 섞인 본문도 정확히 일치했다(50 == 50).
이 검사는 공짜이고, Windows 인자 이스케이프 사고를 조용한 오작동이 아니라 즉시
실패로 만든다.

### 5.2 orca CLI 호출 방식

```js
const run = promisify(execFile);
await run('orca', [...args, '--json'], { encoding: 'utf8' });
```

- **`shell: true`를 쓰지 않는다.** ESC를 포함한 페이로드를 셸 인용부호에 통과시킬
  이유가 없고, 통과시키면 위험하다.
- **`orca.cmd`를 직접 부르지 않는다.** 실측: `execFile('orca.cmd', …)`는 `EINVAL`로
  실패하고, `execFile('orca', …)`는 성공한다 — Node가 `PATHEXT` 순서상 `orca.exe`를
  먼저 찾기 때문이다. 이 프로젝트가 `.cmd` 셔임으로 세 번 넘어진 함정(WinError 2/193)의
  Node판이다.
- 바이너리 경로는 `process.env.ORCA_CLI_COMMAND || 'orca'`로 덮어쓸 수 있게 둔다
  (`bot_win.py:orca_bin`과 같은 규약).
- 런타임이 안 떠 있으면 **여기서 띄우지 않는다.** 기동은 `bridge_win.py`의 책임이다
  (`ensure_runtime` 패턴). `pane.orca.mjs`는 "orca 런타임에 접근할 수 없음 — orca 앱
  또는 `orca serve` 확인"이라는 명시적 오류로 끝낸다. 데몬이 사용자 대신 런타임을
  띄우기 시작하면 실패가 조용해진다.

### 5.3 pane 식별자 해석 — title → handle

orca terminal의 `handle`(`term_<uuid>`)은 **생성할 때마다 새로 발급된다.** `.env`는
설치 시 1회 기록되고 `write_bridge_envs`가 멱등(파일 있으면 건너뜀)이라 handle을
박아 넣을 수 없다. 반면 `title`은 우리가 정한다.

```
resolvePane(value):
  1. value가 "term_"으로 시작하면 그대로 handle로 쓴다 (디버깅 탈출구)
  2. name = value.split(':')[0]            // "codex-live:0.0" → "codex-live"
  3. orca terminal list --json             // --worktree 없이 전역 조회
  4. connected && !orphaned && title === name 인 항목
  5. 여럿이면 lastOutputAt 최대
  6. 없으면 throw: `orca 터미널 '<name>'을 찾지 못함 — bridge_win.py tui-up 먼저 실행`
```

- `--worktree` 셀렉터를 **쓰지 않는다.** 실측: orca에 등록되지 않은 폴더는
  `selector_not_found`로 실패한다(`path:.../codex-discord`에서 재현). 브리지
  워크스페이스는 `orca repo add` 대상이 아닐 수 있다(ADR-0005 미배선). 전역 `list`는
  이 문제를 우회한다 — 실측에서 여러 worktree의 터미널이 함께 나온다.
- **title 유일성은 `bridge_win.py`와의 계약이다.** macOS에서 tmux 세션명이 지는
  역할과 정확히 같다. `tui-up`은 같은 title의 터미널을 하나만 만든다.
- 캐시: 모듈 스코프에 `name → handle` 메모를 두고, orca 호출이
  `terminal_not_found` / `ok:false`를 내면 메모를 비우고 **1회만** 재해석한다.
  재해석도 실패하면 던진다. (턴당 CLI 호출을 3회에서 1회로 줄이려는 것뿐이므로 더
  정교하게 만들지 않는다.)

### 5.4 `paneHasCodex` — 왜 프로세스 트리를 못 쓰는가

macOS판은 `#{pane_pid}`로 pane의 루트 PID를 얻어 `ps` 트리를 훑는다.
**orca는 터미널의 PID를 어디에서도 주지 않는다.** 실측으로 확인한 것:

- `terminal list` / `terminal show`의 필드는 `handle`, `ptyId`, `incarnationId`,
  `worktreeId`, `worktreePath`, `branch`, `tabId`, `leafId`, `title`, `connected`,
  `writable`, `orphaned`, `lastOutputAt`, `preview`, `paneRuntimeId` — **PID 없음**.
- `ptyId`는 프로세스 커맨드라인 어디에도 나타나지 않는다.
- 모든 orca 터미널 셸은 `orca-terminal-daemon.exe` 한 프로세스의 **형제 자식**이다.
  즉 프로세스 표만으로는 어느 pwsh가 어느 터미널인지 구별할 수 없다.

플랜의 "ptyId → 자손 트리" 스케치는 이 실측으로 **성립하지 않는다.**
(Phase 3의 `_tui_root_win`도 같은 벽에 부딪힌다 — T3-1 착수 전에 이 절을 읽을 것.)

그래서 Windows 판정은 세 신호의 논리곱으로 바꾼다. 판정 목적이 "pane에 codex가 떠
있는가"가 아니라 **"지금 붙여넣으면 셸에 명령이 입력되는가"**를 막는 것이므로,
화면 서명이 프로세스 트리보다 오히려 직접적인 증거다.

1. **터미널 생존** — `read`의 `status === 'running'`, `list`/`show`의
   `connected === true`, `orphaned === false`. codex도 셸도 죽었으면 여기서 걸린다.
2. **codex TUI 서명** — 최근 tail에 `OpenAI Codex` 배너, `› Ask Codex` 입력 프롬프트,
   또는 상태바 조각(`esc to interrupt`, `Context ` 등)이 있는가.
3. **셸 프롬프트 부재** — tail의 마지막 가시 조각이 `PS <경로>` + `>` 형태로 끝나면
   거짓. codex가 죽고 pwsh 프롬프트가 돌아온 경우가 정확히 이 모양이다.

셋 다 참일 때만 참. **fail-closed** — 판정에 필요한 정보를 못 얻으면(오류, 빈 tail,
JSON 파싱 실패) 거짓을 돌려 붙여넣기를 막는다.

`title` 필드는 판정에 **쓰지 않는다.** 실측에서 pwsh 터미널의 title은 실행 파일
경로였지만, 우리가 `--title`로 이름을 지정한 터미널은 그 이름이 그대로 남는다. 즉
title은 현재 실행 명령의 신뢰할 수 있는 지표가 아니고, §5.3의 식별자 역할과 충돌한다.

### 5.5 `paneCurrentCommand` — 합성 라벨

이 함수의 반환값은 `index.mjs:140-141`의 오류 문구에만 쓰인다
(`… codex 프로세스를 찾지 못함(현재: ${cmd})`). Windows에는 대응하는 tmux 개념이
없으므로, `paneHasCodex`가 이미 읽은 신호로 짧은 라벨을 합성한다:
`codex` / `pwsh` / `exited` / `unknown`. 시그니처와 사용처 의미("지금 pane에서 도는
것의 짧은 이름")는 보존된다.

### 5.6 `capturePane`의 의미 차이 (의도된 것)

tmux `capture-pane -p`는 **현재 화면**을 준다. orca `terminal read`는 **스크롤백
스트림**을 준다 — `tail`은 줄 배열이고 `nextCursor`/`oldestCursor`가 따라온다. TUI
리페인트가 한 줄로 뭉쳐 들어오기도 한다(실측: 부팅 리페인트 전체가 `tail[0]` 한 줄).

이 차이가 유일한 소비자인 `extractSessionId`에는 문제가 되지 않는다. 그 함수는
**마지막 매치**를 고르므로 스크롤백에서도 가장 최근 UUID가 이긴다. 다만 오래된 줄이
결과를 지배하지 않도록 `--limit 200`으로 상한을 둔다(실측: `--limit N`은 **최근
N줄**을 돌려주고 `limited: true`를 표시한다).

부수 관찰: codex 0.150.1은 Windows에서도 상태바에 세션 UUID를 표시하지 않는다(실측
tail에 UUID 없음). macOS v0.146.0에서 관찰된 것과 같다. 즉 실제 경로는
`extractSessionId → null` → `findRolloutByCwd(WORKDIR)` 폴백이다. `rollout.mjs`는
`JSON.parse` 후 `payload.cwd`를 비교하므로 백슬래시 이스케이프 문제는 없다(플랜이
`tui-up.sh`의 `grep -qF`에 대해 지적한 함정은 여기엔 해당하지 않는다).

## 6. `TUI_PANE` 결정 — 기존 키 재해석

**결정: 새 키를 두지 않는다. `TUI_PANE`을 플랫폼별로 재해석한다.**

- macOS: `codex-live:0.0` = tmux `session:window.pane` (종전 그대로)
- Windows: 콜론 앞부분 `codex-live` = **orca terminal title**, 뒷부분은 무시

### 근거

1. **제약이 "기존 macOS `.env` 호환 유지"다.** 재해석은 기존 파일을 한 글자도
   건드리지 않는다. 같은 `.env`가 양쪽 플랫폼에서 그대로 유효해진다.
2. **`write_bridge_envs`가 멱등이라 새 키는 기존 설치에 절대 도달하지 않는다.**
   `harnessctl.py:write_bridge_envs`는 `if p.exists(): continue`로 기존 `.env`를
   보존한다. 새 키 `TUI_TERMINAL`을 도입하면 이미 설치된 환경에는 영원히 안 생기고,
   그걸 메우려면 `.env` 마이그레이션 코드가 필요하다. 재해석은 마이그레이션이 없다.
3. **`index.mjs`의 게이트를 안 건드린다.** `index.mjs:65`의
   `TUI_ENABLED = Boolean(TUI_PANE && TUI_CHANNEL_ID && ENGINE === 'codex')`는 새 키를
   도입하면 반드시 수정해야 하는 줄이고, 그건 **macOS 실행 경로를 건드리는 것**이다.
   지금 mac이 없으므로 그 줄은 안 건드리는 편이 낫다.
4. **`%%:*` 절단은 이미 이 프로젝트의 관례다.** `scripts/tui-up.sh:35`가
   `SESSION="${PANE%%:*}"`로 똑같이 앞부분만 세션 이름으로 쓴다. 새 규칙을 발명하는
   게 아니라 있는 규칙을 다른 백엔드에 적용하는 것이다.
5. **덤으로 네임스페이싱을 얻는다.** 한 머신에서 작업 폴더가 여럿이면 orca title이
   충돌한다. 재해석 덕분에 `TUI_PANE=codex-live-projX:0.0`으로 설치별 이름을 나눌 수
   있다 — 새 키 없이, macOS에서도 유효한 값으로.

### 기각한 대안

- **새 키 `TUI_TERMINAL` + `TUI_PANE` 폴백** — 근거 2·3의 비용을 지불하고 얻는 게
  "이름이 더 정직하다"뿐이다. 실제 값(`codex-live`)은 양쪽에서 같으므로 정직성 이득도
  작다.
- **handle을 `.env`에 기록** — handle이 생성마다 바뀌므로 첫 재기동에 깨진다. 불가.

### 후속 작업에 남기는 요구

- `harnessctl.py:write_bridge_envs:497`은 `TUI_PANE=codex-live:0.0`을 **그대로
  유지**한다. Windows 분기 불필요 — 이 결정의 요점이 그것이다.
- `bridge_win.py tui-up`은 orca 터미널을 만들 때 `--title <TUI_PANE의 콜론 앞부분>`을
  반드시 넘긴다. 이 값이 `pane.orca.mjs`와의 유일한 접합점이다.
- 문서(`skills/setup/SKILL.md:59`)에 Windows에서의 의미를 한 줄 덧붙인다.

## 7. macOS 무변경 근거

mac 없이 확인 가능한 것만 근거로 삼는다.

### 근거 1 — 실행 코드의 바이트 동일성 (기계적으로 증명 가능)

`pane.tmux.mjs`는 `git mv src/tmux.mjs src/pane.tmux.mjs`의 결과이고 내용을 **한 줄도
고치지 않는다.** 순수 함수를 별도 파일로 빼내지도 않는다 — `pane.orca.mjs`가 필요한
순수 함수(`sanitizeForPaste`, `UUID_RE`)를 `pane.tmux.mjs`에서 import한다. 파일명이
tmux이지만 가져가는 것은 순수 함수뿐이다.

```bash
git show HEAD:src/tmux.mjs | diff - src/pane.tmux.mjs   # 출력이 비어야 한다
```

이 명령이 macOS 회귀 검증을 **대체**한다. 코드가 같으면 동작이 같다.

### 근거 2 — macOS에서 함수 객체가 동일하다

`pane.mjs`는 래퍼를 만들지 않고 바인딩을 재수출한다. darwin에서
`pane.pasteToPane === paneTmux.pasteToPane`이 참이다. 호출 경로에 프레임이 하나도
늘지 않는다.

### 근거 3 — macOS에 추가되는 것은 "평가"뿐이고 그것은 무해하다

darwin에서 늘어나는 일은 두 가지다: `pane.mjs` 평가(상수 1개, 재수출),
`pane.orca.mjs` 평가. 후자는 **top-level 부작용이 없다**는 불변식을 지키므로 함수
정의만 등록된다. orca CLI는 호출되지 않고, 존재 여부도 검사하지 않는다.

### 근거 4 — 실패 모드를 열거하고 각각을 봉인한다

| 실패 모드 | macOS에 미치는 영향 | 봉인 |
|---|---|---|
| `pane.orca.mjs`가 import 시점에 던진다 (문법 오류, top-level await, top-level spawn) | 데몬 기동 실패 | T-1: 모든 플랫폼에서 `import('../src/pane.orca.mjs')`가 resolve하는지 확인 |
| 디스패처가 백엔드를 잘못 고른다 | tmux 대신 orca 호출 → 전 기능 실패 | T-2: `selectBackendName('darwin'\|'linux'\|'win32')` 순수 함수 테스트 |
| 누군가 나중에 `pane.tmux.mjs`를 "정리"한다 | 조용한 회귀 | T-3: 바이트 동일성 테스트(근거 1) + 파일 상단 경고 주석 |
| 순환 import | 모듈 평가 교착 | `pane.mjs → {tmux, orca}`, `orca → tmux`. 비순환. T-1이 함께 잡는다 |
| 새 문법으로 Node 22 미만 깨짐 | 기동 실패 | 새 문법 없음. `engines`는 `>=22` 유지 |

### 근거 5 — mac 수급 후 확인할 것 (1회, 2분)

1. `git show HEAD:src/tmux.mjs | diff - src/pane.tmux.mjs` (빈 출력)
2. `npm test` 그린
3. `npm start`로 데몬 기동 → TUI 채널에서 호명 1회 → 응답 확인

플랜 결정 4의 축소된 게이트와 같은 범위다. 이 문서는 그 게이트를 **더 좁힌다** —
1번이 통과하면 2·3번은 형식 확인이다.

## 8. 테스트 계획

`test/tmux.test.mjs` → `test/pane.test.mjs`로 이름을 바꾸고 import 지정자만
`../src/pane.mjs`로 바꾼다. **기존 단언은 한 줄도 고치지 않는다** —
`extractSessionId` / `sanitizeForPaste` / `treeHasCodex`가 `pane.mjs`에서 그대로
재수출되므로 통과해야 한다. 통과하지 못하면 재수출이 잘못된 것이다.

추가:

- **T-1** 두 백엔드 모듈이 어느 플랫폼에서든 import된다 (top-level 부작용 없음)
- **T-2** `selectBackendName`: `darwin`/`linux` → `tmux`, `win32` → `orca`
- **T-3** `pane.tmux.mjs`가 `git show HEAD:src/tmux.mjs`와 바이트 동일 (git 없는
  환경에서는 skip)
- **T-4** (순수부만) Windows 화면 서명 판정: codex tail 샘플과 pwsh 프롬프트 샘플을
  픽스처로 두고 판정 함수가 각각 참/거짓을 내는지. `paneHasCodex`에서 **순수 판정부를
  분리해 export**한다 — macOS판의 `treeHasCodex`가 같은 이유로 분리돼 있는 것과
  동형(ADR-0004 계약 테스트 방식). 실측 tail 픽스처는 §9에 있다.

`npm test`(`node --test`)는 Windows에서도 그대로 돈다. orca CLI를 부르는 함수는
테스트하지 않는다 — 실기동 검증은 Phase 2 완료 조건(디스코드 응답)이 맡는다.

## 9. 실측 기록 (2026-08-30, 이 머신)

환경: Windows 11 Pro 26200, orca 1.4.184, codex 0.150.1, Node v23.3.0.

- `orca terminal create --worktree path:C:/Users/hdmun/repo/ref/codex-discord` →
  `selector_not_found`. **등록되지 않은 폴더에는 터미널을 못 만든다.** 등록된
  `discord-harness-installer` 경로에서는 성공.
- `terminal create` 응답에는 `ptyId`가 없다(`handle`, `tabId`, `worktreeId`, `title`,
  `hostPlatform`, `surface`만). `ptyId`는 `list`/`show`에만 있다 —
  `bot_win.py:orca_terminal_create`가 `ptyId`를 기대하는 것과 어긋난다(별건).
- `terminal read` 응답 형태:
  `{handle, status, tail[], truncated, limited, oldestCursor, nextCursor, latestCursor, returnedLineCount}`.
  `--limit N`은 **최근 N줄**, 잘리면 `limited: true`.
- codex TUI tail 서명 실측: `│ >_ OpenAI Codex (v0.150.1)  │`,
  `› Ask Codex to do anything`,
  `· Ready · Context 100% left · … · 0.150.1 · 0 in · 0 out · Fast off`, 작업 중에는
  `(2s • esc to interrupt)`. **UUID는 없다.**
- pwsh 터미널 서명 실측: `preview`/tail 마지막이 `PS C:\Users\hdmun\repo\usage-coach>`.
- bracketed paste 실측: `--text "ESC[200~3줄ESC[201~"` → 입력창에 3줄, 미제출,
  `bytesWritten: 62`. 이어 `--enter` 단독 → `bytesWritten: 1`, 제출됨.
- Node 인자 전달 실측: 인용부호·역슬래시·백틱·달러·개행이 섞인 페이로드에서
  `bytesWritten === Buffer.byteLength(payload, 'utf8')` (50 == 50). 손실 없음.
- `execFile('orca.cmd', …)` → `EINVAL`. `execFile('orca', …)` → 성공(PATHEXT 순서로
  `orca.exe`가 먼저 잡힌다).
- orca 터미널 프로세스 배치: `orca-terminal-daemon.exe`(1개) → `OpenConsole.exe` +
  `pwsh.exe -EncodedCommand …`(터미널마다 한 쌍, 전부 형제). 터미널과 PID를 잇는
  식별자가 커맨드라인에 없다.

미확인 (구현 세션이 확인할 것):

- **롤아웃 파일 생성** — 프로브 턴을 2초 만에 인터럽트해서 롤아웃이 안 생겼다.
  `tui-up.sh` 주석대로 "첫 턴 **완료** 후 생성"이면 정상이지만 확인은 안 됐다.
  Windows에서 완결된 더미 턴이 `~/.codex/sessions/**/rollout-*.jsonl`을 만들고 그
  `payload.cwd`가 `.env`의 `CODEX_WORKDIR`와 **문자열로 정확히 일치**하는지(드라이브
  문자 대소문자, 경로 구분자) B2-4에서 확인해야 한다. 여기서 어긋나면
  `findRolloutByCwd` 폴백이 통째로 실패하고, Windows에는 UUID 화면 표시가 없으므로
  대안 검출원이 없다.
- codex가 죽고 pwsh 프롬프트만 남은 터미널의 tail 실물 — §5.4 신호 3의 픽스처.
- **`pane.orca.mjs` 구현이 추정한 JSON 봉투 두 곳** (코드 리뷰 2026-08-30, orca 실물
  없이 작성돼 검증 안 됨) — Phase 2 완료 조건(디스코드 응답)에서 재확인할 것:
  - `terminal list` 최상위 키를 `{terminals: [...]}`로 가정. §9는 개별 터미널
    항목의 필드만 실측했고, list 응답을 감싸는 봉투 키는 실측 기록에 없다.
  - `terminal send` 응답의 `bytesWritten` 위치를 `result.send.bytesWritten`으로
    가정(§5.1 문장을 따름). §9는 값(`bytesWritten: 62`)만 인용했고 감싸는 JSON
    구조는 실측 기록에 없다.
  - 둘 다 실제 orca 응답이 다르면 `pane.orca.mjs`의 `lookupHandle`/`pasteToPane`이
    조용히 깨지지 않고 명시적으로 던지도록 짜여 있다(옵셔널 체이닝 뒤 length/개수
    비교로 실패가 드러남) — 그래도 필드명 자체가 틀리면 최초 실기동에서 잡아야
    한다.

## 10. 구현 순서 (다음 세션)

1. `git mv src/tmux.mjs src/pane.tmux.mjs` — 내용 무변경
2. `src/pane.mjs` 작성 (§3 골격)
3. `src/index.mjs:10` 지정자 교체
4. `test/tmux.test.mjs` → `test/pane.test.mjs`, 지정자만 교체 → `npm test` 그린 확인
   **(여기까지가 macOS 무변경 리팩터링. 별도 커밋으로 끊는다.)**
5. `src/pane.orca.mjs` 작성 (§5)
6. T-1 ~ T-4 추가 → `npm test` 그린
7. `bridge_win.py tui-up`(B2-4)이 `--title`을 넘기도록 계약 반영

4번과 5번 사이를 커밋으로 끊는 것이 중요하다. mac에서 회귀가 나면 어느 커밋이
원인인지 즉시 갈린다.
