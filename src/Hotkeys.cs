using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace TodoPopup
{
    /// <summary>
    /// 전역 단축키. 창이 트레이에 숨어 있어도 키 하나로 부를 수 있어야 한다.
    ///
    /// 왜 있는가
    ///   사용자가 원하는 흐름은 딱 이것이다 — Ctrl+Alt+N → 일정 입력 → Enter.
    ///   그러려면 앱이 포커스를 갖고 있지 않을 때도 키를 받아야 하고, 그것은
    ///   RegisterHotKey 로만 된다(폼의 KeyDown 은 그 창이 활성일 때만 온다).
    ///
    /// 문자열 형식은 Electron 판과 **같은 것**을 쓴다("Control+Alt+N").
    /// settings.json 을 두 판이 공유하므로 형식이 갈라지면 한쪽에서 정한 키가
    /// 다른 쪽에서 조용히 무시된다.
    /// </summary>
    internal static class Hotkeys
    {
        // RegisterHotKey 의 fsModifiers
        public const uint MOD_ALT = 0x0001;
        public const uint MOD_CONTROL = 0x0002;
        public const uint MOD_SHIFT = 0x0004;
        public const uint MOD_WIN = 0x0008;
        // 누르고 있으면 초당 수십 번 들어온다. 목록 창이 그만큼 다시 뜨면 못 쓴다.
        public const uint MOD_NOREPEAT = 0x4000;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        /// <summary>"Control+Alt+N" -> 수정자 + 가상 키. 못 읽으면 false — 지어내지 않는다.</summary>
        public static bool TryParse(string spec, out uint mods, out uint vk)
        {
            mods = 0;
            vk = 0;
            if (string.IsNullOrEmpty(spec)) return false;

            string[] parts = spec.Split('+');
            List<string> tokens = new List<string>();
            foreach (string raw in parts)
            {
                string t = raw.Trim();
                if (t.Length > 0) tokens.Add(t);
            }
            if (tokens.Count < 2) return false; // 수정자 없는 전역 단축키는 만들지 않는다

            string keyToken = tokens[tokens.Count - 1];
            for (int i = 0; i < tokens.Count - 1; i++)
            {
                uint m = ModifierOf(tokens[i]);
                if (m == 0) return false;
                mods |= m;
            }
            if (mods == 0) return false;

            vk = VirtualKeyOf(keyToken);
            if (vk == 0) return false;

            mods |= MOD_NOREPEAT;
            return true;
        }

        private static uint ModifierOf(string t)
        {
            string k = t.ToLowerInvariant();
            // Electron 이 쓰는 이름을 전부 받는다 — 사용자가 그 문서를 보고 적을 수 있다.
            if (k == "control" || k == "ctrl" || k == "commandorcontrol" || k == "cmdorctrl") return MOD_CONTROL;
            if (k == "alt" || k == "option") return MOD_ALT;
            if (k == "shift") return MOD_SHIFT;
            if (k == "super" || k == "meta" || k == "win" || k == "cmd" || k == "command") return MOD_WIN;
            return 0;
        }

        private static uint VirtualKeyOf(string t)
        {
            if (t.Length == 1)
            {
                char c = char.ToUpperInvariant(t[0]);
                if (c >= 'A' && c <= 'Z') return (uint)c;
                if (c >= '0' && c <= '9') return (uint)c;
                return 0;
            }
            string k = t.ToLowerInvariant();
            if (k.Length >= 2 && k[0] == 'f')
            {
                int n;
                if (int.TryParse(k.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out n)
                    && n >= 1 && n <= 24)
                    return (uint)(0x6F + n); // F1 = 0x70
            }
            switch (k)
            {
                case "enter":
                case "return": return 0x0D;
                case "space":
                case "spacebar": return 0x20;
                case "tab": return 0x09;
                case "escape":
                case "esc": return 0x1B;
                case "backspace": return 0x08;
                case "insert": return 0x2D;
                case "delete":
                case "del": return 0x2E;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": return 0x21;
                case "pagedown": return 0x22;
                case "left": return 0x25;
                case "up": return 0x26;
                case "right": return 0x27;
                case "down": return 0x28;
            }
            return 0;
        }

        /// <summary>WinForms 의 Keys 를 우리 문자열로. 설정 화면의 "키 잡기" 가 쓴다.</summary>
        public static string FormatFromKeys(Keys keyData)
        {
            Keys code = keyData & Keys.KeyCode;
            if (code == Keys.None || code == Keys.ControlKey || code == Keys.Menu
                || code == Keys.ShiftKey || code == Keys.LWin || code == Keys.RWin)
                return null; // 수정자만 눌렀다 — 아직 조합이 아니다

            StringBuilder sb = new StringBuilder();
            if ((keyData & Keys.Control) == Keys.Control) sb.Append("Control+");
            if ((keyData & Keys.Alt) == Keys.Alt) sb.Append("Alt+");
            if ((keyData & Keys.Shift) == Keys.Shift) sb.Append("Shift+");
            if (sb.Length == 0) return null; // 수정자 없는 전역 단축키는 만들지 않는다

            string name = KeyName(code);
            if (name == null) return null;
            sb.Append(name);
            return sb.ToString();
        }

        private static string KeyName(Keys code)
        {
            if (code >= Keys.A && code <= Keys.Z) return code.ToString();
            if (code >= Keys.D0 && code <= Keys.D9) return ToDigit(code - Keys.D0);
            if (code >= Keys.NumPad0 && code <= Keys.NumPad9) return ToDigit(code - Keys.NumPad0);
            if (code >= Keys.F1 && code <= Keys.F24) return "F" + (int)(code - Keys.F1 + 1);
            switch (code)
            {
                case Keys.Enter: return "Enter";
                case Keys.Space: return "Space";
                case Keys.Tab: return "Tab";
                case Keys.Escape: return "Escape";
                case Keys.Back: return "Backspace";
                case Keys.Insert: return "Insert";
                case Keys.Delete: return "Delete";
                case Keys.Home: return "Home";
                case Keys.End: return "End";
                case Keys.PageUp: return "PageUp";
                case Keys.PageDown: return "PageDown";
                case Keys.Left: return "Left";
                case Keys.Up: return "Up";
                case Keys.Right: return "Right";
                case Keys.Down: return "Down";
            }
            return null;
        }

        private static string ToDigit(int offset)
        {
            return offset.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>사람에게 보여 주는 이름. 빈 값이면 "없음".</summary>
        public static string Display(string spec)
        {
            if (string.IsNullOrEmpty(spec)) return "없음";
            return spec.Replace("Control+", "Ctrl+");
        }

        // ---- 등록 ----

        /// <summary>
        /// 등록 결과. 실패를 조용히 삼키지 않는다 — 다른 앱이 그 조합을 이미 쥐고 있으면
        /// 사용자는 "단축키가 안 먹는다" 만 알게 되고 이유는 영영 모른다.
        /// </summary>
        public class Result
        {
            public int Id;
            public string Spec;
            public bool Ok;
            public string Why;
        }

        public static Result Register(IntPtr hWnd, int id, string spec)
        {
            Result r = new Result();
            r.Id = id;
            r.Spec = spec;
            if (string.IsNullOrEmpty(spec)) { r.Ok = true; r.Why = "비어 있음(끄기)"; return r; }

            uint mods, vk;
            if (!TryParse(spec, out mods, out vk))
            {
                r.Ok = false;
                r.Why = "읽을 수 없는 조합입니다";
                return r;
            }
            try
            {
                if (RegisterHotKey(hWnd, id, mods, vk)) { r.Ok = true; return r; }
                int err = Marshal.GetLastWin32Error();
                r.Ok = false;
                // 1409 = ERROR_HOTKEY_ALREADY_REGISTERED
                r.Why = err == 1409 ? "다른 프로그램이 이미 쓰고 있습니다" : "등록 실패 (오류 " + err + ")";
            }
            catch (Exception ex)
            {
                r.Ok = false;
                r.Why = ex.Message;
            }
            return r;
        }

        public static void Unregister(IntPtr hWnd, int id)
        {
            try { UnregisterHotKey(hWnd, id); }
            catch { }
        }
    }
}
