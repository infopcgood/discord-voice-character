import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ListeningStore, restoreListening, saveListening } from '../src/listening.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-listening-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new ListeningStore(directory) };
}
function session(owner = '1') {
  return { owner, listeners: new Set(), channel: { members: new Map([
    ['1', { user: { bot: false } }], ['2', { user: { bot: false } }], ['3', { user: { bot: true } }],
  ]) }, setListening(id, enabled) { if (enabled) this.listeners.add(id); else this.listeners.delete(id); } };
}

test('on and off choices survive a fresh store and stay isolated by user and guild', t => {
  const { directory, store } = fixture(t);
  assert.equal(store.get('100', '1'), undefined);
  store.set('100', '1', false); store.set('100', '2', true); store.set('200', '1', true);
  const restarted = new ListeningStore(directory);
  assert.equal(restarted.get('100', '1'), false); assert.equal(restarted.get('100', '2'), true);
  assert.equal(restarted.get('200', '1'), true); assert.equal(restarted.get('200', '2'), undefined);
  restarted.set('100', '2', false);
  assert.deepEqual(JSON.parse(fs.readFileSync(restarted.file('100'), 'utf8')), { '1': false, '2': false });
  assert.equal(fs.existsSync(`${restarted.file('100')}.tmp`), false);
});

test('restoration respects explicit owner opt-out, bots, channel presence and the current allowlist', t => {
  const { store } = fixture(t); const voice = session();
  store.set('100', '1', false); store.set('100', '2', true); store.set('100', '3', true); store.set('100', '4', true);
  voice.listeners.add('4'); // A saved/previous listener who is outside the bot's channel.
  restoreListening(voice, store, '100'); assert.deepEqual([...voice.listeners], ['2']);
  restoreListening(voice, store, '100', new Set(['1'])); assert.deepEqual([...voice.listeners], []);
  restoreListening(voice, store, '100', new Set(['2'])); assert.deepEqual([...voice.listeners], ['2']);
});

test('leaving, moving away and returning change active reception without erasing the preference', t => {
  const { store } = fixture(t); const voice = session();
  store.set('100', '2', true); restoreListening(voice, store, '100');
  const saved = fs.readFileSync(store.file('100'), 'utf8');
  const member = voice.channel.members.get('2'); voice.channel.members.delete('2');
  restoreListening(voice, store, '100', new Set(), '2'); assert.equal(voice.listeners.has('2'), false);
  voice.channel.members.set('2', member);
  restoreListening(voice, store, '100', new Set(), '2'); assert.equal(voice.listeners.has('2'), true);
  assert.equal(fs.readFileSync(store.file('100'), 'utf8'), saved);
  saveListening(voice, store, '100', '2', false);
  restoreListening(voice, store, '100'); assert.equal(voice.listeners.has('2'), false);
});

test('users without a saved choice keep owner-only defaults, and saved off wins on later joins', t => {
  const { directory, store } = fixture(t); const first = session();
  restoreListening(first, store, '100'); assert.deepEqual([...first.listeners], ['1']);
  saveListening(first, store, '100', '1', false); saveListening(first, store, '100', '2', true);
  const afterRestart = session(); restoreListening(afterRestart, new ListeningStore(directory), '100');
  assert.deepEqual([...afterRestart.listeners], ['2']);
  const otherGuild = session(); restoreListening(otherGuild, new ListeningStore(directory), '200');
  assert.deepEqual([...otherGuild.listeners], ['1']);
});

test('failed saves never enable new reception and opt-out still stops current reception', t => {
  const { store } = fixture(t); const voice = session();
  saveListening(voice, store, '100', '2', true);
  fs.mkdirSync(`${store.file('100')}.tmp`); // Reproduce an unwritable temp-file destination.
  assert.throws(() => saveListening(voice, store, '100', '2', false), /현재 음성 수신은 껐지만/);
  assert.equal(voice.listeners.has('2'), false); assert.equal(store.get('100', '2'), true);
  assert.equal(JSON.parse(fs.readFileSync(store.file('100'), 'utf8'))['2'], true);
  assert.throws(() => saveListening(voice, store, '100', '1', true), /저장하지 못/);
  assert.equal(voice.listeners.has('1'), false); assert.equal(store.get('100', '1'), undefined);
});

test('invalid IDs, nonboolean choices and corrupt files fail without resetting saved choices', t => {
  const { directory, store } = fixture(t);
  assert.throws(() => store.get('../100', '1'), /Invalid/);
  assert.throws(() => store.set('100', '../1', true), /Invalid/);
  assert.throws(() => store.set('100', '1', 'false'), /켜기/);
  for (const data of ['null', '[]', '{"1":"false"}', '{"__proto__":true}', '{broken']) {
    fs.writeFileSync(store.file('100'), data);
    assert.throws(() => restoreListening(session(), new ListeningStore(directory), '100'));
    assert.equal(fs.readFileSync(store.file('100'), 'utf8'), data);
  }
});
