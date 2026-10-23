import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const WT200_DIAGNOSTIC_MAX_BYTES = 1024 * 1024;

function reportWriteError(reportError, error) {
  if (typeof reportError !== 'function') return;
  try {
    reportError(`[WT200 schedule diagnostics] file write failed: ${error?.message || 'unknown error'}`);
  } catch {
    // Diagnostic failures must never interfere with the WT200 runtime.
  }
}

export function createWt200DiagnosticFileLogger({
  filePath,
  maxBytes = WT200_DIAGNOSTIC_MAX_BYTES,
  reportError = console.error,
  fileSystem = { appendFile, mkdir, rename, rm, stat },
} = {}) {
  if (!filePath) throw new TypeError('filePath è obbligatorio per la diagnostica WT200.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes deve essere un intero positivo.');

  const rotatedFilePath = `${filePath}.1`;
  let writeQueue = Promise.resolve();

  const write = async (message) => {
    const line = `${String(message).replace(/[\r\n]+$/u, '')}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });

    let currentBytes = 0;
    try {
      currentBytes = (await fileSystem.stat(filePath)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
      await fileSystem.rm(rotatedFilePath, { force: true });
      await fileSystem.rename(filePath, rotatedFilePath);
    }
    await fileSystem.appendFile(filePath, line, 'utf8');
  };

  const logger = (message) => {
    writeQueue = writeQueue.then(() => write(message)).catch((error) => {
      reportWriteError(reportError, error);
    });
  };
  logger.flush = () => writeQueue;
  logger.filePath = filePath;
  logger.rotatedFilePath = rotatedFilePath;
  return logger;
}
