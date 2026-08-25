using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.Serialization;

namespace TodoPopup
{
    // 로컬 상태값. 구글 캘린더 event.status(confirmed/cancelled)와 별개로
    // extendedProperties.private.todoStatus 에 저장된다.
    public static class TodoStatus
    {
        public const string Pending = "pending";
        public const string Done = "done";
        public const string Cancelled = "cancelled";
    }

    // ---- 구글 캘린더 Event 리소스와 호환되는 스키마 ----

    // IExtensibleDataObject: 구글 캘린더 JSON에 있는 우리가 모르는 필드도
    // 로드→저장 왕복에서 유실되지 않도록 보존한다.
    [DataContract]
    public class EventTime : IExtensibleDataObject
    {
        [DataMember(Name = "dateTime", EmitDefaultValue = false)] public string RawDateTime;
        [DataMember(Name = "date", EmitDefaultValue = false)] public string Date;
        [DataMember(Name = "timeZone", EmitDefaultValue = false)] public string TimeZone;
        public ExtensionDataObject ExtensionData { get; set; }
    }

    [DataContract]
    public class ReminderOverride : IExtensibleDataObject
    {
        [DataMember(Name = "method")] public string Method;
        [DataMember(Name = "minutes")] public int Minutes;
        public ExtensionDataObject ExtensionData { get; set; }
    }

    [DataContract]
    public class EventReminders : IExtensibleDataObject
    {
        [DataMember(Name = "useDefault")] public bool UseDefault;
        [DataMember(Name = "overrides", EmitDefaultValue = false)] public List<ReminderOverride> Overrides;
        public ExtensionDataObject ExtensionData { get; set; }
    }

    [DataContract]
    public class PrivateProps : IExtensibleDataObject
    {
        [DataMember(Name = "todoStatus", EmitDefaultValue = false)] public string TodoStatus;
        [DataMember(Name = "renotifyMinutes", EmitDefaultValue = false)] public string RenotifyMinutes;
        [DataMember(Name = "snoozeUntil", EmitDefaultValue = false)] public string SnoozeUntil;
        [DataMember(Name = "notifyCount", EmitDefaultValue = false)] public string NotifyCount;
        [DataMember(Name = "closedAt", EmitDefaultValue = false)] public string ClosedAt;
        public ExtensionDataObject ExtensionData { get; set; }
    }

    [DataContract]
    public class ExtendedProps : IExtensibleDataObject
    {
        [DataMember(Name = "private", EmitDefaultValue = false)] public PrivateProps Private;
        public ExtensionDataObject ExtensionData { get; set; }
    }

    [DataContract]
    public class TodoItem : IExtensibleDataObject
    {
        public ExtensionDataObject ExtensionData { get; set; }

        [DataMember(Name = "kind", EmitDefaultValue = false)] public string Kind;
        [DataMember(Name = "id")] public string Id;
        [DataMember(Name = "status", EmitDefaultValue = false)] public string EventStatus;
        [DataMember(Name = "summary")] public string Summary;
        [DataMember(Name = "description", EmitDefaultValue = false)] public string Description;
        [DataMember(Name = "created", EmitDefaultValue = false)] public string Created;
        [DataMember(Name = "updated", EmitDefaultValue = false)] public string Updated;
        [DataMember(Name = "start")] public EventTime Start;
        [DataMember(Name = "end", EmitDefaultValue = false)] public EventTime End;
        [DataMember(Name = "reminders", EmitDefaultValue = false)] public EventReminders Reminders;
        [DataMember(Name = "extendedProperties", EmitDefaultValue = false)] public ExtendedProps ExtendedProperties;

        public TodoItem()
        {
            Kind = "calendar#event";
            Id = Guid.NewGuid().ToString("N");
            EventStatus = "confirmed";
            Summary = "";
            Created = TimeUtil.ToRfc3339(DateTime.Now);
            Updated = Created;
            Start = new EventTime();
            Reminders = new EventReminders
            {
                UseDefault = false,
                Overrides = new List<ReminderOverride> { new ReminderOverride { Method = "popup", Minutes = 0 } }
            };
            PrivateProps p = P();
            p.TodoStatus = TodoStatus.Pending;
            p.RenotifyMinutes = "5";
            p.NotifyCount = "0";
        }

        // 역직렬화는 생성자를 거치지 않으므로 항상 이 접근자로 확장 속성에 접근한다.
        private PrivateProps P()
        {
            if (ExtendedProperties == null) ExtendedProperties = new ExtendedProps();
            if (ExtendedProperties.Private == null) ExtendedProperties.Private = new PrivateProps();
            return ExtendedProperties.Private;
        }

        // ---- 앱 내부용 접근자 (직렬화 제외) ----

        public string Title
        {
            get { return Summary ?? ""; }
            set { Summary = value; }
        }

        public string Status
        {
            get
            {
                string s = P().TodoStatus;
                if (!string.IsNullOrEmpty(s)) return s;
                if (EventStatus == "cancelled") return TodoStatus.Cancelled;
                return TodoStatus.Pending;
            }
            set
            {
                P().TodoStatus = value;
                EventStatus = (value == TodoStatus.Cancelled) ? "cancelled" : "confirmed";
                Touch();
            }
        }

        public DateTime GetDue()
        {
            if (Start == null) return DateTime.MinValue;
            if (!string.IsNullOrEmpty(Start.RawDateTime)) return TimeUtil.FromRfc3339(Start.RawDateTime);
            if (!string.IsNullOrEmpty(Start.Date)) return TimeUtil.FromRfc3339(Start.Date);
            return DateTime.MinValue;
        }

        public void SetDue(DateTime dt)
        {
            if (Start == null) Start = new EventTime();
            Start.RawDateTime = TimeUtil.ToRfc3339(dt);
            Start.Date = null;
            if (End == null) End = new EventTime();
            End.RawDateTime = TimeUtil.ToRfc3339(dt.AddMinutes(30));
            End.Date = null;
            Touch();
        }

        public int RenotifyMinutes
        {
            get
            {
                int n;
                if (int.TryParse(P().RenotifyMinutes, out n) && n >= 1) return n;
                return 5;
            }
            set { P().RenotifyMinutes = value.ToString(CultureInfo.InvariantCulture); }
        }

        public DateTime GetSnooze()
        {
            return TimeUtil.FromRfc3339(P().SnoozeUntil);
        }

        public void SetSnooze(DateTime dt)
        {
            P().SnoozeUntil = TimeUtil.ToRfc3339(dt);
            Touch();
        }

        public void ClearSnooze()
        {
            P().SnoozeUntil = null;
            Touch();
        }

        public int NotifyCount
        {
            get
            {
                int n;
                if (int.TryParse(P().NotifyCount, out n)) return n;
                return 0;
            }
            set { P().NotifyCount = value.ToString(CultureInfo.InvariantCulture); }
        }

        public string ClosedAt
        {
            get { return P().ClosedAt; }
            set { P().ClosedAt = value; }
        }

        public bool IsPending()
        {
            return Status == TodoStatus.Pending;
        }

        public void Touch()
        {
            Updated = TimeUtil.ToRfc3339(DateTime.Now);
        }
    }

    // 저장 파일은 구글 캘린더 events.list 응답 형태({"kind","items":[...]})를 따른다.
    [DataContract]
    public class TodoFile : IExtensibleDataObject
    {
        [DataMember(Name = "kind", EmitDefaultValue = false)] public string Kind;
        [DataMember(Name = "items")] public List<TodoItem> Items;
        public ExtensionDataObject ExtensionData { get; set; }
    }

    [DataContract]
    public class AppSettings : IExtensibleDataObject
    {
        public ExtensionDataObject ExtensionData { get; set; }

        [DataMember(Name = "opacity")] public double Opacity;
        [DataMember(Name = "position")] public string Position;
        [DataMember(Name = "popupWidth")] public int PopupWidth;
        [DataMember(Name = "popupHeight")] public int PopupHeight;
        [DataMember(Name = "defaultRenotifyMinutes")] public int DefaultRenotifyMinutes;
        [DataMember(Name = "defaultSnoozeMinutes")] public int DefaultSnoozeMinutes;
        [DataMember(Name = "playSound")] public bool PlaySound;
        [DataMember(Name = "showClosed")] public bool ShowClosed;
        // Electron 판과 같은 키를 쓴다. 두 판이 %APPDATA%\TodoPopup\settings.json 을
        // 공유하므로, 키가 갈라지면 한쪽에서 켠 설정이 다른 쪽에서 조용히 무시된다.
        [DataMember(Name = "truncateSeconds")] public bool TruncateSeconds;
        [DataMember(Name = "popupAllMonitors")] public bool PopupAllMonitors;
        [DataMember(Name = "popupEffect")] public string PopupEffect;

        public AppSettings()
        {
            SetDefaults();
        }

        [OnDeserializing]
        private void OnDeserializing(StreamingContext ctx)
        {
            SetDefaults();
        }

        private void SetDefaults()
        {
            Opacity = 0.95;
            Position = "bottom-center";
            PopupWidth = 380;
            PopupHeight = 170;
            DefaultRenotifyMinutes = 5;
            DefaultSnoozeMinutes = 10;
            TruncateSeconds = true;
            PopupAllMonitors = true;
            PopupEffect = "flash";
            PlaySound = true;
            ShowClosed = false;
        }

        public void Clamp()
        {
            if (Opacity < 0.3) Opacity = 0.3;
            if (Opacity > 1.0) Opacity = 1.0;
            if (PopupWidth < 260) PopupWidth = 260;
            if (PopupWidth > 900) PopupWidth = 900;
            if (PopupHeight < 130) PopupHeight = 130;
            if (PopupHeight > 500) PopupHeight = 500;
            if (DefaultRenotifyMinutes < 1) DefaultRenotifyMinutes = 1;
            if (DefaultRenotifyMinutes > 720) DefaultRenotifyMinutes = 720;
            if (DefaultSnoozeMinutes < 1) DefaultSnoozeMinutes = 1;
            if (DefaultSnoozeMinutes > 720) DefaultSnoozeMinutes = 720;
            if (Position != "bottom-center" && Position != "bottom-left" && Position != "bottom-right"
                && Position != "center" && Position != "top-center")
            {
                Position = "bottom-center";
            }
        }
    }

    public static class TimeUtil
    {
        /// <summary>
        /// 예약 시각의 초를 버린다. 14:00:30 에 "1분 뒤" 라고 하면 사람은 14:01 을 뜻하지
        /// 14:01:30 을 뜻하지 않는다. 초가 남으면 알림이 늘 어중간한 자리에서 울리는데,
        /// 화면은 초를 보여 주지 않으므로 사용자는 "14:01 이라 써 놓고 왜 늦지" 만 보게 된다.
        /// Electron 판의 Store.snapSeconds() 와 같은 규칙이다(두 판이 같은 원장을 쓴다).
        /// </summary>
        public static DateTime SnapSeconds(DateTime dt, bool enabled)
        {
            if (!enabled) return dt;
            return new DateTime(dt.Year, dt.Month, dt.Day, dt.Hour, dt.Minute, 0, dt.Kind);
        }

        public static string ToRfc3339(DateTime dt)
        {
            if (dt.Kind == DateTimeKind.Unspecified) dt = DateTime.SpecifyKind(dt, DateTimeKind.Local);
            return dt.ToString("yyyy-MM-dd'T'HH:mm:ssK", CultureInfo.InvariantCulture);
        }

        public static DateTime FromRfc3339(string s)
        {
            if (string.IsNullOrEmpty(s)) return DateTime.MinValue;
            DateTimeOffset dto;
            if (DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out dto))
            {
                return dto.LocalDateTime;
            }
            DateTime d;
            if (DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) return d;
            return DateTime.MinValue;
        }

        public static string FormatKorean(DateTime dt)
        {
            string[] days = { "일", "월", "화", "수", "목", "금", "토" };
            string day = days[(int)dt.DayOfWeek];
            return string.Format("{0}월 {1}일 ({2}) {3:00}:{4:00}", dt.Month, dt.Day, day, dt.Hour, dt.Minute);
        }

        public static string FormatClock(DateTime dt)
        {
            string mer = dt.Hour < 12 ? "오전" : "오후";
            int h = dt.Hour % 12;
            if (h == 0) h = 12;
            return string.Format("{0} {1}:{2:00}", mer, h, dt.Minute);
        }

        public static string FormatListDate(DateTime dt, DateTime now)
        {
            if (dt.Date == now.Date) return string.Format("오늘 {0:00}:{1:00}", dt.Hour, dt.Minute);
            if (dt.Date == now.Date.AddDays(1)) return string.Format("내일 {0:00}:{1:00}", dt.Hour, dt.Minute);
            return FormatKorean(dt);
        }
    }
}
