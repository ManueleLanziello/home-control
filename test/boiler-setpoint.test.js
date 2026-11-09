import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBoilerSetpointEditor, bindBoilerSetpointSlider } from '../public/js/thermostat.js';

function setup() {
  let time=0, next=0; const pending=new Map();
  const editor=createBoilerSetpointEditor({setTimeoutFn:(fn,ms)=>{const id=++next;pending.set(id,{fn,at:time+ms});return id;},clearTimeoutFn:id=>pending.delete(id)});
  const observe=(value,mode='manual',ms=0)=>editor.observe({updatedAt:new Date(100000+ms).toISOString(),setpointUpdatedAt:new Date(100000+ms).toISOString(),thermostat:{mode,setpointTemperature:value}});
  const advance=ms=>{time+=ms;for(const [id,t] of [...pending])if(t.at<=time){pending.delete(id);t.fn();}};
  observe(20); return {editor,observe,advance,pending};
}

class Slider extends EventTarget {
  constructor(){super();this.min='5';this.max='30';this.value='20';this.captured=null;}
  getBoundingClientRect(){return {left:0,width:324};}
  setPointerCapture(id){this.captured=id;}
  hasPointerCapture(id){return this.captured===id;}
  releasePointerCapture(){this.captured=null;}
  dispatch(type,props={}){const e=new Event(type,{cancelable:true});Object.assign(e,props);this.dispatchEvent(e);return e;}
}

test('apertura manuale/auto e primo tocco senza salto',()=>{
  const {editor}=setup(), slider=new Slider(); let mode='auto'; bindBoilerSetpointSlider(slider,editor,()=>mode);
  slider.dispatch('pointerdown',{button:0,pointerId:1,clientX:300}); assert.equal(editor.state().phase,'view');
  mode='manual'; const event=slider.dispatch('pointerdown',{button:0,pointerId:1,clientX:300});
  assert.equal(event.defaultPrevented,true); assert.equal(editor.state().phase,'editing'); assert.equal(editor.state().draft,20);
});

test('mouse e touch usano posizione assoluta, mezzo grado e rilascio esterno',()=>{
  for(const pointerType of ['mouse','touch']) {const {editor}=setup(),slider=new Slider(); bindBoilerSetpointSlider(slider,editor,()=> 'manual');
    slider.dispatch('pointerdown',{button:0,pointerId:4,pointerType,clientX:212}); slider.dispatch('pointermove',{pointerId:4,clientX:210});
    assert.equal(editor.state().draft,21.5); slider.dispatch('pointerup',{pointerId:4,clientX:600});
    assert.equal(editor.state().dragging,false); assert.equal(editor.state().draft,21.5);
  }
});

test('salvataggio attende conferma coerente, ignora risposte vecchie e blocca doppi invii',()=>{
  const {editor}=setup(); editor.begin('manual'); editor.setDraft(21.5); const request=editor.beginSave();
  assert.deepEqual(request,{id:1,value:21.5}); assert.equal(editor.beginSave(),null);
  assert.equal(editor.saved(0,{thermostat:{setpointTemperature:21.5}}),false); assert.equal(editor.saved(1,{thermostat:{setpointTemperature:20}}),false);
  assert.equal(editor.state().phase,'saving'); assert.equal(editor.saved(1,{updatedAt:new Date(110000).toISOString(),thermostat:{setpointTemperature:21.5}}),true);
  assert.equal(editor.state().phase,'view'); assert.equal(editor.state().confirmed,21.5);
});

test('errore resta modificabile e annulla ripristina confermato',()=>{
  const {editor}=setup(); editor.begin('manual'); editor.setDraft(23); const {id}=editor.beginSave();
  editor.failed(id,'Conferma non riuscita'); assert.equal(editor.state().phase,'editing'); assert.equal(editor.state().confirmed,20); assert.equal(editor.state().draft,23);
  assert.equal(editor.state().error,'Conferma non riuscita'); editor.cancel(); assert.equal(editor.state().phase,'view'); assert.equal(editor.state().confirmed,20);
});

test('timeout e reset attivita, sospensione in drag e saving',()=>{
  const f=setup();f.editor.begin('manual');f.advance(29000);f.editor.setDraft(21);f.advance(29000);assert.equal(f.editor.state().phase,'editing');
  f.editor.startDrag();f.advance(90000);assert.equal(f.editor.state().phase,'editing');f.editor.endDrag();f.advance(30000);assert.equal(f.editor.state().phase,'view');
  f.editor.begin('manual');f.editor.setDraft(21);f.editor.beginSave();f.advance(90000);assert.equal(f.editor.state().phase,'saving');
});

test('aggiornamento esterno segnala conflitto senza spostare bozza, auto annulla',()=>{
  const f=setup();f.editor.begin('manual');f.editor.setDraft(22);f.observe(19,'manual',1);assert.equal(f.editor.state().draft,22);assert.equal(f.editor.state().confirmed,19);assert.equal(f.editor.state().conflict,true);assert.equal(f.editor.beginSave(),null);
  f.editor.cancel();assert.equal(f.editor.state().confirmed,19);f.editor.begin('manual');f.observe(19,'auto',2);assert.equal(f.editor.state().phase,'view');
});

test('risposta precedente non sostituisce il valore fisico piu recente',()=>{
  const f=setup();f.editor.begin('manual');f.editor.setDraft(21);const req=f.editor.beginSave();f.observe(22,'manual',100);
  f.editor.saved(req.id,{updatedAt:new Date(100050).toISOString(),thermostat:{setpointTemperature:21}});assert.equal(f.editor.state().confirmed,22);
});

test('chiusura elimina il timer e riapertura parte dal valore confermato',()=>{
  const f=setup();f.editor.begin('manual');f.editor.setDraft(22);f.editor.close();assert.equal(f.pending.size,0);assert.equal(f.editor.state().phase,'view');f.editor.begin('manual');assert.equal(f.editor.state().draft,20);
});

test('popup riserva i pulsanti e lo slider rimane visibile anche in auto',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');const dashboard=await readFile(new URL('../public/js/dashboard.js',import.meta.url),'utf8');const css=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
  assert.match(html,/REGOLA TEMPERATURA/);assert.match(html,/min="5" max="30" step="0.5" data-boiler-setpoint-control/);assert.match(html,/data-boiler-setpoint-save/);assert.match(html,/data-boiler-setpoint-cancel/);
  assert.doesNotMatch(dashboard,/setpointControl\.hidden/);assert.match(css,/prefers-reduced-motion/);assert.match(dashboard,/AbortSignal\.timeout\(30_000\)/);
});


test('timeout con esito incerto blocca duplicati e consente annullamento',()=>{
  const f=setup(); f.editor.begin('manual'); f.editor.setDraft(22); const req=f.editor.beginSave();
  f.editor.failed(req.id,'Esito incerto',null,{uncertain:true}); assert.equal(f.editor.state().phase,'editing'); assert.equal(f.editor.beginSave(),null);
  f.editor.cancel(); assert.equal(f.editor.state().phase,'view'); assert.equal(f.editor.state().confirmed,20);
});


test('un valore fisico fuori dai limiti regolabili non viene inventato o inviato',()=>{
  const f=setup(); f.observe(31.5,'manual',5); assert.equal(f.editor.begin('manual'),false); assert.equal(f.editor.state().confirmed,31.5);
});
