'use strict';

/* 파일 IO 유일 관문.
 *
 * 데이터 디렉터리는 TODO_DATA_DIR 로 주입할 수 있다. 테스트·CI 는 반드시 이것을 쓴다 —
 * 실사용 원장(%APPDATA%\TodoPopup)에 대고 시험하면 사용자의 일정이 지워진다.
 * 파일 목록·기본 설정·clamp 범위는 registry 에서 나온다(손으로 두 벌 적지 않는다).
 */

const fs = require('fs');
const path = require('path');
const REG = require('../shared/registry.js');

let electronApp = null;
try {
  electronApp = require('electron').app; // 테스트에서는 electron 없이 로드된다
} catch (e) {
  electronApp = null;
}

function fileOf(key) {
  const row = REG.DATA_STORES.find(d => d.key === key);
  if (!row) throw new Error('미등록 데이터 저장소: ' + key + ' — registry 의 DATA_STORES 에 넣으세요.');
  return row.file;
}

function dataDir() {
  if (process.env.TODO_DATA_DIR) return process.env.TODO_DATA_DIR;
  const appData = electronApp
    ? electronApp.getPath('appData')
    : (process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'));
  return path.join(appData, 'TodoPopup');
}

const DEFAULT_CALENDARS = {
  services: [
    {
      id: 'local',
      type: 'local',
      name: '이 컴퓨터',
      accounts: [
        {
          id: 'local',
          label: '로컬 캘린더',
          calendars: [
            {
              id: 'default',
              summary: '내 캘린더',
              backgroundColor: '#039be5',
              selected: true,
              alarmsEnabled: true,
              primary: true,
              accessRole: 'owner'
            }
          ]
        }
      ]
    }
  ]
};

function readJson(file) {
  const p = path.join(dataDir(), file);
  try {
    if (!fs.existsSync(p)) return null;
    // BOM 을 벗기고 읽는다. JSON.parse 는 앞의 U+FEFF 를 거부한다.
    // 이걸 안 벗기면 켤 때마다 파싱이 실패해 원본을 .corrupt-<시각> 으로 밀어 두고
    // 기본값으로 시작한다 — 사용자에게는 "설정이 자꾸 초기화되는" 것으로만 보인다.
    // 실제로 그랬다: settings.json 이 ef bb bf 로 시작해 격리 사본이 4개 쌓여 있었다.
    // 메모장·PowerShell 리다이렉트(> · Out-File)가 UTF-8 BOM 을 붙인다.
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    try { fs.copyFileSync(p, p + '.corrupt-' + Date.now()); } catch (e2) {}
    return null;
  }
}

// 저장 실패를 삼키지 않는다. 조용히 실패하면 사용자는 다음에 앱을 켰을 때
// 일정이 사라진 것으로 알게 되고, 그때는 원인을 짚을 방법이 없다.
const saveFailListeners = [];
function onSaveFailed(fn) { saveFailListeners.push(fn); }

function writeJson(file, data) {
  const dir = dataDir();
  const p = path.join(dir, file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p); // 같은 볼륨 rename 은 원자적 교체
    return true;
  } catch (e) {
    console.error('save failed:', file, e);
    const msg = (e && e.message) || String(e);
    for (const fn of saveFailListeners) {
      try { fn(file, msg); } catch (e2) {}
    }
    return false;
  }
}

function loadTodos() {
  const f = readJson(fileOf('todos'));
  const items = f && Array.isArray(f.items) ? f.items : [];
  return items.filter(it => it && it.id);
}

function saveTodos(items) {
  return writeJson(fileOf('todos'), { kind: 'calendar#events', items });
}

function loadSettings() {
  const s = Object.assign(REG.settingsDefaults(), readJson(fileOf('settings')) || {});
  return clampSettings(s);
}

function saveSettings(s) {
  return writeJson(fileOf('settings'), clampSettings(s));
}

function loadCalendars() {
  const c = readJson(fileOf('calendars'));
  if (!c || !Array.isArray(c.services) || !c.services.length) {
    return JSON.parse(JSON.stringify(DEFAULT_CALENDARS));
  }
  return c;
}

function saveCalendars(c) {
  return writeJson(fileOf('calendars'), c);
}



/** 파일의 마지막 수정 시각. 읽지는 않는다 — 빌드 시각 표시에 쓴다.
 *  파일 IO 는 이 파일 하나만 한다는 규약을 지키려고 여기에 둔다(lint:fs-gateway). */
function fileMTime(filePath) {
  try { return fs.statSync(filePath).mtime; } catch (e) { return null; }
}

/** 사용자가 지목한 바깥 텍스트 파일을 읽는다(구독용 .ics 등). 읽기 전용.
 *  우리 데이터 폴더가 아니라 임의 경로라 DATA_STORES 에 등록할 대상이 아니지만,
 *  파일 IO 는 이 파일 하나만 한다는 규약은 그대로 지킨다. */
function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// ---- 구독 캘린더 캐시 ----
// { "<calId>": { fetchedAt, events: [...], error: null|string, warnings: [] } }
// 원장과 섞지 않는다 — 갱신 때 통째로 갈아끼우는 남의 데이터다.

function loadSubCache() {
  return readJson(fileOf('subCache')) || {};
}

function saveSubCache(cache) {
  return writeJson(fileOf('subCache'), cache || {});
}

// ---- 읽기 전용 캘린더의 로컬 상태(오버레이) ----
// { "<instId>": { todoStatus, closedAt } }
// 남의 캘린더는 고칠 수 없으니 "내가 완료했다"는 사실만 여기 남긴다.

function loadOverlay() {
  return readJson(fileOf('subOverlay')) || {};
}

function saveOverlay(o) {
  return writeJson(fileOf('subOverlay'), o || {});
}


// ---- 구글 계정 토큰·메타 ----
// 토큰은 설정 파일에 넣지 않는다 — 사람이 열어 보는 파일이라 언젠가 새어 나간다.
// safeStorage(윈도우 DPAPI)로 암호화해 계정별 파일에 넣고, 그것마저 불가능한 환경이면
// 저장하지 않고 그 세션에서만 쓴다(그 사실을 호출부에 알린다).







// ---- 원격 동기화 비밀번호 ----
// 여기 두는 이유: 파일 IO 는 이 파일이 유일한 관문이다. sync 모듈이 직접 fs 를 쓰면
// 관문이 둘이 되고, 무엇보다 "비밀번호를 한 번 저장하려고" 동기화 모듈 전체를 로드하게 된다
// (동기화가 꺼진 폐쇄망에서도 네트워크 코드가 메모리에 올라온다).
// 설정 파일에는 넣지 않는다 — 사람이 열어 보는 파일이라 언젠가 새어 나간다.





// 정규화는 SETTINGS_FIELDS 에서 파생된다 — 필드를 추가하면 여기가 저절로 따라온다.
/** IANA 시간대 이름인가. Intl 이 모르는 이름이면 Date 가 조용히 UTC 로 돈다. */
function isRealTimeZone(name) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch (e) {
    return false;
  }
}

function clampSettings(input) {
  const out = {};
  for (const f of REG.SETTINGS_FIELDS) {
    const v = input ? input[f.key] : undefined;
    switch (f.type) {
      case 'bool':
        out[f.key] = (v === undefined || v === null) ? f.def : !!v;
        break;
      case 'int': {
        const n = parseInt(v, 10);
        out[f.key] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def;
        break;
      }
      case 'ratio': {
        const n = typeof v === 'number' ? v : parseFloat(v);
        out[f.key] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def;
        break;
      }
      case 'enum':
        out[f.key] = f.values.indexOf(v) >= 0 ? v : f.def;
        break;
      case 'intlist':
        out[f.key] = Array.isArray(v)
          ? v.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0 && x <= 40320)
          : (Array.isArray(f.def) ? f.def.slice() : []);
        break;
      // 값이 실재하는 IANA 시간대여야 한다. 오타 하나로 앱 전체의 시각이 어긋나는데,
      // 보이는 것은 "알림이 9시간 밀린다" 뿐이라 원인을 짚기 어렵다.
      case 'timezone':
        out[f.key] = (typeof v === 'string' && isRealTimeZone(v)) ? v : f.def;
        break;
      case 'string':
      default:
        out[f.key] = typeof v === 'string' ? v : f.def;
        break;
    }
  }
  return out;
}

module.exports = {
  dataDir, loadTodos, saveTodos, loadSettings, saveSettings,
  loadCalendars, saveCalendars,
  loadSubCache, saveSubCache, readTextFile, fileMTime, loadOverlay, saveOverlay,
  clampSettings, onSaveFailed, DEFAULT_CALENDARS,
  DEFAULT_SETTINGS: REG.settingsDefaults()
};
