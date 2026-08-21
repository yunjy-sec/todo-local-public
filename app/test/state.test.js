'use strict';

/* 상태 변경 회귀 시험.
 *
 * 왜 있는가
 *   여기 있는 시험은 전부 실제로 났던 결함이다(멀티에이전트 리뷰에서 확정).
 *   - 반복 일정의 한 회차를 열어 제목만 바꾸고 '모든 일정'으로 저장하면
 *     마스터 시작일이 그 회차 날짜로 옮겨가 과거 회차가 통째로 사라졌다.
 *   - '이 일정만 삭제'로 쌓인 EXDATE 가 이후 '모든 일정' 수정에서 지워져 삭제한 회차가 부활했다.
 *   - 예외 회차에서 '모든 일정' 삭제를 골라도 그 회차 하나만 지워졌다.
 *   이런 것은 화면을 눌러 보는 것으로는 재현하기 어렵고, 사용자는 며칠 뒤에야 알아챈다.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// state 는 storage 를 통해서만 파일을 만진다. 데이터 디렉터리를 임시로 묶어 둔다.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-state-'));
process.env.TODO_DATA_DIR = tmpRoot;

const { Store, keyToDate } = require('../main/state.js');
const model = require('../main/model.js');
const recur = require('../main/recurrence.js');
const { toRfc3339, instKey } = require('../main/util.js');

function freshStore() {
  const s = new Store();
  s.todos = [];
  s.settings = require('../main/storage.js').clampSettings({});
  s.calendars = JSON.parse(JSON.stringify(require('../main/storage.js').DEFAULT_CALENDARS));
  return s;
}

function iso(y, mo, d, h, mi) {
  return toRfc3339(new Date(y, mo - 1, d, h, mi || 0, 0));
}

function addWeekly(store, summary) {
  // 8/3(월) 10:00 시작, 매주 월·수
  const id = store.addEvent({
    summary,
    start: iso(2026, 8, 3, 10),
    end: iso(2026, 8, 3, 11),
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'],
  });
  return store.find(id);
}

function occurrences(store, ev, fromIso, toIso) {
  return recur.expand(ev, new Date(fromIso), new Date(toIso), store.exceptionKeys(ev.id))
    .map(o => o.start.toISOString());
}

test('추가한 일정은 기본 캘린더에 소속된다', () => {
  const s = freshStore();
  const id = s.addEvent({ summary: '단일', start: iso(2026, 8, 20, 9) });
  const ev = s.find(id);
  assert.strictEqual(model.priv(ev).calendarId, 'default');
  assert.strictEqual(s.calendarOf(ev).id, 'default');
});

test("'모든 일정' 수정에서 시각을 안 바꾸면 시리즈 시작일이 그대로다", () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const before = model.getStart(ev).getTime();
  const key = instKey(new Date(2026, 7, 26, 10, 0, 0)); // 8/26(수) 회차

  s.updateEvent(ev.id, key, 'all', {
    summary: '주간 회의(제목만 변경)',
    start: iso(2026, 8, 26, 10),   // 폼이 회차 시각을 그대로 돌려준다
    end: iso(2026, 8, 26, 11),
  });

  const after = s.find(ev.id);
  assert.strictEqual(model.getStart(after).getTime(), before, '마스터 DTSTART 가 회차 날짜로 끌려가면 안 된다');
  assert.strictEqual(after.summary, '주간 회의(제목만 변경)');
});

test("'모든 일정' 수정에서 시각을 바꾸면 시리즈 전체가 그 델타만큼 이동한다", () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const key = instKey(new Date(2026, 7, 26, 10, 0, 0));

  // 회차를 10:00 → 14:00 으로
  s.updateEvent(ev.id, key, 'all', {
    summary: '주간 회의',
    start: iso(2026, 8, 26, 14),
    end: iso(2026, 8, 26, 15),
  });

  const after = s.find(ev.id);
  const start = model.getStart(after);
  assert.strictEqual(start.getDate(), 3, '시작 날짜는 유지');
  assert.strictEqual(start.getHours(), 14, '시각만 4시간 이동');
  const occ = occurrences(s, after, '2026-08-01', '2026-08-31');
  assert.ok(occ.length >= 4, '회차가 사라지면 안 된다');
});

test("'이 일정만' 수정은 예외 이벤트를 만들고 마스터를 건드리지 않는다", () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const key = instKey(new Date(2026, 7, 26, 10, 0, 0));

  s.updateEvent(ev.id, key, 'single', { summary: '이번만 다른 제목', start: iso(2026, 8, 26, 15), end: iso(2026, 8, 26, 16) });

  const master = s.find(ev.id);
  assert.strictEqual(master.summary, '주간 회의', '마스터 제목은 그대로');
  const exceptions = s.exceptionsOf(ev.id);
  assert.strictEqual(exceptions.length, 1);
  assert.strictEqual(exceptions[0].summary, '이번만 다른 제목');
  assert.strictEqual(model.getStart(exceptions[0]).getHours(), 15);
  // 마스터 전개에서 그 회차는 예외로 대체되어 빠진다
  const occ = occurrences(s, master, '2026-08-24', '2026-08-28');
  assert.ok(!occ.some(o => new Date(o).getDate() === 26), '예외로 대체된 회차가 중복 표시되면 안 된다');
});

test("'이 일정만' 삭제로 쌓인 EXDATE 는 이후 '모든 일정' 수정에서도 살아남는다", () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const key = instKey(new Date(2026, 7, 26, 10, 0, 0));

  s.deleteEvent(ev.id, key, 'single');
  let occ = occurrences(s, s.find(ev.id), '2026-08-24', '2026-08-28');
  assert.ok(!occ.some(o => new Date(o).getDate() === 26), '삭제한 회차가 바로 빠져야 한다');

  // 규칙을 실제로 바꾸는 수정(매주 월·수 → 매주 월)
  s.updateEvent(ev.id, instKey(new Date(2026, 7, 31, 10, 0, 0)), 'all', {
    summary: '주간 회의',
    start: iso(2026, 8, 31, 10),
    end: iso(2026, 8, 31, 11),
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
  });

  const after = s.find(ev.id);
  const exdates = (after.recurrence || []).filter(l => l.startsWith('EXDATE'));
  assert.strictEqual(exdates.length, 1, '규칙 교체에서 EXDATE 가 지워지면 삭제한 회차가 부활한다');
});

test('시리즈를 드래그로 옮기면 EXDATE·예외·회차 상태가 함께 따라온다', () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const k26 = instKey(new Date(2026, 7, 26, 10, 0, 0));
  const k31 = instKey(new Date(2026, 7, 31, 10, 0, 0));

  s.deleteEvent(ev.id, k26, 'single');          // EXDATE 8/26
  s.setStatus(ev.id, k31, 'done');              // 8/31 회차 완료

  // 8/31 회차를 10:00 → 11:00 으로 드래그, '모든 일정'
  s.moveInstance(ev.id, k31, 'all', iso(2026, 8, 31, 11), iso(2026, 8, 31, 12));

  const after = s.find(ev.id);
  assert.strictEqual(model.getStart(after).getHours(), 11);

  // 완료 표시가 이동한 회차 키로 따라왔는가
  const movedKey = instKey(new Date(2026, 7, 31, 11, 0, 0));
  assert.strictEqual(model.getInstState(after, movedKey).todoStatus, 'done',
    '시리즈를 옮기면 완료 기록이 사라져 지난 회차가 전부 다시 울린다');

  // EXDATE 도 같이 이동했는가 (8/26 10:00 → 11:00)
  const ex = (after.recurrence || []).filter(l => l.startsWith('EXDATE')).join(',');
  assert.ok(ex.includes('20260826T110000'), 'EXDATE 가 안 따라오면 삭제한 회차가 되살아난다');
});

test('예외 회차에서 "모든 일정" 삭제는 시리즈 전체를 지운다', () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const key = instKey(new Date(2026, 7, 26, 10, 0, 0));
  s.updateEvent(ev.id, key, 'single', { summary: '예외 회차', start: iso(2026, 8, 26, 15), end: iso(2026, 8, 26, 16) });
  const exc = s.exceptionsOf(ev.id)[0];

  s.deleteEvent(exc.id, null, 'all'); // 예외 회차를 골라 '모든 일정' 삭제

  assert.strictEqual(s.find(ev.id), null, '시리즈 마스터가 남으면 계속 알림이 온다');
  assert.strictEqual(s.exceptionsOf(ev.id).length, 0);
});

test('예외 이벤트를 개별 삭제하면 마스터에 EXDATE 가 들어가 원래 회차가 부활하지 않는다', () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const key = instKey(new Date(2026, 7, 26, 10, 0, 0));
  s.updateEvent(ev.id, key, 'single', { summary: '예외', start: iso(2026, 8, 26, 15), end: iso(2026, 8, 26, 16) });
  const exc = s.exceptionsOf(ev.id)[0];

  s.deleteEvent(exc.id, null, 'single');

  const master = s.find(ev.id);
  const occ = occurrences(s, master, '2026-08-24', '2026-08-28');
  assert.ok(!occ.some(o => new Date(o).getDate() === 26), '예외를 지웠더니 원래 회차가 되살아나면 안 된다');
});

test('반복 회차의 완료 상태는 회차별로 따로 기록된다', () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const k24 = instKey(new Date(2026, 7, 24, 10, 0, 0));
  const k26 = instKey(new Date(2026, 7, 26, 10, 0, 0));

  s.setStatus(ev.id, k24, 'done');

  const after = s.find(ev.id);
  assert.strictEqual(model.getInstState(after, k24).todoStatus, 'done');
  assert.strictEqual(model.getInstState(after, k26).todoStatus, 'pending', '다른 회차까지 완료되면 안 된다');
  assert.strictEqual(after.status, 'confirmed', '반복 마스터의 GCal status 는 confirmed 로 남는다');
});

test('단일 일정의 완료는 private.todoStatus 와 event.status 에 함께 반영된다', () => {
  const s = freshStore();
  const id = s.addEvent({ summary: '단일', start: iso(2026, 8, 20, 9) });

  s.setStatus(id, null, 'cancelled');
  let ev = s.find(id);
  assert.strictEqual(model.priv(ev).todoStatus, 'cancelled');
  assert.strictEqual(ev.status, 'cancelled', 'GCal 이벤트 status 도 cancelled 여야 한다');
  assert.ok(model.priv(ev).closedAt, 'closedAt 이 기록돼야 한다');

  s.setStatus(id, null, 'pending');
  ev = s.find(id);
  assert.strictEqual(ev.status, 'confirmed');
  assert.strictEqual(model.priv(ev).closedAt, undefined, 'null 을 넣으면 GCal 스키마 위반 — 필드를 지워야 한다');
});

test('스누즈·확인은 해당 회차에만 걸린다', () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const k24 = instKey(new Date(2026, 7, 24, 10, 0, 0));

  s.snooze(ev.id, k24, 30);
  const st = model.getInstState(s.find(ev.id), k24);
  assert.ok(st.snoozeUntil, '스누즈 시각이 기록돼야 한다');
  const other = model.getInstState(s.find(ev.id), instKey(new Date(2026, 7, 26, 10, 0, 0)));
  assert.strictEqual(other.snoozeUntil, null);
});

test('숨긴 캘린더의 일정은 목록에서 빠지지만 알람은 유지된다', () => {
  const s = freshStore();
  s.addEvent({ summary: '단일', start: iso(2026, 8, 20, 9) });

  s.calendarOp({ op: 'toggle', calId: 'default', selected: false });
  const shown = s.listInstances(new Date(2026, 7, 1), new Date(2026, 8, 1));
  assert.strictEqual(shown.length, 0, '표시 끔 = 뷰에서 제외');

  const alarms = s.alarmInstances(new Date(2026, 7, 20, 9, 30, 0));
  assert.strictEqual(alarms.length, 1, '표시를 껐다고 알람까지 꺼지면 안 된다');

  s.calendarOp({ op: 'alarms', calId: 'default', alarmsEnabled: false });
  assert.strictEqual(s.alarmInstances(new Date(2026, 7, 20, 9, 30, 0)).length, 0, '알람 끔 = 알람 제외');
});

test('캘린더 추가·삭제는 소속 일정과 함께 정리된다', () => {
  const s = freshStore();
  s.calendarOp({ op: 'add-account', serviceType: 'local', label: '업무' });
  const acc = s.calendars.services[0].accounts.find(a => a.label === '업무');
  assert.ok(acc, '계정(그룹)이 추가돼야 한다');

  s.calendarOp({ op: 'add', accountId: acc.id, summary: '프로젝트', backgroundColor: '#33b679' });
  const cal = acc.calendars[0];
  const id = s.addEvent({ summary: '프로젝트 일정', start: iso(2026, 8, 20, 9), calendarId: cal.id });
  assert.strictEqual(s.calendarOf(s.find(id)).id, cal.id);

  s.calendarOp({ op: 'remove', calId: cal.id });
  assert.strictEqual(s.find(id), null, '캘린더를 지우면 소속 일정도 사라져야 한다');
});

test('기본(primary) 캘린더는 삭제할 수 없다', () => {
  const s = freshStore();
  const ok = s.calendarOp({ op: 'remove', calId: 'default' });
  assert.strictEqual(ok, false, '마지막 캘린더가 사라지면 앱이 아무것도 못 한다');
});

test('종일 일정의 종료일은 exclusive 규약으로 저장된다', () => {
  const s = freshStore();
  const id = s.addEvent({
    summary: '휴가',
    start: iso(2026, 8, 20, 0),
    end: iso(2026, 8, 22, 0),
    allDay: true,
  });
  const ev = s.find(id);
  assert.strictEqual(ev.start.date, '2026-08-20');
  assert.strictEqual(ev.end.date, '2026-08-22', 'GCal 종일 end 는 exclusive — 하루가 더 늘어나면 안 된다');
});

test('복제는 원본의 캘린더·색·알림 설정을 따라간다', () => {
  const s = freshStore();
  const id = s.addEvent({
    summary: '원본', start: iso(2026, 8, 20, 9),
    colorId: '5', reminderMinutes: [10, 30], renotifyMinutes: 7,
  });
  const copyId = s.duplicate(id, null);
  const copy = s.find(copyId);
  assert.strictEqual(copy.summary, '원본');
  assert.strictEqual(copy.colorId, '5');
  assert.deepStrictEqual(model.getReminderMinutes(copy).filter(m => m > 0), [10, 30]);
  assert.strictEqual(model.getRenotifyMinutes(copy), 7);
  assert.notStrictEqual(copy.id, id, '복제본은 새 id 를 가져야 한다');
});

test('목록 조회는 시각 오름차순이다 (입력 순서가 아니라)', () => {
  const s = freshStore();
  s.addEvent({ summary: '늦은 것', start: iso(2026, 9, 10, 9) });
  s.addEvent({ summary: '빠른 것', start: iso(2026, 9, 1, 9) });
  s.addEvent({ summary: '중간', start: iso(2026, 9, 5, 9) });

  const out = s.listInstances(new Date(2026, 8, 1), new Date(2026, 9, 1));
  assert.deepStrictEqual(out.map(i => i.title), ['빠른 것', '중간', '늦은 것'],
    'ISO 문자열끼리 빼면 NaN 이라 정렬이 아무 일도 하지 않는다');
});

test('삭제는 툼스톤을 남긴다 (원격에 삭제가 전달돼야 한다)', () => {
  const s = freshStore();
  const id = s.addEvent({ summary: '지울 것', start: iso(2026, 8, 20, 9) });

  s.deleteEvent(id, null, 'all');

  assert.strictEqual(s.find(id), null, '사용자에게는 없는 것과 같아야 한다');
  assert.strictEqual(s.listInstances(new Date(2026, 7, 1), new Date(2026, 8, 1)).length, 0);
  assert.strictEqual(s.alarmInstances(new Date(2026, 7, 20, 9, 30, 0)).length, 0, '지운 항목은 울리지 않는다');
  const raw = s.todos.find(t => t.id === id);
  assert.ok(raw && model.priv(raw).deletedAt, '원장에는 삭제 표식이 남아 원격으로 전파된다');
});

test('캘린더를 지우면 소속 일정도 툼스톤이 된다', () => {
  const s = freshStore();
  s.calendarOp({ op: 'add-account', serviceType: 'local', label: '업무' });
  const acc = s.calendars.services[0].accounts.find(a => a.label === '업무');
  s.calendarOp({ op: 'add', accountId: acc.id, summary: '프로젝트' });
  const cal = acc.calendars[0];
  const id = s.addEvent({ summary: '프로젝트 일정', start: iso(2026, 8, 20, 9), calendarId: cal.id });

  s.calendarOp({ op: 'remove', calId: cal.id });

  assert.strictEqual(s.find(id), null);
  const raw = s.todos.find(t => t.id === id);
  assert.ok(raw && model.priv(raw).deletedAt, '표식 없이 지우면 원격에서 되살아나 기본 캘린더로 쏟아진다');
});

test('오래된 툼스톤은 정리된다 (원장이 무한히 커지지 않는다)', () => {
  const s = freshStore();
  const id = s.addEvent({ summary: '옛날에 지운 것', start: iso(2026, 1, 1, 9) });
  s.deleteEvent(id, null, 'all');
  // 100일 전에 지운 것으로 만든다
  model.priv(s.todos.find(t => t.id === id)).deletedAt =
    require('../main/util.js').toRfc3339(new Date(Date.now() - 100 * 86400000));

  s.purgeTombstones();
  assert.strictEqual(s.todos.find(t => t.id === id), undefined);
});

test('알림 확인·스누즈는 updated 를 올리지 않는다 (동기화에서 남의 수정을 이기면 안 된다)', () => {
  const s = freshStore();
  const id = s.addEvent({ summary: '단일', start: iso(2026, 8, 20, 9) });
  const before = s.find(id).updated;

  s.snooze(id, null, 10);
  s.bumpNotifyCount(s.find(id), null);

  assert.strictEqual(s.find(id).updated, before,
    '알림 상태는 기기 사정이다 — updated 가 오르면 LWW 에서 남의 제목 수정을 되돌린다');
});

test('내용 수정은 updated 를 올린다', () => {
  const s = freshStore();
  const id = s.addEvent({ summary: '단일', start: iso(2026, 8, 20, 9) });
  // updated 는 초 단위라 같은 초 안의 두 변경은 값이 같다. 기준을 과거로 두고 본다.
  s.find(id).updated = '2020-01-01T00:00:00+09:00';

  s.setStatus(id, null, 'done');

  assert.notStrictEqual(s.find(id).updated, '2020-01-01T00:00:00+09:00',
    '완료 표시는 다른 기기에도 전해져야 하므로 updated 가 올라야 한다');
});

test('시각을 바꾸면 이전 스누즈·미리알림 기록이 지워진다', () => {
  const s = freshStore();
  const id = s.addEvent({ summary: '단일', start: iso(2026, 8, 20, 9) });
  s.snooze(id, null, 600); // 10시간 뒤까지 미룸
  model.setFired(s.find(id), null, 30, 'shown');

  s.updateEvent(id, null, 'all', { summary: '단일', start: iso(2026, 8, 25, 14), end: iso(2026, 8, 25, 15) });

  const p = model.priv(s.find(id));
  assert.strictEqual(p.snoozeUntil, undefined, '옛 스누즈가 남으면 새 시각에 알림이 안 뜬다');
  assert.strictEqual(p.firedReminders, undefined);
});

test('반복을 해제하면 예외 회차가 유령으로 남지 않는다', () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const key = instKey(new Date(2026, 7, 26, 10, 0, 0));
  s.updateEvent(ev.id, key, 'single', { summary: '예외 회차', start: iso(2026, 8, 26, 15), end: iso(2026, 8, 26, 16) });
  assert.strictEqual(s.exceptionsOf(ev.id).length, 1);

  s.updateEvent(ev.id, null, 'all', {
    summary: '주간 회의', start: iso(2026, 8, 3, 10), end: iso(2026, 8, 3, 11), recurrence: [],
  });

  assert.strictEqual(s.exceptionsOf(ev.id).length, 0, '주인 없는 예외가 목록에 그대로 보인다');
  const list = s.listInstances(new Date(2026, 7, 1), new Date(2026, 8, 30));
  assert.ok(!list.some(i => i.title === '예외 회차'));
});

test('먼 미리 알림도 스캔 범위에 들어온다 (2일 고정이면 늦게 몰려 울린다)', () => {
  const s = freshStore();
  const now = new Date(2026, 7, 20, 9, 0, 0);
  // 5일 뒤 일정에 3일 전(4320분) 미리 알림
  s.addEvent({ summary: '먼 일정', start: iso(2026, 8, 25, 9), reminderMinutes: [4320] });

  const found = s.alarmInstances(now);
  assert.strictEqual(found.length, 1, '스캔 범위가 좁으면 미리 알림 시각을 지나쳐 버린다');
});

test('설정 저장은 메모리 값도 정규화한다', () => {
  const s = freshStore();
  s.saveSettings({ snapMinutes: 999, opacity: 5, position: '없는위치' });
  assert.strictEqual(s.settings.snapMinutes, 60);
  assert.strictEqual(s.settings.opacity, 1);
  assert.strictEqual(s.settings.position, 'bottom-center');
});

test('상세 폼 초기값은 회차 시각을 돌려준다', () => {
  const s = freshStore();
  const ev = addWeekly(s, '주간 회의');
  const key = instKey(new Date(2026, 7, 26, 10, 0, 0));
  const form = s.getEventForm(ev.id, key);
  assert.strictEqual(new Date(form.start).getDate(), 26);
  assert.strictEqual(form.recurring, true);
  assert.ok(form.recurDesc && form.recurDesc.includes('매주'));
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
