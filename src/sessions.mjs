import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = {};
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.map = {};
      return;
    }
    try {
      this.map = JSON.parse(raw);
    } catch {
      // 손상된 파일은 .bad로 치우고 빈 매핑으로 시작
      const badPath = `${this.filePath}.bad`;
      await rename(this.filePath, badPath);
      console.error(`세션 파일 손상되어 ${badPath}로 이동, 빈 매핑으로 시작`);
      this.map = {};
    }
  }

  get(channelId) {
    return this.map[channelId] ?? null;
  }

  async set(channelId, sessionId) {
    this.map[channelId] = sessionId;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.map, null, 2));
    await rename(tmpPath, this.filePath);
  }
}
