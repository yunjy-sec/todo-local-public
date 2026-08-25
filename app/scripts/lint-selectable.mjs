/* 화면 글자는 드래그해서 복사할 수 있어야 한다 (C# 빌드).
 *
 * 막는 사고 (둘 다 실제로 났다)
 *
 *   1) Label 은 글자를 선택할 수 없다.
 *      알림에 뜬 일정 제목이나 시각을 다른 곳에 옮기려면 손으로 다시 타이핑해야 했다.
 *      그래서 화면에 값을 보여 주는 자리는 전부 SelectableText.Make(...) 로 만든
 *      읽기 전용 TextBox 다. 누가 편하다고 Label 로 되돌리면 여기서 걸린다.
 *
 *   2) TextBox 는 Label 과 달리 자기 BackColor 를 들고 있다.
 *      배경을 Color.White 로 손수 적었더니 회색 막대 위에서 흰 상자로 떠 보였고,
 *      알림이 노랗게 깜빡일 때는 글자 자리만 하얗게 남았다(캡처로 확인).
 *      그래서 배경 인자는 반드시 부모/폼의 BackColor 에서 가져온다.
 *
 * 고칠 자리
 *   src/Models.cs 의 SelectableText.Make(font, fore, back, multiline)
 *   src/PopupForm.cs, src/MainForm.cs 의 아래 FIELDS 목록
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR, report } from './_load.mjs';

const SRC = join(ROOT_DIR, 'src');

// [파일, 필드명] — 화면에 값을 보여 주는 자리. 전부 선택 가능해야 한다.
const FIELDS = [
  ['PopupForm.cs', '_lblTitle'],
  ['PopupForm.cs', '_lblInfo'],
  ['PopupForm.cs', '_lblNote'],
  ['MainForm.cs', '_lblPreview'],
  ['MainForm.cs', '_lblStats'],
];

const problems = [];
const read = (f) => readFileSync(join(SRC, f), 'utf8');

// ── 1) 헬퍼가 살아 있고 읽기 전용·테두리 없음을 유지하는가 ──────────────
{
  const models = read('Models.cs');
  if (!/public\s+static\s+class\s+SelectableText/.test(models)) {
    problems.push('src/Models.cs: SelectableText 클래스가 없다 — 여기가 정본이다');
  }
  for (const [prop, want] of [
    ['ReadOnly', 'true'],
    ['BorderStyle', 'BorderStyle.None'],
    ['TabStop', 'false'],
  ]) {
    const re = new RegExp(`t\\.${prop}\\s*=\\s*${want.replace('.', '\\.')}\\s*;`);
    if (!re.test(models)) {
      problems.push(
        `src/Models.cs: SelectableText.Make 가 ${prop} = ${want} 를 놓쳤다` +
          (prop === 'ReadOnly'
            ? ' — 사용자가 알림 내용을 고칠 수 있게 된다'
            : prop === 'BorderStyle'
              ? ' — 글자 자리에 입력칸 테두리가 보인다'
              : ' — Tab 이 버튼 대신 글자에 걸린다'),
      );
    }
  }
}

// ── 2) 각 자리가 TextBox 로 선언되고 Make() 로 만들어졌는가 ─────────────
for (const [file, field] of FIELDS) {
  const src = read(file);

  if (!new RegExp(`private\\s+TextBox\\s+${field}\\s*;`).test(src)) {
    problems.push(
      `src/${file}: ${field} 가 TextBox 선언이 아니다 — Label 은 드래그 선택이 안 된다`,
    );
    continue;
  }

  const m = src.match(new RegExp(`${field}\\s*=\\s*SelectableText\\.Make\\(([^;]*)\\);`));
  if (!m) {
    problems.push(`src/${file}: ${field} 를 SelectableText.Make(...) 로 만들지 않았다`);
    continue;
  }

  // 인자 넷 중 셋째가 배경. 괄호 안 쉼표(new Font(...)) 때문에 깊이를 센다.
  const args = splitArgs(m[1]);
  const back = (args[2] || '').trim();
  if (!/BackColor/.test(back)) {
    problems.push(
      `src/${file}: ${field} 배경이 ${back || '(없음)'} 이다 — 부모의 BackColor 에서 가져와야 한다` +
        ' (색을 손으로 적으면 배경이 바뀔 때 그 자리만 상자로 남는다)',
    );
  }
}

// ── 3) 팝업이 깜빡일 때 글자 자리도 함께 물드는가 ───────────────────────
{
  const popup = read('PopupForm.cs');
  if (!/private\s+void\s+ApplyBackground\s*\(/.test(popup)) {
    problems.push(
      'src/PopupForm.cs: ApplyBackground(body, header) 가 없다' +
        ' — 창만 물들이면 글자 자리만 흰 상자로 남는다',
    );
  } else {
    for (const [, field] of FIELDS.filter(([f]) => f === 'PopupForm.cs')) {
      if (!new RegExp(`${field}\\.BackColor\\s*=`).test(popup)) {
        problems.push(`src/PopupForm.cs: ApplyBackground 가 ${field} 를 빠뜨렸다`);
      }
    }
    // 효과가 헬퍼를 우회해 BackColor 를 직접 만지면 다시 흰 상자가 생긴다.
    for (const fn of ['TickEffect', 'StopEffect']) {
      const body = blockOf(popup, fn);
      if (body && /(^|[^.\w])BackColor\s*=/.test(body)) {
        problems.push(
          `src/PopupForm.cs: ${fn} 이 BackColor 를 직접 바꾼다 — ApplyBackground 를 쓸 것`,
        );
      }
    }
  }
}

function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function blockOf(src, name) {
  const at = src.search(new RegExp(`\\bvoid\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i);
  }
  return null;
}

process.exit(report(
  'lint:selectable',
  problems,
  `${FIELDS.length}개 글자 자리가 선택·복사 가능하고 배경을 부모의 BackColor 에서 가져온다`,
));
