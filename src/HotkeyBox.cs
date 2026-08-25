using System;
using System.Drawing;
using System.Windows.Forms;

namespace TodoPopup
{
    /// <summary>
    /// 단축키를 **눌러서** 정하는 칸. 사용자가 "Control+Alt+N" 이라고 타이핑하게 두지 않는다.
    ///
    /// 왜 직접 만드는가
    ///   .NET Framework 에 있는 것은 System.Windows.Forms.Design.ShortcutKeysEditor 뿐이고
    ///   그것은 디자이너용이라 런타임 폼에 못 쓴다. 그리고 우리가 저장하는 형식은 WinForms 의
    ///   Keys 가 아니라 Electron 판과 공유하는 문자열("Control+Alt+N")이다 — 그 변환까지
    ///   맡을 컨트롤이 필요하다.
    ///
    /// 규칙
    ///   · 수정자 없는 키는 받지 않는다. 전역 단축키라 A 하나에 걸면 그 글자를 못 쓰게 된다.
    ///   · Backspace 는 끄기다(빈 문자열). 끈 상태를 만들 방법이 없으면 사용자는 갇힌다.
    ///   · Tab 은 그대로 흘려보낸다 — 안 그러면 이 칸에서 키보드로 빠져나갈 수 없다.
    /// </summary>
    internal class HotkeyBox : TextBox
    {
        private string _spec;

        public HotkeyBox(string spec)
        {
            _spec = spec ?? "";
            ReadOnly = true;
            Width = 190;
            TextAlign = HorizontalAlignment.Center;
            Cursor = Cursors.Hand;
            BackColor = Color.White;
            Render();
        }

        /// <summary>저장할 값. Electron 판과 같은 형식이다.</summary>
        public string Spec { get { return _spec; } }

        private void Render()
        {
            Text = Hotkeys.Display(_spec);
            ForeColor = _spec.Length == 0
                ? Color.FromArgb(150, 154, 162)
                : Color.FromArgb(23, 26, 32);
        }

        protected override void OnEnter(EventArgs e)
        {
            base.OnEnter(e);
            BackColor = Color.FromArgb(235, 242, 255);
            Text = "조합을 누르세요…";
        }

        protected override void OnLeave(EventArgs e)
        {
            base.OnLeave(e);
            BackColor = Color.White;
            Render();
        }

        /// <summary>
        /// Alt 조합과 방향키·Tab 은 보통 컨트롤에 KeyDown 으로 오지 않는다.
        /// 여기서 가로채야 Ctrl+Alt+N 같은 것을 잡을 수 있다.
        /// </summary>
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (!Focused) return base.ProcessCmdKey(ref msg, keyData);

            Keys code = keyData & Keys.KeyCode;

            // 이 칸에서 키보드로 빠져나갈 길은 남겨 둔다.
            if (code == Keys.Tab) return base.ProcessCmdKey(ref msg, keyData);

            if (code == Keys.Back || code == Keys.Delete)
            {
                _spec = "";
                Render();
                return true;
            }

            string got = Hotkeys.FormatFromKeys(keyData);
            if (got != null)
            {
                _spec = got;
                Render();
                return true;
            }
            // 수정자만 눌렀거나 우리가 모르는 키다. 삼키되 아무것도 바꾸지 않는다 —
            // 그래야 "Ctrl 을 눌렀더니 칸이 Ctrl 로 채워지는" 일이 없다.
            return true;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            Focus();
            base.OnMouseDown(e);
        }
    }
}
