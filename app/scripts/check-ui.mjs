/* 실제 창 검사(스모크).
 *
 * 왜 있는가
 *   렌더러 오타 하나로 목록이 통째로 비어도 lint 는 전부 초록이다. 등록표는 맞고,
 *   채널도 맞고, 문법도 맞는데 화면에 아무것도 안 그려진다. 그건 사람이 열어 봐야만 안다 —
 *   그래서 여기서 진짜 Electron 창을 띄우고 DOM 을 읽는다.
 *   기대값은 등록표에서 파생시킨다(칩 수·설정 필드 수·캘린더 수). 화면에 손으로 적은
 *   목록이 등록표와 갈라지면 이 검사가 운다.
 *
 * 기대값을 손으로 적지 않는 이유 (이 파일에서 실제로 난 사고)
 *   "설정: 필드가 등록표 수와 어긋나지 않는다" 는 `rows >= 14` 였다. 등록표가 그 사이
 *   스무 행을 넘겼는데도 14 와 비교했으니, 설정 패널에서 컨트롤을 여러 개 지워도 스모크는
 *   초록이었다 — "검사가 조용히 아무것도 검사하지 않는" 상태다. `calOptions === 2`·
 *   `calRows === 2` 도 testdata 를 한 줄 고치는 순간 거짓말이 되는 손으로 적은 상수였다.
 *   그래서 지금은 (1) 등록표(registry) 와 (2) 실제로 앱에 넘긴 픽스처(testdata 사본)에서
 *   정확한 수를 파생시켜 `===` 로 대조한다. 하한(>=) 비교는 반복 전개처럼 이 파일이
 *   recurrence.js 를 복제해야만 정확히 셀 수 있는 자리에만 남기고, 그 자리마다
 *   "왜 정확히 셀 수 없는가"를 주석으로 적는다.
 *
 * Playwright 를 쓰지 않는 이유
 *   의존성 0 을 유지한다. Electron 이 이미 CDP(--remote-debugging-port)를 열어 주므로
 *   최소한의 WebSocket 클라이언트만 있으면 된다(Node 22 의 전역 WebSocket).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const APP = join(SCRIPTS, '..');
const ROOT = join(APP, '..');
const PORT = 9333;

const REG = (await import('file:///' + join(APP, 'shared', 'registry.js').split('\\').join('/'))).default
  || (await import('file:///' + join(APP, 'shared', 'registry.js').split('\\').join('/')));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 조건이 참이 될 때까지 짧게 되묻는다(마지막 값을 돌려준다).
 *  고정 sleep 은 바쁜 머신에서 "아직 안 그려졌을 뿐인데 실패" 를 만든다 —
 *  검사가 랜덤하게 빨개지면 사람은 그 검사를 믿지 않고 그냥 다시 돌린다. */
async function until(fn, timeoutMs = 4000, stepMs = 150) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started >= timeoutMs) return v;
    await sleep(stepMs);
  }
}

/** 최소 CDP 클라이언트 — 타깃 하나에 붙어 Runtime.evaluate 만 쓴다. */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  return {
    send(method, params) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); reject(new Error(method + ' 응답 없음(10초)')); }
        }, 10000);
      });
    },
    async eval(expr) {
      // 표현식이 Promise 를 돌려주는 경우가 흔하다(api.invoke). await 하지 않으면
      // Promise 객체를 그대로 직렬화해 '{}' 가 돌아온다 — 검사가 조용히 거짓 실패한다.
      const r = await this.send('Runtime.evaluate', {
        expression: `(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({__err: String(e)}); } })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error('페이지 예외: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      const v = r.result?.value;
      if (v === undefined) return undefined;
      const parsed = JSON.parse(v);
      if (parsed && parsed.__err) throw new Error('페이지 오류: ' + parsed.__err);
      return parsed;
    },
    close() { try { ws.close(); } catch (e) {} },
  };
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function waitForTarget(match, timeoutMs = 25000) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await targets();
      const hit = list.find(t => t.type === 'page' && match(t));
      if (hit) return hit;
    } catch (e) { lastErr = e; }
    await sleep(400);
  }
  throw new Error('창을 찾지 못했습니다' + (lastErr ? ' (' + lastErr.message + ')' : ''));
}

// ---- 픽스처 데이터 준비 (실사용 원장을 절대 만지지 않는다) ----
const fixtureDir = join(ROOT, 'testdata');
const FIXTURE_FILES = ['todos.json', 'calendars.json'];
// 픽스처가 없으면 앱은 storage.js 의 기본 캘린더(캘린더 1개)와 빈 원장으로 뜬다.
// 그 상태에서 기대값을 "적당히" 낮추면 스모크가 무엇과 비교하는지 아무도 모르게 된다 —
// 여기서는 파생의 근거 자체가 사라진 것이므로 임시 디렉터리를 만들기도 전에 멈춘다.
for (const f of FIXTURE_FILES) {
  if (!existsSync(join(fixtureDir, f))) {
    console.error(`  FAIL check:ui — 픽스처가 없습니다: testdata/${f}`);
    console.error('       이 스모크의 기대값(항목 수·캘린더 수)은 전부 이 파일에서 파생됩니다. 복원하거나, 픽스처를 옮겼다면 app/scripts/check-ui.mjs 의 fixtureDir 를 새 위치로 고치세요.');
    process.exit(1);
  }
}
const dataDir = process.env.TODO_DATA_DIR || mkdtempSync(join(tmpdir(), 'todo-ui-'));
const ownDir = !process.env.TODO_DATA_DIR;
mkdirSync(dataDir, { recursive: true });
for (const f of readdirSync(fixtureDir)) {
  if (f.endsWith('.json')) copyFileSync(join(fixtureDir, f), join(dataDir, f));
}
// 픽스처의 반복 일정이 "지금" 기준으로도 보이도록 현재 주 기준 일정 하나를 추가한다.
const now = new Date();
const soon = new Date(now.getTime() + 60 * 60000);
const p2 = n => String(n).padStart(2, '0');
// 오프셋은 실행 기계에서 구한다. +09:00 을 박아 두면 KST 가 아닌 러너(CI 는 UTC)에서
// "1시간 뒤"로 주입한 일정이 아홉 시간 어긋나 다른 날·다른 주에 그려진다 —
// 그러면 이 파일이 파생한 기대값과 화면이 갈라져 원인 없는 실패가 난다.
const isoLocal = d => {
  const off = -d.getTimezoneOffset();
  const sg = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00`
    + `${sg}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
};
const SOON_TITLE = 'UI 스모크 임박 일정';
const todosPath = join(dataDir, 'todos.json');
const todos = JSON.parse(readFileSync(todosPath, 'utf8'));
todos.items.push({
  kind: 'calendar#event', id: 'ui-smoke-soon', status: 'confirmed',
  summary: SOON_TITLE,
  start: { dateTime: isoLocal(soon) }, end: { dateTime: isoLocal(new Date(soon.getTime() + 30 * 60000)) },
  extendedProperties: { private: { todoStatus: 'pending', renotifyMinutes: '5', notifyCount: '0', calendarId: 'default' } },
});
writeFileSync(todosPath, JSON.stringify(todos, null, 2), 'utf8');

// ---- 기대값 파생 (앱에 실제로 넘긴 픽스처 사본 + 등록표에서) ----
// 손으로 적은 상수는 testdata 를 한 줄 고치는 순간 거짓말이 된다. 아래 수는 전부
// "앱이 지금 읽고 있는 그 파일"에서 나온다 — 픽스처를 고치면 기대값이 함께 움직인다.

const calReg = JSON.parse(readFileSync(join(dataDir, 'calendars.json'), 'utf8'));
const fxAccounts = [];
const fxCalendars = [];
for (const svc of calReg.services || []) {
  for (const acc of svc.accounts || []) {
    fxAccounts.push(acc);
    for (const cal of acc.calendars || []) fxCalendars.push(cal);
  }
}
// list.html openSettings() 의 필터와 같은 규칙 — 읽기 전용 캘린더는 기본 캘린더로 못 고른다.
const fxWritableCalendars = fxCalendars.filter(
  c => !c.accessRole || c.accessRole === 'owner' || c.accessRole === 'writer');
// state.listInstances() 가 건너뛰는 캘린더(사이드바에서 끈 것).
const fxHiddenCalIds = new Set(fxCalendars.filter(c => c.selected === false).map(c => c.id));

// list.html refresh() 가 조회하는 창(now-30일 ~ now+365일)과 state.listInstances() 의
// 단일 일정 포함 조건(end >= from && start < to)을 그대로 다시 계산한다.
const LIST_BACK_DAYS = 30;
const LIST_FWD_DAYS = 365;
const winFrom = now.getTime() - LIST_BACK_DAYS * 86400000;
const winTo = now.getTime() + LIST_FWD_DAYS * 86400000;
const privOf = ev => (ev.extendedProperties && ev.extendedProperties.private) || {};
// main/util.js fromRfc3339 와 같은 규칙: date-only 는 로컬 자정으로 읽는다
// (new Date('2026-08-20') 는 UTC 자정이라 KST 에서 하루 앞으로 밀린다).
const parseWhen = (s) => {
  if (!s) return null;
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return p ? new Date(Number(p[1]), Number(p[2]) - 1, Number(p[3])) : new Date(s);
};
const startOf = ev => parseWhen((ev.start || {}).dateTime || (ev.start || {}).date);
const endOf = ev => parseWhen((ev.end || {}).dateTime || (ev.end || {}).date) || startOf(ev);
// 반복 일정은 여기서 세지 않는다 — 정확한 회차 수를 알려면 recurrence.js(RRULE 전개·EXDATE·
// 예외 회차)를 이 파일에 복제해야 하고, 그러면 "전개기가 틀려도 기대값이 같이 틀리는" 검사가 된다.
// 그래서 반복은 DOM 에서 센 수(↻ 표식)로 다루고, 아래 수는 단일 일정만의 정확한 수다.
const fxPlainVisible = todos.items.filter(ev =>
  !privOf(ev).deletedAt &&
  !(ev.recurrence && ev.recurrence.length) &&
  !fxHiddenCalIds.has(privOf(ev).calendarId || 'default') &&
  startOf(ev) &&                                  // 시작이 없는 행은 state 도 건너뛴다
  endOf(ev).getTime() >= winFrom && startOf(ev).getTime() < winTo);
const statusOf = ev => privOf(ev).todoStatus || 'pending';
const fxPending = fxPlainVisible.filter(ev => statusOf(ev) === 'pending').length;
const fxDone = fxPlainVisible.filter(ev => statusOf(ev) === 'done').length;
const fxCancelled = fxPlainVisible.filter(ev => statusOf(ev) === 'cancelled').length;

// 픽스처의 파생 근거가 사라졌는가 — 근거가 바뀌면 위 계산이 조용히 틀리므로 실패로 알린다.
const staleFixture = [];
if (todos.items.some(ev => privOf(ev).instanceState)) {
  staleFixture.push('testdata/todos.json 에 instanceState(반복 회차별 상태)가 생겼습니다 — 완료·취소 기대값이 회차 상태를 세지 않으므로 app/scripts/check-ui.mjs 의 fxDone/fxCancelled 계산을 회차까지 세도록 고치세요.');
}
if (!todos.items.some(ev => ev.recurrence && ev.recurrence.length)) {
  staleFixture.push('testdata/todos.json 에 반복 일정이 없습니다 — "반복 전개 ≥ 1" 하한 비교가 아무것도 검사하지 않게 됩니다. 반복 픽스처를 복원하거나 app/scripts/check-ui.mjs 의 목록 검사에서 그 조건을 빼세요.');
}

// 설정 패널 컨트롤 수 = 등록 필드 수 − (패널 밖에서 다루는 필드) + (등록 필드가 아닌 컨트롤).
// lint:settings 가 같은 사실을 소스에서 판정한다(OUTSIDE_PANEL / COLLECT_ONLY). 여기서는
// 실제 창의 DOM 을 세어 대조한다 — 소스는 맞는데 화면이 안 그려지는 경우를 잡는 게 스모크의 일이다.
const PANEL_EXEMPT = [
  { key: 'listSortAsc', control: 'btnSort', why: '푸터의 정렬 토글 버튼이 값의 주인이다(lint-settings.mjs OUTSIDE_PANEL)' },
  { key: 'showClosed', control: 'chkClosed', why: '푸터의 "지난 항목" 체크박스가 값의 주인이다(lint-settings.mjs COLLECT_ONLY)' },
];
const PANEL_EXTRA = [
];
const expectPanelControls = REG.SETTINGS_FIELDS.length - PANEL_EXEMPT.length + PANEL_EXTRA.length;

// 목록 창 클래식 입력 칸. id 목록과 기대 수가 같은 자리에서 나온다(6 을 손으로 적지 않는다).
const CLASSIC_FIELD_IDS = ['qsDate', 'qsTime', 'qeDate', 'qeTime', 'qAllDay', 'qLoc'];

// ---- Electron 기동 ----
// 프로필(userData)도 임시 디렉터리로 분리한다. 단일 인스턴스 잠금(main.js requestSingleInstanceLock)은
// userData 기준이라, 앱을 켜 둔 채 이 스모크를 돌리면 두 번째 인스턴스가 잠금을 못 얻고 즉시 quit 해
// "창을 찾지 못했습니다" 로만 끝난다 — 코드는 멀쩡한데 옆에 띄워 둔 창 때문에 검사가 빨개진다.
// 실사용 프로필(캐시·잠금)을 건드리지 않는 이유도 같다(TODO_DATA_DIR 격리와 같은 원칙).
const profileDir = mkdtempSync(join(tmpdir(), 'todo-ui-profile-'));
const electronArgs = ['.', `--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`];
const electronBin = join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronCli = existsSync(electronBin) ? electronBin : null;
const child = electronCli
  ? spawn(electronCli, electronArgs, {
      cwd: APP, env: { ...process.env, TODO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn('npx', ['electron', ...electronArgs], {
      cwd: APP, env: { ...process.env, TODO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], shell: true,
    });

let appLog = '';
child.stdout.on('data', d => { appLog += d.toString(); });
child.stderr.on('data', d => { appLog += d.toString(); });

const results = [];
let fatal = null;

/** 지워질 때까지 잠깐 되묻는다 — 죽는 중인 Electron 이 프로필 폴더를 잠그고 있다.
 *  한 번 실패하고 삼키면 임시 디렉터리(프로필 수십 MB)가 실행할 때마다 쌓인다. */
async function rmRetry(dir) {
  for (let i = 0; i < 15; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { await sleep(200); }
  }
  return false;
}

async function cleanup() {
  try { child.kill(); } catch (e) {}
  // 프로세스가 실제로 끝날 때까지 기다린다(파일 잠금이 풀려야 지워진다).
  await until(() => child.exitCode !== null || child.signalCode !== null, 5000, 100);
  if (ownDir) await rmRetry(dataDir);
  await rmRetry(profileDir); // 프로필은 이 실행이 만든 것이므로 항상 지운다
}

try {
  // ① 목록 창
  const listTarget = await waitForTarget(t => t.url.includes('list.html'));
  const list = await cdp(listTarget.webSocketDebuggerUrl);
  await sleep(1500); // 최초 refresh() 완료 대기

  const listState = await list.eval(`({
    chips: document.querySelectorAll('#chips button').length,
    items: document.querySelectorAll('#list .item').length,
    rows: [...document.querySelectorAll('#list .item')].map(el => ({
      title: (el.querySelector('.t') || {}).textContent || '',
      sub: (el.querySelector('.sub') || {}).textContent || '',
      closed: el.classList.contains('closed'),
    })),
    sections: document.querySelectorAll('#list .sect').length,
    stats: document.getElementById('stats').textContent,
    showClosed: !!(document.getElementById('chkClosed') || {}).checked,
    hasInput: !!document.getElementById('txt'),
    sortBtn: document.getElementById('btnSort').textContent.trim(),
    missingClassic: ${JSON.stringify(CLASSIC_FIELD_IDS)}.filter(id => !document.getElementById(id)),
    apiRegistry: !!(window.api && window.api.registry),
  })`);

  // 반복 회차는 부제의 ↻ 표식으로 가른다(list.html renderItem 이 붙인다).
  // 단일 일정 수는 픽스처에서 정확히 파생되고, 반복 회차 수만 하한으로 본다.
  const recurRows = listState.rows.filter(r => r.sub.includes('↻')).length;
  const plainRows = listState.rows.length - recurRows;
  const closedRows = listState.rows.filter(r => r.closed).length;
  const pendingRows = listState.rows.length - closedRows;
  // 지난 항목 구획은 chkClosed 가 켜져 있을 때만 그려진다 — 그 상태를 DOM 에서 읽어 반영한다.
  const expectPlainRows = fxPending + (listState.showClosed ? fxDone + fxCancelled : 0);
  const sm = /대기\s+(\d+)\s*·\s*완료\s+(\d+)\s*·\s*취소\s+(\d+)/.exec(listState.stats);
  const expectSections = 1 + (closedRows > 0 ? 1 : 0);

  results.push([`목록: 빠른입력 칩이 등록표에서 나온다 (${listState.chips}/${REG.QUICK_CHIPS.length})`,
    listState.chips === REG.QUICK_CHIPS.length,
    `registry.QUICK_CHIPS ${REG.QUICK_CHIPS.length}개인데 #chips 버튼은 ${listState.chips}개입니다 — app/renderer/list.html 의 QUICK_CHIPS 순회를 확인하세요.`]);

  results.push([`목록: 단일 일정이 픽스처 파생 수만큼 그려진다 (${plainRows}/${expectPlainRows}, 반복 전개 ${recurRows}건)`,
    plainRows === expectPlainRows && recurRows >= 1 && staleFixture.length === 0,
    staleFixture.length ? staleFixture.join(' / ')
      : plainRows !== expectPlainRows
        ? `testdata 에서 파생한 단일 일정 ${expectPlainRows}건(대기 ${fxPending} + 지난 ${listState.showClosed ? fxDone + fxCancelled : 0})과 그려진 ${plainRows}건이 다릅니다 — app/renderer/list.html refresh()/renderItem() 또는 main/state.js listInstances() 를 보세요.`
        : '반복 일정이 한 회차도 그려지지 않았습니다 — main/recurrence.js expand() 와 list.html 의 14일 지평선 필터를 보세요. (정확한 회차 수는 recurrence.js 를 복제해야만 셀 수 있어 하한만 봅니다.)']);

  results.push([`목록: 통계 줄과 구획이 그려진 항목과 일치한다 (${listState.stats.trim()})`,
    !!sm && Number(sm[2]) === fxDone && Number(sm[3]) === fxCancelled
      && Number(sm[1]) === pendingRows && listState.sections === expectSections,
    !sm ? `통계 줄이 "대기 n · 완료 n · 취소 n" 형태가 아닙니다: "${listState.stats}" — app/renderer/list.html refresh() 의 $('stats') 대입을 보세요.`
      : `통계=대기 ${sm[1]}·완료 ${sm[2]}·취소 ${sm[3]} / 그려진 항목=대기 ${pendingRows}·지난 ${closedRows} / 픽스처 파생=완료 ${fxDone}·취소 ${fxCancelled}, 구획 ${listState.sections}개(기대 ${expectSections}) — 숫자가 실제로 그려진 것과 갈라졌습니다(list.html refresh()).`]);

  results.push(['목록: 자연어 입력란이 있다', listState.hasInput === true,
    'app/renderer/list.html 의 #txt 입력란이 없습니다.']);

  results.push([`목록: 클래식 입력(기간·종일·장소) ${CLASSIC_FIELD_IDS.length}칸이 있다`,
    listState.missingClassic.length === 0,
    `없는 칸: ${listState.missingClassic.join(', ')} — app/renderer/list.html 에 해당 id 를 되살리거나 check-ui.mjs 의 CLASSIC_FIELD_IDS 를 새 id 로 고치세요.`]);

  // 기본 정렬 방향도 등록표에서 나온다(설정 기본값 listSortAsc).
  const wantSortLabel = REG.settingsDefaults().listSortAsc === false ? '미래순' : '과거순';
  results.push([`목록: 정렬 토글 기본이 ${wantSortLabel}(등록 기본값 파생)`,
    listState.sortBtn.includes(wantSortLabel),
    `#btnSort 는 "${listState.sortBtn}" 인데 registry 기본값(listSortAsc=${REG.settingsDefaults().listSortAsc})은 "${wantSortLabel}" 입니다 — list.html updateSortBtn() 을 보세요.`]);

  results.push(['관문: window.api.registry 로 등록표가 노출된다', listState.apiRegistry === true,
    'preload.js 가 registry 를 노출하지 않습니다.']);

  // ② 미등록 채널은 관문이 막는다 (와일드카드 브리지 회귀 방지)
  const gate = await list.eval(`window.api.invoke('아무거나-없는-채널').then(() => 'allowed', e => 'blocked:' + e.message)`);
  results.push(['관문: 미등록 채널 호출이 거부된다', typeof gate === 'string' && gate.startsWith('blocked'),
    `미등록 채널이 통과했습니다(${JSON.stringify(gate)}) — app/preload.js 의 allowlist(registry.IPC_CHANNELS 파생)가 뚫렸습니다.`]);

  // ③ 자연어 입력 → 추가 → 목록 반영
  const before = listState.items;
  await list.eval(`(() => {
    const t = document.getElementById('txt');
    t.value = '내일 오후 3시 스모크 테스트 항목';
    t.dispatchEvent(new Event('input'));
    return document.getElementById('preview').textContent;
  })()`);
  const preview = await list.eval(`document.getElementById('preview').textContent`);
  results.push(['입력: 자연어 해석 미리보기가 시각을 보여준다', /\d+월 \d+일/.test(preview),
    `#preview 가 "${preview}" 입니다 — "M월 D일" 을 보여야 합니다(app/shared/nlp.js 의 parse 와 list.html updatePreview()).`]);

  await list.eval(`(() => { document.getElementById('btnAdd').click(); return 1; })()`);
  await sleep(1200);
  const after = await list.eval(`({ items: document.querySelectorAll('#list .item').length,
                                   titles: [...document.querySelectorAll('#list .item .t')].map(e => e.textContent) })`);
  results.push([`입력: 추가한 항목이 목록에 나타난다 (${before}→${after.items})`,
    after.items === before + 1 && after.titles.some(t => t.includes('스모크 테스트 항목')),
    `추가 전 ${before}건 → 추가 후 ${after.items}건(기대 ${before + 1}건), 제목: [${after.titles.join(' | ')}] — add-event 저장(main/state.js) 또는 data-changed 로 인한 refresh() 를 보세요.`]);

  // ④ 설정 패널이 등록표만큼 컨트롤을 그린다 (정확한 수. >= 는 필드를 지워도 통과한다)
  await list.eval(`(() => { document.getElementById('btnSettings').click(); return 1; })()`);
  await sleep(600);
  const settings = await list.eval(`({
    open: document.getElementById('settingsOverlay').style.display === 'block',
    controls: document.querySelectorAll('#settingsOverlay .panel input, #settingsOverlay .panel select, #settingsOverlay .panel textarea').length,
    calOptions: document.querySelectorAll('#sDefCal option').length,
    calOptionValues: [...document.querySelectorAll('#sDefCal option')].map(o => o.value),
    exemptInPanel: ${JSON.stringify(PANEL_EXEMPT.map(e => e.control))}.filter(id => !!document.querySelector('#settingsOverlay #' + id)),
    exemptMissing: ${JSON.stringify(PANEL_EXEMPT.map(e => e.control))}.filter(id => !document.getElementById(id)),
    extraMissing: ${JSON.stringify(PANEL_EXTRA.map(e => e.control))}.filter(id => !document.querySelector('#settingsOverlay #' + id)),
  })`);

  // 유예(예외)의 근거가 아직 살아 있는가 — 근거가 사라지면 실패시킨다(CLAUDE.md "유예는 방패가 아니다").
  const staleExempt = [];
  for (const e of PANEL_EXEMPT) {
    if (!REG.SETTINGS_FIELDS.some(f => f.key === e.key)) {
      staleExempt.push(`registry.SETTINGS_FIELDS 에 '${e.key}' 가 없습니다 — 등록이 사라졌으니 app/scripts/check-ui.mjs 의 PANEL_EXEMPT 에서 그 줄을 빼세요.`);
    }
  }
  for (const id of settings.exemptMissing) {
    const e = PANEL_EXEMPT.find(x => x.control === id);
    staleExempt.push(`#${id} 가 목록 창에 없습니다 — '${e.key}' 를 패널 밖 예외로 둔 근거(${e.why})가 사라졌습니다. 컨트롤을 되살리거나 PANEL_EXEMPT 에서 빼고 패널에 컨트롤을 추가하세요.`);
  }
  for (const id of settings.exemptInPanel) {
    const e = PANEL_EXEMPT.find(x => x.control === id);
    staleExempt.push(`#${id}(${e.key}) 가 설정 패널 안으로 들어왔습니다 — PANEL_EXEMPT 에서 빼세요(기대 컨트롤 수가 하나 늘어납니다).`);
  }
  for (const x of PANEL_EXTRA) {
    if (REG.SETTINGS_FIELDS.some(f => f.key === x.notRegistered)) {
      staleExempt.push(`'${x.notRegistered}' 가 이제 registry.SETTINGS_FIELDS 에 있습니다 — #${x.control} 을 "등록 필드가 아닌 컨트롤"로 세던 근거가 사라졌으니 check-ui.mjs 의 PANEL_EXTRA 에서 빼세요.`);
    }
  }
  for (const id of settings.extraMissing) {
    staleExempt.push(`#${id} 컨트롤이 설정 패널에서 사라졌습니다 — check-ui.mjs 의 PANEL_EXTRA 에서 그 줄을 빼세요(기대 수가 하나 줄어듭니다).`);
  }

  results.push(['설정: 패널이 열린다', settings.open === true,
    '#settingsOverlay 가 열리지 않았습니다 — list.html openSettings() 를 보세요.']);

  results.push([`설정: 패널 컨트롤 수가 등록표에서 파생된 수와 같다 (${settings.controls}/${expectPanelControls})`,
    settings.controls === expectPanelControls && staleExempt.length === 0,
    settings.controls !== expectPanelControls
      ? `기대 ${expectPanelControls}개 = 등록 ${REG.SETTINGS_FIELDS.length}개 − 패널 밖 ${PANEL_EXEMPT.length}개(${PANEL_EXEMPT.map(e => e.key).join(', ')}) + 비등록 컨트롤 ${PANEL_EXTRA.length}개(${PANEL_EXTRA.map(e => '#' + e.control).join(', ')}), 실제 ${settings.controls}개 — registry.SETTINGS_FIELDS 에 행을 넣었다면 app/renderer/list.html 설정 패널에 컨트롤을 붙이고(반대면 등록을 지우고), 패널 밖에서 다루는 필드라면 check-ui.mjs 의 PANEL_EXEMPT 에 근거와 함께 넣으세요.`
      : staleExempt.join(' / ')]);

  results.push([`설정: 기본 캘린더 선택지가 캘린더 레지스트리에서 나온다 (${settings.calOptions}/${fxWritableCalendars.length})`,
    settings.calOptions === fxWritableCalendars.length
      && fxWritableCalendars.every(c => settings.calOptionValues.includes(c.id)),
    `#sDefCal 선택지 [${settings.calOptionValues.join(', ')}] 가 픽스처의 쓰기 가능한 캘린더 [${fxWritableCalendars.map(c => c.id).join(', ')}](testdata/calendars.json)와 다릅니다 — list.html openSettings() 의 select 채우기(accessRole 필터 포함)를 보세요.`]);
  await list.eval(`(() => { document.getElementById('sClose').click(); return 1; })()`);

  // ⑤ 캘린더 창 — 사이드바가 캘린더 레지스트리에서 나오고 뷰가 그려진다
  await list.eval(`window.api.invoke('open-calendar')`);
  const calTarget = await waitForTarget(t => t.url.includes('calendar.html'));
  const cal = await cdp(calTarget.webSocketDebuggerUrl);
  await sleep(2500);
  const calState = await cal.eval(`({
    calRows: document.querySelectorAll('#side .cal-row').length,
    calNames: [...document.querySelectorAll('#side .cal-row .nm')].map(e => e.textContent),
    accounts: document.querySelectorAll('#side .acc').length,
    events: document.querySelectorAll('.fc-event').length,
    eventTitles: [...document.querySelectorAll('.fc-event')].map(e => e.textContent),
    hasGrid: !!document.querySelector('.fc-view-harness'),
    paletteSwatches: document.querySelectorAll('#paletteColors .c').length,
    wheel: !!document.querySelector('#paletteColors .c.wheel'),
  })`);
  results.push([`캘린더: 사이드바 캘린더 수 = 픽스처 등록 수 (${calState.calRows}/${fxCalendars.length})`,
    calState.calRows === fxCalendars.length
      && fxCalendars.every(c => calState.calNames.some(n => n.includes(c.summary))),
    `사이드바 [${calState.calNames.join(', ')}] 가 testdata/calendars.json 의 [${fxCalendars.map(c => c.summary).join(', ')}] 와 다릅니다 — app/renderer/calendar.html renderSidebar() 를 보세요.`]);

  results.push([`캘린더: 계정 그룹이 픽스처 수만큼 그려진다 (${calState.accounts}/${fxAccounts.length})`,
    calState.accounts === fxAccounts.length,
    `#side .acc 가 ${calState.accounts}개인데 testdata/calendars.json 의 계정은 ${fxAccounts.length}개(${fxAccounts.map(a => a.label).join(', ')})입니다 — renderSidebar() 의 계정 순회를 보세요.`]);

  results.push(['캘린더: 격자(뷰)가 렌더된다', calState.hasGrid === true,
    '.fc-view-harness 가 없습니다 — FullCalendar 초기화가 실패했습니다(창 콘솔 로그 확인).']);

  // 격자에 그려진 일정의 정확한 수는 여기서 세지 않는다: 주 뷰의 범위 × 반복 전개 × FullCalendar 가
  // 한 일정을 여러 조각으로 그리는 경우까지 재현해야 하고, 그러면 뷰 로직을 복제한 검사가 된다.
  // 대신 "언제 돌려도 이번 주에 반드시 있는" 임박 일정(위에서 now+1시간으로 주입)이 실제로
  // 격자에 있는지를 본다 — 개수 하한과 달리 이건 무엇이 빠졌는지 말해 준다.
  results.push([`캘린더: 임박 일정이 격자에 그려진다 (.fc-event ${calState.events}개)`,
    calState.events >= 1 && calState.eventTitles.some(t => t.includes(SOON_TITLE)),
    `격자에서 "${SOON_TITLE}"(now+1시간에 주입)을 찾지 못했습니다. 그려진 것: [${calState.eventTitles.join(' | ')}] — calendar.html 의 events 피드(list-instances)와 캘린더 표시 토글을 보세요.`]);

  results.push([`캘린더: 색 팔레트가 등록표에서 나온다(+컬러휠) (${calState.paletteSwatches}/${REG.CAL_PALETTE.length + 1})`,
    calState.paletteSwatches === REG.CAL_PALETTE.length + 1 && calState.wheel === true,
    `#paletteColors 견본 ${calState.paletteSwatches}개(휠 ${calState.wheel ? '있음' : '없음'})가 registry.CAL_PALETTE ${REG.CAL_PALETTE.length}개 + 컬러휠 1 과 다릅니다 — calendar.html 의 팔레트 생성을 보세요.`]);

  // ⑥ 뷰 전환 — 실제로 changeView 를 부르고 적용됐는지 확인한다.
  // (예전에는 push 결과만 세어 언제나 참이었다. 캘린더가 통째로 죽어도 초록이었다.)
  // 창 스크립트가 IIFE 안에 있어 calendar 객체를 밖에서 만질 수 없다.
  // 그래서 사용자가 실제로 쓰는 경로(단축키 1~4)로 전환하고 DOM 이 바뀌었는지 본다.
  const WANT_VIEWS = [
    ['1', 'fc-timeGridDay-view'],
    ['2', 'fc-timeGridWeek-view'],
    ['3', 'fc-dayGridMonth-view'],
    ['4', 'fc-multiMonthYear-view'],
  ];
  const views = [];
  for (const [key, cls] of WANT_VIEWS) {
    await cal.eval(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true })); return 1; })()`);
    // 연 뷰(multiMonth)는 12개월을 그리느라 늦게 붙는다. 고정 대기로는 느린 머신에서 거짓 실패가 난다.
    const ok = await until(async () => {
      const seen = await cal.eval(`(document.querySelector('.fc-view') || {}).className || ''`);
      return typeof seen === 'string' && seen.includes(cls);
    });
    views.push(ok === true);
  }
  await cal.eval(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true })); return 1; })()`);
  results.push(['캘린더: 단축키 1~4 로 일/주/월/연 뷰가 실제로 전환된다',
    views.length === WANT_VIEWS.length && views.every(Boolean),
    `전환 실패한 단축키: ${WANT_VIEWS.filter((_, i) => !views[i]).map(([k, c]) => `${k}→${c}`).join(', ') || '(전환 자체가 시도되지 않음)'} — app/renderer/calendar.html 의 keydown 핸들러와 changeView 를 보세요.`]);

  // ⑦ ICS 구독 — 사이드바의 "＋ 캘린더 추가…" 에서 실제로 구독을 만들어 본다.
  // 배관(파서·캐시·조회)은 단위 시험이 보지만, 그 폼이 실제로 눌리는지는 창을 띄워야만 안다
  // (id 오타 하나면 사용자는 구독을 아예 추가할 수 없고 lint 는 초록이다).
  const icsPath = join(ROOT, 'testdata', 'sample.ics');
  if (!existsSync(icsPath)) {
    results.push(['캘린더: ICS 구독 픽스처가 있다', false,
      'testdata/sample.ics 가 없습니다 — 구독 스모크가 아무것도 검사하지 못합니다.']);
  } else {
    const beforeRows = await cal.eval(`document.querySelectorAll('#side .cal-row').length`);
    // 메뉴 → "ICS 주소로 구독" 항목(문구가 아니라 순서에 기대지 않도록 텍스트로 찾는다)
    const opened = await cal.eval(`(() => {
      const btn = [...document.querySelectorAll('#side .side-foot button')].find(b => b.textContent.includes('캘린더 추가'));
      if (!btn) return 'no-button';
      btn.click();
      const item = [...document.querySelectorAll('#addMenu .item')].find(d => d.textContent.includes('ICS'));
      if (!item) return 'no-menu-item';
      if (item.classList.contains('soon')) return 'still-disabled';
      item.click();
      return document.querySelector('.subform') ? 'ok' : 'no-form';
    })()`);
    results.push(['캘린더: "＋ 캘린더 추가 → ICS 주소로 구독" 이 열린다', opened === 'ok',
      `메뉴 열기 결과: ${opened} — calendar.html 의 showAddMenu()/showSubscribeForm() 을 보세요.`]);

    if (opened === 'ok') {
      const submitted = await cal.eval(`(() => {
        const box = document.querySelector('.subform');
        box.querySelector('.v').value = ${JSON.stringify(icsPath)};
        box.querySelector('.n').value = '스모크 구독';
        box.querySelector('.ok').click();
        return 'clicked';
      })()`);
      const grew = await until(async () => {
        const n = await cal.eval(`document.querySelectorAll('#side .cal-row').length`);
        return n === beforeRows + 1;
      }, 15000);
      // 배지는 구독 말고 구글에도 붙는다 — '구독' 배지만 센다.
      const subState = await cal.eval(`({
        badges: [...document.querySelectorAll('#side .cal-row .ro')].filter(e => e.textContent === '구독').length,
        names: [...document.querySelectorAll('#side .cal-row .nm')].map(e => e.textContent),
      })`);
      results.push(['캘린더: 구독이 사이드바에 읽기 전용으로 추가된다',
        submitted === 'clicked' && grew === true && subState.badges === 1
          && subState.names.some(n => n.includes('스모크 구독')),
        `사이드바 [${(subState.names || []).join(', ')}] · 구독 배지 ${subState.badges}개 — calendar.html 의 구독 폼 제출과 state.calendarOp('add-subscription') 을 보세요.`]);

      // 갱신이 끝나면 격자에 그 일정이 나타나야 한다(파서→캐시→조회가 실제로 이어지는지).
      const showed = await until(async () => {
        const titles = await cal.eval(`[...document.querySelectorAll('.fc-event')].map(e => e.textContent).join('|')`);
        return typeof titles === 'string' && titles.includes('구독 스모크');
      }, 20000);
      results.push(['캘린더: 구독 일정이 격자에 그려진다', showed === true,
        'testdata/sample.ics 의 일정이 격자에 나타나지 않았습니다 — main/calendars/subscriptions.js 갱신과 state.subInstanceViews() 를 보세요.']);

      // 구독은 원본을 못 고친다. 그래도 "내가 처리했다"는 표시는 내 화면에 남아야 하고,
      // 그것이 overlay.json 에 저장되어 다시 그려도 살아 있어야 한다(항목 3의 요점).
      if (showed === true) {
        const card = await cal.eval(`(() => {
          const el = [...document.querySelectorAll('.fc-event')].find(e => e.textContent.includes('구독 스모크'));
          if (!el) return { err: 'no-event' };
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return {
            sub: (document.getElementById('cardSub') || {}).textContent || '',
            acts: [...document.querySelectorAll('#cardActs button')].map(b => b.textContent),
          };
        })()`);
        results.push(['캘린더: 구독 일정 카드는 읽기 전용이라고 말하고 "내 화면에서 완료" 를 준다',
          !!card && !card.err && card.sub.includes('원본은 못 고칩니다')
            && (card.acts || []).some(t => t.includes('내 화면에서 완료'))
            && !(card.acts || []).some(t => t === '삭제' || t === '완료'),
          `카드 부제 "${(card && card.sub) || ''}" · 버튼 [${((card && card.acts) || []).join(', ')}] — calendar.html 의 it.readOnly 분기를 보세요.`]);

        const clicked = await cal.eval(`(() => {
          const b = [...document.querySelectorAll('#cardActs button')].find(x => x.textContent.includes('내 화면에서 완료'));
          if (!b) return 'no-button';
          b.click();
          return 'clicked';
        })()`);
        const closed = await until(async () => {
          return await cal.eval(`(() => {
            const el = [...document.querySelectorAll('.fc-event')].find(e => e.textContent.includes('구독 스모크'));
            return !!el && el.classList.contains('closed');
          })()`);
        }, 10000);
        results.push(['캘린더: 구독 일정을 내 화면에서 완료 처리할 수 있다',
          clicked === 'clicked' && closed === true,
          `버튼 클릭 ${clicked} · 격자 표시 갱신 ${closed} — main.js 의 set-status(instId 'sub:') 와 state.setOverlayStatus() 를 보세요.`]);

        // 저장까지 갔는가 — 화면 상태가 아니라 파일을 본다.
        const overlayStore = REG.DATA_STORES.find(s => s.key === 'subOverlay');
        const overlayFile = join(dataDir, overlayStore ? overlayStore.file : 'overlay.json');
        let saved = null;
        await until(async () => {
          if (!existsSync(overlayFile)) return false;
          try { saved = JSON.parse(readFileSync(overlayFile, 'utf8')); } catch { return false; }
          return Object.keys(saved || {}).some(k => k.startsWith('sub:'));
        }, 10000);
        // 파일에 적히는 이름은 원장과 같은 등록 어휘 todoStatus 다(registry.PRIVATE_FIELDS).
        // 오버레이만 'status' 로 달리 부르면 나중에 원장과 오버레이를 함께 읽는 코드가 갈라진다.
        const keys = Object.keys(saved || {});
        results.push(['캘린더: 구독 완료 표시가 overlay.json 에 남는다(껐다 켜도 살아 있게)',
          keys.some(k => k.startsWith('sub:') && saved[k] && saved[k].todoStatus === 'done'),
          `overlay.json 내용 ${JSON.stringify(saved)} — storage.saveOverlay() 를 보세요. ` +
          `여기서 비어 있으면 표시가 화면에만 남고 재시작하면 사라집니다.`]);
      }
    }
  }

  // 알림 팝업이 실제로 눈에 띄게 그려지는가.
  //   알림이 떠도 못 보고 지나치면 이 앱은 아무것도 한 것이 없다. 효과는 CSS 라
  //   lint 로는 "설정이 있다" 까지만 알 수 있고, **창이 그것을 실제로 입었는지**는
  //   창을 띄워 봐야만 안다.
  await list.eval(`window.api.invoke('preview-popup', {})`);
  let popupState = null;
  try {
    const popupTarget = await waitForTarget(t => t.url.includes('popup.html'), 12000);
    const popup = await cdp(popupTarget.webSocketDebuggerUrl);
    await sleep(600);
    popupState = await popup.eval(`({
      // 효과는 **멈추지 않아야** 한다. 이 앱의 약속은 "완료·취소 전까지 계속 알린다" 이고,
      // 효과가 먼저 멎으면 팝업은 떠 있는데 눈에 안 띄어 그 약속이 조용히 깨진다.
      iterations: getComputedStyle(document.body).animationIterationCount,
      effect: document.body.dataset.effect || null,
      title: (document.getElementById('title') || {}).textContent || '',
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      headerAnim: getComputedStyle(document.querySelector('.header')).animationName,
      bodyAnim: getComputedStyle(document.body).animationName,
      animated: (() => {
        const cs = getComputedStyle(document.querySelector('.header'));
        const own = getComputedStyle(document.body);
        return (cs.animationName && cs.animationName !== 'none')
            || (own.animationName && own.animationName !== 'none');
      })()
    })`);
    popup.close();
  } catch (e) {
    popupState = { error: e.message };
  }
  results.push(['팝업: 기본으로 눈에 띄는 효과가 걸린다',
    !!popupState && popupState.effect === 'flash' && popupState.animated === true
      && popupState.iterations === 'infinite',
    `팝업 상태 ${JSON.stringify(popupState)} — registry 의 popupEffect 기본값과 popup.html 의 ` +
    `body[data-effect] 규칙을 보세요. reduced:true 면 OS 가 "움직임 줄이기" 를 켠 것인데, ` +
    `그때도 효과가 (느리게라도) 살아 있어야 합니다 — 통째로 끄면 알림을 조용히 놓칩니다.`]);

  cal.close();
  list.close();
} catch (e) {
  fatal = e;
}

await cleanup();

console.log('');
let failed = 0;
// 실패한 항목에는 "어디를 고치면 되는가"를 함께 찍는다(lint 들의 report() 와 같은 약속).
for (const [label, ok, detail] of results) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failed++;
    if (detail) console.error(`       ${detail}`);
  }
}

if (fatal) {
  console.error('\n  치명적 오류: ' + fatal.message);
  if (appLog.trim()) {
    console.error('  --- 앱 로그(마지막 20줄) ---');
    console.error(appLog.trim().split('\n').slice(-20).map(l => '  ' + l).join('\n'));
  }
  process.exit(1);
}

if (failed) {
  console.error(`\n  FAIL check:ui — ${failed}/${results.length} 항목 실패`);
  if (appLog.trim()) {
    console.error('  --- 앱 로그(마지막 20줄) ---');
    console.error(appLog.trim().split('\n').slice(-20).map(l => '  ' + l).join('\n'));
  }
  process.exit(1);
}

console.log(`\n  ok   check:ui — ${results.length}개 항목 통과 (실제 창 · 등록표/픽스처 파생 기대값: `
  + `설정 컨트롤 ${expectPanelControls} · 캘린더 ${fxCalendars.length}(쓰기 가능 ${fxWritableCalendars.length}) · 계정 ${fxAccounts.length} · 단일 일정 ${fxPending + fxDone + fxCancelled})`);
process.exit(0);
