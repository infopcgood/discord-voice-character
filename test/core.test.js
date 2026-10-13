import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import prism from 'prism-media';
import { SpeechPackets } from '../src/playback.js';
import { SettingsStore, validateSettings } from '../src/config.js';
import { commands } from '../src/commands.js';

const settings = validateSettings({ model: 'local/model', persona: '한국어 캐릭터', voice: 'default', volume: 0.8, speed: 1 });
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('direct Opus packets decode as Discord receive PCM including a partial last frame', async () => {
  const pcm = Buffer.alloc(960 * 3 + 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(10000 * Math.sin(i / 2 * 2 * Math.PI * 440 / 24000)), i);
  const source = new SpeechPackets(pcm);
  const decoder = new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: 480 });
  const result = await collect(source.pipe(decoder));
  assert.equal(result.length, 960 * 4); assert.ok(result.some(byte => byte !== 0));
  assert.equal(source.codec, null);
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
  for (const name of ['join', 'leave', 'act', 'persona', 'voice', 'volume', 'speed', 'listen', 'stop', 'reset', 'silence', 'overlap', 'interrupt', 'model', 'sensitivity']) assert.ok(names.includes(name));
  const text = commands[0].options.find(x => x.name === 'act').options[0];
  assert.equal(text.name, 'text'); assert.equal(text.required, true);
  assert.equal(text.min_length, 1); assert.equal(text.max_length, 2000);
});

test('v2 speech models migrate once; v3 server-specific Strata models survive default changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-character-migration-'));
  try {
    const store = new SettingsStore(directory, 'new persona', 'local/default');
    const old = { ...settings, model: 'gpt-realtime-1.5', voice: 'cedar' };
    delete old.schemaVersion;
    fs.writeFileSync(store.file('123'), JSON.stringify(old));
    const migrated = store.get('123');
    assert.equal(migrated.schemaVersion, 4); assert.equal(migrated.model, 'local/default');
    assert.equal(migrated.persona, old.persona); assert.equal(migrated.voice, 'default');
    store.save('123', { ...migrated, model: 'org/custom:model' });
    const next = new SettingsStore(directory, 'another persona', 'local/other');
    assert.equal(next.get('123').model, 'org/custom:model');
    assert.equal(next.get('456').model, 'local/other');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('v3 settings migrate speech ranges and preserve persona, volume, and Strata model', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-v4-'));
  try {
    const store = new SettingsStore(directory, 'new', 'default/model');
    fs.writeFileSync(store.file('123'), JSON.stringify({ ...settings, schemaVersion: 3, voice: 'marin', speed: 0.25, silenceSeconds: 5 }));
    const migrated = store.get('123');
    assert.equal(migrated.model, settings.model); assert.equal(migrated.persona, settings.persona);
    assert.equal(migrated.volume, settings.volume); assert.equal(migrated.voice, 'default');
    assert.equal(migrated.speed, 0.7); assert.equal(migrated.silenceSeconds, 3);
    store.save('123', { ...migrated, voice: 'voice_custom123' });
    assert.equal(store.get('123').voice, 'voice_custom123');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
