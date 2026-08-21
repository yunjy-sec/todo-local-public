'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');

const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');
const PRELOAD = path.join(__dirname, '..', 'preload.js');

// 목록·캘린더·상세 창의 생성과 표시 (닫기=숨김)
class Windows {
  constructor(store) {
    this.store = store;
    this.list = null;
    this.calendar = null;
    this.detail = null;
  }

  webPrefs() {
    // sandbox:false 인 이유 — preload 가 shared/registry.js 를 읽어 채널 allowlist 를
    // 만든다. 샌드박스 preload 는 로컬 파일 require 가 막혀 있어 등록표를 못 읽고,
    // 그러면 채널 목록을 preload 에 손으로 두 벌 적어야 한다(등록표와 갈라진다).
    // contextIsolation·nodeIntegration 은 그대로라 창 코드에는 Node 가 노출되지 않는다.
    return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false };
  }

  broadcast(channel, data) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        try { w.webContents.send(channel, data || null); } catch (e) {}
      }
    }
  }

  getList() {
    if (this.list && !this.list.isDestroyed()) return this.list;
    this.list = new BrowserWindow({
      width: 420, height: 600, minWidth: 360, minHeight: 420,
      icon: ICON, show: false, title: 'Todo 목록',
      webPreferences: this.webPrefs(),
    });
    this.list.setMenuBarVisibility(false);
    this.list.loadFile(path.join(__dirname, '..', 'renderer', 'list.html'));
    this.list.on('close', (e) => {
      e.preventDefault();
      this.list.hide();
    });
    return this.list;
  }

  showList(focusInput, extraChannel) {
    const w = this.getList();
    const send = () => {
      w.show();
      w.focus();
      if (focusInput) w.webContents.send('focus-input');
      if (extraChannel) w.webContents.send(extraChannel);
    };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
    else send();
  }

  getCalendar() {
    if (this.calendar && !this.calendar.isDestroyed()) return this.calendar;
    this.calendar = new BrowserWindow({
      width: 1040, height: 720, minWidth: 640, minHeight: 480,
      icon: ICON, show: false, title: '캘린더',
      webPreferences: this.webPrefs(),
    });
    this.calendar.setMenuBarVisibility(false);
    this.calendar.loadFile(path.join(__dirname, '..', 'renderer', 'calendar.html'));
    this.calendar.on('close', (e) => {
      e.preventDefault();
      this.calendar.hide();
    });
    const applyOpacity = () => {
      const s = this.store.settings;
      if (s.calendarOpaqueOnFocus && this.calendar.isFocused()) this.calendar.setOpacity(1);
      else this.calendar.setOpacity(s.calendarOpacity);
    };
    this.calendar.on('focus', applyOpacity);
    this.calendar.on('blur', applyOpacity);
    this.applyCalendarOpacity = applyOpacity;
    return this.calendar;
  }

  showCalendar() {
    const w = this.getCalendar();
    w.setOpacity(this.store.settings.calendarOpacity);
    w.show();
    w.focus();
  }

  // 상세 등록/수정 폼 (단일 창 재사용)
  openDetail(payload) {
    if (this.detail && !this.detail.isDestroyed()) {
      const w = this.detail;
      const send = () => {
        w.show();
        w.focus();
        w.webContents.send('detail-init', payload);
      };
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
      else send();
      return;
    }
    this.detail = new BrowserWindow({
      width: 460, height: 640, minWidth: 420, minHeight: 520,
      icon: ICON, show: false, title: '일정 상세',
      webPreferences: this.webPrefs(),
    });
    this.detail.setMenuBarVisibility(false);
    this.detail.loadFile(path.join(__dirname, '..', 'renderer', 'detail.html'));
    this.detail.webContents.once('did-finish-load', () => {
      this.detail.webContents.send('detail-init', payload);
      this.detail.show();
    });
    this.detail.on('closed', () => { this.detail = null; });
  }

  closeDetail() {
    if (this.detail && !this.detail.isDestroyed()) this.detail.close();
  }
}

module.exports = { Windows, ICON };
