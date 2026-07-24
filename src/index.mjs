import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { SessionStore } from './sessions.mjs';
import { runCodexTurn, killActiveCodexChildren } from './codex.mjs';
import { chunkMessage } from './chunk.mjs';
import { pasteToPane, capturePane, extractSessionId, paneCurrentCommand } from './tmux.mjs';
import { findRolloutById, RolloutTail } from './rollout.mjs';
import { classifyMessage, ContextQueue } from './routing.mjs';
import { extractAttachmentMarkers, resolveUploadPath, saveIncomingAttachments } from './attachments.mjs';

const TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED = new Set(
  (process.env.ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
const WORKDIR = process.env.CODEX_WORKDIR;

if (!TOKEN || ALLOWED.size === 0 || !WORKDIR) {
  console.error('DISCORD_TOKEN, ALLOWED_USER_IDS, CODEX_WORKDIR를 .env에 설정하세요.');
  process.exit(1);
}

const LOCK_PATH = fileURLToPath(new URL('../data/daemon.pid', import.meta.url));
try {
  const oldPid = Number(await readFile(LOCK_PATH, 'utf8'));
  if (oldPid) {
    try {
      process.kill(oldPid, 0); // 살아있으면 예외 없음
      console.error(`이미 다른 데몬(PID ${oldPid})이 실행 중입니다. 중복 실행은 이중 응답/이중 주입을 일으킵니다.`);
      process.exit(1);
    } catch { /* 죽은 PID — 무시하고 진행 */ }
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
await mkdir(dirname(LOCK_PATH), { recursive: true });
await writeFile(LOCK_PATH, String(process.pid));

const TUI_PANE = process.env.TUI_PANE || null;            // 예: ai:codex-live
const TUI_CHANNEL_ID = process.env.TUI_CHANNEL_ID || null;
const TUI_ENABLED = Boolean(TUI_PANE && TUI_CHANNEL_ID);

const store = new SessionStore(
  fileURLToPath(new URL('../data/sessions.json', import.meta.url)),
);
await store.load();

// 채널당 직렬 큐: 턴 진행 중 도착한 메시지는 앞 턴이 끝난 뒤 처리
const queues = new Map();
function enqueue(channelId, job) {
  const prev = queues.get(channelId) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(channelId, next);
  return next;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // DM 수신에 필요
});

const tuiQueue = new ContextQueue();
let tuiTail = null;
let tuiSessionId = null;

// codex 답변을 채널로 릴레이: [[첨부: 경로]] 마커는 걷어내 검증 후 파일로 첨부
async function relayReply(channel, raw) {
  const { text, paths } = extractAttachmentMarkers(raw);
  for (const chunk of chunkMessage(text)) {
    await channel.send({ content: chunk, allowedMentions: { parse: [] } }).catch((err) => console.error('릴레이 전송 실패:', err.message));
  }
  const files = [];
  const problems = [];
  for (const p of paths) {
    try {
      files.push(await resolveUploadPath(p, WORKDIR));
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (files.length) {
    await channel.send({ files, allowedMentions: { parse: [] } }).catch((err) => problems.push(`전송 실패: ${err.message}`));
  }
  if (problems.length) {
    await channel.send({ content: `⚠️ 첨부 실패: ${problems.join(' / ')}`.slice(0, 1500), allowedMentions: { parse: [] } }).catch(() => {});
  }
}

// 수신 메시지의 첨부를 워크스페이스 uploads/로 내려받아 본문에 경로 주석을 덧붙인다
async function withAttachments(message, content) {
  if (message.attachments.size === 0) return content;
  try {
    const { saved, errors } = await saveIncomingAttachments([...message.attachments.values()], WORKDIR);
    if (saved.length) content += `\n(첨부 파일: ${saved.join(', ')})`;
    if (errors.length) content += `\n(첨부 저장 실패: ${errors.join(' / ')})`;
  } catch (err) {
    content += `\n(첨부 저장 실패: ${err.message})`;
  }
  return content;
}

// TUI pane의 현재 codex 세션을 찾아 롤아웃 tail을 연결한다.
// pane에서 codex를 재시작해 세션이 바뀌면 tail도 갈아탄다.
async function ensureTuiTail(channel) {
  const cmd = await paneCurrentCommand(TUI_PANE);
  if (!cmd.includes('codex')) {
    throw new Error(`TUI pane(${TUI_PANE})의 현재 프로세스가 codex가 아님(${cmd}) — 셸에 명령이 입력되는 것을 막기 위해 중단`);
  }
  const sid = extractSessionId(await capturePane(TUI_PANE));
  if (!sid) throw new Error(`TUI pane(${TUI_PANE})에서 codex 세션 ID를 찾지 못함 — TUI가 떠 있는지 확인하세요`);
  if (sid === tuiSessionId && tuiTail) return;
  const file = await findRolloutById(sid);
  if (!file) throw new Error(`세션 ${sid}의 롤아웃 파일이 아직 없음 — TUI에서 메시지를 한 번 보낸 뒤 다시 시도하세요`);
  tuiTail?.stop();
  tuiSessionId = sid;
  tuiTail = new RolloutTail(file);
  // 콜백이 캡처하는 channel은 최초 연결 시점의 것 — TUI 채널이 단일 고정이라 안전
  await tuiTail.start((text) => relayReply(channel, text));
  console.log(`TUI tail 연결: 세션 ${sid}`);
}

client.on('messageCreate', async (message) => {
  if (TUI_ENABLED && message.channelId === TUI_CHANNEL_ID) {
    const verdict = classifyMessage({
      isMe: message.author.id === client.user.id,
      isBot: message.author.bot,
      allowed: ALLOWED.has(message.author.id),
      mentionsMe: message.mentions.users.has(client.user.id),
      mentionsOthers: message.mentions.users.size > 0 && !message.mentions.users.has(client.user.id),
      content: message.content ?? '',
    });
    if (verdict === 'ignore') return;
    const speaker = message.member?.displayName ?? message.author.username;
    if (verdict === 'context') {
      tuiQueue.push(speaker, await withAttachments(message, message.cleanContent));
      return;
    }
    enqueue(message.channelId, async () => {
      let block = null;
      try {
        await ensureTuiTail(message.channel);
        block = tuiQueue.drain(speaker, await withAttachments(message, message.cleanContent));
        await pasteToPane(TUI_PANE, block);
      } catch (err) {
        if (block !== null) tuiQueue.restore(block);
        await message.channel.send({ content: `⚠️ ${String(err.message ?? err).slice(0, 1500)}`, allowedMentions: { parse: [] } }).catch(() => {});
      }
    });
    return;
  }

  // ===== 기존 headless 경로 (기존 코드 그대로) =====
  if (message.author.bot) return;
  if (!ALLOWED.has(message.author.id)) return;
  // 다른 봇(예: Claude)을 멘션한 메시지는 그 봇의 몫 — 가로채지 않는다
  if (message.mentions.users.size > 0 && !message.mentions.users.has(client.user.id)) return;
  const basePrompt = message.content?.trim() ?? '';
  if (!basePrompt && message.attachments.size === 0) return;

  enqueue(message.channelId, async () => {
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
    try {
      message.channel.sendTyping().catch(() => {});
      const prompt = await withAttachments(message, basePrompt);
      const prior = store.get(message.channelId);
      const result = await runCodexTurn({ sessionId: prior, prompt, cwd: WORKDIR });
      await relayReply(message.channel, result.reply);
      if (result.sessionId && result.sessionId !== prior) {
        try {
          await store.set(message.channelId, result.sessionId);
        } catch (err) {
          console.error('세션 매핑 저장 실패:', err);
        }
      }
    } catch (err) {
      await message.channel.send(`⚠️ ${String(err.message ?? err).slice(0, 1500)}`).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  });
});

client.once('clientReady', () => {
  console.log(`로그인: ${client.user.tag} / 허용 사용자 ${ALLOWED.size}명 / 작업폴더 ${WORKDIR}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    killActiveCodexChildren();
    client.destroy();
    try { unlinkSync(LOCK_PATH); } catch { /* 없으면 무시 */ }
    process.exit(0);
  });
}

await client.login(TOKEN);
