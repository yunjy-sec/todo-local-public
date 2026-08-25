using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace TodoPopup
{
    /// <summary>이 창을 닫을 때 무엇을 할 것인가.</summary>
    internal enum ConflictOutcome
    {
        /// <summary>사용자가 물러나기를 골랐다. 이 복사본은 끝난다(종료 코드 3).</summary>
        StepAside,

        /// <summary>잠금을 이어받았다. 이 복사본이 정상 시작한다.</summary>
        TookOver,
    }

    /// <summary>
    /// "이 복사본은 시작하지 않았습니다" 를 말하는 창.
    ///
    /// 모달 대화상자가 아니다. MessageBox 는 이 앱의 실행 경로 넷에서 정확히 실패한다 —
    /// 로그온 직후의 소유자 없는 상자는 셸이 준비되기 전에 떠서 다른 창 뒤로 숨고 포커스를
    /// 훔치며, 원격 데스크톱과 잠긴 화면에서는 아예 보이지 않고, "확인을 눌러야만 앱이 뜨는"
    /// 상태를 만든다. 그래서 작업 표시줄 단추가 있는 보통 창이다. 닫아도 되고 놔둬도 된다.
    ///
    /// 이 창이 떠 있는 동안 트레이·스케줄러·알람은 시작하지 않고 원장도 읽지 않는다.
    /// 이어받기에 성공한 뒤에야 읽는다 — 옛 판의 마지막 저장을 덮지 않으려면 순서가 이래야 한다.
    /// </summary>
    internal class ConflictForm : Form
    {
        private static readonly Color Ink = Color.FromArgb(23, 26, 32);
        private static readonly Color Gray = Color.FromArgb(107, 114, 128);
        private static readonly Color Faint = Color.FromArgb(140, 144, 152);
        private static readonly Color Accent = Color.FromArgb(31, 95, 191);
        private static readonly Color Danger = Color.FromArgb(169, 39, 48);

        /// <summary>사람이 아무것도 하지 않을 때의 상한. 방향은 **비파괴** 뿐이다 —
        /// 창만 닫고 아무것도 끄지 않는다. 아무도 안 보는 기계에서 되돌릴 수 없는 교체가
        /// 일어나지 않게 한다.</summary>
        private const int IdleLimitMs = 10 * 60 * 1000;

        /// <summary>종료 요청에 응답을 기다리는 상한.</summary>
        private const int HandoverWaitMs = 5000;

        private readonly InstanceInfo _holder;   // null 이면 정체 불명
        private readonly string _myPath;
        private readonly string _myBuild;
        private readonly Func<bool> _tryAcquire; // 잠금을 딱 한 번 다시 요청한다
        private readonly Action _requestExistingShow;

        private TextBox _body;
        private FlowLayoutPanel _bar;
        private Timer _idle;
        private Timer _wait;
        private int _waitedMs;
        private bool _uipiRefused;

        public ConflictOutcome Outcome = ConflictOutcome.StepAside;

        public ConflictForm(InstanceInfo holder, string myPath, string myBuild,
            Func<bool> tryAcquire, Action requestExistingShow)
        {
            _holder = holder;
            _myPath = myPath;
            _myBuild = myBuild;
            _tryAcquire = tryAcquire;
            _requestExistingShow = requestExistingShow;

            Text = "Todo — 이 복사본은 시작하지 않았습니다";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            ShowInTaskbar = true;   // 작업 표시줄에서 다시 찾을 수 있어야 한다
            TopMost = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 380);
            BackColor = Color.White;
            ForeColor = Ink;
            Font = new Font("맑은 고딕", 9F);
            KeyPreview = true;

            BuildUi();
            ShowNotice();

            _idle = new Timer();
            _idle.Interval = IdleLimitMs;
            _idle.Tick += delegate { Outcome = ConflictOutcome.StepAside; Close(); };
            _idle.Start();
        }

        private void BuildUi()
        {
            _bar = new FlowLayoutPanel();
            _bar.Dock = DockStyle.Bottom;
            _bar.Height = 56;
            _bar.Padding = new Padding(14, 12, 14, 12);
            _bar.FlowDirection = FlowDirection.LeftToRight;
            _bar.BackColor = Color.FromArgb(248, 249, 251);
            Controls.Add(_bar);

            // 경로를 복사하는 것이 사용자가 가장 하고 싶은 일이다.
            _body = SelectableText.Make(new Font("맑은 고딕", 9F), Ink, Color.White, true);
            _body.Dock = DockStyle.Fill;
            _body.ScrollBars = ScrollBars.Vertical;
            Controls.Add(_body);
            Controls.SetChildIndex(_body, 0);
        }

        // ---- 화면들 ----

        private void ShowNotice()
        {
            _bar.Controls.Clear();
            if (_holder != null)
            {
                Text = "Todo — 이 복사본은 시작하지 않았습니다";
                _body.Text = Compose(
                    "이미 다른 폴더의 Todo 가 돌고 있어 이 복사본은 시작하지 않았습니다.",
                    "방금 뜬 목록 창은 아래의 \"지금 도는 판\" 입니다.",
                    "",
                    "지금 도는 판",
                    "    " + Show(_holder.ExePath),
                    "    빌드 " + Show(_holder.Build) + " · C# · pid " + _holder.Pid
                        + (_holder.UptimeText().Length > 0 ? " · " + _holder.UptimeText() : ""),
                    "",
                    "방금 실행한 판 (이 복사본)",
                    "    " + Show(_myPath),
                    "    빌드 " + Show(_myBuild) + " · C# · pid " + Process.GetCurrentProcess().Id,
                    "",
                    InstanceDecision.DifferenceText(_holder, _myPath, _myBuild),
                    "",
                    "교체하면 지금 도는 판을 끄고 이 복사본이 이어받습니다.",
                    "일정과 설정은 두 판이 같은 폴더를 쓰므로 그대로입니다.",
                    "그 판의 입력창에 치던 글자와 열어 둔 설정 창의 미저장 편집은 사라집니다.");

                AddButton("이 판으로 교체", Accent, false, delegate { BeginHandover(); });
                AddButton("폴더 열기", Gray, false, delegate { OpenHolderFolder(); });
                AddSpacer();
                AddButton("그냥 닫기", Gray, true, delegate { Outcome = ConflictOutcome.StepAside; Close(); });
            }
            else
            {
                Text = "Todo — 이 복사본은 시작하지 않았습니다";
                _body.Text = Compose(
                    "이미 다른 Todo 가 돌고 있어 이 복사본은 시작하지 않았습니다.",
                    "그 판이 어디에 있는지는 확인할 수 없습니다 — 실행 위치를 남기지 않는",
                    "옛 빌드입니다 (빌드 " + Show(_myBuild) + " 부터 남깁니다).",
                    "",
                    "방금 실행한 판 (이 복사본)",
                    "    " + Show(_myPath),
                    "    빌드 " + Show(_myBuild) + " · C# · pid " + Process.GetCurrentProcess().Id,
                    "",
                    "끄는 방법: 트레이의 Todo 아이콘 우클릭 → 종료",
                    "(아이콘이 둘이면 둘 다 끕니다.) 끈 뒤 [다시 확인] 을 누르면",
                    "이 복사본이 이어받습니다.",
                    "",
                    "[다시 확인] 을 누를 때마다 지금 도는 판의 목록 창이 한 번 튀어나옵니다.");

                // 정체를 모르면 끄는 단추를 **그리지 않는다**. 모르는 것을 죽이지 않는다.
                AddButton("다시 확인", Accent, true, delegate { Recheck(); });
                AddSpacer();
                AddButton("그냥 닫기", Gray, false, delegate { Outcome = ConflictOutcome.StepAside; Close(); });
            }
        }

        private void BeginHandover()
        {
            _uipiRefused = !RequestExistingExit();
            if (_uipiRefused) { ShowTimeout(); return; }

            Text = "Todo — 교체 중";
            _waitedMs = 0;
            RenderWaiting();
            _bar.Controls.Clear();
            AddSpacer();
            AddButton("기다리지 않기", Gray, false, delegate { StopWait(); ShowTimeout(); });

            _wait = new Timer();
            _wait.Interval = 100;
            _wait.Tick += delegate
            {
                _waitedMs += 100;
                if (_holder == null || !_holder.IsAlive())
                {
                    StopWait();
                    FinishTakeover();
                    return;
                }
                if (_waitedMs >= HandoverWaitMs) { StopWait(); ShowTimeout(); return; }
                if (_waitedMs % 500 == 0) RenderWaiting();
            };
            _wait.Start();
        }

        private void RenderWaiting()
        {
            _body.Text = Compose(
                "지금 도는 판에 종료를 요청했습니다.",
                "응답을 기다리는 중입니다. (" + (_waitedMs / 1000) + "초 / 최대 " + (HandoverWaitMs / 1000) + "초)",
                "    " + Show(_holder == null ? "" : _holder.ExePath) + " · pid " + (_holder == null ? 0 : _holder.Pid),
                "",
                "끝나는 대로 이 복사본이 그 자리를 이어받습니다.",
                "다시 실행할 필요는 없습니다.");
        }

        private void StopWait()
        {
            if (_wait != null) { _wait.Stop(); _wait.Dispose(); _wait = null; }
        }

        private void ShowTimeout()
        {
            Text = "Todo — 응답이 없습니다";
            string first = _uipiRefused
                ? "지금 도는 판이 더 높은 권한으로 떠 있어 종료 요청이 전달되지 않았습니다.\n트레이에서 직접 종료하세요."
                : "5초 동안 종료 요청에 응답이 없습니다. 셋 중 하나입니다.\n"
                  + " · 지금 도는 판이 이 기능이 없는 낡은 빌드입니다.\n"
                  + " · 그 판에 오류 대화상자가 떠 있어 멈춰 있습니다 —\n"
                  + "   화면의 \"Todo 팝업 알림\" 창을 먼저 닫으세요.\n"
                  + " · 트레이에 Todo 아이콘이 없다면 그 판은 이미 반쯤 죽은 상태입니다.";

            _body.Text = Compose(
                first,
                "",
                "    " + Show(_holder == null ? "" : _holder.ExePath) + " · pid " + (_holder == null ? 0 : _holder.Pid),
                "",
                "가장 확실한 방법: 트레이의 Todo 아이콘 우클릭 → 종료.",
                "끈 뒤 [다시 확인] 을 누르세요.",
                "",
                "강제로 끝내면 그 판이 하던 저장 하나를 잃고, 트레이에 아이콘 껍데기가",
                "남습니다(마우스를 올리면 사라집니다). 쓰다 만 임시 파일(.tmp)도 남을 수",
                "있습니다. 일정과 설정은 바뀔 때마다 저장되므로 잃지 않습니다.");

            _bar.Controls.Clear();
            AddButton("다시 확인", Accent, true, delegate { Recheck(); });
            // pid 를 모르면 강제 종료 단추가 아예 없다.
            if (_holder != null) AddButton("강제로 끝내기", Danger, false, delegate { ConfirmForce(); });
            AddSpacer();
            AddButton("그냥 닫기", Gray, false, delegate { Outcome = ConflictOutcome.StepAside; Close(); });
        }

        private void ConfirmForce()
        {
            // 5초를 기다리는 사이 pid 가 재사용될 수 있다. 죽이기 직전에 한 번 더 대조한다.
            if (_holder == null || !_holder.IsTrustworthy())
            {
                _body.Text = Compose(
                    "그 프로세스는 이미 없습니다 — [다시 확인] 을 누르면",
                    "이 복사본이 이어받습니다.");
                _bar.Controls.Clear();
                AddButton("다시 확인", Accent, true, delegate { Recheck(); });
                AddSpacer();
                AddButton("그냥 닫기", Gray, false, delegate { Outcome = ConflictOutcome.StepAside; Close(); });
                return;
            }

            Text = "Todo — 강제 종료";
            _body.Text = Compose(
                "아래 프로세스를 강제로 끝냅니다. 되돌릴 수 없습니다.",
                "    " + Show(_holder.ExePath),
                "    pid " + _holder.Pid
                    + (_holder.StartedAtLocalText().Length > 0 ? " · " + _holder.StartedAtLocalText() + " 시작" : ""),
                "",
                "그 판이 하던 저장 하나와 입력 중이던 글자가 사라지고,",
                "트레이에 아이콘 껍데기가 남을 수 있습니다.");

            _bar.Controls.Clear();
            AddSpacer();
            // 파괴적 단추에는 어떤 키도 배정하지 않는다. 마우스나 Tab 으로만 닿는다.
            AddButton("강제 종료", Danger, false, delegate { DoForce(); });
            AddButton("취소", Gray, true, delegate { ShowTimeout(); });
        }

        private void DoForce()
        {
            if (_holder == null || !_holder.IsTrustworthy()) { ShowTimeout(); return; }
            try
            {
                using (Process p = Process.GetProcessById(_holder.Pid))
                {
                    p.Kill();
                    p.WaitForExit(HandoverWaitMs);
                }
            }
            catch { }
            FinishTakeover();
        }

        private void Recheck()
        {
            if (_tryAcquire != null && _tryAcquire())
            {
                Outcome = ConflictOutcome.TookOver;
                Close();
                return;
            }
            // 못 얻었다. 잠금 요청 한 번마다 낡은 판의 창이 한 번 튀어나올 수 있다 —
            // 그래서 폴링하지 않고 사람이 누른 만큼만 시도한다.
            if (_holder == null) ShowNotice();
            else ShowTimeout();
        }

        private void FinishTakeover()
        {
            if (_tryAcquire != null && _tryAcquire())
            {
                Outcome = ConflictOutcome.TookOver;
                Close();
                return;
            }
            ShowTimeout();
        }

        /// <summary>종료 요청을 정확히 한 번 보낸다. false 면 UIPI 거부다.</summary>
        private bool RequestExistingExit()
        {
            if (_holder != null && _holder.Hwnd != 0)
                return Program.RequestExit(new IntPtr(_holder.Hwnd));
            return Program.RequestExitBroadcast();
        }

        private void OpenHolderFolder()
        {
            if (_holder == null || string.IsNullOrEmpty(_holder.ExePath)) return;
            try { Process.Start("explorer.exe", "\"" + _holder.ExePath + "\""); }
            catch { }
        }

        // ---- 잔손질 ----

        private static string Show(string s) { return string.IsNullOrEmpty(s) ? "(알 수 없음)" : s; }

        private static string Compose(params string[] lines)
        {
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            foreach (string l in lines)
            {
                if (l == null) continue;
                sb.Append(l).Append("\r\n");
            }
            return sb.ToString();
        }

        private void AddButton(string text, Color color, bool isDefault, EventHandler onClick)
        {
            Button b = new Button();
            b.Text = text;
            b.AutoSize = false;
            b.Size = new Size(text.Length > 6 ? 116 : 96, 30);
            b.FlatStyle = FlatStyle.System;
            b.ForeColor = color;
            b.Click += onClick;
            b.Click += delegate { RestartIdle(); };
            _bar.Controls.Add(b);
            if (isDefault) { AcceptButton = b; b.Select(); }
        }

        private void AddSpacer()
        {
            Panel p = new Panel();
            p.Width = 40;
            p.Height = 1;
            _bar.Controls.Add(p);
        }

        private void RestartIdle()
        {
            if (_idle == null) return;
            _idle.Stop();
            _idle.Start();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            // Esc 는 언제나 비파괴다. 파괴적 선택이 엔터 연타로 실행되지 않게 한다.
            if (e.KeyCode == Keys.Escape)
            {
                Outcome = ConflictOutcome.StepAside;
                Close();
                return;
            }
            base.OnKeyDown(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            StopWait();
            if (_idle != null) { _idle.Stop(); _idle.Dispose(); _idle = null; }
            base.OnFormClosed(e);
        }

        /// <summary>[다시 확인] 을 누르면 기존 판의 창을 한 번 앞으로 부른다(정체 불명일 때).</summary>
        public void PokeExisting()
        {
            if (_requestExistingShow != null) _requestExistingShow();
        }
    }
}
