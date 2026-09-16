const fs=require('fs');const path=require('path');
const {execFileSync}=require('child_process');
const root=path.resolve(__dirname,'../..');
const runtime='C:/Users/manue/.cache/codex-runtimes/codex-primary-runtime/dependencies';
const sharp=require(path.join(runtime,'node/node_modules/sharp'));
const out=path.join(root,'design/weather-preview/pioggia');fs.mkdirSync(out,{recursive:true});
async function render(){
  execFileSync(path.join(runtime,'python/python.exe'),[path.join(__dirname,'material_masks.py')],{stdio:'inherit'});
  await Promise.all(['GIORNO','NOTTE'].map(n=>sharp(path.join(root,'design/LAYER-00-'+n+'.svg')).png().toFile(path.join(out,'base-'+n.toLowerCase()+'.png'))));
  await sharp(path.join(out,'material-mask-normalized.svg')).png().toFile(path.join(out,'material-mask-hd.png'));
  const mask=await sharp(path.join(out,'material-mask-hd.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(let i=3;i<mask.data.length;i+=4) mask.data[i]=Math.round(mask.data[i]*.36);
  const review=await sharp(path.join(out,'base-giorno.png')).composite([{input:mask.data,raw:mask.info}]).png().toBuffer();
  await sharp(review).resize(1596,1000).png().toFile(path.join(out,'material-mask-review.png'));
  console.log('Normalized materials rendered; review alignment before build.py');
}
render().catch(e=>{console.error(e);process.exitCode=1});
