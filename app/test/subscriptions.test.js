'use strict';

/* 구독 캘린더(ICS) 시험.
 *
 * 왜 있는가
 *   구독은 "남의 데이터"다. 두 가지가 쉽게 잘못된다.
 *   (1) 남의 이벤트를 우리 원장(todos.json)에 섞으면, 갱신 때 통째로 갈아끼우다가
 *       사용자의 일정까지 지운다. 그래서 캐시에만 담는다 — 그것을 여기서 확인한다.
 *   (2) 갱신이 실패했다고 캐시를 비우면, 인터넷이 잠깐 끊긴 사이 오늘 일정이 화면에서
 *       사라진다. 실패는 error 만 남기고 이전 데이터는 지키는지 확인한다.
 *   그리고 구독 캘린더는 읽기 전용이어야 한다(고쳐도 다음 갱신에 덮이므로,
 *   애초에 편집 대상이 되면 안 된다).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-subs-'));
process.env.TODO_DATA_DIR = tmpRoot;

const storage = require('../main/storage.js');
const C = require('../shared/contracts.js');
const { Store } = require('../main/state.js');
const subs = require('../main/calendars/subscriptions.js');

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//KO',
  'X-WR-CALNAME:회사 공지',
  'BEGIN:VEVENT',
  'UID:sub-1@example.com',
  'DTSTAMP:20260801T000000Z',
  'DTSTART:20260825T010000Z',
  'DTEND:20260825T020000Z',
  'SUMMARY:전체 회의',
  'LOCATION:대회의실',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:sub-2@example.com',
  'DTSTAMP:20260801T000000Z',
  'DTSTART;VALUE=DATE:20260901',
  'DTEND;VALUE=DATE:20260902',
  'SUMMARY:창립기념일',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function freshStore() {
  const s = new Store();
  s.todos = [];
  s.settings = storage.clampSettings({});
  s.calendars = JSON.parse(JSON.stringify(storage.DEFAULT_CALENDARS));
  return s;
}

function icsFile(text) {
  const p = path.join(tmpRoot, 'sample-' + Math.random().toString(16).slice(2) + '.ics');
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('구독 추가는 읽기 전용 캘린더로 등록된다', () => {
  const s = freshStore();
  const ok = s.calendarOp({
    op: 'add-subscription', sourceKind: 'file', sourceValue: icsFile(SAMPLE_ICS),
    summary: '회사 공지', refreshMinutes: 30,
  });
  assert.strictEqual(ok, true);

  const found = s.flatCalendars().find(f => f.cal.summary === '회사 공지');
  assert.ok(found, '구독 캘린더가 등록돼야 한다');
  assert.strictEqual(found.cal.accessRole, 'reader', '쓰기 가능하면 편집 대상이 되고 고친 것이 갱신에 덮인다');
  assert.strictEqual(found.cal.source.kind, 'file');
  assert.strictEqual(found.cal.source.refreshMinutes, 30);
  assert.deepStrictEqual(C.validateCalendar(found.cal), [], '계약 검사를 통과해야 한다');
  assert.strictEqual(s.hasSubscriptions(), true);
});

test('구독 캘린더는 새 일정의 대상이 되지 않는다 (기본 캘린더 선택지에서 제외)', () => {
  const s = freshStore();
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: icsFile(SAMPLE_ICS), summary: '구독' });
  const writable = s.flatCalendars().filter(f =>
    !f.cal.accessRole || f.cal.accessRole === 'owner' || f.cal.accessRole === 'writer');
  assert.ok(!writable.some(f => f.cal.summary === '구독'));
});

test('파일 구독을 갱신하면 캐시에 담기고 원장은 그대로다 (남의 일정이 내 원장에 섞이지 않는다)', async () => {
  const s = freshStore();
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: icsFile(SAMPLE_ICS), summary: '회사 공지' });

  const r = await subs.refreshAll(s.calendars, s.settings, { force: true });
  assert.strictEqual(r.failed, 0, JSON.stringify(r.results));
  assert.strictEqual(r.refreshed, 1);
  assert.strictEqual(r.results[0].count, 2);

  assert.deepStrictEqual(s.todos, [], '구독 이벤트가 원장에 들어가면 갱신 때 사용자 일정까지 위험해진다');
  const cache = storage.loadSubCache();
  const calId = s.flatCalendars().find(f => f.cal.source).cal.id;
  assert.strictEqual(cache[calId].events.length, 2);
});

test('구독 이벤트가 목록 조회에 읽기 전용으로 나온다', async () => {
  const s = freshStore();
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: icsFile(SAMPLE_ICS), summary: '회사 공지' });
  await subs.refreshAll(s.calendars, s.settings, { force: true });

  const items = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1));
  const meeting = items.find(i => i.title === '전체 회의');
  assert.ok(meeting, '구독 이벤트가 화면에 나와야 한다');
  assert.strictEqual(meeting.readOnly, true, '읽기 전용 표시가 없으면 창이 편집 메뉴를 띄운다');
  assert.strictEqual(meeting.calName, '회사 공지');

  const holiday = items.find(i => i.title === '창립기념일');
  assert.ok(holiday && holiday.allDay === true, '종일 이벤트가 종일로 나와야 한다');
});

test('숨긴 구독 캘린더의 일정은 목록에서 빠진다', async () => {
  const s = freshStore();
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: icsFile(SAMPLE_ICS), summary: '회사 공지' });
  await subs.refreshAll(s.calendars, s.settings, { force: true });
  const calId = s.flatCalendars().find(f => f.cal.source).cal.id;

  s.calendarOp({ op: 'toggle', calId, selected: false });
  const items = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1));
  assert.ok(!items.some(i => i.title === '전체 회의'));
});

test('갱신에 실패해도 이전 캐시는 남는다 (인터넷이 끊겼다고 오늘 일정이 사라지면 안 된다)', async () => {
  const s = freshStore();
  const good = icsFile(SAMPLE_ICS);
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: good, summary: '회사 공지' });
  await subs.refreshAll(s.calendars, s.settings, { force: true });

  // 원본을 없애 실패를 만든다
  fs.unlinkSync(good);
  const r = await subs.refreshAll(s.calendars, s.settings, { force: true });
  assert.strictEqual(r.failed, 1);

  const calId = s.flatCalendars().find(f => f.cal.source).cal.id;
  const cache = storage.loadSubCache();
  assert.strictEqual(cache[calId].events.length, 2, '실패가 캐시를 비우면 화면에서 일정이 사라진다');
  assert.ok(cache[calId].error, '실패 사실은 남겨 사용자에게 알릴 수 있어야 한다');

  const items = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1));
  assert.ok(items.some(i => i.title === '전체 회의'), '실패 뒤에도 캐시로 계속 보여야 한다');
});

test('구독 캘린더를 지우면 그 일정만 사라지고 원장은 그대로다', async () => {
  const s = freshStore();
  s.addEvent({ summary: '내 일정', start: '2026-08-25T09:00:00+09:00' });
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: icsFile(SAMPLE_ICS), summary: '회사 공지' });
  await subs.refreshAll(s.calendars, s.settings, { force: true });
  const calId = s.flatCalendars().find(f => f.cal.source).cal.id;

  s.calendarOp({ op: 'remove', calId });

  const items = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1));
  assert.ok(!items.some(i => i.title === '전체 회의'));
  assert.ok(items.some(i => i.title === '내 일정'), '내 일정까지 사라지면 안 된다');
  assert.strictEqual(s.hasSubscriptions(), false);
});

test('구독 일정을 내 화면에서만 완료 처리할 수 있다 (원본은 그대로)', async () => {
  const s = freshStore();
  const file = icsFile(SAMPLE_ICS);
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: file, summary: '회사 공지' });
  await subs.refreshAll(s.calendars, s.settings, { force: true });

  const before = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1));
  const meeting = before.find(i => i.title === '전체 회의');
  assert.strictEqual(meeting.status, 'pending');

  const ok = s.setOverlayStatus(meeting.instId, 'done');
  assert.strictEqual(ok, true);

  const after = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1));
  const done = after.find(i => i.instId === meeting.instId);
  assert.strictEqual(done.status, 'done', '내 화면에서는 완료로 보여야 한다');
  assert.ok(done.closedAt, '언제 처리했는지 남아야 한다');
  assert.strictEqual(done.readOnly, true, '완료 표시를 했다고 편집 가능해지면 안 된다');

  // 원본(캐시에 담긴 남의 이벤트)은 건드리지 않았다
  const cache = storage.loadSubCache();
  const calId = s.flatCalendars().find(f => f.cal.source).cal.id;
  const raw = cache[calId].events.find(e => e.summary === '전체 회의');
  assert.ok(!raw.extendedProperties || !raw.extendedProperties.private,
    '남의 이벤트에 우리 상태를 쓰면 다음 갱신에서 사라지거나 원본을 오염시킨다');
});

test('완료 표시는 갱신해도 남는다 (원본을 다시 받아도)', async () => {
  const s = freshStore();
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: icsFile(SAMPLE_ICS), summary: '회사 공지' });
  await subs.refreshAll(s.calendars, s.settings, { force: true });
  const it = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1)).find(i => i.title === '전체 회의');
  s.setOverlayStatus(it.instId, 'done');

  await subs.refreshAll(s.calendars, s.settings, { force: true }); // 다시 받아 온다

  const after = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1))
    .find(i => i.instId === it.instId);
  assert.strictEqual(after.status, 'done', '갱신 때마다 완료 표시가 풀리면 매번 다시 눌러야 한다');
});

test('완료 취소하면 오버레이에서 지워진다', async () => {
  const s = freshStore();
  s.calendarOp({ op: 'add-subscription', sourceKind: 'file', sourceValue: icsFile(SAMPLE_ICS), summary: '회사 공지' });
  await subs.refreshAll(s.calendars, s.settings, { force: true });
  const it = s.listInstances(new Date(2026, 7, 1), new Date(2026, 9, 1)).find(i => i.title === '전체 회의');

  s.setOverlayStatus(it.instId, 'done');
  s.setOverlayStatus(it.instId, 'pending');

  const overlay = storage.loadOverlay();
  assert.strictEqual(overlay[it.instId], undefined, '되돌린 표시가 파일에 쌓이면 안 된다');
});

test('원장 항목에는 오버레이 경로를 쓸 수 없다', () => {
  const s = freshStore();
  assert.strictEqual(s.setOverlayStatus('not-a-sub-id', 'done'), false);
});

test('구독이 없으면 상태 조회도 비어 있다 (네트워크 모듈이 필요 없다)', () => {
  const s = freshStore();
  assert.strictEqual(s.hasSubscriptions(), false);
  assert.deepStrictEqual(subs.status(s.calendars), []);
});
