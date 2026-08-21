'use strict';

const model = require('./model');
const { fromRfc3339, toRfc3339 } = require('./util');

// 5초 주기로 정시 알림·미리 알림·스누즈 만료를 검사한다.
class Scheduler {
  constructor(store, popupMgr, onChanged) {
    this.store = store;
    this.popups = popupMgr;
    this.onChanged = onChanged || (() => {});
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 5000);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  tick() {
    const now = new Date();
    let dirty = false;
    for (const inst of this.store.alarmInstances(now)) {
      const { ev, key, due } = inst;
      if (!due || isNaN(due.getTime())) continue;
      const k = key || null;
      const st = model.getInstState(ev, k);
      if (st.todoStatus !== 'pending') continue;

      // 1) 정시 알림 (완료·취소 전까지 무한 반복)
      if (due <= now) {
        const sn = st.snoozeUntil ? fromRfc3339(st.snoozeUntil) : null;
        if ((!sn || sn <= now) && !this.popups.isOpen(ev.id, k, 'due')) {
          this.popups.closeAllPre(ev.id, k); // 정시가 되면 미리 알림은 정리
          this.store.bumpNotifyCount(ev, k);
          this.popups.show(ev, k, 'due', { due });
          dirty = true;
        }
        continue;
      }

      // 2) 미리 알림 (N분 전)
      for (const minutes of model.getReminderMinutes(ev)) {
        if (minutes <= 0) continue;
        const fireAt = new Date(due.getTime() - minutes * 60000);
        if (now < fireAt) continue;
        const kind = 'pre' + minutes;
        if (this.popups.isOpen(ev.id, k, kind)) continue;
        const fired = model.getFired(ev, k, minutes);
        if (fired === 'shown') continue;
        if (fired && fromRfc3339(fired) > now) continue; // 미리 알림 스누즈 중
        model.setFired(ev, k, minutes, 'shown');
        this.saveQuiet();
        this.popups.show(ev, k, kind, { due });
        dirty = true;
      }
    }
    if (dirty) this.onChanged();
  }

  saveQuiet() {
    const storage = require('./storage');
    storage.saveTodos(this.store.todos);
  }

  // 팝업 버튼 처리
  handleAction(payload) {
    const { popupKey, masterId, key, kind, action, minutes, isPreview } = payload;
    this.popups.closeByPopupKey(popupKey);
    if (isPreview) return;
    const ev = this.store.find(masterId);
    if (!ev) return;

    if (kind === 'due') {
      if (action === 'ack') this.store.ack(masterId, key);
      else if (action === 'snooze') this.store.snooze(masterId, key, minutes || this.store.settings.defaultSnoozeMinutes);
      else if (action === 'done') this.store.setStatus(masterId, key, 'done');
      else if (action === 'cancel') this.store.setStatus(masterId, key, 'cancelled');
    } else {
      // 미리 알림: 확인=닫기(1회성), 스누즈=N분 뒤 재표시(정시 전까지만), 완료/취소=일정 처리
      const preMin = parseInt(kind.slice(3), 10) || 0;
      if (action === 'snooze') {
        model.setFired(ev, key, preMin, toRfc3339(new Date(Date.now() + (minutes || 5) * 60000)));
        this.saveQuiet();
      } else if (action === 'done') this.store.setStatus(masterId, key, 'done');
      else if (action === 'cancel') this.store.setStatus(masterId, key, 'cancelled');
      // 'ack'은 이미 shown 처리됨 — 아무것도 안 함
    }
    this.onChanged();
  }
}

module.exports = { Scheduler };
