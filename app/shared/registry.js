'use strict';

/* 등록표(registry) — 이 파일이 소유하는 것
 *   IPC 채널, 설정 필드, 팝업 액션/스누즈, 빠른입력 칩, private 속성 키,
 *   데이터 파일, 색 팔레트, 캘린더 연산, 단축키·CLI 플래그, 반복 지원 범위,
 *   검사 목록(TESTING), 아키텍처 지도(ARCHITECTURE), 계획(SCENARIOS), 그리고 verify().
 *
 * 여기 적으면 안 되는 것
 *   DOM · 네트워크 · fs · electron require. 데이터와 순수 함수만 둔다.
 *   (main 도 renderer 도 이 파일을 읽는다. 한쪽 전용 코드가 섞이면 다른 쪽이 깨진다.)
 *
 * 바꾸면 안 되는 것
 *   key           IPC 채널명·설정 키·private 키는 배포된 데이터와 renderer 에 박혀 있다.
 *                 이름이 마음에 안 들면 label 을 고친다. key 는 고치지 않는다.
 *   private key   %APPDATA%\TodoPopup\todos.json 에 이미 그 이름으로 저장돼 있고,
 *                 구글 캘린더 왕복에서도 그대로 오간다.
 *
 * verify() 는 절대 throw 하지 않는다. 문제 문자열 배열을 돌려주고,
 * 부팅 코드(main.js / 각 renderer)가 그 배열이 비지 않으면 터뜨린다.
 * (통과 시 true 를 돌려주면 호출부의 .length 가 undefined 로 어물쩍 넘어간다.)
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./contracts.js'));
  } else {
    root.TD_REGISTRY = factory(root.TD_CONTRACTS);
  }
})(typeof self !== 'undefined' ? self : this, function (C) {

  // ───────────────────────── ipc ─────────────────────────
  // preload 의 allowlist 가 이 표에서 나온다. main 핸들러와 renderer 호출처를
  // lint:ipc 가 3중 양방향 대조한다 — 죽은 채널도, 미등록 호출도 잡는다.
  var IPC_CHANNELS = [
    { key: 'get-init', kind: 'invoke', desc: '창 부팅용 묶음(설정·색·캘린더 트리)' },
    { key: 'get-settings', kind: 'invoke', desc: '현재 설정 조회' },
    { key: 'save-settings', kind: 'invoke', desc: '설정 저장(부분 패치 허용) → 정규화된 설정 반환' },
    { key: 'get-calendars', kind: 'invoke', desc: '캘린더 레지스트리(서비스→계정→캘린더) 조회' },
    { key: 'calendar-op', kind: 'invoke', desc: '캘린더/계정 연산(CALENDAR_OPS 의 op)' },
    { key: 'list-instances', kind: 'invoke', desc: '기간 내 인스턴스 조회(반복 전개 포함)' },
    { key: 'add-event', kind: 'invoke', desc: '일정 추가 → id' },
    { key: 'update-event', kind: 'invoke', desc: '일정 수정(scope: single|all)' },
    { key: 'delete-event', kind: 'invoke', desc: '일정 삭제(scope: single|all)' },
    { key: 'move-event', kind: 'invoke', desc: '드래그 이동·리사이즈' },
    { key: 'set-status', kind: 'invoke', desc: '완료/취소/대기 전환' },
    { key: 'duplicate-event', kind: 'invoke', desc: '일정 복제' },
    { key: 'get-event-form', kind: 'invoke', desc: '상세 폼 초기값(복사/붙여넣기도 이걸 쓴다)' },
    { key: 'notify-now', kind: 'invoke', desc: '지금 알림(스누즈 해제 후 팝업)' },
    { key: 'popup-action', kind: 'invoke', desc: '팝업 버튼 결과 처리' },
    { key: 'preview-popup', kind: 'invoke', desc: '설정 미리보기 팝업' },
    { key: 'open-calendar', kind: 'invoke', desc: '캘린더 창 열기' },
    { key: 'open-list', kind: 'invoke', desc: '목록 창 열기' },
    { key: 'open-detail', kind: 'invoke', desc: '상세 창 열기(new|edit)' },
    { key: 'close-detail', kind: 'invoke', desc: '상세 창 닫기' },
    { key: 'confirm', kind: 'invoke', desc: '네이티브 확인 대화상자 → 버튼 index' },
    { key: 'data-changed', kind: 'event', desc: '데이터 변경 브로드캐스트 → 창 갱신' },
    { key: 'focus-input', kind: 'event', desc: '목록 창 입력란 포커스' },
    { key: 'open-settings', kind: 'event', desc: '목록 창 설정 패널 열기' },
    { key: 'popup-init', kind: 'event', desc: '팝업 창 초기 데이터' },
    { key: 'detail-init', kind: 'event', desc: '상세 창 초기 데이터' }
  ];

  // ───────────────────────── settings ─────────────────────────
  // 기본값과 clamp 가 이 표에서 파생된다(storage.js). 설정 패널 DOM 과는
  // lint:settings 가 1:1 대조한다 — 표에만 있고 UI 에 없는 필드도 잡는다.
  var SETTINGS_FIELDS = [
    { key: 'position', type: 'enum', values: C.POPUP_POSITIONS, def: 'bottom-center', label: '팝업 위치', ui: 'select', section: 'popup' },
    { key: 'opacity', type: 'ratio', min: 0.3, max: 1, def: 0.95, label: '팝업 불투명도', ui: 'range', section: 'popup' },
    { key: 'popupWidth', type: 'int', min: 260, max: 900, def: 380, label: '팝업 너비', ui: 'number', section: 'popup' },
    { key: 'popupHeight', type: 'int', min: 130, max: 500, def: 170, label: '팝업 높이', ui: 'number', section: 'popup' },
    // 알림이 떠도 못 보고 지나치면 이 앱은 아무것도 한 것이 없다. 기본으로 눈에 띄게 한다.
    { key: 'popupEffect', type: 'enum', values: C.POPUP_EFFECTS, def: 'flash', label: '눈에 띄는 효과', ui: 'select', section: 'popup' },
    // 모니터가 여럿이면 알림이 뜬 화면을 안 보고 있을 수 있다. 기본은 전부에 띄운다.
    { key: 'popupAllMonitors', type: 'bool', def: true, label: '모든 모니터에 표시', ui: 'check', section: 'popup' },
    { key: 'defaultRenotifyMinutes', type: 'int', min: 1, max: 720, def: 5, label: '기본 재알림', ui: 'number', section: 'alarm' },
    { key: 'defaultSnoozeMinutes', type: 'int', min: 1, max: 720, def: 10, label: '기본 미루기', ui: 'number', section: 'alarm' },
    { key: 'defaultReminderMinutes', type: 'intlist', def: [], label: '기본 미리 알림', ui: 'text', section: 'alarm' },
    { key: 'playSound', type: 'bool', def: true, label: '알림음', ui: 'check', section: 'alarm' },
    // "1분 뒤" 를 14:00:30 에 말하면 14:01:30 이 아니라 14:01:00 에 울린다.
    // 사람은 분 단위로 생각하지 초를 세지 않는다 — 기본으로 초를 버린다.
    { key: 'truncateSeconds', type: 'bool', def: true, label: '예약 시 초 버림', ui: 'check', section: 'alarm' },
    { key: 'defaultCalendarId', type: 'string', def: 'default', label: '기본 캘린더', ui: 'select', section: 'alarm' },
    { key: 'autostart', type: 'bool', def: true, label: '자동 실행', ui: 'check', section: 'app' },
    { key: 'showClosed', type: 'bool', def: true, label: '지난 항목 표시', ui: 'check', section: 'app' },
    { key: 'listSortAsc', type: 'bool', def: true, label: '예정 목록 과거순', ui: 'toggle', section: 'app' },
    // 24시간·앞자리 0(00:00)이 기본이다. 오전/오후와 앞자리 0 제거는 각각 선택.
    { key: 'timeFormat', type: 'enum', values: C.TIME_FORMATS, def: '24h', label: '시간 표기', ui: 'select', section: 'app' },
    { key: 'timePadHour', type: 'bool', def: true, label: '시각 앞자리 0', ui: 'check', section: 'app' },
    // 값은 불투명도다(1 = 완전히 진함). 화면에는 "투명도 N%" 로도 함께 보여 준다 —
    // 슬라이더 숫자를 투명도로 읽으면 방향을 반대로 이해해 너무 투명하게 맞추게 된다.
    { key: 'calendarOpacity', type: 'ratio', min: 0.3, max: 1, def: 0.8, label: '캘린더 불투명도', ui: 'range', section: 'calendar' },
    { key: 'calendarOpaqueOnFocus', type: 'bool', def: false, label: '포커스 시 불투명', ui: 'check', section: 'calendar' },
    { key: 'snapMinutes', type: 'int', min: 1, max: 60, def: 15, label: '드래그 스냅', ui: 'number', section: 'calendar' },
    // 이 앱의 시각은 전부 이 시간대의 벽시계다 — 팝업이 뜰 시각, 반복 회차 키, ICS 해석, 표기.
    // 기본은 KST. 다른 곳에서 쓰면 여기만 바꾸면 되고, 없는 시간대를 넣으면 기본으로 되돌린다.
    { key: 'timeZone', type: 'timezone', def: 'Asia/Seoul', label: '시간대', ui: 'text', section: 'app' },
    { key: 'hotkeyList', type: 'string', def: 'Control+Alt+T', label: '단축키: 목록', ui: 'text', section: 'app' },
    { key: 'hotkeyNew', type: 'string', def: 'Control+Alt+N', label: '단축키: 새 일정', ui: 'text', section: 'app' },
    { key: 'hotkeyCalendar', type: 'string', def: 'Control+Alt+C', label: '단축키: 캘린더', ui: 'text', section: 'app' },
  ];

  var SETTINGS_SECTIONS = [
    { key: 'popup', label: '팝업' },
    { key: 'alarm', label: '알림' },
    { key: 'calendar', label: '캘린더' },
    { key: 'app', label: '앱' },
  ];

  // ───────────────────────── popup ─────────────────────────
  // 팝업 버튼과 scheduler 의 분기가 같은 표에서 나온다.
  var POPUP_ACTIONS = [
    { key: 'ack', label: '확인', kinds: ['due', 'pre'], style: 'plain', desc: '이번만 닫음. due 면 재알림 간격 뒤 다시' },
    { key: 'snooze', label: '{n}분 뒤', kinds: ['due', 'pre'], style: 'plain', desc: '지정 시간 미루기' },
    { key: 'done', label: '완료', kinds: ['due', 'pre'], style: 'primary', desc: '반복 종료(완료)' },
    { key: 'cancel', label: '취소', kinds: ['due', 'pre'], style: 'danger', desc: '반복 종료(취소)' }
  ];

  var SNOOZE_PRESETS = [
    { minutes: 5, label: '5분 뒤' },
    { minutes: 10, label: '10분 뒤' },
    { minutes: 15, label: '15분 뒤' },
    { minutes: 30, label: '30분 뒤' },
    { minutes: 60, label: '1시간 뒤' },
    { minutes: 180, label: '3시간 뒤' },
    { minutes: 1440, label: '내일 이 시간' }
  ];

  // 빠른입력 칩. offsetMinutes 는 지금부터의 상대 시간,
  // atHour 는 오늘/내일(dayOffset)의 절대 시각.
  var QUICK_CHIPS = [
    { key: 'in30', label: '30분 뒤', offsetMinutes: 30 },
    { key: 'in60', label: '1시간 뒤', offsetMinutes: 60 },
    { key: 'today18', label: '오늘 18:00', dayOffset: 0, atHour: 18, atMinute: 0 },
    { key: 'tomorrow9', label: '내일 09:00', dayOffset: 1, atHour: 9, atMinute: 0 }
  ];

  // ───────────────────────── data ─────────────────────────
  // extendedProperties.private 에 쓸 수 있는 키 전부. 미등록 키 사용은
  // lint:private-fields 가 막는다 — 구글 캘린더 왕복 호환의 보증이다.
  // deviceLocal: true 인 키는 동기화로 오가지 않는다(contracts.DEVICE_LOCAL_PRIVATE 와 대조).
  var PRIVATE_FIELDS = [
    { key: 'todoStatus', desc: '앱 상태 pending|done|cancelled (GCal 에는 완료 개념이 없다)' },
    { key: 'renotifyMinutes', desc: '완료·취소 전까지 다시 알리는 간격(분)' },
    { key: 'snoozeUntil', desc: '이 시각까지 알리지 않음 (RFC3339)', deviceLocal: true },
    { key: 'notifyCount', desc: '정시 알림을 띄운 횟수', deviceLocal: true },
    { key: 'closedAt', desc: '완료·취소 시각 (RFC3339)' },
    { key: 'calendarId', desc: '소속 캘린더 id (calendars.json 의 캘린더)' },
    { key: 'instanceState', desc: '반복 회차별 상태 JSON {instKey: {todoStatus,snoozeUntil,notifyCount,closedAt}}' },
    { key: 'firedReminders', desc: '미리 알림 발화 기록 JSON {"key|minutes": "shown"|재표시시각}', deviceLocal: true },
    { key: 'deletedAt', desc: '삭제 표식(툼스톤, RFC3339). 원격 동기화에서 삭제가 전파되게 한다 — 없으면 지운 일정이 다음 동기화에 되살아난다' },
  ];

  var DATA_STORES = [
    { key: 'todos', file: 'todos.json', shape: 'calendar#events', desc: '일정 원장(구글 events.list 형태)' },
    { key: 'calendars', file: 'calendars.json', shape: 'calendarList', desc: '서비스→계정→캘린더 트리' },
    { key: 'settings', file: 'settings.json', shape: 'settings', desc: '앱 설정(SETTINGS_FIELDS 에서 파생)' },
    // 구독 캘린더의 이벤트는 원장(todos.json)에 섞지 않는다. 남의 캘린더는 우리가 소유하지
    // 않으므로 갱신 때 통째로 갈아끼워야 하고, 원장에 섞이면 그때 사용자의 일정까지 위험해진다.
    { key: 'subCache', file: 'subscriptions.json', shape: 'subscriptionCache', desc: '구독 캘린더에서 받아 온 이벤트 캐시(캘린더별). 네트워크가 끊겨도 알람은 이 캐시로 돈다' },
    // 남의 캘린더(읽기 전용)를 내 화면에서만 완료 처리하기 위한 자리.
    // 원본을 고칠 수 없으니 "내가 처리했다"는 사실만 로컬에 남긴다.
    { key: 'subOverlay', file: 'overlay.json', shape: 'overlay', desc: '읽기 전용 캘린더 항목의 로컬 상태(완료·취소·숨김). 원본은 건드리지 않는다' }
  ];

  // 구글 캘린더 이벤트 색(colorId 1~11).
  var EVENT_COLORS = [
    { id: '1', hex: '#7986cb' }, { id: '2', hex: '#33b679' }, { id: '3', hex: '#8e24aa' },
    { id: '4', hex: '#e67c73' }, { id: '5', hex: '#f6bf26' }, { id: '6', hex: '#f4511e' },
    { id: '7', hex: '#039be5' }, { id: '8', hex: '#616161' }, { id: '9', hex: '#3f51b5' },
    { id: '10', hex: '#0b8043' }, { id: '11', hex: '#d60000' }
  ];
  var DEFAULT_EVENT_COLOR = '#1a73e8';

  // 캘린더 색 팔레트(사이드바). 직접 지정은 컬러휠로 임의 hex 도 받는다.
  var CAL_PALETTE = ['#d50000', '#e67c73', '#f4511e', '#f6bf26', '#33b679', '#0b8043',
    '#009688', '#039be5', '#4285f4', '#3f51b5', '#7986cb', '#8e24aa', '#b39ddb', '#616161'];

  // calendar-op 채널이 받는 op 목록. state.calendarOp() 분기와 1:1.
  var CALENDAR_OPS = [
    { key: 'add', desc: '캘린더 추가(대상 계정 지정)' },
    { key: 'toggle', desc: '표시 켬/끔(알람은 유지)' },
    { key: 'alarms', desc: '캘린더 단위 알람 켬/끔' },
    { key: 'color', desc: '캘린더 색 지정' },
    { key: 'rename', desc: '캘린더 이름 변경' },
    { key: 'remove', desc: '캘린더 삭제(소속 일정 함께)' },
    { key: 'add-subscription', desc: 'ICS 구독 추가(URL 또는 로컬 파일, 읽기 전용)' },
    { key: 'refresh-subscription', desc: '구독 캘린더 지금 갱신' },
    { key: 'add-account', desc: '계정(그룹) 추가' },
    { key: 'rename-account', desc: '계정 이름 변경' },
    { key: 'remove-account', desc: '계정 제거(소속 캘린더·일정 함께)' }
  ];

  // ───────────────────────── app ─────────────────────────
  var HOTKEYS = [
    { key: 'hotkeyList', def: 'Control+Alt+T', desc: '목록 창 열기' },
    { key: 'hotkeyNew', def: 'Control+Alt+N', desc: '새 일정 입력' },
    { key: 'hotkeyCalendar', def: 'Control+Alt+C', desc: '캘린더 창 열기' }
  ];

  var CLI_FLAGS = [
    { key: '--calendar', desc: '캘린더 창으로 시작(이미 실행 중이면 그 창을 띄운다)' },
    { key: '--hidden', desc: '창 없이 트레이만(자동 실행용)' },
    { key: '--test-popup', desc: '미리보기 팝업을 즉시 띄움' }
  ];

  // recurrence.js 가 실제로 전개할 수 있는 범위. detail 폼 옵션과 대조된다.
  var RRULE_SUPPORT = {
    freqs: C.RECUR_FREQS,
    fields: ['INTERVAL', 'BYDAY', 'BYMONTHDAY', 'UNTIL', 'COUNT'],
    lines: ['RRULE', 'EXDATE'],
    unsupported: ['RDATE', 'BYSETPOS', 'BYMONTH', 'WKST'],
    note: '미지원 규칙은 무시하되 데이터는 보존한다(왕복에서 잃지 않는다)'
  };

  // ───────────────────────── ops ─────────────────────────
  // 검사 목록. package.json scripts · scripts/lint-all.mjs · .github/workflows/ci.yml
  // 이 셋과 lint:registry / lint:ci 가 대조한다.
  var TESTING = {
    checks: [
      { npm: 'lint:registry', file: 'scripts/lint-registry.mjs', why: '등록이 계약을 지키고 export 목록이 그대로인가' },
      { npm: 'lint:ipc', file: 'scripts/lint-ipc.mjs', why: '채널 등록·main 핸들러·renderer 호출이 1:1 인가' },
      { npm: 'lint:settings', file: 'scripts/lint-settings.mjs', why: '설정 필드가 등록·기본값·설정 화면에서 갈라지지 않았는가' },
      { npm: 'lint:private-fields', file: 'scripts/lint-private-fields.mjs', why: '미등록 private 키를 쓰지 않는가 (구글 왕복 호환)' },
      { npm: 'lint:network', file: 'scripts/lint-network.mjs', why: '동기화 모듈 밖에서 네트워크를 쓰지 않는가 (폐쇄망 불변식)' },
      { npm: 'lint:fs-gateway', file: 'scripts/lint-fs-gateway.mjs', why: 'storage.js 밖에서 파일을 직접 만지지 않는가 (파일 IO 유일 관문)' },
      { npm: 'lint:boundary', file: 'scripts/lint-boundary.mjs', why: 'main/renderer 경계와 preload 관문을 지키는가' },
      { npm: 'lint:hardcoding', file: 'scripts/lint-hardcoding.mjs', why: '채널명·파일명·설정키가 등록표 밖에 박혀 있지 않은가' },
      { npm: 'lint:csharp5', file: 'scripts/lint-csharp5.mjs', why: 'C# 소스가 내장 컴파일러(C# 5) 문법을 벗어나지 않는가' },
      { npm: 'lint:selectable', file: 'scripts/lint-selectable.mjs', why: '화면 글자가 드래그·복사 가능하고 배경을 부모에서 가져오는가' },
      { npm: 'lint:ci', file: 'scripts/lint-ci.mjs', why: 'CI 필수 단계와 이 표가 어긋나지 않았는가' },
      { npm: 'lint:docs', file: 'scripts/lint-docs.mjs', why: '문서가 코드에 없는 명령·심볼을 말하지 않는가' },
      { npm: 'test', file: 'test/*.test.js', why: '파서·반복 전개·상태 변경·저장이 실제로 맞게 도는가' },
      { npm: 'check:ui', file: 'scripts/check-ui.mjs', why: '실제 창이 뜨고 등록 수만큼 그려지고 저장이 실제로 나가는가' }
    ],
    dataIsolation: 'TODO_DATA_DIR 로 데이터 디렉터리를 주입한다. 테스트·CI 는 임시 디렉터리나 testdata 사본만 쓴다 — 실사용 원장을 만지면 사용자 일정이 사라진다.'
  };

  // _global 서비스 등록의 미러. 양쪽이 같은 사실을 들고 있어야 한다.
  var ARCHITECTURE = {
    loadOrder: ['shared/contracts.js', 'shared/registry.js', '(main) storage/model/recurrence/state/…', '(renderer) 창 스크립트'],
    services: [],
    files: [
      { path: 'app/shared/contracts.js', layer: '계약' },
      { path: 'app/shared/registry.js', layer: '등록' },
      { path: 'app/main/', layer: '실행(메인)' },
      { path: 'app/renderer/', layer: '실행(창)' },
      { path: 'app/preload.js', layer: '관문(IPC allowlist)' },
      { path: 'app/main/storage.js', layer: '관문(파일 IO)' },
      { path: 'app/main/calendars/', layer: '캘린더 어댑터(옵션) — 구독·구글' },
      { path: 'src/', layer: 'Phase 1 C# 구현(폐쇄망 레퍼런스)' }
    ]
  };

  // 계획을 문서가 아니라 등록표로 둔다. status 가 done 인데 실물 등록이 없으면
  // verify() 가 터진다 — 설계와 구현의 드리프트를 부팅 실패로 만든다.
  var SCENARIOS = [
    {
      key: 'ics-subscribe', label: 'ICS 구독(읽기 전용)', status: 'done',
      registers: [
        { table: 'CALENDAR_OPS', key: 'add-subscription', status: 'done' },
        { table: 'CALENDAR_OPS', key: 'refresh-subscription', status: 'done' },
        { table: 'DATA_STORES', key: 'subCache', status: 'done' },
        // 남의 캘린더는 못 고친다. 그래도 "내가 처리했다"는 표시는 내 화면에 남아야 한다.
        { table: 'DATA_STORES', key: 'subOverlay', status: 'done' }
      ]
    },
  ];

  // ───────────────────────── meta ─────────────────────────
  var EXPORTS = {
    IPC_CHANNELS: IPC_CHANNELS,
    SETTINGS_FIELDS: SETTINGS_FIELDS,
    SETTINGS_SECTIONS: SETTINGS_SECTIONS,
    POPUP_ACTIONS: POPUP_ACTIONS,
    SNOOZE_PRESETS: SNOOZE_PRESETS,
    QUICK_CHIPS: QUICK_CHIPS,
    PRIVATE_FIELDS: PRIVATE_FIELDS,
    DATA_STORES: DATA_STORES,
    EVENT_COLORS: EVENT_COLORS,
    CAL_PALETTE: CAL_PALETTE,
    CALENDAR_OPS: CALENDAR_OPS,
    HOTKEYS: HOTKEYS,
    CLI_FLAGS: CLI_FLAGS,
    RRULE_SUPPORT: RRULE_SUPPORT,
    TESTING: TESTING,
    ARCHITECTURE: ARCHITECTURE,
    SCENARIOS: SCENARIOS
  };

  // 모든 export 는 정확히 한 그룹에 속해야 한다. 새 export 를 그룹에 안 넣으면
  // verify() 가 터진다 — 그게 의도다(문서·검사에 안 잡힌 채 자라는 것을 막는다).
  var REGISTRY_GROUPS = [
    { key: 'ipc', label: '채널', tables: ['IPC_CHANNELS'] },
    { key: 'settings', label: '설정', tables: ['SETTINGS_FIELDS', 'SETTINGS_SECTIONS'] },
    { key: 'popup', label: '팝업', tables: ['POPUP_ACTIONS', 'SNOOZE_PRESETS', 'QUICK_CHIPS'] },
    { key: 'data', label: '데이터', tables: ['PRIVATE_FIELDS', 'DATA_STORES', 'EVENT_COLORS', 'CAL_PALETTE', 'CALENDAR_OPS'] },
    { key: 'app', label: '앱', tables: ['HOTKEYS', 'CLI_FLAGS', 'RRULE_SUPPORT'] },
    { key: 'ops', label: '운영', tables: ['TESTING', 'ARCHITECTURE', 'SCENARIOS'] }
  ];

  // ---- 파생 헬퍼 (등록표에서 나오는 것들. 손으로 두 벌 적지 않는다) ----

  function settingsDefaults() {
    var out = {};
    for (var i = 0; i < SETTINGS_FIELDS.length; i++) {
      var f = SETTINGS_FIELDS[i];
      out[f.key] = Array.isArray(f.def) ? f.def.slice() : f.def;
    }
    return out;
  }

  function settingField(key) {
    for (var i = 0; i < SETTINGS_FIELDS.length; i++) {
      if (SETTINGS_FIELDS[i].key === key) return SETTINGS_FIELDS[i];
    }
    return null;
  }

  function channelKeys(kind) {
    var out = [];
    for (var i = 0; i < IPC_CHANNELS.length; i++) {
      if (!kind || IPC_CHANNELS[i].kind === kind) out.push(IPC_CHANNELS[i].key);
    }
    return out;
  }

  function privateKeys() {
    return PRIVATE_FIELDS.map(function (f) { return f.key; });
  }

  function eventColorHex(colorId) {
    for (var i = 0; i < EVENT_COLORS.length; i++) {
      if (EVENT_COLORS[i].id === String(colorId)) return EVENT_COLORS[i].hex;
    }
    return DEFAULT_EVENT_COLOR;
  }

  function tableByName(name) {
    return EXPORTS[name] || null;
  }

  // SCENARIOS 의 registers 가 실물 등록표에 있는지 확인한다.
  function scenarioTargetExists(tableName, key) {
    var t = tableByName(tableName);
    if (!t) return false;
    if (Array.isArray(t)) {
      for (var i = 0; i < t.length; i++) {
        if (t[i] && (t[i].key === key || t[i].id === key)) return true;
      }
      return false;
    }
    return Object.prototype.hasOwnProperty.call(t, key);
  }

  // ---- verify ----

  function verify() {
    var errs = [];
    var seen, i, j, row;

    function dupCheck(list, name, field) {
      var s = {};
      for (var k = 0; k < list.length; k++) {
        var v = list[k] && list[k][field || 'key'];
        if (v === undefined) continue;
        if (s[v]) errs.push(name + ': ' + (field || 'key') + ' 중복 — ' + v);
        s[v] = true;
      }
    }

    // 계약 검사
    for (i = 0; i < IPC_CHANNELS.length; i++) {
      errs = errs.concat(C.validateIpcChannel(IPC_CHANNELS[i]));
    }
    for (i = 0; i < SETTINGS_FIELDS.length; i++) {
      errs = errs.concat(C.validateSettingField(SETTINGS_FIELDS[i]));
    }
    for (i = 0; i < PRIVATE_FIELDS.length; i++) {
      errs = errs.concat(C.validatePrivateField(PRIVATE_FIELDS[i]));
    }

    // 키 중복
    dupCheck(IPC_CHANNELS, 'IPC_CHANNELS');
    dupCheck(SETTINGS_FIELDS, 'SETTINGS_FIELDS');
    dupCheck(PRIVATE_FIELDS, 'PRIVATE_FIELDS');
    dupCheck(DATA_STORES, 'DATA_STORES');
    dupCheck(CALENDAR_OPS, 'CALENDAR_OPS');
    dupCheck(QUICK_CHIPS, 'QUICK_CHIPS');
    dupCheck(EVENT_COLORS, 'EVENT_COLORS', 'id');
    dupCheck(SETTINGS_SECTIONS, 'SETTINGS_SECTIONS');

    // 설정 섹션 실존
    var sectionKeys = {};
    for (i = 0; i < SETTINGS_SECTIONS.length; i++) sectionKeys[SETTINGS_SECTIONS[i].key] = true;
    for (i = 0; i < SETTINGS_FIELDS.length; i++) {
      if (!sectionKeys[SETTINGS_FIELDS[i].section]) {
        errs.push('SETTINGS_FIELDS ' + SETTINGS_FIELDS[i].key + ': 없는 section — ' + SETTINGS_FIELDS[i].section + ' (SETTINGS_SECTIONS 에 넣으세요)');
      }
    }

    // 팝업 액션이 계약 어휘 안에 있는가
    for (i = 0; i < POPUP_ACTIONS.length; i++) {
      if (C.POPUP_ACTION_KEYS.indexOf(POPUP_ACTIONS[i].key) < 0) {
        errs.push('POPUP_ACTIONS ' + POPUP_ACTIONS[i].key + ': contracts.POPUP_ACTION_KEYS 에 없는 액션입니다');
      }
      for (j = 0; j < (POPUP_ACTIONS[i].kinds || []).length; j++) {
        if (C.POPUP_KINDS.indexOf(POPUP_ACTIONS[i].kinds[j]) < 0) {
          errs.push('POPUP_ACTIONS ' + POPUP_ACTIONS[i].key + ': 알 수 없는 kind — ' + POPUP_ACTIONS[i].kinds[j]);
        }
      }
    }
    for (i = 0; i < C.POPUP_ACTION_KEYS.length; i++) {
      var found = false;
      for (j = 0; j < POPUP_ACTIONS.length; j++) {
        if (POPUP_ACTIONS[j].key === C.POPUP_ACTION_KEYS[i]) found = true;
      }
      if (!found) errs.push('POPUP_ACTIONS: 계약에 있는 ' + C.POPUP_ACTION_KEYS[i] + ' 가 등록되지 않았습니다');
    }

    // 색 형식
    for (i = 0; i < EVENT_COLORS.length; i++) {
      if (!/^#[0-9a-f]{6}$/i.test(EVENT_COLORS[i].hex)) {
        errs.push('EVENT_COLORS ' + EVENT_COLORS[i].id + ': hex 형식이 아닙니다 — ' + EVENT_COLORS[i].hex);
      }
    }
    for (i = 0; i < CAL_PALETTE.length; i++) {
      if (!/^#[0-9a-f]{6}$/i.test(CAL_PALETTE[i])) {
        errs.push('CAL_PALETTE[' + i + ']: hex 형식이 아닙니다 — ' + CAL_PALETTE[i]);
      }
    }

    // 단축키 등록이 설정 필드와 짝인가
    for (i = 0; i < HOTKEYS.length; i++) {
      var sf = settingField(HOTKEYS[i].key);
      if (!sf) errs.push('HOTKEYS ' + HOTKEYS[i].key + ': 같은 key 의 SETTINGS_FIELDS 행이 없습니다');
      else if (sf.def !== HOTKEYS[i].def) {
        errs.push('HOTKEYS ' + HOTKEYS[i].key + ': 기본값이 설정 표와 다릅니다 (' + HOTKEYS[i].def + ' vs ' + sf.def + ')');
      }
    }

    // 빠른입력 칩 모양
    for (i = 0; i < QUICK_CHIPS.length; i++) {
      row = QUICK_CHIPS[i];
      var rel = typeof row.offsetMinutes === 'number';
      var abs = typeof row.atHour === 'number';
      if (rel === abs) {
        errs.push('QUICK_CHIPS ' + row.key + ': offsetMinutes(상대) 또는 atHour(절대) 중 정확히 하나여야 합니다');
      }
    }

    // 그룹 전수 배정 (양방향)
    var grouped = {};
    for (i = 0; i < REGISTRY_GROUPS.length; i++) {
      for (j = 0; j < REGISTRY_GROUPS[i].tables.length; j++) {
        var tn = REGISTRY_GROUPS[i].tables[j];
        if (grouped[tn]) errs.push('REGISTRY_GROUPS: ' + tn + ' 이 두 그룹에 들어 있습니다');
        grouped[tn] = true;
        if (!EXPORTS[tn]) errs.push('REGISTRY_GROUPS: 없는 등록표를 가리킵니다 — ' + tn);
      }
    }
    for (var name in EXPORTS) {
      if (!Object.prototype.hasOwnProperty.call(EXPORTS, name)) continue;
      if (!grouped[name]) errs.push('그룹 없는 export: ' + name + ' (REGISTRY_GROUPS 에 넣으세요)');
    }

    // SCENARIOS ↔ 실물 등록표
    for (i = 0; i < SCENARIOS.length; i++) {
      var sc = SCENARIOS[i];
      for (j = 0; j < (sc.registers || []).length; j++) {
        var r = sc.registers[j];
        var exists = scenarioTargetExists(r.table, r.key);
        if (r.status === 'done' && !exists) {
          errs.push('SCENARIOS ' + sc.key + ': done 인데 실물이 없습니다 — ' + r.table + '.' + r.key);
        }
        if (r.status === 'planned' && exists) {
          errs.push('SCENARIOS ' + sc.key + ': planned 인데 이미 등록돼 있습니다 — ' + r.table + '.' + r.key + ' (status 를 done 으로 바꾸세요)');
        }
      }
    }

    // 아키텍처 서비스 미러가 계약과 같은 마커를 들고 있는가
    for (i = 0; i < ARCHITECTURE.services.length; i++) {
      var svc = ARCHITECTURE.services[i];
      if (svc.id === 'todo-sync') {
        if (svc.healthMatch !== C.SYNC_HEALTH_MARKER) {
          errs.push('ARCHITECTURE.services todo-sync: healthMatch 가 계약과 다릅니다 (_global yaml 과도 어긋납니다)');
        }
        if (svc.healthPath !== C.SYNC_API.health.path) {
          errs.push('ARCHITECTURE.services todo-sync: healthPath 가 계약과 다릅니다');
        }
      }
    }

    // 기기 로컬 키 목록이 계약과 등록표에서 갈라지지 않았는가.
    // 갈라지면 한쪽만 보고 짠 병합 코드가 남의 알림 상태를 받아 오게 된다.
    var regLocal = [];
    for (i = 0; i < PRIVATE_FIELDS.length; i++) {
      if (PRIVATE_FIELDS[i].deviceLocal) regLocal.push(PRIVATE_FIELDS[i].key);
    }
    for (i = 0; i < C.DEVICE_LOCAL_PRIVATE.length; i++) {
      if (regLocal.indexOf(C.DEVICE_LOCAL_PRIVATE[i]) < 0) {
        errs.push('PRIVATE_FIELDS: ' + C.DEVICE_LOCAL_PRIVATE[i] + ' 가 계약에서는 기기 로컬인데 등록표에 deviceLocal:true 가 없습니다');
      }
    }
    for (i = 0; i < regLocal.length; i++) {
      if (C.DEVICE_LOCAL_PRIVATE.indexOf(regLocal[i]) < 0) {
        errs.push('PRIVATE_FIELDS ' + regLocal[i] + ': deviceLocal:true 인데 contracts.DEVICE_LOCAL_PRIVATE 에 없습니다');
      }
    }

    // 데이터 저장소 파일명 중복
    seen = {};
    for (i = 0; i < DATA_STORES.length; i++) {
      if (seen[DATA_STORES[i].file]) errs.push('DATA_STORES: 파일명 중복 — ' + DATA_STORES[i].file);
      seen[DATA_STORES[i].file] = true;
    }

    return errs;
  }

  var api = {
    verify: verify,
    settingsDefaults: settingsDefaults,
    settingField: settingField,
    channelKeys: channelKeys,
    privateKeys: privateKeys,
    eventColorHex: eventColorHex,
    tableByName: tableByName,
    scenarioTargetExists: scenarioTargetExists,
    DEFAULT_EVENT_COLOR: DEFAULT_EVENT_COLOR,
    REGISTRY_GROUPS: REGISTRY_GROUPS,
    EXPORTS: EXPORTS
  };
  for (var n in EXPORTS) {
    if (Object.prototype.hasOwnProperty.call(EXPORTS, n)) api[n] = EXPORTS[n];
  }
  return api;
});
