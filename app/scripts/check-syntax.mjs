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
  // tools/ 도 트리에서 파생한다. 전에는 sync-server.mjs 하나만 손으로 적었고,
  // 그래서 tools/cut/assets/audit.mjs 가 깨진 채(문자열 리터럴 안에 진짜 줄바꿈)
  // 커밋되어 생성물 트리로 그대로 실려 나갔다 — 생성된 쪽에서야 발견됐다.
  ...collect(join(APP_DIR, '..', 'tools'), ['.mjs', '.js', '.cjs']),
  join(APP_DIR, 'preload.js'),
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
