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
