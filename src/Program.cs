using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace TodoPopup
{
    public static class Program
    {
        public static int ShowMeMessage;
        public static int ExitPleaseMessage;

        /// <summary>종료 코드. 0 = 정상 시작 또는 사용자가 기존 판을 골랐다 / 3 = 밀렸다.</summary>
        public const int ExitOk = 0;
        public const int ExitSteppedAside = 3;

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int RegisterWindowMessage(string message);

        private static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);

        private static InstanceInfo _nameplate;

        /// <summary>도는 인스턴스에 종료를 요청한다. false 면 전달되지 않았다(UIPI 거부).</summary>
        public static bool RequestExit(IntPtr hwnd)
        {
            if (ExitPleaseMessage == 0) return false;
            return PostMessage(hwnd, ExitPleaseMessage, IntPtr.Zero, IntPtr.Zero);
        }

        public static bool RequestExitBroadcast()
        {
            if (ExitPleaseMessage == 0) return false;
            return PostMessage(HWND_BROADCAST, ExitPleaseMessage, IntPtr.Zero, IntPtr.Zero);
        }

        [STAThread]
        public static int Main(string[] args)
        {
            ShowMeMessage = RegisterWindowMessage("TodoPopup_ShowMain");
            ExitPleaseMessage = RegisterWindowMessage("TodoPopup_ExitPlease");

            // **창을 하나라도 만들기 전에** 정해야 한다.
            // SetUnhandledExceptionMode 는 이 스레드에 첫 창이 생긴 뒤에 부르면
            // InvalidOperationException 을 던진다. 실제로 그렇게 깨졌다 — 안내 창을 띄운
            // 뒤에 불렀더니, 이어받기에 성공한 새 판이 바로 그 줄에서 죽었다.
            // (전부 플래그를 세우는 호출이라 어느 갈래로 가든 값이 같다.)
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

            bool createdNew;
            using (Mutex mutex = new Mutex(true, "TodoPopup_SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    // 잠금을 못 얻었다. 무엇을 할지는 순수 함수가 정한다(InstanceDecision).
                    // 이 갈래 밖의 코드는 예전과 한 줄도 다르지 않다.
                    return SecondInstance(mutex, args);
                }

                bool testPopup = false;
                foreach (string a in args)
                {
                    if (a == "--test-popup") testPopup = true;
                }

                RunApp(testPopup);
                GC.KeepAlive(mutex);
                return ExitOk;
            }
        }

        /// <summary>정상 시작. 명패를 내걸고 트레이를 돌린다.</summary>
        private static void RunApp(bool testPopup)
        {
            TrayContext ctx = new TrayContext(testPopup);
            // 명패는 창 핸들이 생긴 뒤에 내건다 — 종료 요청을 받을 자리가 그 핸들이다.
            _nameplate = InstanceInfo.ForThisProcess(ctx.MessageWindowHandle);
            _nameplate.Publish();
            try { Application.Run(ctx); }
            finally { _nameplate.Release(); }
        }

        /// <summary>
        /// 두 번째 실행. 여기가 이 기능의 전부다 — 잠금을 얻은 경로는 건드리지 않는다.
        ///
        /// 막는 사고: 낡은 복사본이 잠금을 쥐고 있으면 새 복사본이 **종료 코드 0 으로 조용히**
        /// 사라졌다. 사용자는 그것을 "업데이트가 반영 안 됐다" 로 읽었고, 실제로는 다른 폴더의
        /// 옛 판이 계속 돌고 있었다.
        /// </summary>
        private static int SecondInstance(Mutex mutex, string[] args)
        {
            string myPath = InstanceInfo.ExeDir();
            string myBuild = InstanceInfo.BuildStamp();

            InstanceInfo holder = InstanceInfo.Read();
            if (holder != null && !holder.IsTrustworthy()) holder = null; // 못 믿으면 없는 것으로

            InstanceAction act = InstanceDecision.Decide(false, myPath, holder, args);

            if (act == InstanceAction.StepAsideSilently)
                return ExitSteppedAside;

            if (act == InstanceAction.ShowExistingAndQuit)
            {
                // 예전과 똑같다: 기존 판의 목록 창을 띄우고 조용히 끝난다.
                PostMessage(HWND_BROADCAST, ShowMeMessage, IntPtr.Zero, IntPtr.Zero);
                return ExitOk;
            }

            // 안내 창을 띄운다. 이 시점까지 원장(todos.json·settings.json)을 읽지 않았고
            // 트레이·스케줄러·알람도 시작하지 않았다.
            ConflictForm form = new ConflictForm(
                act == InstanceAction.TellKnown ? holder : null,
                myPath, myBuild,
                delegate { return TryAcquire(mutex); },
                delegate { PostMessage(HWND_BROADCAST, ShowMeMessage, IntPtr.Zero, IntPtr.Zero); });

            Application.Run(form);

            if (form.Outcome != ConflictOutcome.TookOver) return ExitSteppedAside;

            // 이어받았다. **이제야** 원장을 읽고 평소대로 시작한다 — 옛 프로세스가 사라진 뒤여야
            // 그 판의 마지막 저장이 우리 메모리에 덮이지 않는다.
            RunApp(InstanceDecision.HasFlag(args, "--test-popup"));
            GC.KeepAlive(mutex);
            return ExitOk;
        }

        /// <summary>
        /// 잠금을 딱 한 번 다시 요청한다.
        ///
        /// 이미 쥔 핸들로 WaitOne(0) 을 쓴다. new Mutex(true, …) 를 다시 부르면 세 번째
        /// 인스턴스와 경합한다. AbandonedMutexException 은 실패가 아니라 "이제 당신이 소유자" 다 —
        /// 이전 소유자가 놓지 않고 죽었다는 뜻이고, 그것이 바로 우리가 기다리던 상황이다.
        /// </summary>
        private static bool TryAcquire(Mutex mutex)
        {
            try { return mutex.WaitOne(0); }
            catch (AbandonedMutexException) { return true; }
            catch { return false; }
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
