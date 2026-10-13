import { Readable } from 'node:stream';
import OpusScript from 'opusscript';

// Discord receives complete Opus packets. No Transform/pipeline owns the encoder,
// so destroying a resource on stop cannot prematurely close an Encoder stream.
export class SpeechPackets extends Readable {
  constructor(pcm, volume = 1) {
    super({ objectMode: true, highWaterMark: 1 });
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2) throw new Error('Invalid 24 kHz PCM segment');
    this.pcm = pcm; this.offset = 0; this.previous = 0;
    this.setVolume(volume);
    this.codec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  }
  setVolume(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 2) throw new Error('Invalid playback volume');
    this.volume = volume;
  }
  _read() {
    if (this.offset >= this.pcm.length) { this.push(null); return; }
    try {
      const frame = Buffer.alloc(3840); // 20 ms, 48 kHz stereo; zero-pad the final frame.
      const scaled = sample => Math.max(-32768, Math.min(32767, Math.round(sample * this.volume)));
      let index = 0;
      while (index < frame.length && this.offset < this.pcm.length) {
        const sample = this.pcm.readInt16LE(this.offset); this.offset += 2;
        const midpoint = scaled((this.previous + sample) / 2); const current = scaled(sample);
        frame.writeInt16LE(midpoint, index); frame.writeInt16LE(midpoint, index + 2);
        frame.writeInt16LE(current, index + 4); frame.writeInt16LE(current, index + 6);
        this.previous = sample; index += 8;
      }
      this.push(Buffer.from(this.codec.encode(frame, 960)));
    } catch (error) { this.destroy(error); }
  }
  _destroy(error, callback) {
    try { this.codec?.delete(); } catch (cleanupError) { error ||= cleanupError; }
    this.codec = null; this.pcm = null;
    callback(error);
  }
}
