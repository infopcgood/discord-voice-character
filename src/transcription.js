import { EventEmitter } from 'node:events';
import { turnDetection } from './audio.js';

export class Transcription extends EventEmitter {
  constructor({ key, settings, model = 'gpt-4o-mini-transcribe', language = '', socketFactory, connectTimeoutMs = 15000, transcriptTimeoutMs = 30000 }) {
    super();
    Object.assign(this, { key, settings, model, language, socketFactory, connectTimeoutMs, transcriptTimeoutMs });
    this.ready = false; this.closed = false; this.items = new Map(); this.order = [];
    this.ignored = new Set(); this.suppressed = false; this.speechItem = null;
  }
  configuration(settings = this.settings) {
    return { type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 },
      transcription: { model: this.model, ...(this.language ? { language: this.language } : {}) },
      turn_detection: turnDetection(settings),
    } } };
  }
  async connect() {
    if (!this.socketFactory) {
      const { default: WebSocket } = await import('ws');
      this.socketFactory = (url, options) => new WebSocket(url, options);
    }
    if (this.closed) throw new Error('음성 인식 연결이 종료되었습니다.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fault(new Error('OpenAI 음성 인식 연결 시간 초과')), this.connectTimeoutMs);
      this.finishConnect = error => {
        clearTimeout(timer); this.finishConnect = null;
        error ? reject(error) : resolve();
      };
      try {
        this.ws = this.socketFactory('wss://api.openai.com/v1/realtime?intent=transcription', {
          headers: { Authorization: `Bearer ${this.key}` }, maxPayload: 1024 * 1024,
        });
        this.ws.on('open', () => {
          try { this.send({ type: 'session.update', session: this.configuration() }); }
          catch (error) { this.fault(error); }
        });
        this.ws.on('message', data => {
          if (this.closed) return;
          try { this.event(JSON.parse(data.toString())); } catch (error) { this.fault(error); }
        });
        this.ws.on('error', () => this.fault(new Error('OpenAI 음성 인식 연결 실패. API 키와 네트워크를 확인하세요.')));
        this.ws.on('close', () => { if (!this.closed) this.fault(new Error('OpenAI 음성 인식 연결이 종료되었습니다. /ai join으로 다시 연결하세요.')); });
      } catch (error) { this.fault(error); }
    });
  }
  event(event) {
    if (event.type === 'session.updated') {
      if (event.session?.type !== 'transcription') throw new Error('OpenAI가 transcription 세션을 확인하지 않았습니다.');
      this.ready = true; this.finishConnect?.(); this.finishUpdate?.(); return;
    }
    if (event.type === 'error') throw new Error('OpenAI 음성 인식 설정 또는 입력 오류. 모델, VAD 설정, API 권한을 확인하세요.');
    if (event.type === 'input_audio_buffer.cleared') { this.awaitingClear = false; return; }
    const id = event.item_id;
    if (!id || this.ignored.has(id)) return;
    // The clear acknowledgement is a fence for VAD/commit events already in flight.
    if (this.awaitingClear) { this.remember(id); return; }
    if (event.type === 'input_audio_buffer.speech_started') {
      this.suppressed = false; this.speechItem = id; this.emit('speechStart'); return;
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      if (!this.suppressed) this.emit('speechStop');
      return;
    }
    if (this.suppressed) { this.remember(id); return; }
    if (event.type === 'input_audio_buffer.committed') {
      const item = this.items.get(id) || {};
      if (!item.committed) {
        item.committed = true; this.order.push(id);
        item.timer = setTimeout(() => this.fault(new Error('OpenAI 음성 전사 시간이 초과되었습니다.')), this.transcriptTimeoutMs);
        this.items.set(id, item);
      }
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (typeof event.transcript !== 'string' || event.transcript.length > 20000) throw new Error('음성 전사 응답 형식 또는 길이 오류');
      const item = this.items.get(id) || {};
      item.text = event.transcript.trim(); this.items.set(id, item);
    } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
      throw new Error('OpenAI 음성 전사에 실패했습니다. 음성 모델과 API 상태를 확인하세요.');
    }
    if (this.items.size > 32) throw new Error('음성 전사 대기열이 가득 찼습니다.');
    // Completion events may arrive out of order; committed events establish order.
    const ready = [];
    while (this.order.length && this.items.get(this.order[0])?.text !== undefined) {
      const first = this.order.shift(); const item = this.items.get(first);
      clearTimeout(item.timer); this.items.delete(first); this.remember(first);
      if (item.text) ready.push(item.text);
    }
    if (ready.length) this.emit('transcript', ready.join('\n'));
  }
  remember(id) {
    this.ignored.add(id);
    if (this.ignored.size > 1024) this.ignored.delete(this.ignored.values().next().value);
  }
  send(event) {
    if (this.closed || this.ws?.readyState !== 1) throw new Error('OpenAI 음성 인식에 연결되어 있지 않습니다.');
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) throw new Error('네트워크가 음성 전송 속도를 따라가지 못합니다.');
    this.ws.send(JSON.stringify(event));
  }
  append(pcm) { this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }); }
  clearInput() {
    if (this.speechItem) this.remember(this.speechItem);
    for (const [id, item] of this.items) { this.remember(id); clearTimeout(item.timer); }
    this.items.clear(); this.order = []; this.suppressed = true; this.awaitingClear = true; this.speechItem = null;
    if (this.ready && !this.closed) this.send({ type: 'input_audio_buffer.clear' });
  }
  updateListening(settings) {
    if (this.finishUpdate) return Promise.reject(new Error('음성 설정 변경을 처리 중입니다.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finishUpdate?.(new Error('음성 설정 적용 시간 초과')), 10000);
      this.finishUpdate = error => {
        clearTimeout(timer); this.finishUpdate = null;
        if (error) reject(error); else { this.settings = settings; resolve(); }
      };
      try { this.send({ type: 'session.update', session: { type: 'transcription', audio: { input: { turn_detection: turnDetection(settings) } } } }); }
      catch (error) { this.finishUpdate(error); }
    });
  }
  fault(error) {
    if (this.closed) return;
    this.finishConnect?.(error); this.finishUpdate?.(error); this.close(); this.emit('fault', error);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    const error = new Error('음성 인식 연결이 종료되었습니다.');
    this.finishConnect?.(error); this.finishUpdate?.(error);
    for (const item of this.items.values()) clearTimeout(item.timer);
    this.items.clear(); this.order = []; this.ignored.clear();
    if (this.ws?.readyState === 0) this.ws.terminate(); else this.ws?.close();
  }
}
