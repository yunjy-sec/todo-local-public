'use strict';

/* 한국어 시간 표현 파서 시험.
 *
 * 왜 있는가
 *   파서는 조용히 틀린다. "3:00" 을 15:00 으로 읽거나 "1시간 회의" 를 오후 1시로 읽어도
 *   앱은 아무 불평 없이 그 시각에 등록한다. 사용자는 알림이 안 와야 알아챈다.
 *   아래 케이스는 전부 실제로 틀렸던 것들이다(전각 숫자·겹치는 매치는 크래시까지 났다).
 */

const test = require('node:test');
const assert = require('node:assert');
const Nlp = require('../shared/nlp.js');

const NOW = new Date(2026, 7, 20, 15, 53, 0); // 2026-08-20 (목) 오후

function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi || 0, 0);
}

function parse(text) {
  return Nlp.parse(text, NOW);
}

const CASES = [
  ['내일 오후 3시 회의', at(2026, 8, 21, 15, 0), '회의'],
  ['30분 뒤 스트레칭', new Date(NOW.getTime() + 30 * 60000), '스트레칭'],
  ['1시간 반 후 운동', new Date(NOW.getTime() + 90 * 60000), '운동'],
  ['두시간 뒤 빨래', new Date(NOW.getTime() + 120 * 60000), '빨래'],
  ['3시 반 회의', at(2026, 8, 21, 15, 30), '회의'],
  ['8시 회의', at(2026, 8, 21, 8, 0), '회의'],
  ['17시 보고', at(2026, 8, 20, 17, 0), '보고'],
  ['오늘 18:00 퇴근', at(2026, 8, 20, 18, 0), '퇴근'],
  ['점심에 약 먹기', at(2026, 8, 21, 12, 0), '약 먹기'],
  ['저녁 회식', at(2026, 8, 20, 18, 0), '회식'],
  ['모레 아침 9시 출장', at(2026, 8, 22, 9, 0), '출장'],
  ['8월 21일 9시 발표', at(2026, 8, 21, 9, 0), '발표'],
  ['8/25 14:30 병원', at(2026, 8, 25, 14, 30), '병원'],
  ['다음주 월요일 9시 보고', at(2026, 8, 24, 9, 0), '보고'],
  ['금요일 3시 미팅', at(2026, 8, 21, 15, 0), '미팅'],
  ['목요일 10시 리뷰', at(2026, 8, 27, 10, 0), '리뷰'],
  ['3일 뒤 오후 2시 검진', at(2026, 8, 23, 14, 0), '검진'],
  ['자정에 백업 확인', at(2026, 8, 21, 0, 0), '백업 확인'],
  // 아래 셋은 리뷰에서 확정된 결함의 회귀 케이스
  ['내일 3:00 공항버스', at(2026, 8, 21, 3, 0), '공항버스'],   // 콜론 표기는 오후 보정 제외
  ['내일모레 9시 검진', at(2026, 8, 22, 9, 0), '검진'],
  ['밤 12시 정리', at(2026, 8, 21, 0, 0), '정리'],             // 밤 12시 = 자정
];

for (const [text, when, title] of CASES) {
  test(`파싱: "${text}"`, () => {
    const r = parse(text);
    assert.ok(r.hasTime, '시간을 인식하지 못했다');
    assert.strictEqual(r.when.getTime(), when.getTime(),
      `기대 ${when.toLocaleString()} / 실제 ${r.when.toLocaleString()}`);
    assert.strictEqual(r.title, title);
  });
}

const NO_TIME = [
  '회의 준비',
  '보고서 3장 쓰기',
  '1시간 회의 준비',   // "N시간"(뒤/후 없음)을 "N시" 로 오인하면 안 된다
  '３０분 뒤 약 먹기', // 전각 숫자 — int 파싱이 터지지 않고 그냥 인식 실패여야 한다
];

for (const text of NO_TIME) {
  test(`시간 없음: "${text}"`, () => {
    assert.strictEqual(parse(text).hasTime, false);
  });
}

const NO_CRASH = ['3/4:30 배송 확인', '회의 3/4:30'];

for (const text of NO_CRASH) {
  test(`크래시 없음: "${text}"`, () => {
    // 겹치는 매치 구간 제거에서 예외가 나면 타이핑 도중 앱이 죽는다
    assert.doesNotThrow(() => parse(text));
  });
}

test('빈 입력은 조용히 시간 없음', () => {
  assert.strictEqual(parse('').hasTime, false);
  assert.strictEqual(Nlp.parse(null, NOW).hasTime, false);
});
