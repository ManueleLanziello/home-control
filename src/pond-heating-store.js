import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const defaults = () => ({
  version: 1,
  config: { mode: 'manual', threshold: 18, repetitions: 4, onMinutes: 20, offMinutes: 30 },
  activeCycle: null,
  history: [],
  nextCycleId: 1,
  lastCompletedMeasurementAt: null,
});

const finite = value => Number.isFinite(value);
const validMode = value => value === 'manual' || value === 'thermostat';
const validConfig = config => validMode(config?.mode)
  && finite(config.threshold)
  && Number.isInteger(config.repetitions) && config.repetitions > 0
  && finite(config.onMinutes) && config.onMinutes > 0
  && finite(config.offMinutes) && config.offMinutes >= 0;

function normalize(saved) {
  const initial = defaults();
  const config = validConfig(saved?.config) ? { ...saved.config } : initial.config;
  return {
    ...initial,
    ...saved,
    config,
    activeCycle: saved?.activeCycle && typeof saved.activeCycle === 'object' ? structuredClone(saved.activeCycle) : null,
    history: Array.isArray(saved?.history) ? structuredClone(saved.history) : [],
    nextCycleId: Number.isInteger(saved?.nextCycleId) && saved.nextCycleId > 0 ? saved.nextCycleId : initial.nextCycleId,
    lastCompletedMeasurementAt: typeof saved?.lastCompletedMeasurementAt === 'string' ? saved.lastCompletedMeasurementAt : null,
  };
}

export class PondHeatingStore {
  constructor({ filePath }) { this.filePath = filePath; this.writeQueue = Promise.resolve(); }

  async read() {
    try { return normalize(JSON.parse(await readFile(this.filePath, 'utf8'))); }
    catch { return defaults(); }
  }

  async update(mutator) {
    const operation = this.writeQueue.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      const next = normalize(state);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return { state: next, result };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}

export function validatePondHeatingConfig(input, previous = defaults().config) {
  const config = {
    mode: input?.mode ?? previous.mode,
    threshold: Number(input?.threshold ?? previous.threshold),
    repetitions: Number(input?.repetitions ?? previous.repetitions),
    onMinutes: Number(input?.onMinutes ?? previous.onMinutes),
    offMinutes: Number(input?.offMinutes ?? previous.offMinutes),
  };
  if (!validConfig(config)) throw new TypeError('Configurazione termostato Pond non valida.');
  return config;
}
