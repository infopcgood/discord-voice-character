import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import OpusScript from 'opusscript';
import { Bridge } from '../src/bridge.js';
import { VoiceMixer, FRAME_BYTES } from '../src/mixer.js';
import { validateSettings, parseGuildIds, acceptsGuild } from '../src/config.js';
import { registerGuild } from '../src/registration.js';

class MockApi extends EventEmitter {
  ready = false; generating = false; closed = false; frames = []; cleared = 0; requests = 0; stops = [];
  async connect() { this.ready = true; }
  append(pcm) { this.frames.push(pcm); }
  clearInput() { this.cleared++; }
  respond() { assert.equal(this.generating, false); this.generating = true; this.requests++; }
  stop(ms) { this.stops.push(ms); } // Cancellation is asynchronous; done must arrive separately.
  finish() { this.generating = false; this.emit('done'); }
  async updateListening(next) { this.updated = next; }
  close() { this.closed = true; this.ready = false; }
}
class MockPlayer extends EventEmitter {
  state = { status: 'idle' };
  play(resource) { this.resource = resource; this.state = { status: 'playing' }; }
  stop() { const active = this.state.status !== 'idle'; this.state = { status: 'idle' }; if (active) this.emit('idle'); }
}
function fixture(overrides = {}) {
  const connection = new EventEmitter(); connection.state = { status: 'ready' }; connection.subscribe = () => {};
  connection.destroy = () => { connection.state.status = 'destroyed'; connection.emit('destroyed'); };
  const sources = new Map();
  connection.receiver = { speaking: new EventEmitter(), subscribe(id, options) {
    const source = new PassThrough({ objectMode: true }); sources.set(id, source); source.options = options; return source;
  } };
  const users = new Map([['1', { user: { bot: false } }], ['2', { user: { bot: false } }], ['3', { user: { bot: true } }]]);
  const api = new MockApi(); const player = new MockPlayer();
  const settings = validateSettings({ persona: 'hi', voice: 'marin', speed: 1, volume: 0.8, ...overrides });
  const bridge = new Bridge({ connection, channel: { members: users }, owner: '1', settings, notify() {}, onClose() {}, player, apiFactory: () => api });
  return { bridge, api, player, sources, connection };
}
function frame(value = 1000) { const pcm = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i); return pcm; }
function opusPacket() {
  const codec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try { return Buffer.from(codec.encode(Buffer.alloc(3840), 960)); } finally { codec.delete(); }
}

test('mixer aligns two voices on one clock and prevents clipping', () => {
  const mixer = new VoiceMixer(); mixer.push('a', frame(1000)); mixer.push('b', frame(2000));
  assert.equal(mixer.tick().pcm.readInt16LE(0), Math.round(3000 / Math.sqrt(2)));
  assert.equal(mixer.tick().pcm.readInt16LE(0), 0); // Empty queues produce timed silence.
  mixer.push('a', frame(32000)); mixer.push('b', frame(32000));
  assert.equal(mixer.tick().pcm.readInt16LE(0), 32767);
});
test('overlap disabled retains first speaker then hands off without replaying dropped speech', () => {
  const mixer = new VoiceMixer({ overlap: false });
  mixer.push('a', frame(1000)); assert.equal(mixer.tick().pcm.readInt16LE(0), 1000);
  mixer.push('a', frame(1000)); mixer.push('b', frame(2000));
  assert.equal(mixer.tick().pcm.readInt16LE(0), 1000);
  for (let i = 0; i < 9; i++) { mixer.push('b', frame(2000)); assert.equal(mixer.tick().pcm.readInt16LE(0), 0); }
  mixer.push('b', frame(2000)); assert.equal(mixer.tick().pcm.readInt16LE(0), 2000);
  assert.equal(mixer.tick().pcm.readInt16LE(0), 0);
});
test('mixer carries incomplete frames, bounds backlog and purges users', () => {
  const mixer = new VoiceMixer({ maxFrames: 2 }); const pcm = frame(900);
  mixer.push('a', pcm.subarray(0, 13)); assert.equal(mixer.tick().active, false);
  mixer.push('a', pcm.subarray(13)); assert.equal(mixer.tick().pcm.readInt16LE(0), 900);
  for (const value of [1000, 2000, 3000]) mixer.push('a', frame(value));
  assert.equal(mixer.tick().pcm.readInt16LE(0), 2000);
  mixer.remove('a'); assert.equal(mixer.tick().active, false);
});
test('opt-in streams decode actual Opus and remain subscribed during playback', async () => {
  const { bridge, api, sources } = fixture();
  try {
    await bridge.start(); assert.equal(sources.size, 1);
    bridge.capture('2'); bridge.setListening('3', true); assert.equal(sources.size, 1);
    bridge.setListening('2', true); assert.equal(sources.size, 2);
    api.generating = true;
    sources.get('1').write(opusPacket()); sources.get('2').write(opusPacket());
    assert.equal(bridge.mixer.tracks.size, 2); bridge.tick();
    assert.equal(api.frames.at(-1).length, FRAME_BYTES);
    bridge.setListening('2', false);
    assert.equal(sources.get('2').destroyed, true); assert.equal(bridge.mixer.tracks.has('2'), false);
  } finally { bridge.close(); }
});
test('server commit schedules one reply; silence ticks cannot create unsolicited replies', async () => {
  const { bridge, api } = fixture();
  try {
    await bridge.start(); bridge.tick(); bridge.tick(); assert.equal(api.requests, 0);
    api.emit('speechStart'); api.emit('speechStop'); api.emit('committed');
    assert.equal(api.requests, 1); assert.equal(bridge.pendingTurn, false);
  } finally { bridge.close(); }
});
test('automatic interruption clears playback but preserves new input and waits for cancellation acknowledgement', async () => {
  const { bridge, api, player } = fixture();
  try {
    await bridge.start(); api.emit('committed'); assert.equal(api.requests, 1);
    player.state = { status: 'playing' }; bridge.resource = { playbackDuration: 500 };
    bridge.mixer.push('1', frame(1000)); api.emit('speechStart');
    assert.deepEqual(api.stops, [400]); assert.equal(player.state.status, 'idle');
    assert.equal(api.cleared, 0); bridge.tick(); assert.equal(api.frames.at(-1).readInt16LE(0), 1000);
    api.emit('speechStop'); api.emit('committed'); assert.equal(api.requests, 1);
    api.finish(); assert.equal(api.requests, 2);
  } finally { bridge.close(); }
});
test('interruption still stops buffered playback after generation has completed', async () => {
  const { bridge, api, player } = fixture();
  try {
    await bridge.start(); player.state = { status: 'playing' }; bridge.resource = { playbackDuration: 800 };
    api.emit('speechStart'); assert.deepEqual(api.stops, [700]); assert.equal(player.state.status, 'idle');
  } finally { bridge.close(); }
});
test('disabled interruption drops playback-time audio without a delayed replay', async () => {
  const { bridge, api } = fixture({ interrupt: false });
  try {
    await bridge.start(); api.generating = true; bridge.mixer.push('1', frame(1000)); bridge.tick();
    assert.equal(api.frames.at(-1).readInt16LE(0), 0);
    api.emit('speechStart'); assert.equal(api.stops.length, 0);
    api.finish(); bridge.tick(); assert.equal(api.frames.at(-1).readInt16LE(0), 0);
  } finally { bridge.close(); }
});
test('hot listening settings preserve the connection and conversation', async () => {
  const { bridge, api } = fixture();
  try {
    await bridge.start(); const next = { ...bridge.settings, silenceSeconds: 2.2, overlap: false, interrupt: false };
    await bridge.updateListening(next);
    assert.equal(bridge.api, api); assert.equal(api.closed, false); assert.equal(bridge.settings.silenceSeconds, 2.2);
    assert.equal(bridge.mixer.overlap, false);
  } finally { bridge.close(); }
});
test('failed model change leaves prior model session usable', async () => {
  const { bridge, api } = fixture();
  try {
    await bridge.start(); const nextApi = new MockApi(); nextApi.connect = async () => { throw new Error('model unavailable'); };
    bridge.apiFactory = () => nextApi;
    await assert.rejects(bridge.restart({ ...bridge.settings, model: 'unavailable-model' }), /unavailable/);
    assert.equal(bridge.api, api); assert.equal(api.closed, false); assert.equal(nextApi.closed, true);
    assert.equal(bridge.changing, false); assert.notEqual(bridge.settings.model, 'unavailable-model');
  } finally { bridge.close(); }
});
test('successful model change retires old API and keeps listener subscriptions', async () => {
  const { bridge, api, sources } = fixture();
  try {
    await bridge.start(); const nextApi = new MockApi(); let chosen;
    bridge.apiFactory = options => { chosen = options.model; return nextApi; };
    await bridge.restart({ ...bridge.settings, model: 'gpt-realtime' });
    assert.equal(chosen, 'gpt-realtime'); assert.equal(api.closed, true); assert.equal(bridge.api, nextApi);
    assert.equal(sources.get('1').destroyed, false);
  } finally { bridge.close(); }
});
test('independent servers never share voices, pending turns, settings or lifecycle', async () => {
  const a = fixture(); const b = fixture({ model: 'gpt-realtime', overlap: false });
  try {
    await a.bridge.start(); await b.bridge.start();
    a.bridge.mixer.push('1', frame(3000)); a.bridge.tick(); b.bridge.tick();
    assert.equal(a.api.frames.at(-1).readInt16LE(0), 3000); assert.equal(b.api.frames.at(-1).readInt16LE(0), 0);
    a.api.emit('committed'); assert.equal(a.api.requests, 1); assert.equal(b.api.requests, 0);
    a.bridge.close(); assert.equal(b.api.closed, false); assert.equal(b.bridge.settings.model, 'gpt-realtime');
  } finally { a.bridge.close(); b.bridge.close(); }
});
test('manual stop drops pending input and late commit cannot restart the reply', async () => {
  const { bridge, api } = fixture();
  try {
    await bridge.start(); api.emit('committed'); bridge.stop(); api.emit('committed'); api.finish();
    assert.equal(api.requests, 1); assert.equal(api.cleared, 1);
    api.emit('speechStart'); api.emit('speechStop'); api.emit('committed'); assert.equal(api.requests, 2);
  } finally { bridge.close(); }
});
test('closing releases timers, all receive streams, API and voice connection', async () => {
  const { bridge, api, connection, sources } = fixture();
  await bridge.start(); bridge.setListening('2', true); bridge.close(); bridge.close();
  assert.equal(api.closed, true); for (const source of sources.values()) assert.equal(source.destroyed, true);
  assert.equal(connection.state.status, 'destroyed'); assert.equal(connection.receiver.speaking.listenerCount('start'), 0);
});
test('guild configuration accepts multiple IDs, all-server mode and legacy environments', () => {
  assert.deepEqual([...parseGuildIds({ DISCORD_GUILD_IDS: '123,456,123' })], ['123', '456']);
  assert.equal(acceptsGuild('456', parseGuildIds({ DISCORD_GUILD_IDS: '123,456' })), true);
  assert.equal(acceptsGuild('789', parseGuildIds({ DISCORD_GUILD_IDS: '123,456' })), false);
  assert.equal(acceptsGuild('789', parseGuildIds({ DISCORD_GUILD_IDS: '*', DISCORD_GUILD_ID: '123' })), true);
  assert.equal(parseGuildIds({ DISCORD_GUILD_IDS: '', DISCORD_GUILD_ID: '123' }).size, 0);
  assert.deepEqual([...parseGuildIds({ DISCORD_GUILD_ID: '123' })], ['123']);
  assert.throws(() => parseGuildIds({ DISCORD_GUILD_IDS: 'not-an-id' }));
});
test('command registration targets each server and preserves unrelated commands', async () => {
  const calls = []; const rest = { async post(route, data) { calls.push({ route, data }); } };
  await registerGuild(rest, '111', '222'); await registerGuild(rest, '111', '333');
  assert.match(calls[0].route, /guilds\/222\/commands$/); assert.match(calls[1].route, /guilds\/333\/commands$/);
  assert.equal(calls[0].data.body.name, 'ai');
});
test('v1 settings migrate and new setting ranges are enforced', () => {
  const base = { persona: 'original', voice: 'cedar', speed: 1, volume: 0.8 };
  const migrated = validateSettings(base);
  assert.equal(migrated.persona, 'original'); assert.equal(migrated.silenceSeconds, 0.85);
  assert.equal(migrated.interrupt, true); assert.equal(migrated.overlap, true);
  for (const patch of [{ silenceSeconds: 0 }, { silenceSeconds: 6 }, { overlap: 'true' }, { interrupt: 1 }, { model: '' }, { vadThreshold: 2 }]) assert.throws(() => validateSettings({ ...base, ...patch }));
});

