# v2 업데이트 방법

1. 기존 봇 실행 창에서 `Ctrl+C`로 종료합니다.
2. 새 ZIP을 **새 폴더**에 풉니다.
3. 기존 폴더의 `.env`, `persona.txt`, `data` 폴더를 새 폴더로 복사합니다. `node_modules`는 복사하지 않습니다.
4. 새 폴더의 `.env`에 아래 한 줄을 추가하거나 수정합니다.

```dotenv
DISCORD_GUILD_IDS=첫번째서버ID,두번째서버ID
```

초대된 모든 서버에서 쓰려면 `DISCORD_GUILD_IDS=*`로 설정합니다. 새 `DISCORD_GUILD_IDS`가 있으면 기존 `DISCORD_GUILD_ID`보다 우선합니다. 서버마다 같은 봇을 초대해야 합니다.

5. 새 폴더의 `start.cmd`를 실행합니다. 새 명령어는 자동 등록됩니다. 각 서버에서 `/ai join`으로 시작하세요.

기존 캐릭터·목소리·볼륨 설정은 유지되며 새 항목은 자동 보충됩니다. 초기값은 **침묵 0.85초 / 겹침 수신 켜기 / 자동 끼어들기 켜기 / 감지 기준 0.5**입니다.

| 바꾸려는 설정 | 예시 |
| --- | --- |
| 말을 마친 뒤 1.5초 기다리기 | `/ai silence seconds:1.5` |
| 겹친 목소리 함께 듣기 | `/ai overlap enabled:True` |
| 먼저 말한 사람 우선 듣기 | `/ai overlap enabled:False` |
| 말로 AI 답변에 끼어들기 | `/ai interrupt enabled:True` |
| AI 답변 도중에는 듣지 않기 | `/ai interrupt enabled:False` |
| 서버별 모델 변경 | `/ai model name:gpt-realtime-1.5` |
| 배경 소리에 덜 반응하기 | `/ai sensitivity threshold:0.7` |
| 현재 설정 보기 | `/ai status` |

겹침 수신은 **사람과 사람**, 자동 끼어들기는 **사람과 AI**가 동시에 말하는 상황을 조절합니다. 두 설정은 독립적입니다. 다른 참가자는 먼저 `/ai listen enabled:True`로 참여해야 합니다.

침묵 시간·겹침·끼어들기·감지 기준 변경은 대화 기억을 유지합니다. 모델·목소리·속도·프롬프트 변경은 새 대화로 시작합니다. 모델은 Realtime 음성 대화와 호환되어야 하며 사용 가능 여부는 API 계정 권한에 따라 달라집니다.

자동 검사 28개를 통과했습니다. 실제 디스코드 통화 품질과 동시 발화 인식률은 봇 토큰·API 키를 넣은 뒤 확인해야 합니다. 동시 발화는 음성 혼합 방식으로 전달하며 완벽한 화자 분리를 보장하지 않습니다.
