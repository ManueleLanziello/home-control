export const WEATHER_CANVAS_LIMITS = Object.freeze({ impacts: 20, fragments: 64, rainRate: [4, 8], stormRate: [8, 15] });

export function createWeatherPrng(seed = Date.now()) {
  let state = (Number(seed) >>> 0) || 0x6d2b79f5;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const between = (random, min, max) => min + (max - min) * random();
const VARIANTS = Object.freeze({
  small: { flattenWidth: [16, 25], flattenHeight: [3, 5], fragments: [0, 2], fragmentSpeed: [95, 155], rippleChance: .08, rippleSize: [18, 29] },
  normal: { flattenWidth: [25, 39], flattenHeight: [4, 6], fragments: [2, 3], fragmentSpeed: [125, 205], rippleChance: .38, rippleSize: [25, 42] },
  strong: { flattenWidth: [38, 55], flattenHeight: [5, 8], fragments: [3, 4], fragmentSpeed: [170, 260], rippleChance: .68, rippleSize: [38, 58] },
});

export function createWeatherCanvasRenderer({
  canvas,
  observedElement = canvas,
  viewBox,
  allowed,
  excluded,
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id),
  random = createWeatherPrng(Date.now() ^ Math.floor(globalThis.performance?.now?.() || 0)),
  now = () => globalThis.performance?.now?.() || 0,
  pixelRatio = () => globalThis.devicePixelRatio || 1,
  createResizeObserver = callback => typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(callback),
} = {}) {
  const context = canvas?.getContext?.('2d');
  if (!context) throw new Error('Canvas meteo 2D non disponibile');
  const impacts = Array.from({ length: WEATHER_CANVAS_LIMITS.impacts }, () => ({ active: false }));
  const fragments = Array.from({ length: WEATHER_CANVAS_LIMITS.fragments }, () => ({ active: false }));
  let mode = 'none';
  let frameId = null;
  let lastFrameAt = null;
  let nextEventAt = 0;
  let currentRate = 6;
  let targetRate = 6;
  let nextRateChangeAt = 0;
  let nextBurstAt = 0;
  let burstRemaining = 0;
  let nextBurstEventAt = 0;
  let nextFlashAt = 0;
  let flashStartedAt = 0;
  let flashUntil = 0;
  let flashStrength = 0;
  let secondaryFlashAt = 0;
  let lastImpactX = allowed.x + allowed.width / 2;
  let lastImpactY = allowed.y + allowed.height / 2;
  let bufferWidth = 0;
  let bufferHeight = 0;
  let dpr = 1;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let requestedFrames = 0;
  let cancelledFrames = 0;
  let resizeCount = 0;
  let emittedEvents = 0;
  let emittedFragments = 0;
  let emittedBursts = 0;
  let emittedFlashes = 0;
  const variantCounts = { small: 0, normal: 0, strong: 0 };

  const clear = () => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
  };

  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    const nextDpr = Math.max(1, Math.min(2, Number(pixelRatio()) || 1));
    const nextWidth = Math.max(1, Math.round(bounds.width * nextDpr));
    const nextHeight = Math.max(1, Math.round(bounds.height * nextDpr));
    if (nextWidth === bufferWidth && nextHeight === bufferHeight && nextDpr === dpr) return false;
    dpr = nextDpr; bufferWidth = nextWidth; bufferHeight = nextHeight;
    canvas.width = bufferWidth; canvas.height = bufferHeight;
    scale = Math.min(bufferWidth / viewBox.width, bufferHeight / viewBox.height);
    offsetX = (bufferWidth - viewBox.width * scale) / 2 - viewBox.x * scale;
    offsetY = (bufferHeight - viewBox.height * scale) / 2 - viewBox.y * scale;
    resizeCount += 1; clear(); return true;
  };

  const insideExcluded = (x, y) => excluded.some(box => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height);
  const randomImpactPoint = () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const clustered = attempt === 0 && random() < (mode === 'storm' ? .34 : .24);
      const x = clustered ? lastImpactX + between(random, -260, 260) : allowed.x + random() * allowed.width;
      const y = clustered ? lastImpactY + between(random, -190, 190) : allowed.y + random() * allowed.height;
      if (x >= allowed.x && x <= allowed.x + allowed.width && y >= allowed.y && y <= allowed.y + allowed.height && !insideExcluded(x, y)) return { x, y };
    }
    return { x: allowed.x + 24, y: allowed.y + 24 };
  };

  const chooseVariant = () => {
    const value = random();
    if (mode === 'storm') return value < .2 ? 'small' : value < .74 ? 'normal' : 'strong';
    return value < .46 ? 'small' : value < .91 ? 'normal' : 'strong';
  };

  const activateFragment = (impact, variant, index, count) => {
    const fragment = fragments.find(candidate => !candidate.active);
    if (!fragment) return;
    const settings = VARIANTS[variant];
    const angle = random() * Math.PI * 2 + (index / Math.max(1, count)) * .35;
    const speed = between(random, ...settings.fragmentSpeed) * (mode === 'storm' ? 1.12 : 1);
    fragment.active = true; fragment.x = impact.x; fragment.y = impact.y;
    fragment.vx = Math.cos(angle) * speed; fragment.vy = Math.sin(angle) * speed;
    fragment.size = between(random, variant === 'small' ? 2.5 : 3, variant === 'strong' ? 7 : 5.8);
    fragment.opacity = between(random, .3, mode === 'storm' ? .62 : .53);
    fragment.age = 0; fragment.lifetime = between(random, 240, variant === 'strong' ? 480 : 410);
    emittedFragments += 1;
  };

  const triggerImpact = impact => {
    if (impact.impacted) return;
    impact.impacted = true;
    const settings = VARIANTS[impact.variant];
    const minimum = settings.fragments[0]; const maximum = settings.fragments[1];
    const count = minimum + Math.floor(random() * (maximum - minimum + 1));
    for (let index = 0; index < count; index += 1) activateFragment(impact, impact.variant, index, count);
  };

  const spawnImpact = () => {
    const impact = impacts.find(candidate => !candidate.active);
    if (!impact) return false;
    const point = randomImpactPoint(); const variant = chooseVariant(); const settings = VARIANTS[variant];
    impact.active = true; impact.impacted = false; impact.variant = variant;
    variantCounts[variant] += 1;
    impact.x = point.x; impact.y = point.y; impact.age = 0;
    impact.approachDuration = between(random, mode === 'storm' ? 55 : 75, mode === 'storm' ? 105 : 135);
    impact.flattenDuration = between(random, 70, variant === 'strong' ? 125 : 105);
    impact.dispersionDuration = between(random, 270, variant === 'strong' ? 520 : 450);
    impact.approachDistance = between(random, 34, mode === 'storm' ? 112 : 98);
    impact.dropRadius = between(random, variant === 'small' ? 3 : 4, variant === 'strong' ? 8 : 6.5);
    impact.flattenWidth = between(random, ...settings.flattenWidth) * (mode === 'storm' ? 1.08 : 1);
    impact.flattenHeight = between(random, ...settings.flattenHeight);
    impact.opacity = between(random, .48, mode === 'storm' ? .78 : .68);
    impact.ripple = random() < settings.rippleChance;
    impact.rippleSize = between(random, ...settings.rippleSize) * (mode === 'storm' ? 1.08 : 1);
    impact.lobeAngleA = random() * Math.PI; impact.lobeAngleB = impact.lobeAngleA + between(random, 1.5, 3.8);
    impact.lobeScaleA = between(random, .38, .7); impact.lobeScaleB = between(random, .28, .58);
    lastImpactX = impact.x; lastImpactY = impact.y; emittedEvents += 1;
    return true;
  };

  const scheduleNextEvent = now => {
    nextEventAt = now + (1000 / Math.max(1, currentRate)) * between(random, .52, 1.58);
  };

  const updateScheduler = (now, delta) => {
    if (now >= nextRateChangeAt) {
      const range = mode === 'storm' ? WEATHER_CANVAS_LIMITS.stormRate : WEATHER_CANVAS_LIMITS.rainRate;
      targetRate = between(random, ...range);
      nextRateChangeAt = now + between(random, 2600, 6100);
    }
    currentRate += (targetRate - currentRate) * (1 - Math.exp(-delta * 1.2));
    let safety = 0;
    while (now >= nextEventAt && safety < 3) { spawnImpact(); scheduleNextEvent(nextEventAt || now); safety += 1; }
    if (now >= nextBurstAt && burstRemaining === 0) {
      const burstChance = mode === 'storm' ? .82 : .24;
      if (random() < burstChance) { burstRemaining = mode === 'storm' ? 2 + Math.floor(random() * 3) : 1 + Math.floor(random() * 2); nextBurstEventAt = now; emittedBursts += 1; }
      nextBurstAt = now + (mode === 'storm' ? between(random, 4800, 12500) : between(random, 14000, 30000));
    }
    if (burstRemaining > 0 && now >= nextBurstEventAt) {
      spawnImpact(); burstRemaining -= 1;
      nextBurstEventAt = now + (mode === 'storm' ? between(random, 70, 135) : between(random, 115, 190));
    }
  };

  const applyMask = () => {
    context.beginPath(); context.rect(allowed.x, allowed.y, allowed.width, allowed.height);
    for (const box of excluded) context.rect(box.x, box.y, box.width, box.height);
    context.clip('evenodd');
  };

  const drawApproach = (impact, progress) => {
    const eased = 1 - (1 - progress) * (1 - progress);
    const y = impact.y - impact.approachDistance * (1 - eased);
    const radius = impact.dropRadius * (.72 + eased * .28);
    context.globalAlpha = impact.opacity * (.45 + eased * .55); context.fillStyle = '#d9f5ff';
    context.beginPath(); context.ellipse(impact.x, y, radius * .72, radius, 0, 0, Math.PI * 2); context.fill();
    context.globalAlpha *= .35; context.beginPath(); context.ellipse(impact.x - radius * .2, y - radius * .25, radius * .2, radius * .28, 0, 0, Math.PI * 2); context.fill();
  };

  const drawFlatten = (impact, progress) => {
    const width = impact.dropRadius * 1.4 + (impact.flattenWidth - impact.dropRadius * 1.4) * progress;
    const height = impact.dropRadius * 1.3 + (impact.flattenHeight - impact.dropRadius * 1.3) * progress;
    context.globalAlpha = impact.opacity * (1 - progress * .18); context.fillStyle = '#c9efff';
    context.beginPath(); context.ellipse(impact.x, impact.y, width, Math.max(1, height), impact.lobeAngleA * .08, 0, Math.PI * 2); context.fill();
  };

  const drawDispersion = (impact, progress) => {
    const fade = 1 - progress;
    const spread = impact.flattenWidth * (.55 + progress * .62);
    context.fillStyle = '#bfeaff'; context.globalAlpha = impact.opacity * fade * .34;
    context.beginPath();
    context.ellipse(impact.x + Math.cos(impact.lobeAngleA) * spread * .25, impact.y + Math.sin(impact.lobeAngleA) * spread * .16, spread * impact.lobeScaleA, Math.max(1, impact.flattenHeight * fade), impact.lobeAngleA, 0, Math.PI * 2);
    context.ellipse(impact.x + Math.cos(impact.lobeAngleB) * spread * .22, impact.y + Math.sin(impact.lobeAngleB) * spread * .14, spread * impact.lobeScaleB, Math.max(1, impact.flattenHeight * fade * .8), impact.lobeAngleB, 0, Math.PI * 2);
    context.fill();
    if (impact.ripple && progress < .72) {
      context.globalAlpha = fade * (impact.variant === 'strong' ? .2 : .11); context.strokeStyle = '#ccefff'; context.lineWidth = 2;
      context.beginPath(); context.ellipse(impact.x, impact.y, impact.rippleSize * progress, impact.rippleSize * progress * (.62 + impact.lobeScaleB * .2), impact.lobeAngleA, 0, Math.PI * 2); context.stroke();
    }
  };

  const updateFlash = now => {
    if (mode !== 'storm') return 0;
    if (secondaryFlashAt && now >= secondaryFlashAt) { secondaryFlashAt = 0; flashStartedAt = now; flashUntil = now + between(random, 45, 85); flashStrength = between(random, .035, .065); emittedFlashes += 1; }
    if (now >= nextFlashAt) {
      flashStartedAt = now; flashUntil = now + between(random, 60, 120); flashStrength = between(random, .075, .125);
      if (random() < .52) secondaryFlashAt = flashUntil + between(random, 80, 150);
      nextFlashAt = now + between(random, 7500, 19000);
      emittedFlashes += 1;
    }
    return now >= flashUntil ? 0 : flashStrength * ((flashUntil - now) / Math.max(1, flashUntil - flashStartedAt));
  };

  const renderFrame = now => {
    frameId = null;
    if (mode !== 'rain' && mode !== 'storm') return;
    resize();
    const delta = lastFrameAt === null ? 0 : Math.min(.05, Math.max(0, (now - lastFrameAt) / 1000));
    lastFrameAt = now; updateScheduler(now, delta); clear();
    context.setTransform(scale, 0, 0, scale, offsetX, offsetY); context.save(); applyMask();
    context.globalAlpha = 1; context.fillStyle = mode === 'storm' ? 'rgba(103, 174, 205, .055)' : 'rgba(118, 188, 214, .028)';
    context.fillRect(allowed.x, allowed.y, allowed.width, allowed.height);
    for (const impact of impacts) {
      if (!impact.active) continue;
      impact.age += delta * 1000;
      if (impact.age < impact.approachDuration) drawApproach(impact, impact.age / impact.approachDuration);
      else {
        triggerImpact(impact);
        const afterImpact = impact.age - impact.approachDuration;
        if (afterImpact < impact.flattenDuration) drawFlatten(impact, afterImpact / impact.flattenDuration);
        else {
          const dispersion = (afterImpact - impact.flattenDuration) / impact.dispersionDuration;
          if (dispersion >= 1) impact.active = false; else drawDispersion(impact, dispersion);
        }
      }
    }
    for (const fragment of fragments) {
      if (!fragment.active) continue;
      fragment.age += delta * 1000;
      const progress = fragment.age / fragment.lifetime;
      if (progress >= 1) { fragment.active = false; continue; }
      fragment.x += fragment.vx * delta; fragment.y += fragment.vy * delta;
      const damping = Math.pow(.07, delta); fragment.vx *= damping; fragment.vy *= damping;
      context.globalAlpha = fragment.opacity * (1 - progress); context.fillStyle = '#d3f3ff';
      context.beginPath(); context.ellipse(fragment.x, fragment.y, fragment.size * (1 - progress * .35), fragment.size * (1 - progress * .35), 0, 0, Math.PI * 2); context.fill();
    }
    const flash = updateFlash(now);
    if (flash > 0) { context.globalAlpha = flash; context.fillStyle = '#dff5ff'; context.fillRect(allowed.x, allowed.y, allowed.width, allowed.height); }
    context.restore(); context.globalAlpha = 1;
    if (mode === 'rain' || mode === 'storm') { frameId = requestFrame(renderFrame); requestedFrames += 1; }
  };

  const start = () => {
    if (frameId !== null) return;
    lastFrameAt = null; frameId = requestFrame(renderFrame); requestedFrames += 1;
  };
  const stop = () => {
    if (frameId !== null) { cancelFrame(frameId); cancelledFrames += 1; frameId = null; }
    lastFrameAt = null; burstRemaining = 0; secondaryFlashAt = 0; flashUntil = 0;
    for (const impact of impacts) impact.active = false;
    for (const fragment of fragments) fragment.active = false;
    clear();
  };
  const setMode = nextMode => {
    const next = nextMode === 'rain' || nextMode === 'storm' ? nextMode : 'none';
    if (next === mode) return;
    const wasRunning = mode === 'rain' || mode === 'storm'; mode = next;
    if (mode === 'none') { stop(); return; }
    const currentTime = now();
    currentRate = mode === 'storm' ? 11 : 6; targetRate = currentRate;
    nextEventAt = wasRunning ? Math.min(nextEventAt, currentTime + 80) : currentTime;
    nextRateChangeAt = currentTime + between(random, 2600, 6100);
    nextBurstAt = currentTime + (mode === 'storm' ? between(random, 3200, 8500) : between(random, 12000, 26000));
    if (mode === 'storm') nextFlashAt = currentTime + between(random, 5000, 14000);
    start();
  };

  resize();
  const resizeObserver = createResizeObserver(() => resize());
  resizeObserver?.observe(observedElement);
  return {
    setMode,
    resize,
    destroy() { mode = 'none'; stop(); resizeObserver?.disconnect(); },
    state() {
      return {
        mode, running: frameId !== null, frameId, currentRate, targetRate,
        activeImpacts: impacts.filter(item => item.active).length,
        activeFragments: fragments.filter(item => item.active).length,
        emittedEvents, emittedFragments, emittedBursts, emittedFlashes, variantCounts: { ...variantCounts },
        bufferWidth, bufferHeight, dpr, requestedFrames, cancelledFrames, resizeCount,
      };
    },
  };
}
