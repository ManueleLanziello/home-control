"""Offline rain effects only. No source RGB is exported into the runtime asset.
Inputs: unchanged original SVG rasterization, never the aesthetic reference.
Rebuild: node scripts/weather-rain/render.cjs, then bundled Python build.py.
"""
from pathlib import Path
import base64, hashlib, json, io, os, xml.etree.ElementTree as ET
import numpy as np
from PIL import Image, ImageFilter, ImageDraw
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'design/weather-preview/pioggia'
OUT.mkdir(parents=True, exist_ok=True)
W,H = 4932,3091
SW,SH = 1596,1000
rng = np.random.default_rng(20260916)
base = Image.open(OUT/'base-giorno.png').convert('RGB')
assert base.size == (W,H)
src = np.asarray(base.resize((SW,SH),Image.Resampling.LANCZOS),dtype=np.float32)/255
Y,X = np.mgrid[0:SH,0:SW].astype(np.float32)
r,g,b = src[:,:,0],src[:,:,1],src[:,:,2]
# All selections refer to the ORIGINAL source raster in its exported coordinates.
# Conservative material supports: effects never introduce or move scene geometry.
# House clipping origin is read from the original SVG's g transform (1364,1712)
# and outer translation (-133,-909); reference coordinates are never consulted.
ns={'s':'http://www.w3.org/2000/svg'}
doc=ET.parse(ROOT/'design/LAYER-00-GIORNO.svg').getroot()
assert doc.attrib['width']==str(W) and doc.attrib['height']==str(H)
groups=doc.findall('s:g/s:g',ns)
assert groups[1].attrib['transform'].endswith('1364 1712)')
house_x=(1364-133)*SW/W
house_y=(1712-909)*SH/H
inside=(X>=house_x)&(X<1139)&(Y>=house_y)
# Source-visible outdoor supports, deliberately inset from object boundaries.
terrace=(X>30)&(X<435)&(Y>24)
terracotta=terrace*np.clip((r-g-.08)*8,0,1)*np.clip((g-b-.035)*12,0,1)
apron=(((X>345)&(X<399)&(Y>207))|((X>399)&(X<1196)&(Y>204)&(Y<257))|((X>1141)&(X<1196)&(Y>257))|((X>444)&(X<477)&(Y<200))|((X>763)&(X<793)&(Y<200)))
apron=apron*np.clip((r-b-.09)*9,0,1)
gazebo=(X>489)&(X<751)&(Y>31)&(Y<188)
# Feet excluded from wet horizontal slab; grey slab color determines actual mask.
gazebo=gazebo*np.clip(1-np.abs(r-g)*12,0,1)*np.clip((r-.22)*3,0,1)
green=np.clip((g-r-.012)*12,0,1)*np.clip((g-b-.035)*8,0,1)
external=~inside
vegetation=green*external
pond_region=((X-1384)/60)**2+((Y-254)/53)**2<1
pond=pond_region*np.clip((b-r-.025)*10,0,1)
# Surface masks are alpha data, not copies of the plan's appearance.
paving=np.maximum(terracotta,np.maximum(apron,gazebo)).astype(np.float32)

def noise(cols,rows):
    a=(rng.random((rows,cols))*255).astype(np.uint8)
    return np.asarray(Image.fromarray(a).resize((SW,SH),Image.Resampling.BICUBIC),dtype=np.float32)/255
broad=noise(19,13)
medium=noise(85,61)
fine=noise(360,270)
fractal=.55*broad+.3*medium+.15*fine
# A control variant: diffuse broad wetness, no normal-derived specular details.
# The final alternative below adds water-film normals + material-dependent highlights.
alpha0=(.065*external+.34*paving*(.65+.35*broad)+.21*vegetation).clip(0,.6)
control=np.zeros((SH,SW,4),dtype=np.float32)
control[:,:,:3]=[.055,.075,.095];control[:,:,3]=alpha0

def write_texture(array,name):
    im=Image.fromarray(np.uint8(np.clip(array,0,1)*255),'RGBA').resize((W,H),Image.Resampling.BICUBIC)
    im.save(OUT/name,optimize=True)
    return im
v1=write_texture(control,'control-diffuse-only.png')
Image.alpha_composite(base.convert('RGBA'),v1).save(OUT/'control-diffuse-day.png')
# Premultiplied compositing keeps only environmental contributions in output RGB.
color=np.zeros((SH,SW,3),dtype=np.float32)
alpha=np.zeros((SH,SW),dtype=np.float32)
def over(rgb,a):
    global color,alpha
    a=np.clip(a,0,.92).astype(np.float32)
    color=np.asarray(rgb,dtype=np.float32)*a[:,:,None]+color*(1-a[:,:,None])
    alpha=a+alpha*(1-a)
over([.045,.058,.071],.12*external)
over([.020,.035,.035],paving*(.35+.17*fractal))
over([.015,.046,.013],vegetation*(.29+.12*medium))
# Accumulation is tied to selected horizontal low-edge zones, not scattered globally.
wet=np.zeros((SH,SW),dtype=np.float32)
for cx,cy,rx,ry,strength in [(68,485,40,420,1),(274,236,110,240,.8),(293,784,92,196,.9),(351,378,75,115,.55),(609,119,126,90,.9),(1168,660,30,310,.75),(1320,613,59,342,.66),(1425,748,62,162,.5),(893,157,73,57,.55)]:
    wet+=strength*np.exp(-((X-cx)/rx)**2-((Y-cy)/ry)**2)
wet=np.clip(wet,0,1)
# Shore-like irregular puddle boundaries from multiple spatial scales.
water=np.clip((wet+.68*(fractal-.5)-.49)*4,0,1)
water*=np.maximum(paving,vegetation*.72)
over([.075,.115,.126],water*.36)
# Spatially varying water-film normal field, evaluated once offline.
normal_height=.6*noise(290,168)+.27*noise(740,530)+.13*noise(1120,790)
ny,nx=np.gradient(normal_height)
normal=np.clip((nx*.9+ny*.45+.06)*8,0,1)
# Nonperiodic elongated glints; avoid added streaks or a repeated tile pattern.
glint=np.clip((normal-.40)*3.2,0,1)*np.clip((fine-.43)*2.4,0,1)
cloud=.45+.55*noise(28,19)
spec=(.065+.27*water)*glint*cloud*paving
spec+=.16*water*cloud
spec+=.06*paving*np.clip((medium-.57)*3.2,0,1)
spec+=.022*vegetation*glint*wet
spec*=~inside
# Luminance ceiling keeps the same absolute highlights usable at night.
over([.46,.53,.55],spec)
# Small, bounded source-water highlights, never on the pond rim or vegetation.
over([.08,.18,.21],pond*(.12+.07*medium))
over([.36,.49,.50],pond*glint*.058)
rgba=np.concatenate([np.divide(color,alpha[:,:,None],out=np.zeros_like(color),where=alpha[:,:,None]>0),alpha[:,:,None]],axis=2)
effects=write_texture(rgba,'rain-effects-hd.png')
# Static ripple arcs at HD: positions admitted only by ORIGINAL source water mask.
ripple=Image.new('RGBA',(W,H))
draw=ImageDraw.Draw(ripple)
for _ in range(48):
    cx=float(rng.uniform(1333,1435));cy=float(rng.uniform(206,298))
    if pond[int(cy),int(cx)]<.42: continue
    x,y=cx*W/SW,cy*H/SH
    radius=float(rng.uniform(3,14))*W/SW
    oval=(x-radius,y-radius*.55,x+radius,y+radius*.55)
    start=float(rng.uniform(0,260));end=start+float(rng.uniform(80,190))
    draw.arc(oval,start,end,fill=(141,171,172,int(rng.uniform(24,59))),width=2)
# Per-pixel water mask also clips entire ripple extent (not just ripple centers).
pond_hd=Image.fromarray(np.uint8(pond*255)).resize((W,H),Image.Resampling.BICUBIC)
ripple.putalpha(Image.fromarray(np.uint8(np.asarray(ripple.getchannel('A'),dtype=np.float32)*np.asarray(pond_hd,dtype=np.float32)/255)))
effects=Image.alpha_composite(effects,ripple)
effects.save(OUT/'rain-effects-hd.png',optimize=True)
payload=base64.b64encode((OUT/'rain-effects-hd.png').read_bytes()).decode()
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="4932" height="3091" viewBox="0 0 4932 3091" preserveAspectRatio="xMidYMid meet" pointer-events="none">
<!-- Static rain candidate; quality assessment is documented in weather-preview/pioggia/REPORT.md.
Environmental alpha texture ONLY. No source plan or aesthetic reference is embedded.
Offline deterministic seed 20260916. Root origin matches the exported base viewport. -->
<image x="0" y="0" width="4932" height="3091" preserveAspectRatio="none" pointer-events="none" href="data:image/png;base64,{payload}"/>
</svg>\n'''
(ROOT/'design/LAYER-METEO-PIOGGIA.svg').write_text(svg,encoding='utf8')
for period in ['giorno','notte']:
    original=Image.open(OUT/f'base-{period}.png').convert('RGBA')
    Image.alpha_composite(original,effects).save(OUT/f'composite-{period}.png',optimize=True)
    Image.alpha_composite(original,effects).resize((1596,1000),Image.Resampling.LANCZOS).save(OUT/f'composite-{period}-review.png')
# Preview is intentionally outside runtime paths used by the Dashboard.
print(json.dumps({'svg_bytes':len(svg),'texture_bytes':(OUT/'rain-effects-hd.png').stat().st_size,'dimensions':[W,H],'source_sha256':hashlib.sha256((ROOT/'design/LAYER-00-GIORNO.svg').read_bytes()).hexdigest()}))



for temporary in ['base-giorno.png','base-notte.png','composite-giorno.png','composite-notte.png','control-diffuse-only.png','control-diffuse-day.png','rain-effects-hd.png']:
    (OUT/temporary).unlink(missing_ok=True)

