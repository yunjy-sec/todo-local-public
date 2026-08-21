/* 문법 검사 — 파일 트리에서 파생한다.
 *
 * 왜 있는가
 *   전에는 package.json 에 파일 이름을 손으로 나열했다. 그래서 app/main/sync/ 두 파일이
 *   목록에 없었고, manager.js 는 동기화를 켠 사용자만 로드하는 지연 require 라
 *   문법 오류를 넣어도 check·lint·test 가 전부 초록이었다. 처음 그 기능을 켜는 사람이
 *   트레이도 창도 없이 앱이 안 뜨는 것으로 그 사실을 알게 된다.
 *   목록을 트리에서 만들면 새 파일이 기본으로 포함되고, 그 구멍이 다시 열리지 않는다.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { collect, APP_DIR, rel, report } from './_load.mjs';

const files = [
  ...collect(join(APP_DIR, 'main'), ['.js']),
  ...collect(join(APP_DIR, 'shared'), ['.js']),
  ...collect(join(APP_DIR, 'test'), ['.js']),
  ...collect(join(APP_DIR, 'scripts'), ['.mjs']),
  join(APP_DIR, 'preload.js'),
  join(APP_DIR, '..', 'tools', 'sync-server.mjs'),
].filter(f => existsSync(f));

const problems = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || '').split('\n').slice(0, 3).join(' ').trim();
    problems.push(`${rel(f)} — ${msg}`);
  }
}

process.exit(report('check', problems, `${files.length}개 파일 문법 이상 없음 (트리에서 파생)`));
