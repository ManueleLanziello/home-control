import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function isPeriod(value) {
  return value
    && Number.isInteger(value.hour)
    && Number.isInteger(value.minute)
    && Number.isInteger(value.unknownByte)
    && Number.isFinite(value.temperature);
}

function isSchedule(value) {
  return value
    && typeof value.raw === 'string'
    && Array.isArray(value.normalPeriods)
    && value.normalPeriods.length === 6
    && value.normalPeriods.every(isPeriod)
    && Array.isArray(value.restDayPeriods)
    && value.restDayPeriods.length === 2
    && value.restDayPeriods.every(isPeriod);
}

export class Wt200ScheduleStore {
  constructor({ filePath, fallbackFilePath = null }) {
    this.filePath = filePath;
    this.fallbackFilePath = fallbackFilePath;
  }

  async read() {
    const primary = await this.readFile(this.filePath);
    if (primary) return primary;
    return this.fallbackFilePath ? this.readFile(this.fallbackFilePath) : null;
  }

  async readFile(filePath) {
    try {
      const saved = JSON.parse(await readFile(filePath, 'utf8'));
      if (!saved?.deviceId || !isSchedule(saved.schedule)) return null;
      return structuredClone(saved);
    } catch {
      return null;
    }
  }

  async write({ deviceId, schedule, updatedAt }) {
    if (!deviceId || !isSchedule(schedule)) return null;
    const saved = { deviceId, schedule: structuredClone(schedule), updatedAt: updatedAt ?? null };
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(saved), 'utf8');
    await rename(temporaryPath, this.filePath);
    return saved;
  }
}
