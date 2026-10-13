import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import OpusScript from 'opusscript';
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType, entersState } from '@discordjs/voice';
import { SpeechPackets } from '../src/playback.js';

function player() { return createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }); }

test('real Discord player naturally drains repeated short and partial-frame responses', { timeout: 10000 }, async () => {
  const audio = player(); const errors = []; audio.on('error', error => errors.push(error));
  try {
    for (const samples of [1, 479, 480, 481, 2401]) {
      const source = new SpeechPackets(Buffer.alloc(samples * 2), 0.8);
      const completion = finished(source);
      const resource = createAudioResource(source, { inputType: StreamType.Opus });
      assert.equal(resource.playStream, source); assert.equal(resource.edges.length, 0);
      audio.play(resource);
      await entersState(audio, AudioPlayerStatus.Playing, 3000);
      await entersState(audio, AudioPlayerStatus.Idle, 3000);
      await completion;
      assert.ok(resource.playbackDuration >= Math.ceil(samples / 480) * 20);
      assert.equal(source.codec, null);
    }
    assert.deepEqual(errors, []);
  } finally { audio.stop(true); }
});

test('real player stop during playback and before first frame releases the codec without stream errors', { timeout: 5000 }, async () => {
  const audio = player(); const errors = []; audio.on('error', error => errors.push(error));
  try {
    for (const beforeFirst of [true, false]) {
      const source = new SpeechPackets(Buffer.alloc(48000 * 5)); source.on('error', error => errors.push(error));
      const resource = createAudioResource(source, { inputType: StreamType.Opus });
      audio.play(resource);
      if (!beforeFirst) await entersState(audio, AudioPlayerStatus.Playing, 3000);
      const closed = once(source, 'close'); audio.stop(true); source.destroy(); await closed;
      assert.equal(source.codec, null); assert.equal(audio.state.status, AudioPlayerStatus.Idle);
    }
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(errors, []);
  } finally { audio.stop(true); }
});

test('direct packets preserve stereo duration, pad the tail, and apply live volume without a transform', async () => {
  const pcm = Buffer.alloc(960 * 3 + 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 2 * 2 * Math.PI * 440 / 24000)), i);
  const source = new SpeechPackets(pcm, 1); const packets = [];
  for await (const packet of source) packets.push(packet);
  assert.equal(packets.length, 4);
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try {
    const decoded = Buffer.concat(packets.map(packet => Buffer.from(decoder.decode(packet))));
    assert.equal(decoded.length, 3840 * 4); assert.ok(decoded.some(value => value !== 0));
    for (let i = 0; i < decoded.length; i += 4) assert.ok(Math.abs(decoded.readInt16LE(i) - decoded.readInt16LE(i + 2)) <= 1);
  } finally { decoder.delete(); }
  const muted = new SpeechPackets(pcm, 1); muted.setVolume(0);
  const silentPackets = []; for await (const packet of muted) silentPackets.push(packet);
  const silentDecoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try { for (const packet of silentPackets) assert.ok(Buffer.from(silentDecoder.decode(packet)).every(value => value === 0)); }
  finally { silentDecoder.delete(); }
  assert.throws(() => new SpeechPackets(Buffer.alloc(1)), /Invalid/);
});
