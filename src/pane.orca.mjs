// Windows 백엔드 (orca terminal). §5 구현 예정 — 이 시점에는 pane.mjs의 정적
// import 대상으로 존재하기만 하면 된다. top-level 부작용 없음(§8 T-1).

export async function pasteToPane(_pane, _text) {
  throw new Error('pane.orca.mjs: not implemented yet');
}

export async function capturePane(_pane) {
  throw new Error('pane.orca.mjs: not implemented yet');
}

export async function paneCurrentCommand(_pane) {
  throw new Error('pane.orca.mjs: not implemented yet');
}

export async function paneHasCodex(_pane) {
  throw new Error('pane.orca.mjs: not implemented yet');
}
