'use strict';

// 한국어 시간 표현 파서 — C# v1 (src\Nlp.cs)의 JS 포팅.
// 지원: "30분 뒤", "1시간 반 후", "두시간 뒤", "3일 뒤", "내일 오후 3시",
//       "모레 14:30", "8월 21일 9시", "8/21 저녁", "다음주 월요일 3시 반", "점심에" 등
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Nlp = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const WORD_NUMS = '한|두|세|네|다섯|여섯|일곱|여덟|아홉|열한|열두|열';
  const WORD_MAP = { '한': 1, '두': 2, '세': 3, '네': 4, '다섯': 5, '여섯': 6, '일곱': 7, '여덟': 8, '아홉': 9, '열': 10, '열한': 11, '열두': 12 };

  function wordNum(w) { return WORD_MAP[w] || 0; }

  function cleanTitle(t) {
    return (t || '').replace(/\s+/g, ' ').trim().replace(/^[\s,·-]+|[\s,·-]+$/g, '');
  }

  // 겹칠 수 있는 매치 구간을 클램프하며 제거
  function removeSegs(text, segs) {
    segs.sort((a, b) => b.start - a.start);
    let t = text;
    let prevStart = t.length;
    for (const s of segs) {
      const end = Math.min(s.start + s.len, prevStart);
      if (end > s.start) {
        t = t.slice(0, s.start) + t.slice(end);
        prevStart = s.start;
      }
    }
    return cleanTitle(t);
  }

  function parse(text, now) {
    const r = { hasTime: false, when: null, title: cleanTitle(text || ''), matched: '' };
    if (!text || !text.trim()) return r;
    now = now || new Date();
    const segs = [];
    const matched = [];

    // ---- 1) 상대 시간 ----
    let m = text.match(new RegExp('(?:([0-9]{1,3})|(' + WORD_NUMS + '))\\s*시간\\s*(?:([0-9]{1,2})\\s*분|(반))?\\s*(?:뒤|후)(?:에)?'));
    if (m) {
      const h = m[1] ? parseInt(m[1], 10) : wordNum(m[2]);
      const mm = m[3] ? parseInt(m[3], 10) : (m[4] ? 30 : 0);
      r.when = new Date(now.getTime() + h * 3600000 + mm * 60000);
      r.hasTime = true;
      segs.push({ start: m.index, len: m[0].length });
      matched.push(m[0].trim());
      r.title = removeSegs(text, segs);
      r.matched = matched.join(' ');
      return r;
    }
    m = text.match(/([0-9]{1,4})\s*분\s*(?:뒤|후)(?:에)?/);
    if (m) {
      r.when = new Date(now.getTime() + parseInt(m[1], 10) * 60000);
      r.hasTime = true;
      segs.push({ start: m.index, len: m[0].length });
      matched.push(m[0].trim());
      r.title = removeSegs(text, segs);
      r.matched = matched.join(' ');
      return r;
    }

    // ---- 2) 날짜 부분 ----
    let hasDay = false;
    let weekdayAuto = false;
    let baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    m = text.match(/([0-9]{1,3})\s*일\s*(?:뒤|후)(?:에)?/);
    if (m) {
      baseDate = addDays(baseDate, parseInt(m[1], 10));
      hasDay = true;
      segs.push({ start: m.index, len: m[0].length });
      matched.push(m[0].trim());
    }

    if (!hasDay) {
      m = text.match(/오늘|내일모레|내일|모레|글피/);
      if (m) {
        let off = 0;
        if (m[0] === '내일') off = 1;
        else if (m[0] === '모레' || m[0] === '내일모레') off = 2;
        else if (m[0] === '글피') off = 3;
        baseDate = addDays(baseDate, off);
        hasDay = true;
        segs.push({ start: m.index, len: m[0].length });
        matched.push(m[0]);
      }
    }

    if (!hasDay) {
      m = text.match(/([0-9]{1,2})\s*월\s*([0-9]{1,2})\s*일(?:에)?/);
      if (m) {
        const mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(now.getFullYear(), mo)) {
          baseDate = new Date(now.getFullYear(), mo - 1, d);
          if (baseDate < startOfDay(now)) baseDate = new Date(now.getFullYear() + 1, mo - 1, d);
          hasDay = true;
          segs.push({ start: m.index, len: m[0].length });
          matched.push(m[0].trim());
        }
      }
    }

    if (!hasDay) {
      m = text.match(/(?<![0-9./])([0-9]{1,2})\s*\/\s*([0-9]{1,2})(?![0-9./:])/);
      if (m) {
        const mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(now.getFullYear(), mo)) {
          baseDate = new Date(now.getFullYear(), mo - 1, d);
          if (baseDate < startOfDay(now)) baseDate = new Date(now.getFullYear() + 1, mo - 1, d);
          hasDay = true;
          segs.push({ start: m.index, len: m[0].length });
          matched.push(m[0].trim());
        }
      }
    }

    if (!hasDay) {
      m = text.match(/(?:(다음\s*주|담주)\s*)?([월화수목금토일])요일(?:에)?/);
      if (m) {
        const order = ['일', '월', '화', '수', '목', '금', '토'];
        const target = order.indexOf(m[2]);
        if (m[1]) {
          // 다음주 X요일 = 다음 달력 주(월요일 시작)의 X요일
          const mondayOffset = (now.getDay() + 6) % 7;
          const thisMonday = addDays(startOfDay(now), -mondayOffset);
          baseDate = addDays(thisMonday, 7 + ((target + 6) % 7));
        } else {
          weekdayAuto = true;
          baseDate = addDays(startOfDay(now), (target - now.getDay() + 7) % 7);
        }
        hasDay = true;
        segs.push({ start: m.index, len: m[0].length });
        matched.push(m[0].trim());
      }
    }

    // ---- 3) 시각 부분 ----
    let hasClock = false;
    let clockDigits = false;
    let colonNotation = false;
    let hour = 9, minute = 0;
    let mer = null;

    m = text.match(/(?:(오전|오후|아침|점심|저녁|밤|새벽)\s*)?([0-9]{1,2})\s*[:：]\s*([0-9]{2})(?:에)?/);
    if (m) {
      const h = parseInt(m[2], 10), mm2 = parseInt(m[3], 10);
      if (h <= 23 && mm2 <= 59) {
        if (m[1]) mer = m[1];
        hour = h; minute = mm2;
        hasClock = true; clockDigits = true; colonNotation = true;
        segs.push({ start: m.index, len: m[0].length });
        matched.push(m[0].trim());
      }
    }

    if (!hasClock) {
      m = text.match(new RegExp('(?:(오전|오후|아침|점심|저녁|밤|새벽)\\s*)?(?:([0-9]{1,2})|(' + WORD_NUMS + '))\\s*시(?!간)(?:\\s*(?:([0-9]{1,2})\\s*분|(반)))?(?:에)?'));
      if (m) {
        const h = m[2] ? parseInt(m[2], 10) : wordNum(m[3]);
        if (h >= 0 && h <= 24) {
          if (m[1]) mer = m[1];
          hour = h;
          minute = m[4] ? Math.min(59, parseInt(m[4], 10)) : (m[5] ? 30 : 0);
          hasClock = true; clockDigits = true;
          segs.push({ start: m.index, len: m[0].length });
          matched.push(m[0].trim());
        }
      }
    }

    if (!hasClock) {
      m = text.match(/(정오|자정|아침|점심|저녁|밤|새벽|오전|오후)(?:에)?/);
      if (m) {
        const w = m[1];
        minute = 0;
        if (w === '정오' || w === '점심') hour = 12;
        else if (w === '자정') hour = 0;
        else if (w === '아침') hour = 8;
        else if (w === '오전') hour = 9;
        else if (w === '오후') hour = 14;
        else if (w === '저녁') hour = 18;
        else if (w === '밤') hour = 21;
        else if (w === '새벽') hour = 5;
        hasClock = true;
        segs.push({ start: m.index, len: m[0].length });
        matched.push(m[0].trim());
      }
    }

    if (!hasDay && !hasClock) return r;

    // 오전/오후 보정
    if (clockDigits) {
      if (mer === '오후' || mer === '저녁' || mer === '밤' || mer === '점심') {
        if (mer === '밤' && hour === 12) {
          hour = 0;
          if (hasDay) baseDate = addDays(baseDate, 1); // "밤 12시" = 자정
        } else if (hour < 12) hour += 12;
      } else if (mer === '오전' || mer === '아침' || mer === '새벽') {
        if (hour === 12) hour = 0;
      } else if (mer === null && !colonNotation) {
        if (hour >= 1 && hour <= 7) hour += 12; // 관용: "3시 회의"=15:00 (콜론 표기 제외)
      }
    }
    if (hour > 23) hour = 23;

    let when = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), hour, minute, 0);
    if (!hasDay && hasClock) {
      if (when <= now) when = addDays(when, 1);
    } else if (weekdayAuto && when <= now) {
      when = addDays(when, 7);
    }

    r.when = when;
    r.hasTime = true;
    r.title = removeSegs(text, segs);
    r.matched = matched.join(' ');
    return r;
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysInMonth(y, mo) { return new Date(y, mo, 0).getDate(); }

  return { parse };
});
