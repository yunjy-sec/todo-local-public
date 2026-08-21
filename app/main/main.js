'use strict';

const path = require('path');
const { app, Tray, Menu, ipcMain, globalShortcut, BrowserWindow, dialog } = require('electron');
const REG = require('../shared/registry.js');

// 등록이 계약에 안 맞으면 창을 띄우기 전에 여기서 바로 터진다.
const registryProblems = REG.verify();
if (registryProblems.length) {
  throw new Error('registry: ' + registryProblems.join(' | '));
}

// IPC 핸들러 관문 — 등록표에 없는 채널에는 핸들러를 붙일 수 없다.
// (preload 가 renderer 의 호출을 막고, 이쪽이 main 의 등록을 막는다. 양쪽에서 조인다.)
const INVOKE_KEYS = new Set(REG.channelKeys('invoke'));
function handle(channel, fn) {
  if (!INVOKE_KEYS.has(channel)) {
    throw new Error('미등록 IPC 채널에 핸들러를 붙이려 합니다: ' + channel
      + ' — app/shared/registry.js 의 IPC_CHANNELS 에 넣으세요.');
  }
  ipcMain.handle(channel, fn);
}

const storage = require('./storage');
const { Store } = require('./state');
const { PopupManager } = require('./popups');
const { Scheduler } = require('./scheduler');
const { Windows, ICON } = require('./windows');
const model = require('./model');
const recur = require('./recurrence');
const { fromRfc3339, toRfc3339 } = require('./util');

// 한 번에 돌려주는 인스턴스 상한. 넘으면 잘렸다는 사실을 함께 알린다.
const LIST_CAP = 2000;

const store = new Store();
let tray = null;
let popups = null;
let scheduler = null;
let windows = null;
let quitting = false;

// ---- 단일 인스턴스 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let pendingSecond = null;
  app.on('second-instance', (e, argv) => {
    if (!windows) { pendingSecond = argv; return; } // 초기화 전 도착 → 준비 후 처리
    if (argv && argv.indexOf('--calendar') >= 0) windows.showCalendar();
    else windows.showList(true);
  });

  app.whenReady().then(() => {
    onReady();
    if (pendingSecond) {
      const argv = pendingSecond;
      pendingSecond = null;
      if (argv.indexOf('--calendar') >= 0) windows.showCalendar();
      else windows.showList(true);
    }
  });

  // 보안: 렌더러에서의 외부 네비게이션·새 창 차단 (드래그 드롭된 HTML 포함)
  app.on('web-contents-created', (e, wc) => {
    wc.on('will-navigate', (ev) => ev.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function onReady() {
  store.load();
  windows = new Windows(store);
  popups = new PopupManager(store);
  scheduler = new Scheduler(store, popups, () => windows.broadcast('data-changed'));
  store.onChange(() => windows.broadcast('data-changed'));

  setupTray();
  setupIpc();
  // 저장이 실패하면 조용히 넘어가지 않는다 — 사용자는 다음 실행에서야 일정이
  // 사라진 것을 알게 되고, 그때는 원인을 짚을 수 없다.
  storage.onSaveFailed((file, msg) => {
    notifyUser('저장 실패', file + ' 을(를) 저장하지 못했습니다: ' + msg);
  });
  applyAutostart();
  registerShortcuts();
  scheduler.start();
  startSubscriptions();

  if (process.argv.indexOf('--test-popup') >= 0) {
    popups.showPreview(null);
  }
  // 첫 실행에서도 --calendar 를 봐야 한다. 예전에는 second-instance 경로에서만 봐서
  // 앱이 꺼져 있을 때 start-calendar.bat 을 누르면 목록 창이 떴다.
  if (process.argv.indexOf('--hidden') >= 0) {
    // 창 없이 트레이만
  } else if (process.argv.indexOf('--calendar') >= 0) {
    windows.showCalendar();
  } else {
    windows.showList(false);
  }
}

function setupTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon-32.png'));
  tray.setToolTip('Todo 팝업 알림');
  const menu = Menu.buildFromTemplate([
    { label: '새 일정 추가', click: () => windows.showList(true) },
    { label: '목록 열기', click: () => windows.showList(false) },
    { label: '캘린더 열기', click: () => windows.showCalendar() },
    { type: 'separator' },
    { label: '설정', click: () => windows.showList(false, 'open-settings') },
    { type: 'separator' },
    { label: '종료', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => windows.showList(false));
}

// 트레이 풍선으로 알린다(창이 닫혀 있어도 보인다). 실패해도 앱은 계속 돈다.
let lastNotice = 0;
function notifyUser(title, body) {
  const now = Date.now();
  if (now - lastNotice < 3000) return; // 연속 실패가 풍선을 도배하지 않게
  lastNotice = now;
  console.error('[' + title + '] ' + body);
  try {
    if (tray) tray.displayBalloon({ title: 'Todo — ' + title, content: body });
  } catch (e) {}
}

function quitApp() {
  quitting = true;
  globalShortcut.unregisterAll();
  scheduler.stop();
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.destroy(); } catch (e) {}
  }
  if (tray) tray.destroy();
  app.exit(0);
}

function applyAutostart() {
  // 개발 실행(electron .)에서는 electron.exe가 등록되므로 패키징 전엔 적용하지 않음
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!store.settings.autostart,
      path: process.execPath,
      args: ['--hidden'],
    });
  } catch (e) { console.error(e); }
}



// 구독 캘린더 주기 갱신. 등록된 구독이 없으면 모듈을 로드하지 않는다
// (폐쇄망에서는 네트워크 코드가 메모리에 올라오지도 않는다).
let subTimer = null;
function startSubscriptions() {
  if (subTimer) clearInterval(subTimer);
  subTimer = null;
  if (!store.hasSubscriptions()) return;
  const tick = () => {
    store.subs().refreshAll(store.calendars, store.settings, {})
      .then(r => { if (r.refreshed || r.failed) windows.broadcast('data-changed'); })
      .catch(e => console.error('구독 갱신 실패', e));
  };
  subTimer = setInterval(tick, 5 * 60000);
  setTimeout(tick, 4000); // 켠 직후 한 번
}


function registerShortcuts() {
  globalShortcut.unregisterAll();
  const failed = [];
  const reg = (accel, fn) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) failed.push(accel);
    } catch (e) { failed.push(accel); }
  };
  reg(store.settings.hotkeyList, () => windows.showList(false));
  reg(store.settings.hotkeyNew, () => windows.showList(true));
  reg(store.settings.hotkeyCalendar, () => windows.showCalendar());
  if (failed.length && tray) {
    try {
      tray.displayBalloon({ title: 'Todo 팝업 알림', content: '단축키 등록 실패 (다른 프로그램이 사용 중): ' + failed.join(', ') });
    } catch (e) {}
  }
}

function setupIpc() {
  handle('get-init', () => ({
    settings: store.settings,
    colors: model.COLORS,
    defaultColor: model.DEFAULT_COLOR,
    calendars: store.calendars,
  }));

  handle('get-calendars', () => store.calendars);
  handle('calendar-op', async (e, p) => {

    const r = store.calendarOp(p);
    // 구독이 새로 생기거나 사라지면 주기 갱신을 다시 건다.
    if (r && (p.op === 'add-subscription' || p.op === 'remove' || p.op === 'remove-account')) {
      startSubscriptions();
    }
    return r;
  });

  handle('get-settings', () => store.settings);

  handle('save-settings', (e, s) => {
    store.saveSettings(s);
    applyAutostart();
    registerShortcuts();
    if (windows.calendar && !windows.calendar.isDestroyed() && windows.applyCalendarOpacity) {
      windows.applyCalendarOpacity();
    }
    return store.settings;
  });

  handle('preview-popup', (e, s) => {
    // 창이 보낸 값을 그대로 BrowserWindow 에 넘기지 않는다 — 범위 밖 크기·투명도가
    // 그대로 적용되면 화면 밖으로 나가거나 보이지 않는 창이 뜬다.
    popups.showPreview(s ? storage.clampSettings(Object.assign({}, store.settings, s)) : null);
    return true;
  });

  // 조회 — 상한을 넘으면 조용히 자르지 않고 잘렸다는 사실을 함께 돌려준다.
  // (예전에는 800건에서 말없이 잘라, 연 뷰나 장기 목록에서 뒤쪽 일정이 사라진 것처럼 보였다.)
  handle('list-instances', (e, q) => {
    const start = q && q.start ? new Date(q.start) : new Date(Date.now() - 30 * 86400000);
    const end = q && q.end ? new Date(q.end) : new Date(Date.now() + 365 * 86400000);
    const all = store.listInstances(start, end);
    const items = all.length > LIST_CAP ? all.slice(0, LIST_CAP) : all;
    return { items, total: all.length, truncated: all.length > LIST_CAP, cap: LIST_CAP };
  });

  // 변경
  handle('add-event', (e, payload) => store.addEvent(payload));
  handle('update-event', (e, p) => store.updateEvent(p.masterId, p.key, p.scope, p.patch));
  handle('delete-event', (e, p) => {
    const r = store.deleteEvent(p.masterId, p.key, p.scope);
    if (r) popups.closeAllForMaster(p.masterId);
    return r;
  });
  handle('set-status', (e, p) => {
    // 구독(읽기 전용) 항목은 원본을 못 고친다 — 로컬 오버레이에만 기록한다.
    if (p.instId && String(p.instId).indexOf('sub:') === 0) {
      return store.setOverlayStatus(p.instId, p.status);
    }
    const r = store.setStatus(p.masterId, p.key, p.status);
    if (r && p.status !== 'pending') {
      // 완료/취소하면 떠 있는 해당 팝업도 닫는다
      popups.closeFor(p.masterId, p.key, 'due');
      popups.closeAllPre(p.masterId, p.key);
    }
    return r;
  });
  handle('move-event', (e, p) => store.moveInstance(p.masterId, p.key, p.scope, p.start, p.end));
  handle('duplicate-event', (e, p) => store.duplicate(p.masterId, p.key));
  handle('get-event-form', (e, p) => store.getEventForm(p.masterId, p.key));

  handle('notify-now', (e, p) => {
    const ev = store.find(p.masterId);
    if (!ev) return false;
    store.clearSnooze(p.masterId, p.key);
    const k = recur.isRecurring(ev) ? p.key : null;
    if (!popups.isOpen(p.masterId, k, 'due')) {
      const start = p.key ? require('./state').keyToDate(p.key) : model.getStart(ev);
      const due = store.dueOf(ev, start);
      popups.closeAllPre(p.masterId, k);
      store.bumpNotifyCount(ev, k);
      popups.show(ev, k, 'due', { due });
    }
    return true;
  });

  handle('popup-action', (e, payload) => {
    scheduler.handleAction(payload);
    return true;
  });


  // 창 열기
  handle('open-calendar', () => { windows.showCalendar(); return true; });
  handle('open-list', () => { windows.showList(false); return true; });
  handle('open-detail', (e, payload) => {
    // payload: {mode:'new', start?, end?, summary?} | {mode:'edit', masterId, key}
    if (payload.mode === 'edit') {
      const form = store.getEventForm(payload.masterId, payload.key);
      if (!form) return false;
      windows.openDetail({ mode: 'edit', form, settings: store.settings, colors: model.COLORS, calendars: store.calendars });
    } else {
      windows.openDetail({ mode: 'new', preset: payload, settings: store.settings, colors: model.COLORS, calendars: store.calendars });
    }
    return true;
  });
  handle('close-detail', () => { windows.closeDetail(); return true; });

  handle('confirm', async (e, p) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: p.buttons || ['확인', '취소'],
      defaultId: 0, cancelId: (p.buttons || ['확인', '취소']).length - 1,
      message: p.message,
      noLink: true,
    });
    return r.response;
  });
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => { /* 트레이 상주 - 종료하지 않음 */ });
