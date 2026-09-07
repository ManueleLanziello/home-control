function minutes(period) {
  return period.hour * 60 + period.minute;
}

export function selectWt200PeriodsForDate(schedule, date) {
  if (schedule?.weekPattern !== '5+2') return null;
  const day = date.getDay();
  return day === 0 || day === 6 ? schedule.restDayPeriods : schedule.normalPeriods;
}

export function initialWt200SetpointForDate(schedule, date) {
  if (schedule?.weekPattern !== '5+2') return null;
  const day = date.getDay();
  const previousPeriods = day === 1 || day === 0 ? schedule.restDayPeriods : schedule.normalPeriods;
  const previous = previousPeriods?.at(-1);
  return Number.isFinite(previous?.temperature) ? previous.temperature : null;
}

export function createWt200ScheduleModel(schedule, date = new Date()) {
  const periods = selectWt200PeriodsForDate(schedule, date);
  const initialTemperature = initialWt200SetpointForDate(schedule, date);
  if (!Array.isArray(periods) || !periods.length || initialTemperature === null) return null;
  return { periods, initialTemperature };
}

function graphMarkup({ periods, initialTemperature }, date) {
  const width = 480;
  const height = 132;
  const left = 30;
  const right = 12;
  const top = 12;
  const bottom = 24;
  const graphWidth = width - left - right;
  const graphHeight = height - top - bottom;
  const temperatures = [initialTemperature, ...periods.map((period) => period.temperature)];
  const minTemperature = Math.min(...temperatures);
  const maxTemperature = Math.max(...temperatures);
  const span = Math.max(maxTemperature - minTemperature, 1);
  const xForMinutes = (value) => left + (value / 1440) * graphWidth;
  const yForTemperature = (value) => top + ((maxTemperature - value) / span) * graphHeight;
  let path = `M ${xForMinutes(0)} ${yForTemperature(initialTemperature)}`;
  for (const period of periods) {
    const x = xForMinutes(minutes(period));
    path += ` H ${x} V ${yForTemperature(period.temperature)}`;
  }
  path += ` H ${xForMinutes(1440)}`;
  const nowMinutes = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const labels = [0, 360, 720, 1080, 1440].map((value) => `<text x="${xForMinutes(value)}" y="${height - 5}" text-anchor="middle">${String(Math.floor(value / 60)).padStart(2, '0')}:00</text>`).join('');
  const changes = periods.map((period) => {
    const x = xForMinutes(minutes(period));
    const y = yForTemperature(period.temperature);
    return `<circle cx="${x}" cy="${y}" r="3"/><text x="${x}" y="${Math.max(10, y - 7)}" text-anchor="middle">${period.hour}:${String(period.minute).padStart(2, '0')} · ${period.temperature.toFixed(1)}°</text>`;
  }).join('');
  return `<svg class="boiler-schedule-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Programmazione setpoint nelle 24 ore"><line class="boiler-schedule-grid" x1="${left}" x2="${width - right}" y1="${top}" y2="${top}"/><line class="boiler-schedule-grid" x1="${left}" x2="${width - right}" y1="${top + graphHeight / 2}" y2="${top + graphHeight / 2}"/><line class="boiler-schedule-grid" x1="${left}" x2="${width - right}" y1="${top + graphHeight}" y2="${top + graphHeight}"/><line class="boiler-schedule-now" x1="${xForMinutes(nowMinutes)}" x2="${xForMinutes(nowMinutes)}" y1="${top}" y2="${top + graphHeight}"/><path class="boiler-schedule-step" d="${path}"/>${changes}${labels}</svg>`;
}

export function renderWt200Schedule(container, schedule, date = new Date()) {
  if (!container) return;
  const model = createWt200ScheduleModel(schedule, date);
  if (!model) {
    container.classList.remove('boiler-schedule-placeholder--chart');
    container.textContent = 'Programmazione non ancora acquisita';
    return;
  }
  container.classList.add('boiler-schedule-placeholder--chart');
  container.innerHTML = graphMarkup(model, date);
}
