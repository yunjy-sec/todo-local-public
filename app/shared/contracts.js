'use strict';

/* 계약(contract) — 이 파일이 소유하는 것
 *   상태·액션·주기 enum, IPC 채널의 모양 규약, 원격 동기화 API 경로,
 *   그리고 그것들을 런타임에 확인하는 validate*() 함수.
 *
 * 여기 적으면 안 되는 것
 *   구체적인 등록 항목(채널 목록, 설정 필드 목록 등). 그것은 registry.js 의 일이다.
 *   등록표가 계약까지 소유하면 계약을 쓰는 쪽이 등록표를 읽어야 해서 소유권이 순환한다.
 *
 * JS 라 타입 검사기가 없으므로 계약은 validate*() 가 런타임에 확인하고,
 * registry.verify() 가 부팅 시 그 결과를 모아 보고한다.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TD_CONTRACTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ---- 닫힌 어휘 ----

  // 항목의 앱 상태. GCal event.status(confirmed/cancelled)와 별개로
  // extendedProperties.private.todoStatus 에 저장된다.
  var TODO_STATUS = ['pending', 'done', 'cancelled'];

  // 팝업 버튼이 낼 수 있는 결과.
  var POPUP_ACTION_KEYS = ['ack', 'snooze', 'done', 'cancel'];

  // 팝업 종류: 정시 알림과 N분 전 미리 알림.
  var POPUP_KINDS = ['due', 'pre'];

  // 반복 수정/삭제의 적용 범위.
  var SCOPES = ['single', 'all'];

  // recurrence.js 가 전개할 수 있는 FREQ.
  var RECUR_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

  // 팝업 위치 프리셋.
  var POPUP_POSITIONS = ['bottom-center', 'bottom-left', 'bottom-right', 'center', 'top-center'];

  // 캘린더 권한(GCal accessRole 준용). writer 이상이어야 생성 대상이 된다.
  var ACCESS_ROLES = ['owner', 'writer', 'reader', 'freeBusyReader'];

  // 캘린더 서비스 유형. local 은 항상 있고, ics 는 디스크의 .ics 파일을 읽는
  // 읽기 전용 구독이다. 원격 어댑터는 이 빌드에 없다.
  var SERVICE_TYPES = ['local', 'ics'];




  // 구독 원본의 종류. url 은 네트워크, file 은 로컬 .ics (폐쇄망에서도 쓸 수 있다).
  var SUBSCRIPTION_SOURCES = ['file'];

  // IPC 채널의 종류. invoke 는 renderer→main 요청/응답, event 는 main→renderer 단방향.
  var IPC_KINDS = ['invoke', 'event'];

  // 설정 필드 타입.
  var SETTING_TYPES = ['bool', 'int', 'ratio', 'enum', 'string', 'intlist'];

  // 시각 표기. 기본은 24시간(00:00 - 23:59), 12h 는 오전/오후.
  var TIME_FORMATS = ['24h', '12h'];


  // 기기 로컬 상태 — 원장에 같이 담기지만 기기마다 달라야 하는 값들.
  //   snoozeUntil     이 기기에서 "10분 뒤"를 누른 것이지 다른 기기의 사정이 아니다.
  //   notifyCount     이 기기가 몇 번 띄웠는지.
  //   firedReminders  이 기기가 미리 알림을 이미 보여 줬는지.
  // 이것들이 동기화로 오가면 (1) 다른 기기에서 미리 알림이 아예 안 뜨고
  // (2) 알림을 확인만 해도 updated 가 올라가 남의 실제 수정을 LWW 로 되돌린다.
  // 그래서 병합에서 원격 값을 받지 않고, 이 값만 바뀔 때는 updated 도 올리지 않는다.
  //   googlePushedAt  이 기기가 구글에 마지막으로 넘긴 판본(updated 값)이다.
  //     반드시 기기 전용이어야 한다 — 이 값이 updated 를 올리는 순간, 올려 보낸 사실을
  //     적는 것만으로 "또 바뀌었다"가 되어 같은 항목을 영원히 다시 올린다.
  var DEVICE_LOCAL_PRIVATE = ['snoozeUntil', 'notifyCount', 'firedReminders'];




  // ---- validate ----

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function validateIpcChannel(row) {
    var errs = [];
    if (!row || !row.key) return ['ipc: key 없는 행이 있습니다'];
    if (!/^[a-z][a-z0-9-]*$/.test(row.key)) errs.push('ipc ' + row.key + ': key 는 소문자-하이픈만 (채널명이 곧 계약이라 바꾸면 renderer 가 깨진다)');
    if (IPC_KINDS.indexOf(row.kind) < 0) errs.push('ipc ' + row.key + ': kind 는 ' + IPC_KINDS.join('|') + ' 중 하나여야 합니다');
    if (!row.desc) errs.push('ipc ' + row.key + ': desc 가 필요합니다 (무엇을 하는 채널인지)');
    return errs;
  }

  function validateSettingField(row) {
    var errs = [];
    if (!row || !row.key) return ['settings: key 없는 행이 있습니다'];
    if (SETTING_TYPES.indexOf(row.type) < 0) {
      errs.push('settings ' + row.key + ': type 은 ' + SETTING_TYPES.join('|') + ' 중 하나여야 합니다');
    }
    if (row.def === undefined) errs.push('settings ' + row.key + ': def(기본값) 이 필요합니다');
    if (row.type === 'int' || row.type === 'ratio') {
      if (typeof row.min !== 'number' || typeof row.max !== 'number') {
        errs.push('settings ' + row.key + ': ' + row.type + ' 는 min/max 가 필요합니다 (clamp 가 여기서 파생된다)');
      } else if (typeof row.def === 'number' && (row.def < row.min || row.def > row.max)) {
        errs.push('settings ' + row.key + ': def 가 min~max 밖입니다');
      }
    }
    if (row.type === 'enum' && !(Array.isArray(row.values) && row.values.length)) {
      errs.push('settings ' + row.key + ': enum 은 values 배열이 필요합니다');
    }
    return errs;
  }

  function validatePrivateField(row) {
    var errs = [];
    if (!row || !row.key) return ['private: key 없는 행이 있습니다'];
    // GCal extendedProperties.private 은 문자열 값만 받는다. 숫자·객체를 넣으면
    // 원격 왕복에서 조용히 문자열로 바뀌거나 거부된다.
    if (!row.desc) errs.push('private ' + row.key + ': desc 가 필요합니다');
    return errs;
  }

  function validateEvent(ev) {
    var errs = [];
    if (!isPlainObject(ev)) return ['event: 객체가 아닙니다'];
    if (!ev.id) errs.push('event: id 가 없습니다');
    if (!ev.start || (!ev.start.dateTime && !ev.start.date)) {
      errs.push('event ' + (ev.id || '?') + ': start.dateTime 또는 start.date 가 필요합니다');
    }
    if (ev.status && ev.status !== 'confirmed' && ev.status !== 'cancelled' && ev.status !== 'tentative') {
      errs.push('event ' + ev.id + ': status 는 GCal 어휘(confirmed|tentative|cancelled)여야 합니다');
    }
    var p = ev.extendedProperties && ev.extendedProperties.private;
    if (p) {
      for (var k in p) {
        if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
        if (p[k] !== null && p[k] !== undefined && typeof p[k] !== 'string') {
          errs.push('event ' + ev.id + ': private.' + k + ' 가 문자열이 아닙니다 (GCal 은 문자열만 받는다)');
        }
      }
      if (p.todoStatus && TODO_STATUS.indexOf(p.todoStatus) < 0) {
        errs.push('event ' + ev.id + ': private.todoStatus 가 ' + TODO_STATUS.join('|') + ' 밖입니다');
      }
    }
    return errs;
  }

  function validateCalendar(cal) {
    var errs = [];
    if (!isPlainObject(cal)) return ['calendar: 객체가 아닙니다'];
    if (!cal.id) errs.push('calendar: id 가 없습니다');
    if (!cal.summary) errs.push('calendar ' + (cal.id || '?') + ': summary 가 필요합니다');
    if (cal.source) {
      // 구독 캘린더는 읽기 전용이어야 한다. writer 로 두면 편집·생성 대상이 되고,
      // 사용자가 고친 것이 다음 갱신에서 통째로 사라진다.
      if (SUBSCRIPTION_SOURCES.indexOf(cal.source.kind) < 0) {
        errs.push('calendar ' + cal.id + ': source.kind 는 ' + SUBSCRIPTION_SOURCES.join('|') + ' 중 하나여야 합니다');
      }
      if (!cal.source.value) errs.push('calendar ' + cal.id + ': source.value(주소 또는 파일 경로)가 필요합니다');
      if (cal.accessRole !== 'reader') {
        errs.push('calendar ' + cal.id + ': 구독 캘린더는 accessRole 이 reader 여야 합니다(고쳐도 다음 갱신에 덮인다)');
      }
    }
    if (cal.accessRole && ACCESS_ROLES.indexOf(cal.accessRole) < 0) {
      errs.push('calendar ' + cal.id + ': accessRole 은 ' + ACCESS_ROLES.join('|') + ' 중 하나여야 합니다');
    }
    if (cal.backgroundColor && !/^#[0-9a-fA-F]{6}$/.test(cal.backgroundColor)) {
      errs.push('calendar ' + cal.id + ': backgroundColor 는 #rrggbb 형식이어야 합니다');
    }
    return errs;
  }

  return {
    TODO_STATUS: TODO_STATUS,
    POPUP_ACTION_KEYS: POPUP_ACTION_KEYS,
    POPUP_KINDS: POPUP_KINDS,
    SCOPES: SCOPES,
    RECUR_FREQS: RECUR_FREQS,
    POPUP_POSITIONS: POPUP_POSITIONS,
    ACCESS_ROLES: ACCESS_ROLES,
    SERVICE_TYPES: SERVICE_TYPES,
    SUBSCRIPTION_SOURCES: SUBSCRIPTION_SOURCES,
    IPC_KINDS: IPC_KINDS,
    SETTING_TYPES: SETTING_TYPES,
    TIME_FORMATS: TIME_FORMATS,
    DEVICE_LOCAL_PRIVATE: DEVICE_LOCAL_PRIVATE,
    validateIpcChannel: validateIpcChannel,
    validateSettingField: validateSettingField,
    validatePrivateField: validatePrivateField,
    validateEvent: validateEvent,
    validateCalendar: validateCalendar
  };
});
