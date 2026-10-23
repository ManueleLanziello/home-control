import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createWt200DiagnosticFileLogger } from '../src/wt200-diagnostic-file-logger.js';
import { createHomeWt200Runtime, DEFAULT_WT200_DIAGNOSTIC_FILE } from '../src/wt200-runtime.js';

async function temporaryLog() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wt200-diagnostics-'));
  return { directory, filePath: path.join(directory, 'logs', 'wt200-diagnostics.log') };
}

test('diagnostica file resta completamente inattiva con flag assente o disabilitato', async () => {
  for (const flagValue of [undefined, '0']) {
    const { directory, filePath } = await temporaryLog();
    try {
      const previous = process.env.WT200_SCHEDULE_DIAGNOSTICS;
      if (flagValue === undefined) delete process.env.WT200_SCHEDULE_DIAGNOSTICS;
      else process.env.WT200_SCHEDULE_DIAGNOSTICS = flagValue;
      try {
        const runtime = createHomeWt200Runtime({
          deviceId: 'wt200-1', lanIp: '127.0.0.1', localKey: 'secret',
          diagnosticFilePath: filePath,
        });
        assert.equal(runtime.lanAdapter.scheduleDiagnostics, false);
        await assert.rejects(stat(filePath), { code: 'ENOENT' });
      } finally {
        if (previous === undefined) delete process.env.WT200_SCHEDULE_DIAGNOSTICS;
        else process.env.WT200_SCHEDULE_DIAGNOSTICS = previous;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('flag attivo crea directory e file, poi accoda messaggi leggibili in append', async () => {
  const { directory, filePath } = await temporaryLog();
  const previous = process.env.WT200_SCHEDULE_DIAGNOSTICS;
  try {
    process.env.WT200_SCHEDULE_DIAGNOSTICS = '1';
    const runtime = createHomeWt200Runtime({
      deviceId: 'wt200-1', lanIp: '127.0.0.1', localKey: 'secret',
      diagnosticFilePath: filePath,
    });
    const logger = runtime.lanAdapter.diagnosticLogger;
    logger('[WT200 schedule diagnostics] {"timestamp":"2026-10-23T10:00:00.000Z","eventType":"get"}');
    logger('[WT200 schedule diagnostics] {"timestamp":"2026-10-23T10:00:01.000Z","eventType":"data"}');
    await logger.flush();

    assert.equal(logger.filePath, filePath);
    assert.equal(await readFile(filePath, 'utf8'),
      '[WT200 schedule diagnostics] {"timestamp":"2026-10-23T10:00:00.000Z","eventType":"get"}\n'
      + '[WT200 schedule diagnostics] {"timestamp":"2026-10-23T10:00:01.000Z","eventType":"data"}\n');
  } finally {
    if (previous === undefined) delete process.env.WT200_SCHEDULE_DIAGNOSTICS;
    else process.env.WT200_SCHEDULE_DIAGNOSTICS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('rotazione conserva un solo file precedente quando viene superata la dimensione massima', async () => {
  const { directory, filePath } = await temporaryLog();
  try {
    const logger = createWt200DiagnosticFileLogger({ filePath, maxBytes: 12, reportError: () => {} });
    logger('prima-riga');
    await logger.flush();
    logger('seconda-riga');
    await logger.flush();
    assert.equal(await readFile(`${filePath}.1`, 'utf8'), 'prima-riga\n');
    assert.equal(await readFile(filePath, 'utf8'), 'seconda-riga\n');

    logger('terza-riga');
    await logger.flush();
    assert.equal(await readFile(`${filePath}.1`, 'utf8'), 'seconda-riga\n');
    assert.equal(await readFile(filePath, 'utf8'), 'terza-riga\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('errori filesystem vengono segnalati senza throw e non bloccano i messaggi successivi', async () => {
  const errors = [];
  let attempts = 0;
  const logger = createWt200DiagnosticFileLogger({
    filePath: path.join(os.tmpdir(), 'not-written', 'wt200.log'),
    reportError: message => errors.push(message),
    fileSystem: {
      async mkdir() {}, async stat() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
      async rm() {}, async rename() {},
      async appendFile() { attempts += 1; if (attempts === 1) throw new Error('disk unavailable'); },
    },
  });

  assert.doesNotThrow(() => logger('first'));
  logger('second');
  await logger.flush();
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /disk unavailable/);
});

test('logger riceve soltanto la diagnostica ridotta del Core senza segreti o DP105 completo', async () => {
  const { directory, filePath } = await temporaryLog();
  const secretDeviceId = 'secret-device-id';
  const secretLocalKey = 'secret-local-key';
  const completeDp105 = 'full-dp105-payload-that-must-not-be-logged';
  try {
    const runtime = createHomeWt200Runtime({
      deviceId: secretDeviceId, lanIp: '192.0.2.10', localKey: secretLocalKey,
      scheduleDiagnostics: true, diagnosticFilePath: filePath,
    });
    runtime.lanAdapter.emitScheduleDiagnostics('data', { 105: completeDp105, 107: '1' }, '2026-10-23T10:00:00.000Z');
    await runtime.lanAdapter.diagnosticLogger.flush();
    const contents = await readFile(filePath, 'utf8');

    assert.match(contents, /"eventType":"data"/);
    const diagnostic = JSON.parse(contents.slice(contents.indexOf('{')));
    assert.deepEqual(diagnostic.dp105, {
      source: 'current', type: 'string', length: completeDp105.length, valid: false,
    });
    assert.doesNotMatch(contents, new RegExp(secretDeviceId));
    assert.doesNotMatch(contents, new RegExp(secretLocalKey));
    assert.doesNotMatch(contents, /192\.0\.2\.10/);
    assert.doesNotMatch(contents, new RegExp(completeDp105));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('percorso predefinito resta relativo alla root effettiva di Home-Control', () => {
  assert.equal(DEFAULT_WT200_DIAGNOSTIC_FILE, path.resolve('logs', 'wt200-diagnostics.log'));
});
