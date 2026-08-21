'use strict';

/* 구독 캘린더 관리 — 가져오기 → 파싱 → 캐시.
 *
 * 규칙
 *   - 구독 이벤트는 원장(todos.json)에 섞지 않는다. 남의 캘린더라 갱신 때 통째로
 *     갈아끼워야 하는데, 원장에 섞이면 그 순간 사용자의 일정까지 위험해진다.
 *     그래서 별도 캐시(subscriptions.json)에 캘린더별로 담는다.
 *   - 네트워크가 끊겨도 알람은 캐시로 돈다. 갱신 실패는 캐시를 지우지 않고
 *     error 만 기록한다 — 실패했다고 오늘 일정이 사라지면 안 된다.
 *   - 읽기 전용이다. 구독 캘린더의 이벤트는 편집·삭제 대상이 아니고,
 *     완료 표시 같은 앱 상태는 로컬 오버레이에만 남는다(P3 후속).
 */

const storage = require('../storage');
const ICS = require('../../shared/ics.js');

function subscriptionsOf(calendars) {
  const out = [];
  for (const svc of (calendars && calendars.services) || []) {
    for (const acc of svc.accounts || []) {
      for (const cal of acc.calendars || []) {
        if (cal.source) out.push({ svc, acc, cal });
      }
    }
  }
  return out;
}

function isDue(entry, cache, now) {
  const c = cache[entry.cal.id];
  if (!c || !c.fetchedAt) return true;
  const minutes = Math.max(1, entry.cal.source.refreshMinutes || 60);
  return (now - new Date(c.fetchedAt).getTime()) >= minutes * 60000;
}

/** 구독 하나를 갱신한다. 반환: {ok, count?, error?, notModified?} */
async function refreshOne(entry, cache, settings) {
  const { fetchSource } = require('./ics-file.js');
  const cal = entry.cal;
  const prev = cache[cal.id] || {};
  try {
    const got = await fetchSource(cal.source, {
      etag: prev.etag || null,
      lastModified: prev.lastModified || null,
      allowSelfSigned: settings && settings.syncAllowSelfSigned === true,
    });
    if (got.notModified) {
      cache[cal.id] = Object.assign({}, prev, { fetchedAt: new Date().toISOString(), error: null });
      return { ok: true, notModified: true, count: (prev.events || []).length };
    }
    const parsed = ICS.parse(got.text);
    cache[cal.id] = {
      fetchedAt: new Date().toISOString(),
      etag: got.etag || null,
      lastModified: got.lastModified || null,
      events: parsed.events,
      warnings: parsed.warnings,
      calendarName: parsed.calendarName || null,
      error: null,
    };
    return { ok: true, count: parsed.events.length, warnings: parsed.warnings };
  } catch (e) {
    // 실패해도 이전 캐시는 남긴다 — 네트워크가 끊겼다고 오늘 일정이 사라지면 안 된다.
    cache[cal.id] = Object.assign({}, prev, {
      error: String((e && e.message) || e),
      failedAt: new Date().toISOString(),
    });
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 주기가 된 구독을 갱신한다(force 면 전부). 반환: {refreshed, failed, results} */
async function refreshAll(calendars, settings, opts) {
  const entries = subscriptionsOf(calendars);
  if (!entries.length) return { refreshed: 0, failed: 0, results: [] };

  const cache = storage.loadSubCache();
  const now = Date.now();
  const force = !!(opts && opts.force);
  const only = opts && opts.calId;
  const results = [];
  let refreshed = 0;
  let failed = 0;

  for (const entry of entries) {
    if (only && entry.cal.id !== only) continue;
    if (!force && !only && !isDue(entry, cache, now)) continue;
    const r = await refreshOne(entry, cache, settings);
    results.push(Object.assign({ calId: entry.cal.id, summary: entry.cal.summary }, r));
    if (r.ok) refreshed++; else failed++;
  }

  if (results.length) storage.saveSubCache(cache);
  return { refreshed, failed, results };
}

/** 캐시에 담긴 구독 이벤트를 캘린더별로 돌려준다(표시 대상만). */
function cachedEvents(calendars) {
  const cache = storage.loadSubCache();
  const out = [];
  for (const entry of subscriptionsOf(calendars)) {
    const c = cache[entry.cal.id];
    if (!c || !Array.isArray(c.events)) continue;
    out.push({ cal: entry.cal, events: c.events, error: c.error || null, fetchedAt: c.fetchedAt || null });
  }
  return out;
}

function status(calendars) {
  const cache = storage.loadSubCache();
  return subscriptionsOf(calendars).map(e => {
    const c = cache[e.cal.id] || {};
    return {
      calId: e.cal.id,
      summary: e.cal.summary,
      source: e.cal.source,
      fetchedAt: c.fetchedAt || null,
      error: c.error || null,
      count: (c.events || []).length,
      warnings: (c.warnings || []).length,
    };
  });
}

module.exports = { refreshAll, cachedEvents, status, subscriptionsOf };
