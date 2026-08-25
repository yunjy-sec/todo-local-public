using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace TodoPopup
{
    public static class Program
    {
        public static int ShowMeMessage;

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int RegisterWindowMessage(string message);

        private static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);

        [STAThread]
        public static void Main(string[] args)
        {
            ShowMeMessage = RegisterWindowMessage("TodoPopup_ShowMain");

            bool createdNew;
            using (Mutex mutex = new Mutex(true, "TodoPopup_SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    // 이미 실행 중 → 기존 인스턴스의 목록 창을 띄우고 종료
                    PostMessage(HWND_BROADCAST, ShowMeMessage, IntPtr.Zero, IntPtr.Zero);
                    return;
                }

                bool testPopup = false;
                foreach (string a in args)
                {
                    if (a == "--test-popup") testPopup = true;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
                {
                    // 예기치 못한 예외로 트레이 앱 전체가 죽지 않게 한다.
                    //
                    // 메시지만 보여 줬더니 "개체 참조가 개체의 인스턴스로 설정되지 않았습니다"
                    // 한 줄이 전부라 어디서 났는지 아무도 알 수 없었다. 사용자도 우리도.
                    // 그래서 우리 코드의 첫 프레임을 제목처럼 앞세우고, 전문은 파일로 남긴다.
                    Report(e.Exception);
                };
                AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
                {
                    // UI 스레드 밖(타이머 스레드·작업 스레드)에서 난 것은 위 핸들러가 못 잡는다.
                    // 그대로 두면 앱이 아무 말 없이 사라진다 — 실제로 그렇게 보였다.
                    Exception ex = e.ExceptionObject as Exception;
                    if (ex != null) Report(ex);
                };
                Application.Run(new TrayContext(testPopup));
                GC.KeepAlive(mutex);
            }
        }

        private static readonly System.Collections.Generic.HashSet<string> _shown =
            new System.Collections.Generic.HashSet<string>();
        private static bool _reporting;

        /// <summary>예외를 사람이 고칠 수 있는 모양으로 보여 주고 파일로 남긴다.</summary>
        ///
        /// 같은 예외를 두 번 이상 상자로 띄우지 않는다. 알림 검사는 5초마다 돌기 때문에,
        /// 그 안에서 예외가 나면 상자가 뜨고 → 상자가 메시지를 펌프하고 → 타이머가 또 돌고
        /// → 상자가 또 뜬다. 상자가 끝없이 겹치다가 프로세스가 조용히 죽는다.
        /// 사용자에게는 "버튼을 눌렀더니 프로그램이 사라졌다" 로 보인다.
        /// 첫 번째만 보여 주고, 나머지는 crash.log 에만 쌓는다.
        private static void Report(Exception ex)
        {
            if (_reporting) return; // 상자를 띄우는 도중에 또 들어왔다
            string where = FirstOwnFrame(ex);
            string full = ex.ToString();
            string logPath = "";
            try
            {
                logPath = System.IO.Path.Combine(Storage.DataDir, "crash.log");
                System.IO.File.AppendAllText(logPath,
                    "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + full + Environment.NewLine + Environment.NewLine,
                    System.Text.Encoding.UTF8);
            }
            catch { logPath = ""; }

            string sig = ex.GetType().Name + "|" + where;
            if (_shown.Contains(sig)) return; // 이미 말했다 — 기록만 쌓는다
            _shown.Add(sig);

            string body = "예기치 않은 오류가 발생했습니다.\n\n"
                + ex.GetType().Name + ": " + ex.Message + "\n\n"
                + "난 자리: " + where + "\n";
            if (logPath.Length > 0) body += "\n전문은 여기에 남겼습니다:\n" + logPath;
            body += "\n\n같은 오류는 다시 알리지 않고 위 파일에만 기록합니다.";

            _reporting = true;
            try
            {
                MessageBox.Show(body, "Todo 팝업 알림", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally { _reporting = false; }
        }

        /// <summary>스택에서 **우리 코드**의 첫 줄을 뽑는다. 프레임워크 프레임은 고칠 자리가 아니다.</summary>
        private static string FirstOwnFrame(Exception ex)
        {
            try
            {
                string[] lines = ex.ToString().Split(new string[] { Environment.NewLine }, StringSplitOptions.None);
                foreach (string ln in lines)
                {
                    if (ln.IndexOf("TodoPopup.", StringComparison.Ordinal) >= 0 && ln.IndexOf("위치:", StringComparison.Ordinal) >= 0)
                        return ln.Trim();
                    if (ln.IndexOf("TodoPopup.", StringComparison.Ordinal) >= 0 && ln.IndexOf(" at ", StringComparison.Ordinal) >= 0)
                        return ln.Trim();
                }
            }
            catch { }
            return "알 수 없음";
        }
    }
}
