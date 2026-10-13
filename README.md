# 디스코드 음성 캐릭터 봇 v4

**답변 생성은 로컬 Strata, 음성 인식·발화 감지·음성 합성은 온라인 ElevenLabs**를 사용합니다. Windows에서는 `start.cmd`, Linux에서는 `./start.sh`로 실행하고 디스코드 `/ai` 명령으로 조작합니다. 기존 사용자는 [v4 업데이트 안내](UPDATE-v4.md)를 먼저 읽으세요.

## 1. 설정과 실행

1. Node.js 24를 설치합니다.
2. Discord Developer Portal에서 봇을 만들고 봇 토큰과 Application ID를 준비합니다. 초대 범위는 `bot`, `applications.commands`, 권한은 View Channels, Send Messages, Connect, Speak입니다. Message Content Intent는 필요 없습니다.
3. ElevenLabs API 키와 사용할 Voice ID를 준비합니다. 계정에서 TTS와 Scribe Realtime 사용 권한 및 이용 약관 동의를 확인하세요. **음성 서비스에는 계속 ElevenLabs API 사용 요금이 발생합니다.** ChatGPT 구독과 별도입니다.
4. Strata를 실행하고 API 주소와 배포 모델 ID를 확인합니다. 아래 API 계약을 충족해야 합니다.
5. Windows에서는 `start.cmd`, Linux에서는 `./start.sh`를 한 번 실행해 생성된 `.env`를 채웁니다. 기존 사용자는 `.env.example`의 새 설정을 자신의 `.env`에 추가합니다.

```dotenv
DISCORD_TOKEN=your-discord-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_GUILD_IDS=
ELEVENLABS_API_KEY=your-elevenlabs-api-key
ELEVENLABS_VOICE_ID=your-elevenlabs-voice-id
STRATA_BASE_URL=http://127.0.0.1:8000/v1
STRATA_MODEL=your-served-model-id
STRATA_API_KEY=
```

위 포트와 모델 이름은 **예시**입니다. Strata 배포의 실제 값을 입력하세요. `STRATA_BASE_URL`에는 `/chat/completions` 앞부분까지 넣습니다. 봇과 Strata가 서로 다른 PC/컨테이너에서 실행되면 봇에서 접근 가능한 주소를 사용하세요. 컨테이너의 `127.0.0.1`은 해당 컨테이너 자체입니다. API 키는 저장소나 채팅에 올리지 마세요.

6. Windows에서는 `start.cmd`, Linux에서는 `./start.sh`를 다시 실행합니다. 음성채널에 들어가 `/ai join`을 실행하세요. 저장된 개인별 `/ai listen` 설정을 복원합니다. 설정이 없는 사용자는 봇을 부른 사람만 기본 수신하며, 다른 참가자는 `/ai listen enabled:True`로 참여합니다.

### Linux에서 실행

Node.js 24와 npm을 설치한 뒤 저장소 폴더에서 실행합니다 (최소 Node.js 22.12.0).

```sh
chmod +x start.sh
./start.sh
# 첫 실행으로 생성된 .env에 실제 설정을 입력합니다.
nano .env
./start.sh
```

이미 `.env`를 설정했다면 `./start.sh`만 실행하면 됩니다. 스크립트는 기존 `.env`를 유지하고, 누락되거나 버전이 맞지 않는 의존성을 설치한 뒤 설정·코덱 점검과 명령어 등록을 거쳐 봇을 시작합니다. `Ctrl+C`로 종료합니다. Strata는 별도로 실행해 두어야 하며, 음성 인식·합성에는 계속 온라인 ElevenLabs를 사용합니다. 다른 폴더에서 스크립트의 경로를 지정해 실행해도 됩니다.

### 수동 실행과 점검

```sh
npm install
npm run check
npm run check -- --network
npm run register
npm start
```

`check`는 설정과 코덱을 점검합니다. `check -- --network`는 Strata에 **최대 1토큰의 점검 요청**을 보내 모델을 확인합니다. `/ai join`과 모델 변경 때도 이 점검을 수행한 뒤 음성 인식 세션을 엽니다. ElevenLabs TTS는 실제 발화 때 확인됩니다.

## 2. Strata API 계약

이 저장소에는 사용자의 Strata 배포 명세가 제공되지 않았으므로, `src/llm.js` 한 파일에 **OpenAI 호환 Chat Completions** 계약을 명시했습니다. Strata가 다른 프로토콜을 사용하면 이 어댑터를 수정해야 합니다. 실제 배포 호환성은 점검 요청과 통화로 확인하세요.

- `POST {STRATA_BASE_URL}/chat/completions`
- JSON 입력: `model`, `messages` (`system`, `user`, `assistant`), `stream`, `max_tokens`, `reasoning_effort: "none"`.
- 모든 답변과 연결 점검 요청에 `reasoning_effort: "none"`을 보내 Strata의 thinking을 끕니다. [Strata 공식 API 설정](https://github.com/Niko1221/Strata/blob/main/docs/DETAILS.md#api)을 사용하며 별도 `.env` 설정은 필요 없습니다.
- `stream:false` 점검: `choices[0].message`를 포함한 JSON.
- `stream:true` 대화: `text/event-stream`, `data:` 이벤트의 `choices[0].delta.content` 텍스트, `finish_reason` 또는 `[DONE]` 종료 표시.
- `STRATA_API_KEY`가 있을 때만 로컬 요청에 Bearer 인증을 넣습니다. ElevenLabs 키는 Strata로 보내지 않습니다.
- `reasoning_content` 등 별도 추론 필드는 읽지 않습니다. 모델의 최종 답변만 `content`에 보내도록 서버의 채팅 템플릿을 설정하세요. 도구 호출은 지원하지 않습니다.
- ElevenLabs LLM으로 자동 우회하지 않습니다. 로컬 서버 오류는 표시하고 세션을 종료합니다.

## 3. 음성과 대화 처리

Discord 음성을 24 kHz 모노 PCM16으로 받아 ElevenLabs **Scribe v2 Realtime**에 보냅니다. 서버 VAD가 발화를 나누고 최종 전사문이 도착하면, 봇이 캐릭터 프롬프트와 서버별 대화 이력을 Strata로 보냅니다.

- 음성 인식: `scribe_v2_realtime`, `commit_strategy=vad`. 최종 `committed_transcript`만 대화 입력으로 사용합니다. 타임스탬프 부가 이벤트는 중복 입력하지 않습니다.
- 음성 합성: 기본 `eleven_multilingual_v2`. 문장마다 ElevenLabs에서 `pcm_24000` 오디오를 끝까지 받은 뒤 검증하고 재생 대기열에 넣습니다. 각 문장 전체를 기다리므로 첫 소리가 나오기까지 합성 시간이 필요합니다.
- 재생: 완성된 PCM을 48 kHz 스테레오 Opus 패킷으로 직접 인코딩합니다. 마지막 20 ms 프레임은 무음으로 채우고 같은 코덱으로 무음 한 프레임을 더 인코딩해 지연된 마지막 샘플도 내보냅니다. 라이브 PCM→Transform→Encoder 파이프라인을 사용하지 않으며, 합성 지연은 문장 사이 대기로 처리합니다. 합성 한 조각은 120초, 재생 대기열은 8 MiB로 제한합니다.
- 자동 끼어들기: 첫 비어 있지 않은 부분 전사문을 받으면 Strata 요청·TTS 요청·Discord 재생을 취소합니다. Scribe는 별도 발화 시작 이벤트를 보내지 않으므로 인식 지연만큼 끼어들기가 늦어질 수 있습니다. 새 사용자 음성은 계속 수신합니다.
- 대화 기억: 서버별 메모리에만 보관합니다. `HISTORY_MAX_CHARS`를 넘으면 오래된 발화부터 제거하고 캐릭터 프롬프트와 현재 발화는 유지합니다. 이 값은 **문자 수이며 토큰 수가 아닙니다.** 배포 모델의 문맥 한도에 맞춰 조절하세요.
- 들려주지 않은 답변: TTS에 단어별 재생 시각 정보가 없으므로 끼어들기 시 **끝까지 재생된 문장 조각만** 이력에 남깁니다. 중간에 끊긴 문장의 들린 앞부분도 보수적으로 제외합니다.
- `/ai stop`: 미처리 전사문, 현재 입력, 생성·재생을 모두 취소합니다. STT 소켓을 교체하고 이전 소켓의 늦은 전사문을 버립니다. 새 세션이 준비될 때까지 짧게 입력을 중단합니다. `/ai reset`: 새 세션을 열고 대화 기억을 초기화합니다.
- 여러 서버는 하나의 로컬 추론 동시 실행 한도를 공유합니다 (`STRATA_MAX_CONCURRENT`, 기본 1). 대화 이력과 음성은 서버별로 분리됩니다.
- 사람끼리 겹친 음성은 혼합됩니다. 화자 분리 기능이 아닙니다. 헤드셋을 권장합니다.

## 4. 명령어

| 명령어 | 기능 |
| --- | --- |
| `/ai join`, `/ai leave` | 음성채널 입장·퇴장 |
| `/ai act text:손을 흔들며 웃는다` | 사용자 행동을 Strata에 전달하고 캐릭터가 음성으로 반응 |
| `/ai persona` | 캐릭터 프롬프트 입력, 최대 4,000자 |
| `/ai reload` | `persona.txt` 다시 읽기, 최대 12,000자 |
| `/ai model name:org/model` | 이 서버의 **Strata LLM 모델** 선택 |
| `/ai voice name:default` | 환경변수의 목소리 선택 (또는 실제 ElevenLabs Voice ID 입력) |
| `/ai speed value:1.0` | 말하기 속도 0.7~1.2배 |
| `/ai volume percent:80` | 볼륨 0~200% |
| `/ai silence seconds:1.2` | 발화 끝 침묵 감지 0.3~3초 |
| `/ai sensitivity threshold:0.5` | VAD 감지 기준 0.1~0.9 |
| `/ai overlap enabled:True` | 겹친 참가자 음성 혼합 |
| `/ai interrupt enabled:True` | AI 발화 중 자동 끼어들기 |
| `/ai listen enabled:True` | 내 음성 수신 설정을 사용자·서버별로 저장 (`False`: 해제) |
| `/ai stop`, `/ai reset` | 현재 발화 취소·기억 초기화 |
| `/ai status` | LLM·음성 서비스 및 설정 확인 |

목소리는 ElevenLabs Voice ID를 입력합니다. `default`는 `.env`의 `ELEVENLABS_VOICE_ID`를 사용합니다. 기존 OpenAI 목소리 이름은 자동으로 `default`로 이전합니다.

볼륨·침묵·겹침·끼어들기·감지 기준 변경은 기억을 유지합니다. 모델·목소리·속도·프롬프트 변경은 새 세션을 열며 기억을 초기화합니다. 모델·프롬프트 변경의 연결 점검에 실패하면 기존 연결과 설정을 유지합니다. 침묵·감지 기준 변경은 STT 소켓을 다시 연결하므로 진행 중인 미확정 음성과 재연결 중 입력은 버립니다. 재연결에 실패하면 오류를 표시하고 종료합니다. 목소리의 실제 합성 권한은 첫 발화 때 확인합니다. 설정은 `data/<서버ID>.json`에 저장됩니다. 모델 ID는 Strata가 실제 서비스하는 ID여야 하며 `/`도 허용합니다.

`/ai listen`의 켜짐·꺼짐은 `data/listening/<서버ID>.json`에 Discord 사용자 ID별로 저장합니다. 봇을 재시작한 뒤에도 다음 `/ai join`에서 복원되며, `/ai reset`과 캐릭터 설정 변경으로 지워지지 않습니다. 저장된 꺼짐은 봇을 부른 사용자에게도 적용됩니다. 봇과 같은 채널에 있는 사람만 수신하며 `ALLOWED_USER_IDS`에 맞지 않는 사용자와 봇은 자동 참여하지 않습니다. 다른 서버의 선택은 서로 독립적입니다. `/ai status`에서 자신의 저장 설정과 현재 수신 여부를 확인할 수 있습니다. 설정을 계속 유지하려면 배포 시 `data/` 디렉터리를 보존하세요.

기본적으로 봇을 부른 사용자(같은 음성채널)와 서버 관리자만 설정을 바꿀 수 있습니다. `ALLOWED_USER_IDS`를 지정하면 명령 사용자를 제한할 수 있습니다. 채널에서 나가면 현재 수신을 중지하며 저장한 선택은 유지합니다. 다시 봇과 같은 음성채널에 들어오거나 봇을 재연결하면 개인별 설정을 복원합니다. 스테이지 채널은 지원하지 않습니다.

`/ai act text:손을 흔들며 웃는다`처럼 입력하면 작성자의 서버 표시 이름과 함께 **대사가 아닌 사용자 행동**으로 Strata에 전달됩니다 (최대 2,000자, 중괄호 불필요). 행동은 현재 대화 이력에 남고 캐릭터의 답변만 ElevenLabs TTS로 읽습니다. 캐릭터 프롬프트나 TTS 말투 설정을 바꾸는 명령은 아닙니다. 봇과 같은 음성채널에 있는 허용된 사용자는 마이크 수신 참여 없이 사용할 수 있습니다. 발화나 응답이 진행 중이면 기다렸다가 처리하며, 그동안 들어온 행동과 전사문은 다음 입력에 함께 포함될 수 있습니다. `/ai stop`은 대기 중인 행동도 취소하고 `/ai reset`은 행동을 포함한 대화 기억을 지웁니다. 업데이트 후 봇을 재시작하면 새 명령이 등록됩니다.

## 5. 선택 설정과 문제 해결

전체 항목은 `.env.example`을 참고하세요.

| 설정 | 기본값 / 의미 |
| --- | --- |
| `ELEVENLABS_STT_LANGUAGE` | 빈 값: 자동 인식, `ko`: 한국어 힌트 |
| `ELEVENLABS_TTS_MODEL` | `eleven_multilingual_v2`: 합성 모델 |
| `ELEVENLABS_TIMEOUT_MS` | 60000: 문장별 합성 요청 시간 한도 |
| `STRATA_MAX_TOKENS` | 128000: 한 답변의 최대 출력 토큰 수 (Strata 모델이 지원하는 한도에 따름) |
| `STRATA_TIMEOUT_MS` | 60000: 추론 대기열과 응답 스트림 시간 한도 |
| `RESPONSE_TIMEOUT_MS` | 180000: 합성을 포함한 전체 응답 시간 한도 |
| `HISTORY_MAX_CHARS` | 24000: 프롬프트와 최근 대화의 문자 예산 |
| `IDLE_MINUTES` | 10: 대화가 없을 때 퇴장 |
| `SPEECH_SESSION_MINUTES` | 55 (1~55): 온라인 전사 세션 종료 전 퇴장 |

Strata 연결이 실패하면 주소·포트·모델 ID·선택적 인증과 로컬 서버 로그를 확인하세요. 봇을 실행하는 PC가 Strata에 접속할 수 있어야 합니다. 음성 연결은 ElevenLabs API 키와 전사 모델 권한을, 합성 오류는 TTS 모델·목소리를 확인하세요. 설정 변경 후 봇을 재시작합니다.

## 6. 데이터와 검증

참여자의 원본 음성은 ElevenLabs로 전송됩니다. 전사문과 캐릭터 프롬프트·대화 이력은 설정한 Strata 서버로 전송됩니다. 생성된 답변 텍스트는 ElevenLabs로 보내 음성으로 합성합니다. 따라서 LLM만 로컬화되며 **음성과 대화문 전체가 로컬에만 머무르는 구성은 아닙니다.** 봇은 원본 음성·대화문을 로컬 파일에 기록하지 않습니다. ElevenLabs와 Strata 자체의 로그·보관 정책은 각각의 서비스 설정을 따릅니다. 응답은 AI가 만든 목소리이며 음성채널 전체에 들립니다.

`npm test`는 실제 Discord AudioPlayer의 자연 종료·취소·문장 간 지연·Opus 코덱·Discord 브리지·참가자 필터·서버 격리·설정 이전과 새 어댑터의 HTTP/SSE·자격 증명 분리·최종 전사 처리·끼어들기·늦은 응답 차단·이력 처리를 검사합니다. 외부 Discord 연결/ElevenLabs/Strata 호출은 모의 처리하며 HTTP 계약 검사는 로컬 테스트 서버를 사용합니다. GitHub Actions는 Windows와 Linux에서 실행합니다.

배포 전 실제 점검: `/ai join` → 한국어 대화 → 다음 질문으로 기억 확인 → 응답 도중 끼어들기 → `/ai stop` 후 늦은 답변이 나오지 않는지 확인 → 두 번째 서버 동시 접속 → 잘못된 `/ai model` 변경 후 기존 대화가 유지되는지 확인 → `/ai reset` → `/ai leave`. 실제 사용자의 Strata 배포와 Discord/ElevenLabs 통화는 인증 정보와 실행 환경을 넣어 별도로 확인해야 합니다.

공식 API 참고: [Scribe Realtime](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime), [STT 이벤트](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference), [음성 합성](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
