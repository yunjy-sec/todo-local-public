# CLAUDE.md — 이 저장소에서 일하는 법

## 무엇이 정답인가 (SSoT 우선순위)

1. **현재 코드** — 지금 동작의 진실은 코드다. 문서와 다르면 문서가 낡은 것이다.
2. **이 파일** — 소유권 지도, 불변 규약, 검사 명령.
3. **`docs/ARCHITECTURE.md`** — 설계 의도(왜 이 모양인가).
4. **`docs/PLAN.md`** — 로드맵과 구글 캘린더 벤치마크(무엇을 안 만들기로 했는가).

충돌하면 위가 이긴다. 낡은 스냅샷 문서를 트리에 쌓지 않는다 — 역사는 git 이 갖고 있다.

## 소유권 지도 (여기 적으면 안 되는 것)

| 파일 | 소유 | 금지 |
|---|---|---|
| `app/shared/contracts.js` | 닫힌 어휘, 원격 API 경로, `validate*()` | 등록 항목 목록(그건 registry 의 일) |
| `app/shared/registry.js` | 모든 등록표 + `verify()` | DOM · 네트워크 · fs · electron require |
| `app/main/**` | 실행(창·알람·상태·저장) | DOM API |
| `app/renderer/**` | 화면 | Node/Electron API — `window.api` 관문만 |
| `app/preload.js` | IPC allowlist(등록표에서 파생) | 채널 목록을 손으로 적기 |
| `app/main/storage.js` | 파일 IO 유일 관문 | — |
| `app/main/sync/**` | 네트워크 유일 관문(옵션) | — |
| `src/**` | Phase 1 C# 구현(폐쇄망 레퍼런스) | C# 6+ 문법(내장 csc 는 C# 5) |

## 바꾸면 안 되는 것

- **key** — IPC 채널명·설정 키·`extendedProperties.private` 키. 이미 저장된 데이터와 배포된 창에 박혀 있다. 이름이 마음에 안 들면 `label` 을 고친다.
- **GCal 스키마 호환** — `todos.json` 은 구글 캘린더 `events.list` 형태다. 앱 전용 값은 반드시 `extendedProperties.private` 에, 반드시 **문자열로**. 새 키는 `PRIVATE_FIELDS` 에 등록해야 쓸 수 있다(`lint:private-fields`).
- **폐쇄망 불변식** — 네트워크는 `app/main/sync/` 와 `tools/sync-server.mjs` 안에서만. 기본값은 동기화 꺼짐이고, 꺼져 있으면 그 모듈은 require 되지도 않는다(`lint:network`).
- **테스트는 실사용 원장을 만지지 않는다** — 데이터 디렉터리는 `TODO_DATA_DIR` 로 주입한다. 기본값은 `%APPDATA%\TodoPopup`.

## 새 것을 추가하는 절차

**새 IPC 채널**: `registry.IPC_CHANNELS` 에 한 줄 → `main.js` 에 `handle('<key>', …)` → 창에서 `window.api.invoke('<key>')` → `npm run lint:ipc` 초록.
등록만 하고 구현을 다음 라운드로 미루면 `lint-ipc.mjs` 의 `UNIMPLEMENTED_INVOKE` 에 넣고, 구현되는 순간 빼야 한다(검사가 강제한다).

**새 설정**: `registry.SETTINGS_FIELDS` 에 한 줄(기본값·범위 포함) → `list.html` 설정 패널에 컨트롤 → `npm run lint:settings`. 기본값과 clamp 는 등록표에서 저절로 나온다.

**새 private 속성**: `registry.PRIVATE_FIELDS` 에 한 줄(무엇을 담는지) → `model.priv(ev).<key>` 로 접근. 값은 문자열만.

**새 검사**: `scripts/lint-<이름>.mjs`(머리주석에 "막는 사고"를 적는다) → `package.json` scripts → `scripts/lint-all.mjs` CHECKS → `registry.TESTING.checks`. **네 자리 전부**. `ci.yml` 은 `npm run lint` 경유라 손대지 않는다. `lint:ci` 가 이 넷을 대조한다.

## 검사

```bash
cd app
npm run check      # 문법
npm run lint       # 가드레일 10종
npm test           # 단위·회귀 81건
npm run check:ui   # 실제 창 스모크 19항목 (CDP)
```

C# 쪽: `build.cmd` → `TodoPopup.exe`. CI 는 `windows-latest` 에서 위 전부 + C# 빌드·파서 시험.

## 사고가 나면

세 가지를 같이 한다. (1) 주석에 무슨 일이 있었는지 적고 (2) 그것을 lint 나 테스트로 고정하고 (3) 실패 메시지에 **고칠 자리**를 넣는다. 이 저장소의 lint 머리주석은 전부 실제 사고 기록이다.

## 유예(allowlist)는 방패가 아니다

검사를 통과시키려고 예외를 넣었다면, 그 예외의 근거가 사라졌을 때 검사가 **실패하도록** 만든다. 실제로 그렇게 동작한다 — R4 에서 동기화가 도착하자 세 개의 유예가 스스로 낡았다고 신고했고, 그래서 걷어냈다.
