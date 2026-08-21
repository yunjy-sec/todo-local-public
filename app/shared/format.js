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

  // ---- 시간대 ----
  // 윈도우의 Node/Chromium 은 **시작 시점의** TZ 환경변수를 무시하고 OS 시간대를 쓴다.
  // 그래서 main 이 process.env.TZ 를 바꿔도 창은 그것을 물려받지 못한다 —
  // 설정한 시간대와 다른 곳에 살면 목록·캘린더의 시각이 OS 기준으로 그려진다.
  // 표기를 만드는 자리가 여기 하나뿐이므로, 벽시계 숫자를 여기서 설정 시간대로 뽑는다.
  var fmtCache = { tz: null, fmt: null };
  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /** 설정 시간대의 벽시계 값. 시간대가 없거나 쓸 수 없으면 null(호스트 기준을 쓴다). */
  function zoned(d, tz) {
    if (!tz) return null;
    try {
      if (fmtCache.tz !== tz) {
        fmtCache.fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, hourCycle: 'h23', weekday: 'short',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        });
        fmtCache.tz = tz;
      }
      var got = {};
      var arr = fmtCache.fmt.formatToParts(d);
      for (var i = 0; i < arr.length; i++) got[arr[i].type] = arr[i].value;
      return {
        y: parseInt(got.year, 10), mo: parseInt(got.month, 10), day: parseInt(got.day, 10),
        h: parseInt(got.hour, 10) % 24, mi: parseInt(got.minute, 10), dow: DOW[got.weekday]
      };
    } catch (e) {
      return null; // 없는 시간대 이름 — 조용히 호스트 기준으로 돈다(설정 저장에서 이미 걸러진다)
    }
  }

  /** 표기에 쓸 벽시계 값 한 벌. */
  function wall(d, settings) {
    return zoned(d, settings && settings.timeZone) || {
      y: d.getFullYear(), mo: d.getMonth() + 1, day: d.getDate(),
      h: d.getHours(), mi: d.getMinutes(), dow: d.getDay()
    };
  }

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
    var w = wall(d, settings);
    var h = w.h;
    var m = pad2(w.mi);
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
    var w = wall(d, settings);
    return w.mo + '월 ' + w.day + '일 (' + DAYS[w.dow] + ') ' + time(d, settings);
  }

  /** 오늘/내일이면 그렇게, 아니면 날짜까지. */
  function listDate(d, now, settings) {
    // 날짜 경계도 설정 시간대 기준이다 — 호스트 기준으로 세면 자정 근처에서
    // "오늘" 과 "내일" 이 뒤바뀐다.
    var a = wall(d, settings), b = wall(now, settings);
    var d0 = Date.UTC(a.y, a.mo - 1, a.day);
    var n0 = Date.UTC(b.y, b.mo - 1, b.day);
    var diff = Math.round((d0 - n0) / 86400000);
    if (diff === 0) return '오늘 ' + time(d, settings);
    if (diff === 1) return '내일 ' + time(d, settings);
    return dateTime(d, settings);
  }

  /** 종일 일정 표기: 'M/D 종일' */
  function allDay(d, settings) {
    var w = wall(d, settings);
    return w.mo + '/' + w.day + ' 종일';
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

  return { time: time, dateTime: dateTime, listDate: listDate, allDay: allDay, fcTime: fcTime, wall: wall, DAYS: DAYS };
});
