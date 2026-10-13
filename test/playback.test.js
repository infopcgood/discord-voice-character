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
      assert.ok(resource.playbackDuration >= (Math.ceil(samples / 480) + 1) * 20);
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
  const source = new SpeechPackets(pcm, 1); const packets = []; const frames = [];
  const encode = source.codec.encode.bind(source.codec);
  source.codec.encode = (frame, samples) => { frames.push(Buffer.from(frame)); return encode(frame, samples); };
  for await (const packet of source) packets.push(packet);
  assert.equal(packets.length, 5);
  // Opus is lossy; verify exact stereo/resampling invariants before compression.
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 4) assert.equal(frame.readInt16LE(i), frame.readInt16LE(i + 2));
  }
  assert.ok(frames.at(-2).subarray(8).every(value => value === 0));
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try {
    const decoded = Buffer.concat(packets.map(packet => Buffer.from(decoder.decode(packet))));
    assert.equal(decoded.length, 3840 * 5); assert.ok(decoded.some(value => value !== 0));
  } finally { decoder.delete(); }
  const muted = new SpeechPackets(Buffer.concat(Array(10).fill(pcm)), 1); const volumeFrames = [];
  const encodeMuted = muted.codec.encode.bind(muted.codec);
  muted.codec.encode = (frame, samples) => { volumeFrames.push(Buffer.from(frame)); return encodeMuted(frame, samples); };
  for await (const _packet of muted) muted.setVolume(0);
  assert.ok(volumeFrames[0].some(value => value !== 0));
  // Readable may prefetch a packet; the remaining audio must honor live mute.
  assert.ok(volumeFrames.at(-1).every(value => value === 0));
  assert.throws(() => new SpeechPackets(Buffer.alloc(1)), /Invalid/);
});

test('the encoded drain frame carries the delayed tail of a frame-aligned response', async () => {
  const pcm = Buffer.alloc(960 * 10);
  // Only the last 5 ms contain speech: the encoder must carry it into the drain.
  for (let i = pcm.length - 240; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(12000 * Math.sin(i / 2 * 2 * Math.PI * 440 / 24000)), i);
  const packets = []; for await (const packet of new SpeechPackets(pcm)) packets.push(packet);
  assert.equal(packets.length, 11);
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try {
    const frames = packets.map(packet => Buffer.from(decoder.decode(packet)));
    let peak = 0;
    for (let i = 0; i < frames.at(-1).length; i += 2) peak = Math.max(peak, Math.abs(frames.at(-1).readInt16LE(i)));
    assert.ok(peak > 1000, `The drain must contain the audible final samples (peak ${peak})`);
  } finally { decoder.delete(); }
});
