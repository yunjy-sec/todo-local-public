'use strict';

const path = require('path');
const { BrowserWindow, screen, shell } = require('electron');
const model = require('./model');
const { fromRfc3339 } = require('./util');

// 알림 팝업 창 관리: 빈 슬롯 배정 스택, 포커스 스틸 없음, 투명도 적용
class PopupManager {
  constructor(store) {
    this.store = store;
    this.popups = new Map(); // popupKey -> { win, slot, masterId, key, kind }
  }

  popupKey(masterId, key, kind) {
    return masterId + '|' + (key || '-') + '|' + kind;
  }

  isOpen(masterId, key, kind) {
    return this.popups.has(this.popupKey(masterId, key, kind));
  }

  closeFor(masterId, key, kind) {
    const pk = this.popupKey(masterId, key, kind);
    const p = this.popups.get(pk);
    if (p) {
      this.popups.delete(pk);
      try { p.win.destroy(); } catch (e) {}
    }
  }

  closeAllForMaster(masterId) {
    for (const [pk, p] of Array.from(this.popups)) {
      if (p.masterId === masterId) {
        this.popups.delete(pk);
        try { p.win.destroy(); } catch (e) {}
      }
    }
  }

  closeAllPre(masterId, key) {
    for (const [pk, p] of Array.from(this.popups)) {
      if (p.masterId === masterId && (p.key || '-') === (key || '-') && p.kind.startsWith('pre')) {
        this.popups.delete(pk);
        try { p.win.destroy(); } catch (e) {}
      }
    }
  }

  freeSlot() {
    const used = new Set(Array.from(this.popups.values()).map(p => p.slot));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  computePosition(slot, w, h) {
    const wa = screen.getPrimaryDisplay().workArea;
    const margin = 16;
    const step = h + 8;
    let x, y;
    switch (this.store.settings.position) {
      case 'bottom-left': x = wa.x + margin; y = wa.y + wa.height - h - margin - slot * step; break;
      case 'bottom-right': x = wa.x + wa.width - w - margin; y = wa.y + wa.height - h - margin - slot * step; break;
      case 'center': x = wa.x + Math.round((wa.width - w) / 2); y = wa.y + Math.round((wa.height - h) / 2) + slot * step; break;
      case 'top-center': x = wa.x + Math.round((wa.width - w) / 2); y = wa.y + margin + slot * step; break;
      default: x = wa.x + Math.round((wa.width - w) / 2); y = wa.y + wa.height - h - margin - slot * step;
    }
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
    return { x, y };
  }

  // kind: 'due' | 'pre<minutes>'
  show(ev, key, kind, opts) {
    const pk = this.popupKey(ev.id, key, kind);
    if (this.popups.has(pk)) return;
    const s = this.store.settings;
    const slot = this.freeSlot();
    const pos = this.computePosition(slot, s.popupWidth, s.popupHeight);

    const win = new BrowserWindow({
      width: s.popupWidth,
      height: s.popupHeight,
      x: pos.x, y: pos.y,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // preload 가 등록표를 읽어야 한다 (windows.js 의 설명 참고)
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'popup.html'));

    const entry = { win, slot, masterId: ev.id, key: key || null, kind };
    this.popups.set(pk, entry);
    win.on('closed', () => {
      const cur = this.popups.get(pk);
      if (cur && cur.win === win) this.popups.delete(pk);
    });

    const st = model.getInstState(ev, key);
    const due = opts.due;
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('popup-init', {
        popupKey: pk,
        masterId: ev.id,
        key: key || null,
        kind,
        title: ev.summary || '(제목 없음)',
        dueIso: due.toISOString(),
        notifyCount: Math.max(1, st.notifyCount | 0), // 스케줄러가 표시 전에 이미 증가시킴
        renotifyMinutes: model.getRenotifyMinutes(ev),
        defaultSnoozeMinutes: s.defaultSnoozeMinutes,
        preMinutes: kind === 'due' ? 0 : parseInt(kind.slice(3), 10) || 0,
        isPreview: !!opts.preview,
        // 시각 표기 설정 — 팝업도 목록·캘린더와 같은 모양으로 그린다
        timeFormat: s.timeFormat,
        timePadHour: s.timePadHour,
      });
      win.setOpacity(s.opacity);
      win.showInactive();
      if (s.playSound) shell.beep();
    });
  }

  closeByPopupKey(pk) {
    const p = this.popups.get(pk);
    if (p) {
      this.popups.delete(pk);
      try { p.win.destroy(); } catch (e) {}
    }
  }

  showPreview(settingsOverride) {
    const s = settingsOverride || this.store.settings;
    const fake = model.newEvent({ summary: '미리보기 알림입니다', start: new Date() });
    fake.id = 'preview-' + Date.now();
    const saved = this.store.settings;
    this.store.settings = Object.assign({}, saved, s);
    try {
      this.show(fake, null, 'due', { due: new Date(), preview: true });
    } finally {
      this.store.settings = saved;
    }
  }
}

module.exports = { PopupManager };
