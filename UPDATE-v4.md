# v4: ElevenLabs STT/TTS 및 재생 교체

음성 인식과 합성을 ElevenLabs로 이전했습니다. LLM은 기존 Strata OpenAI 호환 Chat Completions를 계속 사용하며 `STRATA_MAX_TOKENS=128000` 설정도 유지합니다.

1. 변경 내용을 받은 뒤 기존 `.env`에 다음을 추가합니다. 키와 Voice ID는 ElevenLabs 계정의 실제 값을 입력하세요.

   ```dotenv
   ELEVENLABS_API_KEY=your-api-key
   ELEVENLABS_VOICE_ID=your-voice-id
   ELEVENLABS_STT_MODEL=scribe_v2_realtime
   ELEVENLABS_STT_LANGUAGE=ko
   ELEVENLABS_TTS_MODEL=eleven_multilingual_v2
   ELEVENLABS_TIMEOUT_MS=60000
   ```

2. 기존 `OPENAI_API_KEY`, `OPENAI_TRANSCRIBE_*`, `OPENAI_TTS_MODEL`은 더 이상 사용하지 않으므로 제거할 수 있습니다. Discord와 Strata 설정은 유지합니다. 언어 자동 감지는 `ELEVENLABS_STT_LANGUAGE=`로 설정합니다.
3. `start.cmd` 또는 `./start.sh`로 재시작합니다. 수동 실행 시 의존성을 설치하고 `npm run register`로 변경된 명령어를 등록하세요.
4. 기존 서버별 프롬프트·볼륨·Strata 모델은 유지합니다. 기존 목소리는 `default`로 바뀌며 `.env`의 Voice ID를 사용합니다. 속도는 0.7~1.2, 침묵 대기는 0.3~3초 범위로 조정됩니다. `/ai voice name:<Voice ID>`로 서버별 목소리를 지정할 수 있습니다.
5. `/ai join` → 한국어 대화 → 답변 끝까지 듣기 → 다음 질문 → 말하는 중 끼어들기 → `/ai stop` → 다시 질문 순서로 실제 환경을 확인하세요. 상태는 `/ai status`로 확인합니다.

TTS는 문장 전체의 PCM을 받은 뒤 직접 Opus 패킷으로 재생합니다. 이전의 라이브 Encoder 스트림과 강제 종료 우회 코드는 제거했습니다. 첫 음성까지 문장 합성을 기다리고, 문장 사이에 합성 대기가 생길 수 있습니다. STT 자동 끼어들기는 첫 부분 전사 도착 시점에 작동합니다. `/ai stop`과 VAD 설정 변경은 STT 소켓을 교체하므로 재연결 중 음성은 짧게 수신되지 않습니다.

자동 테스트는 실제 Opus 코덱과 Discord AudioPlayer의 자연 종료·취소·반복 응답을 검사합니다. 실제 Discord 연결 및 ElevenLabs 계정/목소리/Strata 배포에 대한 종단 간 확인은 사용자 실행 환경에서 필요합니다.
