# CLAUDE.md — 이 저장소에서 일하는 법

## 먼저: 이 트리는 생성물이다

여기는 **통신을 물리적으로 제거한 빌드**이고, 상류 저장소에서 스크립트로 생성된다.
여기에 직접 커밋한 수정은 다음 생성 때 사라진다. **고칠 것은 상류에 고친다.**

감사 절차는 [docs/AUDIT.md](docs/AUDIT.md), 확인은 한 줄이다:

```bash
cd app && npm run audit
```

## 무엇이 정답인가 (SSoT 우선순위)

1. **현재 코드** — 지금 동작의 진실은 코드다. 문서와 다르면 문서가 낡은 것이다.
2. **이 파일** — 소유권 지도, 불변 규약, 검사 명령.
3. **`docs/AUDIT.md`** — 무엇을 왜 제거했고 무엇이 왜 남았는가.

## 소유권 지도 (여기 적으면 안 되는 것)

| 파일 | 소유 | 금지 |
|---|---|---|
| `app/shared/contracts.js` | 닫힌 어휘, `validate*()` | 등록 항목 목록(그건 registry 의 일) |
| `app/shared/registry.js` | 모든 등록표 + `verify()` | DOM · 네트워크 · fs · electron require |
| `app/main/**` | 실행(창·알람·상태·저장) | DOM API |
| `app/renderer/**` | 화면 | Node/Electron API — `window.api` 관문만 |
| `app/preload.js` | IPC allowlist(등록표에서 파생) | 채널 목록을 손으로 적기 |
| `app/main/storage.js` | 파일 IO 유일 관문 | — |
| `src/**` | Phase 1 C# 구현 | C# 6+ 문법(내장 csc 는 C# 5) |

## 바꾸면 안 되는 것

- **네트워크 0** — 이 빌드에는 통신하는 코드가 한 줄도 없어야 한다. `lint:network` 가
  관문 0개 모드로 돌며 트리 전체를 본다. `npm run audit` 이 같은 것을 감사관의 눈으로 다시 본다.
- **key** — IPC 채널명·설정 키·`extendedProperties.private` 키. 이미 저장된 데이터에 박혀 있다.
  이름이 마음에 안 들면 `label` 을 고친다.
- **GCal 스키마 호환** — `todos.json` 은 구글 캘린더 `events.list` 형태다(접속하지는 않는다).
  앱 전용 값은 `extendedProperties.private` 에 문자열로. 새 키는 `PRIVATE_FIELDS` 에 등록해야 쓸 수 있다.
- **테스트는 실사용 원장을 만지지 않는다** — 데이터 디렉터리는 `TODO_DATA_DIR` 로 주입한다.
  기본값은 `%APPDATA%\TodoPopup`.

## 검사

```bash
cd app
npm run check      # 문법
npm run lint       # 가드레일 11종
npm test           # 단위·회귀 129건
npm run check:ui   # 실제 창 스모크 25항목 (CDP)
npm run audit      # 통신 흔적 감사 — 이 빌드의 존재 이유
```

C# 쪽: `build.cmd` → `TodoPopup.exe`.

## 사고가 나면

세 가지를 같이 한다. (1) 주석에 무슨 일이 있었는지 적고 (2) 그것을 lint 나 테스트로 고정하고
(3) 실패 메시지에 **고칠 자리**를 넣는다. 이 저장소의 lint 머리주석은 전부 실제 사고 기록이다.

단, 그 수정은 **상류에서** 한다. 여기서 고치면 다음 생성 때 사라진다.

## 유예(allowlist)는 방패가 아니다

검사를 통과시키려고 예외를 넣었다면, 그 예외의 근거가 사라졌을 때 검사가 **실패하도록** 만든다.
실제로 그렇게 동작한다 — 이 트리를 처음 생성했을 때 상류에만 있는 디렉터리를 가리키던 유예가
스스로 낡았다고 신고했고, 그래서 생성기가 그것도 함께 걷어내게 됐다.
