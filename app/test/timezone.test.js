'use strict';

/* 이 시험 묶음이 서 있는 전제: 프로세스의 지역 시간대가 +09:00 이다.
 *
 * 왜 있는가
 *   이 앱은 **로컬 벽시계**로 돈다. 반복 회차 키(instKey)도, 팝업이 뜰 시각도,
 *   ICS 의 TZID 해석도 전부 그 기계의 지역 시각 기준이다. 단일 기기에서 쓰는
 *   도구라 그게 옳은 의미지만, 그래서 시험 픽스처의 '+09:00' 과 기대값의
 *   '09:00' 이 **한 시간대에서만** 맞는다.
 *
 *   실제로 그것 때문에 CI 가 통째로 빨개졌다. 러너는 UTC 였고, 같은 픽스처가
 *   09:00 이 아니라 00:00 로 전개되면서 반복·상태·ICS 시험 15건이 한꺼번에
 *   무너졌다. 그런데 실패 메시지는 전부 "09:00 을 기대했는데 00:00" 이라
 *   **원인이 시간대라는 말을 아무도 하지 않았다** — 반복 전개기가 깨진 줄 알고
 *   엉뚱한 곳을 뒤지게 된다.
 *
 *   그래서 전제를 코드로 못 박는다. 시간대가 다르면 이 시험이 **먼저** 울고,
 *   무엇을 하면 되는지 한 줄로 말한다.
 */

const test = require('node:test');
const assert = require('node:assert');

// 픽스처가 쓰는 오프셋. 여기를 바꾸려면 test/ 전체의 기대값을 함께 바꿔야 한다.
const EXPECTED_OFFSET_MINUTES = 9 * 60;

test('시험은 +09:00 지역 시간대를 전제한다 (다르면 여기서 먼저 운다)', () => {
  // getTimezoneOffset 은 "UTC - 지역" 이라 부호가 뒤집혀 있다(+09:00 → -540).
  const actual = -new Date('2026-08-25T00:00:00Z').getTimezoneOffset();
  assert.strictEqual(actual, EXPECTED_OFFSET_MINUTES,
    `이 시험 묶음은 지역 시간대 +09:00 을 전제합니다(지금은 ${actual >= 0 ? '+' : ''}${actual}분). ` +
    '픽스처가 +09:00 로 적혀 있고 기대값이 로컬 벽시계라, 다른 시간대에서는 반복 전개·회차 키·' +
    'ICS 해석 시험이 한꺼번에 어긋납니다. TZ=Asia/Seoul 로 실행하세요 ' +
    '(CI 는 워크플로에서 그렇게 지정합니다).');
});

test('시간대는 설정 항목이고 기본값이 KST 다', () => {
  const REG = require('../shared/registry.js');
  const storage = require('../main/storage.js');
  const field = REG.SETTINGS_FIELDS.find(f => f.key === 'timeZone');
  assert.ok(field, '시간대가 설정에 없으면 다른 곳에서 쓰는 사람이 고칠 방법이 없다');
  assert.strictEqual(field.def, 'Asia/Seoul');

  // 없는 이름을 넣으면 기본으로 되돌린다. 오타 하나로 앱 전체의 시각이 어긋나는데,
  // 보이는 것은 "알림이 9시간 밀린다" 뿐이라 원인을 짚기 어렵다.
  assert.strictEqual(storage.clampSettings({ timeZone: 'Asia/Seuol' }).timeZone, 'Asia/Seoul');
  assert.strictEqual(storage.clampSettings({ timeZone: '' }).timeZone, 'Asia/Seoul');
  assert.strictEqual(storage.clampSettings({ timeZone: 42 }).timeZone, 'Asia/Seoul');
  // 실재하는 이름은 그대로 둔다.
  assert.strictEqual(storage.clampSettings({ timeZone: 'America/New_York' }).timeZone, 'America/New_York');
});

test('로컬 벽시계 해석이 실제로 그렇게 동작한다', () => {
  // 전제가 맞다면 이 두 표기는 같은 순간이고, 지역 시각으로 09:00 이다.
  const withOffset = new Date('2026-08-25T09:00:00+09:00');
  const asUtc = new Date('2026-08-25T00:00:00Z');
  assert.strictEqual(withOffset.getTime(), asUtc.getTime(), '같은 순간이어야 한다');
  assert.strictEqual(withOffset.getHours(), 9,
    '픽스처의 +09:00 시각이 로컬 벽시계로 9시로 읽혀야 나머지 시험의 기대값이 성립한다');
});

test('표기는 설정 시간대로 그린다 (창은 OS 시간대를 물려받으므로 표기에서 맞춘다)', () => {
  const fmt = require('../shared/format.js');
  const d = new Date('2026-08-25T09:00:00+09:00');

  assert.strictEqual(fmt.time(d, { timeZone: 'Asia/Seoul' }), '09:00');
  assert.strictEqual(fmt.time(d, { timeZone: 'America/New_York' }), '20:00',
    '창이 다른 시간대에 있어도 설정한 기준으로 그려야 한다');
  // 날짜 경계도 함께 움직여야 한다 — 안 그러면 자정 근처에서 "오늘/내일"이 뒤바뀐다.
  assert.strictEqual(fmt.dateTime(d, { timeZone: 'America/New_York' }), '8월 24일 (월) 20:00');

  // 없는 이름은 조용히 호스트 기준으로 떨어진다(설정 저장에서 이미 걸러진다).
  assert.strictEqual(fmt.time(d, { timeZone: 'Asia/Seuol' }), fmt.time(d, {}));
});
