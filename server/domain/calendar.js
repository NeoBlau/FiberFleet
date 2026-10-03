// Рабочий календарь. Время переводится в «рабочие минуты» — сквозной счётчик минут рабочего
// времени от фиксированной эпохи. В этом пространстве задачи, переходящие через ночь/выходные,
// — просто отрезки [start, end), что сильно упрощает поиск свободных окон.

const DAY = 86400000;
const EPOCH = Date.UTC(2020, 0, 6); // понедельник

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

export class WorkCalendar {
  constructor(settings) {
    this.offset = Number(settings.tz_offset_min ?? 180) * 60000;
    const ws = toMin(settings.work_start || '08:00');
    const we = toMin(settings.work_end || '17:00');
    const ls = settings.lunch_start ? toMin(settings.lunch_start) : null;
    const le = settings.lunch_end ? toMin(settings.lunch_end) : null;
    this.segments = ls != null && le != null && ls > ws && le < we && le > ls
      ? [[ws, ls], [le, we]]
      : [[ws, we]];
    this.perDay = this.segments.reduce((a, [s, e]) => a + (e - s), 0);
    this.workDays = new Set((settings.work_days || [1, 2, 3, 4, 5]).map(Number));
    this.holidays = new Set(settings.holidays || []);
  }

  isWorkDay(dayIdx) {
    const d = new Date(EPOCH + dayIdx * DAY);
    const dow = d.getUTCDay() || 7; // 1..7
    if (!this.workDays.has(dow)) return false;
    return !this.holidays.has(d.toISOString().slice(0, 10));
  }

  // Число рабочих дней в [0, dayIdx)
  workDaysBefore(dayIdx) {
    if (dayIdx <= 0) return 0;
    const p = this._prefix || (this._prefix = [0]);
    while (p.length <= dayIdx) {
      const i = p.length - 1;
      p.push(p[i] + (this.isWorkDay(i) ? 1 : 0));
    }
    return p[dayIdx];
  }

  // Реальная дата (Date|ISO) → рабочая минута (время вне рабочего окна сдвигается вперёд)
  toWork(date) {
    const local = new Date(date).getTime() + this.offset;
    if (local < EPOCH) return 0;
    const dayIdx = Math.floor((local - EPOCH) / DAY);
    const minOfDay = Math.floor((local - EPOCH - dayIdx * DAY) / 60000);
    const base = this.workDaysBefore(dayIdx) * this.perDay;
    if (!this.isWorkDay(dayIdx)) return base;
    let acc = 0;
    for (const [s, e] of this.segments) {
      if (minOfDay < s) return base + acc;
      if (minOfDay < e) return base + acc + (minOfDay - s);
      acc += e - s;
    }
    return base + acc; // после конца дня → начало следующего рабочего дня
  }

  // Рабочая минута → реальная дата (ISO). atEnd=true: конец отрезка ставим на конец предыдущего окна
  fromWork(wm, atEnd = false) {
    let workDay = Math.floor(wm / this.perDay);
    let within = wm - workDay * this.perDay;
    if (atEnd && within === 0 && workDay > 0) { workDay -= 1; within = this.perDay; }
    // найти календарный день с индексом workDay среди рабочих
    let lo = workDay, hi = workDay * 2 + 30;
    while (this.workDaysBefore(hi) <= workDay) hi *= 2;
    while (lo < hi) { // минимальный d: workDaysBefore(d+1) > workDay
      const mid = Math.floor((lo + hi) / 2);
      if (this.workDaysBefore(mid + 1) > workDay) hi = mid; else lo = mid + 1;
    }
    const dayIdx = lo;
    let minute = null;
    for (const [s, e] of this.segments) {
      const len = e - s;
      if (within < len || (atEnd && within === len)) { minute = s + within; break; }
      within -= len;
    }
    if (minute == null) minute = this.segments[this.segments.length - 1][1];
    return new Date(EPOCH + dayIdx * DAY + minute * 60000 - this.offset).toISOString();
  }

  // Конец рабочего дня через n рабочих дней от даты (для сроков по приоритету)
  addWorkDays(date, n) {
    const start = this.toWork(date);
    const day = Math.floor(start / this.perDay) + n;
    return this.fromWork((day + 1) * this.perDay, true);
  }

  // Начало/конец «локальных» суток для отображения
  localDayStart(date) {
    const local = new Date(date).getTime() + this.offset;
    return new Date(Math.floor(local / DAY) * DAY - this.offset).toISOString();
  }
}
