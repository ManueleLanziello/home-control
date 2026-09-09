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
function fixture(overrides={}) {
  const devices=['S1','S2','S4','S5'].map(device);
  return { hardwareStore:{async read(){return {devices};}}, roleStore:{async read(){return Object.fromEntries(devices.map(d=>[d.id,HOME_ROLES[d.id]]));}}, readThermostat:async()=>wt(), now:()=>time,
    createSensorRuntime:d=>({async readSnapshot(){return {online:true,updatedAt:stamp,measurements:{ambientTemperature:{value:({S1:20,S2:24,S4:26,S5:40})[d.id]}}};}}), ...overrides };
}
test('Core Dewin normalization, explicit roles, S3 WT200 and indoor-only average', async()=>{
  const runtime=new HomeStatusRuntime(fixture({createSensorRuntime:d=>new HomeDewinRuntime({device:d,now:()=>stamp,client:{async readDevice(){return {device:{id:d.identity.tuyaDeviceId,online:true},statuses:[{code:'temp_current',value:200}],specification:{status:[{code:'temp_current',type:'Integer',values:'{"scale":1,"unit":"℃"}'}]}};}}})}));
  const home=await runtime.readSnapshot();
  assert.equal(home.sensors.S1.value,20);
  assert.equal(home.sensors.S3.value,22);
  assert.equal(home.sensors.S3.source,'thermostat');
  assert.equal(home.averageTemperature,20.5);
  assert.equal(home.indoorSensorCount,4);
  assert.equal(home.thermostat.heatingActive,true);
  assert.equal(home.lights.L7.source,'simulation');
  assert.equal(home.cameras.C1.reason,'not_configured');
});
test('offline, stale, rejected, nonnumeric readings excluded; WT200 survives sensor failures',async()=>{
 const runtime=new HomeStatusRuntime(fixture({createSensorRuntime:d=>({async readSnapshot(){
  if(d.id==='S1')throw Error('Offline');
  return {online:d.id!=='S2',updatedAt:d.id==='S4'?new Date(time-100000).toISOString():stamp,measurements:{ambientTemperature:{value:d.id==='S5'?'40':20}}};
 }})}));
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
 assert.equal((await runtime.readSnapshot()).sensors.S1.value,null);assert.equal(reads,2);
});
test('cache cannot extend an already old sensor past freshness limit',async()=>{
 let now=time;
 const runtime=new HomeStatusRuntime(fixture({now:()=>now,createSensorRuntime:()=>({async readSnapshot(){return {online:true,updatedAt:new Date(time-85000).toISOString(),measurements:{ambientTemperature:{value:20}}};}})}));
 assert.equal((await runtime.readSnapshot()).sensors.S1.value,20);
 now+=6000;assert.equal((await runtime.readSnapshot()).sensors.S1.value,null);
});
test('hanging adapter isolated and never duplicated after timeout',async()=>{
 let reads=0;
 const runtime=new HomeStatusRuntime(fixture({cacheMs:0,timeoutMs:5,createSensorRuntime:d=>({readSnapshot(){if(d.id==='S1'){reads++;return new Promise(()=>{});}return Promise.resolve({online:false});}})}));
 const h=await runtime.readSnapshot();assert.equal(h.sensors.S3.value,22);
 await runtime.readSnapshot();assert.equal(reads,1);
});
test('configured unsupported lights/cameras stay unavailable, never become simulators',async()=>{
 const options=fixture();options.hardwareStore.read=async()=>({devices:[device('lamp'),device('camera')]});
 options.roleStore.read=async()=>({lamp:HOME_ROLES.L1,camera:HOME_ROLES.C1});
 const h=await new HomeStatusRuntime(options).readSnapshot();
 assert.equal(h.lights.L1.reason,'unsupported_adapter');assert.equal(h.lights.L1.source,'hardware');
 assert.equal(h.cameras.C1.alias,'camera');assert.equal(h.cameras.C1.available,false);
});
test('WT200 cloud failure clears measurements while LAN heating remains independent',async()=>{
 let fail=false;
 const runtime=new HomeWt200Runtime({cloudAdapter:{async read(){if(fail)throw Error('Cloud');return wt();}},lanAdapter:{async read(){return {updatedAt:stamp,heatingActive:false};}}});
 assert.equal(normalizeThermostat(await runtime.readSnapshot(),time).thermostat.currentTemperature,22);
 fail=true;const h=normalizeThermostat(await runtime.readSnapshot(),time);
 assert.equal(h.thermostat.currentTemperature,null);assert.equal(h.thermostat.mode,null);assert.equal(h.heatingActive,false);
 assert.equal(normalizeThermostat(wt(),time+100000).thermostat.currentTemperature,null);
});
test('UI store synchronizes sensors, boiler, all seven simulated lights, and failure fallback',async()=>{
 const h=await new HomeStatusRuntime(fixture()).readSnapshot();const store=createFloorplanState();store.applyHomeSnapshot(h);
 for(let i=1;i<=7;i++){const id='L'+i;store.setLight(id,true);assert.equal(store.snapshot().lights[id],true);store.applyHomeSnapshot(h);assert.equal(store.snapshot().lights[id],true);store.setLight(id,false);assert.equal(store.snapshot().lights[id],false);}
 assert.equal(store.snapshot().sensors.S3,22);assert.equal(store.snapshot().boiler.on,true);assert.equal(store.snapshot().boiler.mode,'manual');
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
 }finally{server.close();await once(server,'close');}
});
