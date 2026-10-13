import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Transcription } from '../src/transcription.js';

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  event(message_type, fields = {}) { this.emit('message', Buffer.from(JSON.stringify({ message_type, ...fields }))); }
}
function fixture(options = {}) {
  const sockets = []; const requests = [];
  const api = new Transcription({ key: 'speech-only', settings: { silenceSeconds: 0.85, vadThreshold: 0.5 },
    socketFactory: (url, options) => { requests.push({ url: new URL(url), options }); const socket = new Socket(); sockets.push(socket); return socket; }, ...options });
  api.on('fault', () => {});
  return { api, sockets, requests };
}
async function connected(options) {
  const f = fixture(options); const pending = f.api.connect();
  f.sockets[0].event('session_started'); await pending; return { ...f, socket: f.sockets[0] };
}

test('ElevenLabs handshake negotiates PCM/VAD and sends audio with independent credentials', async t => {
  const { api, socket, requests } = await connected({ language: 'ko' }); t.after(() => api.close());
  const { url, options } = requests[0];
  assert.equal(url.origin, 'wss://api.elevenlabs.io'); assert.equal(url.pathname, '/v1/speech-to-text/realtime');
  assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
  assert.equal(url.searchParams.get('audio_format'), 'pcm_24000');
  assert.equal(url.searchParams.get('commit_strategy'), 'vad');
  assert.equal(url.searchParams.get('vad_silence_threshold_secs'), '0.85');
  assert.equal(url.searchParams.get('language_code'), 'ko');
  assert.deepEqual(options.headers, { 'xi-api-key': 'speech-only' });
  api.append(Buffer.alloc(960));
  assert.deepEqual(socket.sent, [{ message_type: 'input_audio_chunk', audio_base_64: Buffer.alloc(960).toString('base64'), sample_rate: 24000, commit: false }]);
});

test('partial updates trigger one interruption and only final commits become conversation input', async t => {
  const { api, socket } = await connected(); t.after(() => api.close()); const seen = [];
  api.on('speechStart', () => seen.push('start')); api.on('speechStop', () => seen.push('stop')); api.on('transcript', text => seen.push(text));
  socket.event('partial_transcript', { text: '' });
  socket.event('partial_transcript', { text: '안녕' }); socket.event('partial_transcript', { text: '안녕하세요' });
  assert.deepEqual(seen, ['start']);
  socket.event('committed_transcript', { text: '안녕하세요.' });
  socket.event('committed_transcript_with_timestamps', { text: '안녕하세요.', words: [] });
  socket.event('committed_transcript', { text: '두 번째' }); // Final without preceding partial.
  assert.deepEqual(seen, ['start', '안녕하세요.', 'stop', 'start', '두 번째', 'stop']);
});

test('stop replaces the socket, discards old events and drops audio until the new handshake', async t => {
  const { api, socket, sockets } = await connected(); t.after(() => api.close()); const seen = [];
  api.on('transcript', text => seen.push(text));
  socket.event('partial_transcript', { text: 'old' }); api.clearInput();
  assert.equal(socket.readyState, 3); assert.equal(api.ready, false);
  api.append(Buffer.alloc(960)); assert.equal(sockets[1].sent.length, 0);
  socket.event('committed_transcript', { text: 'discard' }); socket.emit('error', new Error('late close'));
  sockets[1].event('session_started'); sockets[1].event('committed_transcript', { text: 'new' });
  assert.deepEqual(seen, ['new']); assert.equal(api.closed, false);
});

test('listening updates reconnect only for VAD changes and wait for acknowledgement', async t => {
  const { api, sockets, requests } = await connected(); t.after(() => api.close());
  await api.updateListening({ ...api.settings, interrupt: false }); assert.equal(sockets.length, 1);
  const update = api.updateListening({ ...api.settings, silenceSeconds: 2, vadThreshold: 0.7 });
  assert.equal(api.ready, false); assert.equal(requests[1].url.searchParams.get('vad_threshold'), '0.7');
  assert.equal(requests[1].url.searchParams.get('vad_silence_threshold_secs'), '2');
  sockets[1].event('session_started'); await update; assert.equal(api.ready, true);
});

test('startup faults, close during handshake and backpressure surface without leaking payloads', async () => {
  const a = fixture(); const startup = a.api.connect(); a.sockets[0].event('auth_error', { error: 'private details' });
  await assert.rejects(startup, e => /auth_error/.test(e.message) && !e.message.includes('private details'));
  const b = fixture(); const pending = b.api.connect(); b.api.close(); await assert.rejects(pending, /종료/);
  const c = await connected(); c.socket.bufferedAmount = 3 * 1024 * 1024;
  assert.throws(() => c.api.append(Buffer.alloc(960)), /네트워크/);
  const fault = once(c.api, 'fault'); c.socket.event('quota_exceeded');
  assert.match((await fault)[0].message, /quota_exceeded/); assert.equal(c.api.closed, true);
});

test('connection timeout and repeated stop settle pending handshakes cleanly', async () => {
  const a = fixture({ connectTimeoutMs: 10 }); await assert.rejects(a.api.connect(), /초과/); assert.equal(a.api.closed, true);
  const b = await connected();
  b.api.clearInput(); b.api.clearInput(); b.sockets[2].event('session_started');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(b.api.ready, true); assert.equal(b.api.closed, false); b.api.close();
});
