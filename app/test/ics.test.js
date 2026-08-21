'use strict';

/* iCalendar(.ics) 파서 시험.
 *
 * 왜 있는가
 *   구독 캘린더는 우리가 만들지 않은 텍스트다 — 접힌 줄, 이스케이프, 세 가지 시각 표기,
 *   DURATION, 예외 회차, 중첩 VALARM, 그리고 200 으로 오는 HTML 로그인 페이지까지 온다.
 *   여기서 한 가지만 어긋나도 사용자는 "일정이 하나 없다" 또는 "알림이 한 시간 늦게 뜬다"로
 *   며칠 뒤에야 알게 되고, 그때는 원본 텍스트가 남아 있지 않아 원인을 짚을 수 없다.
 *
 *   특히 마지막 항목이 이 파일의 핵심이다: 파서가 낸 recurrence 배열을 실제로
 *   app/main/recurrence.js 의 expand() 에 넣어 회차가 나오는지 확인한다. 파서와 전개기가
 *   각자 초록인데 서로 안 맞물리는 것(예: EXDATE 를 UTC 로 둬서 엉뚱한 날이 빠지는 것)은
 *   양쪽 단위 시험으로는 절대 잡히지 않는다.
 */

const test = require('node:test');
const assert = require('node:assert');
const ics = require('../shared/ics.js');
const recur = require('../main/recurrence.js');
const model = require('../main/model.js');
const C = require('../shared/contracts.js');
const { toRfc3339 } = require('../main/util.js');

// ---- 도우미 ----

/** 줄 배열을 CRLF 로 이어 붙여 진짜 .ics 처럼 만든다(접힘 시험은 줄을 직접 준다). */
function cal(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//test//EN']
    .concat(lines, ['END:VCALENDAR']).join('\r\n');
}

function vevent(lines) {
  return cal(['BEGIN:VEVENT'].concat(lines, ['END:VEVENT']));
}

function one(text) {
  const r = ics.parse(text);
  assert.strictEqual(r.events.length, 1, '이벤트 1개를 기대했습니다. warnings=' + JSON.stringify(r.warnings));
  return { ev: r.events[0], warnings: r.warnings, res: r };
}

function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hasWarning(warnings, re) {
  return warnings.some(w => re.test(w));
}

// ---- 줄 접힘 · 이스케이프 ----

test('줄 접힘(폴딩)을 푼다 — 공백·탭 이어붙이기, CRLF·LF 혼용', () => {
  // 앞부분은 CRLF, 뒤는 LF. 이어지는 줄은 공백 한 칸과 탭으로 각각 접혀 있다.
  const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fold-1\r\nSUMMARY:주간 회의 준\r\n 비 그리고\r\n\t 뒷부분\nDTSTART:20260820T140000\nEND:VEVENT\nEND:VCALENDAR';
  const { ev } = one(text);
  assert.strictEqual(ev.summary, '주간 회의 준비 그리고 뒷부분');
});

test('이스케이프를 푼다 — \\n · \\, · \\; · \\\\', () => {
  const { ev } = one(vevent([
    'UID:esc-1',
    'SUMMARY:회의\\, 그리고 정리\\; 마무리',
    'DESCRIPTION:첫 줄\\n둘째 줄\\n경로 C:\\\\temp\\\\a',
    'LOCATION:서울\\, 강남',
    'DTSTART:20260820T140000'
  ]));
  assert.strictEqual(ev.summary, '회의, 그리고 정리; 마무리');
  assert.strictEqual(ev.description, '첫 줄\n둘째 줄\n경로 C:\\temp\\a');
  assert.strictEqual(ev.location, '서울, 강남');
});

// ---- 종일 (DTEND exclusive) ----

test('종일 일정은 date 로 내고 DTEND 의 exclusive 규약을 그대로 지킨다', () => {
  const { ev } = one(vevent([
    'UID:allday-1',
    'SUMMARY:휴가',
    'DTSTART;VALUE=DATE:20260820',
    'DTEND;VALUE=DATE:20260822'
  ]));
  assert.deepStrictEqual(ev.start, { date: '2026-08-20' });
  assert.deepStrictEqual(ev.end, { date: '2026-08-22' }, 'exclusive 를 하루 줄이면 8/21 이 사라진다');
  assert.strictEqual(model.isAllDay(ev), true);
});

test('종일인데 DTEND 가 없으면 하루짜리(다음 날, exclusive)로 만든다', () => {
  const { ev } = one(vevent(['UID:allday-2', 'DTSTART;VALUE=DATE:20260820']));
  assert.deepStrictEqual(ev.end, { date: '2026-08-21' });
});

test('시각 표기가 없는 8자리 값도 종일로 읽는다 (VALUE=DATE 를 안 붙인 피드)', () => {
  const { ev } = one(vevent(['UID:allday-3', 'DTSTART:20260820', 'DTEND:20260821']));
  assert.deepStrictEqual(ev.start, { date: '2026-08-20' });
  assert.deepStrictEqual(ev.end, { date: '2026-08-21' });
});

// ---- 시각 ----

test('UTC(Z) 시각을 실행 환경 로컬 시각으로 옮긴다 (우리 toRfc3339 와 같은 모양)', () => {
  const { ev } = one(vevent([
    'UID:utc-1',
    'DTSTART:20260820T050000Z',
    'DTEND:20260820T063000Z'
  ]));
  // 기대값을 손으로 적지 않고 app/main/util.js 의 toRfc3339 로 만든다 —
  // 표기가 갈라지면(오프셋 없는 ISO 등) 여기서 바로 드러난다. CI 의 시간대와 무관하다.
  assert.strictEqual(ev.start.dateTime, toRfc3339(new Date(Date.UTC(2026, 7, 20, 5, 0, 0))));
  assert.strictEqual(ev.end.dateTime, toRfc3339(new Date(Date.UTC(2026, 7, 20, 6, 30, 0))));
  assert.match(ev.start.dateTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  // 로컬로 되읽으면 같은 순간이어야 한다.
  assert.strictEqual(model.getStart(ev).getTime(), Date.UTC(2026, 7, 20, 5, 0, 0));
});

test('TZID 가 있는 시각은 벽시계를 로컬로 읽고 어떤 TZID 였는지 warning 에 남긴다', () => {
  const { ev, warnings } = one(vevent([
    'UID:tz-1',
    'DTSTART;TZID=America/New_York:20260820T140000',
    'DTEND;TZID=America/New_York:20260820T150000'
  ]));
  assert.strictEqual(ev.start.dateTime, toRfc3339(new Date(2026, 7, 20, 14, 0, 0)));
  assert.strictEqual(ev.end.dateTime, toRfc3339(new Date(2026, 7, 20, 15, 0, 0)));
  assert.ok(hasWarning(warnings, /TZID=America\/New_York/), 'TZID 이름이 warning 에 있어야 고칠 수 있다');
  assert.ok(hasWarning(warnings, /로컬/), 'warning 이 무엇으로 읽었는지 말해야 한다');
});

test('TZID 경고는 시간대별로 한 줄만 모아서 낸다 (건마다 내면 수백 줄이 된다)', () => {
  const r = ics.parse(cal([
    'BEGIN:VEVENT', 'UID:tz-a', 'DTSTART;TZID=Europe/Berlin:20260820T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:tz-b', 'DTSTART;TZID=Europe/Berlin:20260821T090000', 'END:VEVENT'
  ]));
  assert.strictEqual(r.events.length, 2);
  const tzWarns = r.warnings.filter(w => /TZID=Europe\/Berlin/.test(w));
  assert.strictEqual(tzWarns.length, 1);
  assert.ok(/2건/.test(tzWarns[0]), '몇 건이었는지 세어 준다: ' + tzWarns[0]);
});

test('시간대 표기가 없는 floating 시각은 경고 없이 로컬로 읽는다 (그것이 규격의 뜻이다)', () => {
  const { ev, warnings } = one(vevent(['UID:float-1', 'DTSTART:20260820T140000', 'DTEND:20260820T150000']));
  assert.strictEqual(ev.start.dateTime, toRfc3339(new Date(2026, 7, 20, 14, 0, 0)));
  assert.deepStrictEqual(warnings, []);
});

// ---- DURATION ----

test('DTEND 가 없고 DURATION 이 있으면 end 를 계산한다', () => {
  const a = one(vevent(['UID:dur-1', 'DTSTART:20260820T140000', 'DURATION:PT1H30M'])).ev;
  assert.strictEqual(a.end.dateTime, toRfc3339(new Date(2026, 7, 20, 15, 30, 0)));

  const b = one(vevent(['UID:dur-2', 'DTSTART:20260820T140000', 'DURATION:PT45M'])).ev;
  assert.strictEqual(b.end.dateTime, toRfc3339(new Date(2026, 7, 20, 14, 45, 0)));

  const c = one(vevent(['UID:dur-3', 'DTSTART;VALUE=DATE:20260820', 'DURATION:P1D'])).ev;
  assert.deepStrictEqual(c.end, { date: '2026-08-21' }, '종일 + P1D = 하루짜리(exclusive 다음 날)');

  const d = one(vevent(['UID:dur-4', 'DTSTART:20260820T140000', 'DURATION:P1W'])).ev;
  assert.strictEqual(d.end.dateTime, toRfc3339(new Date(2026, 7, 27, 14, 0, 0)));
});

test('DTEND 가 있으면 DURATION 보다 DTEND 를 쓴다', () => {
  const { ev } = one(vevent([
    'UID:dur-5', 'DTSTART:20260820T140000', 'DTEND:20260820T141500', 'DURATION:PT5H'
  ]));
  assert.strictEqual(ev.end.dateTime, toRfc3339(new Date(2026, 7, 20, 14, 15, 0)));
});

test('읽을 수 없는 DURATION 은 무시하고 warning 을 남긴다 (end 는 model 의 기본값에 맡긴다)', () => {
  const { ev, warnings } = one(vevent(['UID:dur-6', 'DTSTART:20260820T140000', 'DURATION:1시간']));
  assert.strictEqual(ev.end, undefined);
  assert.ok(hasWarning(warnings, /DURATION/));
  assert.ok(model.getEnd(ev) > model.getStart(ev), 'end 가 없어도 model.getEnd 가 기본 길이를 준다');
});

// ---- RRULE · EXDATE : 파서와 전개기가 실제로 맞물리는가 ----

test('RRULE·EXDATE 를 문자열 그대로 보존한다', () => {
  const { ev } = one(vevent([
    'UID:rr-1',
    'DTSTART:20260824T100000',
    'DTEND:20260824T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
    'EXDATE:20260826T100000'
  ]));
  assert.deepStrictEqual(ev.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE:20260826T100000']);
});

test('파서가 낸 이벤트를 recurrence.expand() 에 넣으면 회차가 나온다 (파서 ↔ 전개기 맞물림)', () => {
  const { ev } = one(vevent([
    'UID:rr-2',
    'SUMMARY:주간 회의',
    'DTSTART:20260824T100000',
    'DTEND:20260824T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE'
  ]));
  assert.strictEqual(recur.isRecurring(ev), true);
  const got = recur.expand(ev, new Date(2026, 7, 16), new Date(2026, 8, 8), null).map(o => fmt(o.start));
  assert.deepStrictEqual(got,
    ['2026-08-24 10:00', '2026-08-26 10:00', '2026-08-31 10:00', '2026-09-02 10:00', '2026-09-07 10:00']);
  // 길이도 DTSTART/DTEND 에서 그대로 온다.
  const occ = recur.expand(ev, new Date(2026, 7, 16), new Date(2026, 8, 8), null)[0];
  assert.strictEqual(occ.end.getTime() - occ.start.getTime(), 60 * 60000);
});

test('EXDATE 로 지운 회차가 전개에서 실제로 빠진다', () => {
  const { ev } = one(vevent([
    'UID:rr-3',
    'DTSTART:20260824T100000',
    'DTEND:20260824T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
    'EXDATE:20260826T100000'
  ]));
  const got = recur.expand(ev, new Date(2026, 7, 16), new Date(2026, 8, 8), null).map(o => fmt(o.start));
  assert.deepStrictEqual(got, ['2026-08-24 10:00', '2026-08-31 10:00', '2026-09-02 10:00', '2026-09-07 10:00']);
});

test('UTC(Z) EXDATE 는 로컬 벽시계 표기로 옮겨 둔다 — 안 그러면 전개기가 엉뚱한 날을 뺀다', () => {
  // recurrence.parseExdates 는 EXDATE 에서 날짜(YYYYMMDD)만 잘라 쓴다. UTC 문자열을 그대로 두면
  // 자정을 넘는 시간대에서 제외가 하루 어긋난다. 그래서 파서가 미리 로컬로 옮긴다.
  const dropped = new Date(Date.UTC(2026, 7, 26, 1, 0, 0)); // 두 번째 회차
  const { ev } = one(vevent([
    'UID:rr-4',
    'DTSTART:20260824T010000Z',
    'DTEND:20260824T020000Z',
    'RRULE:FREQ=DAILY;COUNT=4',
    'EXDATE:20260826T010000Z'
  ]));
  const exdateLine = ev.recurrence.filter(s => s.indexOf('EXDATE') === 0)[0];
  assert.ok(exdateLine.indexOf('Z') < 0, 'Z 가 남아 있으면 날짜를 UTC 로 자르게 된다: ' + exdateLine);

  const days = recur.expand(ev, new Date(2026, 6, 1), new Date(2026, 8, 1), null)
    .map(o => fmt(o.start).slice(0, 10));
  assert.strictEqual(days.length, 3, 'COUNT=4 에서 한 회차가 빠져야 한다');
  assert.ok(days.indexOf(fmt(dropped).slice(0, 10)) < 0, '제외한 날이 로컬 기준으로 정확히 빠져야 한다');
});

test('COUNT·UNTIL 이 붙은 RRULE 도 전개까지 그대로 이어진다', () => {
  const { ev } = one(vevent([
    'UID:rr-5', 'DTSTART:20260824T100000', 'DTEND:20260824T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3'
  ]));
  const got = recur.expand(ev, new Date(2026, 7, 16), new Date(2026, 8, 8), null).map(o => fmt(o.start));
  assert.deepStrictEqual(got, ['2026-08-24 10:00', '2026-08-26 10:00', '2026-08-31 10:00']);
});

// ---- 예외 회차 (RECURRENCE-ID) ----

test('RECURRENCE-ID 는 예외 회차로 — recurringEventId + originalStartTime, id 는 따로', () => {
  const r = ics.parse(cal([
    'BEGIN:VEVENT', 'UID:series-1', 'SUMMARY:주간 회의',
    'DTSTART:20260824T100000', 'DTEND:20260824T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:series-1', 'SUMMARY:주간 회의 (장소 변경)',
    'RECURRENCE-ID:20260831T100000',
    'DTSTART:20260831T140000', 'DTEND:20260831T150000', 'END:VEVENT'
  ]));
  assert.strictEqual(r.events.length, 2);
  const master = r.events[0];
  const ex = r.events[1];

  assert.strictEqual(master.id, 'series-1');
  assert.strictEqual(master.recurringEventId, undefined);
  assert.strictEqual(ex.recurringEventId, 'series-1', '예외는 마스터를 가리켜야 한다');
  assert.notStrictEqual(ex.id, master.id, '예외가 마스터 id 를 쓰면 원본을 덮어쓴다');
  assert.strictEqual(ex.id, 'series-1_20260831T100000');
  assert.strictEqual(ex.originalStartTime.dateTime, toRfc3339(new Date(2026, 7, 31, 10, 0, 0)));
  assert.strictEqual(ex.start.dateTime, toRfc3339(new Date(2026, 7, 31, 14, 0, 0)));
  assert.deepStrictEqual(r.warnings, [], '정상적인 예외 회차에는 경고가 없어야 한다');

  // 그 회차를 마스터 전개에서 빼는 열쇠(state.js 의 exceptionKeys)가 실제로 맞물리는지.
  const key = '20260831T100000';
  const got = recur.expand(master, new Date(2026, 7, 16), new Date(2026, 8, 8), new Set([key])).map(o => fmt(o.start));
  assert.deepStrictEqual(got, ['2026-08-24 10:00', '2026-09-07 10:00']);
});

test('종일 예외 회차는 originalStartTime 을 date 로 낸다', () => {
  const r = ics.parse(cal([
    'BEGIN:VEVENT', 'UID:series-2', 'DTSTART;VALUE=DATE:20260820', 'DTEND;VALUE=DATE:20260821',
    'RRULE:FREQ=DAILY', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:series-2', 'RECURRENCE-ID;VALUE=DATE:20260822',
    'DTSTART;VALUE=DATE:20260823', 'DTEND;VALUE=DATE:20260824', 'END:VEVENT'
  ]));
  const ex = r.events[1];
  assert.deepStrictEqual(ex.originalStartTime, { date: '2026-08-22' });
  assert.strictEqual(ex.id, 'series-2_20260822');
});

test('마스터 없는 예외 회차는 넣되 warning 을 남긴다', () => {
  const r = ics.parse(vevent([
    'UID:orphan-1', 'RECURRENCE-ID:20260831T100000', 'DTSTART:20260831T140000'
  ]));
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].recurringEventId, 'orphan-1');
  assert.ok(hasWarning(r.warnings, /반복 일정이 이 파일에 없습니다/));
});

// ---- 미지원 규칙 ----

test('우리가 전개하지 못하는 규칙은 버리지 않고 보존한 뒤 warning 을 남긴다', () => {
  const { ev, warnings } = one(vevent([
    'UID:uns-1',
    'DTSTART:20260824T100000',
    'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU',
    'RDATE:20260901T100000'
  ]));
  assert.ok(ev.recurrence.indexOf('RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU') >= 0,
    'RRULE 원문을 그대로 보존해야 왕복에서 잃지 않는다');
  assert.ok(ev.recurrence.some(s => s.indexOf('RDATE') === 0), 'RDATE 도 보존한다');
  assert.ok(hasWarning(warnings, /BYSETPOS/));
  assert.ok(hasWarning(warnings, /WKST/));
  assert.ok(hasWarning(warnings, /RDATE/));
});

test('미지원 목록은 registry.RRULE_SUPPORT 에서 나온다 — 지원하는 규칙에는 경고하지 않는다', () => {
  const { warnings } = one(vevent([
    'UID:uns-2', 'DTSTART:20260824T100000',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5'
  ]));
  assert.deepStrictEqual(warnings, []);
});

// ---- 건너뛰는 블록 ----

test('VEVENT 안에 중첩된 VALARM 의 필드를 이벤트 속성으로 읽지 않는다', () => {
  const { ev } = one(vevent([
    'UID:alarm-1',
    'SUMMARY:치과',
    'DESCRIPTION:진료 카드 챙기기',
    'DTSTART:20260820T140000',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:15분 전입니다',
    'SUMMARY:알림',
    'TRIGGER:-PT15M',
    'END:VALARM'
  ]));
  assert.strictEqual(ev.summary, '치과');
  assert.strictEqual(ev.description, '진료 카드 챙기기', 'VALARM 의 DESCRIPTION 이 설명을 덮으면 안 된다');
});

test('VTIMEZONE·VTODO·VJOURNAL 블록은 건너뛴다', () => {
  const r = ics.parse(cal([
    'BEGIN:VTIMEZONE', 'TZID:Asia/Seoul',
    'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900',
    'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VTODO', 'UID:todo-1', 'SUMMARY:할 일', 'DTSTART:20260820T090000', 'END:VTODO',
    'BEGIN:VJOURNAL', 'UID:journal-1', 'DTSTART:20260820T090000', 'END:VJOURNAL',
    'BEGIN:VEVENT', 'UID:ev-1', 'SUMMARY:회의', 'DTSTART:20260820T140000', 'END:VEVENT'
  ]));
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].summary, '회의');
});

// ---- 상태 · 캘린더 이름 ----

test('STATUS 를 GCal 어휘로 옮기고 없으면 confirmed', () => {
  const mk = s => one(vevent(['UID:st-' + s, 'DTSTART:20260820T140000'].concat(s ? ['STATUS:' + s] : []))).ev.status;
  assert.strictEqual(mk('CONFIRMED'), 'confirmed');
  assert.strictEqual(mk('TENTATIVE'), 'tentative');
  assert.strictEqual(mk('CANCELLED'), 'cancelled');
  assert.strictEqual(mk(''), 'confirmed');
  const odd = one(vevent(['UID:st-x', 'DTSTART:20260820T140000', 'STATUS:NEEDS-ACTION']));
  assert.strictEqual(odd.ev.status, 'confirmed');
  assert.ok(hasWarning(odd.warnings, /STATUS/));
});

test('X-WR-CALNAME 을 calendarName 으로 낸다 (구독 캘린더 기본 이름)', () => {
  const r = ics.parse(cal([
    'X-WR-CALNAME:팀 일정\\, 2026',
    'BEGIN:VEVENT', 'UID:name-1', 'DTSTART:20260820T140000', 'END:VEVENT'
  ]));
  assert.strictEqual(r.calendarName, '팀 일정, 2026');
});

test('X-WR-CALNAME 이 없으면 calendarName 은 null', () => {
  const r = ics.parse(vevent(['UID:name-2', 'DTSTART:20260820T140000']));
  assert.strictEqual(r.calendarName, null);
});

// ---- UID 정규화 ----

test('UID 를 id 로 쓰되 파일명·키로 안전하게 정규화한다', () => {
  const ev = one(vevent(['UID:abc-123_ok.v2', 'DTSTART:20260820T140000'])).ev;
  assert.strictEqual(ev.id, 'abc-123_ok.v2', '이미 안전한 UID 는 그대로 쓴다(재동기화에서 같은 id 여야 한다)');

  const dirty = one(vevent(['UID:a/b\\c:d*e?f "g" <h>@example.com', 'DTSTART:20260820T140000'])).ev;
  assert.match(dirty.id, /^[A-Za-z0-9._-]+$/, '경로·예약 문자가 남으면 파일명·키로 쓸 수 없다');

  const long = 'x'.repeat(400) + '@example.com';
  const big = one(vevent(['UID:' + long, 'DTSTART:20260820T140000'])).ev;
  assert.ok(big.id.length <= 120, 'id 길이 상한: ' + big.id.length);

  // 같은 UID 는 언제나 같은 id (재동기화가 복제를 만들지 않는다)
  const again = one(vevent(['UID:' + long, 'DTSTART:20260820T140000'])).ev;
  assert.strictEqual(again.id, big.id);

  // 정규화로 서로 다른 UID 가 한 id 로 합쳐지지 않는다
  const p = one(vevent(['UID:a/b', 'DTSTART:20260820T140000'])).ev;
  const q = one(vevent(['UID:a-b', 'DTSTART:20260820T140000'])).ev;
  assert.notStrictEqual(p.id, q.id);
});

test('UID 가 없으면 내용에서 결정적 id 를 만들고 warning 을 남긴다', () => {
  const a = one(vevent(['SUMMARY:무명 일정', 'DTSTART:20260820T140000']));
  const b = one(vevent(['SUMMARY:무명 일정', 'DTSTART:20260820T140000']));
  assert.strictEqual(a.ev.id, b.ev.id, '무작위 id 면 동기화할 때마다 같은 일정이 새로 쌓인다');
  assert.ok(hasWarning(a.warnings, /UID 가 없어/));
});

test('예외 회차가 아닌데 UID 가 중복이면 따로 넣고 warning 을 남긴다 (한쪽이 사라지면 안 된다)', () => {
  const r = ics.parse(cal([
    'BEGIN:VEVENT', 'UID:dup-1', 'SUMMARY:하나', 'DTSTART:20260820T140000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:dup-1', 'SUMMARY:둘', 'DTSTART:20260821T140000', 'END:VEVENT'
  ]));
  assert.strictEqual(r.events.length, 2);
  assert.notStrictEqual(r.events[0].id, r.events[1].id);
  assert.ok(hasWarning(r.warnings, /같은 id/));
});

// ---- 깨진 입력 ----

test('HTML 응답·빈 문자열·쓰레기에도 죽지 않는다 (events 는 빈 배열)', () => {
  const html = ics.parse('<!DOCTYPE html>\n<html><body><h1>Sign in</h1></body></html>');
  assert.deepStrictEqual(html.events, []);
  assert.ok(html.warnings.length > 0, '무엇이 왔는지 남겨야 주소를 고칠 수 있다');
  assert.ok(hasWarning(html.warnings, /VCALENDAR/));

  assert.deepStrictEqual(ics.parse('').events, []);
  assert.deepStrictEqual(ics.parse('   \n\n  ').events, []);
  assert.deepStrictEqual(ics.parse(null).events, []);
  assert.deepStrictEqual(ics.parse(undefined).events, []);
  assert.deepStrictEqual(ics.parse(12345).events, []);
  assert.deepStrictEqual(ics.parse('그냥 아무 글자').events, []);
});

test('망가진 VEVENT 는 건너뛰고 나머지는 살린다', () => {
  const r = ics.parse(cal([
    'BEGIN:VEVENT', 'UID:bad-1', 'SUMMARY:시작이 없음', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:bad-2', 'SUMMARY:시작을 읽을 수 없음', 'DTSTART:내일 오후', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:good-1', 'SUMMARY:멀쩡한 일정', 'DTSTART:20260820T140000', 'END:VEVENT'
  ]));
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].id, 'good-1');
  assert.ok(hasWarning(r.warnings, /DTSTART 가 없어/));
  assert.ok(hasWarning(r.warnings, /DTSTART 값을 읽지 못해/));
});

test('END:VEVENT 없이 잘린 응답에도 죽지 않는다', () => {
  const r = ics.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:cut-1\r\nSUMMARY:잘린 일정\r\nDTSTART:2026082');
  assert.deepStrictEqual(r.events, []);
  assert.ok(hasWarning(r.warnings, /잘린/));
});

test('끝이 시작보다 앞서면 무시하고 warning 을 남긴다', () => {
  const { ev, warnings } = one(vevent([
    'UID:rev-1', 'DTSTART:20260820T140000', 'DTEND:20260820T130000'
  ]));
  assert.strictEqual(ev.end, undefined);
  assert.ok(hasWarning(warnings, /끝이 시작보다/));
});

// ---- 우리 계약과의 정합 ----

test('결과 이벤트는 계약(validateEvent)을 통과하고 private 을 만들지 않는다', () => {
  const r = ics.parse(cal([
    'X-WR-CALNAME:구독',
    'BEGIN:VEVENT', 'UID:c-1', 'SUMMARY:A', 'DTSTART:20260820T140000', 'DTEND:20260820T150000',
    'STATUS:TENTATIVE', 'CREATED:20260801T000000Z', 'LAST-MODIFIED:20260810T000000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c-2', 'SUMMARY:B', 'DTSTART;VALUE=DATE:20260820',
    'RRULE:FREQ=DAILY;COUNT=2', 'END:VEVENT'
  ]));
  assert.strictEqual(r.events.length, 2);
  for (const ev of r.events) {
    assert.deepStrictEqual(C.validateEvent(ev), []);
    assert.strictEqual(ev.kind, 'calendar#event');
    assert.strictEqual(ev.extendedProperties, undefined,
      '소속 캘린더·앱 상태는 app/main 이 붙인다 — 파서가 미등록 private 키를 만들면 lint:private-fields 가 막는다');
  }
  assert.strictEqual(r.events[0].created, toRfc3339(new Date(Date.UTC(2026, 7, 1, 0, 0, 0))));
  assert.strictEqual(r.events[0].updated, toRfc3339(new Date(Date.UTC(2026, 7, 10, 0, 0, 0))));
});

test('LAST-MODIFIED 가 없으면 DTSTAMP 를 updated 로 쓴다', () => {
  const { ev } = one(vevent([
    'UID:ts-1', 'DTSTART:20260820T140000', 'DTSTAMP:20260805T123000Z'
  ]));
  assert.strictEqual(ev.updated, toRfc3339(new Date(Date.UTC(2026, 7, 5, 12, 30, 0))));
});

test('opts.maxEvents 를 넘으면 거기서 멈추고 warning 을 남긴다', () => {
  const lines = [];
  for (let i = 0; i < 5; i++) {
    lines.push('BEGIN:VEVENT', 'UID:m-' + i, 'DTSTART:20260820T140000', 'END:VEVENT');
  }
  const r = ics.parse(cal(lines), { maxEvents: 2 });
  assert.strictEqual(r.events.length, 2);
  assert.ok(hasWarning(r.warnings, /maxEvents/));
});
