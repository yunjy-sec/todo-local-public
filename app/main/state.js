'use strict';

const storage = require('./storage');
const model = require('./model');
const recur = require('./recurrence');
const { toRfc3339, fromRfc3339, instKey, newId } = require('./util');
const REG = require('../shared/registry.js');

// 색은 등록표에서 읽는다 — 여기 베껴 두면 팔레트를 고쳐도 이 자리만 옛 색으로 남는다.
const NEW_CALENDAR_COLOR = REG.CAL_PALETTE[4];          // 새 로컬 캘린더
const SUBSCRIPTION_COLOR = REG.CAL_PALETTE[REG.CAL_PALETTE.length - 1]; // 구독(회색 계열)

// 소속 캘린더를 찾지 못했을 때의 마지막 방어선. 등록이 깨져도 화면이 비지 않게 한다.
const FALLBACK_CALENDAR = {
  id: 'default',
  summary: '내 캘린더',
  backgroundColor: REG.DEFAULT_EVENT_COLOR,
  selected: true,
  alarmsEnabled: true,
};

// 앱의 단일 상태 저장소. 모든 변경은 여기를 거쳐 저장·브로드캐스트된다.
class Store {
  constructor() {
    this.todos = [];
    this.settings = storage.DEFAULT_SETTINGS;
    this.calendars = storage.DEFAULT_CALENDARS;
    this.listeners = [];
  }

  load() {
    this.todos = storage.loadTodos();
    this.settings = storage.loadSettings();
    this.calendars = storage.loadCalendars();
  }

  // ---- 캘린더 레지스트리 ----

  flatCalendars() {
    const out = [];
    for (const svc of this.calendars.services) {
      for (const acc of svc.accounts || []) {
        for (const cal of acc.calendars || []) {
          out.push({ service: svc, account: acc, cal });
        }
      }
    }
    return out;
  }

  calById(calId) {
    const hit = this.flatCalendars().find(f => f.cal.id === calId);
    return hit ? hit.cal : null;
  }

  calendarOf(ev) {
    const id = (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.calendarId) || 'default';
    return this.calById(id) || this.calById('default') || FALLBACK_CALENDAR;
  }

  findAccount(accountId) {
    for (const svc of this.calendars.services) {
      for (const acc of svc.accounts || []) {
        if (acc.id === accountId) return { svc, acc };
      }
    }
    return null;
  }

  // 구독 캘린더가 하나라도 있을 때만 그 모듈을 로드한다(폐쇄망에서는 로드되지 않는다).
  hasSubscriptions() {
    for (const svc of (this.calendars && this.calendars.services) || []) {
      for (const acc of svc.accounts || []) {
        for (const cal of acc.calendars || []) {
          if (cal.source) return true;
        }
      }
    }
    return false;
  }

  subs() {
    return require('./calendars/subscriptions.js');
  }



  calendarOp(p) {
    if (p.op === 'add-subscription') {
      // 구독은 읽기 전용 캘린더다 — accessRole 을 reader 로 고정해 편집·생성 대상에서 뺀다.
      const hit = p.accountId ? this.findAccount(p.accountId) : null;
      let svc = hit ? hit.svc : this.calendars.services.find(s => s.type === 'ics');
      let acc = hit ? hit.acc : (svc && svc.accounts[0]);
      if (!svc) {
        svc = { id: 'ics', type: 'ics', name: '구독', accounts: [] };
        this.calendars.services.push(svc);
      }
      if (!acc) {
        acc = { id: newId().slice(0, 12), label: 'ICS 구독', calendars: [] };
        svc.accounts.push(acc);
      }
      acc.calendars = acc.calendars || [];
      acc.calendars.push({
        id: newId().slice(0, 12),
        summary: p.summary || '구독 캘린더',
        backgroundColor: p.backgroundColor || SUBSCRIPTION_COLOR,
        selected: true,
        alarmsEnabled: p.alarmsEnabled !== false,
        accessRole: 'reader',
        source: {
          kind: 'file',
          value: p.sourceValue,
          refreshMinutes: Math.max(1, p.refreshMinutes || 60),
        },
      });
      storage.saveCalendars(this.calendars);
      this.emit();
      return true;
    }


    if (p.op === 'refresh-subscription') {
      if (!this.hasSubscriptions()) return false;
      // 비동기지만 UI 는 기다리지 않는다 — 끝나면 data-changed 로 알린다.
      this.subs().refreshAll(this.calendars, this.settings, { force: true, calId: p.calId })
        .then(() => this.emit())
        .catch(() => this.emit());
      return true;
    }

    if (p.op === 'add') {
      // 캘린더 추가 — 대상 계정 지정 (로컬·원격 공통 양식)
      const hit = p.accountId ? this.findAccount(p.accountId) : null;
      const local = this.calendars.services.find(s => s.type === 'local');
      const acc = hit ? hit.acc : (local && local.accounts[0]);
      if (!acc) return false;
      acc.calendars = acc.calendars || [];
      acc.calendars.push({
        id: newId().slice(0, 12),
        summary: p.summary || '새 캘린더',
        backgroundColor: p.backgroundColor || NEW_CALENDAR_COLOR,
        selected: true,
        alarmsEnabled: true,
        accessRole: 'owner',
      });
    } else if (p.op === 'add-account') {
      // 계정(그룹) 추가 — 로컬은 인증 없이 생성. 원격 유형은 추후 어댑터가 같은 양식으로 추가
      let svc = this.calendars.services.find(s => s.type === (p.serviceType || 'local'));
      if (!svc) {
        svc = { id: p.serviceType || 'local', type: p.serviceType || 'local', name: p.serviceName || p.serviceType, accounts: [] };
        this.calendars.services.push(svc);
      }
      svc.accounts.push({
        id: newId().slice(0, 12),
        label: p.label || '새 계정',
        calendars: [],
      });
    } else if (p.op === 'rename-account') {
      const hit = this.findAccount(p.accountId);
      if (!hit) return false;
      hit.acc.label = p.label || hit.acc.label;
    } else if (p.op === 'remove-account') {
      const hit = this.findAccount(p.accountId);
      if (!hit) return false;
      const hasPrimary = (hit.acc.calendars || []).some(c => c.primary);
      if (hasPrimary) return false;
      const calIds = (hit.acc.calendars || []).map(c => c.id);
      hit.svc.accounts = hit.svc.accounts.filter(a => a.id !== p.accountId);
      this.markCalendarEventsDeleted(calIds);
      storage.saveTodos(this.todos);
    } else {
      const cal = this.calById(p.calId);
      if (!cal) return false;
      if (p.op === 'toggle') cal.selected = !!p.selected;
      else if (p.op === 'alarms') cal.alarmsEnabled = !!p.alarmsEnabled;
      else if (p.op === 'color') cal.backgroundColor = p.backgroundColor;
      else if (p.op === 'rename') cal.summary = p.summary || cal.summary;
      else if (p.op === 'remove') {
        if (cal.primary) return false;
        for (const svc of this.calendars.services) {
          for (const acc of svc.accounts || []) {
            acc.calendars = (acc.calendars || []).filter(c => c.id !== p.calId);
          }
        }
        // 해당 캘린더의 일정도 함께 삭제(툼스톤 — 원격에도 삭제가 전달돼야 한다)
        this.markCalendarEventsDeleted([p.calId]);
        storage.saveTodos(this.todos);
      }
      else return false;
    }
    storage.saveCalendars(this.calendars);
    this.emit();
    return true;
  }

  // 시각이 바뀐 이벤트의 알림 상태(스누즈·미리알림 기록)를 지운다.
  // 회차 상태(완료 여부)는 남긴다 — 그건 사용자의 판단이지 알림 사정이 아니다.
  clearAlarmState(ev) {
    const p = model.priv(ev);
    delete p.snoozeUntil;
    delete p.firedReminders;
    let map = null;
    try { map = p.instanceState ? JSON.parse(p.instanceState) : null; } catch (e) { map = null; }
    if (map) {
      for (const k of Object.keys(map)) {
        if (map[k]) delete map[k].snoozeUntil;
      }
      p.instanceState = JSON.stringify(map);
    }
  }

  markCalendarEventsDeleted(calIds) {
    const now = toRfc3339(new Date());
    for (const t of this.todos) {
      if (model.isDeleted(t)) continue;
      const cid = (t.extendedProperties && t.extendedProperties.private
        && t.extendedProperties.private.calendarId) || 'default';
      if (calIds.indexOf(cid) >= 0) model.markDeleted(t, now);
    }
  }

  onChange(fn) { this.listeners.push(fn); }

  emit() { for (const fn of this.listeners) { try { fn(); } catch (e) { console.error(e); } } }

  save() { storage.saveTodos(this.todos); this.emit(); }

  saveSettings(s) {
    // clamp 한 결과를 메모리에도 그대로 쓴다. 디스크만 정규화하면 이번 세션 내내
    // 범위 밖 값(예: 투명도 5, 스냅 999분)이 실제로 쓰인다.
    this.settings = storage.clampSettings(Object.assign({}, this.settings, s));
    storage.saveSettings(this.settings);
    this.emit();
  }

  // 삭제 표식이 찍힌 항목은 사용자에게 없는 것과 같다.
  find(id) {
    const ev = this.todos.find(t => t.id === id);
    return ev && !model.isDeleted(ev) ? ev : null;
  }



  // 오래된 툼스톤은 치운다 — 남겨 둘 이유가 없고 원장만 커진다.
  // 동기화 주기(분 단위)보다 훨씬 긴 90일이면 어느 기기든 그 사실을 이미 받아 갔다.
  purgeTombstones(days = 90) {
    const cutoff = Date.now() - days * 86400000;
    this.todos = this.todos.filter(t => {
      if (!model.isDeleted(t)) return true;
      const d = fromRfc3339(model.priv(t).deletedAt);
      return !d || isNaN(d.getTime()) || d.getTime() > cutoff;
    });
  }

  exceptionsOf(masterId) {
    return this.todos.filter(t => t.recurringEventId === masterId && !model.isDeleted(t));
  }

  exceptionKeys(masterId) {
    const set = new Set();
    for (const ex of this.exceptionsOf(masterId)) {
      const ost = ex.originalStartTime && (ex.originalStartTime.dateTime || ex.originalStartTime.date);
      const d = fromRfc3339(ost);
      if (d) set.add(instKey(d));
    }
    return set;
  }

  // ---- 조회: 기간 내 모든 인스턴스(단일 + 반복 전개 + 예외) ----
  listInstances(rangeStart, rangeEnd) {
    const out = [];
    for (const ev of this.todos) {
      if (model.isDeleted(ev)) continue; // 툼스톤은 화면에 없다
      const cal = this.calendarOf(ev);
      if (cal.selected === false) continue; // 사이드바에서 숨긴 캘린더
      if (recur.isRecurring(ev)) {
        const occs = recur.expand(ev, rangeStart, rangeEnd, this.exceptionKeys(ev.id));
        for (const o of occs) {
          out.push(this.instanceView(ev, o.key, o.start, o.end));
        }
      } else {
        const s = model.getStart(ev);
        if (!s) continue;
        const e = model.getEnd(ev) || s;
        if (e.getTime() >= rangeStart.getTime() && s < rangeEnd) {
          out.push(this.instanceView(ev, null, s, e));
        }
      }
    }
    // start 는 ISO 문자열이다. 그냥 빼면 NaN 이 되어 정렬이 아무 일도 하지 않는다
    // (그 상태로는 목록이 원장 입력순으로 그려지고, 800건 절단도 임의 절단이 된다).
    // 구독 캘린더(읽기 전용)의 이벤트를 덧붙인다. 캐시에서 읽으므로 네트워크가
    // 끊겨 있어도 보인다. 원장과 섞지 않으니 편집·삭제 경로에는 닿지 않는다.
    if (this.hasSubscriptions()) {
      const overlay = storage.loadOverlay();
      for (const sub of this.subs().cachedEvents(this.calendars)) {
        if (sub.cal.selected === false) continue;
        for (const ev of sub.events) {
          const view = this.subInstanceViews(ev, sub.cal, rangeStart, rangeEnd, overlay);
          for (const v of view) out.push(v);
        }
      }
    }

    out.sort((a, b) => new Date(a.start) - new Date(b.start));
    return out;
  }

  // 구독 이벤트를 화면용 인스턴스로. 읽기 전용이라 상태·스누즈가 없고,
  // 반복은 같은 전개기를 쓴다(같은 RRULE 어휘를 파서가 그대로 넘겨준다).
  subInstanceViews(ev, cal, rangeStart, rangeEnd, overlay) {
    const mk = (start, end, key) => {
      const instId = 'sub:' + cal.id + ':' + ev.id + (key ? '_' + key : '');
      // 원본은 못 고치지만 "내가 처리했다"는 사실은 내 화면에 남는다.
      const o = (overlay && overlay[instId]) || null;
      return {
      instId,
      masterId: ev.id,
      key: key || null,
      title: ev.summary || '(제목 없음)',
      start: start.toISOString(),
      end: (end || start).toISOString(),
      allDay: model.isAllDay(ev),
      colorId: null,
      color: cal.backgroundColor || model.DEFAULT_COLOR,
      calendarId: cal.id,
      calName: cal.summary,
      status: (o && o.todoStatus) || 'pending',
      snoozeUntil: null,
      notifyCount: 0,
      recurring: !!(ev.recurrence && ev.recurrence.length),
      recurDesc: recur.describe(ev.recurrence),
      renotifyMinutes: 0,
      reminderMinutes: [],
      description: ev.description || '',
      location: ev.location || '',
      readOnly: true,
      closedAt: (o && o.closedAt) || null,
      };
    };

    if (recur.isRecurring(ev)) {
      return recur.expand(ev, rangeStart, rangeEnd, null).map(o => mk(o.start, o.end, o.key));
    }
    const s = model.getStart(ev);
    if (!s) return [];
    const e = model.getEnd(ev) || s;
    if (e.getTime() < rangeStart.getTime() || s >= rangeEnd) return [];
    return [mk(s, e, null)];
  }

  instanceView(ev, key, start, end) {
    const st = model.getInstState(ev, key);
    const cal = this.calendarOf(ev);
    return {
      instId: key ? ev.id + '_' + key : ev.id,
      masterId: ev.id,
      key,
      title: ev.summary || '(제목 없음)',
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: model.isAllDay(ev),
      colorId: ev.colorId || null,
      color: ev.colorId ? model.eventColor(ev) : (cal.backgroundColor || model.DEFAULT_COLOR),
      calendarId: cal.id,
      calName: cal.summary,
      status: st.todoStatus,
      snoozeUntil: st.snoozeUntil,
      notifyCount: st.notifyCount,
      recurring: !!(recur.isRecurring(ev) || ev.recurringEventId),
      recurDesc: recur.describe(ev.recurrence),
      renotifyMinutes: model.getRenotifyMinutes(ev),
      reminderMinutes: model.getReminderMinutes(ev).filter(m => m > 0),
      description: ev.description || '',
      location: ev.location || '',
    };
  }

  // 알람 검사 대상: 단일 이벤트 전부 + 최근/임박 반복 인스턴스
  alarmInstances(now) {
    const rangeStart = new Date(now.getTime() - 7 * 86400000);
    // 앞쪽 범위는 가장 먼 미리 알림까지 덮어야 한다. 2일로 고정하면 "3일 전 알림" 같은
    // 설정이 제때 울리지 못하고, 회차가 범위에 들어오는 순간 지난 것들이 한꺼번에 터진다.
    let maxPreMs = 2 * 86400000;
    for (const ev of this.todos) {
      if (model.isDeleted(ev)) continue;
      for (const m of model.getReminderMinutes(ev)) {
        const ms = m * 60000 + 3600000; // 여유 1시간
        if (ms > maxPreMs) maxPreMs = ms;
      }
    }
    const rangeEnd = new Date(now.getTime() + maxPreMs);
    const out = [];
    for (const ev of this.todos) {
      if (model.isDeleted(ev)) continue; // 지운 항목은 울리지 않는다
      const cal = this.calendarOf(ev);
      if (cal.alarmsEnabled === false) continue; // 캘린더 단위 알람 끔
      if (recur.isRecurring(ev)) {
        for (const o of recur.expand(ev, rangeStart, rangeEnd, this.exceptionKeys(ev.id))) {
          out.push({ ev, key: o.key, due: this.dueOf(ev, o.start) });
        }
      } else {
        const s = model.getStart(ev);
        if (s) out.push({ ev, key: null, due: this.dueOf(ev, s) });
      }
    }
    return out;
  }

  dueOf(ev, start) {
    // 종일 이벤트는 당일 09:00에 알림
    if (model.isAllDay(ev)) {
      return new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0, 0);
    }
    return start;
  }

  // ---- 변경 조작 ----

  /**
   * 예약 시각의 초를 버린다(설정 truncateSeconds, 기본 켬).
   *
   * 14:00:30 에 "1분 뒤" 라고 하면 사람은 14:01 을 뜻하지 14:01:30 을 뜻하지 않는다.
   * 초를 남겨 두면 알림이 늘 어중간한 자리에서 울리고, 목록의 "14:01" 과도 어긋난다
   * (화면은 초를 안 보여 주므로 사용자는 왜 늦는지 알 수가 없다).
   * 초를 그대로 두고 싶은 사람을 위해 끌 수 있게 두었다.
   */
  snapSeconds(d) {
    if (!d || !(d instanceof Date) || isNaN(d.getTime())) return d;
    if (this.settings && this.settings.truncateSeconds === false) return d;
    const out = new Date(d.getTime());
    out.setSeconds(0, 0);
    return out;
  }

  addEvent(payload) {
    const start = this.snapSeconds(fromRfc3339(payload.start));
    const end = payload.end ? this.snapSeconds(fromRfc3339(payload.end)) : null;
    const ev = model.newEvent({
      summary: payload.summary,
      start, end,
      allDay: !!payload.allDay,
      renotifyMinutes: payload.renotifyMinutes || this.settings.defaultRenotifyMinutes,
      reminderMinutes: Array.isArray(payload.reminderMinutes) ? payload.reminderMinutes : this.settings.defaultReminderMinutes,
      recurrence: payload.recurrence,
      colorId: payload.colorId,
      description: payload.description,
      location: payload.location,
    });
    model.priv(ev).calendarId = payload.calendarId || this.settings.defaultCalendarId || 'default';
    this.todos.push(ev);
    this.save();
    return ev.id;
  }

  applyPatch(ev, patch) {
    if (patch.summary !== undefined) ev.summary = patch.summary;
    if (patch.start !== undefined) {
      const before = model.getStart(ev);
      model.setTimes(ev, this.snapSeconds(fromRfc3339(patch.start)),
        patch.end ? this.snapSeconds(fromRfc3339(patch.end)) : null, !!patch.allDay);
      const after = model.getStart(ev);
      if (!before || !after || before.getTime() !== after.getTime()) {
        // 시각이 바뀌면 옛 일정 기준의 알림 상태는 무효다. 남겨 두면 새 시각에 알림이
        // 아예 뜨지 않거나(스누즈가 미래를 가리킴) 미리 알림이 건너뛰어진다.
        this.clearAlarmState(ev);
      }
    }
    if (patch.recurrence !== undefined) {
      // 반복을 해제하면 예외 회차 이벤트는 주인이 없어진다. 남겨 두면 시리즈에서
      // 떨어져 나온 유령 항목으로 목록·캘린더에 계속 보인다.
      const hadRecurrence = !!(ev.recurrence && ev.recurrence.length);
      const willHave = !!(patch.recurrence && patch.recurrence.length);
      if (hadRecurrence && !willHave) {
        const now = toRfc3339(new Date());
        for (const ex of this.exceptionsOf(ev.id)) model.markDeleted(ex, now);
      }
      if (patch.recurrence && patch.recurrence.length) {
        // 규칙 교체 시 기존 EXDATE(삭제된 회차)는 보존한다
        const hasEx = patch.recurrence.some(l => typeof l === 'string' && l.toUpperCase().startsWith('EXDATE'));
        const keep = hasEx ? [] : (ev.recurrence || []).filter(l => typeof l === 'string' && l.toUpperCase().startsWith('EXDATE'));
        ev.recurrence = patch.recurrence.concat(keep);
      } else {
        delete ev.recurrence;
      }
    }
    if (patch.reminderMinutes !== undefined) {
      ev.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }]
        .concat((patch.reminderMinutes || []).filter(m => m > 0).map(m => ({ method: 'popup', minutes: m }))) };
      delete model.priv(ev).firedReminders;
    }
    if (patch.colorId !== undefined) {
      if (patch.colorId) ev.colorId = String(patch.colorId); else delete ev.colorId;
    }
    if (patch.description !== undefined) {
      if (patch.description) ev.description = patch.description; else delete ev.description;
    }
    if (patch.location !== undefined) {
      if (patch.location) ev.location = patch.location; else delete ev.location;
    }
    if (patch.renotifyMinutes !== undefined) {
      model.priv(ev).renotifyMinutes = String(Math.max(1, patch.renotifyMinutes | 0));
    }
    if (patch.calendarId !== undefined && patch.calendarId) {
      model.priv(ev).calendarId = patch.calendarId;
    }
    model.touch(ev);
  }

  // 시리즈를 delta(ms)만큼 이동할 때 EXDATE·예외·회차 상태 키를 함께 재매핑
  shiftSeries(ev, delta) {
    if (delta === 0) return;
    if (Array.isArray(ev.recurrence)) {
      ev.recurrence = ev.recurrence.map(l => {
        if (typeof l !== 'string' || !l.toUpperCase().startsWith('EXDATE')) return l;
        const idx = l.indexOf(':');
        const parts = l.slice(idx + 1).split(',').map(tok => {
          const m = tok.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
          if (!m) return tok;
          const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
          return instKey(new Date(d.getTime() + delta));
        });
        return 'EXDATE:' + parts.join(',');
      });
    }
    for (const ex of this.exceptionsOf(ev.id)) {
      const ost = ex.originalStartTime && fromRfc3339(ex.originalStartTime.dateTime || ex.originalStartTime.date);
      if (ost) ex.originalStartTime = { dateTime: toRfc3339(new Date(ost.getTime() + delta)) };
      const s = model.getStart(ex);
      const e = model.getEnd(ex);
      if (s) model.setTimes(ex, new Date(s.getTime() + delta), e ? new Date(e.getTime() + delta) : null, model.isAllDay(ex));
    }
    const p = model.priv(ev);
    if (p.instanceState) {
      try {
        const map = JSON.parse(p.instanceState);
        const out = {};
        for (const k of Object.keys(map)) {
          const d = keyToDate(k);
          out[isNaN(d.getTime()) ? k : instKey(new Date(d.getTime() + delta))] = map[k];
        }
        p.instanceState = JSON.stringify(out);
      } catch (e) {}
    }
    delete p.firedReminders;
  }

  // scope: 'all'(마스터 수정) | 'single'(예외 이벤트 생성/수정)
  updateEvent(masterId, key, scope, patch) {
    const ev = this.find(masterId);
    if (!ev) return false;
    if (!key || scope === 'all' || !recur.isRecurring(ev)) {
      if (key && scope === 'all' && recur.isRecurring(ev) && patch.start) {
        // '모든 일정': 폼의 회차 시각을 델타로 환산해 마스터 DTSTART를 상대 이동
        // (시각을 안 바꿨으면 마스터 시작일·회차 상태를 그대로 보존)
        const occStart = keyToDate(key);
        const ns = fromRfc3339(patch.start);
        const delta = ns.getTime() - occStart.getTime();
        const masterStart = model.getStart(ev);
        const masterEnd = model.getEnd(ev);
        const oldDur = masterEnd ? masterEnd.getTime() - masterStart.getTime() : 1800000;
        const newDur = patch.end ? fromRfc3339(patch.end).getTime() - ns.getTime() : oldDur;
        const p2 = Object.assign({}, patch);
        if (delta !== 0 || newDur !== oldDur) {
          const nStart = new Date(masterStart.getTime() + delta);
          p2.start = toRfc3339(nStart);
          p2.end = toRfc3339(new Date(nStart.getTime() + Math.max(60000, newDur)));
          this.applyPatch(ev, p2);
          this.shiftSeries(ev, delta);
        } else {
          delete p2.start;
          delete p2.end;
          this.applyPatch(ev, p2);
        }
        // 시리즈 캘린더 변경은 예외 이벤트에도 전파
        if (patch.calendarId) {
          for (const ex of this.exceptionsOf(ev.id)) model.priv(ex).calendarId = patch.calendarId;
        }
      } else {
        this.applyPatch(ev, patch);
      }
    } else {
      // 이 일정만: 예외 이벤트 생성 (GCal 방식: recurringEventId + originalStartTime)
      const occStart = keyToDate(key);
      const exist = this.exceptionsOf(masterId).find(x => {
        const d = fromRfc3339(x.originalStartTime && (x.originalStartTime.dateTime || x.originalStartTime.date));
        return d && instKey(d) === key;
      });
      if (exist) {
        this.applyPatch(exist, patch);
      } else {
        const dur = (model.getEnd(ev) || new Date(model.getStart(ev).getTime() + 1800000)).getTime() - model.getStart(ev).getTime();
        const exc = model.newEvent({
          summary: patch.summary !== undefined ? patch.summary : ev.summary,
          start: patch.start ? fromRfc3339(patch.start) : occStart,
          end: patch.end ? fromRfc3339(patch.end) : new Date(occStart.getTime() + dur),
          renotifyMinutes: model.getRenotifyMinutes(ev),
        });
        exc.recurringEventId = masterId;
        exc.originalStartTime = { dateTime: toRfc3339(occStart) };
        if (ev.colorId) exc.colorId = ev.colorId;
        if (ev.description) exc.description = ev.description;
        if (ev.location) exc.location = ev.location;
        exc.reminders = JSON.parse(JSON.stringify(ev.reminders || { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }));
        model.priv(exc).calendarId = this.calendarOf(ev).id;
        this.applyPatch(exc, patch);
        this.todos.push(exc);
      }
    }
    this.save();
    return true;
  }

  // 드래그 이동/리사이즈. scope: 'single'(예외 생성) | 'all'(마스터를 델타만큼 이동, 규칙 유지)
  moveInstance(masterId, key, scope, newStartIso, newEndIso) {
    const ev = this.find(masterId);
    if (!ev) return false;
    // 예외 회차에서 '모든 일정'을 고르면 원 시리즈(마스터)로 위임
    if (scope === 'all' && ev.recurringEventId) {
      const master = this.find(ev.recurringEventId);
      const ost = ev.originalStartTime && fromRfc3339(ev.originalStartTime.dateTime || ev.originalStartTime.date);
      if (master && ost) return this.moveInstance(master.id, instKey(ost), 'all', newStartIso, newEndIso);
    }
    const newStart = fromRfc3339(newStartIso);
    const newEnd = newEndIso ? fromRfc3339(newEndIso) : null;
    const isRec = recur.isRecurring(ev);
    if (!isRec || !key) {
      model.setTimes(ev, newStart, newEnd, model.isAllDay(ev));
      this.clearAlarmState(ev); // 옛 시각 기준의 스누즈·미리알림 기록은 무효다
      this.save();
      return true;
    }
    if (scope === 'all') {
      const occStart = keyToDate(key);
      const delta = newStart.getTime() - occStart.getTime();
      const ms = model.getStart(ev);
      const me = model.getEnd(ev);
      const dur = newEnd ? newEnd.getTime() - newStart.getTime() : (me ? me.getTime() - ms.getTime() : 1800000);
      const shifted = new Date(ms.getTime() + delta);
      model.setTimes(ev, shifted, new Date(shifted.getTime() + dur), model.isAllDay(ev));
      this.shiftSeries(ev, delta); // EXDATE·예외·회차 상태를 함께 재매핑
      this.save();
      return true;
    }
    return this.updateEvent(masterId, key, 'single', {
      start: newStartIso, end: newEndIso, allDay: model.isAllDay(ev),
    });
  }

  deleteEvent(masterId, key, scope) {
    const ev = this.find(masterId);
    if (!ev) return false;
    // 예외 회차에서 '모든 일정' 삭제 → 원 시리즈 전체 삭제로 위임
    if (scope === 'all' && ev.recurringEventId) {
      const master = this.find(ev.recurringEventId);
      if (master) return this.deleteEvent(master.id, null, 'all');
    }
    if (key && scope === 'single' && recur.isRecurring(ev)) {
      recur.addExdate(ev, keyToDate(key));
      model.touch(ev);
    } else {
      // 예외 이벤트를 지우면 마스터에 EXDATE를 넣어 원래 회차가 되살아나지 않게 한다
      if (ev.recurringEventId) {
        const master = this.find(ev.recurringEventId);
        const ost = ev.originalStartTime && fromRfc3339(ev.originalStartTime.dateTime || ev.originalStartTime.date);
        if (master && ost && master.recurrence) {
          recur.addExdate(master, ost);
          model.touch(master);
        }
      }
      // 즉시 지우지 않고 삭제 표식을 찍는다 — 원격에 "지웠다"가 전달되지 않으면
      // 다음 동기화에서 원격 사본이 그대로 돌아온다(지운 기기에서조차 되살아난다).
      const now = toRfc3339(new Date());
      for (const t of this.todos) {
        if (t.id === masterId || t.recurringEventId === masterId) model.markDeleted(t, now);
      }
    }
    this.save();
    return true;
  }

  /** 읽기 전용 항목(구독)의 로컬 상태. 원본은 건드리지 않고 내 화면에만 남긴다. */
  setOverlayStatus(instId, status) {
    if (!instId || String(instId).indexOf('sub:') !== 0) return false;
    const o = storage.loadOverlay();
    if (status === 'pending') {
      delete o[instId];
    } else {
      o[instId] = { todoStatus: status, closedAt: toRfc3339(new Date()) };
    }
    storage.saveOverlay(o);
    this.emit();
    return true;
  }

  setStatus(masterId, key, status) {
    const ev = this.find(masterId);
    if (!ev) return false;
    const patch = { todoStatus: status };
    if (status !== 'pending') patch.closedAt = toRfc3339(new Date());
    else { patch.closedAt = null; patch.snoozeUntil = null; }
    model.setInstState(ev, recur.isRecurring(ev) ? key : null, patch);
    this.save();
    return true;
  }

  snooze(masterId, key, minutes) {
    const ev = this.find(masterId);
    if (!ev) return false;
    model.setInstState(ev, recur.isRecurring(ev) ? key : null,
      // 미루기도 같은 규칙이다 — "10분 뒤" 가 10분 30초 뒤면 사용자는 늦었다고 느낀다.
      { snoozeUntil: toRfc3339(this.snapSeconds(new Date(Date.now() + minutes * 60000))) });
    this.save();
    return true;
  }

  ack(masterId, key) {
    const ev = this.find(masterId);
    if (!ev) return false;
    return this.snooze(masterId, key, model.getRenotifyMinutes(ev));
  }

  bumpNotifyCount(ev, key) {
    const k = recur.isRecurring(ev) ? key : null;
    const st = model.getInstState(ev, k);
    model.setInstState(ev, k, { notifyCount: (st.notifyCount | 0) + 1 });
    storage.saveTodos(this.todos); // 알림 횟수는 조용히 저장 (브로드캐스트는 호출측에서)
  }

  clearSnooze(masterId, key) {
    const ev = this.find(masterId);
    if (!ev) return false;
    model.setInstState(ev, recur.isRecurring(ev) ? key : null, { snoozeUntil: null });
    this.save();
    return true;
  }

  duplicate(masterId, key) {
    const ev = this.find(masterId);
    if (!ev) return null;
    const start = key ? keyToDate(key) : model.getStart(ev);
    const dur = (model.getEnd(ev) || new Date(start.getTime() + 1800000)).getTime() - model.getStart(ev).getTime();
    return this.addEvent({
      summary: ev.summary,
      start: toRfc3339(start),
      end: toRfc3339(new Date(start.getTime() + Math.max(60000, dur))),
      allDay: model.isAllDay(ev),
      renotifyMinutes: model.getRenotifyMinutes(ev),
      reminderMinutes: model.getReminderMinutes(ev).filter(m => m > 0),
      colorId: ev.colorId,
      description: ev.description,
      location: ev.location,
      calendarId: this.calendarOf(ev).id,
    });
  }

  // 상세 폼 초기값
  getEventForm(masterId, key) {
    const ev = this.find(masterId);
    if (!ev) return null;
    const isRec = recur.isRecurring(ev);
    const start = key && isRec ? keyToDate(key) : model.getStart(ev);
    const dur = (model.getEnd(ev) || new Date(model.getStart(ev).getTime() + 1800000)).getTime() - model.getStart(ev).getTime();
    return {
      masterId, key: isRec ? key : null,
      summary: ev.summary || '',
      start: toRfc3339(start),
      end: toRfc3339(new Date(start.getTime() + Math.max(60000, dur))),
      allDay: model.isAllDay(ev),
      recurrence: ev.recurrence || [],
      recurring: isRec,
      recurDesc: recur.describe(ev.recurrence),
      isException: !!ev.recurringEventId,
      reminderMinutes: model.getReminderMinutes(ev).filter(m => m > 0),
      colorId: ev.colorId || null,
      description: ev.description || '',
      location: ev.location || '',
      renotifyMinutes: model.getRenotifyMinutes(ev),
      calendarId: this.calendarOf(ev).id,
    };
  }
}

function keyToDate(key) {
  const m = key.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return new Date(NaN);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

module.exports = { Store, keyToDate };
