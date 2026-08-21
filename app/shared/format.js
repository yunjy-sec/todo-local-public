'use strict';

/* 시각·날짜 표기 — 창마다 따로 만들지 않는다.
 *
 * 왜 한 곳인가
 *   팝업·목록·캘린더가 각자 시각을 그리면 설정을 바꿔도 한 곳만 바뀌고, 사용자는
 *   같은 일정이 창마다 다르게 보이는 것을 본다. 실제로 팝업만 오전/오후였고
 *   목록은 24시간이었다.
 *
 * 기본은 24시간 · 앞자리 0 (00:00). 오전/오후와 앞자리 0 제거는 각각 옵션이다.
 * 이 파일은 순수 함수만 둔다(DOM·네트워크·fs 금지) — main 과 창이 같은 파일을 읽는다.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TD_FORMAT = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  var DAYS = ['일', '월', '화', '수', '목', '금', '토'];

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function opt(o) {
    o = o || {};
    return {
      // '24h'(기본) | '12h'
      timeFormat: o.timeFormat === '12h' ? '12h' : '24h',
      // 한 자리 시각 앞에 0 을 붙일지. 기본 true → 09:00 / 끄면 9:00
      padHour: o.timePadHour === undefined ? true : !!o.timePadHour
    };
  }

  /** 시:분. 12h 면 '오후 2:30', 24h 면 '14:30'. */
  function time(d, settings) {
    var s = opt(settings);
    var h = d.getHours();
    var m = pad2(d.getMinutes());
    if (s.timeFormat === '12h') {
      var mer = h < 12 ? '오전' : '오후';
      var h12 = h % 12;
      if (h12 === 0) h12 = 12;
      return mer + ' ' + (s.padHour ? pad2(h12) : h12) + ':' + m;
    }
    return (s.padHour ? pad2(h) : h) + ':' + m;
  }

  /** 'M월 D일 (요일) 시:분' */
  function dateTime(d, settings) {
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + DAYS[d.getDay()] + ') ' + time(d, settings);
  }

  /** 오늘/내일이면 그렇게, 아니면 날짜까지. */
  function listDate(d, now, settings) {
    var d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var n0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diff = Math.round((d0 - n0) / 86400000);
    if (diff === 0) return '오늘 ' + time(d, settings);
    if (diff === 1) return '내일 ' + time(d, settings);
    return dateTime(d, settings);
  }

  /** 종일 일정 표기: 'M/D 종일' */
  function allDay(d) {
    return (d.getMonth() + 1) + '/' + d.getDate() + ' 종일';
  }

  /** FullCalendar 의 시각 포맷 객체(뷰의 시간축·이벤트 시각에 그대로 넘긴다). */
  function fcTime(settings) {
    var s = opt(settings);
    return {
      hour: s.padHour ? '2-digit' : 'numeric',
      minute: '2-digit',
      hour12: s.timeFormat === '12h',
      meridiem: s.timeFormat === '12h' ? 'short' : false
    };
  }

  return { time: time, dateTime: dateTime, listDate: listDate, allDay: allDay, fcTime: fcTime, DAYS: DAYS };
});
