import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { sessionSettings, turnDetection } from './audio.js';

export class Realtime extends EventEmitter {
  constructor({ key, model, settings, socketFactory = (url, options) => new WebSocket(url, options) }) {
    super();
    this.options = { key, model, settings, socketFactory };
    this.ready = false; this.closed = false; this.generating = false; this.turn = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.finishConnect = null;
        error ? reject(error) : resolve();
      };
      this.finishConnect = finish;
      const timer = setTimeout(() => { finish(new Error('OpenAI 연결 시간 초과')); this.close(); }, 15000);
      const { key, model, settings, socketFactory } = this.options;
      try {
        this.ws = socketFactory(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
          headers: { Authorization: `Bearer ${key}` }, maxPayload: 4 * 1024 * 1024,
        });
      } catch (error) { finish(error); return; }
      this.ws.on('message', data => {
        if (this.closed) return;
        try {
          const event = JSON.parse(data.toString());
          if (event.type === 'session.created') this.send({ type: 'session.update', session: sessionSettings(settings, model) });
          if (event.type === 'session.updated') {
            if (!this.ready) { this.ready = true; finish(); }
            else this.finishUpdate?.();
          }
          if (event.type === 'error') {
            if (event.error?.code === 'response_cancel_not_active') return;
            const error = new Error(`OpenAI: ${event.error?.message || '알 수 없는 오류'}`);
            finish(error); this.finishUpdate?.(error); this.emit('fault', error); return;
          }
          if (event.type === 'input_audio_buffer.speech_started') this.emit('speechStart');
          if (event.type === 'input_audio_buffer.speech_stopped') this.emit('speechStop');
          if (event.type === 'input_audio_buffer.committed') this.emit('committed', event.item_id);
          const turn = this.turn;
          if (!turn) return;
          const responseId = event.response_id || event.response?.id;
          if (responseId && turn.id && responseId !== turn.id) return;
          if (event.type === 'response.created') turn.id = event.response.id;
          if (event.type === 'response.output_item.added' && event.item?.type === 'message') turn.itemId = event.item.id;
          if (event.type === 'response.output_audio.delta') {
            const pcm = Buffer.from(event.delta, 'base64');
            turn.bytes += pcm.length; turn.itemId = event.item_id || turn.itemId; turn.contentIndex = event.content_index ?? 0;
            if (turn.discard) this.truncate(); else this.emit('audio', pcm);
          }
          if (event.type === 'response.output_audio.done' && !turn.discard) this.emit('audioEnd');
          if (event.type === 'response.done') {
            this.generating = false;
            if (!turn.discard) this.emit('audioEnd');
            if (event.response?.status === 'failed') this.emit('fault', new Error(`응답 생성 실패: ${event.response.status_details?.error?.message || 'API 상태를 확인하세요.'}`));
            else this.emit('done');
          }
        } catch (error) { finish(error); this.finishUpdate?.(error); this.emit('fault', error); }
      });
      this.ws.on('error', () => {
        const error = new Error('OpenAI 연결 실패. API 키와 인터넷 연결을 확인하세요.');
        finish(error); this.finishUpdate?.(error); if (!this.closed) this.emit('fault', error);
      });
      this.ws.on('close', () => {
        const error = new Error('OpenAI 연결이 종료되었습니다. /ai join으로 다시 연결하세요.');
        finish(error); this.finishUpdate?.(error); this.ready = false;
        if (!this.closed) this.emit('fault', error);
      });
    });
  }
  send(event) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) throw new Error('OpenAI에 연결되어 있지 않습니다.');
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) throw new Error('네트워크가 음성 전송 속도를 따라가지 못합니다.');
    this.ws.send(JSON.stringify(event));
  }
  updateListening(settings) {
    if (this.finishUpdate) return Promise.reject(new Error('설정 변경을 처리 중입니다.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finishUpdate?.(new Error('음성 설정 적용 시간 초과')), 10000);
      this.finishUpdate = error => { clearTimeout(timer); this.finishUpdate = null; error ? reject(error) : resolve(); };
      try { this.send({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: turnDetection(settings) } } } }); }
      catch (error) { this.finishUpdate(error); }
    });
  }
  append(pcm) { this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }); }
  clearInput() { if (this.ready && !this.closed) this.send({ type: 'input_audio_buffer.clear' }); }
  respond() {
    if (!this.ready || this.generating) throw new Error('AI가 아직 준비되지 않았습니다.');
    this.turn = { id: null, itemId: null, bytes: 0, discard: false, playedMs: 0, truncated: false, contentIndex: 0 };
    this.generating = true;
    // Server VAD has already committed this input; do not commit it twice.
    this.send({ type: 'response.create' });
  }
  truncate() {
    const turn = this.turn;
    if (!turn || turn.truncated || !turn.itemId || turn.bytes === 0) return;
    this.send({ type: 'conversation.item.truncate', item_id: turn.itemId, content_index: turn.contentIndex,
      audio_end_ms: Math.max(0, Math.min(Math.floor(turn.playedMs), Math.floor(turn.bytes / 48))) });
    turn.truncated = true;
  }
  stop(playedMs = 0) {
    if (!this.ready || this.closed || !this.turn || this.turn.discard) return;
    this.turn.discard = true; this.turn.playedMs = playedMs;
    if (this.generating) this.send({ type: 'response.cancel' });
    // If stopped before the first audio packet, truncate that late packet too.
    this.truncate();
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    const error = new Error('OpenAI 연결이 종료되었습니다.');
    this.finishConnect?.(error); this.finishUpdate?.(error);
    if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate(); else this.ws?.close();
  }
}

