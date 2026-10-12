import { EventEmitter } from 'node:events';
import { Transcription } from './transcription.js';
import { StrataClient } from './llm.js';
import { OpenAISpeech } from './speech.js';
import { serviceConfig } from './services.js';

// Bound each TTS request and start speaking once a sentence is available.
export function takeSpeechChunk(text, flush = false) {
  const boundary = /[.!?。！？\n](?:\s|$)/u.exec(text);
  let length = boundary ? boundary.index + boundary[0].length : 0;
  if (!length && text.length >= 400) {
    length = text.lastIndexOf(' ', 400);
    if (length < 100) length = 400;
  }
  if (!length && flush) length = text.length;
  if (!length) return null;
  length = Math.min(length, 400);
  if (/[\uD800-\uDBFF]/.test(text[length - 1])) length--;
  return { text: text.slice(0, length).trim(), rest: text.slice(length) };
}

export class VoiceSession extends EventEmitter {
  constructor({ key, model, settings, services = serviceConfig(), transcription, llm, speech }) {
    super();
    Object.assign(this, { settings, services });
    this.transcription = transcription || new Transcription({ key, settings, model: services.transcriptionModel, language: services.transcriptionLanguage });
    this.llm = llm || new StrataClient({ ...services, model });
    this.speaker = speech || new OpenAISpeech({ key, model: services.ttsModel });
    this.ready = false; this.closed = false; this.generating = false;
    this.history = []; this.pending = []; this.turn = null; this.connectionAbort = new AbortController();
    this.transcription.on('fault', error => { if (!this.closed) this.emit('fault', error); });
    for (const name of ['speechStart', 'speechStop']) this.transcription.on(name, () => { if (!this.closed) this.emit(name); });
    this.transcription.on('transcript', text => {
      if (!this.ready || this.closed) return;
      if (this.pending.length >= 32 || this.pending.join('\n').length + text.length > this.services.historyChars) {
        this.emit('fault', new Error('처리 대기 중인 발화가 너무 깁니다.')); return;
      }
      this.pending.push(text); this.emit('committed');
    });
  }
  async connect() {
    // Probe the selected local model before replacing an existing guild session.
    await this.llm.check(this.connectionAbort.signal);
    if (this.closed) throw new Error('연결이 종료되었습니다.');
    await this.transcription.connect();
    if (this.closed) throw new Error('연결이 종료되었습니다.');
    this.ready = true;
  }
  append(pcm) { this.transcription.append(pcm); }
  clearInput() { this.pending = []; this.transcription.clearInput(); }
  async updateListening(settings) { await this.transcription.updateListening(settings); this.settings = settings; }
  messages(user) {
    const system = { role: 'system', content: this.settings.persona };
    const current = { role: 'user', content: user };
    const size = messages => messages.reduce((sum, message) => sum + message.content.length, 0);
    if (size([system, current]) > this.services.historyChars) throw new Error('프롬프트와 현재 발화가 HISTORY_MAX_CHARS 한도를 넘습니다.');
    while (this.history.length && (size([system, ...this.history, current]) > this.services.historyChars || this.history.length >= 40)) {
      this.history.shift();
      while (this.history[0]?.role === 'assistant') this.history.shift();
    }
    this.history.push(current);
    return [system, ...this.history];
  }
  respond() {
    if (!this.ready || this.closed || this.generating || !this.pending.length) throw new Error('AI가 아직 준비되지 않았습니다.');
    const messages = this.messages(this.pending.join('\n')); this.pending = [];
    const turn = { controller: new AbortController(), segments: [], bytes: 0, discard: false, recorded: false };
    this.turn = turn; this.generating = true;
    turn.timer = setTimeout(() => turn.controller.abort(new Error('AI 응답 시간이 초과되었습니다.')), this.services.responseTimeoutMs);
    // Own every rejection: the Discord event loop never receives an unhandled promise.
    this.run(turn, messages).catch(error => {
      if (!this.closed && !turn.discard && this.turn === turn) this.emit('fault', error);
    });
  }
  active(turn) { return !this.closed && !turn.discard && this.turn === turn; }
  async say(turn, text) {
    if (!text || !this.active(turn)) return;
    for await (const pcm of this.speaker.synthesize(text, this.settings, turn.controller.signal)) {
      if (!this.active(turn)) return;
      turn.controller.signal.throwIfAborted(); turn.bytes += pcm.length; this.emit('audio', pcm);
    }
    if (this.active(turn)) turn.segments.push({ text, endMs: turn.bytes / 48 });
  }
  async run(turn, messages) {
    let pending = '';
    try {
      for await (const delta of this.llm.stream(messages, turn.controller.signal)) {
        if (!this.active(turn)) return;
        turn.controller.signal.throwIfAborted(); pending += delta;
        let chunk;
        while ((chunk = takeSpeechChunk(pending))) {
          pending = chunk.rest; await this.say(turn, chunk.text);
          if (!this.active(turn)) return;
        }
      }
      let chunk;
      while ((chunk = takeSpeechChunk(pending, true))) { pending = chunk.rest; await this.say(turn, chunk.text); }
      if (this.active(turn)) {
        this.generating = false;
        this.emit('audioEnd'); this.emit('done');
      }
    } finally {
      clearTimeout(turn.timer);
      if (this.turn === turn) this.generating = false;
    }
  }
  recordPlayed(playedMs) {
    const turn = this.turn;
    if (!turn || turn.recorded) return;
    turn.recorded = true;
    // TTS does not provide word alignment. Retain only completely heard chunks.
    const text = turn.segments.filter(segment => segment.endMs <= playedMs).map(segment => segment.text).join(' ');
    if (text) this.history.push({ role: 'assistant', content: text });
  }
  playbackFinished() { if (!this.generating && !this.turn?.discard) this.recordPlayed(Infinity); }
  stop(playedMs = 0) {
    const turn = this.turn;
    if (!turn || turn.discard) return;
    this.recordPlayed(Math.max(0, playedMs));
    turn.discard = true; clearTimeout(turn.timer); turn.controller.abort(); this.generating = false;
    queueMicrotask(() => { if (!this.closed && this.turn === turn) this.emit('done'); });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.connectionAbort.abort();
    this.stop(0); this.transcription.close(); this.history = []; this.pending = [];
  }
}
