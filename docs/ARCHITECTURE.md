# 아키텍처 — 견고화 설계 (Phase 2.5)

작성: 2026-08-20 · 상태: **승인 대기**
참조: `../study-treasurer`(검증·동적 로딩), `../fire-claude`(보일러플레이트 규약), `../cicd-todo`(guardrail lint·CI·문서 거버넌스), `../_global`(서비스 레지스트리)

## 0. 채택하는 핵심 교리

1. **3층 소유권 분리** — 계약은 `contracts`, 등록은 `registry`, 실행은 `main/`·`renderer/`. 등록표는 DOM·네트워크·fs를 모른다(데이터와 순수 함수만).
2. **부팅 즉시 `verify()`** — 문자열 배열을 반환하고(절대 throw 하지 않음), 부팅 코드가 배열이 비지 않으면 터뜨린다. main과 renderer 양쪽 진입 첫 줄.
3. **하드코딩 금지** — IPC 채널명, 설정 키, 데이터 파일명, `extendedProperties.private` 키는 등록표에만 산다. lint가 등록과 사용처를 양방향 1:1로 결박한다.
4. **부수효과 관문 단일화** — renderer→main은 preload 관문 하나(등록된 채널만), 파일 쓰기는 `storage.js` 하나, 네트워크는 `main/sync/` 디렉터리 하나(옵션 기능 전용).
5. **lint는 사고 기록** — 각 lint 머리주석에 "막는 사고"를 적고, 실패 메시지에 고칠 자리를 넣는다. 새 lint는 4자리 자기등록(스크립트 + package.json + lint-all + `TESTING.checks`), `lint-ci`가 대조.
6. **테스트는 실데이터를 만지지 않는다** — `TODO_DATA_DIR` 환경변수로 데이터 디렉터리를 주입하고, CI·테스트는 픽스처 사본 위에서만 돈다.
7. **문서 통치** — 동작의 진실은 코드, 의도의 진실은 이 문서와 `CLAUDE.md`. 낡은 스냅샷 문서는 쌓지 않는다(역사는 git).

## 1. 파일 구조 (목표)

```
app/
├─ shared/                  ← main(require)과 renderer(<script>)가 같은 파일을 읽음 (UMD)
│   ├─ contracts.js         계약: enum(상태·팝업액션·반복빈도), validateEvent(), IPC 채널 계약 스키마, SYNC_API(원격 route 단일 원천)
│   ├─ registry.js          등록표 전부 + verify()
│   └─ nlp.js               (기존)
├─ main/                    실행 (Electron 메인)
│   ├─ main.js              부팅: verify → IPC 관문(레지스트리 순회 등록) → tray/scheduler/shortcuts
│   ├─ state.js·model.js·recurrence.js·scheduler.js·popups.js·windows.js·util.js
│   ├─ storage.js           파일 IO 유일 관문. dataDir = TODO_DATA_DIR || %APPDATA%\TodoPopup
│   └─ sync/                (옵션) 원격 동기화 클라이언트 — 네트워크 코드 허용 유일 지점
├─ renderer/                실행 (창들). window.api 관문만 사용
├─ preload.js               IPC_CHANNELS 등록표 기반 allowlist (와일드카드 제거)
├─ test/                    node --test 기반 (nlp, recurrence, state, storage)
└─ scripts/                 lint-*.mjs + lint-all.mjs + _load.mjs(report/diffBothWays)
tools/sync-server.mjs       (옵션) 무의존 원격 저장 서버 (node:http)
testdata/                   CI·스모크용 픽스처 (todos/calendars/settings)
.github/workflows/ci.yml
CLAUDE.md                   소유권 지도 + 불변 규약 + 검사 명령 (SSoT 우선순위 포함)
```

## 2. 등록표 (registry.js) — 이 앱의 실제 등록 대상

| 등록표 | 내용 | 파생·결박 대상 |
|---|---|---|
| `IPC_CHANNELS` | key, kind(invoke/event), 설명, 페이로드 요약 | preload allowlist 생성, main 핸들러 존재, renderer `invoke('…')` 사용처 — 3중 양방향 lint |
| `SETTINGS_FIELDS` | key, type, default, min/max, label, ui 종류, 섹션 | `clampSettings()` 파생, 설정 패널 DOM 1:1 lint |
| `POPUP_ACTIONS` | ack/snooze/done/cancel — kind별 노출, 라벨 | popup 버튼 ↔ scheduler 분기 대조 |
| `SNOOZE_PRESETS` / `QUICK_CHIPS` | 미루기 메뉴, 빠른입력 칩 | popup 메뉴·list 칩을 표에서 생성 |
| `PRIVATE_FIELDS` | `extendedProperties.private`에 허용된 키 전부(todoStatus, renotifyMinutes, snoozeUntil, notifyCount, closedAt, calendarId, instanceState, firedReminders) | **GCal 호환 보증** — 미등록 private 키 사용을 lint가 차단 |
| `DATA_STORES` | todos.json/calendars.json/settings.json 경로·스키마 kind | storage 외 fs 접근 차단 lint |
| `EVENT_COLORS` / `CAL_PALETTE` | 이벤트 11색(GCal colorId), 캘린더 14색 | detail 스와치·사이드바 팔레트 생성 |
| `CALENDAR_OPS` | add/toggle/color/… op 목록 | `calendarOp()` 분기 ↔ 사이드바 호출 대조 |
| `HOTKEYS` / `CLI_FLAGS` | 단축키 기본값, --calendar/--hidden/--test-popup | README·main 인자 처리 대조 |
| `RRULE_SUPPORT` | 지원 FREQ·필드 목록 | recurrence.js·detail 폼 옵션 대조 |
| `TESTING` | checks 목록(각 npm 명령·파일·왜) | lint-all·package.json·ci.yml 4중 대조 |
| `ARCHITECTURE` | services(= `_global` yaml 미러: 포트·publicHost·healthMatch·command), files(레이어 지도), loadOrder | `_global` 등록과 드리프트 검사(파일 존재 시) |
| `SCENARIOS` | P3 계획(계정 연결 등) registers[].status planned/done | 실물 등록표와 대조 — 설계-구현 드리프트를 lint 실패로 |

`REGISTRY_GROUPS`가 모든 export를 정확히 한 그룹에 배정(누락 시 verify 실패). key는 불변, label만 가변.

## 3. 검사 체계

### lint (scripts/, 의존성 0, `report()`/`diffBothWays()` 공용)

| 명령 | 막는 사고 |
|---|---|
| `lint:registry` | verify() + REQUIRED_EXPORTS 개수 고정 + 그룹 전수 배정 |
| `lint:ipc` | 채널 3중(등록↔main 핸들러↔renderer 호출) 어긋남 — 죽은 채널·미등록 호출 양방향 |
| `lint:settings` | 설정 필드가 기본값·클램프·설정 UI 3곳 중 한 곳에만 있는 드리프트 |
| `lint:private-fields` | 미등록 private 키 사용 → GCal 왕복 호환 파괴 |
| `lint:network` | `main/sync/`·`tools/sync-server.mjs` 밖의 net/fetch/http 사용 — **폐쇄망 불변식** |
| `lint:boundary` | renderer의 Node API 사용, main의 DOM 사용, preload 우회 |
| `lint:hardcoding` | 채널명·설정키·파일명 리터럴이 registry 밖에서 사용 |
| `lint:csharp5` | `src/*.cs`의 C#6+ 문법($"", ?., nameof, expression-bodied, out var) — 내장 csc 제약 |
| `lint:ci` | ci.yml 필수 단계 + TESTING.checks 대조 |
| `lint:docs` | 문서 속 `npm run` 실재 여부, 코드에 없는 심볼 참조 |

### test (`node --test`, 프레임워크 0)
- `nlp.test.js`·`recurrence.test.js` (기존 이식) + `state.test.js`(델타 수정·예외 위임·EXDATE 병합·shiftSeries·calendarOp) + `storage.test.js`(원자적 저장·미지 필드 왕복). 전부 `TODO_DATA_DIR`=임시 디렉터리.

### smoke (`check:ui` — CDP, Playwright 없음)
`npx electron . --remote-debugging-port` + 20줄 CDP 클라이언트. 픽스처 데이터로 기동 → 판정표 한 곳: 목록 칩 수=`QUICK_CHIPS` 등록 수, 설정 필드 수=`SETTINGS_FIELDS` 수, 사이드바 캘린더 수=calendars.json, 빠른입력→추가→행 반영, due 픽스처→팝업 창 수 확인. **기대값을 레지스트리에서 파생**.

### CI (`.github/workflows/ci.yml`)
- `windows-latest` 단일 job(실제 타깃 OS): checkout → node 22 → `npm ci` → `npm run check`(node --check) → `npm run lint` → `npm test` → smoke(`check:ui`) → C# 빌드(`build.cmd`, windows 러너에 .NET Framework 내장) + `NlpTest.exe` 실행.
- `permissions: contents: read`, concurrency cancel-in-progress, secret 0, 배포 단계 0.

## 4. 원격 저장 옵션 (todo-sync) — 기본 꺼짐

### 서버: `tools/sync-server.mjs` (무의존 node:http, 127.0.0.1:8850)
- `GET /api/health` → `{"app":"todo-sync","ok":true}` (healthMatch 마커)
- `GET /api/state` → `{rev, todos, calendars}` / `PUT /api/state` (If-Match rev, 불일치 409) — study-treasurer·fire-claude와 같은 rev 낙관적 동시성 관례
- 사용자 식별: `_global`이 주입하는 신뢰 헤더 `x-global-user` (서버 자체 인증 없음 — `_global` 로그인이 앞단)
- 저장: `data/sync/<user>/state.json` (tmp→rename 원자적)

### `_global` 등록: `../_global/config/services/8850.todo-sync.yaml`
조사로 확정된 양식 그대로: `kind: backend-api`, `frontend: false`, `publicHost: todo-sync.tradechord.com`(와일드카드 DNS라 추가 작업 0), `healthPath: /api/health` + `healthMatch: '"app":"todo-sync"'`, `app.command: node tools/sync-server.mjs`, registrar 기록, 등록 후 `npm run icons`. 앱의 `ARCHITECTURE.services`에 미러.

### 클라이언트: `app/main/sync/` (여기만 네트워크 허용)
- 설정 섹션 "원격 동기화": 끔(기본)/켬, 서버 URL, 계정(Basic — 비밀번호는 Electron `safeStorage`로 암호화 저장), 주기(기본 5분)
- 동작: 켰을 때만 로드되는 모듈. 주기마다 pull→병합(항목별 `updated` LWW)→push(rev, 409면 재병합). 꺼져 있으면 **네트워크 코드가 로드조차 되지 않음**(lint:network가 경계 보장).
- 충돌 원칙: 로컬 우선 앱이므로 병합 실패 시 로컬 보존 + 트레이 풍선 알림.

## 5. 문서 거버넌스 (`CLAUDE.md` 신설)
SSoT 우선순위: ①현재 코드 ②CLAUDE.md(소유권·불변 규약·검사 명령) ③docs/ARCHITECTURE.md(설계 의도) ④docs/PLAN.md(로드맵·벤치마크). 충돌 시 위가 이긴다. 불변 규약: GCal 스키마 필드·`PRIVATE_FIELDS`·C#5 제약·폐쇄망 불변식·key 불변.

## 6. 구현 라운드 (각 라운드마다 커밋·푸시)
- **R1 레지스트리화**: shared/contracts.js·registry.js + verify + preload allowlist + main IPC 관문화 + storage `TODO_DATA_DIR` 주입 (동작 변화 없음 — 기존 기능 회귀 테스트로 확인)
- **R2 검사 체계**: scripts/ lint 10종 + lint-all + `node --test` 이식·신규(state/storage) + testdata 픽스처
- **R3 스모크+CI**: check:ui(CDP) + ci.yml + CLAUDE.md
- **R4 원격 옵션**: sync-server + main/sync 클라이언트 + 설정 UI + `_global` 등록
- 마지막에 멀티에이전트 리뷰 1회 → 수정 → 푸시
