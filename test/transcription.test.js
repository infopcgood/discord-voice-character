import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Transcription } from '../src/transcription.js';

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  event(type, fields = {}) { this.emit('message', Buffer.from(JSON.stringify({ type, ...fields }))); }
}
function fixture(options = {}) {
  const socket = new Socket(); const settings = { silenceSeconds: 0.85, vadThreshold: 0.5 };
  let request;
  const api = new Transcription({ key: 'cloud-only', settings, socketFactory: (url, options) => { request = { url, options }; return socket; }, ...options });
  api.on('fault', () => {});
  return { api, socket, request: () => request };
}
async function connected(options) {
  const f = fixture(options); const promise = f.api.connect();
  f.socket.emit('open'); f.socket.event('session.updated', { session: { type: 'transcription' } });
  await promise; return f;
}

test('transcription-only handshake keeps PCM/VAD online and never requests a cloud LLM response', async () => {
  const { api, socket, request } = await connected();
  try {
    assert.equal(request().url, 'wss://api.openai.com/v1/realtime?intent=transcription');
    assert.equal(request().options.headers.Authorization, 'Bearer cloud-only');
    const session = socket.sent[0].session;
    assert.equal(session.type, 'transcription');
    assert.equal(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
    assert.equal(session.audio.input.format.rate, 24000);
    assert.equal(session.audio.input.turn_detection.create_response, false);
    assert.equal(session.audio.input.turn_detection.interrupt_response, false);
    api.append(Buffer.alloc(960));
    assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.append');
    assert.ok(socket.sent.every(event => event.type !== 'response.create'));
  } finally { api.close(); }
});

test('transcripts are emitted in committed order even when later recognition finishes first', async () => {
  const { api, socket } = await connected();
  try {
    const seen = []; api.on('transcript', text => seen.push(text));
    socket.event('input_audio_buffer.committed', { item_id: 'a' });
    socket.event('input_audio_buffer.committed', { item_id: 'b', previous_item_id: 'a' });
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'b', transcript: '두 번째' });
    assert.deepEqual(seen, []);
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'a', transcript: '첫 번째' });
    assert.deepEqual(seen, ['첫 번째\n두 번째']);
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'a', transcript: 'duplicate' });
    assert.equal(seen.length, 1);
    socket.event('input_audio_buffer.committed', { item_id: 'empty' });
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'empty', transcript: ' ' });
    assert.equal(seen.length, 1);
  } finally { api.close(); }
});

test('manual stop fences old transcripts even after a new utterance begins', async () => {
  const { api, socket } = await connected();
  try {
    const seen = []; api.on('transcript', text => seen.push(text));
    socket.event('input_audio_buffer.speech_started', { item_id: 'old' });
    socket.event('input_audio_buffer.committed', { item_id: 'old' });
    api.clearInput();
    socket.event('input_audio_buffer.speech_started', { item_id: 'in-flight-before-clear' });
    socket.event('input_audio_buffer.cleared');
    socket.event('input_audio_buffer.speech_started', { item_id: 'new' });
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'in-flight-before-clear', transcript: 'discard this too' });
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'old', transcript: 'discard me' });
    socket.event('input_audio_buffer.committed', { item_id: 'new' });
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'new', transcript: 'keep me' });
    assert.deepEqual(seen, ['keep me']);
    assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.clear');
  } finally { api.close(); }
});

test('VAD events and acknowledged listening updates preserve the transcription session', async () => {
  const { api, socket } = await connected();
  try {
    const events = []; api.on('speechStart', () => events.push('start')); api.on('speechStop', () => events.push('stop'));
    socket.event('input_audio_buffer.speech_started', { item_id: 'a' }); socket.event('input_audio_buffer.speech_stopped', { item_id: 'a' });
    assert.deepEqual(events, ['start', 'stop']);
    const next = { silenceSeconds: 2, vadThreshold: 0.7 }; let applied = false;
    const update = api.updateListening(next).then(() => { applied = true; });
    await Promise.resolve(); assert.equal(applied, false);
    assert.equal(socket.sent.at(-1).session.audio.input.turn_detection.silence_duration_ms, 2000);
    socket.event('session.updated', { session: { type: 'transcription' } }); await update;
    assert.equal(api.settings, next); assert.equal(api.ready, true);
  } finally { api.close(); }
});

test('startup failure, close during handshake, backpressure, and transcript failure are surfaced', async () => {
  const a = fixture(); const startup = a.api.connect(); a.socket.event('error', { error: { message: 'secret transcript' } });
  await assert.rejects(startup, error => !error.message.includes('secret transcript')); assert.equal(a.api.closed, true);
  const b = fixture(); const connecting = b.api.connect(); b.api.close(); await assert.rejects(connecting, /종료/);
  const c = await connected(); c.socket.bufferedAmount = 3 * 1024 * 1024;
  assert.throws(() => c.api.append(Buffer.alloc(960)), /네트워크/);
  const failure = once(c.api, 'fault');
  c.socket.event('conversation.item.input_audio_transcription.failed', { item_id: 'a' });
  assert.match((await failure)[0].message, /전사/); assert.equal(c.api.closed, true);
});

test('missing transcription has a watchdog and closing clears pending timers', async () => {
  const { api, socket } = await connected({ transcriptTimeoutMs: 10 });
  const fault = once(api, 'fault'); socket.event('input_audio_buffer.committed', { item_id: 'a' });
  assert.match((await fault)[0].message, /초과/); assert.equal(api.items.size, 0);
});
