import { EventEmitter } from 'node:events';

const errors = new Set(['error', 'auth_error', 'quota_exceeded', 'transcriber_error', 'input_error',
  'invalid_request', 'commit_throttled', 'unaccepted_terms', 'rate_limited', 'queue_overflow',
  'resource_exhausted', 'session_time_limit_exceeded', 'chunk_size_exceeded', 'insufficient_audio_activity']);

export class Transcription extends EventEmitter {
  constructor({ key, settings, model = 'scribe_v2_realtime', language = '', socketFactory, connectTimeoutMs = 15000 }) {
    super();
    Object.assign(this, { key, settings, model, language, socketFactory, connectTimeoutMs });
    this.ready = false; this.closed = false; this.speaking = false; this.generation = 0;
  }
  url() {
    const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    url.search = new URLSearchParams({ model_id: this.model, audio_format: 'pcm_24000', commit_strategy: 'vad',
      vad_silence_threshold_secs: String(this.settings.silenceSeconds), vad_threshold: String(this.settings.vadThreshold),
      include_timestamps: 'false', include_language_detection: 'false',
      ...(this.language ? { language_code: this.language } : {}) }).toString();
    return url.toString();
  }
  async connect() {
    if (!this.socketFactory) {
      const { default: WebSocket } = await import('ws');
      this.socketFactory = (url, options) => new WebSocket(url, options);
    }
    await this.replaceConnection();
  }
  replaceConnection() {
    if (this.closed) return Promise.reject(new Error('음성 인식 연결이 종료되었습니다.'));
    // Scribe has no clear-buffer or session-update message. Replace the socket to
    // fence old transcripts, and drop input until the new session is acknowledged.
    const generation = ++this.generation;
    this.ready = false; this.speaking = false;
    this.finishConnect?.(new Error('음성 인식 연결이 교체되었습니다.'));
    this.retireSocket();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fault(new Error('ElevenLabs STT 연결 시간 초과')), this.connectTimeoutMs);
      this.finishConnect = error => {
        clearTimeout(timer); this.finishConnect = null;
        error ? reject(error) : resolve();
      };
      const current = () => !this.closed && this.generation === generation;
      try {
        const ws = this.socketFactory(this.url(), { headers: { 'xi-api-key': this.key }, maxPayload: 1024 * 1024 });
        this.ws = ws;
        ws.on('message', data => {
          if (!current()) return;
          try { this.event(JSON.parse(data.toString())); } catch (error) { this.fault(error); }
        });
        ws.on('error', () => { if (current()) this.fault(new Error('ElevenLabs STT 연결 실패. API 키와 네트워크를 확인하세요.')); });
        ws.on('close', () => { if (current()) this.fault(new Error('ElevenLabs STT 연결이 종료되었습니다. /ai join으로 다시 연결하세요.')); });
      } catch (error) { this.fault(error); }
    });
  }
  event(event) {
    const type = event.message_type;
    if (errors.has(type)) throw new Error(`ElevenLabs STT 오류 (${type}). API 키, 사용량, 모델 설정과 Scribe 이용 약관 동의를 확인하세요.`);
    if (type === 'session_started') {
      if (this.ready) return;
      this.ready = true; this.finishConnect?.(); this.emit('speechStop'); return;
    }
    if (!this.ready || !['partial_transcript', 'committed_transcript'].includes(type)) return;
    if (typeof event.text !== 'string' || event.text.length > 20000) throw new Error('ElevenLabs 전사 응답 형식 또는 길이 오류');
    const text = event.text.trim();
    if (text && !this.speaking) { this.speaking = true; this.emit('speechStart'); }
    if (type === 'committed_transcript') {
      // Commit first while speech is still active: the bridge starts a response
      // only after the matching speechStop, including commits without a partial.
      if (text) this.emit('transcript', text);
      this.speaking = false; this.emit('speechStop');
    }
  }
  append(pcm) {
    if (!this.ready || this.closed) return;
    if (this.ws?.readyState !== 1) throw new Error('ElevenLabs STT에 연결되어 있지 않습니다.');
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) throw new Error('네트워크가 음성 전송 속도를 따라가지 못합니다.');
    this.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm.toString('base64'), sample_rate: 24000, commit: false }));
  }
  clearInput() {
    if (this.closed) return;
    const pending = this.replaceConnection();
    const generation = this.generation;
    pending.catch(error => { if (!this.closed && this.generation === generation) this.fault(error); });
  }
  async updateListening(settings) {
    if (this.finishConnect) throw new Error('음성 인식 재연결 중입니다. 잠시 후 다시 시도하세요.');
    const changed = settings.silenceSeconds !== this.settings.silenceSeconds || settings.vadThreshold !== this.settings.vadThreshold;
    this.settings = settings;
    if (changed) await this.replaceConnection();
  }
  retireSocket() {
    const ws = this.ws; this.ws = null;
    if (ws?.readyState === 0) ws.terminate(); else ws?.close();
  }
  fault(error) {
    if (this.closed) return;
    this.close(error); this.emit('fault', error);
  }
  close(error = new Error('음성 인식 연결이 종료되었습니다.')) {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.generation++;
    this.finishConnect?.(error); this.retireSocket();
  }
}
