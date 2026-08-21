'use strict';

/* 구독 원본 하나를 가져온다 — 어디서 가져올지 고르는 자리.
 *
 * 이 파일에는 네트워크가 없다. 디스크의 .ics 를 읽는 것은 파일 IO 이고,
 * 원격 주소에서 받아 오는 것만 네트워크다. 그 둘을 갈라 둔 이유:
 *   통신 제거판(../todo-local)은 ics-fetch-url.js 를 통째로 지우고 이 파일은 남긴다.
 *   폐쇄망에서 USB·공유 폴더로 받은 사내 일정표를 여는 길은 통신이 아니므로 살린다.
 *
 * 그래서 원격 모듈은 **함수 안에서** require 한다. 최상위에서 부르면 파일 구독만 쓰는
 * 폐쇄망 PC 에서도 네트워크 모듈이 메모리에 올라오고, 지웠을 때 이 파일이 못 로드된다.
 *
 * UNC 경로(\\서버\공유\팀일정.ics)는 허용한다. fs 에게는 파일 경로이고, SMB 는 OS 가
 * 처리한다 — 우리 코드가 소켓을 열지 않는다. 감사에서 물어볼 수 있는 자리라
 * docs/AUDIT.md 에 근거를 적어 둔다.
 */

const storage = require('../storage'); // 파일 읽기는 파일 IO 관문이 한다

function readLocalFile(path) {
  return { text: storage.readTextFile(path), etag: null, lastModified: null };
}

/** 구독 하나를 가져온다. 반환: {notModified} 또는 {text, etag, lastModified} */
async function fetchSource(source, opts) {
  if (!source || !source.value) throw new Error('구독 원본이 비어 있습니다');
  if (source.kind === 'file') return readLocalFile(source.value);
  // 원격은 여기서만 부른다 — 통신 제거판에서는 이 모듈이 없고, 그때는 kind 도 'file' 뿐이다.
  const { fetchUrl } = require('./ics-fetch-url.js');
  return fetchUrl(source.value, opts);
}

module.exports = { fetchSource, readLocalFile };
