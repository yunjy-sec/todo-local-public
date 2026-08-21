'use strict';

// GCal recurrence 필드(RRULE/EXDATE 문자열 배열)의 서브셋 전개 엔진.
// 지원: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY(요일 목록 + 서수 "2TU"/"-1FR"),
//       BYMONTHDAY, UNTIL, COUNT, EXDATE
// 미지원 규칙 부분은 무시하되 데이터는 보존된다.

const { instKey } = require('./util');
const model = require('./model');

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(recurrence) {
  if (!Array.isArray(recurrence)) return null;
  const line = recurrence.find(s => typeof s === 'string' && s.toUpperCase().startsWith('RRULE:'));
  if (!line) return null;
  const rule = { freq: null, interval: 1, byday: [], bymonthday: [], until: null, count: null };
  for (const part of line.slice(6).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1);
    if (k === 'FREQ') rule.freq = v.toUpperCase();
    else if (k === 'INTERVAL') rule.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (k === 'COUNT') rule.count = Math.max(1, parseInt(v, 10) || 1);
    else if (k === 'UNTIL') rule.until = parseUntil(v);
    else if (k === 'BYDAY') {
      for (const tok of v.toUpperCase().split(',')) {
        const m = tok.match(/^(-?\d)?([A-Z]{2})$/);
        if (m && WD[m[2]] !== undefined) {
          rule.byday.push({ ord: m[1] ? parseInt(m[1], 10) : 0, wd: WD[m[2]] });
        }
      }
    } else if (k === 'BYMONTHDAY') {
      rule.bymonthday = v.split(',').map(x => parseInt(x, 10)).filter(x => x >= 1 && x <= 31);
    }
  }
  return rule.freq ? rule : null;
}

function parseUntil(v) {
  // 20260930T145959Z 또는 20260930 형태
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (m) {
    return v.endsWith('Z')
      ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59);
  return null;
}

function parseExdates(recurrence) {
  const set = new Set();
  if (!Array.isArray(recurrence)) return set;
  for (const line of recurrence) {
    if (typeof line !== 'string' || !line.toUpperCase().startsWith('EXDATE')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    for (const tok of line.slice(idx + 1).split(',')) {
      const m = tok.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
      if (m) set.add(m[1] + m[2] + m[3]); // 날짜 단위로 제외 (같은 날 시각 차이는 무시)
    }
  }
  return set;
}

function addExdate(ev, occStart) {
  if (!ev.recurrence) return;
  const p = n => String(n).padStart(2, '0');
  const stamp = '' + occStart.getFullYear() + p(occStart.getMonth() + 1) + p(occStart.getDate())
    + 'T' + p(occStart.getHours()) + p(occStart.getMinutes()) + p(occStart.getSeconds());
  ev.recurrence.push('EXDATE:' + stamp);
}

function isRecurring(ev) {
  return !!parseRrule(ev.recurrence);
}

// master의 발생 시각들을 [rangeStart, rangeEnd) 범위에서 반환.
// exceptionKeys: 예외 이벤트(recurringEventId)로 대체된 originalStartTime 키 집합.
function expand(master, rangeStart, rangeEnd, exceptionKeys) {
  const rule = parseRrule(master.recurrence);
  const dtstart = model.getStart(master);
  if (!rule || !dtstart) return [];
  const dtend = model.getEnd(master);
  const durMs = Math.max(60000, (dtend ? dtend.getTime() : dtstart.getTime() + 1800000) - dtstart.getTime());
  const exdates = parseExdates(master.recurrence);
  const out = [];
  let produced = 0; // COUNT는 시작부터 센다
  const hardCap = 5000;
  let iter = 0;

  const emit = (d) => {
    produced++;
    if (rule.until && d > rule.until) return 'stop';
    if (rule.count && produced > rule.count) return 'stop';
    const p = n => String(n).padStart(2, '0');
    const dayStamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
    if (!exdates.has(dayStamp) && d.getTime() + durMs > rangeStart.getTime() && d < rangeEnd) {
      const key = instKey(d);
      if (!exceptionKeys || !exceptionKeys.has(key)) {
        out.push({ start: d, end: new Date(d.getTime() + durMs), key });
      }
    }
    return d >= rangeEnd ? 'stop' : 'ok';
  };

  if (rule.freq === 'DAILY') {
    for (let d = new Date(dtstart); iter++ < hardCap; d = addDays(d, rule.interval)) {
      if (emit(d) === 'stop') break;
    }
  } else if (rule.freq === 'WEEKLY') {
    const bydays = rule.byday.length ? rule.byday.map(b => b.wd) : [dtstart.getDay()];
    const week0 = startOfWeek(dtstart);
    for (let d = new Date(dtstart); iter++ < hardCap; d = addDays(d, 1)) {
      const weeks = Math.round((startOfWeek(d).getTime() - week0.getTime()) / (7 * 86400000));
      if (weeks % rule.interval === 0 && bydays.indexOf(d.getDay()) >= 0) {
        if (emit(d) === 'stop') break;
      }
      if (d > rangeEnd && (!rule.count || produced >= rule.count)) break;
    }
  } else if (rule.freq === 'MONTHLY') {
    const ordByday = rule.byday.find(b => b.ord !== 0);
    for (let mIdx = 0; iter++ < hardCap; mIdx += rule.interval) {
      const base = new Date(dtstart.getFullYear(), dtstart.getMonth() + mIdx, 1,
        dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds());
      let d = null;
      if (ordByday) {
        d = nthWeekdayOfMonth(base, ordByday.ord, ordByday.wd);
      } else {
        const day = rule.bymonthday.length ? rule.bymonthday[0] : dtstart.getDate();
        const dim = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
        if (day <= dim) {
          d = new Date(base.getFullYear(), base.getMonth(), day,
            dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds());
        }
      }
      if (d && d >= dtstart) {
        if (emit(d) === 'stop') break;
      }
      if (base > rangeEnd && (!rule.count || produced >= rule.count)) break;
    }
  } else if (rule.freq === 'YEARLY') {
    for (let y = 0; iter++ < hardCap; y += rule.interval) {
      const yy = dtstart.getFullYear() + y;
      const dim = new Date(yy, dtstart.getMonth() + 1, 0).getDate();
      if (dtstart.getDate() <= dim) {
        const d = new Date(yy, dtstart.getMonth(), dtstart.getDate(),
          dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds());
        if (emit(d) === 'stop') break;
        if (d > rangeEnd && (!rule.count || produced >= rule.count)) break;
      }
    }
  }
  return out;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfWeek(d) { // 월요일 시작 (RFC WKST 기본)
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const off = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - off);
  return r;
}

function nthWeekdayOfMonth(base, ord, wd) {
  const y = base.getFullYear(), mo = base.getMonth();
  if (ord > 0) {
    const first = new Date(y, mo, 1);
    let day = 1 + ((wd - first.getDay() + 7) % 7) + (ord - 1) * 7;
    const dim = new Date(y, mo + 1, 0).getDate();
    if (day > dim) return null;
    return new Date(y, mo, day, base.getHours(), base.getMinutes(), base.getSeconds());
  }
  // 음수: 마지막에서부터
  const dim = new Date(y, mo + 1, 0).getDate();
  const last = new Date(y, mo, dim);
  let day = dim - ((last.getDay() - wd + 7) % 7) + (ord + 1) * 7;
  if (day < 1) return null;
  return new Date(y, mo, day, base.getHours(), base.getMinutes(), base.getSeconds());
}

// 사람이 읽는 반복 설명 (목록/상세 표시용)
function describe(recurrence) {
  const rule = parseRrule(recurrence);
  if (!rule) return null;
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const iv = rule.interval;
  let base;
  if (rule.freq === 'DAILY') base = iv === 1 ? '매일' : iv + '일마다';
  else if (rule.freq === 'WEEKLY') {
    const days = rule.byday.filter(b => b.ord === 0).map(b => dayNames[b.wd]).join('·');
    base = (iv === 1 ? '매주' : iv + '주마다') + (days ? ' ' + days : '');
  } else if (rule.freq === 'MONTHLY') {
    const ob = rule.byday.find(b => b.ord !== 0);
    if (ob) base = (iv === 1 ? '매월' : iv + '개월마다') + ' ' + (ob.ord > 0 ? ob.ord + '번째' : '마지막') + ' ' + dayNames[ob.wd] + '요일';
    else base = (iv === 1 ? '매월' : iv + '개월마다') + (rule.bymonthday.length ? ' ' + rule.bymonthday[0] + '일' : '');
  } else if (rule.freq === 'YEARLY') base = iv === 1 ? '매년' : iv + '년마다';
  else return null;
  if (rule.count) base += ' (' + rule.count + '회)';
  else if (rule.until) base += ' (~' + (rule.until.getMonth() + 1) + '/' + rule.until.getDate() + ')';
  return base;
}

module.exports = { parseRrule, parseExdates, addExdate, isRecurring, expand, describe };
