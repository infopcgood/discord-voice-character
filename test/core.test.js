import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import prism from 'prism-media';
import { DiscordPCM, sessionSettings } from '../src/audio.js';
import { SettingsStore, validateSettings } from '../src/config.js';
import { Realtime } from '../src/realtime.js';
import { commands } from '../src/commands.js';

const settings = validateSettings({ persona: '한국어 캐릭터', voice: 'marin', volume: 0.8, speed: 1 });
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
    const store = new SettingsStore(directory, '기본 캐릭터');
    store.save('123', settings);
    assert.deepEqual(new SettingsStore(directory, '새 기본값').get('123'), settings);
    assert.equal(store.get('456').persona, '기본 캐릭터');
    assert.throws(() => store.get('../123'));
    assert.throws(() => validateSettings({ ...settings, volume: NaN }));
    assert.throws(() => validateSettings({ ...settings, speed: 2 }));
    assert.throws(() => validateSettings({ ...settings, voice: 'unknown' }));
    assert.throws(() => validateSettings({ ...settings, persona: ' ' }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  event(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
async function setup() {
  const socket = new FakeSocket();
  const api = new Realtime({ key: 'test', model: 'test-model', settings, socketFactory: () => socket });
  const connected = api.connect();
  socket.event({ type: 'session.created' });
  assert.deepEqual(socket.sent[0].session, sessionSettings(settings, 'test-model'));
  assert.equal(api.ready, false);
  socket.event({ type: 'session.updated' });
  await connected;
  return { socket, api };
}
test('Realtime handshake, server commit, streaming, and response completion', async () => {
  const { socket, api } = await setup();
  try {
    api.append(Buffer.alloc(4800)); api.respond();
    assert.deepEqual(socket.sent.slice(1).map(x => x.type), ['input_audio_buffer.append', 'response.create']);
    assert.throws(() => api.respond());
    const audio = once(api, 'audio');
    socket.event({ type: 'response.output_audio.delta', delta: Buffer.from([1, 0]).toString('base64') });
    assert.deepEqual((await audio)[0], Buffer.from([1, 0]));
    socket.event({ type: 'response.done', response: { status: 'completed' } });
    assert.equal(api.generating, false);
  } finally { api.close(); }
});
test('stop cancels, truncates unheard audio and ignores late deltas', async () => {
  const { socket, api } = await setup();
  try {
    let received = 0; api.on('audio', () => received++);
    api.respond();
    socket.event({ type: 'response.output_item.added', item: { id: 'item-1', type: 'message' } });
    socket.event({ type: 'response.output_audio.delta', delta: Buffer.alloc(48000).toString('base64') });
    api.stop(200);
    assert.equal(socket.sent.at(-2).type, 'response.cancel');
    assert.equal(socket.sent.at(-1).audio_end_ms, 200);
    socket.event({ type: 'response.output_audio.delta', delta: 'AAA=' });
    assert.equal(received, 1);
    socket.event({ type: 'response.done' });
    api.respond();
    assert.equal(api.turn.discard, false);
  } finally { api.close(); }
});
test('API configuration errors reject startup and network closure reports a fault', async () => {
  const socket = new FakeSocket();
  const api = new Realtime({ key: 'test', model: 'test', settings, socketFactory: () => socket });
  api.on('fault', () => {});
  const connected = api.connect();
  socket.event({ type: 'error', error: { message: 'invalid voice' } });
  await assert.rejects(connected, /invalid voice/);
  api.close();
  const second = await setup();
  const fault = once(second.api, 'fault'); second.socket.close();
  assert.match((await fault)[0].message, /종료/);
  second.api.close();
});
test('outgoing network backpressure is bounded', async () => {
  const { socket, api } = await setup();
  socket.bufferedAmount = 3 * 1024 * 1024;
  assert.throws(() => api.append(Buffer.alloc(960)), /네트워크/);
  api.close();
});
test('all requested slash controls serialize successfully', () => {
  const names = commands[0].options.map(x => x.name);
  for (const name of ['join', 'leave', 'persona', 'voice', 'volume', 'speed', 'listen', 'stop', 'reset', 'silence', 'overlap', 'interrupt', 'model', 'sensitivity']) assert.ok(names.includes(name));
});
test('VAD speech and commit events are forwarded; hot settings wait for server acknowledgement', async () => {
  const { socket, api } = await setup();
  try {
    const events = [];
    for (const name of ['speechStart', 'speechStop', 'committed']) api.on(name, () => events.push(name));
    socket.event({ type: 'input_audio_buffer.speech_started' });
    socket.event({ type: 'input_audio_buffer.speech_stopped' });
    socket.event({ type: 'input_audio_buffer.committed' });
    assert.deepEqual(events, ['speechStart', 'speechStop', 'committed']);
    let applied = false;
    const update = api.updateListening({ ...settings, silenceSeconds: 2.3, vadThreshold: 0.7 }).then(() => { applied = true; });
    const detection = socket.sent.at(-1).session.audio.input.turn_detection;
    assert.equal(detection.silence_duration_ms, 2300);
    assert.equal(detection.threshold, 0.7);
    assert.equal(detection.create_response, false);
    assert.equal(detection.interrupt_response, false);
    assert.equal(applied, false);
    socket.event({ type: 'session.updated' }); await update;
    assert.equal(applied, true);
  } finally { api.close(); }
});
test('interruption before the first audio packet truncates late audio exactly once', async () => {
  const { socket, api } = await setup();
  try {
    api.respond(); api.stop(0); api.stop(0);
    let audible = 0; api.on('audio', () => audible++);
    socket.event({ type: 'response.created', response: { id: 'r1' } });
    socket.event({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'i1', delta: Buffer.alloc(960).toString('base64') });
    socket.event({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'i1', delta: Buffer.alloc(960).toString('base64') });
    assert.equal(audible, 0);
    assert.equal(socket.sent.filter(x => x.type === 'response.cancel').length, 1);
    const trims = socket.sent.filter(x => x.type === 'conversation.item.truncate');
    assert.equal(trims.length, 1); assert.equal(trims[0].audio_end_ms, 0);
    socket.event({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } });
    api.respond(); socket.event({ type: 'response.created', response: { id: 'r2' } });
    socket.event({ type: 'response.done', response: { id: 'r1' } });
    assert.equal(api.generating, true);
  } finally { api.close(); }
});
