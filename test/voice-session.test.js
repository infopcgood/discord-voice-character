import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { VoiceSession, takeSpeechChunk } from '../src/voice-session.js';
import { serviceConfig } from '../src/services.js';
import { formatAction } from '../src/actions.js';

class Recognition extends EventEmitter {
  async connect() { this.connected = true; }
  append(pcm) { this.input = pcm; }
  clearInput() { this.cleared = true; }
  async updateListening(settings) { this.settings = settings; }
  close() { this.closed = true; }
}
function fixture(overrides = {}) {
  const transcription = new Recognition(); const calls = []; const said = [];
  const llm = { async check() {}, async *stream(messages) { calls.push(structuredClone(messages)); yield 'First. '; yield 'Second.'; } };
  const speech = { async synthesize(text) { said.push(text); return Buffer.alloc(48000); } };
  const settings = { persona: 'Speak Korean as a librarian.', voice: 'default', speed: 1 };
  const session = new VoiceSession({ settings, services: serviceConfig(), transcription, llm, speech, ...overrides });
  return { session, transcription, calls, said };
}
async function reply(f, text = '안녕하세요') {
  f.transcription.emit('transcript', text); const done = once(f.session, 'done'); f.session.respond(); await done;
}

test('speech chunks are bounded, sentence-aware, and preserve split surrogate pairs', () => {
  assert.equal(takeSpeechChunk('Hello. More').text, 'Hello.');
  assert.equal(takeSpeechChunk('unfinished'), null);
  assert.equal(takeSpeechChunk('unfinished', true).text, 'unfinished');
  const text = 'a'.repeat(399) + '😀' + 'b'.repeat(100);
  const chunk = takeSpeechChunk(text); assert.equal(chunk.text.length, 399); assert.ok(chunk.rest.startsWith('😀'));
});

test('recognized text and persona go to Strata, complete speech segments are emitted, history commits after playback', async () => {
  const f = fixture(); await f.session.connect();
  try {
    let bytes = 0; f.session.on('audio', pcm => { bytes += pcm.length; });
    await reply(f);
    assert.deepEqual(f.calls[0], [{ role: 'system', content: 'Speak Korean as a librarian.' }, { role: 'user', content: '안녕하세요' }]);
    assert.deepEqual(f.said, ['First.', 'Second.']); assert.equal(bytes, 96000);
    assert.equal(f.session.history.length, 1);
    f.session.playbackFinished(); f.session.playbackFinished();
    assert.equal(f.session.history[1].content, 'First. Second.');
    await reply(f, '다음 질문'); assert.equal(f.calls[1][2].role, 'assistant');
  } finally { f.session.close(); }
});

test('typed actions are user turns, preserve conversation, and only the reply reaches TTS', async () => {
  const f = fixture(); await f.session.connect();
  try {
    await reply(f, '안녕'); f.session.playbackFinished();
    f.session.queueAction('손을 흔든다', '민수');
    const done = once(f.session, 'done'); f.session.respond(); await done;
    assert.deepEqual(f.calls[1].at(-1), { role: 'user', content: formatAction('손을 흔든다', '민수') });
    assert.equal(f.calls[1][0].content, f.session.settings.persona);
    assert.equal(f.calls[1][1].content, '안녕');
    assert.equal(f.calls[1][2].content, 'First. Second.');
    assert.deepEqual(f.said, ['First.', 'Second.', 'First.', 'Second.']);
    f.session.playbackFinished();
    await reply(f, '다음');
    assert.ok(f.calls[2].some(message => message.content === formatAction('손을 흔든다', '민수')));
  } finally { f.session.close(); }
});

test('invalid or oversized action queues preserve pending speech and do not fault the session', async () => {
  const f = fixture();
  assert.throws(() => f.session.queueAction('행동', '민수'), /준비/);
  await f.session.connect();
  try {
    f.transcription.emit('transcript', '진행 중인 대화');
    assert.throws(() => f.session.queueAction(' ', '민수'), /1~2000/);
    assert.throws(() => f.session.queueAction('x'.repeat(2001), '민수'), /1~2000/);
    f.session.services = { ...f.session.services, historyChars: 50 };
    assert.throws(() => f.session.queueAction('행동', '민수'), /공간/);
    assert.deepEqual(f.session.pending, ['진행 중인 대화']);
    assert.equal(f.session.ready, true);
    f.session.services = { ...f.session.services, historyChars: 24000 };
    for (let i = 0; i < 31; i++) f.session.queueAction('행동', '민수');
    assert.throws(() => f.session.queueAction('행동', '민수'), /공간/);
    f.session.clearInput(); assert.deepEqual(f.session.pending, []);
  } finally { f.session.close(); }
  assert.throws(() => f.session.queueAction('행동', '민수'), /준비/);
});

test('interruption after generation retains only completely heard speech chunks', async () => {
  const f = fixture(); await f.session.connect();
  try {
    await reply(f); f.session.stop(1200); f.session.playbackFinished();
    assert.equal(f.session.history[1].content, 'First.');
    await reply(f, 'Wait'); assert.equal(f.calls[1][2].content, 'First.');
  } finally { f.session.close(); }
});

test('cancellation before first output ignores a late generation and permits a new turn', async () => {
  let resolveOld; let call = 0;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const f = fixture({ llm: { async check() {}, async *stream() { if (++call === 1) yield await old; else yield 'New.'; } } });
  await f.session.connect();
  try {
    f.transcription.emit('transcript', 'Old request'); f.session.respond();
    const cancelled = once(f.session, 'done'); f.session.stop(0); await cancelled;
    await reply(f, 'New request'); resolveOld('Old.');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.said, ['New.']); assert.equal(f.session.generating, false);
    f.session.playbackFinished(); assert.equal(f.session.history.at(-1).content, 'New.');
    assert.ok(f.session.history.every(message => message.role !== 'assistant' || !message.content.includes('Old')));
  } finally { f.session.close(); }
});

test('cancelling active TTS aborts its signal and blocks late PCM', async () => {
  let release; const hold = new Promise(resolve => { release = resolve; }); let signal;
  const f = fixture({ speech: { async synthesize(_text, _settings, current) { signal = current; await hold; return Buffer.alloc(48000); } } });
  await f.session.connect(); let bytes = 0; f.session.on('audio', pcm => { bytes += pcm.length; });
  try {
    f.transcription.emit('transcript', 'Hello'); f.session.respond(); await new Promise(resolve => setImmediate(resolve));
    f.session.stop(10); release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true); assert.equal(bytes, 0);
    assert.equal(f.session.history.filter(message => message.role === 'assistant').length, 0);
  } finally { f.session.close(); }
});

test('manual stop clears pending recognition; listening changes preserve conversation', async () => {
  const f = fixture(); await f.session.connect();
  try {
    await reply(f); f.session.playbackFinished();
    f.transcription.emit('transcript', 'pending'); f.session.clearInput(); f.session.stop();
    assert.deepEqual(f.session.pending, []); assert.equal(f.transcription.cleared, true);
    const history = structuredClone(f.session.history);
    await f.session.updateListening({ ...f.session.settings, silenceSeconds: 2 });
    assert.deepEqual(f.session.history, history); assert.equal(f.transcription.settings.silenceSeconds, 2);
  } finally { f.session.close(); }
});

test('history budget drops old turns and never truncates the character prompt or newest user input', () => {
  const f = fixture({ services: { ...serviceConfig(), historyChars: 49 }, settings: { persona: 'persona' } });
  f.session.history = [{ role: 'user', content: 'x'.repeat(20) }, { role: 'assistant', content: 'y'.repeat(20) }];
  assert.deepEqual(f.session.messages('new'), [{ role: 'system', content: 'persona' }, { role: 'user', content: 'new' }]);
  assert.throws(() => f.session.messages('z'.repeat(50)), /HISTORY_MAX_CHARS/); f.session.close();
});

test('two guild sessions have independent history, cancellation, queues, and lifecycle', async () => {
  const a = fixture(); const b = fixture(); await a.session.connect(); await b.session.connect();
  try {
    await reply(a, 'A secret'); a.session.playbackFinished(); await reply(b, 'B secret');
    assert.ok(b.calls[0].every(message => !message.content.includes('A secret')));
    a.session.close(); assert.equal(b.session.ready, true); assert.equal(b.transcription.closed, undefined);
  } finally { a.session.close(); b.session.close(); }
});

test('unavailable local model fails before opening speech; generation errors are handled', async () => {
  const a = fixture({ llm: { async check() { throw new Error('model unavailable'); } } });
  await assert.rejects(a.session.connect(), /model unavailable/); assert.equal(a.transcription.connected, undefined); a.session.close();
  const b = fixture({ llm: { async check() {}, async *stream() { throw new Error('inference failed'); } } });
  await b.session.connect();
  try {
    const fault = once(b.session, 'fault'); b.transcription.emit('transcript', 'hi'); b.session.respond();
    assert.match((await fault)[0].message, /inference failed/); assert.equal(b.session.generating, false);
  } finally { b.session.close(); }
});

