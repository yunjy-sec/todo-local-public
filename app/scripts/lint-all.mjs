/* 검사 러너.
 *
 * 왜 있는가
 *   검사를 하나씩 손으로 돌리면 결국 안 돌린다. 그리고 새 검사를 추가했는데
 *   여기 안 넣으면 CI 는 그 검사가 있는 줄도 모른다 — 초록불이 거짓말을 한다.
 *   그래서 CHECKS 가 정본이고, lint-registry 가 이 목록을 package.json 및
 *   registry.TESTING.checks 와 대조한다(4자리 자기등록의 두 번째 자리).
 *
 * 이 파일은 _load.mjs 조차 import 하지 않는다 — 다른 스크립트가 깨져도
 * 러너만은 살아서 무엇이 실패했는지 보고해야 한다.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const APP = join(SCRIPTS, '..');

// [npm 이름, 파일, 왜 있는가]
const CHECKS = [
  ['lint:registry', 'lint-registry.mjs', '등록이 계약을 지키고 export 목록이 그대로인가'],
  ['lint:ipc', 'lint-ipc.mjs', '채널 등록·main 핸들러·renderer 호출이 1:1 인가'],
  ['lint:settings', 'lint-settings.mjs', '설정 필드가 등록·기본값·설정 화면에서 갈라지지 않았는가'],
  ['lint:private-fields', 'lint-private-fields.mjs', '미등록 private 키를 쓰지 않는가 (구글 왕복 호환)'],
  ['lint:network', 'lint-network.mjs', '동기화 모듈 밖에서 네트워크를 쓰지 않는가 (폐쇄망 불변식)'],
  ['lint:fs-gateway', 'lint-fs-gateway.mjs', 'storage.js 밖에서 파일을 직접 만지지 않는가 (파일 IO 유일 관문)'],
  ['lint:boundary', 'lint-boundary.mjs', 'main/renderer 경계와 preload 관문을 지키는가'],
  ['lint:hardcoding', 'lint-hardcoding.mjs', '채널명·파일명·설정키가 등록표 밖에 박혀 있지 않은가'],
  ['lint:csharp5', 'lint-csharp5.mjs', 'C# 소스가 내장 컴파일러(C# 5) 문법을 벗어나지 않는가'],
  ['lint:selectable', 'lint-selectable.mjs', '화면 글자가 드래그·복사 가능하고 배경을 부모에서 가져오는가'],
  ['lint:ci', 'lint-ci.mjs', 'CI 필수 단계와 검사 목록이 어긋나지 않았는가'],
  ['lint:docs', 'lint-docs.mjs', '문서가 코드에 없는 명령·심볼을 말하지 않는가'],
];

let failed = 0;
for (const [name, file] of CHECKS) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, file)], {
    cwd: APP,
    stdio: 'inherit',
  });
  if (r.status !== 0) failed++;
}

if (failed) {
  console.error(`\n  ${failed}/${CHECKS.length} 검사 실패`);
  process.exit(1);
}
console.log(`\n  ${CHECKS.length}개 검사 통과`);

export { CHECKS };
