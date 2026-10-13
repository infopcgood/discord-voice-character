import test from 'node:test';
import assert from 'node:assert/strict';
import { TextSession, formatChat, splitDiscordText, publishCommandInput, messagePayload, textSessionKey, closeTextSessions } from '../src/text-chat.js';
import { formatAction } from '../src/actions.js';
import { serviceConfig } from '../src/services.js';

function fixture(overrides = {}) {
  const calls = []; const posted = [];
  const session = new TextSession({ guildId: 'guild-1', channelId: 'channel-1', owner: 'user-1',
    settings: { persona: 'Be the character.', model: 'local/model' }, services: serviceConfig(),
    llm: { async *stream(messages) { calls.push(structuredClone(messages)); yield '안녕. '; yield '반가워!'; } }, ...overrides });
  const respond = input => session.respond(input, { publishInput: async () => posted.push(['input', input]), publishReply: async text => posted.push(['reply', text]) });
  return { session, calls, posted, respond };
}

test('text chat identifies the speaker and remembers published replies and actions without voice', async () => {
  const f = fixture();
  try {
    const first = formatChat('안녕하세요', '민수');
    await f.respond(first);
    assert.deepEqual(f.calls[0], [{ role: 'system', content: 'Be the character.' }, { role: 'user', content: first }]);
    assert.deepEqual(f.posted, [['input', first], ['reply', '안녕. 반가워!']]);
    const action = formatAction('손을 흔든다', '지민');
    await f.respond(action);
    assert.deepEqual(f.calls[1].slice(0, 2), f.calls[0]);
    assert.equal(f.calls[1][2].content, '안녕. 반가워!');
    assert.equal(f.calls[1].at(-1).content, action);
    assert.equal(f.session.history.length, 4);
  } finally { f.session.close(); }
  for (const value of ['', ' \n ', null, 'x'.repeat(2001)]) assert.throws(() => formatChat(value, '민수'), /1~2000/);
});

test('every initial and follow-up input message honors visibility and disables mentions', async () => {
  for (const visibility of ['public', 'private']) {
    for (const action of ['chat', 'act']) {
      const sent = [];
      const interaction = { reply: async value => sent.push(value), followUp: async value => sent.push(value) };
      const text = '@everyone ' + 'x'.repeat(1990);
      await publishCommandInput(interaction, action, text, '*민수*', visibility);
      assert.ok(sent.length > 1);
      assert.ok(sent.map(item => item.content).join('').endsWith(text));
      assert.ok(sent[0].content.includes('\\*민수\\*'));
      for (const item of [...sent, messagePayload('answer @everyone', visibility)]) {
        assert.ok(item.content.length <= 2000);
        assert.deepEqual(item.allowedMentions, { parse: [] });
        assert.equal(Boolean(item.flags & 64), visibility === 'private');
      }
    }
  }
});

test('reply splitting preserves Unicode, whitespace, and the full published answer in history', async () => {
  const answer = 'x'.repeat(1999) + '😀\n' + 'y'.repeat(2400);
  const parts = splitDiscordText(answer);
  assert.equal(parts.join(''), answer);
  assert.ok(parts.every(part => part.length <= 2000 && !/[\uD800-\uDBFF]$/.test(part)));
  const f = fixture({ llm: { async *stream() { yield answer; } } });
  try {
    await f.respond('Hello');
    assert.deepEqual(f.posted.filter(([kind]) => kind === 'reply').map(([,text]) => text), parts);
    assert.equal(f.session.history.at(-1).content, answer);
    assert.equal(f.session.history.filter(message => message.role === 'assistant').length, 1);
  } finally { f.session.close(); }
});

test('public memory is channel-scoped; private memory is also user-scoped', async () => {
  const publicKey = textSessionKey('g1', 'c1', 'public', 'u1');
  assert.equal(publicKey, textSessionKey('g1', 'c1', 'public', 'u2'));
  const keys = [publicKey, textSessionKey('g1', 'c2', 'public', 'u1'), textSessionKey('g2', 'c1', 'public', 'u1'),
    textSessionKey('g1', 'c1', 'private', 'u1'), textSessionKey('g1', 'c1', 'private', 'u2')];
  assert.equal(new Set(keys).size, keys.length);
  const sessions = new Map(keys.map(key => [key, fixture()]));
  try {
    let i = 0;
    for (const f of sessions.values()) await f.respond('Secret ' + i++);
    i = 0;
    for (const f of sessions.values()) {
      assert.equal(f.calls[0].filter(message => message.role === 'user').length, 1);
      assert.equal(f.calls[0].at(-1).content, 'Secret ' + i++);
    }
  } finally { for (const f of sessions.values()) f.session.close(); }
});

test('busy sessions reject a second input before posting it; stop suppresses late output', async () => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  let signal;
  const f = fixture({ llm: { async *stream(_messages, current) { signal = current; await wait; yield 'Late answer'; } } });
  try {
    const pending = f.respond('First');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.respond('Second'), /생성 중/);
    assert.deepEqual(f.posted, [['input', 'First']]);
    f.session.stop(); assert.equal(signal.aborted, true);
    release(); await pending;
    assert.equal(f.session.busy, false);
    assert.deepEqual(f.session.history, [{ role: 'user', content: 'First' }]);
    assert.equal(f.posted.filter(([kind]) => kind === 'reply').length, 0);
  } finally { release(); f.session.close(); }
});

test('closing a session cancels pending work and clears memory without a late commit', async () => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ llm: { async *stream() { await wait; yield 'Old private answer'; } } });
  const pending = f.respond('Private text');
  await new Promise(resolve => setImmediate(resolve));
  f.session.close(); release(); await pending;
  assert.deepEqual(f.session.history, []);
  assert.equal(f.posted.filter(([kind]) => kind === 'reply').length, 0);
  await assert.rejects(f.respond('New'), /종료/);
});

test('failed input publication makes no LLM request or history change', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.session.respond('Hello', { publishInput: async () => { throw new Error('Discord failure'); }, publishReply: async () => {} }), /Discord failure/);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.session.history, []); assert.equal(f.session.busy, false);
  } finally { f.session.close(); }
});

test('visibility changes clear every text scope in one guild and cancel pending private replies', async () => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const privateChat = fixture({ llm: { async *stream() { await wait; yield 'Private answer'; } } });
  const publicChat = fixture({ channelId: 'channel-2' });
  const otherGuild = fixture({ guildId: 'guild-2' });
  const sessions = new Map([['private', privateChat.session], ['public', publicChat.session], ['other', otherGuild.session]]);
  try {
    await publicChat.respond('Public history'); await otherGuild.respond('Other history');
    const pending = privateChat.respond('Private history');
    await new Promise(resolve => setImmediate(resolve));
    closeTextSessions(sessions, 'guild-1'); release(); await pending;
    assert.deepEqual([...sessions.keys()], ['other']);
    assert.deepEqual(privateChat.session.history, []); assert.deepEqual(publicChat.session.history, []);
    assert.equal(privateChat.posted.filter(([kind]) => kind === 'reply').length, 0);
    assert.equal(otherGuild.session.closed, false); assert.equal(otherGuild.session.history.length, 2);
    closeTextSessions(sessions, 'guild-2', 'different-channel'); assert.equal(sessions.size, 1);
    closeTextSessions(sessions, 'guild-2', 'channel-1'); assert.equal(sessions.size, 0);
  } finally { release(); for (const f of [privateChat, publicChat, otherGuild]) f.session.close(); }
});

test('failed response publication retains only the part successfully posted', async () => {
  const f = fixture({ llm: { async *stream() { yield 'x'.repeat(2500); } } });
  let posted = 0;
  try {
    await assert.rejects(f.session.respond('Hello', { publishInput: async () => {}, publishReply: async () => {
      if (++posted === 2) throw new Error('Discord failure');
    } }), /Discord failure/);
    assert.equal(f.session.history.at(-1).content, 'x'.repeat(2000));
    assert.equal(f.session.busy, false);
  } finally { f.session.close(); }
});

test('text history preserves system prompt, batches trimming, and retains invalid-request history', async () => {
  const f = fixture({ settings: { persona: 'persona', model: 'local/model' }, services: { ...serviceConfig(), historyChars: 1000 } });
  f.session.history = Array.from({length:12}, (_,i) => [
    { role: 'user', content: `User ${i}`.padEnd(40,'.') }, { role: 'assistant', content: `Reply ${i}`.padEnd(40,'.') }
  ]).flat();
  try {
    await f.respond('x'.repeat(50));
    assert.equal(f.calls[0][0].content, 'persona');
    assert.ok(f.calls[0].reduce((sum,m) => sum + m.content.length, 0) <= 750);
    const history = structuredClone(f.session.history);
    await assert.rejects(f.respond('x'.repeat(1000)), /HISTORY_MAX_CHARS/);
    assert.deepEqual(f.session.history, history);
    assert.equal(f.calls.length, 1);
  } finally { f.session.close(); }
});
