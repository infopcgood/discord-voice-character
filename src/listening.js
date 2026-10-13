import fs from 'node:fs';
import path from 'node:path';

function validId(id) {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('Invalid Discord ID');
}

// Separate from character settings so persona/model saves never overwrite consent.
export class ListeningStore {
  constructor(directory) { this.directory = directory; this.cache = new Map(); }
  file(guildId) { validId(guildId); return path.join(this.directory, `${guildId}.json`); }
  load(guildId) {
    const file = this.file(guildId);
    if (this.cache.has(guildId)) return this.cache.get(guildId);
    let users = {};
    try { users = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!users || typeof users !== 'object' || Array.isArray(users) ||
        Object.entries(users).some(([id, enabled]) => !/^\d+$/.test(id) || typeof enabled !== 'boolean')) {
      throw new Error('저장된 음성 수신 설정이 올바르지 않습니다.');
    }
    this.cache.set(guildId, users); return users;
  }
  get(guildId, userId) {
    validId(userId);
    return this.load(guildId)[userId]; // undefined means the user has no saved choice.
  }
  set(guildId, userId, enabled) {
    validId(userId);
    if (typeof enabled !== 'boolean') throw new Error('음성 수신 설정은 켜기/끄기여야 합니다.');
    const users = { ...this.load(guildId), [userId]: enabled };
    fs.mkdirSync(this.directory, { recursive: true });
    const file = this.file(guildId);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    this.cache.set(guildId, users); // Publish the choice only after the disk write succeeds.
  }
}

// Called at session start and on channel changes. Departures affect reception,
// never the persisted choice. Unknown users keep the existing owner-only default.
export function restoreListening(session, store, guildId, allowed = new Set(), userId) {
  const ids = userId === undefined
    ? new Set([...session.listeners, ...session.channel.members.keys()]) : [userId];
  for (const id of ids) {
    const member = session.channel.members.get(id);
    const enabled = Boolean(member && !member.user.bot && (!allowed.size || allowed.has(id)) &&
      (store.get(guildId, id) ?? id === session.owner));
    session.setListening(id, enabled);
  }
}

export function saveListening(session, store, guildId, userId, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('음성 수신 설정은 켜기/끄기여야 합니다.');
  // Opt-out takes effect immediately, even if saving fails (e.g. a full disk).
  if (!enabled) session.setListening(userId, false);
  try { store.set(guildId, userId, enabled); }
  catch (cause) {
    throw new Error(enabled ? '음성 수신 설정을 저장하지 못했습니다. 다시 시도하세요.' :
      '현재 음성 수신은 껐지만 설정을 저장하지 못했습니다. 다시 시도하세요. 재연결 시 이전 설정이 적용됩니다.', { cause });
  }
  if (enabled) session.setListening(userId, true);
}
