import prism from 'prism-media';
import { AudioPlayerStatus, createAudioPlayer, createAudioResource, EndBehaviorType, StreamType, VoiceConnectionStatus } from '@discordjs/voice';
import { VoiceSession } from './voice-session.js';
import { serviceConfig } from './services.js';
import { SpeechPackets } from './playback.js';
import { VoiceMixer, FRAME_BYTES } from './mixer.js';
import { idleMinutes, validateSettings } from './config.js';

export class Bridge {
  constructor({ connection, channel, owner, settings, notify, onClose, apiFactory = options => new VoiceSession(options), player = createAudioPlayer() }) {
    Object.assign(this, { connection, channel, owner, notify, onClose, apiFactory, player });
    this.settings = validateSettings(settings);
    this.services = serviceConfig();
    this.listeners = new Set([owner]); this.inputs = new Map();
    this.mixer = new VoiceMixer({ overlap: this.settings.overlap });
    this.connection.subscribe(this.player);
    this.audioQueue = []; this.queuedBytes = 0; this.playedMs = 0; this.playbackEnded = false;
    this.player.on('error', error => {
      if (error.resource && error.resource !== this.resource) return;
      console.error('[voice playback]', error);
      this.fail(new Error(`음성 재생 실패: ${error.message}`));
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.clearingPlayback || this.closed) return;
      if (this.resource) {
        this.playedMs += this.resource.metadata.durationMs;
        this.queuedBytes -= this.resource.metadata.bytes;
        this.resource = null; this.playbackSource = null;
      }
      try { this.playNext(); } catch (error) { this.fail(error); }
      this.finishPlayback(); this.maybeRespond();
    });
    this.lastActivity = Date.now(); this.closed = false; this.changing = false;
    this.speech = false; this.pendingTurn = false; this.ignoreCommit = false;
    this.connection.on('error', () => this.fail(new Error('디스코드 음성 연결 오류')));
    this.connection.on(VoiceConnectionStatus.Disconnected, () => this.fail(new Error('디스코드 음성 연결이 끊어졌습니다. /ai join으로 다시 연결하세요.')));
    this.connection.on(VoiceConnectionStatus.Destroyed, () => this.close());
    this.speaking = userId => { try { this.capture(userId); } catch (error) { this.fail(error); } };
    this.connection.receiver.speaking.on('start', this.speaking);
  }
  async start() {
    await this.restart(this.settings);
    this.audioTimer = setInterval(() => this.tick(), 20);
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > idleMinutes * 60000) {
        this.notify('대화가 없어 자동으로 퇴장했습니다. /ai join으로 다시 시작하세요.'); this.close();
      }
    }, 15000);
  }
  async restart(settings) {
    if (this.closed) throw new Error('연결이 종료되었습니다.');
    const next = validateSettings(settings);
    this.changing = true;
    const api = this.apiFactory({ key: process.env.ELEVENLABS_API_KEY, model: next.model, settings: next, services: this.services });
    // Validate a replacement connection before retiring the old session.
    api.on('fault', error => { if (this.api === api) this.fail(error); });
    try {
      this.connectingApi = api;
      await api.connect();
      if (this.closed) throw new Error('연결이 종료되었습니다.');
      this.api?.close(); this.api = api;
      this.settings = next; this.speech = false; this.pendingTurn = false; this.ignoreCommit = false;
      clearTimeout(this.responseTimer); clearTimeout(this.lifeTimer);
      this.clearPlayback(); this.mixer.reset(); this.mixer.overlap = next.overlap;
      this.bindApi(api); this.lastActivity = Date.now();
      this.lifeTimer = setTimeout(() => { this.notify('연결 유지 시간이 끝나 퇴장했습니다. /ai join으로 새 대화를 시작하세요.'); this.close(); }, this.services.sessionMinutes * 60000);
      for (const id of this.listeners) this.capture(id);
    } catch (error) { api.close(); throw error; }
    finally { this.connectingApi = null; this.changing = false; this.mixer.reset(); this.maybeRespond(); }
  }
  bindApi(api) {
    const current = () => this.api === api && !this.closed;
    api.on('speechStart', () => {
      if (!current()) return;
      this.speech = true; this.ignoreCommit = false; this.lastActivity = Date.now();
      if (this.settings.interrupt && this.responding) this.interruptOutput();
    });
    api.on('speechStop', () => {
      if (!current()) return;
      this.speech = false;
      // A typed action can be pending even when VAD yields no transcript.
      this.maybeRespond();
    });
    api.on('committed', () => {
      if (!current() || this.ignoreCommit) return;
      this.pendingTurn = true; this.lastActivity = Date.now(); this.maybeRespond();
    });
    api.on('audio', pcm => {
      if (!current()) return;
      try {
        if (this.queuedBytes + pcm.length > 8 * 1024 * 1024) throw new Error('음성 응답 버퍼가 너무 큽니다.');
        this.audioQueue.push(pcm); this.queuedBytes += pcm.length; this.playNext();
      } catch (error) { this.fail(error); }
    });
    api.on('audioEnd', () => { if (current()) { this.playbackEnded = true; this.finishPlayback(); } });
    api.on('done', () => { if (current()) { clearTimeout(this.responseTimer); this.maybeRespond(); } });
  }
  get responding() { return Boolean(this.api?.generating || this.resource || this.audioQueue.length || this.player.state.status !== AudioPlayerStatus.Idle); }
  get busy() { return this.changing || this.speech || this.pendingTurn || this.responding; }
  capture(userId) {
    const member = this.channel.members.get(userId);
    if (this.closed || this.inputs.has(userId) || !this.listeners.has(userId) || !member || member.user.bot) return;
    // Persistent receive subscriptions preserve the beginning of overlapping speech.
    const source = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const state = { source, decoder: null, decodeErrorWindow: 0, decodeErrors: 0 };
    this.inputs.set(userId, state);
    const decoder = this.createInputDecoder(userId, state);
    source.on('error', error => {
      console.error('[voice receive source]', error);
      if (this.inputs.get(userId) === state) this.fail(new Error('디스코드 음성 수신 스트림 오류'));
    });
    source.once('end', () => { if (this.inputs.get(userId) === state) this.removeInput(userId); });
    source.pipe(decoder);
  }
  createInputDecoder(userId, state) {
    const decoder = new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: 480 });
    state.decoder = decoder;
    decoder.on('data', pcm => {
      if (!this.closed && !this.changing && this.listeners.has(userId)) this.mixer.push(userId, pcm);
    });
    decoder.on('error', error => this.recoverInputDecoder(userId, state, decoder, error));
    return decoder;
  }
  recoverInputDecoder(userId, state, decoder, error) {
    if (this.closed || this.inputs.get(userId) !== state || state.decoder !== decoder) return;
    state.source.unpipe(decoder);
    const now = Date.now();
    if (!state.decodeErrorWindow || now - state.decodeErrorWindow > 10000) {
      state.decodeErrorWindow = now;
      state.decodeErrors = 0;
    }
    state.decodeErrors++;
    console.warn(`Opus decode failed for voice participant ${userId}; resetting their decoder: ${error.message}`);
    if (state.decodeErrors >= 5) {
      console.error(`Pausing voice input for participant ${userId} after repeated invalid Opus packets.`);
      this.removeInput(userId);
      this.notify('한 참가자의 음성 패킷 오류가 반복되어 해당 참가자의 수신을 잠시 중지했습니다. 다음 발화 때 다시 연결됩니다.');
      return;
    }
    let replacement;
    try { replacement = this.createInputDecoder(userId, state); }
    catch (restartError) {
      console.error('Could not restart Opus decoder:', restartError);
      this.removeInput(userId);
      return;
    }
    // Let the failed pipe's error handler finish unpiping before attaching its replacement.
    queueMicrotask(() => {
      if (!this.closed && this.inputs.get(userId) === state && state.decoder === replacement && !replacement.destroyed) {
        state.source.pipe(replacement);
      }
    });
  }
  tick() {
    if (this.closed || this.changing || !this.api?.ready) return;
    try {
      const frame = this.mixer.tick();
      // Clocked silence lets server VAD measure the configured pause accurately.
      // Disabled interruption drops input during playback instead of queuing stale speech.
      const muted = !this.settings.interrupt && this.responding;
      if (frame.active && !muted) this.lastActivity = Date.now();
      this.api.append(muted ? Buffer.alloc(FRAME_BYTES) : frame.pcm);
    } catch (error) { this.fail(error); }
  }
  maybeRespond() {
    if (this.closed || this.changing || !this.api?.ready || !this.pendingTurn || this.speech || this.responding) return;
    try {
      this.pendingTurn = false; this.clearPlayback(); this.api.respond();
      clearTimeout(this.responseTimer);
      this.responseTimer = setTimeout(() => this.fail(new Error('AI 응답 시간이 초과되었습니다.')), this.services.responseTimeoutMs);
    } catch (error) { this.fail(error); }
  }
  act(text, actor) {
    if (this.closed || this.changing || !this.api?.ready) throw new Error('음성 연결이 아직 준비되지 않았습니다. 잠시 후 다시 시도하세요.');
    this.api.queueAction(text, actor);
    this.pendingTurn = true; this.lastActivity = Date.now();
    // Keep the stop fence for late voice commits; text input bypasses it explicitly.
    this.maybeRespond();
  }
  setListening(id, enabled) {
    if (enabled) { this.listeners.add(id); this.capture(id); }
    else { this.listeners.delete(id); this.removeInput(id); }
  }
  removeInput(id) {
    const state = this.inputs.get(id);
    if (state) { this.inputs.delete(id); state.source.unpipe(state.decoder); state.source.destroy(); state.decoder.destroy(); }
    this.mixer.remove(id);
  }
  async updateListening(settings) {
    const next = validateSettings(settings);
    await this.api.updateListening(next);
    this.settings = next; this.mixer.overlap = next.overlap;
  }
  playNext() {
    if (this.closed || this.resource || !this.audioQueue.length) return;
    const pcm = this.audioQueue.shift();
    const source = new SpeechPackets(pcm, this.settings.volume);
    this.playbackSource = source;
    this.resource = createAudioResource(source, { inputType: StreamType.Opus,
      metadata: { durationMs: pcm.length / 48, bytes: pcm.length }, silencePaddingFrames: 5 });
    this.player.play(this.resource);
  }
  finishPlayback() {
    if (!this.playbackEnded || this.resource || this.audioQueue.length) return;
    this.playbackEnded = false; this.api?.playbackFinished?.();
  }
  clearPlayback() {
    this.clearingPlayback = true;
    const source = this.playbackSource;
    this.audioQueue = []; this.queuedBytes = 0; this.playedMs = 0; this.playbackEnded = false;
    this.resource = null; this.playbackSource = null;
    try { this.player.stop(true); source?.destroy(); }
    finally { this.clearingPlayback = false; }
  }
  interruptOutput() {
    const currentMs = Math.min(this.resource?.playbackDuration || 0, this.resource?.metadata.durationMs || 0);
    this.api?.stop(this.playedMs + Math.max(0, currentMs - 100));
    this.clearPlayback();
    // The backend cancels generation; preserve the new user audio.
  }
  stop() {
    this.pendingTurn = false; this.speech = false; this.ignoreCommit = true;
    this.mixer.reset(); this.api?.clearInput(); this.interruptOutput();
  }
  setVolume(volume) { this.settings.volume = volume; this.playbackSource?.setVolume(volume); }
  fail(error) {
    if (this.closed) return;
    console.error(error.message); this.notify(`연결을 종료했습니다: ${error.message}`); this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.audioTimer); clearInterval(this.idleTimer); clearTimeout(this.lifeTimer); clearTimeout(this.responseTimer);
    this.connectingApi?.close(); this.api?.close();
    for (const id of this.inputs.keys()) this.removeInput(id);
    this.clearPlayback(); this.connection.receiver.speaking.off('start', this.speaking);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    this.onClose(this);
  }
}



