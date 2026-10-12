// The only Strata-specific contract: OpenAI-compatible POST /chat/completions.
// No OpenAI credentials, audio, cloud fallback, tools, or reasoning fields go here.
export class RequestGate {
  constructor(limit = 1) { this.limit = limit; this.active = 0; this.waiters = []; }
  async acquire(signal) {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return () => this.release(); }
    if (this.waiters.length >= 32) throw new Error('Strata 요청 대기열이 가득 찼습니다.');
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      waiter.abort = () => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(signal.reason);
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
    return () => this.release();
  }
  release() {
    const next = this.waiters.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else this.active--;
  }
}
const gates = new Map();
function sharedGate(baseURL, limit) {
  const key = `${baseURL}|${limit}`;
  if (!gates.has(key)) gates.set(key, new RequestGate(limit));
  return gates.get(key);
}

export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Do not normalize CRLF until both bytes have arrived.
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
      if (buffer.length > 1024 * 1024) throw new Error('Strata 스트림 이벤트가 너무 큽니다.');
      if (done) {
        if (buffer.trim()) throw new Error('Strata 스트림이 이벤트 중간에 종료되었습니다.');
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class StrataClient {
  constructor({ baseURL, apiKey = '', model, maxTokens = 512, requestTimeoutMs = 60000, concurrency = 1, fetchImpl = fetch, gate }) {
    if (!baseURL || !model) throw new Error('STRATA_BASE_URL과 STRATA_MODEL을 설정하세요.');
    Object.assign(this, { baseURL: baseURL.replace(/\/+$/, ''), apiKey, model, maxTokens, requestTimeoutMs, fetchImpl });
    this.gate = gate || sharedGate(this.baseURL, concurrency);
  }
  async request(messages, { signal, stream, maxTokens = this.maxTokens }) {
    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, messages, stream, max_tokens: maxTokens }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Strata HTTP ${response.status}: API 주소, 모델 ID, 인증, 서버 로그를 확인하세요.`); }
    return response;
  }
  async check(signal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)].filter(Boolean));
    const release = await this.gate.acquire(combined);
    try {
      const response = await this.request([{ role: 'user', content: 'Reply OK.' }], { signal: combined, stream: false, maxTokens: 1 });
      const data = await response.json();
      if (!Array.isArray(data.choices) || !data.choices[0]?.message) throw new Error('Strata 응답이 Chat Completions 형식이 아닙니다.');
    } finally { release(); }
  }
  async *stream(messages, signal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)].filter(Boolean));
    const release = await this.gate.acquire(combined);
    let chars = 0; let finished = false;
    try {
      const response = await this.request(messages, { signal: combined, stream: true });
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        await response.body?.cancel();
        throw new Error('Strata에서 stream:true SSE 응답을 지원해야 합니다.');
      }
      for await (const data of readSSE(response.body)) {
        combined.throwIfAborted();
        if (data.trim() === '[DONE]') { finished = true; break; }
        let event;
        try { event = JSON.parse(data); } catch { throw new Error('Strata 스트림 JSON이 올바르지 않습니다.'); }
        if (event.error) throw new Error('Strata가 생성 오류를 반환했습니다. 로컬 서버 로그를 확인하세요.');
        const choice = event.choices?.find(item => item.index === 0) || event.choices?.[0];
        if (!choice) continue; // Usage-only events.
        if (choice.delta?.tool_calls || ['tool_calls', 'function_call', 'content_filter'].includes(choice.finish_reason)) {
          throw new Error('Strata는 도구 호출 없는 일반 텍스트 답변을 반환해야 합니다.');
        }
        const text = choice.delta?.content;
        if (text != null && typeof text !== 'string') throw new Error('Strata content는 텍스트여야 합니다.');
        if (text) {
          chars += text.length;
          if (chars > 16000) throw new Error('Strata 답변이 음성 응답 길이 한도를 넘었습니다.');
          yield text;
        }
        if (choice.finish_reason) finished = true;
      }
      if (!finished || !chars) throw new Error('Strata 답변이 비어 있거나 스트림이 중간에 종료되었습니다.');
    } finally { release(); }
  }
}
