import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { PondHeatingStore } from '../src/pond-heating-store.js';
import { PondHeatingController } from '../src/pond-heating-controller.js';

const pondSnapshot = (pump = 'ON', heater = 'OFF') => ({ plugs: [
  { role: 'pump', runtime: { state: pump, online: true, communicationDegraded: false, consecutiveFailures: 0 } },
  { role: 'heater', runtime: { state: heater, online: true, communicationDegraded: false, consecutiveFailures: 0 } },
] });

async function fixture(t, { stateFile = null } = {}) {
  const dir = stateFile ? null : await mkdtemp(path.join(os.tmpdir(), 'pond-heating-'));
  if (dir) t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PondHeatingStore({ filePath: stateFile || path.join(dir, 'pond-heating.json') });
  const calls = []; const timers = [];
  const controller = new PondHeatingController({
    store,
    now: () => Date.parse('2026-10-23T10:01:00.000Z'),
    pondController: { async set(role, on) { calls.push([role, on]); return { role, state: on ? 'ON' : 'OFF' }; } },
    setTimeoutFn: operation => { timers.push(operation); return operation; },
    clearTimeoutFn: () => {},
  });
  await controller.initialize();
  await controller.observePondState(pondSnapshot());
  return { store, calls, timers, controller };
}

const live = (value, updatedAt) => ({ temperature: value, updatedAt, online: true, available: true, confirmed: true });

test('un ciclo termostatico congela la configurazione, alterna ON/OFF e richiede una nuova misura dopo il completamento', async t => {
  const { controller, calls, timers } = await fixture(t);
  await controller.setConfig({ mode: 'thermostat', threshold: 18, repetitions: 2, onMinutes: 1, offMinutes: 1 });
  await controller.observeS5(live(17, '2026-10-23T10:00:00.000Z'));
  assert.deepEqual(calls, [['heater', true]]);
  assert.equal((await controller.snapshot()).activeCycle.config.repetitions, 2);
  await controller.setConfig({ mode: 'thermostat', threshold: 22, repetitions: 5, onMinutes: 4, offMinutes: 6 });
  assert.equal((await controller.snapshot()).config.repetitions, 5);
  assert.equal((await controller.snapshot()).activeCycle.config.repetitions, 2);
  assert.deepEqual((await controller.snapshot()).latestMeasurement, { value: 17, updatedAt: '2026-10-23T10:00:00.000Z' });
  timers.shift()(); await controller.queue;
  assert.deepEqual(calls, [['heater', true], ['heater', false]]);
  timers.shift()(); await controller.queue;
  assert.deepEqual(calls, [['heater', true], ['heater', false], ['heater', true]]);
  timers.shift()(); await controller.queue;
  const completed = await controller.snapshot();
  assert.equal(completed.activeCycle, null);
  assert.equal(completed.history.length, 1);
  assert.equal(completed.history[0].result, 'COMPLETATO');
  await controller.observeS5(live(17, '2026-10-23T10:00:00.000Z'));
  assert.equal((await controller.snapshot()).activeCycle, null);
  await controller.observeS5(live(17, '2026-10-23T10:01:00.000Z'));
  assert.equal((await controller.snapshot()).activeCycle?.phase, 'on');
});

test('il passaggio a manuale interrompe subito il ciclo, spegne il riscaldatore e conserva la configurazione attiva nello storico', async t => {
  const { controller, calls } = await fixture(t);
  await controller.setConfig({ mode: 'thermostat', threshold: 18, repetitions: 3, onMinutes: 20, offMinutes: 30 });
  await controller.observeS5(live(16, '2026-10-23T10:00:00.000Z'));
  await controller.setConfig({ mode: 'manual', threshold: 19, repetitions: 1, onMinutes: 2, offMinutes: 0 });
  const state = await controller.snapshot();
  assert.deepEqual(calls, [['heater', true], ['heater', false]]);
  assert.equal(state.config.mode, 'manual');
  assert.equal(state.history[0].result, 'INTERROTTO — MODALITÀ MANUALE');
  assert.deepEqual(state.history[0].config, { mode: 'thermostat', threshold: 18, repetitions: 3, onMinutes: 20, offMinutes: 30 });
});

test('un errore durante lo spegnimento mantiene la modalità termostato e non rende disponibili i comandi manuali', async t => {
  const { controller, calls } = await fixture(t);
  await controller.setConfig({ mode: 'thermostat', threshold: 18, repetitions: 1, onMinutes: 20, offMinutes: 0 });
  await controller.observeS5(live(16, '2026-10-23T10:00:00.000Z'));
  controller.pondController.set = async (role, on) => { calls.push([role, on]); if (!on) throw new Error('readback OFF non confermato'); };
  await assert.rejects(controller.setConfig({ mode: 'manual' }), /readback OFF non confermato/);
  const state = await controller.snapshot();
  assert.equal(state.config.mode, 'thermostat');
  assert.equal(state.activeCycle?.phase, 'interrupting');
});

test('un ciclo persistente viene registrato come interrotto al riavvio senza riattivare il riscaldatore', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pond-heating-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'pond-heating.json');
  const first = await fixture(t, { stateFile });
  await first.controller.setConfig({ mode: 'thermostat', threshold: 18, repetitions: 1, onMinutes: 1, offMinutes: 0 });
  await first.controller.observeS5(live(17, '2026-10-23T10:00:00.000Z'));
  const second = await fixture(t, { stateFile });
  const state = await second.controller.snapshot();
  assert.equal(state.activeCycle, null);
  assert.equal(state.deviceVerified, true);
  assert.equal(state.history.at(-1).result, 'INTERROTTO — RIAVVIO');
  assert.deepEqual(second.calls, []);
});


async function immediateFixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pond-immediate-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const store = new PondHeatingStore({filePath:path.join(dir,'state.json')});
  let time = Date.parse('2026-10-23T10:00:00.000Z');
  let sensor = live(9.9, new Date(time).toISOString());
  const calls = [], timers = [], intervals = [], cleared = [];
  const controller = new PondHeatingController({store, now:()=>time, readS5:()=>sensor,
    setIntervalFn:(fn,ms)=>{const entry={fn,ms}; intervals.push(entry); return entry;}, clearIntervalFn:id=>cleared.push(id),
    pondController:{async set(role,on){calls.push([role,on]); if (overrides.fail && on) { const e=new Error('offline'); e.code='DEVICE_WRITE_FAILED'; throw e; } }},
    setTimeoutFn:fn=>{timers.push(fn);return fn;}, clearTimeoutFn:()=>{}});
  await controller.initialize();
  t.after(()=>controller.dispose());
  return {controller,store,calls,timers,intervals,cleared, setSensor:value=>{sensor=value;}, advance:ms=>{time+=ms;}, now:()=>time, overrides};
}

test('attivazione usa subito S5 live, con pompa verificata e senza duplicati', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot());
  await f.controller.setConfig({mode:'thermostat', threshold:11, repetitions:2, onMinutes:30, offMinutes:15});
  assert.deepEqual(f.calls, [['heater',true]]);
  await Promise.all([f.controller.observePondState(pondSnapshot()),f.controller.observePondState(pondSnapshot())]);
  assert.equal(f.calls.length,1);
  f.timers.shift()(); await f.controller.queue;
  await f.controller.observePondState(pondSnapshot());
  assert.deepEqual(f.calls, [['heater',true],['heater',false]]);
  assert.equal((await f.controller.snapshot()).activeCycle.phase,'off');
  await f.controller.setConfig({mode:'manual'}); await f.controller.observePondState(pondSnapshot());
  assert.equal(f.calls.filter(c=>c[1]).length,1);
});

test('S5 sopra soglia, assente, non confermata, futura o obsoleta non avvia', async t => {
  for (const kind of ['high','equal','missing','unavailable','old','future']) {
    const f=await immediateFixture(t); const now=f.now();
    f.setSensor(kind==='missing'?null:kind==='high'?live(12,new Date(now).toISOString()):kind==='equal'?live(11,new Date(now).toISOString()):kind==='unavailable'?{...live(9,new Date(now).toISOString()),available:false}:live(9,new Date(now+(kind==='old'?-7200001:1000)).toISOString()));
    await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11}); assert.equal(f.calls.length,0,kind);
  }
});

test('pompa OFF o non verificata blocca, recupero verificato avvia senza nuova misura', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot('OFF'));
  await f.controller.setConfig({mode:'thermostat',threshold:11}); assert.equal(f.calls.length,0);
  const bad=pondSnapshot(); bad.plugs[0].runtime.communicationDegraded=true;
  await f.controller.observePondState(bad); assert.equal(f.calls.length,0);
  await f.controller.observePondState(pondSnapshot()); assert.deepEqual(f.calls,[['heater',true]]);
});

test('errore temporaneo usa retry con attesa crescente', async t => {
  const f=await immediateFixture(t,{fail:true}); await f.controller.observePondState(pondSnapshot());
  await f.controller.setConfig({mode:'thermostat',threshold:11}); assert.equal(f.calls.length,1);
  await f.controller.observePondState(pondSnapshot()); assert.equal(f.calls.length,1);
  f.advance(60000); await f.controller.observePondState(pondSnapshot()); assert.equal(f.calls.length,2);
  f.advance(60000); await f.controller.observePondState(pondSnapshot()); assert.equal(f.calls.length,2);
});

test('al riavvio valuta S5 disponibile dopo verifica prese senza ripartire durante la pausa', async t => {
  const f=await immediateFixture(t); await f.controller.setConfig({mode:'thermostat',threshold:11});
  const recovered = new PondHeatingController({store:f.store, now:f.now, readS5:()=>live(9.9,new Date(f.now()).toISOString()), pondController:{async set(role,on){f.calls.push([role,on]);}}, setTimeoutFn:()=>1, clearTimeoutFn:()=>{}});
  await recovered.initialize(); await recovered.observePondState(pondSnapshot()); assert.deepEqual(f.calls,[['heater',true]]);
});

test('pulizia persistente conserva ciclo attivo e configurazione', async t => {
  const f=await immediateFixture(t); await f.store.update(s=>{s.history=[{id:4,result:'COMPLETATO'}];});
  await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:2,onMinutes:30,offMinutes:15});
  const before=await f.controller.snapshot(); await f.controller.clearHistory(); const after=await f.controller.snapshot();
  assert.deepEqual(after.history,[]); assert.deepEqual(after.activeCycle,before.activeCycle); assert.deepEqual(after.config,before.config);
  assert.deepEqual((await new PondHeatingStore({filePath:f.store.filePath}).read()).history,[]);
});


test('riavvio durante pausa OFF rispetta la pausa prima di rivalutare', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot());
  await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:2,onMinutes:30,offMinutes:15});
  f.timers.shift()(); await f.controller.queue; assert.equal((await f.controller.snapshot()).activeCycle.phase,'off');
  const recovered=new PondHeatingController({store:f.store, now:f.now, readS5:()=>live(9.9,new Date(f.now()).toISOString()), pondController:{async set(role,on){f.calls.push([role,on]);}},setTimeoutFn:()=>1,clearTimeoutFn:()=>{}});
  await recovered.initialize(); await recovered.observePondState(pondSnapshot()); assert.equal(f.calls.filter(c=>c[1]).length,1);
  const restartedAgain=new PondHeatingController({store:f.store, now:f.now, readS5:()=>live(9.9,new Date(f.now()).toISOString()), pondController:{async set(role,on){f.calls.push([role,on]);}},setTimeoutFn:()=>1,clearTimeoutFn:()=>{}});
  await restartedAgain.initialize(); await restartedAgain.observePondState(pondSnapshot()); assert.equal(f.calls.filter(c=>c[1]).length,1);
  f.advance(15*60000-1); await recovered.observePondState(pondSnapshot()); assert.equal(f.calls.filter(c=>c[1]).length,1);
  f.advance(1); await recovered.observePondState(pondSnapshot()); assert.equal(f.calls.filter(c=>c[1]).length,2);
});

test('retry recuperato avvia una volta e rimane fermo dopo passaggio manuale', async t => {
  const f=await immediateFixture(t,{fail:true}); await f.controller.observePondState(pondSnapshot());
  await f.controller.setConfig({mode:'thermostat',threshold:11}); f.overrides.fail=false; f.advance(60000);
  await f.controller.observePondState(pondSnapshot()); assert.equal((await f.controller.snapshot()).activeCycle.phase,'on');
  await f.controller.setConfig({mode:'manual'}); f.advance(60000); await f.controller.observePondState(pondSnapshot());
  assert.deepEqual(f.calls,[['heater',true],['heater',true],['heater',false]]);
});


test('errore alla ripetizione consente un retry dopo la pausa e il raffreddamento', async t => {
  const f=await immediateFixture(t,{fail:false}); await f.controller.observePondState(pondSnapshot());
  await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:2,onMinutes:30,offMinutes:15});
  f.timers.shift()(); await f.controller.queue; f.overrides.fail=true;
  f.timers.shift()(); await f.controller.queue; assert.equal((await f.controller.snapshot()).activeCycle,null);
  f.overrides.fail=false; f.advance(60000); await f.controller.observePondState(pondSnapshot());
  assert.equal((await f.controller.snapshot()).activeCycle.phase,'on');
});


test('rivalutazione periodica non riavvia con la stessa misura dopo completamento', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot());
  await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:1,onMinutes:1,offMinutes:0});
  assert.equal(f.intervals.length,1); assert.equal(f.intervals[0].ms,60000);
  f.timers.shift()(); await f.controller.queue; assert.equal((await f.controller.snapshot()).activeCycle,null);
  f.advance(60000); f.intervals[0].fn(); await f.controller.queue; await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(c=>c[1]).length,1);
  await f.controller.clearHistory(); await f.controller.setConfig({mode:'manual'}); await f.controller.setConfig({mode:'thermostat'});
  assert.equal(f.calls.filter(c=>c[1]).length,1);
  f.setSensor(live(9.9,new Date(f.now()).toISOString())); await f.controller.observePondState(pondSnapshot());
  assert.equal(f.calls.filter(c=>c[1]).length,2);
  await f.controller.setConfig({mode:'manual'}); assert.equal(f.cleared.length,2);
});

test('retry persiste al riavvio, attende il backoff e recupera dopo piu errori', async t => {
  const f=await immediateFixture(t,{fail:true}); await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11});
  assert.equal((await f.controller.snapshot()).retry.failures,1);
  const restarted=new PondHeatingController({store:f.store,now:f.now,readS5:()=>live(9.9,new Date(f.now()).toISOString()),pondController:{async set(r,on){f.calls.push([r,on]);if(on && f.overrides.fail){const e=new Error('offline');e.code='DEVICE_WRITE_FAILED';throw e;}}},setTimeoutFn:()=>1,clearTimeoutFn:()=>{},setIntervalFn:()=>1,clearIntervalFn:()=>{}});
  t.after(()=>restarted.dispose()); await restarted.initialize(); await restarted.observePondState(pondSnapshot()); assert.equal(f.calls.length,1);
  f.advance(60000); await restarted.observePondState(pondSnapshot()); assert.equal(f.calls.length,2); assert.equal((await restarted.snapshot()).retry.failures,2);
  f.overrides.fail=false; f.advance(119999); await restarted.observePondState(pondSnapshot()); assert.equal(f.calls.length,2);
  f.advance(1); await restarted.observePondState(pondSnapshot()); assert.equal(f.calls.length,3); assert.equal((await restarted.snapshot()).activeCycle.phase,'on');
});

test('errore non classificato blocca i retry fino alla riattivazione esplicita', async t => {
  const f=await immediateFixture(t); f.controller.pondController.set=async (r,on)=>{f.calls.push([r,on]); if(on){const e=new Error('mismatch');e.code='STATE_MISMATCH';throw e;}};
  await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11}); assert.equal((await f.controller.snapshot()).retry.kind,'blocked');
  f.advance(600000); await f.controller.observePondState(pondSnapshot()); assert.equal(f.calls.length,1);
  await f.controller.setConfig({mode:'manual'}); f.controller.pondController.set=async(r,on)=>f.calls.push([r,on]);
  await f.controller.setConfig({mode:'thermostat'}); assert.equal(f.calls.length,2);
});

test('perdita pompa interrompe il ciclo e recupera dopo la verifica e attesa', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11});
  await f.controller.observePondState(pondSnapshot('OFF')); assert.deepEqual(f.calls,[['heater',true],['heater',false]]);
  await f.controller.observePondState(pondSnapshot()); assert.equal(f.calls.length,2);
  f.advance(60000); await f.controller.observePondState(pondSnapshot()); assert.equal(f.calls.length,3);
});

test('STOP intenzionale persiste e impedisce ripartenze anche dopo riavvio', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11});
  await f.controller.interrupt('STOP'); assert.equal((await f.controller.snapshot()).stopped,true);
  const restarted=new PondHeatingController({store:f.store,now:f.now,readS5:()=>live(9,new Date(f.now()).toISOString()),pondController:{async set(r,on){f.calls.push([r,on]);}},setIntervalFn:()=>1,clearIntervalFn:()=>{}});
  t.after(()=>restarted.dispose()); await restarted.initialize(); f.advance(120000); await restarted.observePondState(pondSnapshot()); assert.deepEqual(f.calls,[['heater',true],['heater',false]]);
});

test('pulizia storico durante pausa non modifica timer e ciclo', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:2,onMinutes:1,offMinutes:1});
  f.timers.shift()(); await f.controller.queue; const timer=f.controller.timer; const before=await f.controller.snapshot(); await f.controller.clearHistory();
  assert.equal(f.controller.timer,timer); assert.deepEqual((await f.controller.snapshot()).activeCycle,before.activeCycle);
  f.timers.shift()(); await f.controller.queue; assert.deepEqual(f.calls,[['heater',true],['heater',false],['heater',true]]);
});


test('durate ON e OFF e numero ripetizioni restano quelli configurati', async t => {
  const f=await immediateFixture(t); const armed=[];
  f.controller.setTimeoutFn=(fn,delay)=>{const event={fn,delay};armed.push(event);return event;};
  await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:2,onMinutes:30,offMinutes:15});
  assert.equal(armed[0].delay,30*60000); armed.shift().fn(); await f.controller.queue;
  assert.equal(armed[0].delay,15*60000); armed.shift().fn(); await f.controller.queue;
  assert.equal(armed[0].delay,30*60000); armed.shift().fn(); await f.controller.queue;
  assert.deepEqual(f.calls,[['heater',true],['heater',false],['heater',true],['heater',false]]);
  assert.equal((await f.controller.snapshot()).history.at(-1).result,'COMPLETATO');
});

test('valutazioni concorrenti restano serializzate senza duplicare ON', async t => {
  const f=await immediateFixture(t); let release; const gate=new Promise(resolve=>{release=resolve;});
  f.controller.pondController.set=async(r,on)=>{f.calls.push([r,on]); if(on) await gate;};
  await f.controller.observePondState(pondSnapshot()); const activation=f.controller.setConfig({mode:'thermostat',threshold:11});
  while (!f.calls.length) await new Promise(resolve=>setImmediate(resolve));
  const second=f.controller.observePondState(pondSnapshot()); f.intervals[0].fn(); f.intervals[0].fn();
  release(); await Promise.all([activation,second]); await f.controller.queue;
  assert.deepEqual(f.calls,[['heater',true]]); assert.equal((await f.controller.snapshot()).history.length,0);
});


test('variazioni S5 e assenza trasmissioni non alterano le ripetizioni avviate', async t => {
  for (const scenario of ['above','below','silent']) {
    const f=await immediateFixture(t); const armed=[];
    f.controller.setTimeoutFn=(fn,delay)=>{const event={fn,delay};armed.push(event);return event;};
    await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:2,onMinutes:30,offMinutes:15});
    const firstTimer=f.controller.timer; f.advance(10*60000);
    if (scenario !== 'silent') { const sample=live(scenario==='above'?14:8,new Date(f.now()).toISOString()); f.setSensor(sample); await f.controller.observeS5(sample); }
    assert.equal(f.controller.timer,firstTimer,scenario); assert.equal(armed[0].delay,30*60000);
    f.advance(20*60000); armed.shift().fn(); await f.controller.queue;
    assert.equal(armed[0].delay,15*60000); const pauseTimer=f.controller.timer;
    if (scenario !== 'silent') await f.controller.observeS5(live(scenario==='above'?14:8,new Date(f.now()).toISOString()));
    assert.equal(f.controller.timer,pauseTimer,scenario);
    f.advance(15*60000); armed.shift().fn(); await f.controller.queue;
    assert.equal(armed[0].delay,30*60000); f.advance(30*60000); armed.shift().fn(); await f.controller.queue;
    assert.deepEqual(f.calls,[['heater',true],['heater',false],['heater',true],['heater',false]],scenario);
    const completed=(await f.controller.snapshot()).history.at(-1); assert.equal(completed.result,'COMPLETATO');
    assert.equal(completed.initialMeasurement.value,9.9); assert.equal(completed.finalMeasurement.value,scenario==='above'?14:scenario==='below'?8:9.9);
    assert.ok(Math.abs(completed.deltaTemperature-(completed.finalMeasurement.value-9.9))<1e-9);
  }
});

test('temperatura finale usa misura runtime piu recente anche senza evento osservato', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot());
  await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:1,onMinutes:30,offMinutes:0});
  f.advance(30*60000); f.setSensor(live(12,new Date(f.now()).toISOString()));
  f.timers.shift()(); await f.controller.queue; const done=(await f.controller.snapshot()).history.at(-1);
  assert.equal(done.finalMeasurement.value,12); assert.ok(Math.abs(done.deltaTemperature-2.1)<1e-9);
  assert.equal(done.finalMeasurement.updatedAt,new Date(f.now()).toISOString());
});


test('completamento blocca la stessa misura anche dopo riavvio e vecchia scadenza periodica', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:1,onMinutes:1,offMinutes:0});
  f.timers.shift()(); await f.controller.queue; await f.store.update(s=>{s.nextHeatingEvaluationAt=new Date(f.now()).toISOString();});
  const restarted=new PondHeatingController({store:f.store,now:f.now,readS5:()=>live(9.9,new Date(f.now()).toISOString()),pondController:{async set(role,on){f.calls.push([role,on]);}},setIntervalFn:()=>1,clearIntervalFn:()=>{}});
  t.after(()=>restarted.dispose()); await restarted.initialize(); await restarted.observePondState(pondSnapshot()); assert.deepEqual(f.calls,[['heater',true],['heater',false]]);
});

test('errore lettura S5 finale conserva ultima misura e completa il ciclo', async t => {
  const f=await immediateFixture(t); await f.controller.observePondState(pondSnapshot()); await f.controller.setConfig({mode:'thermostat',threshold:11,repetitions:1,onMinutes:1,offMinutes:0});
  f.controller.readS5=()=>{throw new Error('unavailable');}; f.timers.shift()(); await f.controller.queue;
  const state=await f.controller.snapshot(); assert.equal(state.activeCycle,null); assert.equal(state.history.at(-1).result,'COMPLETATO'); assert.equal(state.history.at(-1).finalMeasurement.value,9.9);
});
