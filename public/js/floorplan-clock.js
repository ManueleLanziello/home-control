const SVG_NS = 'http://www.w3.org/2000/svg';
const CLOCK_SIZE = 100;
const CLOCK_CENTER = CLOCK_SIZE / 2;

const svg = (documentRef, tag, attributes = {}) => {
  const element = documentRef.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};

export function clockAngles(now) {
  const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
  const minutes = now.getMinutes() + seconds / 60;
  const hours = (now.getHours() % 12) + minutes / 60;
  return { hours: hours * 30, minutes: minutes * 6, seconds: seconds * 6 };
}

export function formatDigitalTime(now) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function createFloorplanClock({ overlay, box, documentRef = document, requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, now = () => new Date() }) {
  const size = Math.min(box.width, box.height);
  const x = box.x + (box.width - size) / 2;
  const y = box.y + (box.height - size) / 2;
  const clock = svg(documentRef, 'g', { class: 'floorplan-clock', transform: `translate(${x} ${y}) scale(${size / CLOCK_SIZE})`, 'aria-label': 'Orologio analogico' });
  clock.append(svg(documentRef, 'circle', { class: 'floorplan-clock-face', cx: CLOCK_CENTER, cy: CLOCK_CENTER, r: 48 }));
  const ticks = svg(documentRef, 'g', { class: 'floorplan-clock-ticks' });
  for (let hour = 0; hour < 12; hour += 1) ticks.append(svg(documentRef, 'line', { x1: CLOCK_CENTER, y1: 7, x2: CLOCK_CENTER, y2: hour % 3 === 0 ? 13 : 10, transform: `rotate(${hour * 30} ${CLOCK_CENTER} ${CLOCK_CENTER})` }));
  const digital = svg(documentRef, 'text', { class: 'floorplan-clock-digital', x: CLOCK_CENTER, y: 72, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
  const hourHand = svg(documentRef, 'line', { class: 'floorplan-clock-hand floorplan-clock-hour-hand', x1: CLOCK_CENTER, y1: CLOCK_CENTER, x2: CLOCK_CENTER, y2: 28 });
  const minuteHand = svg(documentRef, 'line', { class: 'floorplan-clock-hand floorplan-clock-minute-hand', x1: CLOCK_CENTER, y1: CLOCK_CENTER, x2: CLOCK_CENTER, y2: 18 });
  const secondHand = svg(documentRef, 'line', { class: 'floorplan-clock-hand floorplan-clock-second-hand', x1: CLOCK_CENTER, y1: 55, x2: CLOCK_CENTER, y2: 13 });
  const pin = svg(documentRef, 'circle', { class: 'floorplan-clock-pin', cx: CLOCK_CENTER, cy: CLOCK_CENTER, r: 3 });
  clock.append(ticks, digital, hourHand, minuteHand, secondHand, pin);
  overlay.append(clock);

  let displayedTime;
  const render = () => {
    const current = now();
    const angles = clockAngles(current);
    hourHand.setAttribute('transform', `rotate(${angles.hours} ${CLOCK_CENTER} ${CLOCK_CENTER})`);
    minuteHand.setAttribute('transform', `rotate(${angles.minutes} ${CLOCK_CENTER} ${CLOCK_CENTER})`);
    secondHand.setAttribute('transform', `rotate(${angles.seconds} ${CLOCK_CENTER} ${CLOCK_CENTER})`);
    const nextTime = formatDigitalTime(current);
    if (nextTime !== displayedTime) {
      digital.textContent = nextTime;
      displayedTime = nextTime;
    }
  };
  let frame;
  const schedule = () => {
    if (documentRef.visibilityState !== 'visible') return;
    frame = requestFrame(() => { render(); schedule(); });
  };
  const onVisibilityChange = () => {
    if (documentRef.visibilityState === 'hidden') cancelFrame(frame);
    else schedule();
  };
  render();
  schedule();
  documentRef.addEventListener('visibilitychange', onVisibilityChange);
  return { element: clock, destroy() { cancelFrame(frame); documentRef.removeEventListener('visibilitychange', onVisibilityChange); clock.remove(); } };
}
