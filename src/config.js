import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const model = process.env.STRATA_MODEL?.trim() || '';
export function parseGuildIds(env = process.env) {
  const raw = env.DISCORD_GUILD_IDS ?? env.DISCORD_GUILD_ID ?? '';
  if (!raw.trim() || raw.trim() === '*') return new Set();
  const ids = raw.split(',').map(x => x.trim()).filter(Boolean);
  if (ids.some(id => !/^\d+$/.test(id))) throw new Error('DISCORD_GUILD_IDS에는 서버 ID를 쉼표로 구분해 입력하세요.');
  return new Set(ids);
}
export const guildIds = parseGuildIds();
export function acceptsGuild(id, ids = guildIds) { return ids.size === 0 || ids.has(id); }
export const allowed = new Set((process.env.ALLOWED_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
export const idleMinutes = Number(process.env.IDLE_MINUTES || 10);
export function requireEnv(names) {
  for (const name of names) if (!process.env[name]?.trim()) throw new Error(`.env에 ${name} 값을 입력하세요.`);
  if (!Number.isFinite(idleMinutes) || idleMinutes < 1) throw new Error('IDLE_MINUTES는 1 이상의 숫자여야 합니다.');
}
export function validateSettings(value, defaultModel = model) {
  // Apply defaults without confusing a saved LLM selection with a legacy voice model.
  value = { model: defaultModel, silenceSeconds: 0.85, overlap: true, interrupt: true, vadThreshold: 0.5, visibility: 'public', ...value };
  if (typeof value.persona !== 'string' || !value.persona.trim() || value.persona.length > 12000) throw new Error('프롬프트는 1~12000자로 입력하세요.');
  if (value.voice !== 'default' && (typeof value.voice !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.voice))) throw new Error('ElevenLabs Voice ID 또는 default를 입력하세요.');
  if (!Number.isFinite(value.volume) || value.volume < 0 || value.volume > 2) throw new Error('볼륨은 0~200%입니다.');
  if (!Number.isFinite(value.speed) || value.speed < 0.7 || value.speed > 1.2) throw new Error('속도는 0.7~1.2입니다.');
  if (typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value.model)) throw new Error('올바른 Strata 모델 ID를 입력하세요. STRATA_MODEL 설정을 확인하세요.');
  if (!Number.isFinite(value.silenceSeconds) || value.silenceSeconds < 0.3 || value.silenceSeconds > 3) throw new Error('침묵 대기 시간은 0.3~3초입니다.');
  if (typeof value.overlap !== 'boolean' || typeof value.interrupt !== 'boolean') throw new Error('겹침 수신과 자동 끼어들기 설정은 켜기/끄기여야 합니다.');
  if (!['public', 'private'].includes(value.visibility)) throw new Error('텍스트 공개 범위는 public 또는 private입니다.');
  if (!Number.isFinite(value.vadThreshold) || value.vadThreshold < 0.1 || value.vadThreshold > 0.9) throw new Error('음성 감지 기준은 0.1~0.9입니다.');
  return { schemaVersion: 4, persona: value.persona, voice: value.voice, volume: value.volume, speed: value.speed,
    model: value.model, silenceSeconds: value.silenceSeconds, overlap: value.overlap, interrupt: value.interrupt, vadThreshold: value.vadThreshold, visibility: value.visibility };
}
export class SettingsStore {
  constructor(directory = path.join(root, 'data'), persona = fs.readFileSync(path.join(root, 'persona.txt'), 'utf8'), defaultModel = model) {
    this.directory = directory;
    this.defaults = validateSettings({ persona, voice: 'default', volume: 0.8, speed: 1, model: defaultModel });
  }
  file(id) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid guild ID');
    return path.join(this.directory, `${id}.json`);
  }
  get(id) {
    const file = this.file(id);
    if (!fs.existsSync(file)) return { ...this.defaults };
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    // v1/v2 model selected a speech-to-speech model, never a Strata model.
    if (!saved.schemaVersion || saved.schemaVersion < 3) saved.model = this.defaults.model;
    if (!saved.schemaVersion || saved.schemaVersion < 4) {
      saved.voice = 'default';
      saved.speed = Math.max(0.7, Math.min(1.2, saved.speed ?? 1));
      saved.silenceSeconds = Math.max(0.3, Math.min(3, saved.silenceSeconds ?? 0.85));
    }
    return validateSettings(saved, this.defaults.model);
  }
  save(id, settings) {
    const valid = validateSettings(settings);
    fs.mkdirSync(this.directory, { recursive: true });
    const file = this.file(id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(valid, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return valid;
  }
}


