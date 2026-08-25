using System;
using System.Windows.Forms;
using TodoPopup;

/// <summary>
/// 알림 팝업 묶음이 **서로를 끝없이 닫지 않는지** 본다.
///
/// 막는 사고 (사용자 기계에서 실제로 앱이 죽었다)
///   모니터가 2대 이상이면 알림 하나에 창이 2개 뜬다. 그중 하나를 닫으면
///   A가 B를 닫고 B가 A를 닫는 상호 재귀가 시작돼 500겹쯤에서 스택이 넘치고
///   프로세스가 즉사했다(0xC00000FD). StackOverflowException 은 잡을 수 없어
///   try/catch 도 Application.ThreadException 도 소용이 없었다.
///   증상은 "완료를 누르면 창이 몇 초 얼어 있다가 프로그램이 통째로 사라진다".
///
///   왜 검사가 못 잡았나: 모니터가 1대면 묶음에 창이 하나뿐이라 그 루프가 아예
///   돌지 않는다. CI 의 가상 디스플레이도 1대다. 그래서 화면 수에 기대지 않고
///   묶음 자체를 시험한다 — 창 두 개를 손으로 넣으면 모니터 2대와 같은 상황이다.
/// </summary>
public static class PopupGroupTest
{
    private static int _fail;

    [STAThread]
    public static int Main()
    {
        Application.EnableVisualStyles();

        // ---- 2대(쌍둥이 둘): 하나를 닫으면 나머지도 닫히고, 마무리는 한 번만 ----
        {
            PopupGroup g = new PopupGroup();
            int finished = 0;
            g.Finished = delegate { finished++; };

            Form a = NewForm();
            Form b = NewForm();
            g.Add(a);
            g.Add(b);
            a.Show();
            b.Show();
            Application.DoEvents();

            a.Close();
            Application.DoEvents();

            Check("쌍둥이 하나를 닫으면 나머지도 닫힌다", b.IsDisposed, "b.IsDisposed=" + b.IsDisposed);
            Check("마무리는 딱 한 번", finished == 1 && g.FinishCount == 1,
                "finished=" + finished + " FinishCount=" + g.FinishCount);
            // 재귀가 살아 있으면 이 값이 폭주하다가 프로세스가 죽는다.
            // 창 2개니 닫힘 통보는 2번이면 충분하다.
            Check("닫힘 통보가 폭주하지 않는다 (재귀 차단)", g.CloseNotices <= 2,
                "CloseNotices=" + g.CloseNotices);
        }

        // ---- 3대: 하나를 닫으면 셋 다 ----
        {
            PopupGroup g = new PopupGroup();
            Form[] f = new Form[] { NewForm(), NewForm(), NewForm() };
            foreach (Form x in f) { g.Add(x); x.Show(); }
            Application.DoEvents();

            f[1].Close(); // 가운데 것을 닫아도 같아야 한다
            Application.DoEvents();

            Check("3대에서도 전부 닫힌다", f[0].IsDisposed && f[2].IsDisposed,
                "0=" + f[0].IsDisposed + " 2=" + f[2].IsDisposed);
            Check("3대에서도 마무리는 한 번", g.FinishCount == 1, "FinishCount=" + g.FinishCount);
            Check("3대에서도 통보가 폭주하지 않는다", g.CloseNotices <= 3, "CloseNotices=" + g.CloseNotices);
        }

        // ---- 1대: 예전에도 멀쩡했던 경우가 여전히 멀쩡한가 ----
        {
            PopupGroup g = new PopupGroup();
            Form only = NewForm();
            g.Add(only);
            only.Show();
            Application.DoEvents();
            only.Close();
            Application.DoEvents();

            Check("1대에서도 마무리가 돈다", g.FinishCount == 1, "FinishCount=" + g.FinishCount);
        }

        // ---- 이미 닫힌 묶음에 통보가 또 와도 마무리가 두 번 돌지 않는다 ----
        {
            PopupGroup g = new PopupGroup();
            Form a = NewForm();
            Form b = NewForm();
            g.Add(a); g.Add(b);
            a.Show(); b.Show();
            Application.DoEvents();
            a.Close();
            Application.DoEvents();
            try { b.Close(); } catch { }
            Application.DoEvents();

            Check("늦게 온 통보로 마무리가 두 번 돌지 않는다", g.FinishCount == 1,
                "FinishCount=" + g.FinishCount);
        }

        Console.WriteLine(_fail == 0 ? "ALL PASS" : "FAILED " + _fail);
        return _fail;
    }

    private static Form NewForm()
    {
        Form f = new Form();
        f.FormBorderStyle = FormBorderStyle.None;
        f.ShowInTaskbar = false;
        f.StartPosition = FormStartPosition.Manual;
        f.Size = new System.Drawing.Size(120, 60);
        f.Location = new System.Drawing.Point(-4000, -4000); // 화면 밖 — 눈에 띄지 않게
        return f;
    }

    private static void Check(string what, bool ok, string detail)
    {
        if (ok) Console.WriteLine("PASS " + what);
        else
        {
            _fail++;
            Console.WriteLine("FAIL " + what + " — " + detail);
        }
    }
}
