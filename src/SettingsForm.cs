using System;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TodoPopup
{
    public class SettingsForm : Form
    {
        private static readonly Color GrayText = Color.FromArgb(96, 100, 110);
        private static readonly Color AccentColor = Color.FromArgb(37, 99, 235);

        private const string RunKeyPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        private const string RunValueName = "TodoPopup";

        private static readonly string[] PositionCodes =
            { "bottom-center", "bottom-left", "bottom-right", "center", "top-center" };
        private static readonly string[] PositionNames =
            { "중앙 하단", "좌측 하단", "우측 하단", "화면 중앙", "중앙 상단" };

        private readonly TrayContext _ctx;

        private ComboBox _cbPosition;
        private TrackBar _tbOpacity;
        private Label _lblOpacityVal;
        private NumericUpDown _numW;
        private NumericUpDown _numH;
        private NumericUpDown _numRenotify;
        private NumericUpDown _numSnooze;
        private CheckBox _chkSound;
        private CheckBox _chkAutostart;

        public SettingsForm(TrayContext ctx)
        {
            _ctx = ctx;

            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = "설정";
            Font = new Font("맑은 고딕", 9F);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(400, 356);
            StartPosition = FormStartPosition.CenterScreen;

            AppSettings s = _ctx.Settings;
            int y = 16;

            _cbPosition = new ComboBox();
            _cbPosition.DropDownStyle = ComboBoxStyle.DropDownList;
            _cbPosition.Items.AddRange(PositionNames);
            int posIdx = Array.IndexOf(PositionCodes, s.Position);
            _cbPosition.SelectedIndex = posIdx >= 0 ? posIdx : 0;
            _cbPosition.Width = 130;
            AddRow("팝업 위치", _cbPosition, ref y);

            Panel opacityPanel = new Panel();
            opacityPanel.Size = new Size(240, 32);
            _tbOpacity = new TrackBar();
            _tbOpacity.Minimum = 30;
            _tbOpacity.Maximum = 100;
            _tbOpacity.TickFrequency = 10;
            _tbOpacity.Value = (int)Math.Round(s.Opacity * 100);
            _tbOpacity.Location = new Point(0, 0);
            _tbOpacity.Size = new Size(190, 32);
            _lblOpacityVal = new Label();
            _lblOpacityVal.Location = new Point(196, 6);
            _lblOpacityVal.AutoSize = true;
            _lblOpacityVal.Text = _tbOpacity.Value + "%";
            _tbOpacity.ValueChanged += delegate { _lblOpacityVal.Text = _tbOpacity.Value + "%"; };
            opacityPanel.Controls.Add(_tbOpacity);
            opacityPanel.Controls.Add(_lblOpacityVal);
            AddRow("투명도", opacityPanel, ref y);

            Panel sizePanel = new Panel();
            sizePanel.Size = new Size(240, 26);
            _numW = MakeNum(260, 900, s.PopupWidth);
            _numW.Location = new Point(0, 2);
            Label lblX = new Label();
            lblX.Text = "×";
            lblX.ForeColor = GrayText;
            lblX.Location = new Point(64, 6);
            lblX.AutoSize = true;
            _numH = MakeNum(130, 500, s.PopupHeight);
            _numH.Location = new Point(84, 2);
            Label lblPx = new Label();
            lblPx.Text = "픽셀 (너비×높이)";
            lblPx.ForeColor = GrayText;
            lblPx.Location = new Point(150, 6);
            lblPx.AutoSize = true;
            sizePanel.Controls.Add(_numW);
            sizePanel.Controls.Add(lblX);
            sizePanel.Controls.Add(_numH);
            sizePanel.Controls.Add(lblPx);
            AddRow("팝업 크기", sizePanel, ref y);

            Panel renotifyPanel = MakeMinutePanel(out _numRenotify, s.DefaultRenotifyMinutes, "분마다 다시 알림");
            AddRow("기본 재알림", renotifyPanel, ref y);

            Panel snoozePanel = MakeMinutePanel(out _numSnooze, s.DefaultSnoozeMinutes, "분 (팝업의 미루기 버튼)");
            AddRow("기본 미루기", snoozePanel, ref y);

            _chkSound = new CheckBox();
            _chkSound.Text = "알림음 재생";
            _chkSound.Checked = s.PlaySound;
            _chkSound.AutoSize = true;
            AddRow("소리", _chkSound, ref y);

            _chkAutostart = new CheckBox();
            _chkAutostart.Text = "윈도우 시작 시 자동 실행";
            _chkAutostart.Checked = IsAutostartEnabled();
            _chkAutostart.AutoSize = true;
            AddRow("시작", _chkAutostart, ref y);

            Button btnPreview = new Button();
            btnPreview.Text = "미리보기";
            btnPreview.FlatStyle = FlatStyle.Flat;
            btnPreview.FlatAppearance.BorderColor = Color.FromArgb(203, 206, 213);
            btnPreview.Size = new Size(88, 30);
            btnPreview.Location = new Point(16, y + 10);
            btnPreview.Click += delegate { _ctx.ShowPreview(Collect()); };

            Button btnSave = new Button();
            btnSave.Text = "저장";
            btnSave.FlatStyle = FlatStyle.Flat;
            btnSave.FlatAppearance.BorderColor = AccentColor;
            btnSave.BackColor = AccentColor;
            btnSave.ForeColor = Color.White;
            btnSave.Size = new Size(80, 30);
            btnSave.Location = new Point(ClientSize.Width - 184, y + 10);
            btnSave.Click += delegate { SaveAndClose(); };

            Button btnClose = new Button();
            btnClose.Text = "닫기";
            btnClose.FlatStyle = FlatStyle.Flat;
            btnClose.FlatAppearance.BorderColor = Color.FromArgb(203, 206, 213);
            btnClose.Size = new Size(80, 30);
            btnClose.Location = new Point(ClientSize.Width - 96, y + 10);
            btnClose.Click += delegate { Close(); };

            Controls.Add(btnPreview);
            Controls.Add(btnSave);
            Controls.Add(btnClose);
        }

        private Panel MakeMinutePanel(out NumericUpDown num, int value, string suffix)
        {
            Panel p = new Panel();
            p.Size = new Size(260, 26);
            num = MakeNum(1, 720, value);
            num.Location = new Point(0, 2);
            Label lbl = new Label();
            lbl.Text = suffix;
            lbl.ForeColor = GrayText;
            lbl.Location = new Point(66, 6);
            lbl.AutoSize = true;
            p.Controls.Add(num);
            p.Controls.Add(lbl);
            return p;
        }

        private static NumericUpDown MakeNum(int min, int max, int value)
        {
            NumericUpDown n = new NumericUpDown();
            n.Minimum = min;
            n.Maximum = max;
            if (value < min) value = min;
            if (value > max) value = max;
            n.Value = value;
            n.Width = 60;
            return n;
        }

        private void AddRow(string label, Control control, ref int y)
        {
            Label lbl = new Label();
            lbl.Text = label;
            lbl.ForeColor = GrayText;
            lbl.Location = new Point(16, y + 4);
            lbl.AutoSize = true;
            control.Location = new Point(120, y);
            Controls.Add(lbl);
            Controls.Add(control);
            y += control.Height > 30 ? control.Height + 8 : 36;
        }

        private AppSettings Collect()
        {
            AppSettings s = new AppSettings();
            int idx = _cbPosition.SelectedIndex;
            s.Position = (idx >= 0 && idx < PositionCodes.Length) ? PositionCodes[idx] : "bottom-center";
            s.Opacity = _tbOpacity.Value / 100.0;
            s.PopupWidth = (int)_numW.Value;
            s.PopupHeight = (int)_numH.Value;
            s.DefaultRenotifyMinutes = (int)_numRenotify.Value;
            s.DefaultSnoozeMinutes = (int)_numSnooze.Value;
            s.PlaySound = _chkSound.Checked;
            s.ShowClosed = _ctx.Settings.ShowClosed;
            s.Clamp();
            return s;
        }

        private void SaveAndClose()
        {
            _ctx.ApplySettings(Collect());
            try
            {
                SetAutostart(_chkAutostart.Checked);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "자동 실행 설정 변경에 실패했습니다: " + ex.Message,
                    "설정", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            Close();
        }

        private static bool IsAutostartEnabled()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKeyPath))
                {
                    return k != null && k.GetValue(RunValueName) != null;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void SetAutostart(bool enable)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKeyPath))
            {
                if (k == null) return;
                if (enable)
                {
                    k.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"");
                }
                else if (k.GetValue(RunValueName) != null)
                {
                    k.DeleteValue(RunValueName, false);
                }
            }
        }
    }
}
