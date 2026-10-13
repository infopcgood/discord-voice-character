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
  const transcriptionModel = env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'gpt-4o-mini-transcribe';
  if (!/^(whisper-1|gpt-4o-(mini-)?transcribe(?:-\d{4}-\d{2}-\d{2})?)$/.test(transcriptionModel)) {
    throw new Error('OPENAI_TRANSCRIBE_MODEL에는 server_vad를 지원하는 whisper-1 또는 gpt-4o[-mini]-transcribe 모델을 사용하세요.');
  }
  const ttsModel = env.OPENAI_TTS_MODEL?.trim() || 'gpt-4o-mini-tts';
  if (!/^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/.test(ttsModel)) throw new Error('OPENAI_TTS_MODEL에는 gpt-4o-mini-tts 계열 모델을 사용하세요.');
  return {
    baseURL, apiKey: env.STRATA_API_KEY?.trim() || '',
    transcriptionModel, transcriptionLanguage: env.OPENAI_TRANSCRIBE_LANGUAGE?.trim() || '', ttsModel,
    maxTokens: integer('STRATA_MAX_TOKENS', 128000, 1, 128000),
    concurrency: integer('STRATA_MAX_CONCURRENT', 1, 1, 16),
    requestTimeoutMs: integer('STRATA_TIMEOUT_MS', 60000, 1000, 300000),
    responseTimeoutMs: integer('RESPONSE_TIMEOUT_MS', 180000, 1000, 600000),
    historyChars: integer('HISTORY_MAX_CHARS', 24000, 1000, 200000),
    sessionMinutes: integer('SPEECH_SESSION_MINUTES', 55, 1, 55),
  };
}

export function requireServices(env = process.env) {
  for (const name of ['OPENAI_API_KEY', 'STRATA_BASE_URL', 'STRATA_MODEL']) {
    if (!env[name]?.trim()) throw new Error(`.env에 ${name} 값을 입력하세요.`);
  }
  return serviceConfig(env);
}
