using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace TodoPopup
{
    public enum PopupAction
    {
        Ack,
        Snooze,
        Done,
        Cancel
    }

    public class PopupForm : Form
    {
        public event Action<PopupForm, TodoItem, PopupAction, int> ActionChosen;

        private static readonly Color BorderColor = Color.FromArgb(178, 182, 192);
        private static readonly Color HeaderColor = Color.FromArgb(244, 244, 246);
        private static readonly Color AccentColor = Color.FromArgb(37, 99, 235);
        private static readonly Color DangerColor = Color.FromArgb(200, 42, 42);
        private static readonly Color GrayText = Color.FromArgb(96, 100, 110);

        private readonly TodoItem _todo;
        private readonly bool _isPreview;
        private TextBox _lblTitle;
        private TextBox _lblInfo;
        private TextBox _lblNote;
        private Button _btnSnooze;
        private Timer _refresh;
        private bool _chosen;
        private Timer _blink;          // 눈에 띄는 효과
        private bool _blinkOn;
        private string _effect;
        private Panel _header;         // 효과가 배경을 갈아 끼울 때 함께 바꾼다
        private int _rainbowStep;

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HT_CAPTION = 0x2;

        public TodoItem Todo { get { return _todo; } }
        public bool IsPreview { get { return _isPreview; } }

        // TrayContext가 관리하는 스택 위치 슬롯
        public int Slot;

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        public PopupForm(TodoItem todo, AppSettings st, bool isPreview)
        {
            _todo = todo;
            _isPreview = isPreview;

            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            KeyPreview = true;
            BackColor = Color.White;
            Opacity = st.Opacity;
            Size = new Size(st.PopupWidth, st.PopupHeight);
            MinimumSize = new Size(260, 130);
            Font = new Font("맑은 고딕", 9F);
            SetStyle(ControlStyles.ResizeRedraw, true);

            BuildUi(st);
            UpdateInfo();

            _refresh = new Timer();
            _refresh.Interval = 30000;
            _refresh.Tick += delegate { UpdateInfo(); };
            _refresh.Start();

            StartEffect(st);
        }

        // ───────── 눈에 띄는 효과 ─────────
        // 알림이 떠도 못 보고 지나치면 이 앱은 아무것도 한 것이 없다. 그래서 기본으로 번쩍인다.
        // **창 전체**의 배경을 바꾼다 — 제목 줄만 바뀌면 넓은 본문이 흰 채로 남아 눈에 띄지 않는다.
        // 0.5초 주기이고, 버튼을 누를 때까지 멈추지 않는다("완료·취소 전까지 계속 알린다"는 약속).
        private static readonly Color[] RainbowColors = new Color[]
        {
            Color.FromArgb(255, 213, 74),
            Color.FromArgb(182, 240, 160),
            Color.FromArgb(191, 224, 255),
            Color.FromArgb(255, 196, 236),
        };

        private void StartEffect(AppSettings st)
        {
            _effect = string.IsNullOrEmpty(st.PopupEffect) ? "flash" : st.PopupEffect;
            if (_effect == "none") return;

            _blink = new Timer();
            // rainbow 는 색이 네 개라 한 바퀴가 길다. 나머지는 0.5초 주기(켜짐 0.25 + 꺼짐 0.25).
            _blink.Interval = _effect == "rainbow" ? 500 : 250;
            _blink.Tick += delegate { TickEffect(); };
            _blink.Start();
        }

        private void TickEffect()
        {
            if (_chosen) return;
            _blinkOn = !_blinkOn;
            Color bg;
            switch (_effect)
            {
                case "pulse":
                    bg = _blinkOn ? Color.FromArgb(191, 224, 255) : Color.White;
                    break;
                case "glow":
                    bg = _blinkOn ? Color.FromArgb(255, 214, 208) : Color.White;
                    break;
                case "rainbow":
                    _rainbowStep = (_rainbowStep + 1) % RainbowColors.Length;
                    bg = RainbowColors[_rainbowStep];
                    break;
                case "shake":
                    // 위치를 흔든다. 색은 건드리지 않는다.
                    Left += _blinkOn ? 3 : -3;
                    return;
                default: // flash
                    bg = _blinkOn ? Color.FromArgb(255, 213, 74) : Color.White;
                    break;
            }
            ApplyBackground(bg, bg);
            Invalidate();
        }

        /// <summary>
        /// 창 배경을 바꾼다. **글자 영역(TextBox)도 함께** 바꿔야 한다 —
        /// 선택 가능하게 하려고 Label 을 TextBox 로 바꿨는데, TextBox 는 자기 BackColor 를
        /// 들고 있어서 창만 물들이면 글자 자리만 흰 상자로 남는다(실제로 그렇게 보였다).
        /// </summary>
        private void ApplyBackground(Color body, Color header)
        {
            BackColor = body;
            if (_header != null) _header.BackColor = header;
            if (_lblTitle != null) _lblTitle.BackColor = body;
            if (_lblInfo != null) _lblInfo.BackColor = body;
            if (_lblNote != null) _lblNote.BackColor = body;
        }

        /// <summary>사용자가 눌렀다. 알림은 제 할 일을 다 했으므로 즉시 조용해진다.</summary>
        private void StopEffect()
        {
            if (_blink != null) { _blink.Stop(); _blink.Dispose(); _blink = null; }
            ApplyBackground(Color.White, HeaderColor);
            Invalidate();
        }

        /// <summary>
        /// 이 실행 파일이 언제 만들어졌는가(yyyyMMdd_HHmmss). 디버깅 힌트다 —
        /// ZIP 을 받아 실행했을 때 "업데이트가 반영된 판인가" 를 창만 보고 알 수 있어야 한다.
        /// </summary>
        private static string BuildStamp()
        {
            try
            {
                string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(exe) && System.IO.File.Exists(exe))
                {
                    return System.IO.File.GetLastWriteTime(exe).ToString("yyyyMMdd_HHmmss");
                }
            }
            catch { }
            return "unknown";
        }

        private void BuildUi(AppSettings st)
        {
            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 26;
            header.BackColor = HeaderColor;
            _header = header;

            Label lblHeader = new Label();
            // 빌드 시각·런타임 표시는 목록 창 좌상단 배너로 옮겼다(알림 팝업은 좁다).
            lblHeader.Text = "≡  할 일 알림";
            lblHeader.ForeColor = GrayText;
            lblHeader.Font = new Font("맑은 고딕", 8.5F);
            lblHeader.Location = new Point(10, 5);
            lblHeader.AutoSize = true;
            header.Controls.Add(lblHeader);

            Label lblDragHint = new Label();
            lblDragHint.Text = "드래그로 이동";
            lblDragHint.ForeColor = Color.FromArgb(150, 154, 162);
            lblDragHint.Font = new Font("맑은 고딕", 8F);
            lblDragHint.AutoSize = true;
            lblDragHint.Location = new Point(Width - 90, 6);
            lblDragHint.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            header.Controls.Add(lblDragHint);

            _lblTitle = SelectableText.Make(new Font("맑은 고딕", 11.5F, FontStyle.Bold), ForeColor, BackColor, false);
            _lblTitle.Location = new Point(14, 34);
            _lblTitle.Size = new Size(Width - 28, 26);
            _lblTitle.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            _lblTitle.Text = _todo.Title;

            _lblInfo = SelectableText.Make(null, GrayText, BackColor, false);
            _lblInfo.Location = new Point(14, 62);
            _lblInfo.Size = new Size(Width - 28, 18);
            _lblInfo.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            _lblNote = SelectableText.Make(new Font("맑은 고딕", 8F), Color.FromArgb(150, 154, 162), BackColor, false);
            _lblNote.Location = new Point(14, 82);
            _lblNote.Size = new Size(Width - 28, 16);
            _lblNote.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            _lblNote.Text = _isPreview
                ? "미리보기입니다 — 아무 버튼이나 누르면 닫힙니다"
                : string.Format("완료·취소 전까지 {0}분마다 다시 알립니다", _todo.RenotifyMinutes);

            TableLayoutPanel buttons = new TableLayoutPanel();
            buttons.Dock = DockStyle.Bottom;
            buttons.Height = 42;
            buttons.Padding = new Padding(8, 4, 8, 8);
            buttons.ColumnCount = 5;
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25F));
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25F));
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 26F));
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25F));
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25F));

            Button btnAck = MakeButton("확인", Color.White, Color.FromArgb(55, 58, 64));
            btnAck.Click += delegate { Choose(PopupAction.Ack, 0); };

            _btnSnooze = MakeButton(string.Format("{0}분 뒤", st.DefaultSnoozeMinutes), Color.White, Color.FromArgb(55, 58, 64));
            int defSnooze = st.DefaultSnoozeMinutes;
            _btnSnooze.Click += delegate { Choose(PopupAction.Snooze, defSnooze); };

            Button btnMore = MakeButton("▾", Color.White, GrayText);
            ContextMenuStrip menu = new ContextMenuStrip();
            AddSnoozeMenu(menu, "5분 뒤", 5);
            AddSnoozeMenu(menu, "10분 뒤", 10);
            AddSnoozeMenu(menu, "15분 뒤", 15);
            AddSnoozeMenu(menu, "30분 뒤", 30);
            AddSnoozeMenu(menu, "1시간 뒤", 60);
            AddSnoozeMenu(menu, "3시간 뒤", 180);
            AddSnoozeMenu(menu, "내일 이 시간", 1440);
            btnMore.Click += delegate { menu.Show(btnMore, new Point(0, btnMore.Height)); };

            Button btnDone = MakeButton("완료", AccentColor, Color.White);
            btnDone.FlatAppearance.BorderColor = AccentColor;
            btnDone.Click += delegate { Choose(PopupAction.Done, 0); };

            Button btnCancel = MakeButton("취소", Color.White, DangerColor);
            btnCancel.Click += delegate { Choose(PopupAction.Cancel, 0); };

            buttons.Controls.Add(btnAck, 0, 0);
            buttons.Controls.Add(_btnSnooze, 1, 0);
            buttons.Controls.Add(btnMore, 2, 0);
            buttons.Controls.Add(btnDone, 3, 0);
            buttons.Controls.Add(btnCancel, 4, 0);

            Controls.Add(_lblTitle);
            Controls.Add(_lblInfo);
            Controls.Add(_lblNote);
            Controls.Add(buttons);
            Controls.Add(header);

            HookDrag(this);
            HookDrag(header);
            HookDrag(lblHeader);
            HookDrag(lblDragHint);
            HookDrag(_lblTitle);
            HookDrag(_lblInfo);
            HookDrag(_lblNote);
        }

        private void AddSnoozeMenu(ContextMenuStrip menu, string label, int minutes)
        {
            int captured = minutes;
            menu.Items.Add(label, null, delegate { Choose(PopupAction.Snooze, captured); });
        }

        private Button MakeButton(string text, Color back, Color fore)
        {
            Button b = new Button();
            b.Text = text;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Color.FromArgb(203, 206, 213);
            b.BackColor = back;
            b.ForeColor = fore;
            b.Dock = DockStyle.Fill;
            b.Margin = new Padding(3, 0, 3, 0);
            b.TabStop = false;
            return b;
        }

        private void HookDrag(Control c)
        {
            c.MouseDown += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left)
                {
                    ReleaseCapture();
                    SendMessage(Handle, WM_NCLBUTTONDOWN, HT_CAPTION, 0);
                }
            };
        }

        public void UpdateInfo()
        {
            DateTime due = _todo.GetDue();
            DateTime now = DateTime.Now;
            string overdue;
            TimeSpan diff = now - due;
            if (diff.TotalMinutes < 1 && diff.TotalMinutes > -1) overdue = "지금";
            else if (diff.TotalMinutes < 0) overdue = "곧";
            else if (diff.TotalMinutes < 60) overdue = string.Format("{0}분 지남", (int)diff.TotalMinutes);
            else overdue = string.Format("{0}시간 {1}분 지남", (int)diff.TotalHours, diff.Minutes);

            int count = _todo.NotifyCount;
            if (count < 1) count = 1;
            _lblInfo.Text = string.Format("{0} 예정 · {1} · {2}번째 알림",
                TimeUtil.FormatClock(due), overdue, count);
        }

        private void Choose(PopupAction action, int minutes)
        {
            if (_chosen) return;
            _chosen = true;
            // 누른 즉시 효과를 멈춘다. 닫히기까지의 짧은 사이에도 번쩍이면 눌렸는지
            // 알 수가 없고, 모니터마다 있는 쌍둥이가 차례로 닫힐 때 더 어지럽다.
            StopEffect();
            Action<PopupForm, TodoItem, PopupAction, int> h = ActionChosen;
            if (h != null) h(this, _todo, action, minutes);
            Close();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape)
            {
                e.Handled = true;
                Choose(PopupAction.Ack, 0);
                return;
            }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (Pen p = new Pen(BorderColor))
            {
                e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (_refresh != null)
            {
                _refresh.Stop();
                _refresh.Dispose();
                _refresh = null;
            }
            base.OnFormClosed(e);
        }
    }
}
