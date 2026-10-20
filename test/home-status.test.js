import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { HomeStatusRuntime, HOME_ROLES, normalizeThermostat } from '../src/home-status.js';
import { HomeDewinRuntime } from '../src/dewin-runtime.js';
import { normalizeHardwareRecord } from '../src/hardware-registry.js';
import { HomeWt200Runtime } from '../src/wt200-runtime.js';
import { createFloorplanState } from '../public/js/floorplan-state.js';
import { createHomeControlServer } from '../server.js';
const time = Date.parse('2026-09-09T12:00:00Z');
const stamp = new Date(time).toISOString();
const wt = () => ({ online: true, updatedAt: stamp, heatingActive: true, thermostat: {currentTemperature:22, setpointTemperature:24, mode:'manual'} });
const device = id => normalizeHardwareRecord({ id, alias:id, model:'Dewin', protocol:'tuya-cloud', connectionType:'cloud', configurationStatus:'complete', verificationStatus:'verified', identity:{tuyaDeviceId:'physical-'+id}, metadata:{adapter:'dewin-tuya'} });

test('S5 usa lo snapshot Zigbee acqua e non attiva il runtime Dewin', async () => {
  let cloudReads = 0;
  const runtime = new HomeStatusRuntime({ hardwareStore: { read: async () => ({ devices: [device('S5')], inventory: [] }) }, roleStore: { read: async () => ({ S5: 'temperature_giardino' }) }, readPresence: async () => ({}), readThermostat: async () => null, now: () => time,
    readZigbeeSensors: () => ({ S5: { temperature: 12.4, battery: 87, linkQuality: 93, name: 'SONOFF — Temperatura acqua', model: 'SNZB-02LD', protocol: 'Zigbee', online: true, available: true, updatedAt: stamp } }),
    createSensorRuntime: () => { cloudReads += 1; throw Error('S5 non deve usare Dewin'); },
  });
  const s = (await runtime.readSnapshot()).sensors.S5;
  assert.equal(s.value, 12.4); assert.equal(s.temperature, 12.4); assert.equal(s.humidity, null); assert.equal(s.battery, 87); assert.equal(s.linkQuality, 93); assert.equal(s.source, 'zigbee'); assert.equal(cloudReads, 0);
  const store = createFloorplanState(); store.applyHomeSnapshot({ sensors: { S5: s } });
  assert.equal(store.snapshot().sensors.S5, 12.4); assert.equal(store.snapshot().sensorDetails.S5.humidity, null);
});
function fixture(overrides={}) {
  const devices=['S1','S2','S4','S5'].map(device);
  return { hardwareStore:{async read(){return {devices};}}, roleStore:{async read(){return Object.fromEntries(devices.map(d=>[d.id,HOME_ROLES[d.id]]));}}, readThermostat:async()=>wt(), now:()=>time,
    readZigbeeSensors: () => ({ S1: { temperature: 20, humidity: 50, online: true, available: true, updatedAt: stamp, model: 'SONOFF SNZB-02P' }, S2: { temperature: 24, humidity: 50, online: true, available: true, updatedAt: stamp, model: 'SONOFF SNZB-02P' }, S4: { temperature: 26, humidity: 50, online: true, available: true, updatedAt: stamp, model: 'SONOFF SNZB-02P' }, S5: { temperature: 12, battery: 87, linkQuality: 93, online: true, available: true, updatedAt: stamp, model: 'SNZB-02LD' } }),
    createSensorRuntime:d=>({async readSnapshot(){return {online:true,updatedAt:stamp,measurements:{ambientTemperature:{value:({S1:20,S2:24,S4:26,S5:40})[d.id]}}};}}), ...overrides };
}
test('Zigbee sensors, S3 WT200 and indoor-only average remain independent from Dewin roles', async()=>{
  const runtime=new HomeStatusRuntime(fixture({createSensorRuntime:d=>new HomeDewinRuntime({device:d,now:()=>stamp,client:{async readDevice(){return {device:{id:d.identity.tuyaDeviceId,online:true},statuses:[{code:'temp_current',value:200}],specification:{status:[{code:'temp_current',type:'Integer',values:'{"scale":1,"unit":"℃"}'}]}};}}})}));
  const home=await runtime.readSnapshot();
  assert.equal(home.sensors.S1.value,20);
  assert.equal(home.sensors.S3.value,22);
  assert.equal(home.sensors.S3.source,'thermostat');
 assert.equal(home.averageTemperature,23);
  assert.equal(home.indoorSensorCount,4);
  assert.equal(home.thermostat.heatingActive,true);
  assert.equal(home.lights.L7.source,'simulation');
  assert.equal(home.cameras.C1.reason,'not_configured');
});
test('offline, stale, rejected, nonnumeric readings excluded; WT200 survives sensor failures',async()=>{
 const runtime=new HomeStatusRuntime(fixture({readZigbeeSensors:()=>({ S1:{temperature:20,online:false,available:false,updatedAt:stamp}, S2:{temperature:20,online:false,available:false,updatedAt:stamp}, S4:{temperature:20,online:false,available:false,updatedAt:new Date(time-1800001).toISOString()}, S5:{temperature:12,online:false,available:false,updatedAt:stamp} })}));
 const h=await runtime.readSnapshot();
 for(const id of ['S1','S2','S4','S5'])assert.equal(h.sensors[id].value,null);
 assert.equal(h.averageTemperature,null);assert.equal(h.indoorSensorCount,1);
});
test('concurrent clients share one read and registry reassignment invalidates cached state',async()=>{
 let reads=0;
 const options=fixture({readThermostat:async()=>{reads++;return wt();}});
 const runtime=new HomeStatusRuntime(options);
 await Promise.all([runtime.readSnapshot(),runtime.readSnapshot()]);
 await runtime.readSnapshot();assert.equal(reads,1);
 options.roleStore.read=async()=>({});
 assert.equal((await runtime.readSnapshot()).sensors.S1.value,20);assert.equal(reads,2);
});
test('cache cannot extend an already old sensor past freshness limit',async()=>{
 let now=time;
 const runtime=new HomeStatusRuntime(fixture({now:()=>now,readZigbeeSensors:()=>({ S1:{temperature:20,online:true,available:true,updatedAt:new Date(time-7199000).toISOString()}, S2:{temperature:20,online:true,available:true,updatedAt:stamp}, S4:{temperature:20,online:true,available:true,updatedAt:stamp}, S5:{temperature:12,online:true,available:true,updatedAt:stamp} })}));
 assert.equal((await runtime.readSnapshot()).sensors.S1.value,20);
 now+=6000;assert.equal((await runtime.readSnapshot()).sensors.S1.value,null);
});
test('invalidate impedisce a una lettura precedente di ripopolare la cache',async()=>{
 let thermostatVersion=1;let releaseOldCamera;let signalOldCamera;
 const oldCamera=new Promise(resolve=>{releaseOldCamera=resolve;});
 const oldCameraStarted=new Promise(resolve=>{signalOldCamera=resolve;});
 const options=fixture({
  readThermostat:async()=>({...wt(),heatingActive:thermostatVersion===2}),
  readCameras:async()=>{if(thermostatVersion===1){signalOldCamera();await oldCamera;}return {};},
 });
 const runtime=new HomeStatusRuntime(options);
 const oldRead=runtime.readSnapshot();
 await oldCameraStarted;
 thermostatVersion=2;runtime.invalidate();
 const current=await runtime.readSnapshot();
 assert.equal(current.thermostat.heatingActive,true);
 releaseOldCamera();await oldRead;
 assert.equal((await runtime.readSnapshot()).thermostat.heatingActive,true);
});
test('S1-S5 Zigbee snapshots do not instantiate Dewin adapters',async()=>{
 let reads=0;
 const runtime=new HomeStatusRuntime(fixture({cacheMs:0,createSensorRuntime:()=>{reads++;throw Error('non deve essere usato');}}));
 const h=await runtime.readSnapshot();assert.equal(h.sensors.S3.value,22);
 await runtime.readSnapshot();assert.equal(reads,0);
});
test('configured unsupported lights/cameras stay unavailable, never become simulators',async()=>{
 const options=fixture();options.hardwareStore.read=async()=>({devices:[device('lamp'),device('camera')]});
 options.roleStore.read=async()=>({lamp:HOME_ROLES.L1,camera:HOME_ROLES.C1});
 const h=await new HomeStatusRuntime(options).readSnapshot();
 assert.equal(h.lights.L1.reason,'unsupported_adapter');assert.equal(h.lights.L1.source,'hardware');
 assert.equal(h.cameras.C1.alias,'camera');assert.equal(h.cameras.C1.available,false);
});
test('WT200 LAN senza Cloud mantiene misure, modalita, relay e S3',async()=>{
 const runtime=new HomeWt200Runtime({lanAdapter:{async read(){return {updatedAt:stamp,heatingActive:false,thermostat:{currentTemperature:25.9,setpointTemperature:5.5,mode:'manual'}};}}});
 const thermostat=normalizeThermostat(await runtime.readSnapshot(),time);
 assert.equal(thermostat.online,true);assert.equal(thermostat.thermostat.currentTemperature,25.9);assert.equal(thermostat.thermostat.setpointTemperature,5.5);assert.equal(thermostat.thermostat.mode,'manual');assert.equal(thermostat.heatingActive,false);
 const home=await new HomeStatusRuntime({...fixture(),readThermostat:async()=>runtime.readSnapshot()}).readSnapshot();
 assert.equal(home.sensors.S3.value,25.9);assert.equal(home.sensors.S3.available,true);assert.equal(home.sensors.S3.online,true);
});
test('S3 conserva una misura LAN recente durante un errore, ma la nasconde dopo 90 secondi', () => {
 const snapshot={online:false,lanUpdatedAt:stamp,temperatureUpdatedAt:stamp,updatedAt:stamp,thermostat:{currentTemperature:22}};
 const recent=normalizeThermostat(snapshot,time+89_999);
 assert.equal(recent.online,false);assert.equal(recent.thermostat.currentTemperature,22);assert.equal(recent.temperatureUpdatedAt,stamp);
 const stale=normalizeThermostat(snapshot,time+90_001);
 assert.equal(stale.online,false);assert.equal(stale.thermostat.currentTemperature,null);assert.equal(stale.temperatureUpdatedAt,null);
 const store=createFloorplanState();store.applyThermostatSnapshot(recent);store.applyThermostatSnapshot({online:false,thermostat:{}});
 assert.equal(store.snapshot().sensors.S3,22);
 store.applyThermostatSnapshot(stale);assert.equal(store.snapshot().sensors.S3,null);
});
test('UI store synchronizes sensors, boiler, active simulated lights, and failure fallback',async()=>{
 const h=await new HomeStatusRuntime(fixture()).readSnapshot();const store=createFloorplanState();store.applyHomeSnapshot(h);
 for(const id of ['L1','L2','L5','L6','L7']){store.setLight(id,true);assert.equal(store.snapshot().lights[id],true);store.applyHomeSnapshot(h);assert.equal(store.snapshot().lights[id],true);store.setLight(id,false);assert.equal(store.snapshot().lights[id],false);}
 assert.equal(store.snapshot().sensors.S3,22);assert.equal(store.snapshot().boiler.on,true);assert.equal(store.snapshot().boiler.mode,'manual');
 store.applyThermostatSnapshot({heatingActive:false,thermostat:{currentTemperature:21.5,mode:'auto'}});assert.equal(store.snapshot().sensors.S3,21.5);assert.equal(store.snapshot().boiler.on,false);assert.equal(store.snapshot().boiler.mode,'auto');
 store.setLight('L1',true);store.applyHomeSnapshot();assert.equal(store.snapshot().lights.L1,true);assert.equal(store.snapshot().sensors.S3,null);
 h.lights.L1={source:'hardware',available:true,state:true};store.applyHomeSnapshot(h);store.setLight('L1',false);assert.equal(store.snapshot().lights.L1,true);
});
test('HTTP aggregate and thermostat share normalized read; static Dashboard/audio served',async()=>{
 let reads=0;
 const schedule={weekPattern:'5+2',normalPeriods:[{hour:6,minute:0,temperature:20}],restDayPeriods:[{hour:8,minute:0,temperature:20}]};
 const server=createHomeControlServer({hardwareStore:{async read(){return {devices:[]};}},roleStore:{async read(){return {};}},thermostatRuntime:{async readSnapshot(){reads++;return {...wt(),schedule,updatedAt:new Date().toISOString()};}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const h=await (await fetch(base+'/api/home/status')).json();
  const t=await (await fetch(base+'/api/thermostat')).json();
  assert.equal(h.sensors.S3.value,22);assert.deepEqual(t,h.thermostat);assert.deepEqual(h.thermostat.schedule,schedule);assert.equal(reads,1);
  assert.equal((await fetch(base+'/')).status,200);
  const audio=await fetch(base+'/sounds/switch.ogg');assert.equal(audio.status,200);assert.equal(audio.headers.get('content-type'),'audio/ogg');
  const temperatureAudio=await fetch(base+'/sounds/alarm/temperature-room-salotto.ogg');assert.equal(temperatureAudio.status,200);assert.equal(temperatureAudio.headers.get('content-type'),'audio/ogg');
 }finally{server.close();await once(server,'close');}
});
