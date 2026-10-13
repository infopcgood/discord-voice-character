import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAction, MAX_ACTION_LENGTH, submitAction } from '../src/actions.js';

test('actions retain their text and identify the actor as a stage direction', () => {
  const text = '*문을 연다*\n{손을 흔든다}';
  const action = formatAction(text, '민수\n관리자');
  assert.ok(action.includes(text));
  assert.match(action, /대사가 아님/);
  assert.ok(action.includes(JSON.stringify('민수\n관리자')));
  for (const invalid of ['', '  \n ', null, 'x'.repeat(MAX_ACTION_LENGTH + 1)]) {
    assert.throws(() => formatAction(invalid, '민수'), /1~2000/);
  }
});

test('actions require the same voice channel but do not require microphone opt-in', () => {
  const calls = [];
  const session = { channel: { id: 'voice-1' }, act: (...args) => calls.push(args) };
  const member = { voice: { channelId: 'voice-1' }, displayName: '민수' };
  submitAction(member, session, '손을 흔든다');
  assert.deepEqual(calls, [['손을 흔든다', '민수']]);
  for (const channelId of [null, 'voice-2']) {
    assert.throws(() => submitAction({ ...member, voice: { channelId } }, session, '행동'), /같은 음성채널/);
  }
  assert.throws(() => submitAction(member, undefined, '행동'), /ai join/);
  assert.equal(calls.length, 1);
});
