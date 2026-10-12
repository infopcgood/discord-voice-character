# v3: Strata LLM + 온라인 음성으로 업데이트

1. 기존 봇을 종료합니다. `.env`, `persona.txt`, `data` 폴더를 백업합니다.
2. v3 코드를 새 폴더에 받고 위 세 항목을 복사합니다. `node_modules`는 복사하지 않습니다.
3. `.env.example`을 참고해 `.env`에 `STRATA_BASE_URL`과 `STRATA_MODEL`을 추가합니다. 로컬 서버가 인증을 요구할 때만 `STRATA_API_KEY`를 넣습니다.
4. `OPENAI_API_KEY`는 계속 필요합니다. 음성 인식·VAD와 음성 합성은 OpenAI를 사용합니다. `OPENAI_REALTIME_MODEL`은 더 이상 사용하지 않습니다.
5. `npm install`, `npm run check -- --network`로 설정·코덱·Strata 모델을 확인한 뒤 `start.cmd`로 실행합니다.

Strata는 OpenAI 호환 `/chat/completions`의 JSON 응답과 SSE 스트리밍을 모두 제공해야 합니다. 다른 프로토콜은 `src/llm.js`를 수정해야 합니다. 설정 예시의 포트와 모델 이름을 실제 값으로 바꾸세요.

기존 `data/<서버ID>.json`에는 Realtime 음성 모델 ID가 저장되어 있습니다. v3는 스키마 버전이 없는 v1/v2 설정을 읽을 때 모델을 `STRATA_MODEL`로 바꾸고 캐릭터·목소리·볼륨·속도·듣기 설정을 보존합니다. 다음 설정 저장 때 `schemaVersion: 3`을 기록합니다. 이후 `/ai model`로 선택한 서버별 Strata 모델은 환경변수 기본값을 바꿔도 유지됩니다. 해당 서버에서도 바꾸려면 `/ai model`을 사용하세요. 이전 버전으로 되돌릴 때는 백업한 `data` 폴더를 사용합니다.

설정 이전을 위해 실제 모델 ID를 지정해야 합니다. 목소리와 속도는 OpenAI TTS 설정이고 `/ai model`은 이제 로컬 LLM 설정입니다. 모델 변경은 먼저 최대 1토큰 점검 요청을 수행하며 실패하면 이전 세션을 유지합니다. OpenAI 합성 가능 여부는 다음 발화 시 확인합니다.

대화 기억은 로컬 프로세스 메모리에만 있습니다. 끼어들기 때 완전히 들려준 문장 조각만 기억에 남기며, 중간에 끊긴 조각은 제외합니다. 음성 서비스가 온라인이므로 세션 시간 제한(기본 55분)은 계속 적용됩니다. 그 후 `/ai join`으로 다시 연결하세요.
