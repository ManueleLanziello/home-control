// Local-only visual verification: all runtime/providers are injected fixtures.
const assert=require('node:assert/strict');
const {once}=require('node:events');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {chromium}=require('C:/Users/manue/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..');
async function verify(){
  const {createHomeControlServer}=await import(pathToFileURL(path.join(root,'server.js')));
  const unavailable=async()=>{throw new Error('Hardware access prohibited in rain preview')};
  const fixture={available:true,stale:false,location:'Anteprima offline',current:{weatherCode:61,overlayCondition:'rain',condition:'Pioggia',icon:'rain.svg',temperature:20,humidity:75,windSpeed:10},today:{rainProbability:65},hourly:[],daily:[]};
  const server=createHomeControlServer({hardwareStore:{read:async()=>({version:4,devices:[]})},roleStore:{read:async()=>({})},thermostatRuntime:{readSnapshot:async()=>({online:false,thermostat:{},schedule:null,updatedAt:null}),setMode:unavailable,setSetpointTemperature:unavailable,updateSchedule:unavailable},weatherService:{getSnapshot:async()=>fixture}});
  let browser;
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page=await browser.newPage({viewport:{width:1600,height:1000},timezoneId:'Europe/Rome'});
    await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
    const requests=[];page.on('request',r=>requests.push(r.url()));
    await page.addInitScript(()=>{window.weatherRafCalls=0;const original=requestAnimationFrame;window.requestAnimationFrame=callback=>{if(/weather-(?:canvas|static)-renderer/.test(new Error().stack))window.weatherRafCalls++;return original(callback)}});
    await page.clock.setFixedTime(new Date('2026-09-16T10:00:00Z'));
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'OFF',exact:true}).click();
    const before=await page.locator('[data-layered-floorplan]').boundingBox();
    const records={};
    for(const [period,time] of [['day','2026-09-16T10:00:00Z'],['night','2026-09-16T22:00:00Z']]){
      await page.clock.setFixedTime(new Date(time));await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.getByRole('button',{name:'PIOGGIA',exact:true}).click();
      await page.waitForFunction(()=>{const e=document.querySelector('[data-weather-state="pioggia"]');return e?.complete&&e.naturalWidth===4932});
      const state=await page.locator('.floorplan-static-weather').evaluate(e=>({src:e.getAttribute('src'),natural:[e.naturalWidth,e.naturalHeight],pointer:getComputedStyle(e).pointerEvents,period:e.parentElement.dataset.period,count:e.parentElement.querySelectorAll('.floorplan-static-weather').length,canvas:e.parentElement.querySelectorAll('canvas').length,weatherRafCalls:window.weatherRafCalls,animation:getComputedStyle(e).animationName}));
      const bounds=await page.locator('.floorplan-static-weather').boundingBox();
      assert.deepEqual(bounds,before);assert.equal(state.period,period);assert.equal(state.pointer,'none');assert.equal(state.count,1);assert.equal(state.canvas,0);assert.equal(state.weatherRafCalls,0);assert.equal(state.animation,'none');
      records[period]={...state,bounds,alignmentDeltaPx:0};
      if(period==='day'){await page.screenshot({path:path.join(root,'design/weather-preview/pioggia/dashboard-pioggia.png'),fullPage:true});fs.copyFileSync(path.join(root,'design/weather-preview/pioggia/dashboard-pioggia.png'),path.join(root,'design/weather-preview/pioggia/dashboard-pioggia-v3.png'));}
      await page.getByRole('button',{name:'OFF',exact:true}).click();
      assert.equal(await page.locator('.floorplan-static-weather').count(),0);
      assert.deepEqual(await page.locator('[data-layered-floorplan]').boundingBox(),before);
    }
    assert.equal(requests.some(u=>u.includes('LAYER-15-MAPPATURA')),false);
    assert.equal(requests.filter(u=>u.includes('LAYER-14-OVERLAY')).length,0);
    const result={...records,offLayerCount:0,offBoundingBoxDeltaPx:0,materialMaskRuntimeRequests:0};
    fs.writeFileSync(path.join(root,'design/weather-preview/pioggia/browser-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  } finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
verify().catch(e=>{console.error(e);process.exitCode=1});
