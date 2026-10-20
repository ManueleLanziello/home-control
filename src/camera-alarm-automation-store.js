import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class CameraAlarmAutomationStore {
  constructor({ filePath }) { this.filePath = filePath; this.writeQueue = Promise.resolve(); }

  async read() {
    try { return { enabled: JSON.parse(await readFile(this.filePath, 'utf8'))?.enabled === true }; }
    catch { return { enabled: false }; }
  }

  async set(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Stato automazione CAM non valido');
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return { enabled };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}
