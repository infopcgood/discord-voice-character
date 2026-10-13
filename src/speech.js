// Complete each bounded sentence before exposing it to the Discord player.
export class ElevenLabsSpeech {
  constructor({ key, model = 'eleven_multilingual_v2', voiceId, timeoutMs = 60000, fetchImpl = fetch }) {
    Object.assign(this, { key, model, voiceId, timeoutMs, fetchImpl });
  }
  async synthesize(text, settings, signal) {
    const voice = settings.voice === 'default' ? this.voiceId : settings.voice;
    if (!voice || !/^[a-zA-Z0-9_-]{8,128}$/.test(voice)) throw new Error('ELEVENLABS_VOICE_ID 또는 /ai voice에 ElevenLabs Voice ID를 입력하세요.');
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    requestSignal.throwIfAborted();
    const response = await this.fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`, {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { 'xi-api-key': this.key, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
      body: JSON.stringify({ text, model_id: this.model, voice_settings: { speed: settings.speed } }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ElevenLabs TTS HTTP ${response.status}: API 키, 사용량, Voice ID와 모델 권한을 확인하세요.`);
    }
    if (!response.body || /json|text\//i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel(); throw new Error('ElevenLabs TTS 응답이 PCM 오디오가 아닙니다.');
    }
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0; let complete = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        requestSignal.throwIfAborted();
        if (done) { complete = true; break; }
        bytes += value.length;
        if (bytes > 48000 * 120) throw new Error('음성 합성 조각이 너무 깁니다.');
        chunks.push(Buffer.from(value));
      }
      if (!bytes || bytes % 2) throw new Error('ElevenLabs PCM 오디오가 비어 있거나 손상되었습니다.');
      return Buffer.concat(chunks, bytes);
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
