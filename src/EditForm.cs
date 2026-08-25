using System;
using System.Drawing;
using System.Windows.Forms;

namespace TodoPopup
{
    /// <summary>
    /// 이미 있는 일정을 고친다.
    ///
    /// 왜 있는가
    ///   여기에는 추가와 삭제만 있었다. 제목의 오타 하나, 30분 밀린 회의 하나를 고치려면
    ///   지우고 다시 넣어야 했고 그 과정에서 재알림 횟수와 원래 id 가 사라졌다.
    ///   같은 항목을 계속 들고 가려면 고치는 길이 있어야 한다.
    ///
    /// 무엇을 고치지 않는가
    ///   상태(대기·완료·취소)와 삭제는 여기에 두지 않는다. 목록의 오른쪽 클릭 메뉴가
    ///   이미 그 일을 하고, 되돌릴 수 없는 것과 고치는 것을 한 화면에 섞으면 실수가 난다.
    /// </summary>
    internal class EditForm : Form
    {
        private static readonly Color GrayText = Color.FromArgb(96, 100, 110);
        private static readonly Color AccentColor = Color.FromArgb(37, 99, 235);

        private readonly TodoItem _todo;

        private TextBox _txtTitle;
        private DateTimePicker _dtpDate;
        private DateTimePicker _dtpTime;
        private NumericUpDown _numRenotify;
        private Label _lblWarn;

        /// <summary>저장을 눌렀는가.</summary>
        public bool Saved;

        public string ResultTitle { get { return _txtTitle.Text.Trim(); } }
        public DateTime ResultDue
        {
            get
            {
                return _dtpDate.Value.Date
                    .AddHours(_dtpTime.Value.Hour)
                    .AddMinutes(_dtpTime.Value.Minute);
            }
        }
        public int ResultRenotify { get { return (int)_numRenotify.Value; } }

        public EditForm(TodoItem todo, AppSettings settings)
        {
            _todo = todo;

            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = "일정 편집";
            Font = new Font("맑은 고딕", 9F);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(430, 214);
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.White;
            KeyPreview = true;

            int y = 18;

            _txtTitle = new TextBox();
            _txtTitle.Font = new Font("맑은 고딕", 10.5F);
            _txtTitle.Width = 290;
            _txtTitle.Text = todo.Title;
            _txtTitle.TextChanged += delegate { Revalidate(); };
            AddRow("할 일", _txtTitle, ref y);

            DateTime due = todo.GetDue();
            if (due == DateTime.MinValue) due = DateTime.Now;

            Panel when = new Panel();
            when.Size = new Size(292, 26);

            _dtpDate = new DateTimePicker();
            _dtpDate.Format = DateTimePickerFormat.Short;
            _dtpDate.Width = 130;
            _dtpDate.Location = new Point(0, 0);
            _dtpDate.Value = due.Date;
            _dtpDate.ValueChanged += delegate { Revalidate(); };
            when.Controls.Add(_dtpDate);

            _dtpTime = new DateTimePicker();
            _dtpTime.Format = DateTimePickerFormat.Time;
            _dtpTime.ShowUpDown = true;
            _dtpTime.Width = 100;
            _dtpTime.Location = new Point(140, 0);
            _dtpTime.Value = due;
            _dtpTime.ValueChanged += delegate { Revalidate(); };
            when.Controls.Add(_dtpTime);

            AddRow("예정", when, ref y);

            Panel renotify = new Panel();
            renotify.Size = new Size(292, 26);

            _numRenotify = new NumericUpDown();
            _numRenotify.Minimum = 1;
            _numRenotify.Maximum = 720;
            _numRenotify.Width = 60;
            int rn = todo.RenotifyMinutes;
            if (rn < _numRenotify.Minimum) rn = settings.DefaultRenotifyMinutes;
            if (rn > _numRenotify.Maximum) rn = (int)_numRenotify.Maximum;
            _numRenotify.Value = rn;
            renotify.Controls.Add(_numRenotify);

            Label lblMin = new Label();
            lblMin.Text = "분마다 다시 알림";
            lblMin.ForeColor = GrayText;
            lblMin.Location = new Point(68, 4);
            lblMin.AutoSize = true;
            renotify.Controls.Add(lblMin);

            AddRow("재알림", renotify, ref y);

            _lblWarn = new Label();
            _lblWarn.ForeColor = Color.FromArgb(202, 96, 12);
            _lblWarn.Location = new Point(16, y + 2);
            _lblWarn.AutoSize = true;
            Controls.Add(_lblWarn);
            y += 24;

            Button btnSave = new Button();
            btnSave.Text = "저장";
            btnSave.FlatStyle = FlatStyle.Flat;
            btnSave.FlatAppearance.BorderColor = AccentColor;
            btnSave.BackColor = AccentColor;
            btnSave.ForeColor = Color.White;
            btnSave.Size = new Size(80, 30);
            btnSave.Location = new Point(ClientSize.Width - 184, y);
            btnSave.Click += delegate { Commit(); };
            Controls.Add(btnSave);
            AcceptButton = btnSave;

            Button btnCancel = new Button();
            btnCancel.Text = "취소";
            btnCancel.FlatStyle = FlatStyle.Flat;
            btnCancel.FlatAppearance.BorderColor = Color.FromArgb(203, 206, 213);
            btnCancel.Size = new Size(80, 30);
            btnCancel.Location = new Point(ClientSize.Width - 96, y);
            btnCancel.Click += delegate { Close(); };
            Controls.Add(btnCancel);
            CancelButton = btnCancel;

            Revalidate();
            _txtTitle.SelectAll();
        }

        private void AddRow(string label, Control control, ref int y)
        {
            Label lbl = new Label();
            lbl.Text = label;
            lbl.ForeColor = GrayText;
            lbl.Location = new Point(16, y + 4);
            lbl.AutoSize = true;
            control.Location = new Point(104, y);
            Controls.Add(lbl);
            Controls.Add(control);
            y += 40;
        }

        /// <summary>지난 시각으로 옮기면 곧 울린다 — 저장하기 전에 말해 준다.</summary>
        private void Revalidate()
        {
            if (_lblWarn == null) return;
            if (_txtTitle.Text.Trim().Length == 0)
            {
                _lblWarn.Text = "할 일 내용을 입력하세요";
                return;
            }
            if (_todo.IsPending() && ResultDue <= DateTime.Now)
            {
                _lblWarn.Text = "지난 시각이라 저장하면 곧 알림이 뜹니다";
                return;
            }
            _lblWarn.Text = "";
        }

        private void Commit()
        {
            if (_txtTitle.Text.Trim().Length == 0)
            {
                _txtTitle.Focus();
                return;
            }
            Saved = true;
            Close();
        }
    }
}
