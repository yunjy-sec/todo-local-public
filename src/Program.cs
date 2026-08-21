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
                    // 예기치 못한 예외로 트레이 앱 전체가 죽지 않게 한다
                    MessageBox.Show("예기치 않은 오류가 발생했습니다:\n" + e.Exception.Message,
                        "Todo 팝업 알림", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                };
                Application.Run(new TrayContext(testPopup));
                GC.KeepAlive(mutex);
            }
        }
    }
}
