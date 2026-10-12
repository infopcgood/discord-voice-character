// Discord packets decode to mono PCM16 at 24 kHz. One clock tick is 20 ms.
export const FRAME_BYTES = 960;
export class VoiceMixer {
  constructor({ overlap = true, maxFrames = 10 } = {}) {
    this.overlap = overlap; this.maxFrames = maxFrames; this.tracks = new Map();
    this.primary = null; this.primaryQuiet = 0; this.sequence = 0;
  }
  push(id, pcm) {
    let track = this.tracks.get(id);
    if (!track) { track = { frames: [], tail: Buffer.alloc(0), order: this.sequence++ }; this.tracks.set(id, track); }
    const data = Buffer.concat([track.tail, pcm]);
    let offset = 0;
    for (; offset + FRAME_BYTES <= data.length; offset += FRAME_BYTES) track.frames.push(Buffer.from(data.subarray(offset, offset + FRAME_BYTES)));
    track.tail = Buffer.from(data.subarray(offset));
    // Drop oldest delayed packets instead of creating unbounded conversational lag.
    if (track.frames.length > this.maxFrames) track.frames.splice(0, track.frames.length - this.maxFrames);
  }
  remove(id) {
    this.tracks.delete(id);
    if (this.primary === id) { this.primary = null; this.primaryQuiet = 0; }
  }
  reset() { this.tracks.clear(); this.primary = null; this.primaryQuiet = 0; }
  tick() {
    const frames = [];
    for (const [id, track] of this.tracks) {
      const frame = track.frames.shift();
      if (!frame) continue;
      let energy = 0;
      for (let i = 0; i < frame.length; i += 2) energy += frame.readInt16LE(i) ** 2;
      frames.push({ id, frame, active: Math.sqrt(energy / 480) >= 120, order: track.order });
    }
    const active = frames.filter(frame => frame.active);
    if (!active.some(frame => frame.id === this.primary)) this.primaryQuiet++;
    else this.primaryQuiet = 0;
    // A 200 ms hangover keeps the first speaker through short packet gaps.
    if (this.primary === null || this.primaryQuiet >= 10) {
      this.primary = active.sort((a, b) => a.order - b.order)[0]?.id ?? null;
      this.primaryQuiet = 0;
    }
    const selected = this.overlap ? frames : frames.filter(frame => frame.id === this.primary);
    const out = Buffer.alloc(FRAME_BYTES);
    // Normalize simultaneous signals and saturate to prevent integer wraparound.
    const gain = 1 / Math.sqrt(Math.max(1, selected.filter(frame => frame.active).length));
    for (let i = 0; i < FRAME_BYTES; i += 2) {
      const sample = Math.round(selected.reduce((sum, source) => sum + source.frame.readInt16LE(i), 0) * gain);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
    }
    return { pcm: out, active: selected.some(frame => frame.active) };
  }
}
