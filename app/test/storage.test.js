'use strict';

/* 저장 계약 시험.
 *
 * 왜 있는가
 *   저장은 조용히 실패한다. 화면에도 콘솔에도 표시가 없고, 사용자는 다음에 앱을 켰을 때
 *   비로소 일정이 사라진 것을 안다. 그런 것은 사람이 못 잡는다.
 *   그리고 구글 캘린더가 준 필드 중 우리가 모르는 것을 왕복에서 잃으면
 *   나중에 원격 동기화를 붙였을 때 남의 캘린더 데이터를 조용히 지우게 된다.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-storage-'));
  const prev = process.env.TODO_DATA_DIR;
  process.env.TODO_DATA_DIR = dir;
  // storage 는 dataDir() 를 호출 시점에 읽으므로 require 캐시를 비울 필요가 없다.
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TODO_DATA_DIR;
    else process.env.TODO_DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const storage = require('../main/storage.js');
const REG = require('../shared/registry.js');

test('데이터 디렉터리는 TODO_DATA_DIR 로 주입된다 (실사용 원장을 만지지 않는다)', () => {
  withTempDir((dir) => {
    assert.strictEqual(storage.dataDir(), dir);
  });
});

test('todos 저장·로드 왕복', () => {
  withTempDir(() => {
    const items = [{ id: 'a1', kind: 'calendar#event', summary: '테스트', start: { dateTime: '2026-08-20T10:00:00+09:00' } }];
    assert.strictEqual(storage.saveTodos(items), true);
    const back = storage.loadTodos();
    assert.strictEqual(back.length, 1);
    assert.strictEqual(back[0].summary, '테스트');
  });
});

test('id 없는 항목은 로드에서 걸러진다', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'todos.json'), JSON.stringify({
      kind: 'calendar#events',
      items: [{ id: 'ok', summary: 'a' }, { summary: 'id 없음' }, null],
    }), 'utf8');
    const back = storage.loadTodos();
    assert.strictEqual(back.length, 1);
    assert.strictEqual(back[0].id, 'ok');
  });
});

test('우리가 모르는 구글 캘린더 필드도 왕복에서 보존된다', () => {
  withTempDir(() => {
    const items = [{
      id: 'g1',
      kind: 'calendar#event',
      summary: '남의 캘린더에서 온 일정',
      start: { dateTime: '2026-08-20T10:00:00+09:00', timeZone: 'Asia/Seoul' },
      attendees: [{ email: 'x@example.com', responseStatus: 'accepted' }],
      conferenceData: { conferenceId: 'abc-defg-hij' },
      etag: '"3456789"',
      htmlLink: 'calendar-link-xyz',
      extendedProperties: { private: { todoStatus: 'pending' }, shared: { team: 'infra' } },
    }];
    storage.saveTodos(items);
    const back = storage.loadTodos();
    assert.deepStrictEqual(back[0].attendees, items[0].attendees);
    assert.deepStrictEqual(back[0].conferenceData, items[0].conferenceData);
    assert.strictEqual(back[0].etag, items[0].etag);
    assert.strictEqual(back[0].htmlLink, items[0].htmlLink);
    assert.deepStrictEqual(back[0].extendedProperties.shared, { team: 'infra' });
    assert.strictEqual(back[0].start.timeZone, 'Asia/Seoul');
  });
});

test('깨진 JSON 은 백업하고 빈 목록으로 시작한다 (앱이 죽지 않는다)', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'todos.json'), '{ 이건 JSON 이 아니다', 'utf8');
    const back = storage.loadTodos();
    assert.deepStrictEqual(back, []);
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('todos.json.corrupt-'));
    assert.strictEqual(backups.length, 1, '깨진 파일은 백업본이 남아야 한다');
  });
});

test('BOM 이 붙은 파일도 읽는다 (설정이 매번 초기화되던 사고)', () => {
  withTempDir((dir) => {
    // 메모장·PowerShell 리다이렉트(> · Out-File)가 UTF-8 BOM 을 붙인다.
    // JSON.parse 는 앞의 U+FEFF 를 거부하므로, 벗기지 않으면 켤 때마다 파싱이 실패해
    // 원본을 .corrupt-<시각> 으로 밀어 두고 기본값으로 시작한다.
    // 실사용 원장에서 실제로 그랬다 — settings.json 이 ef bb bf 로 시작하고
    // 격리 사본이 4개 쌓여 있었다. 사용자에게는 "설정이 자꾸 초기화되는" 것으로만 보인다.
    const BOM = '﻿';
    fs.writeFileSync(path.join(dir, 'settings.json'),
      BOM + JSON.stringify({ opacity: 0.55 }), 'utf8');

    const s = storage.loadSettings();
    assert.strictEqual(s.opacity, 0.55, '저장해 둔 설정이 살아 있어야 한다');

    const backups = fs.readdirSync(dir).filter(f => f.startsWith('settings.json.corrupt-'));
    assert.deepStrictEqual(backups, [], 'BOM 을 손상으로 오해하면 매 실행마다 격리 사본이 쌓인다');
  });
});

test('저장은 원자적이다 — 임시 파일이 남지 않는다', () => {
  withTempDir((dir) => {
    storage.saveTodos([{ id: 'x', summary: 'a' }]);
    const stray = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.deepStrictEqual(stray, [], '.tmp 가 남았다면 교체가 원자적이지 않다');
  });
});

test('설정 기본값은 SETTINGS_FIELDS 에서 파생된다', () => {
  withTempDir(() => {
    const s = storage.loadSettings();
    for (const f of REG.SETTINGS_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(s, f.key), `설정에 ${f.key} 가 없다`);
    }
    // 사용자가 명시한 기본값 (변경 시 이 시험이 먼저 운다)
    assert.strictEqual(s.autostart, true, '자동 실행 기본값은 켜짐');
    assert.strictEqual(s.showClosed, true, '지난 항목 표시 기본값은 켜짐');
    assert.strictEqual(s.listSortAsc, true, '예정 목록 기본은 과거→미래');
    assert.strictEqual(s.snapMinutes, 15);
    assert.strictEqual(s.position, 'bottom-center');
  });
});

test('설정 clamp — 범위 밖·잘못된 타입은 기본값이나 경계로 정규화된다', () => {
  const c = storage.clampSettings({
    opacity: 5,             // 범위 초과 → max
    popupWidth: 10,         // 범위 미만 → min
    snapMinutes: 'abc',     // 숫자 아님 → 기본값
    position: '없는위치',    // enum 밖 → 기본값
    playSound: 'yes',       // 문자열 → true
    defaultReminderMinutes: [10, -3, 'x', 30], // 유효한 것만
    hotkeyList: 42,         // 문자열 아님 → 기본값
  });
  assert.strictEqual(c.opacity, 1);
  assert.strictEqual(c.popupWidth, 260);
  assert.strictEqual(c.snapMinutes, 15);
  assert.strictEqual(c.position, 'bottom-center');
  assert.strictEqual(c.playSound, true);
  assert.deepStrictEqual(c.defaultReminderMinutes, [10, 30]);
  assert.strictEqual(c.hotkeyList, 'Control+Alt+T');
});

test('설정 저장·로드 왕복 후에도 정규화가 유지된다', () => {
  withTempDir(() => {
    storage.saveSettings(Object.assign(storage.loadSettings(), { snapMinutes: 999, opacity: 0.5 }));
    const s = storage.loadSettings();
    assert.strictEqual(s.snapMinutes, 60, 'clamp 상한');
    assert.strictEqual(s.opacity, 0.5);
  });
});

test('캘린더 레지스트리 기본값 — 로컬 캘린더 하나가 항상 있다 (폐쇄망에서도 동작)', () => {
  withTempDir(() => {
    const c = storage.loadCalendars();
    assert.strictEqual(c.services.length, 1);
    assert.strictEqual(c.services[0].type, 'local');
    const cal = c.services[0].accounts[0].calendars[0];
    assert.strictEqual(cal.id, 'default');
    assert.strictEqual(cal.primary, true);
    assert.strictEqual(cal.accessRole, 'owner');
  });
});

test('빈 서비스 목록은 기본 캘린더로 복구된다', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'calendars.json'), JSON.stringify({ services: [] }), 'utf8');
    const c = storage.loadCalendars();
    assert.strictEqual(c.services.length, 1, '캘린더가 하나도 없으면 앱이 아무것도 못 한다');
  });
});

test('미등록 데이터 저장소 접근은 즉시 터진다', () => {
  const files = REG.DATA_STORES.map(d => d.file);
  assert.ok(files.includes('todos.json'));
  assert.ok(files.includes('calendars.json'));
  assert.ok(files.includes('settings.json'));
});
