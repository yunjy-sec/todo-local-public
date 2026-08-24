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
      this.destroyEntry(p);
    }
  }

  closeAllForMaster(masterId) {
    for (const [pk, p] of Array.from(this.popups)) {
      if (p.masterId === masterId) {
        this.popups.delete(pk);
        this.destroyEntry(p);
      }
    }
  }

  closeAllPre(masterId, key) {
    for (const [pk, p] of Array.from(this.popups)) {
      if (p.masterId === masterId && (p.key || '-') === (key || '-') && p.kind.startsWith('pre')) {
        this.popups.delete(pk);
        this.destroyEntry(p);
      }
    }
  }

  freeSlot() {
    const used = new Set(Array.from(this.popups.values()).map(p => p.slot));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  /** 알림을 띄울 화면들. 기본은 전부 — 모니터가 여럿이면 안 보고 있는 화면에 뜰 수 있다. */
  targetDisplays() {
    if (this.store.settings.popupAllMonitors === false) return [screen.getPrimaryDisplay()];
    const all = screen.getAllDisplays();
    return all.length ? all : [screen.getPrimaryDisplay()];
  }

  computePosition(slot, w, h, display) {
    const wa = (display || screen.getPrimaryDisplay()).workArea;
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
    const st = model.getInstState(ev, key);
    const due = opts.due;

    // 화면마다 하나씩 띄운다. 한 화면만 띄우면 그 모니터를 안 보고 있을 때 알림을 놓친다 —
    // 완료·취소 전까지 계속 알린다는 이 앱의 약속이 거기서 조용히 깨진다.
    const wins = [];
    const entry = { win: null, wins, slot, masterId: ev.id, key: key || null, kind };
    this.popups.set(pk, entry);

    for (const display of this.targetDisplays()) {
      const pos = this.computePosition(slot, s.popupWidth, s.popupHeight, display);
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
      wins.push(win);
      if (!entry.win) entry.win = win; // 대표 창(기존 코드가 하나만 볼 때를 위해)

      // 한 화면의 창이 닫히면 그 알림은 끝난 것이다 — 나머지 화면의 쌍둥이도 함께 닫는다.
      // 안 그러면 다른 모니터에 유령 팝업이 남아 버튼이 두 번 눌린다.
      win.on('closed', () => {
        const cur = this.popups.get(pk);
        if (cur !== entry) return;
        this.popups.delete(pk);
        for (const w of wins) {
          if (w === win) continue;
          try { w.destroy(); } catch (e) {}
        }
      });

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
        // 눈에 띄게 하는 방법. 창이 스스로 그린다(OS 마다 다른 창 깜빡임 API 를 쓰지 않는다).
        effect: s.popupEffect,
      });
        win.setOpacity(s.opacity);
        win.showInactive();
      });
    }

    // 소리는 알림 하나에 한 번이다 — 모니터 수만큼 울리면 그것이 더 방해가 된다.
    if (s.playSound) shell.beep();
  }

  /** 한 알림에 딸린 창 전부. 화면마다 하나씩 떠 있다. */
  winsOf(entry) {
    return entry.wins && entry.wins.length ? entry.wins : (entry.win ? [entry.win] : []);
  }

  destroyEntry(entry) {
    for (const w of this.winsOf(entry)) {
      try { w.destroy(); } catch (e) {}
    }
  }

  closeByPopupKey(pk) {
    const p = this.popups.get(pk);
    if (p) {
      this.popups.delete(pk);
      this.destroyEntry(p);
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
