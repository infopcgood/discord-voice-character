# 디스코드 음성 캐릭터 봇 v2

디스코드 음성채널에서 사람의 말을 듣고, OpenAI가 생성한 목소리로 답하는 프로그램입니다. Windows에서 `start.cmd`로 실행하고 디스코드의 `/ai` 명령어로 조작합니다.

**구현 완료 · 자동 검사 28개 통과 · 실제 디스코드/OpenAI 통화는 미검증**입니다. 봇 토큰과 API 키는 들어 있지 않습니다. 기존 사용자는 먼저 [v2 업데이트 안내](UPDATE-v2.md)를 읽어 주세요.

## 1. 처음 한 번만 설정하기

1. [Node.js](https://nodejs.org/) **24 LTS**를 설치합니다. 설치 후 실행 중인 터미널을 다시 열어 주세요.
2. [Discord Developer Portal](https://discord.com/developers/applications)에서 **New Application**으로 앱을 만듭니다. **Bot → Reset Token**에서 봇 토큰을 발급하고, **General Information → Application ID**도 복사합니다.
3. **OAuth2 → URL Generator**에서 `bot`, `applications.commands`를 선택합니다. 권한은 **View Channels, Send Messages, Connect, Speak**를 선택하고 생성된 주소로 원하는 서버마다 같은 봇을 초대합니다. 관리자 전체 권한이나 Message Content Intent는 필요 없습니다.
4. 디스코드 **사용자 설정 → 고급 → 개발자 모드**를 켜고, 서버 아이콘을 오른쪽 클릭해 **서버 ID 복사**를 선택합니다.
5. [OpenAI API 키 페이지](https://platform.openai.com/api-keys)에서 키를 발급하고 API 결제/사용 한도를 설정합니다. 이 프로그램은 ChatGPT 앱이 아니라 **별도 사용량 과금 방식의 OpenAI API**에 연결합니다. [API 요금 안내](https://developers.openai.com/api/docs/pricing)
6. 압축을 풀고 `start.cmd`를 실행합니다. 처음에는 `.env` 파일이 만들어지고 메모장이 열립니다. 아래 값을 채워 저장합니다. 서버 목록은 선택 사항이며, 비워 두면 초대된 모든 서버를 허용합니다. 토큰이나 키는 채팅에 올리지 마세요.

```dotenv
DISCORD_TOKEN=디스코드_봇_토큰
DISCORD_CLIENT_ID=Application_ID
DISCORD_GUILD_IDS=첫번째_서버_ID,두번째_서버_ID
OPENAI_API_KEY=OpenAI_API_키
```

7. `start.cmd`를 다시 실행합니다. 필요한 구성 요소 설치와 명령어 등록 후 봇이 켜집니다. 창을 열어 둔 상태에서 각 서버의 음성채널에 들어가 `/ai join`을 실행하세요. 프로그램 하나로 여러 서버의 대화를 동시에 처리합니다. 봇 시작 시와 새로운 서버에 초대될 때 명령어가 자동 등록됩니다.

봇은 **이 프로그램을 실행 중인 PC가 켜져 있을 때** 동작합니다. 실행 창에서 `Ctrl+C`를 누르면 종료합니다. 24시간 사용하려면 상시 켜진 PC나 서버가 필요합니다.

## 2. 디스코드에서 사용하는 명령어

| 명령어 | 기능 |
| --- | --- |
| `/ai join` | 내 음성채널에 입장하고 내 음성을 듣기 시작 |
| `/ai leave` | 퇴장하고 현재 대화 종료 |
| `/ai persona` | 캐릭터 프롬프트 입력 창 열기, 최대 4,000자 |
| `/ai reload` | `persona.txt`를 다시 읽기, 최대 12,000자 |
| `/ai voice name:marin` | 목소리 선택 |
| `/ai volume percent:80` | 볼륨 0~200%, 기본 80% |
| `/ai speed value:1.0` | 말하기 속도 0.25~1.5배 |
| `/ai silence seconds:1.2` | 말이 끝난 후 침묵 대기 0.2~5초, 기본 0.85초 |
| `/ai overlap enabled:True` | 겹친 참가자 음성을 함께 듣기, 기본 켜기 |
| `/ai interrupt enabled:True` | AI가 말하는 중 내 발화로 자동 끼어들기, 기본 켜기 |
| `/ai model name:gpt-realtime-1.5` | 이 서버의 Realtime 음성 모델 선택 |
| `/ai sensitivity threshold:0.5` | 발화 감지 기준 0.1~0.9, 높을수록 작은 소리를 무시 |
| `/ai stop` | 현재 듣는 발화와 AI 응답 중지 |
| `/ai reset` | 대화 기억 초기화 |
| `/ai listen enabled:True` | 다른 참가자가 자신의 음성 전송을 켜기 |
| `/ai listen enabled:False` | 자신의 음성 전송 끄기 |
| `/ai status` | 연결과 설정 확인 |

목소리: `marin`, `cedar`, `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`.

볼륨은 재생 중에도 바뀝니다. **침묵 시간·겹침 수신·자동 끼어들기·감지 기준은 대화 기억을 유지하며 적용**됩니다. **모델·목소리·속도·프롬프트 변경은 새 API 세션을 열므로 기억이 초기화**됩니다. 새 연결이 실패하면 기존 연결과 설정을 유지합니다. 설정은 서버별 `data/서버ID.json`에 저장되어 재실행해도 유지됩니다.

## 3. 캐릭터 설정

처음 연결할 때 `persona.txt`가 기본 프롬프트입니다. 파일을 원하는 내용으로 바꿔 놓거나, 입장 후 `/ai persona`를 사용하세요. 서버별 저장 설정이 이미 있으면 파일을 수정한 뒤 `/ai reload`로 적용합니다.

예시:

```text
너는 달빛 도서관의 사서 루나다.
한국어로 차분하고 다정하게 말하고 가끔 짧은 농담을 한다.
평소에는 두 문장 이내로 답하고, 설명을 요청받으면 자세히 말한다.
듣지 못한 말은 추측하지 말고 다시 물어본다.
너는 AI가 연기하는 가상의 캐릭터다.
```

프롬프트로 말투·성격·관계·배경을 설정할 수 있습니다. 음색은 제공된 목소리 목록에서 선택합니다. 음성 복제, 외부 음성 파일 학습, 독립적인 피치 조절 기능은 포함하지 않았습니다.

## 4. 대화 방식과 범위

- OpenAI의 발화 감지(VAD)가 설정된 침묵 시간만큼 말이 없다고 판단한 뒤 응답을 요청합니다. 실제 답변 시작까지는 네트워크와 모델 처리 시간이 더 걸립니다. 기본 0.85초이며 `/ai silence`로 변경합니다.
- **겹침 수신 켜기:** 여러 참가자의 같은 시간대 음성을 혼합해 전달합니다. **끄기:** 먼저 말한 사람의 음성을 우선 전달하며, 약 0.2초 동안 조용하면 다음 사람으로 넘깁니다. 제외한 발화를 나중에 재생하지 않습니다. v1의 20초 발화 제한은 제거했습니다.
- **자동 끼어들기 켜기:** AI가 말하는 중에도 듣습니다. 사용자 발화가 감지되면 AI 생성·재생을 중단하고, 들려주지 않은 답변을 대화 문맥에서 잘라냅니다. 사용자가 말을 마치면 이어서 응답합니다. **끄기:** AI가 생성하거나 재생하는 동안의 사용자 음성을 버립니다. 수동 `/ai stop`도 사용할 수 있습니다.
- 겹친 음성을 전달하는 기능이며, 동시 발화를 완벽히 분리하거나 누가 무엇을 말했는지 정확히 식별하는 화자 분리 기능은 아닙니다. 스피커 소리가 마이크로 다시 들어오면 AI가 자기 목소리에 반응할 수 있어 헤드셋 사용을 권장합니다. 잡음에 자주 끊기면 `/ai sensitivity threshold:0.7`처럼 기준을 높여 보세요.
- 처음에는 `/ai join`을 실행한 사람만 수신합니다. 다른 사람은 `/ai listen`으로 참여합니다. 채널을 나가면 참여 설정이 해제됩니다. 응답은 채널 전체에 들리며 참가자는 하나의 대화 문맥을 공유합니다.
- 서로 다른 서버의 음성·설정·대화 기억은 분리됩니다. 서버마다 하나의 음성채널에 연결할 수 있습니다. 동시에 연결한 서버 수만큼 PC 자원과 API 사용량이 늘어납니다.
- 기본적으로 봇을 부른 사용자(같은 음성채널에 있어야 함)와 서버 관리자만 캐릭터 설정·퇴장·초기화를 할 수 있습니다.
- `.env`의 `ALLOWED_USER_IDS=사용자ID1,사용자ID2`를 지정하면 해당 사용자들만 봇 명령어를 사용할 수 있습니다. 비워 두면 서버 멤버가 사용할 수 있습니다.
- 대화가 10분 없으면 자동 퇴장합니다. `.env`의 `IDLE_MINUTES`로 변경할 수 있습니다. API 세션을 연 뒤 55분에도 퇴장하며 `/ai join`으로 새 대화를 시작합니다.
- 원본 음성이나 대화문을 로컬 파일에 기록하지 않습니다. 수신 대상으로 선택된 음성은 응답 생성을 위해 OpenAI로 전송됩니다. 캐릭터 프롬프트는 로컬 파일과 API 세션에 포함됩니다.
- 기본 모델은 `gpt-realtime-1.5`입니다. `/ai model`에는 계정에서 사용 가능한 **Realtime 음성 대화 모델 ID**를 입력합니다. 일반 텍스트 모델, GPT-Live 전용 모델, 전사 전용 모델은 이 연결 방식과 호환되지 않습니다. 연결 중 변경하면 새 모델 접속 성공 후 저장하고, 퇴장 상태에서 저장하면 다음 입장 때 사용 가능 여부를 확인합니다. `.env`의 `OPENAI_REALTIME_MODEL`은 아직 모델이 저장되지 않은 서버의 기본값입니다. ChatGPT 앱의 저장된 대화·메모리·커스텀 GPT 설정은 자동 연동되지 않습니다.
- 일반 음성채널을 지원하며 스테이지 채널은 제외합니다. Discord의 음성 수신 동작은 변경될 수 있으므로 플랫폼 업데이트 후 재검증이 필요할 수 있습니다.

## 5. 문제가 생기면

| 증상 | 확인할 것 |
| --- | --- |
| `/ai`가 안 보임 | Application ID·서버 목록·초대 범위 확인 후 봇 재시작. 콘솔의 서버별 등록 오류 확인 |
| 입장 실패 | 채널별 덮어쓰기 권한까지 보기·연결·말하기 허용 확인 |
| 내 말을 안 들음 | `/ai status`, 내 마이크 음소거, `/ai listen enabled:True` 확인. 자동 끼어들기를 끈 경우 AI 답변 후 말하기 |
| 두 번째 서버에서 안 됨 | 봇 초대 후 `.env`에 `DISCORD_GUILD_IDS=서버1ID,서버2ID` 또는 `DISCORD_GUILD_IDS=*`를 추가하고 재시작 |
| 답변이 너무 빨리/늦게 시작 | `/ai silence seconds:1.2`로 침묵 시간 조절 |
| AI가 자꾸 끊김 | 마이크의 스피커 반향·배경 소음 확인, 감지 기준 높이기 또는 자동 끼어들기 끄기 |
| API 연결 실패 | 키·API 결제 상태·모델 접근 권한·네트워크 확인 |
| DAVE 또는 코덱 오류 | Node.js 24 LTS 사용 여부와 `npm run check` 결과 확인, `npm install` 재실행 |
| 연결이 끊김 | 오류 안내 확인 후 `/ai join`. 대화 기억은 새로 시작 |

## 개발/검증

터미널에서 직접 실행할 수도 있습니다.

```sh
npm install
npm run register
npm start
```

`npm test`: 오디오 혼합·클리핑 방지·실제 Opus 변환·참가자 필터링·VAD 이벤트·자동 끼어들기·늦은 응답 차단·모델 변경 실패 복구·서버 간 격리·설정 이전 등 28개 검사. Discord 및 OpenAI 네트워크 호출은 모의 처리합니다.

`npm run check`: 코덱/DAVE와 필수 환경변수 점검. 키의 유효성까지 확인하는 명령은 아닙니다. 이 프로젝트는 FFmpeg를 사용하지 않으므로 FFmpeg가 없다는 보고는 정상입니다.

검증 환경: Windows / Node.js 24.19.0 / discord.js 14.27.0 / @discordjs/voice 0.19.2 / @snazzah/davey 0.1.12. 설치한 버전은 `package.json`에 고정했고, pnpm용 잠금 파일도 포함했습니다.

실제 통화 점검: 두 서버에서 각각 `/ai join` → 서로 다른 모델/프롬프트로 대화 → 각 서버에서 두 번째 사용자 `/ai listen` → `/ai overlap` 켜기/끄기로 동시에 말하기 → AI 답변 중 말해서 자동 끼어들기 확인 → `/ai silence` 0.5초/2초 비교 → `/ai leave`. 한 서버의 종료가 다른 서버의 대화에 영향을 주지 않는지도 확인하세요.

공식 참고: [OpenAI Realtime 음성 대화와 끼어들기](https://developers.openai.com/api/docs/guides/realtime-conversations), [발화·침묵 감지](https://developers.openai.com/api/docs/guides/realtime-vad), [Discord 음성 라이브러리](https://discord.js.org/docs/packages/voice/main), [봇 명령어 등록](https://docs.discord.com/developers/docs/interactions/slash-commands).
