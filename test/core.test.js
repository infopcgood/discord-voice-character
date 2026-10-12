import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import prism from 'prism-media';
import { DiscordPCM } from '../src/audio.js';
import { SettingsStore, validateSettings } from '../src/config.js';
import { commands } from '../src/commands.js';

const settings = validateSettings({ model: 'local/model', persona: '한국어 캐릭터', voice: 'marin', volume: 0.8, speed: 1 });
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('resampler preserves duration/stereo and split-byte chunk boundaries', async () => {
  const data = Buffer.alloc(960);
  for (let i = 0; i < 480; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 18000), i * 2);
  const whole = await collect(Readable.from([data]).pipe(new DiscordPCM()));
  const split = await collect(Readable.from([data.subarray(0, 1), data.subarray(1, 137), data.subarray(137)]).pipe(new DiscordPCM()));
  assert.deepEqual(split, whole);
  assert.equal(whole.length, 3840); // 20 ms, 48 kHz stereo
  for (let i = 0; i < whole.length; i += 4) assert.equal(whole.readInt16LE(i), whole.readInt16LE(i + 2));
});
test('resampler rejects an incomplete final PCM sample', async () => {
  await assert.rejects(collect(Readable.from([Buffer.from([1])]).pipe(new DiscordPCM())), /Incomplete/);
});
test('actual Opus codec encodes Discord stereo and decodes 24 kHz mono', async () => {
  const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  const decoder = new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: 480 });
  const pcm = Buffer.alloc(3840 * 4);
  for (let i = 0; i < pcm.length; i += 4) {
    const value = Math.round(10000 * Math.sin(i / 4 * 2 * Math.PI * 440 / 48000));
    pcm.writeInt16LE(value, i); pcm.writeInt16LE(value, i + 2);
  }
  const result = await collect(Readable.from([pcm]).pipe(encoder).pipe(decoder));
  assert.equal(result.length, 960 * 4);
  assert.ok(result.some(byte => byte !== 0));
});
test('settings persist per guild and reject unsafe paths or invalid values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-character-test-'));
  try {
    const store = new SettingsStore(directory, '기본 캐릭터', 'local/model');
    store.save('123', settings);
    assert.deepEqual(new SettingsStore(directory, '새 기본값', 'local/model').get('123'), settings);
    assert.equal(store.get('456').persona, '기본 캐릭터');
    assert.throws(() => store.get('../123'));
    assert.throws(() => validateSettings({ ...settings, volume: NaN }));
    assert.throws(() => validateSettings({ ...settings, speed: 2 }));
    assert.throws(() => validateSettings({ ...settings, voice: 'unknown' }));
    assert.throws(() => validateSettings({ ...settings, persona: ' ' }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('all requested slash controls serialize successfully', () => {
  const names = commands[0].options.map(x => x.name);
  for (const name of ['join', 'leave', 'persona', 'voice', 'volume', 'speed', 'listen', 'stop', 'reset', 'silence', 'overlap', 'interrupt', 'model', 'sensitivity']) assert.ok(names.includes(name));
});

test('v2 speech models migrate once; v3 server-specific Strata models survive default changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-character-migration-'));
  try {
    const store = new SettingsStore(directory, 'new persona', 'local/default');
    const old = { ...settings, model: 'gpt-realtime-1.5', voice: 'cedar' };
    delete old.schemaVersion;
    fs.writeFileSync(store.file('123'), JSON.stringify(old));
    const migrated = store.get('123');
    assert.equal(migrated.schemaVersion, 3); assert.equal(migrated.model, 'local/default');
    assert.equal(migrated.persona, old.persona); assert.equal(migrated.voice, 'cedar');
    store.save('123', { ...migrated, model: 'org/custom:model' });
    const next = new SettingsStore(directory, 'another persona', 'local/other');
    assert.equal(next.get('123').model, 'org/custom:model');
    assert.equal(next.get('456').model, 'local/other');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
