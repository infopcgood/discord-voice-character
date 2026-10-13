import { PassThrough } from 'node:stream';
import prism from 'prism-media';
import { AudioPlayerStatus, createAudioPlayer, createAudioResource, EndBehaviorType, StreamType, VoiceConnectionStatus } from '@discordjs/voice';
import { VoiceSession } from './voice-session.js';
import { serviceConfig } from './services.js';
import { DiscordPCM } from './audio.js';
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
    this.player.on('error', () => this.fail(new Error('음성 재생 실패. Opus 라이브러리를 확인하세요.')));
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (!this.clearingPlayback) { this.api?.playbackFinished?.(); this.maybeRespond(); }
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
    const api = this.apiFactory({ key: process.env.OPENAI_API_KEY, model: next.model, settings: next, services: this.services });
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
      if (!this.output) {
        this.output = new PassThrough(); this.converter = new DiscordPCM();
        this.output.on('error', error => this.fail(error)); this.converter.on('error', error => this.fail(error));
        this.resource = createAudioResource(this.output.pipe(this.converter), { inputType: StreamType.Raw, inlineVolume: true });
        this.resource.volume.setVolume(this.settings.volume); this.player.play(this.resource);
      }
      if (this.output.writableLength > 4 * 1024 * 1024) { this.fail(new Error('음성 응답 버퍼가 너무 큽니다.')); return; }
      if (!this.output.writableEnded) this.output.write(pcm);
    });
    api.on('audioEnd', () => { if (current()) this.output?.end(); });
    api.on('done', () => { if (current()) { clearTimeout(this.responseTimer); this.maybeRespond(); } });
  }
  get responding() { return Boolean(this.api?.generating || this.player.state.status !== AudioPlayerStatus.Idle); }
  get busy() { return this.changing || this.speech || this.pendingTurn || this.responding; }
  capture(userId) {
    const member = this.channel.members.get(userId);
    if (this.closed || this.inputs.has(userId) || !this.listeners.has(userId) || !member || member.user.bot) return;
    // Persistent receive subscriptions preserve the beginning of overlapping speech.
    const source = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new prism.opus.Decoder({ rate: 24000, channels: 1, frameSize: 480 });
    const state = { source, decoder }; this.inputs.set(userId, state);
    decoder.on('data', pcm => { if (!this.closed && !this.changing && this.listeners.has(userId)) this.mixer.push(userId, pcm); });
    const failure = () => this.fail(new Error('수신 음성 해독에 실패했습니다. 의존성과 DAVE 지원을 확인하세요.'));
    source.on('error', failure); decoder.on('error', failure);
    source.once('end', () => { if (this.inputs.get(userId) === state) this.removeInput(userId); });
    source.pipe(decoder);
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
  clearPlayback() {
    this.clearingPlayback = true;
    try {
      this.player.stop(true); this.output?.destroy(); this.converter?.destroy();
      this.output = null; this.converter = null; this.resource = null;
    } finally { this.clearingPlayback = false; }
  }
  interruptOutput() {
    this.api?.stop(Math.max(0, (this.resource?.playbackDuration || 0) - 100));
    this.clearPlayback();
    // The backend cancels generation; preserve the new user audio.
  }
  stop() {
    this.pendingTurn = false; this.speech = false; this.ignoreCommit = true;
    this.mixer.reset(); this.api?.clearInput(); this.interruptOutput();
  }
  setVolume(volume) { this.settings.volume = volume; this.resource?.volume?.setVolume(volume); }
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


