using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Media;
using System.Windows.Forms;

namespace TodoPopup
{
    public class TrayContext : ApplicationContext
    {
        private NotifyIcon _tray;
        private Timer _timer;
        private MainForm _mainForm;
        private SettingsForm _settingsForm;
        private readonly Dictionary<string, PopupForm> _popups = new Dictionary<string, PopupForm>();
        private List<TodoItem> _todos;
        private AppSettings _settings;
        private Icon _icon;

        public event Action TodosChanged;
        public event Action SettingsChanged;

        public AppSettings Settings { get { return _settings; } }
        public List<TodoItem> Todos { get { return _todos; } }

        public TrayContext(bool testPopup)
        {
            _todos = Storage.LoadTodos();
            _settings = Storage.LoadSettings();

            _mainForm = new MainForm(this);
            IntPtr forceHandle = _mainForm.Handle; // 다른 인스턴스의 브로드캐스트 수신용

            _icon = CreateIcon();
            _tray = new NotifyIcon();
            _tray.Icon = _icon;
            _tray.Text = "Todo 팝업 알림";
            _tray.Visible = true;
            _tray.DoubleClick += delegate { ShowMain(); };

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("새 일정 추가", null, delegate { ShowMain(); });
            menu.Items.Add("목록 열기", null, delegate { ShowMain(); });
            menu.Items.Add("설정", null, delegate { OpenSettings(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("종료", null, delegate { ExitApp(); });
            _tray.ContextMenuStrip = menu;

            _timer = new Timer();
            _timer.Interval = 5000;
            _timer.Tick += delegate { Tick(); };
            _timer.Start();

            if (testPopup)
            {
                ShowPreview(_settings);
            }

            Tick();
        }

        private void Tick()
        {
            DateTime now = DateTime.Now;
            List<TodoItem> due = new List<TodoItem>();
            foreach (TodoItem t in _todos)
            {
                if (!t.IsPending()) continue;
                DateTime d = t.GetDue();
                if (d == DateTime.MinValue) continue;
                if (now < d) continue;
                DateTime sn = t.GetSnooze();
                if (sn != DateTime.MinValue && now < sn) continue;
                if (_popups.ContainsKey(t.Id)) continue;
                due.Add(t);
            }
            foreach (TodoItem t in due)
            {
                ShowPopupWith(t, false, _settings);
            }
            if (due.Count > 0) RaiseChanged();
        }

        private void ShowPopupWith(TodoItem todo, bool isPreview, AppSettings st)
        {
            // 열린 팝업들이 점유하지 않은 가장 낮은 슬롯을 배정한다.
            // (_popups.Count를 쓰면 먼저 닫힌 슬롯이 재사용되지 않아 기존 팝업과 겹친다.)
            HashSet<int> used = new HashSet<int>();
            foreach (PopupForm p in _popups.Values) used.Add(p.Slot);
            int index = 0;
            while (used.Contains(index)) index++;

            if (!isPreview)
            {
                todo.NotifyCount = todo.NotifyCount + 1;
                Storage.SaveTodos(_todos);
            }
            // 화면마다 하나씩 띄운다. 한 화면만 띄우면 그 모니터를 안 보고 있을 때 알림을
            // 놓친다 — "완료·취소 전까지 계속 알린다" 는 약속이 거기서 조용히 깨진다.
            Screen[] targets = st.PopupAllMonitors
                ? Screen.AllScreens
                : new Screen[] { Screen.PrimaryScreen };
            if (targets == null || targets.Length == 0) targets = new Screen[] { Screen.PrimaryScreen };

            string id = todo.Id;
            List<PopupForm> twins = new List<PopupForm>();
            PopupForm first = null;

            // 한 화면의 창이 닫히면 그 알림은 끝난 것이다 — 나머지 화면의 쌍둥이도 함께
            // 닫는다. 안 그러면 다른 모니터에 유령 팝업이 남아 버튼이 두 번 눌린다.
            // 그 일과 **재귀 차단**은 PopupGroup 이 맡는다(왜인지는 그 파일 머리주석에).
            PopupGroup group = new PopupGroup();

            foreach (Screen sc in targets)
            {
                PopupForm pf = new PopupForm(todo, st, isPreview);
                pf.Slot = index;
                pf.Location = ComputePopupLocation(st, pf.Size, index, sc);
                pf.ActionChosen += OnPopupAction;
                twins.Add(pf);
                if (first == null) first = pf;
                group.Add(pf);
            }

            PopupForm firstOfGroup = first;
            group.Finished = delegate
            {
                PopupForm cur;
                if (_popups.TryGetValue(id, out cur) && cur == firstOfGroup)
                {
                    _popups.Remove(id);
                    RaiseChanged(); // 목록의 '알림중' 상태 즉시 갱신
                }
            };

            _popups[id] = first;
            foreach (PopupForm pf in twins) pf.Show();
            // DPI 자동 스케일로 실제 크기가 바뀔 수 있으므로 표시 후 위치를 재보정
            for (int i = 0; i < twins.Count; i++)
            {
                twins[i].Location = ComputePopupLocation(st, twins[i].Size, index, targets[i]);
            }
            if (st.PlaySound)
            {
                try { SystemSounds.Exclamation.Play(); }
                catch { }
            }
        }

        private static Point ComputePopupLocation(AppSettings st, Size size, int index, Screen screen)
        {
            Rectangle wa = (screen ?? Screen.PrimaryScreen).WorkingArea;
            int margin = 16;
            int step = size.Height + 8;
            int x, y;
            switch (st.Position)
            {
                case "bottom-left":
                    x = wa.Left + margin;
                    y = wa.Bottom - size.Height - margin - index * step;
                    break;
                case "bottom-right":
                    x = wa.Right - size.Width - margin;
                    y = wa.Bottom - size.Height - margin - index * step;
                    break;
                case "center":
                    x = wa.Left + (wa.Width - size.Width) / 2;
                    y = wa.Top + (wa.Height - size.Height) / 2 + index * step;
                    break;
                case "top-center":
                    x = wa.Left + (wa.Width - size.Width) / 2;
                    y = wa.Top + margin + index * step;
                    break;
                default: // bottom-center
                    x = wa.Left + (wa.Width - size.Width) / 2;
                    y = wa.Bottom - size.Height - margin - index * step;
                    break;
            }
            if (y < wa.Top + margin) y = wa.Top + margin;
            if (y + size.Height > wa.Bottom - margin) y = wa.Bottom - size.Height - margin;
            if (x < wa.Left + margin) x = wa.Left + margin;
            if (x + size.Width > wa.Right - margin) x = wa.Right - size.Width - margin;
            return new Point(x, y);
        }

        private void OnPopupAction(PopupForm pf, TodoItem todo, PopupAction action, int minutes)
        {
            if (pf.IsPreview) return;
            DateTime now = DateTime.Now;
            switch (action)
            {
                case PopupAction.Ack:
                    todo.SetSnooze(TimeUtil.SnapSeconds(now.AddMinutes(todo.RenotifyMinutes), _settings.TruncateSeconds));
                    break;
                case PopupAction.Snooze:
                    todo.SetSnooze(TimeUtil.SnapSeconds(now.AddMinutes(minutes), _settings.TruncateSeconds));
                    break;
                case PopupAction.Done:
                    todo.Status = TodoStatus.Done;
                    todo.ClosedAt = TimeUtil.ToRfc3339(now);
                    break;
                case PopupAction.Cancel:
                    todo.Status = TodoStatus.Cancelled;
                    todo.ClosedAt = TimeUtil.ToRfc3339(now);
                    break;
            }
            Storage.SaveTodos(_todos);
            RaiseChanged();
        }

        // ---- MainForm/SettingsForm에서 쓰는 API ----

        public void AddTodo(TodoItem t)
        {
            _todos.Add(t);
            Storage.SaveTodos(_todos);
            RaiseChanged();
            Tick();
        }

        public void SetTodoStatus(TodoItem t, string status)
        {
            t.Status = status;
            if (status != TodoStatus.Pending) t.ClosedAt = TimeUtil.ToRfc3339(DateTime.Now);
            CloseIfOpen(t.Id);
            Storage.SaveTodos(_todos);
            RaiseChanged();
        }

        public void DeleteTodo(TodoItem t)
        {
            CloseIfOpen(t.Id);
            _todos.Remove(t);
            Storage.SaveTodos(_todos);
            RaiseChanged();
        }

        public void NotifyNow(TodoItem t)
        {
            if (!t.IsPending()) return;
            t.ClearSnooze();
            Storage.SaveTodos(_todos);
            if (!_popups.ContainsKey(t.Id))
            {
                ShowPopupWith(t, false, _settings);
            }
            RaiseChanged();
        }

        public bool IsPopupOpen(string id)
        {
            return _popups.ContainsKey(id);
        }

        private void CloseIfOpen(string id)
        {
            PopupForm pf;
            if (_popups.TryGetValue(id, out pf))
            {
                _popups.Remove(id);
                try { pf.Close(); }
                catch { }
            }
        }

        public void ApplySettings(AppSettings s)
        {
            s.Clamp();
            _settings = s;
            Storage.SaveSettings(s);
            Action h = SettingsChanged;
            if (h != null) h();
        }

        public void SaveTodosNow()
        {
            Storage.SaveTodos(_todos);
        }

        public void ShowPreview(AppSettings st)
        {
            TodoItem t = new TodoItem();
            t.Id = "preview-" + Guid.NewGuid().ToString("N");
            t.Title = "미리보기 알림입니다";
            t.SetDue(DateTime.Now);
            t.NotifyCount = 1;
            t.RenotifyMinutes = st.DefaultRenotifyMinutes;
            ShowPopupWith(t, true, st);
        }

        public void ShowMain()
        {
            _mainForm.ShowMain();
        }

        public void OpenSettings()
        {
            if (_settingsForm != null && !_settingsForm.IsDisposed)
            {
                _settingsForm.Activate();
                return;
            }
            _settingsForm = new SettingsForm(this);
            _settingsForm.FormClosed += delegate { _settingsForm = null; };
            _settingsForm.Show();
        }

        /// <summary>다른 복사본이 자리를 이어받는다. 트레이 아이콘까지 확실히 걷고 나간다.</summary>
        public void ExitForHandover()
        {
            ExitApp();
        }

        /// <summary>
        /// 종료 요청을 받을 창의 핸들. 명패에 적어 두면 상대가 브로드캐스트 대신
        /// 이 창을 콕 집어 부를 수 있다.
        /// </summary>
        public IntPtr MessageWindowHandle
        {
            get { return _mainForm != null ? _mainForm.Handle : IntPtr.Zero; }
        }

        private void ExitApp()
        {
            _timer.Stop();
            _tray.Visible = false;
            _tray.Dispose();
            ExitThread();
        }

        private void RaiseChanged()
        {
            Action h = TodosChanged;
            if (h != null) h();
        }

        private static Icon CreateIcon()
        {
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush b = new SolidBrush(Color.FromArgb(37, 99, 235)))
                {
                    g.FillEllipse(b, 1, 1, 30, 30);
                }
                using (Pen p = new Pen(Color.White, 4f))
                {
                    p.StartCap = LineCap.Round;
                    p.EndCap = LineCap.Round;
                    g.DrawLine(p, 8, 17, 14, 22);
                    g.DrawLine(p, 14, 22, 24, 10);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }
}
