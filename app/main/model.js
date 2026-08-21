'use strict';

const { toRfc3339, fromRfc3339, newId } = require('./util');
const REG = require('../shared/registry.js');
const C = require('../shared/contracts.js');

// 색은 등록표에서 나온다(registry.EVENT_COLORS = 구글 colorId 1~11).
const COLORS = REG.EVENT_COLORS.reduce((acc, c) => { acc[c.id] = c.hex; return acc; }, {});
const DEFAULT_COLOR = REG.DEFAULT_EVENT_COLOR;

function priv(ev) {
  if (!ev.extendedProperties) ev.extendedProperties = {};
  if (!ev.extendedProperties.private) ev.extendedProperties.private = {};
  return ev.extendedProperties.private;
}

function newEvent(opts) {
  const now = new Date();
  const ev = {
    kind: 'calendar#event',
    id: newId(),
    status: 'confirmed',
    summary: opts.summary || '',
    created: toRfc3339(now),
    updated: toRfc3339(now),
    start: { dateTime: toRfc3339(opts.start) },
    end: { dateTime: toRfc3339(opts.end || new Date(opts.start.getTime() + 30 * 60000)) },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    extendedProperties: { private: {
      todoStatus: 'pending',
      renotifyMinutes: String(opts.renotifyMinutes || 5),
      notifyCount: '0',
    } },
  };
  if (opts.description) ev.description = opts.description;
  if (opts.location) ev.location = opts.location;
  if (opts.colorId) ev.colorId = String(opts.colorId);
  if (opts.allDay) {
    // 종일 종료일은 항상 exclusive 규약 (setTimes와 동일). end가 없거나 유효하지 않으면 하루짜리.
    ev.start = { date: dateOnly(opts.start) };
    ev.end = { date: dateOnly(opts.end && opts.end > opts.start ? opts.end : new Date(opts.start.getTime() + 86400000)) };
  }
  if (opts.recurrence && opts.recurrence.length) ev.recurrence = opts.recurrence.slice();
  if (Array.isArray(opts.reminderMinutes)) {
    ev.reminders.overrides = [{ method: 'popup', minutes: 0 }]
      .concat(opts.reminderMinutes.filter(m => m > 0).map(m => ({ method: 'popup', minutes: m })));
  }
  return ev;
}

function dateOnly(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function touch(ev) { ev.updated = toRfc3339(new Date()); }

function isAllDay(ev) { return !!(ev.start && ev.start.date && !ev.start.dateTime); }

// 삭제 표식(툼스톤). 항목을 즉시 지우면 원격에 "지웠다"는 사실이 전달되지 않아
// 다음 동기화에서 원격 사본이 그대로 되살아난다. 그래서 표식만 찍고 남겨 둔다.
function isDeleted(ev) {
  return !!(ev && ev.extendedProperties && ev.extendedProperties.private
    && ev.extendedProperties.private.deletedAt);
}

function markDeleted(ev, whenIso) {
  priv(ev).deletedAt = whenIso;
  touch(ev);
}

function getStart(ev) {
  if (!ev.start) return null;
  return fromRfc3339(ev.start.dateTime || ev.start.date);
}

function getEnd(ev) {
  if (!ev.end) {
    const s = getStart(ev);
    return s ? new Date(s.getTime() + 30 * 60000) : null;
  }
  return fromRfc3339(ev.end.dateTime || ev.end.date);
}

function setTimes(ev, start, end, allDay) {
  if (allDay) {
    ev.start = { date: dateOnly(start) };
    ev.end = { date: dateOnly(end && end > start ? end : new Date(start.getTime() + 86400000)) };
  } else {
    ev.start = { dateTime: toRfc3339(start) };
    ev.end = { dateTime: toRfc3339(end && end > start ? end : new Date(start.getTime() + 30 * 60000)) };
  }
  touch(ev);
}

// ---- 인스턴스 상태 (완료/스누즈/알림횟수) ----
// 단일 이벤트: private에 직접 (C# v1 호환).
// 반복 이벤트의 개별 회차: private.instanceState JSON의 instKey 항목.

function getInstState(ev, key) {
  const p = priv(ev);
  if (!key) {
    return {
      todoStatus: p.todoStatus || (ev.status === 'cancelled' ? 'cancelled' : 'pending'),
      snoozeUntil: p.snoozeUntil || null,
      notifyCount: parseInt(p.notifyCount, 10) || 0,
      closedAt: p.closedAt || null,
    };
  }
  let map = {};
  try { map = JSON.parse(p.instanceState || '{}'); } catch (e) { map = {}; }
  const s = map[key] || {};
  return {
    todoStatus: s.todoStatus || 'pending',
    snoozeUntil: s.snoozeUntil || null,
    notifyCount: s.notifyCount || 0,
    closedAt: s.closedAt || null,
  };
}

// 기기 로컬 값만 바뀌었는가 — 그렇다면 updated 를 올리지 않는다.
// (알림을 확인만 해도 updated 가 올라가면, 동기화 LWW 에서 그 확인이
//  다른 기기의 실제 수정을 이겨 제목·시각 변경을 되돌린다.)
function onlyDeviceLocal(patch) {
  const keys = Object.keys(patch || {});
  return keys.length > 0 && keys.every(k => C.DEVICE_LOCAL_PRIVATE.indexOf(k) >= 0);
}

function setInstState(ev, key, patch) {
  const p = priv(ev);
  if (!key) {
    if (patch.todoStatus !== undefined) {
      p.todoStatus = patch.todoStatus;
      ev.status = patch.todoStatus === 'cancelled' ? 'cancelled' : 'confirmed';
    }
    if (patch.snoozeUntil !== undefined) {
      if (patch.snoozeUntil) p.snoozeUntil = patch.snoozeUntil; else delete p.snoozeUntil;
    }
    if (patch.notifyCount !== undefined) p.notifyCount = String(patch.notifyCount);
    if (patch.closedAt !== undefined) {
      // GCal private 속성 값은 문자열만 허용 — null은 필드 삭제로 처리
      if (patch.closedAt) p.closedAt = patch.closedAt; else delete p.closedAt;
    }
  } else {
    let map = {};
    try { map = JSON.parse(p.instanceState || '{}'); } catch (e) { map = {}; }
    const s = map[key] || {};
    for (const k of Object.keys(patch)) {
      if (patch[k] === null || patch[k] === undefined) delete s[k];
      else s[k] = patch[k];
    }
    map[key] = s;
    p.instanceState = JSON.stringify(map);
  }
  if (!onlyDeviceLocal(patch)) touch(ev);
}

function getRenotifyMinutes(ev) {
  const n = parseInt(priv(ev).renotifyMinutes, 10);
  return n >= 1 ? n : 5;
}

// 미리 알림(분 단위, 0=정시) 목록
function getReminderMinutes(ev) {
  const r = ev.reminders;
  if (!r || r.useDefault || !Array.isArray(r.overrides)) return [0];
  const mins = r.overrides.filter(o => !o.method || o.method === 'popup').map(o => o.minutes | 0);
  if (mins.indexOf(0) < 0) mins.push(0);
  return Array.from(new Set(mins)).sort((a, b) => a - b);
}

// 미리 알림 발화 기록: private.firedReminders JSON { "<instKey|없으면 '-'>|<minutes>": "shown" | 재표시예정 ISO }
function getFired(ev, key, minutes) {
  let map = {};
  try { map = JSON.parse(priv(ev).firedReminders || '{}'); } catch (e) { map = {}; }
  return map[(key || '-') + '|' + minutes] || null;
}

function setFired(ev, key, minutes, value) {
  const p = priv(ev);
  let map = {};
  try { map = JSON.parse(p.firedReminders || '{}'); } catch (e) { map = {}; }
  map[(key || '-') + '|' + minutes] = value;
  p.firedReminders = JSON.stringify(map);
}

function eventColor(ev) { return COLORS[ev.colorId] || DEFAULT_COLOR; }

module.exports = {
  COLORS, DEFAULT_COLOR, priv, newEvent, touch, isAllDay, isDeleted, markDeleted, getStart, getEnd, setTimes,
  getInstState, setInstState, getRenotifyMinutes, getReminderMinutes,
  getFired, setFired, eventColor, dateOnly,
};
