import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SENSOR_THRESHOLD_IDS = Object.freeze(['S1', 'S2', 'S3', 'S4', 'S5']);
const validThreshold = value => Number.isFinite(value) && value >= -50 && value <= 80;

export class SensorThresholdStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      const thresholds = Object.fromEntries(SENSOR_THRESHOLD_IDS
        .filter(id => validThreshold(saved?.thresholds?.[id]))
        .map(id => [id, saved.thresholds[id]]));
      return { thresholds };
    } catch { return { thresholds: {} }; }
  }

  async set(id, minimumTemperature) {
    if (!SENSOR_THRESHOLD_IDS.includes(id)) throw new Error('Sensore non valido');
    if (minimumTemperature !== null && !validThreshold(minimumTemperature)) throw new Error('Soglia temperatura non valida');
    const operation = this.writeQueue.then(async () => {
      const current = await this.read();
      const thresholds = { ...current.thresholds };
      if (minimumTemperature === null) delete thresholds[id];
      else thresholds[id] = minimumTemperature;
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, thresholds }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return { thresholds };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}
