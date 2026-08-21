'use strict';

/* iCalendar(.ics) 파서 — 남이 만든 캘린더 텍스트를 우리 이벤트 모양으로 옮긴다.
 *
 * 무엇을 하는가
 *   RFC 5545 텍스트 → { events, warnings, calendarName }.
 *   events 는 우리 원장과 같은 구글 캘린더 호환 모양(kind:'calendar#event')이라
 *   그대로 app/main/model.js · recurrence.js 에 넣을 수 있다. 그것이 이 파서의 합격 기준이다
 *   ("파싱했다"가 아니라 "우리 전개기가 회차를 뽑아낸다" — test/ics.test.js 가 그것을 확인한다).
 *
 * 여기 없는 것 (있으면 안 되는 것)
 *   네트워크·파일 IO·DOM. 문자열을 받아 객체를 돌려주는 순수 함수뿐이다.
 *   .ics 를 가져오는 일은 app/main/sync/(네트워크 유일 관문)와 app/main/storage.js(파일 유일 관문)
 *   의 몫이다 — 여기서 한 줄만 fetch 해도 폐쇄망 불변식이 깨지고 lint:network 가 막는다.
 *
 *   extendedProperties.private 도 만들지 않는다. 소속 캘린더(calendarId)·앱 상태(todoStatus)는
 *   이 텍스트가 아니라 "어느 구독으로 받았는가"에서 나오고, 그것을 아는 것은 app/main 이다.
 *   여기서 private 키를 지어내면 등록되지 않은 키가 원장에 섞이고 lint:private-fields 가 막는다.
 *
 * 시간대(TZID)를 왜 로컬 시각으로 읽는가  ← 이 파서의 유일한 "부정확"이라 근거를 남긴다
 *   TZID=America/New_York 을 제대로 옮기려면 IANA tz 데이터베이스가 필요하다. 이 파일은
 *   의존성 0 이어야 하고(shared 는 창이 <script> 로도 읽는다) 앱은 폐쇄망에서 돈다 —
 *   tz 라이브러리를 들일 수 없다. Intl.DateTimeFormat({timeZone}) 로 흉내 낼 수는 있지만
 *   그것은 "UTC 순간 → 그 지역 벽시계" 방향이고, 우리에게 필요한 것은 반대 방향
 *   ("그 지역 벽시계 → UTC 순간")이라 DST 전환 구간에서 한 시간을 조용히 틀린다.
 *   조용히 한 시간 틀린 알람은 안 뜨는 알람보다 나쁘다 — 사용자가 원인을 짚을 수 없다.
 *   그래서 벽시계 숫자를 그대로 이 PC 의 로컬 시각으로 읽고, 어떤 TZID 였는지를 warnings 에
 *   남긴다. 실제로 만나는 구독 피드는 대부분 (1) UTC(Z) 이거나 (2) 사용자 자신의 시간대라
 *   이 해석이 정확하고, 아닌 경우는 warnings 가 그 사실을 드러낸다.
 *   UTC(Z)는 순간이 확정돼 있으므로 로컬 시각으로 정확히 옮긴다(app/main/util.js 의
 *   toRfc3339 와 같은 모양: 2026-08-20T14:00:00+09:00).
 *
 * 무엇을 버리지 않는가
 *   우리 전개기가 모르는 반복 규칙(RDATE·BYSETPOS 등)도 recurrence 배열에 그대로 보존하고
 *   warnings 로만 알린다. 버리면 왕복에서 원본이 영영 사라진다
 *   (registry.RRULE_SUPPORT.note 와 같은 원칙 — 지원 범위표도 거기서 읽는다).
 *
 * 깨진 입력
 *   죽지 않는다. 못 읽은 VEVENT 는 건너뛰고 warnings 에 남긴다. HTML(로그인·오류 페이지)이
 *   200 으로 오는 일이 흔하므로 그때도 events 는 빈 배열이고 무엇이 왔는지를 남긴다.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./registry.js'));
  else root.TD_ICS = factory(root.TD_REGISTRY);
})(typeof self !== 'undefined' ? self : this, function (REG) {

  // 우리가 전개할 수 있는 반복 규칙의 범위. 표는 registry 가 소유한다 —
  // 목록을 여기 다시 적으면 registry 에서 지원을 늘려도 경고는 옛날 표로 나온다.
  var SUPPORT = REG && REG.RRULE_SUPPORT ? REG.RRULE_SUPPORT : null;

  // RFC 5545 가 정한 반복 관련 속성 전부(우리 정책이 아니라 규격의 어휘라 여기 둔다).
  // 이 중 무엇을 실제로 전개하는지는 SUPPORT.lines 가 정한다.
  var RECUR_PROPS = ['RRULE', 'RDATE', 'EXDATE', 'EXRULE'];

  // ics STATUS → GCal event.status (contracts.validateEvent 가 받는 어휘).
  var STATUS_MAP = { CONFIRMED: 'confirmed', TENTATIVE: 'tentative', CANCELLED: 'cancelled' };
  var DEFAULT_STATUS = 'confirmed';

  // id 정규화. 우리 id 는 키이자 파일명 조각으로 쓰이므로 경로·예약어로 쓸 수 없는 글자를 남기지 않는다.
  var ID_MAX = 120;
  var ID_HASH_LEN = 9; // '-' + 8자리
  var ID_UNSAFE = /[^A-Za-z0-9._-]/g;
  var ID_LEADING = /^[.\-]+/;
  var WIN_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

  var DEFAULT_MAX_EVENTS = 5000;
  var DAY_MS = 86400000;

  // ───────────────────────── 문자열 ─────────────────────────

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  /** 프로토타입 없는 표(키가 남이 지은 문자열일 때 쓴다). */
  function bare() { return Object.create(null); }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /* 줄 접힘(line folding)을 푼다. 다음 줄이 공백·탭으로 시작하면 그 한 글자만 떼고 이어 붙인다.
   * CRLF·LF·CR 이 섞여 오는 파일이 흔하다(윈도우에서 만든 것을 리눅스 도구가 다시 저장한 경우). */
  function unfold(text) {
    var raw = text.split(/\r\n|\n|\r/);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var ln = raw[i];
      var c = ln.charAt(0);
      if ((c === ' ' || c === '\t') && out.length) { out[out.length - 1] += ln.slice(1); continue; }
      if (!ln) continue; // 빈 줄은 규격상 의미가 없다
      out.push(ln);
    }
    return out;
  }

  function stripQuotes(s) {
    var t = String(s).trim();
    if (t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') t = t.slice(1, -1);
    return t;
  }

  /** 따옴표 밖의 구분자로만 자른다(파라미터 값에 ';' ':' 가 들어 있을 수 있다). */
  function splitUnquoted(s, sep) {
    var out = [];
    var inQ = false;
    var last = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '"') inQ = !inQ;
      else if (c === sep && !inQ) { out.push(s.slice(last, i)); last = i + 1; }
    }
    out.push(s.slice(last));
    return out;
  }

  /** 'NAME;PARAM=V:value' → { name, params, value }. ':' 가 없으면 내용 줄이 아니다. */
  function parseContentLine(line) {
    var inQ = false;
    var colon = -1;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '"') inQ = !inQ;
      else if (c === ':' && !inQ) { colon = i; break; }
    }
    if (colon < 0) return null;
    var parts = splitUnquoted(line.slice(0, colon), ';');
    var params = {};
    for (var k = 1; k < parts.length; k++) {
      var eq = parts[k].indexOf('=');
      if (eq < 0) { params[parts[k].toUpperCase().trim()] = ''; continue; }
      params[parts[k].slice(0, eq).toUpperCase().trim()] = stripQuotes(parts[k].slice(eq + 1));
    }
    return { name: parts[0].toUpperCase().trim(), params: params, value: line.slice(colon + 1) };
  }

  /** TEXT 값의 이스케이프를 푼다: \n·\N → 줄바꿈, \, \; \\ → 그 글자. */
  function unescapeText(s) {
    var str = String(s == null ? '' : s);
    if (str.indexOf('\\') < 0) return str;
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (c !== '\\') { out += c; continue; }
      var n = str.charAt(++i);
      if (n === 'n' || n === 'N') out += '\n';
      else if (n === '') break;   // 끝에 홀로 남은 백슬래시
      else out += n;              // \, \; \\ 그리고 규격에 없는 이스케이프도 글자 그대로
    }
    return out;
  }

  /** 무엇이 왔는지 warnings 에 보여 주기 위한 앞부분 발췌. */
  function head(text) {
    var s = String(text).replace(/\s+/g, ' ').trim();
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  // ───────────────────────── 시각 ─────────────────────────

  /* app/main/util.js 의 toRfc3339 와 같은 모양을 낸다(2026-08-20T14:00:00+09:00).
   * shared 는 main 을 require 할 수 없어(층이 반대다) 같은 규칙을 여기 한 번 더 적는다 —
   * 모양이 갈라지면 원장에 두 가지 표기가 섞이므로 test/ics.test.js 가 util.toRfc3339 와
   * 직접 대조해 그 갈라짐을 잡는다. */
  function toRfc3339Local(d) {
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var abs = Math.abs(off);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
      + sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }

  function dateOnly(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 로컬 벽시계 compact 표기 — app/main/util.js 의 instKey, recurrence.addExdate 와 같은 모양. */
  function stampLocal(d) {
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + 'T' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function compactDate(d) {
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  var DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

  /* 값 하나를 읽는다. 세 형태:
   *   VALUE=DATE 또는 시각 없음 → 종일(date)
   *   ...Z                      → UTC. 순간이 확정돼 있으니 로컬 시각으로 정확히 옮긴다
   *   그 밖(TZID 또는 floating)  → 벽시계 숫자를 로컬로 읽는다(머리주석의 근거 참고) */
  function parseValue(value, params) {
    var m = DATE_RE.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], da = +m[3];
    var isDate = !m[4] || (params && (params.VALUE || '').toUpperCase() === 'DATE');
    if (isDate) {
      var d0 = new Date(y, mo - 1, da);
      if (isNaN(d0.getTime())) return null;
      return { kind: 'date', at: d0, tzid: null };
    }
    var h = +m[4], mi = +m[5], se = +m[6];
    var at = m[7] ? new Date(Date.UTC(y, mo - 1, da, h, mi, se)) : new Date(y, mo - 1, da, h, mi, se);
    if (isNaN(at.getTime())) return null;
    return { kind: 'dateTime', at: at, tzid: m[7] ? null : ((params && params.TZID) || null) };
  }

  /** 내용 줄 하나를 시각으로. TZID 를 만나면 어디서 몇 번 나왔는지 세어 둔다. */
  function parseLineValue(line, ctx, where) {
    var v = parseValue(line.value, line.params);
    if (v && v.tzid) noteTzid(ctx, v.tzid, where);
    return v;
  }

  function noteTzid(ctx, tzid, where) {
    if (!has(ctx.tz, tzid)) { ctx.tz[tzid] = { n: 0, where: where }; ctx.tzOrder.push(tzid); }
    ctx.tz[tzid].n++;
  }

  // DURATION: P1W / P1D / PT1H30M / PT45S / -PT15M
  var DUR_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

  function parseDurationMs(v) {
    var m = DUR_RE.exec(String(v == null ? '' : v).trim().toUpperCase());
    if (!m) return null;
    if (!m[2] && !m[3] && !m[4] && !m[5] && !m[6]) return null; // 'P' 만 있으면 값이 없다
    var ms = (+(m[2] || 0)) * 7 * DAY_MS + (+(m[3] || 0)) * DAY_MS
      + (+(m[4] || 0)) * 3600000 + (+(m[5] || 0)) * 60000 + (+(m[6] || 0)) * 1000;
    return m[1] === '-' ? -ms : ms;
  }

  // ───────────────────────── id ─────────────────────────

  /* 결정적 축약. crypto 를 쓸 수 없어(의존성 0, 창에서도 로드된다) FNV-1a 32비트를 쓴다.
   * 보안용이 아니라 "같은 UID 는 언제나 같은 id" 를 위한 것이다 — 재동기화 때 같은 일정이
   * 새 id 로 다시 들어와 복제되는 것을 막는 것이 유일한 목적이다. */
  function hash32(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /* UID → 우리 id.
   *   UID 는 남이 짓는 문자열이라 무엇이든 들어온다(이메일 주소, 경로, 한글, 수백 글자).
   *   우리 id 는 키이자 파일명 조각이라 안전한 글자만 남기고 길이를 자른다.
   *   글자를 바꾸거나 자른 경우에는 원본 UID 의 해시를 붙인다 — 그러지 않으면
   *   'a/b' 와 'a-b' 가 같은 id 가 돼 서로 다른 두 일정이 하나로 합쳐진다. */
  function safeId(uid) {
    var raw = String(uid == null ? '' : uid).trim();
    if (!raw) return null;
    var s = raw.replace(ID_UNSAFE, '-').replace(ID_LEADING, '');
    var changed = s !== raw;
    if (s.length > ID_MAX) { s = s.slice(0, ID_MAX - ID_HASH_LEN); changed = true; }
    if (!s || changed || WIN_RESERVED.test(s)) s = (s || 'ics') + '-' + hash32(raw);
    return s;
  }

  function uniqueId(id, ctx, where) {
    if (!has(ctx.usedIds, id)) { ctx.usedIds[id] = 1; return id; }
    var n = ctx.usedIds[id] + 1;
    ctx.usedIds[id] = n;
    var alt = id + '-' + n;
    ctx.usedIds[alt] = 1;
    ctx.warnings.push(where + ': 같은 id(' + id + ')가 이미 있어 ' + alt + ' 로 넣었습니다. '
      + '원본 UID 가 파일 안에서 중복됩니다 — 예외 회차라면 RECURRENCE-ID 가 있어야 합니다.');
    return alt;
  }

  // ───────────────────────── 반복 규칙 ─────────────────────────

  function noSupportTable(ctx) {
    if (ctx.saidNoTable) return;
    ctx.saidNoTable = true;
    ctx.warnings.push('반복 지원 범위표(app/shared/registry.js 의 RRULE_SUPPORT)를 읽지 못해 '
      + '미지원 규칙을 알려 줄 수 없습니다. 규칙 문자열은 그대로 보존했습니다 — '
      + '브라우저에서 쓴다면 registry.js 를 ics.js 보다 먼저 <script> 로 읽으세요.');
  }

  /** 이 줄(RRULE/RDATE/…)을 우리 전개기가 읽는가. 못 읽는 부분은 버리지 말고 알리기만 한다. */
  function checkSupport(line, ctx, where) {
    if (!SUPPORT) { noSupportTable(ctx); return; }
    var fix = ' 규칙은 recurrence 에 그대로 보존했습니다(왕복에서 잃지 않습니다). '
      + '전개까지 되게 하려면 app/main/recurrence.js 를 늘리고 app/shared/registry.js 의 RRULE_SUPPORT 에 등록하세요.';
    if (SUPPORT.lines.indexOf(line.name) < 0) {
      ctx.warnings.push(where + ': ' + line.name + ' 은 우리 전개기가 읽지 않습니다 — 그만큼 회차가 덜/더 나옵니다.' + fix);
      return;
    }
    if (line.name !== 'RRULE') return;
    var bad = [];
    var parts = String(line.value).split(';');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      var k = (eq < 0 ? parts[i] : parts[i].slice(0, eq)).toUpperCase().trim();
      if (!k) continue;
      if (k === 'FREQ') {
        var f = (eq < 0 ? '' : parts[i].slice(eq + 1)).toUpperCase().trim();
        if (SUPPORT.freqs.indexOf(f) < 0) bad.push('FREQ=' + f);
      } else if (SUPPORT.fields.indexOf(k) < 0) {
        bad.push(k);
      }
    }
    if (bad.length) {
      ctx.warnings.push(where + ': 우리 전개기가 무시하는 RRULE 부분 — ' + bad.join(', ') + '.' + fix);
    }
  }

  /* recurrence 배열에 넣을 문자열을 만든다.
   *   RRULE/EXRULE — 파라미터는 규격에 없으므로 'NAME:값' 으로 정규화한다.
   *                  (recurrence.parseRrule 이 line.slice(6) 으로 값을 꺼내므로
   *                   'RRULE;X=1:FREQ=…' 같은 줄이 오면 규칙을 통째로 못 읽는다.)
   *   EXDATE/RDATE  — 시각을 로컬 벽시계 표기로 옮긴다. UTC 그대로 두면 우리 전개기가
   *                  날짜만 잘라 쓰기 때문에(recurrence.parseExdates) 자정을 넘는 시간대에서
   *                  엉뚱한 날을 제외한다. DTSTART 를 로컬로 옮겼으니 제외 날짜도 같은 시계로 옮긴다. */
  function recurrenceLine(line, ctx, where) {
    var value = String(line.value == null ? '' : line.value).trim();
    if (!value) return null;
    if (line.name === 'RRULE' || line.name === 'EXRULE') return line.name + ':' + value;

    var toks = value.split(',');
    var outToks = [];
    var anyDate = false;
    var kept = false;
    for (var i = 0; i < toks.length; i++) {
      var v = parseValue(toks[i].trim(), line.params);
      if (!v) { outToks.push(toks[i].trim()); kept = true; continue; }
      if (v.tzid) noteTzid(ctx, v.tzid, where);
      if (v.kind === 'date') { anyDate = true; outToks.push(compactDate(v.at)); }
      else outToks.push(stampLocal(v.at));
    }
    if (kept) {
      ctx.warnings.push(where + ': ' + line.name + ' 에 읽지 못한 값이 있어 원문 그대로 두었습니다 — ' + value);
    }
    return line.name + (anyDate ? ';VALUE=DATE' : '') + ':' + outToks.join(',');
  }

  // ───────────────────────── VEVENT → 우리 이벤트 ─────────────────────────

  function first(props, name) {
    for (var i = 0; i < props.length; i++) if (props[i].name === name) return props[i];
    return null;
  }

  function textOf(line) { return line ? String(line.value == null ? '' : line.value) : ''; }

  function stampOf(line) {
    var v = line ? parseValue(line.value, line.params) : null;
    return v ? toRfc3339Local(v.at) : null;
  }

  function buildEvent(block, ctx) {
    var props = block.props;
    var uidRaw = textOf(first(props, 'UID')).trim();
    var summary = unescapeText(textOf(first(props, 'SUMMARY'))).trim();
    var where = 'VEVENT ' + (uidRaw ? 'UID=' + uidRaw : '#' + block.index)
      + (summary ? ' "' + summary + '"' : '');

    // ---- 시작 ----
    var dtstart = first(props, 'DTSTART');
    if (!dtstart) {
      ctx.warnings.push(where + ': DTSTART 가 없어 건너뜁니다 (start 없는 이벤트는 우리 계약을 못 지킵니다).');
      return null;
    }
    var st = parseLineValue(dtstart, ctx, where);
    if (!st) {
      ctx.warnings.push(where + ': DTSTART 값을 읽지 못해 건너뜁니다 — ' + textOf(dtstart));
      return null;
    }

    // ---- 끝 (DTEND 는 exclusive. 우리 앱도 exclusive 라 그대로 둔다) ----
    var en = null;
    var dtend = first(props, 'DTEND');
    var dur = first(props, 'DURATION');
    if (dtend) {
      en = parseLineValue(dtend, ctx, where);
      if (!en) ctx.warnings.push(where + ': DTEND 값을 읽지 못해 무시합니다 — ' + textOf(dtend));
    } else if (dur) {
      var ms = parseDurationMs(textOf(dur));
      if (ms === null) ctx.warnings.push(where + ': DURATION 을 읽지 못해 무시합니다 — ' + textOf(dur));
      else en = { kind: st.kind, at: new Date(st.at.getTime() + ms), tzid: null };
    }
    if (en && en.kind !== st.kind) {
      // 한쪽만 종일인 이벤트. start 의 종류를 따른다 — 섞이면 model.isAllDay 와 end 해석이 어긋난다.
      ctx.warnings.push(where + ': DTSTART 와 DTEND 의 종류가 다릅니다(종일 ↔ 시각). DTSTART 쪽으로 맞췄습니다.');
      en = { kind: st.kind, at: en.at, tzid: null };
    }
    if (en && en.at.getTime() <= st.at.getTime()) {
      ctx.warnings.push(where + ': 끝이 시작보다 앞서거나 같아 무시합니다 (' + textOf(dtend || dur) + ').');
      en = null;
    }
    // 종일은 end 가 반드시 있어야 한다 — 없으면 하루짜리(exclusive 다음 날).
    // 시각 일정에 end 가 없으면 넣지 않는다: 기본 길이는 app/main/model.js 의 getEnd 가 소유한다
    // (여기서 한 번 더 정하면 기본값이 두 곳이 되고 조용히 갈라진다).
    if (!en && st.kind === 'date') en = { kind: 'date', at: new Date(st.at.getTime() + DAY_MS), tzid: null };

    // ---- id · 예외 회차 ----
    var baseId = safeId(uidRaw);
    if (!baseId) {
      // UID 없는 VEVENT. 다시 받아도 같은 id 가 나오도록 내용에서 만든다 —
      // 무작위 id 면 동기화할 때마다 같은 일정이 새 항목으로 쌓인다.
      baseId = 'ics-' + hash32(summary + '|' + textOf(dtstart) + '|' + textOf(dtend));
      ctx.warnings.push(where + ': UID 가 없어 내용으로 id 를 만들었습니다 (' + baseId + ').');
    }
    var id = baseId;
    var recurringEventId = null;
    var originalStartTime = null;
    var rid = first(props, 'RECURRENCE-ID');
    if (rid) {
      var ro = parseLineValue(rid, ctx, where);
      if (!ro) {
        ctx.warnings.push(where + ': RECURRENCE-ID 를 읽지 못해 예외 회차가 아닌 일정으로 넣습니다 — ' + textOf(rid));
      } else {
        // 예외 회차는 마스터와 같은 UID 를 갖는다. id 는 회차별로 따로 만들고(구글의
        // '<마스터>_<회차>' 관례) recurringEventId 로 마스터를 가리킨다 — 그래야 원본이
        // 덮이지 않고, state.js 가 마스터 전개에서 이 회차를 빼도록 짝지을 수 있다.
        recurringEventId = baseId;
        originalStartTime = ro.kind === 'date' ? { date: dateOnly(ro.at) } : { dateTime: toRfc3339Local(ro.at) };
        id = baseId + '_' + (ro.kind === 'date' ? compactDate(ro.at) : stampLocal(ro.at));
        if ((rid.params.RANGE || '').toUpperCase() === 'THISANDFUTURE') {
          ctx.warnings.push(where + ': RECURRENCE-ID;RANGE=THISANDFUTURE 는 이 회차 하나만 바꾸는 것으로 읽었습니다 '
            + '(이후 전체를 바꾸는 규칙은 전개기가 모릅니다).');
        }
      }
    }
    id = uniqueId(id, ctx, where);

    // ---- 반복 ----
    var recurrence = [];
    for (var i = 0; i < props.length; i++) {
      if (RECUR_PROPS.indexOf(props[i].name) < 0) continue;
      var text = recurrenceLine(props[i], ctx, where);
      if (!text) continue;
      recurrence.push(text);
      checkSupport(props[i], ctx, where);
    }

    // ---- 상태 ----
    var statusRaw = textOf(first(props, 'STATUS')).toUpperCase().trim();
    var status = DEFAULT_STATUS;
    if (statusRaw) {
      if (has(STATUS_MAP, statusRaw)) status = STATUS_MAP[statusRaw];
      else ctx.warnings.push(where + ': 모르는 STATUS(' + statusRaw + ') — ' + DEFAULT_STATUS + ' 로 읽었습니다.');
    }

    // ---- 조립 (extendedProperties 는 만들지 않는다 — 머리주석 참고) ----
    var ev = { kind: 'calendar#event', id: id, status: status, summary: summary };
    var desc = unescapeText(textOf(first(props, 'DESCRIPTION')));
    if (desc) ev.description = desc;
    var loc = unescapeText(textOf(first(props, 'LOCATION'))).trim();
    if (loc) ev.location = loc;
    ev.start = st.kind === 'date' ? { date: dateOnly(st.at) } : { dateTime: toRfc3339Local(st.at) };
    if (en) ev.end = en.kind === 'date' ? { date: dateOnly(en.at) } : { dateTime: toRfc3339Local(en.at) };
    if (recurrence.length) ev.recurrence = recurrence;
    if (recurringEventId) {
      ev.recurringEventId = recurringEventId;
      ev.originalStartTime = originalStartTime;
      ctx.exceptions.push({ id: id, master: recurringEventId, where: where });
    } else {
      ctx.masters[baseId] = true;
    }
    var updated = stampOf(first(props, 'LAST-MODIFIED')) || stampOf(first(props, 'DTSTAMP'));
    if (updated) ev.updated = updated;
    var created = stampOf(first(props, 'CREATED'));
    if (created) ev.created = created;
    return ev;
  }

  // ───────────────────────── parse ─────────────────────────

  /**
   * .ics 텍스트를 우리 이벤트로 옮긴다.
   * @param {string} icsText  RFC 5545 본문
   * @param {object} [opts]   { maxEvents: 한 번에 받을 최대 개수(기본 5000) }
   * @returns {{events: Array, warnings: Array<string>, calendarName: (string|null)}}
   */
  function parse(icsText, opts) {
    opts = opts || {};
    var maxEvents = typeof opts.maxEvents === 'number' && opts.maxEvents > 0 ? opts.maxEvents : DEFAULT_MAX_EVENTS;
    // id·UID·TZID 는 남이 지은 문자열이 그대로 키가 된다. 보통 객체에 담으면 '__proto__' 같은
    // 이름이 대입을 조용히 삼켜 중복 검사와 마스터 짝짓기가 어긋난다 — 프로토타입 없는 표를 쓴다.
    var ctx = {
      warnings: [], tz: bare(), tzOrder: [], usedIds: bare(), masters: bare(),
      exceptions: [], saidNoTable: false
    };
    var out = { events: [], warnings: ctx.warnings, calendarName: null };

    var text = typeof icsText === 'string' ? icsText : '';
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM (윈도우에서 만든 파일에 흔하다)
    if (!text.replace(/\s+/g, '')) {
      ctx.warnings.push('빈 입력입니다 — .ics 본문이 오지 않았습니다.');
      return out;
    }
    if (!/BEGIN[ \t]*:[ \t]*VCALENDAR/i.test(text)) {
      // 구독 주소가 로그인·오류 페이지로 넘어가 HTML 이 200 으로 오는 일이 흔하다.
      // 던지지 말고 무엇이 왔는지 남긴다 — 그래야 사용자가 주소를 고칠 수 있다.
      ctx.warnings.push('BEGIN:VCALENDAR 가 없습니다 — .ics 가 아닌 것 같습니다 (앞부분: ' + head(text) + ').');
    }

    var lines = unfold(text);
    var stack = [];   // 컴포넌트 중첩 (VCALENDAR > VEVENT > VALARM …)
    var cur = null;   // 지금 모으는 VEVENT
    var nth = 0;
    var truncated = false;

    for (var i = 0; i < lines.length; i++) {
      var cl = parseContentLine(lines[i]);
      if (!cl) continue; // ':' 없는 줄은 내용 줄이 아니다(잘린 파일·잡음)

      if (cl.name === 'BEGIN') {
        var comp = cl.value.toUpperCase().trim();
        stack.push(comp);
        if (comp === 'VEVENT' && !cur) cur = { props: [], index: ++nth };
        continue;
      }

      if (cl.name === 'END') {
        var endComp = cl.value.toUpperCase().trim();
        if (endComp === 'VEVENT') {
          if (cur) {
            if (out.events.length >= maxEvents) { truncated = true; cur = null; break; }
            var ev = null;
            try {
              ev = buildEvent(cur, ctx);
            } catch (e) {
              ctx.warnings.push('VEVENT #' + cur.index + ': 파싱하지 못해 건너뜁니다 — '
                + (e && e.message ? e.message : String(e)));
            }
            if (ev) out.events.push(ev);
            cur = null;
          }
        }
        // 짝이 안 맞는 END 도 흘려보낸다(가장 가까운 같은 이름까지 되감는다).
        for (var s = stack.length - 1; s >= 0; s--) {
          if (stack[s] === endComp) { stack.length = s; break; }
        }
        continue;
      }

      var top = stack.length ? stack[stack.length - 1] : '';
      if (top === 'VEVENT' && cur) {
        cur.props.push(cl);
      } else if (!stack.length || top === 'VCALENDAR') {
        // 캘린더 이름. X-WR-CALNAME 이 사실상의 표준이고, RFC 7986 의 NAME 은 그 다음이다.
        if (cl.name === 'X-WR-CALNAME') out.calendarName = unescapeText(cl.value).trim() || out.calendarName;
        else if (cl.name === 'NAME' && !out.calendarName) out.calendarName = unescapeText(cl.value).trim() || null;
      }
      // 그 밖(VTIMEZONE·VALARM·VTODO·VJOURNAL 안)은 버린다. 특히 VEVENT 안에 중첩된 VALARM 의
      // DESCRIPTION·TRIGGER 를 이벤트 속성으로 읽으면 알림 문구가 일정 설명을 덮어쓴다.
    }

    if (cur) {
      ctx.warnings.push('VEVENT #' + cur.index + ': END:VEVENT 없이 파일이 끝나 건너뜁니다 (잘린 응답일 수 있습니다).');
    }
    if (truncated) {
      ctx.warnings.push('이벤트가 ' + maxEvents + '개를 넘어 나머지를 읽지 않았습니다 (parse 의 opts.maxEvents).');
    }

    // 마스터 없는 예외 회차 — 이 피드만으로는 어느 반복의 몇 번째인지 짝지을 수 없다.
    for (var x = 0; x < ctx.exceptions.length; x++) {
      if (!has(ctx.masters, ctx.exceptions[x].master)) {
        ctx.warnings.push(ctx.exceptions[x].where + ': 예외 회차인데 같은 UID 의 반복 일정이 이 파일에 없습니다 '
          + '(recurringEventId=' + ctx.exceptions[x].master + '). 기간을 잘라 받은 구독이면 마스터가 범위 밖일 수 있습니다.');
      }
    }

    // TZID 는 건마다 알리면 수백 줄이 된다 — 시간대별로 한 줄씩 모아서 알린다.
    for (var t = 0; t < ctx.tzOrder.length; t++) {
      var tz = ctx.tzOrder[t];
      ctx.warnings.push('TZID=' + tz + ' 인 시각 ' + ctx.tz[tz].n + '건을 이 PC 의 로컬 시각으로 읽었습니다 '
        + '(예: ' + ctx.tz[tz].where + '). IANA 시간대 변환기가 없어 벽시계 숫자를 그대로 씁니다 — '
        + '다른 시간대의 피드라면 실제 시각과 어긋납니다.');
    }

    return out;
  }

  return {
    parse: parse,
    // 아래는 시험·재사용용으로 열어 둔다(파서 안에서만 쓰는 순수 함수들).
    unfold: unfold,
    unescapeText: unescapeText,
    parseContentLine: parseContentLine,
    parseDurationMs: parseDurationMs,
    safeId: safeId,
    toRfc3339Local: toRfc3339Local
  };
});
