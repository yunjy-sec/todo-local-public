using System;
using System.Collections.Generic;
using System.Windows.Forms;

namespace TodoPopup
{
    /// <summary>
    /// 알림 하나를 화면마다 하나씩 띄운 **묶음**. 그중 아무 창이나 닫히면 나머지도 닫고,
    /// 마무리는 딱 한 번만 한다.
    ///
    /// 왜 클래스로 떼어 놓았는가 (실제로 앱을 죽인 사고)
    ///
    ///   전에는 이 일을 TrayContext 안의 익명 델리게이트가 했고, 재귀를 막는 것이
    ///   `if (!other.IsDisposed) other.Close()` 한 줄뿐이었다. 그 방어는 **한 번도
    ///   발동하지 않는다** — FormClosed 가 도는 시점의 창은 아직 Disposed 가 아니고
    ///   핸들도 살아 있다. 그래서 Close() 는 Dispose 로 빠지지 않고 WM_CLOSE 를 다시
    ///   보내고, 그 창의 FormClosed 가 이 코드를 또 부른다.
    ///
    ///     A.FormClosed → B.Close() → B.FormClosed → A.Close() → A.FormClosed → …
    ///
    ///   500겹쯤에서 스택이 넘쳐 프로세스가 즉사한다(0xC00000FD). StackOverflowException
    ///   은 .NET 2.0 이후 잡을 수 없어서 try/catch 도 Application.ThreadException 도
    ///   소용이 없다. 사용자에게는 "완료를 눌렀더니 창이 몇 초 얼어 있다가 프로그램이
    ///   통째로 사라진다" 로 보였다.
    ///
    ///   모니터가 1대면 묶음에 창이 하나뿐이라 루프 본문이 아예 안 돈다. CI 의 가상
    ///   디스플레이도 1대라 검사는 내내 초록이었다 — 초록불이 무죄의 증거가 아니었다.
    ///   그래서 화면 수에 기대지 않고 시험할 수 있도록 여기로 꺼냈다(test/PopupGroupTest.cs).
    /// </summary>
    internal class PopupGroup
    {
        private readonly List<Form> _wins = new List<Form>();
        private bool _cascading;
        private bool _finished;

        /// <summary>마지막에 딱 한 번 부를 일 (목록 갱신 등).</summary>
        public Action Finished;

        /// <summary>시험용: 마무리가 몇 번 돌았는가. 1 이 아니면 사고다.</summary>
        public int FinishCount;

        /// <summary>시험용: 닫힘 통보가 몇 번 왔는가(재귀가 살아 있으면 폭주한다).</summary>
        public int CloseNotices;

        public IList<Form> Windows { get { return _wins; } }

        public void Add(Form f)
        {
            if (f == null) return;
            _wins.Add(f);
            Form self = f;
            f.FormClosed += delegate { OneClosed(self); };
        }

        private void OneClosed(Form self)
        {
            CloseNotices++;
            // 재귀 차단. 이 한 줄이 없으면 서로가 서로를 끝없이 닫는다.
            if (_cascading) return;
            _cascading = true;

            foreach (Form other in _wins)
            {
                if (other == self) continue;
                try { if (!other.IsDisposed) other.Close(); }
                catch { }
            }

            if (_finished) return;
            _finished = true;
            FinishCount++;
            if (Finished != null) Finished();
        }
    }
}
