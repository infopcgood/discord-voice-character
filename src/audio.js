import { Transform } from 'node:stream';

// Stateful 2x linear interpolation: 24 kHz mono PCM16 -> 48 kHz stereo PCM16.
// Carries partial samples across WebSocket chunks; never treats chunks as frames.
export class DiscordPCM extends Transform {
  constructor() { super(); this.tail = Buffer.alloc(0); this.previous = null; }
  _transform(chunk, encoding, done) {
    const input = Buffer.concat([this.tail, chunk]);
    const length = input.length - input.length % 2;
    this.tail = Buffer.from(input.subarray(length));
    const out = Buffer.alloc(length * 4);
    let offset = 0;
    for (let i = 0; i < length; i += 2) {
      const sample = input.readInt16LE(i);
      const mid = this.previous === null ? sample : Math.round((this.previous + sample) / 2);
      for (const value of [mid, sample]) {
        out.writeInt16LE(value, offset);
        out.writeInt16LE(value, offset + 2);
        offset += 4;
      }
      this.previous = sample;
    }
    done(null, out);
  }
  _flush(done) { done(this.tail.length ? new Error('Incomplete PCM sample') : null); }
}

export function turnDetection(settings) {
  return { type: 'server_vad', threshold: settings.vadThreshold ?? 0.5, prefix_padding_ms: 300,
    silence_duration_ms: Math.round((settings.silenceSeconds ?? 0.85) * 1000),
    // The bridge schedules replies after commit and handles cancellation itself.
    create_response: false, interrupt_response: false };
}
export function sessionSettings(settings, model = settings.model) {
  return {
    type: 'realtime', model,
    instructions: settings.persona,
    output_modalities: ['audio'],
    max_output_tokens: 1200,
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: turnDetection(settings) },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice: settings.voice, speed: settings.speed },
    },
  };
}
