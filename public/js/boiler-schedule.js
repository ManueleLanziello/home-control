const NORMAL_PERIOD_NAMES = ['Mattina presto', 'Mattina', 'Mezzogiorno', 'Pomeriggio', 'Sera', 'Notte'];
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 30;

let selectedWeekday = null;
let activeSchedule = null;
let activeNow = null;

function minutes(period) {
  return period.hour * 60 + period.minute;
}

function temperatureText(value) {
  return `${value.toFixed(1).replace('.', ',')}°`;
}

function timeText(period) {
  return `${String(period.hour).padStart(2, '0')}:${String(period.minute).padStart(2, '0')}`;
}

function timelineMinute(value, origin) {
  return value < origin ? value + 1440 : value;
}

function labelColor(temperature) {
  const normalized = Math.max(0, Math.min(1, temperature / MAX_TEMPERATURE));
  return `hsl(${218 - normalized * 210} 94% 61%)`;
}

export function selectWt200PeriodsForDate(schedule, date) {
  const day = date.getDay();
  const deviceGroup = schedule?.groups?.find((group) => group.days?.includes(day));
  if (Array.isArray(deviceGroup?.periods)) return deviceGroup.periods;
  if (schedule?.weekPattern === '5+2') return day === 0 || day === 6 ? schedule.restDayPeriods : schedule.normalPeriods;
  if (schedule?.weekPattern === '6+1') return day === 0 ? schedule.restDayPeriods : schedule.normalPeriods;
  if (schedule?.weekPattern === '7') return schedule.normalPeriods;
  return null;
}

export function initialWt200SetpointForDate(schedule, date) {
  const previousDate = new Date(date);
  previousDate.setDate(date.getDate() - 1);
  const previousPeriods = selectWt200PeriodsForDate(schedule, previousDate);
  const previous = previousPeriods?.at(-1);
  return Number.isFinite(previous?.temperature) ? previous.temperature : null;
}

export function createWt200ScheduleModel(schedule, date = new Date()) {
  const periods = selectWt200PeriodsForDate(schedule, date);
  const initialTemperature = initialWt200SetpointForDate(schedule, date);
  if (!Array.isArray(periods) || !periods.length || initialTemperature === null) return null;
  return { periods, initialTemperature };
}

function selectedDate(now) {
  const today = now.getDay();
  const day = selectedWeekday ?? today;
  const result = new Date(now);
  result.setDate(now.getDate() + (day - today + 7) % 7);
  result.setHours(12, 0, 0, 0);
  return result;
}

function timelineSegments(periods) {
  const origin = minutes(periods[0]);
  const starts = periods.map((period) => timelineMinute(minutes(period), origin));
  return periods.map((period, index) => ({
    period,
    start: starts[index],
    end: starts[index + 1] ?? origin + 1440,
    duration: (starts[index + 1] ?? origin + 1440) - starts[index],
  }));
}

function graphMarkup(periods, now, showNow) {
  const width = 760;
  const height = 252;
  const left = 48;
  const right = 10;
  const top = 14;
  const bottom = 36;
  const graphWidth = width - left - right;
  const graphHeight = height - top - bottom;
  const segments = timelineSegments(periods);
  const origin = segments[0].start;
  const x = (value) => left + ((value - origin) / 1440) * graphWidth;
  const y = (value) => top + ((MAX_TEMPERATURE - Math.max(MIN_TEMPERATURE, Math.min(MAX_TEMPERATURE, value))) / MAX_TEMPERATURE) * graphHeight;
  const baseline = y(MIN_TEMPERATURE);
  const grid = Array.from({ length: 16 }, (_, index) => index * 2).map((value) => `<g><line class="boiler-schedule-grid" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 7}" y="${y(value) + 3}" text-anchor="end">${value}°</text></g>`).join('');
  const bars = segments.map((segment) => {
    const barX = x(segment.start);
    const barWidth = x(segment.end) - x(segment.start);
    const barY = y(segment.period.temperature);
    const barHeight = Math.max(1, baseline - barY);
    const labelY = barHeight > 26 ? barY + 16 : Math.max(top + 10, barY - 5);
    return `<g><rect class="boiler-schedule-bar" x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" fill="url(#boiler-thermal-axis)"/><line class="boiler-schedule-period-marker" x1="${barX}" x2="${barX}" y1="${top}" y2="${baseline}"/><text class="boiler-schedule-value" x="${barX + barWidth / 2}" y="${labelY}" text-anchor="middle">${temperatureText(segment.period.temperature)}</text></g>`;
  }).join('');
  const labels = [...segments.map((segment) => ({ position: segment.start, text: timeText(segment.period) })), { position: origin + 1440, text: `${timeText(periods[0])} +1` }]
    .map(({ position, text }) => `<text x="${x(position)}" y="${height - 7}" text-anchor="middle">${text}</text>`).join('');
  const currentMinutes = timelineMinute(now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60, origin);
  const currentMarker = showNow ? `<line class="boiler-schedule-now" x1="${x(currentMinutes)}" x2="${x(currentMinutes)}" y1="${top}" y2="${baseline}"/>` : '';
  const thermalGradient = '<linearGradient id="boiler-thermal-axis" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="' + baseline + '" y2="' + top + '"><stop offset="0" stop-color="#1359eb"/><stop offset=".29" stop-color="#08c9fa"/><stop offset=".47" stop-color="#43f0c7"/><stop offset=".63" stop-color="#d8f53b"/><stop offset=".77" stop-color="#ffbd31"/><stop offset=".9" stop-color="#ff782f"/><stop offset="1" stop-color="#ff3f4d"/></linearGradient>';
  return `<div class="boiler-schedule-chart-shell"><svg class="boiler-schedule-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Profilo di temperatura programmato nelle 24 ore"><defs>${thermalGradient}</defs><text class="boiler-schedule-axis-title" transform="translate(14 ${top + graphHeight / 2}) rotate(-90)" text-anchor="middle">Temperatura °C</text>${grid}${bars}${currentMarker}${labels}</svg></div>`;
}

function periodIcon(index, count) {
  if (count !== 6) return '◷';
  return ['☀', '☼', '◐', '☀', '◒', '☾'][index];
}

function periodsMarkup(periods) {
  const names = periods.length === 6 ? NORMAL_PERIOD_NAMES : periods.map((_, index) => `Fascia ${index + 1}`);
  const segments = timelineSegments(periods);
  return `<div class="boiler-schedule-periods">${segments.map((segment, index) => `<div class="boiler-schedule-period" style="flex-grow:${segment.duration};--period-color:${labelColor(segment.period.temperature)}"><span class="boiler-schedule-period-icon">${periodIcon(index, periods.length)}</span><span><strong>${names[index]}</strong><small>${timeText(segment.period)} · ${temperatureText(segment.period.temperature)}</small></span></div>`).join('')}</div>`;
}

function updateDayButtons() {
  for (const button of document.querySelectorAll('[data-boiler-weekday]')) {
    const isSelected = Number(button.dataset.boilerWeekday) === selectedWeekday;
    button.classList.toggle('is-active', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  }
}

function attachDayButtons() {
  for (const button of document.querySelectorAll('[data-boiler-weekday]')) {
    if (button.dataset.boilerScheduleBound) continue;
    button.dataset.boilerScheduleBound = 'true';
    button.addEventListener('click', () => {
      selectedWeekday = Number(button.dataset.boilerWeekday);
      renderWt200Schedule(document.querySelector('[data-boiler-schedule]'), activeSchedule, activeNow || new Date());
    });
  }
}

export function renderWt200Schedule(container, schedule, now = new Date()) {
  if (!container) return;
  activeSchedule = schedule;
  activeNow = now;
  selectedWeekday ??= now.getDay();
  attachDayButtons();
  updateDayButtons();
  const date = selectedDate(now);
  const model = createWt200ScheduleModel(schedule, date);
  if (!model) {
    container.classList.remove('boiler-schedule-placeholder--chart');
    container.textContent = 'Programmazione non ancora acquisita';
    return;
  }
  const showNow = date.toDateString() === now.toDateString();
  container.classList.add('boiler-schedule-placeholder--chart');
  container.innerHTML = graphMarkup(model.periods, now, showNow) + periodsMarkup(model.periods);
}
