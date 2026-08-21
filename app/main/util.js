'use strict';

const crypto = require('crypto');

function pad(n) { return String(n).padStart(2, '0'); }

// 로컬 시간대 오프셋을 포함한 RFC3339 문자열 (C# v1과 동일 포맷)
function toRfc3339(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}

function fromRfc3339(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // date-only는 로컬 자정으로 (Date 생성자의 UTC 해석 회피)
    const p = s.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// 반복 인스턴스 키: 로컬 컴팩트 표기 (GCal 인스턴스 id 관례와 유사)
function instKey(d) {
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
    + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function clamp(v, min, max, dflt) {
  if (typeof v !== 'number' || isNaN(v)) return dflt;
  return Math.min(max, Math.max(min, v));
}

module.exports = { toRfc3339, fromRfc3339, instKey, newId, clamp, pad };
