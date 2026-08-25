using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace TodoPopup
{
    public class MainForm : Form
    {
        private static readonly Color AccentColor = Color.FromArgb(37, 99, 235);
        private static readonly Color GrayText = Color.FromArgb(96, 100, 110);
        private static readonly Color WarnColor = Color.FromArgb(202, 96, 12);
        private static readonly Color OkColor = Color.FromArgb(22, 128, 84);
        private static readonly Color ErrColor = Color.FromArgb(200, 42, 42);
        private static readonly Color ChipOn = Color.FromArgb(219, 232, 254);

        private readonly TrayContext _ctx;

        private Panel _pnlInput;
        private TextBox _txtInput;
        private TextBox _lblPreview;
        private FlowLayoutPanel _chips;
        private Panel _pnlDetail;
        private DateTimePicker _dtpDate;
        private DateTimePicker _dtpTime;
        private Label _lblRenotify;
        private Label _lblRenotify2;
        private NumericUpDown _numRenotify;
        private Button _btnAdd;
        private ListView _lv;
        private CheckBox _chkShowClosed;
        private TextBox _lblStats;
        private Button _btnSettings;

        private Button _selectedChip;
        private Func<DateTime> _chipFunc;
        private string _chipLabel;
        private bool _detailOpen;

        public MainForm(TrayContext ctx)
        {
            _ctx = ctx;

            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = "Todo 팝업 알림";
            Font = new Font("맑은 고딕", 9F);
            ClientSize = new Size(640, 540);
            MinimumSize = new Size(560, 420);
            StartPosition = FormStartPosition.CenterScreen;

            BuildUi();
            _ctx.TodosChanged += OnTodosChanged;
            _ctx.SettingsChanged += delegate
            {
                if (IsDisposed) return;
                int def = _ctx.Settings.DefaultRenotifyMinutes;
                if (def >= _numRenotify.Minimum && def <= _numRenotify.Maximum) _numRenotify.Value = def;
            };
            RefreshList();
        }

        protected override void WndProc(ref Message m)
        {
            if (Program.ShowMeMessage != 0 && m.Msg == Program.ShowMeMessage)
            {
                ShowMain();
            }
            else if (Program.ExitPleaseMessage != 0 && m.Msg == Program.ExitPleaseMessage)
            {
                // 다른 폴더의 복사본이 "자리를 넘겨 달라" 고 했다. 밖에서 이 앱을 곱게 끄는
                // 방법은 없다 — taskkill 은 창 닫기가 취소돼 아무 일도 안 하고, 강제 종료는
                // 저장 중인 것을 잃는다. 그래서 협조가 유일한 정상 경로다.
                _ctx.ExitForHandover();
            }
            base.WndProc(ref m);
        }

        private void BuildUi()
        {
            _pnlInput = new Panel();
            _pnlInput.Dock = DockStyle.Top;
            _pnlInput.Height = 144;
            _pnlInput.BackColor = Color.White;

            _txtInput = new TextBox();
            _txtInput.Font = new Font("맑은 고딕", 10.5F);
            _txtInput.Location = new Point(14, 14);
            _txtInput.Width = ClientSize.Width - 28;
            _txtInput.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            _txtInput.TextChanged += delegate { UpdatePreview(); };
            _txtInput.KeyDown += OnInputKeyDown;

            _lblPreview = SelectableText.Make(null, GrayText, _pnlInput.BackColor, false);
            _lblPreview.Location = new Point(16, 44);
            _lblPreview.Size = new Size(ClientSize.Width - 32, 18);
            _lblPreview.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            _lblPreview.Text = "예: \"내일 오후 3시 회의\", \"30분 뒤 스트레칭\" — 시간 표현을 자동 인식합니다";

            _chips = new FlowLayoutPanel();
            _chips.Location = new Point(12, 66);
            _chips.Size = new Size(ClientSize.Width - 24, 30);
            _chips.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            _chips.WrapContents = false;

            AddChip("30분 뒤", delegate { return DateTime.Now.AddMinutes(30); });
            AddChip("1시간 뒤", delegate { return DateTime.Now.AddHours(1); });
            AddChip("오늘 18:00", delegate { return DateTime.Today.AddHours(18); });
            AddChip("내일 09:00", delegate { return DateTime.Today.AddDays(1).AddHours(9); });

            Button chipCustom = MakeChipButton("직접 선택…");
            chipCustom.Click += delegate { ToggleDetail(!_detailOpen); };
            _chips.Controls.Add(chipCustom);

            _pnlDetail = new Panel();
            _pnlDetail.Location = new Point(14, 100);
            _pnlDetail.Size = new Size(ClientSize.Width - 28, 30);
            _pnlDetail.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            _pnlDetail.Visible = false;

            Label lblDate = new Label();
            lblDate.Text = "날짜";
            lblDate.ForeColor = GrayText;
            lblDate.Location = new Point(2, 7);
            lblDate.AutoSize = true;
            _pnlDetail.Controls.Add(lblDate);

            _dtpDate = new DateTimePicker();
            _dtpDate.Format = DateTimePickerFormat.Short;
            _dtpDate.Location = new Point(38, 3);
            _dtpDate.Width = 115;
            _dtpDate.ValueChanged += delegate { UpdatePreview(); };
            _pnlDetail.Controls.Add(_dtpDate);

            Label lblTime = new Label();
            lblTime.Text = "시간";
            lblTime.ForeColor = GrayText;
            lblTime.Location = new Point(168, 7);
            lblTime.AutoSize = true;
            _pnlDetail.Controls.Add(lblTime);

            _dtpTime = new DateTimePicker();
            _dtpTime.Format = DateTimePickerFormat.Time;
            _dtpTime.ShowUpDown = true;
            _dtpTime.Location = new Point(204, 3);
            _dtpTime.Width = 90;
            _dtpTime.ValueChanged += delegate { UpdatePreview(); };
            _pnlDetail.Controls.Add(_dtpTime);

            _lblRenotify = new Label();
            _lblRenotify.Text = "재알림 간격";
            _lblRenotify.ForeColor = GrayText;
            _lblRenotify.AutoSize = true;

            _numRenotify = new NumericUpDown();
            _numRenotify.Minimum = 1;
            _numRenotify.Maximum = 720;
            _numRenotify.Value = _ctx.Settings.DefaultRenotifyMinutes;
            _numRenotify.Width = 52;

            _lblRenotify2 = new Label();
            _lblRenotify2.Text = "분마다";
            _lblRenotify2.ForeColor = GrayText;
            _lblRenotify2.AutoSize = true;

            _btnAdd = new Button();
            _btnAdd.Text = "추가";
            _btnAdd.FlatStyle = FlatStyle.Flat;
            _btnAdd.FlatAppearance.BorderColor = AccentColor;
            _btnAdd.BackColor = AccentColor;
            _btnAdd.ForeColor = Color.White;
            _btnAdd.Size = new Size(88, 28);
            _btnAdd.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            _btnAdd.Click += delegate { AddFromInput(); };

            _pnlInput.Controls.Add(_txtInput);
            _pnlInput.Controls.Add(_lblPreview);
            _pnlInput.Controls.Add(_chips);
            _pnlInput.Controls.Add(_pnlDetail);
            _pnlInput.Controls.Add(_lblRenotify);
            _pnlInput.Controls.Add(_numRenotify);
            _pnlInput.Controls.Add(_lblRenotify2);
            _pnlInput.Controls.Add(_btnAdd);

            _lv = new ListView();
            _lv.View = View.Details;
            _lv.FullRowSelect = true;
            _lv.HideSelection = false;
            _lv.MultiSelect = false;
            _lv.Dock = DockStyle.Fill;
            _lv.Columns.Add("할 일", 270);
            _lv.Columns.Add("예정", 160);
            _lv.Columns.Add("재알림", 64);
            _lv.Columns.Add("상태", 90);
            _lv.Resize += delegate { FitColumns(); };
            _lv.DoubleClick += delegate { MarkSelected(TodoStatus.Done); };

            ContextMenuStrip cm = new ContextMenuStrip();
            ToolStripMenuItem miNotify = new ToolStripMenuItem("지금 알림");
            miNotify.Click += delegate
            {
                TodoItem t = SelectedTodo();
                if (t != null) _ctx.NotifyNow(t);
            };
            ToolStripMenuItem miDone = new ToolStripMenuItem("완료로 표시");
            miDone.Click += delegate { MarkSelected(TodoStatus.Done); };
            ToolStripMenuItem miCancel = new ToolStripMenuItem("취소로 표시");
            miCancel.Click += delegate { MarkSelected(TodoStatus.Cancelled); };
            ToolStripMenuItem miDelete = new ToolStripMenuItem("삭제");
            miDelete.Click += delegate { DeleteSelected(); };
            cm.Items.Add(miNotify);
            cm.Items.Add(miDone);
            cm.Items.Add(miCancel);
            cm.Items.Add(new ToolStripSeparator());
            cm.Items.Add(miDelete);
            cm.Opening += delegate
            {
                TodoItem t = SelectedTodo();
                bool pending = t != null && t.IsPending();
                miNotify.Enabled = pending;
                miDone.Enabled = pending;
                miCancel.Enabled = pending;
                miDelete.Enabled = t != null;
            };
            _lv.ContextMenuStrip = cm;

            Panel pnlBottom = new Panel();
            pnlBottom.Dock = DockStyle.Bottom;
            pnlBottom.Height = 38;

            _chkShowClosed = new CheckBox();
            _chkShowClosed.Text = "지난 항목 표시";
            _chkShowClosed.Location = new Point(14, 9);
            _chkShowClosed.AutoSize = true;
            _chkShowClosed.Checked = _ctx.Settings.ShowClosed;
            _chkShowClosed.CheckedChanged += delegate
            {
                _ctx.Settings.ShowClosed = _chkShowClosed.Checked;
                Storage.SaveSettings(_ctx.Settings);
                RefreshList();
            };
            pnlBottom.Controls.Add(_chkShowClosed);

            // 배경은 반드시 부모 막대에서 가져온다. 흰색을 손으로 적었더니
            // 회색 막대 위에 흰 상자가 떠 보였다(캡처로 확인).
            _lblStats = SelectableText.Make(null, GrayText, pnlBottom.BackColor, false);
            _lblStats.Location = new Point(140, 11);
            _lblStats.Size = new Size(320, 18);
            pnlBottom.Controls.Add(_lblStats);

            _btnSettings = new Button();
            _btnSettings.Text = "설정";
            _btnSettings.FlatStyle = FlatStyle.Flat;
            _btnSettings.FlatAppearance.BorderColor = Color.FromArgb(203, 206, 213);
            _btnSettings.Size = new Size(72, 26);
            _btnSettings.Location = new Point(ClientSize.Width - 86, 6);
            _btnSettings.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            _btnSettings.Click += delegate { _ctx.OpenSettings(); };
            pnlBottom.Controls.Add(_btnSettings);

            Controls.Add(_lv);
            Controls.Add(pnlBottom);
            Controls.Add(_pnlInput);
            Controls.Add(BuildRuntimeBanner());
            _lv.BringToFront();

            LayoutInputRow();
            FitColumns();
        }

        /// <summary>
        /// 좌상단 런타임 표시(작은 회색 글씨).
        ///
        /// 왜 있는가: ZIP 을 받아 실행했을 때 어느 판이 도는지 알 수가 없었다.
        /// node_modules 가 없으면 런처가 조용히 C# 판을 빌드해 띄우는데, 사용자는 그것을
        /// Electron 판으로 알고 "업데이트가 반영 안 됐다" 고 판단하게 된다. 실제로 그랬다.
        /// 그래서 런타임·빌드시각·node/npm 유무를 창에 그대로 적는다.
        /// </summary>
        private Panel BuildRuntimeBanner()
        {
            Panel bar = new Panel();
            bar.Dock = DockStyle.Top;
            bar.Height = 18;
            bar.BackColor = Color.FromArgb(248, 249, 251);

            TextBox lbl = SelectableText.Make(new Font("맑은 고딕", 7.5F),
                Color.FromArgb(140, 144, 152), bar.BackColor, false);
            lbl.Location = new Point(8, 2);
            lbl.Size = new Size(560, 14);

            // 런타임과 빌드 시각은 지금 당장 안다 — 이것만으로 "어느 판이 도는가" 는 답이 된다.
            string head = "런타임: C# (TodoPopup.exe) · 빌드 " + BuildStampOf();
            lbl.Text = head + " · node … · npm …";
            bar.Controls.Add(lbl);

            // node/npm 조회는 **UI 스레드에서 하면 안 된다**. cmd.exe 를 두 번 띄우는데
            // npm 은 Node 스크립트라 느린 기계에서 혼자 1~2초를 쓴다. 그 시간 동안 창이
            // 아예 안 떴고, 사용자에게는 "프로그램 구동에 2초 이상 걸린다" 로 보였다.
            // 배너는 진단용 곁다리지 시작을 붙들 이유가 없다 — 알아내면 그때 고쳐 쓴다.
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                string tail;
                try { tail = " · node " + ProbeVersion("node") + " · npm " + ProbeVersion("npm"); }
                catch { tail = " · node ? · npm ?"; }
                try
                {
                    if (lbl.IsDisposed) return;
                    lbl.BeginInvoke((MethodInvoker)delegate
                    {
                        if (!lbl.IsDisposed) lbl.Text = head + tail;
                    });
                }
                catch { } // 창이 그 사이에 닫혔다 — 진단 문구 하나 못 채운 것뿐이다
            });
            return bar;
        }

        private static string BuildStampOf()
        {
            try
            {
                string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(exe) && System.IO.File.Exists(exe))
                    return System.IO.File.GetLastWriteTime(exe).ToString("yyyyMMdd_HHmmss");
            }
            catch { }
            return "unknown";
        }

        /// <summary>node/npm 이 PATH 에 있는가. 없으면 "없음" — 그것이 곧 이 판이 도는 이유다.</summary>
        private static string ProbeVersion(string exeName)
        {
            try
            {
                System.Diagnostics.ProcessStartInfo psi =
                    new System.Diagnostics.ProcessStartInfo("cmd.exe", "/c " + exeName + " -v");
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (System.Diagnostics.Process pr = System.Diagnostics.Process.Start(psi))
                {
                    string outp = pr.StandardOutput.ReadToEnd();
                    pr.WaitForExit(2000);
                    outp = (outp ?? "").Trim();
                    if (pr.ExitCode != 0 || outp.Length == 0) return "없음";
                    return outp.Split(new char[] { '\n', '\r' })[0].Trim();
                }
            }
            catch { return "없음"; }
        }

        private void LayoutInputRow()
        {
            int y = _detailOpen ? 138 : 102;
            _lblRenotify.Location = new Point(16, y + 6);
            _numRenotify.Location = new Point(84, y + 2);
            _lblRenotify2.Location = new Point(140, y + 6);
            _btnAdd.Location = new Point(_pnlInput.ClientSize.Width - 14 - 88, y);
            _pnlInput.Height = y + 38;
        }

        private void FitColumns()
        {
            if (_lv.Columns.Count < 4) return;
            int w = _lv.ClientSize.Width - _lv.Columns[1].Width - _lv.Columns[2].Width - _lv.Columns[3].Width - 4;
            if (w < 120) w = 120;
            _lv.Columns[0].Width = w;
        }

        private void AddChip(string label, Func<DateTime> f)
        {
            Button b = MakeChipButton(label);
            b.Click += delegate
            {
                if (_selectedChip == b)
                {
                    ClearChip();
                }
                else
                {
                    ClearChip();
                    _selectedChip = b;
                    _chipFunc = f;
                    _chipLabel = label;
                    b.BackColor = ChipOn;
                    if (_detailOpen) ToggleDetail(false);
                }
                UpdatePreview();
            };
            _chips.Controls.Add(b);
        }

        private Button MakeChipButton(string label)
        {
            Button b = new Button();
            b.Text = label;
            b.AutoSize = true;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Color.FromArgb(203, 206, 213);
            b.BackColor = Color.White;
            b.ForeColor = Color.FromArgb(55, 58, 64);
            b.Margin = new Padding(0, 0, 6, 0);
            b.TabStop = false;
            return b;
        }

        private void ClearChip()
        {
            if (_selectedChip != null) _selectedChip.BackColor = Color.White;
            _selectedChip = null;
            _chipFunc = null;
            _chipLabel = null;
        }

        private void ToggleDetail(bool open)
        {
            _detailOpen = open;
            _pnlDetail.Visible = open;
            if (open)
            {
                DateTime init = DateTime.Now.AddHours(1);
                init = init.AddMinutes(-init.Minute).AddSeconds(-init.Second);
                _dtpDate.Value = init.Date;
                _dtpTime.Value = init;
                ClearChip();
            }
            LayoutInputRow();
            UpdatePreview();
        }

        private DateTime GetDetailTime()
        {
            return _dtpDate.Value.Date + new TimeSpan(_dtpTime.Value.Hour, _dtpTime.Value.Minute, 0);
        }

        private void OnInputKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.Handled = true;
                e.SuppressKeyPress = true;
                AddFromInput();
            }
        }

        // 우선순위: 자연어 > 직접 선택 > 칩
        private bool ResolveInput(out DateTime when, out string title, out string source)
        {
            when = DateTime.MinValue;
            source = null;
            string raw = _txtInput.Text.Trim();
            title = raw;
            NlpResult nr;
            try
            {
                nr = Nlp.Parse(raw, DateTime.Now);
            }
            catch
            {
                // 파서 예외는 "시간 인식 실패"로 취급 (타이핑 중 크래시 방지)
                nr = new NlpResult();
                nr.Title = raw;
            }
            if (nr.HasTime)
            {
                when = TimeUtil.SnapSeconds(nr.When, _ctx.Settings.TruncateSeconds);
                title = nr.Title;
                source = "문장에서 인식: " + nr.Matched;
                return true;
            }
            if (_detailOpen)
            {
                when = TimeUtil.SnapSeconds(GetDetailTime(), _ctx.Settings.TruncateSeconds);
                source = "직접 선택";
                return true;
            }
            if (_chipFunc != null)
            {
                when = TimeUtil.SnapSeconds(_chipFunc(), _ctx.Settings.TruncateSeconds);
                source = "칩: " + _chipLabel;
                return true;
            }
            return false;
        }

        private void UpdatePreview()
        {
            DateTime when;
            string title;
            string source;
            if (_txtInput.Text.Trim().Length == 0)
            {
                _lblPreview.ForeColor = GrayText;
                _lblPreview.Text = "예: \"내일 오후 3시 회의\", \"30분 뒤 스트레칭\" — 시간 표현을 자동 인식합니다";
                return;
            }
            if (!ResolveInput(out when, out title, out source))
            {
                _lblPreview.ForeColor = GrayText;
                _lblPreview.Text = "시간 없음 — 문장에 시간을 쓰거나 칩 또는 직접 선택을 사용하세요";
                return;
            }
            if (title.Length == 0)
            {
                _lblPreview.ForeColor = WarnColor;
                _lblPreview.Text = "할 일 내용을 입력하세요";
                return;
            }
            string warn = when <= DateTime.Now ? " — 지난 시간이라 즉시 알림됩니다" : "";
            _lblPreview.ForeColor = warn.Length > 0 ? WarnColor : GrayText;
            _lblPreview.Text = string.Format("알림 {0} ({1}) · {2}{3}",
                TimeUtil.FormatKorean(when), source, title, warn);
        }

        private void AddFromInput()
        {
            DateTime when;
            string title;
            string source;
            if (!ResolveInput(out when, out title, out source))
            {
                _lblPreview.ForeColor = ErrColor;
                _lblPreview.Text = "시간이 필요합니다 — 문장에 시간을 쓰거나 칩 또는 직접 선택을 사용하세요";
                return;
            }
            if (title.Length == 0)
            {
                _lblPreview.ForeColor = ErrColor;
                _lblPreview.Text = "할 일 내용을 입력하세요";
                return;
            }

            TodoItem t = new TodoItem();
            t.Title = title;
            t.SetDue(when);
            t.RenotifyMinutes = (int)_numRenotify.Value;
            _ctx.AddTodo(t);

            _txtInput.Text = "";
            ClearChip();
            if (_detailOpen) ToggleDetail(false);
            _lblPreview.ForeColor = OkColor;
            _lblPreview.Text = string.Format("추가됨: {0} — {1}", TimeUtil.FormatKorean(when), title);
            _txtInput.Focus();
        }

        private TodoItem SelectedTodo()
        {
            if (_lv.SelectedItems.Count == 0) return null;
            return _lv.SelectedItems[0].Tag as TodoItem;
        }

        private void MarkSelected(string status)
        {
            TodoItem t = SelectedTodo();
            if (t == null || !t.IsPending()) return;
            _ctx.SetTodoStatus(t, status);
        }

        private void DeleteSelected()
        {
            TodoItem t = SelectedTodo();
            if (t == null) return;
            DialogResult r = MessageBox.Show(this,
                string.Format("\"{0}\" 항목을 삭제할까요?", t.Title),
                "삭제 확인", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r == DialogResult.Yes) _ctx.DeleteTodo(t);
        }

        private void OnTodosChanged()
        {
            if (IsDisposed) return;
            RefreshList();
        }

        public void RefreshList()
        {
            DateTime now = DateTime.Now;
            string selectedId = null;
            TodoItem selected = SelectedTodo();
            if (selected != null) selectedId = selected.Id;

            _lv.BeginUpdate();
            _lv.Items.Clear();

            List<TodoItem> pending = _ctx.Todos.Where(delegate(TodoItem t) { return t.IsPending(); })
                .OrderBy(delegate(TodoItem t) { return t.GetDue(); }).ToList();
            foreach (TodoItem t in pending)
            {
                _lv.Items.Add(MakeRow(t, now));
            }

            int doneCount = _ctx.Todos.Count(delegate(TodoItem t) { return t.Status == TodoStatus.Done; });
            int cancelCount = _ctx.Todos.Count(delegate(TodoItem t) { return t.Status == TodoStatus.Cancelled; });

            if (_chkShowClosed.Checked)
            {
                List<TodoItem> closed = _ctx.Todos.Where(delegate(TodoItem t) { return !t.IsPending(); })
                    .OrderByDescending(delegate(TodoItem t) { return t.ClosedAt ?? ""; }).ToList();
                foreach (TodoItem t in closed)
                {
                    _lv.Items.Add(MakeRow(t, now));
                }
            }

            _lblStats.Text = string.Format("대기 {0} · 완료 {1} · 취소 {2}", pending.Count, doneCount, cancelCount);

            // 자동 갱신이 사용자의 선택을 지우지 않도록 복원
            if (selectedId != null)
            {
                foreach (ListViewItem it in _lv.Items)
                {
                    TodoItem tt = it.Tag as TodoItem;
                    if (tt != null && tt.Id == selectedId)
                    {
                        it.Selected = true;
                        break;
                    }
                }
            }
            _lv.EndUpdate();
        }

        private ListViewItem MakeRow(TodoItem t, DateTime now)
        {
            DateTime due = t.GetDue();
            string dueText = due == DateTime.MinValue ? "-" : TimeUtil.FormatListDate(due, now);
            string status;
            Color color = Color.FromArgb(32, 33, 36);

            if (t.Status == TodoStatus.Done)
            {
                status = "완료";
                color = Color.FromArgb(150, 154, 162);
            }
            else if (t.Status == TodoStatus.Cancelled)
            {
                status = "취소";
                color = Color.FromArgb(150, 154, 162);
            }
            else if (due > now)
            {
                status = "대기";
            }
            else
            {
                DateTime sn = t.GetSnooze();
                if (_ctx.IsPopupOpen(t.Id))
                {
                    status = "알림중";
                    color = WarnColor;
                }
                else if (sn != DateTime.MinValue && sn > now)
                {
                    status = string.Format("미룸 {0:00}:{1:00}", sn.Hour, sn.Minute);
                    color = WarnColor;
                }
                else
                {
                    status = "알림중";
                    color = WarnColor;
                }
            }

            ListViewItem it = new ListViewItem(t.Title);
            it.SubItems.Add(dueText);
            it.SubItems.Add(string.Format("{0}분", t.RenotifyMinutes));
            it.SubItems.Add(status);
            it.ForeColor = color;
            it.Tag = t;
            return it;
        }

        public void ShowMain()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
            RefreshList();
            _txtInput.Focus();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            base.OnFormClosing(e);
        }
    }
}
