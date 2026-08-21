'use strict';

/* 반복 전개 엔진 시험.
 *
 * 왜 있는가
 *   전개가 틀리면 알림이 안 오거나(회차 누락) 지운 회차가 되살아난다(EXDATE 무시).
 *   둘 다 사용자가 며칠 뒤에야 알아채고, 그때는 원인을 짚기 어렵다.
 *   월말(31일)·서수 요일(둘째 화요일)·격주 같은 경계는 특히 손으로 검증하기 어렵다.
 */

const test = require('node:test');
const assert = require('node:assert');
const recur = require('../main/recurrence.js');

function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function mkEvent(startIso, endIso, rules) {
  return { id: 'm1', summary: 't', start: { dateTime: startIso }, end: { dateTime: endIso }, recurrence: rules };
}

function expand(ev, from, to, exceptionKeys) {
  return recur.expand(ev, from, to, exceptionKeys || null).map(o => fmt(o.start));
}

const R1 = new Date(2026, 7, 16);
const R2 = new Date(2026, 8, 8);
const WEEKLY = () => mkEvent('2026-08-24T10:00:00+09:00', '2026-08-24T11:00:00+09:00', ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE']);

test('매주 월·수', () => {
  assert.deepStrictEqual(expand(WEEKLY(), R1, R2),
    ['2026-08-24 10:00', '2026-08-26 10:00', '2026-08-31 10:00', '2026-09-02 10:00', '2026-09-07 10:00']);
});

test('COUNT 는 시작부터 센다', () => {
  const ev = mkEvent('2026-08-24T10:00:00+09:00', '2026-08-24T11:00:00+09:00', ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3']);
  assert.deepStrictEqual(expand(ev, R1, R2), ['2026-08-24 10:00', '2026-08-26 10:00', '2026-08-31 10:00']);
});

test('UNTIL 이후는 전개하지 않는다', () => {
  const ev = mkEvent('2026-08-24T10:00:00+09:00', '2026-08-24T11:00:00+09:00', ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260901']);
  assert.deepStrictEqual(expand(ev, R1, R2), ['2026-08-24 10:00', '2026-08-26 10:00', '2026-08-31 10:00']);
});

test('EXDATE 로 지운 회차는 빠진다', () => {
  const ev = mkEvent('2026-08-24T10:00:00+09:00', '2026-08-24T11:00:00+09:00',
    ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE:20260826T100000']);
  assert.deepStrictEqual(expand(ev, R1, R2),
    ['2026-08-24 10:00', '2026-08-31 10:00', '2026-09-02 10:00', '2026-09-07 10:00']);
});

test('예외 이벤트로 대체된 회차는 마스터 전개에서 빠진다 (중복 표시 방지)', () => {
  assert.deepStrictEqual(expand(WEEKLY(), R1, R2, new Set(['20260831T100000'])),
    ['2026-08-24 10:00', '2026-08-26 10:00', '2026-09-02 10:00', '2026-09-07 10:00']);
});

test('격일 (DAILY INTERVAL=2)', () => {
  const ev = mkEvent('2026-08-20T09:00:00+09:00', '2026-08-20T09:30:00+09:00', ['RRULE:FREQ=DAILY;INTERVAL=2']);
  assert.deepStrictEqual(expand(ev, new Date(2026, 7, 20), new Date(2026, 7, 27)),
    ['2026-08-20 09:00', '2026-08-22 09:00', '2026-08-24 09:00', '2026-08-26 09:00']);
});

test('매월 31일 — 31일이 없는 달은 건너뛴다', () => {
  const ev = mkEvent('2026-01-31T12:00:00+09:00', '2026-01-31T12:30:00+09:00', ['RRULE:FREQ=MONTHLY;BYMONTHDAY=31']);
  assert.deepStrictEqual(expand(ev, new Date(2026, 0, 1), new Date(2026, 5, 1)),
    ['2026-01-31 12:00', '2026-03-31 12:00', '2026-05-31 12:00']);
});

test('매월 둘째 화요일 (BYDAY=2TU)', () => {
  const ev = mkEvent('2026-08-11T14:00:00+09:00', '2026-08-11T15:00:00+09:00', ['RRULE:FREQ=MONTHLY;BYDAY=2TU']);
  assert.deepStrictEqual(expand(ev, new Date(2026, 7, 1), new Date(2026, 10, 1)),
    ['2026-08-11 14:00', '2026-09-08 14:00', '2026-10-13 14:00']);
});

test('매년', () => {
  const ev = mkEvent('2026-08-21T09:00:00+09:00', '2026-08-21T09:30:00+09:00', ['RRULE:FREQ=YEARLY']);
  assert.deepStrictEqual(expand(ev, new Date(2026, 0, 1), new Date(2029, 0, 1)),
    ['2026-08-21 09:00', '2027-08-21 09:00', '2028-08-21 09:00']);
});

test('격주 (WEEKLY INTERVAL=2)', () => {
  const ev = mkEvent('2026-08-21T09:00:00+09:00', '2026-08-21T09:30:00+09:00', ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR']);
  assert.deepStrictEqual(expand(ev, new Date(2026, 7, 16), new Date(2026, 8, 20)),
    ['2026-08-21 09:00', '2026-09-04 09:00', '2026-09-18 09:00']);
});

test('반복 아닌 이벤트는 전개하지 않는다', () => {
  const ev = mkEvent('2026-08-21T09:00:00+09:00', '2026-08-21T09:30:00+09:00', undefined);
  assert.deepStrictEqual(expand(ev, R1, R2), []);
  assert.strictEqual(recur.isRecurring(ev), false);
});

test('사람이 읽는 반복 설명', () => {
  assert.strictEqual(recur.describe(['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10']), '매주 월·수 (10회)');
  assert.strictEqual(recur.describe(['RRULE:FREQ=DAILY']), '매일');
  assert.strictEqual(recur.describe(['RRULE:FREQ=MONTHLY;BYDAY=2TU']), '매월 2번째 화요일');
  assert.strictEqual(recur.describe(undefined), null);
});
