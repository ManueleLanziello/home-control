"""Rain V2, material-aware offline effects. Reuses V1 noise/compositing/ripple pipeline.
Rebuild: node scripts/weather-rain/render.cjs && bundled Python build.py.
The plan is used for luminance-derived micro-normals only, never material inference.
"""
from pathlib import Path
import argparse, base64, hashlib, json
import numpy as np
from PIL import Image, ImageFilter, ImageDraw
from material_masks import PALETTE, hashes
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'design/weather-preview/pioggia'
W,H=4932,3091
SW,SH=2466,1546
args=argparse.ArgumentParser()
args.add_argument('--variant',type=int,choices=[1,2],default=2)
variant=args.parse_args().variant
baseline=json.loads((OUT/'source-hashes.json').read_text())
if hashes()!=baseline: raise ValueError('Authoritative source changed since initial baseline')
rng=np.random.default_rng(20260916)
base=Image.open(OUT/'base-giorno.png').convert('RGB')
assert base.size==(W,H)
semantic=Image.open(OUT/'material-mask-hd.png').convert('RGBA')
assert semantic.size==(W,H)
pixels=np.asarray(semantic)
ids=np.zeros((H,W),dtype=np.uint8)
classes={}
for index,(hex_color,name) in enumerate(PALETTE.items(),1):
    rgb=np.array([int(hex_color[k:k+2],16) for k in (1,3,5)],dtype=np.uint8)
    admitted=np.all(pixels[:,:,:3]==rgb,axis=2)&(pixels[:,:,3]==255)
    ids[admitted]=index
    classes[name]=index
# Antialias/undefined pixels are conservatively excluded, not guessed from plan RGB.
masks={name:np.asarray(Image.fromarray(np.uint8(ids==index)*255).resize((SW,SH),Image.Resampling.BOX),dtype=np.float32)/255 for name,index in classes.items()}
cotto,wood,beige,grass,pond=[masks[n] for n in ['cotto','legno','beige','giardino','pond']]
support=np.maximum.reduce([cotto,wood,beige,grass,pond])
Y,X=np.mgrid[0:SH,0:SW].astype(np.float32)

def noise(cols,rows):
    a=np.uint8(rng.random((rows,cols))*255)
    return np.asarray(Image.fromarray(a).resize((SW,SH),Image.Resampling.BICUBIC),dtype=np.float32)/255
broad=noise(21,17)
medium=noise(104,78)
fine=noise(500,340)
fractal=.60*broad+.28*medium+.12*fine
# Micro-normal approximation follows ORIGINAL grout/grain details; no RGB is exported.
lum_im=base.convert('L').resize((SW,SH),Image.Resampling.LANCZOS)
lum=np.asarray(lum_im,dtype=np.float32)/255
smooth=np.asarray(lum_im.filter(ImageFilter.GaussianBlur(3.5)),dtype=np.float32)/255
micro=np.clip(lum-smooth,-.12,.12)
material_y,material_x=np.gradient(micro)
normal_height=.58*noise(190,170)+.30*noise(500,310)+.12*fine
ny,nx=np.gradient(normal_height)
# Broad water-film contours are separate from high-frequency material micro-normal.
film_height=.7*noise(132,196)+.3*noise(310,350)
fy,fx=np.gradient(film_height)
reflection=np.clip((.043-np.abs(fx*.8+fy*.35-.009))*21,0,1)
reflection=reflection**2
material_gloss=np.clip(.40+material_x*16+material_y*5,0,1)
# Accumulation supports are procedural zones INSIDE the authoritative hard-surface mask.
# Their placement is an artistic hypothesis, not a claim about surveyed slopes.
yc,xc=np.where(cotto>.9)
left,right=float(xc.min()),float(xc.max())
top,bottom=float(yc.min()),float(yc.max())
width,height=right-left,bottom-top
warped_x=X+(noise(16,21)-.5)*width*.10
warped_y=Y+(noise(23,17)-.5)*height*.045
field=np.zeros((SH,SW),dtype=np.float32)
for u,v,rx,ry,strength in [(.53,.21,.10,.12,.96),(.18,.65,.09,.16,1.0),(.53,.77,.13,.09,1.0),(.69,.43,.08,.11,.91),(.25,.92,.12,.05,.88)]:
    blob=strength*np.exp(-((warped_x-(left+u*width))/(rx*width))**2-((warped_y-(top+v*height))/(ry*height))**2)
    field=np.maximum(field,blob)
water=np.clip((field+.44*(broad-.5)+.17*(medium-.5)-.57)*7,0,1)*cotto
water=np.asarray(Image.fromarray(np.uint8(water*255)).filter(ImageFilter.GaussianBlur(5)),dtype=np.float32)/255*cotto
if variant==2:
    reflection=np.asarray(Image.fromarray(np.uint8(reflection*255)).filter(ImageFilter.GaussianBlur(3)),dtype=np.float32)/255
# Beige has weaker, smaller accumulations and wood/grass have none.
beige_water=np.clip((broad+.24*(medium-.5)-.78)*5,0,1)*beige
color=np.zeros((SH,SW,3),dtype=np.float32)
alpha=np.zeros((SH,SW),dtype=np.float32)
def over(rgb,a):
    global color,alpha
    a=np.clip(a,0,.8).astype(np.float32)
    color=np.asarray(rgb,dtype=np.float32)*a[:,:,None]+color*(1-a[:,:,None])
    alpha=a+alpha*(1-a)
# Atmosphere is a separate pass; excluded/undefined surfaces remain untouched.
over([.045,.061,.079],support*.055)
# Material-specific absorption preserves the brown/beige/wood/green identity.
over([.11,.033,.012],cotto*(.26+.105*fractal+.09*water))
over([.09,.043,.022],wood*(.18+.065*medium))
over([.125,.111,.087],beige*(.13+.055*broad))
over([.018,.059,.010],grass*(.25+.085*broad))
over([.045,.125,.15],pond*(.06+.025*medium))
cloud=.55+.45*noise(34,24)
# Water-film reflection, broad and coherent; no white-noise coat over the scene.
reflection_strength=(.048+.105*field)*reflection*material_gloss*cotto
if variant==2:
    # Alternative: continuous soft sky reflection in puddles, with fewer sharp glints.
    # This corrects the speckled look of the first V2 and raises water readability.
    reflection_strength=(.04+.15*water)*reflection*cloud*cotto
    over([.29,.34,.36],water*(.095+.055*cloud))
    over([.42,.49,.53],water*cloud*.055)
else:
    over([.22,.29,.32],water*.14)
over([.47,.51,.53],reflection_strength)
# Thin soft highlight rims follow irregular field contours instead of geometric ellipses.
wy,wx=np.gradient(water)
rim=np.clip(np.hypot(wx,wy)*1.5,0,.15)*cotto
if variant==2: rim*=0
over([.49,.53,.55],rim)
over([.38,.41,.42],beige*(.025+.046*reflection*cloud)+beige_water*.055)
# Wood response follows grain normals, without paving water field or broad puddles.
over([.40,.36,.30],wood*.043*material_gloss)
# Sparse humid sparkle, never a continuous specular grass sheet.
leaf_gloss=np.clip((micro-.05)*3,0,.08)*grass
leaf_gloss*=np.clip((fine-.58)*2,0,1)
over([.35,.42,.29],leaf_gloss)
over([.29,.43,.45],pond*reflection*.025)
rgba=np.concatenate([np.divide(color,alpha[:,:,None],out=np.zeros_like(color),where=alpha[:,:,None]>0),alpha[:,:,None]],axis=2)
effects=Image.fromarray(np.uint8(np.clip(rgba,0,1)*255),'RGBA').resize((W,H),Image.Resampling.BICUBIC)
# Exact HD semantic clipping after resampling: black and unclassified pixels get alpha 0.
allowed=(ids>0)&(ids!=classes['excluded'])
a=np.asarray(effects.getchannel('A')).copy()
a[~allowed]=0
effects.putalpha(Image.fromarray(a))
ripple=Image.new('RGBA',(W,H))
draw=ImageDraw.Draw(ripple)
py,px=np.where(ids==classes['pond'])
for _ in range(48):
    cx=int(rng.integers(px.min(),px.max()+1));cy=int(rng.integers(py.min(),py.max()+1))
    if ids[cy,cx]!=classes['pond']: continue
    radius=float(rng.uniform(8,37))
    oval=(cx-radius,cy-radius*.55,cx+radius,cy+radius*.55)
    start=float(rng.uniform(0,260));end=start+float(rng.uniform(80,190))
    draw.arc(oval,start,end,fill=(141,171,172,int(rng.uniform(23,48))),width=2)
ripple_a=np.asarray(ripple.getchannel('A')).copy()
ripple_a[ids!=classes['pond']]=0
ripple.putalpha(Image.fromarray(ripple_a))
effects=Image.alpha_composite(effects,ripple)
assert np.count_nonzero(np.asarray(effects.getchannel('A'))[~allowed])==0
texture=OUT/'rain-effects-hd.png'
effects.save(texture,optimize=True)
payload=base64.b64encode(texture.read_bytes()).decode()
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="4932" height="3091" viewBox="0 0 4932 3091" preserveAspectRatio="xMidYMid meet" pointer-events="none">
<!-- Rain V2 candidate: quality assessment in weather-preview/pioggia/REPORT.md.
Offline material masks from LAYER-15; environmental alpha texture ONLY.
No plan, aesthetic reference, or visible material map is embedded. Seed 20260916. -->
<image x="0" y="0" width="4932" height="3091" preserveAspectRatio="none" pointer-events="none" href="data:image/png;base64,{payload}"/>
</svg>\n'''
(ROOT/'design/LAYER-METEO-PIOGGIA.svg').write_text(svg,encoding='utf8')
for period in ['giorno','notte']:
    original=Image.open(OUT/f'base-{period}.png').convert('RGBA')
    composite=Image.alpha_composite(original,effects)
    composite.resize((1596,1000),Image.Resampling.LANCZOS).save(OUT/f'composite-{period}-review.png')
metadata={'version':2,'variant':variant,'seed':20260916,'viewport':[W,H],'shading_resolution':[SW,SH],'texture_bytes':texture.stat().st_size,'svg_bytes':(ROOT/'design/LAYER-METEO-PIOGGIA.svg').stat().st_size,'excluded_effect_pixels':0,'material_pixels':{n:int(np.count_nonzero(ids==idx)) for n,idx in classes.items()},'cotto_puddle_fraction':float(np.count_nonzero(water>.15)/np.count_nonzero(cotto>.9)),'source_hashes':hashes()}
(OUT/'generation.json').write_text(json.dumps(metadata,indent=2),encoding='utf8')
print(json.dumps(metadata))
