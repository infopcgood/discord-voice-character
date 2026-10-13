// No provider credentials or URLs are inferred from one another.
export function serviceConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}: ${min}~${max} 정수를 입력하세요.`);
    return value;
  };
  const baseURL = (env.STRATA_BASE_URL || '').trim().replace(/\/+$/, '');
  if (baseURL) {
    let url;
    try { url = new URL(baseURL); } catch { throw new Error('STRATA_BASE_URL에 http(s) API 주소를 입력하세요.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('STRATA_BASE_URL에는 인증 정보, 쿼리, 해시 없이 http(s) API 주소만 입력하세요.');
    }
  }
  const transcriptionModel = env.ELEVENLABS_STT_MODEL?.trim() || 'scribe_v2_realtime';
  if (transcriptionModel !== 'scribe_v2_realtime') throw new Error('ELEVENLABS_STT_MODEL에는 scribe_v2_realtime을 사용하세요.');
  const transcriptionLanguage = env.ELEVENLABS_STT_LANGUAGE?.trim() || '';
  if (transcriptionLanguage && !/^[a-z]{2,3}$/.test(transcriptionLanguage)) throw new Error('ELEVENLABS_STT_LANGUAGE에는 ko 등의 언어 코드를 입력하세요.');
  const ttsModel = env.ELEVENLABS_TTS_MODEL?.trim() || 'eleven_multilingual_v2';
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || '';
  if (voiceId && !/^[a-zA-Z0-9_-]{8,128}$/.test(voiceId)) throw new Error('ELEVENLABS_VOICE_ID에 Voice ID를 입력하세요.');
  return {
    baseURL, apiKey: env.STRATA_API_KEY?.trim() || '',
    transcriptionModel, transcriptionLanguage, ttsModel, voiceId,
    speechTimeoutMs: integer('ELEVENLABS_TIMEOUT_MS', 60000, 1000, 300000),
    maxTokens: integer('STRATA_MAX_TOKENS', 128000, 1, 128000),
    concurrency: integer('STRATA_MAX_CONCURRENT', 1, 1, 16),
    requestTimeoutMs: integer('STRATA_TIMEOUT_MS', 60000, 1000, 300000),
    responseTimeoutMs: integer('RESPONSE_TIMEOUT_MS', 180000, 1000, 600000),
    historyChars: integer('HISTORY_MAX_CHARS', 24000, 1000, 200000),
    sessionMinutes: integer('SPEECH_SESSION_MINUTES', 55, 1, 55),
  };
}

export function requireServices(env = process.env) {
  for (const name of ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'STRATA_BASE_URL', 'STRATA_MODEL']) {
    if (!env[name]?.trim()) throw new Error(`.env에 ${name} 값을 입력하세요.`);
  }
  return serviceConfig(env);
}

