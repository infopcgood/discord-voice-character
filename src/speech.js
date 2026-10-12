export class OpenAISpeech {
  constructor({ key, model = 'gpt-4o-mini-tts', fetchImpl = fetch }) { Object.assign(this, { key, model, fetchImpl }); }
  async *synthesize(text, settings, signal) {
    const response = await this.fetchImpl('https://api.openai.com/v1/audio/speech', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text, voice: settings.voice, speed: settings.speed,
        response_format: 'pcm', stream_format: 'audio' }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenAI 음성 합성 HTTP ${response.status}: 키, 모델, 목소리 설정을 확인하세요.`); }
    if (!response.body || /json|text\//i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel(); throw new Error('OpenAI 음성 응답이 PCM 오디오가 아닙니다.');
    }
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        bytes += value.length;
        if (bytes > 48000 * 120) throw new Error('음성 합성 조각이 너무 깁니다.');
        yield Buffer.from(value);
      }
      if (!bytes || bytes % 2) throw new Error('OpenAI PCM 오디오가 비어 있거나 손상되었습니다.');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
