"""Rain V3, material-aware offline effects. Reuses V1 noise/compositing/ripple pipeline.
Rebuild: node scripts/weather-rain/render.cjs && bundled Python build.py.
The plan is used for luminance-derived micro-normals only, never material inference.
"""
from pathlib import Path
import argparse, base64, hashlib, json
import numpy as np
from PIL import Image, ImageFilter, ImageDraw
from material_masks import PALETTE, hashes, normalize
from procedural_water import generate_water
from soft_light import composite_soft_light
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
    admitted=np.all(pixels[:,:,:3]==rgb,axis=2)&(pixels[:,:,3]>=128)
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
# Original-detail gloss for wood/beige/pond is retained from V2.
film_height=.7*noise(132,196)+.3*noise(310,350)
fy,fx=np.gradient(film_height)
reflection=np.clip((.043-np.abs(fx*.8+fy*.35-.009))*21,0,1)**2
material_gloss=np.clip(.40+material_x*16+material_y*5,0,1)
CW,CH=822,516
coarse_ids=np.asarray(Image.fromarray(ids).resize((CW,CH),Image.Resampling.NEAREST))
cot_fields,cot_clusters=generate_water(coarse_ids==classes['cotto'],20260916,'cotto')
grass_fields,grass_clusters=generate_water(coarse_ids==classes['giardino'],20260917,'giardino')
def enlarge(field,mask):
    return np.asarray(Image.fromarray(np.float32(field)).resize((SW,SH),Image.Resampling.BICUBIC),dtype=np.float32).clip(0,1)*mask
water=enlarge(cot_fields['water'],cotto)
cot_reflection=enlarge(cot_fields['reflection'],cotto)
cot_film=enlarge(cot_fields['film'],cotto)
grass_water=enlarge(grass_fields['water'],grass)
grass_reflection=enlarge(grass_fields['reflection'],grass)
np.savez_compressed(OUT/'fields-v3.npz',coarse_ids=coarse_ids,cotto_water=cot_fields['water'],cotto_reflection=cot_fields['reflection'],cotto_film=cot_fields['film'],giardino_water=grass_fields['water'],giardino_reflection=grass_fields['reflection'])
for name,field in [('field-ristagni-cotto-v3',cot_fields['water']),('field-riflessi-cotto-v3',cot_fields['reflection']),('field-ristagni-prato-v3',grass_fields['water'])]:
    Image.fromarray(np.uint8(field*255)).resize((1596,1000),Image.Resampling.BICUBIC).save(OUT/(name+'.png'))
night=Image.open(OUT/'base-notte.png').convert('L').resize((SW,SH),Image.Resampling.LANCZOS)
night_lum=np.asarray(night,dtype=np.float32)/255
color=np.zeros((SH,SW,3),dtype=np.float32)
alpha=np.zeros((SH,SW),dtype=np.float32)
def over(rgb,a):
    global color,alpha
    a=np.clip(a,0,.8).astype(np.float32)
    color=np.asarray(rgb,dtype=np.float32)*a[:,:,None]+color*(1-a[:,:,None])
    alpha=a+alpha*(1-a)
# Atmosphere is a separate pass; excluded/undefined surfaces remain untouched.
# Separate atmosphere pass: exterior from Layer 15, largest black shape protects house.
_,semantic_meta=normalize()
black_rects=[entry['geometry'] for entry in semantic_meta['shapes'] if entry['material']=='excluded']
house=max(black_rects,key=lambda r:float(r['width'])*float(r['height']))
shift=semantic_meta['author_coordinate_translation']
hx=(float(house['x'])+shift[0])*SW/W;hy=(float(house['y'])+shift[1])*SH/H
hw=float(house['width'])*SW/W;hh=float(house['height'])*SH/H
exterior=~((X>=hx)&(X<hx+hw)&(Y>=hy)&(Y<hy+hh))
local_light=np.asarray(lum_im.filter(ImageFilter.GaussianBlur(24)),dtype=np.float32)/255
shadow=np.clip((local_light-lum)*1.8,0,.35)
sunlit=np.clip((lum-local_light)*1.6+.45,0,1)
cloud_atmo=noise(17,13)
dimming=(.075+.11*sunlit+.055*cloud_atmo)*exterior
shadow_fill=shadow*.12*exterior
lighting_alpha=shadow_fill+dimming*(1-shadow_fill)
lighting_color=(np.array([.26,.32,.40])*dimming[:,:,None]*(1-shadow_fill[:,:,None])+np.array([.62,.68,.73])*shadow_fill[:,:,None])
lighting_color=np.divide(lighting_color,lighting_alpha[:,:,None],out=np.zeros_like(lighting_color),where=lighting_alpha[:,:,None]>0)
lighting=Image.fromarray(np.uint8(np.clip(np.concatenate([lighting_color,lighting_alpha[:,:,None]],axis=2),0,1)*255),'RGBA')
# Re-clip the atmosphere on the exact HD house rectangle after resizing.
lighting_hd=lighting.resize((W,H),Image.Resampling.BICUBIC)
ly,lx=np.mgrid[0:H,0:W]
house_hd=(lx>=float(house['x'])+shift[0])&(lx<float(house['x'])+shift[0]+float(house['width']))&(ly>=float(house['y'])+shift[1])&(ly<float(house['y'])+shift[1]+float(house['height']))
la=np.asarray(lighting_hd.getchannel('A')).copy();la[house_hd]=0
lighting_hd.putalpha(Image.fromarray(la))
# Material-specific absorption preserves the brown/beige/wood/green identity.
over([.15,.08,.045],cotto*(.30+.105*fractal+.09*water))
over([.09,.043,.022],wood*(.18+.065*medium))
over([.125,.111,.087],beige*(.13+.055*broad))
over([.15,.25,.10],grass*(.27+.08*broad+.05*grass_water))
over([.045,.125,.15],pond*(.06+.025*medium))
cloud=.55+.45*noise(34,24)
# Cotton hierarchy: thin film, dark wet meniscus, then internal directional reflection.
over([.07,.05,.025],cot_film*.055+water*.07)
wy,wx=np.gradient(water)
edge=np.clip(np.hypot(wx,wy)*1.8,0,.08)*cotto
over([.045,.032,.015],edge)
# Reflection has its own asymmetric structure inside each connected water cluster.
sky_color=np.stack([.78+.10*cloud,.84+.10*cloud,.89+.10*cloud],axis=2)
reflection_alpha=np.power(cot_reflection,.60)*.65+water*material_gloss*.13
over(sky_color,reflection_alpha)
over([.72,.80,.85],cot_film*material_gloss*.06)
# Grass: separate, much weaker saturation/pooling profile; texture stays visible.
over([.026,.083,.075],grass_water*.11)
over([.60,.70,.75],grass_reflection*.065)
# Beige retains appropriate gloss but receives NO procedural pooling in V3.
over([.67,.70,.72],beige*(.025+.046*reflection*cloud))
# Wood response follows grain normals, without paving water field or broad puddles.
over([.65,.58,.52],wood*.043*material_gloss)
# Sparse humid sparkle, never a continuous specular grass sheet.
leaf_gloss=np.clip((micro-.05)*3,0,.08)*grass
leaf_gloss*=np.clip((fine-.58)*2,0,1)
over([.65,.70,.58],leaf_gloss)
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
lighting_texture=OUT/'rain-atmosphere-hd.webp'
# Lossless WebP reduces size without quantization/dither or visible loss.
lighting_hd.save(lighting_texture,format='WEBP',lossless=True,exact=True,method=6)
lighting_payload=base64.b64encode(lighting_texture.read_bytes()).decode()
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="4932" height="3091" viewBox="0 0 4932 3091" preserveAspectRatio="xMidYMid meet" pointer-events="none">
<!-- Rain V3 candidate: quality assessment in weather-preview/pioggia/REPORT.md.
Offline material masks from LAYER-15; environmental alpha texture ONLY.
No plan, aesthetic reference, or visible material map is embedded. Seed 20260916. -->
<image data-weather-pass="atmosphere" x="0" y="0" width="4932" height="3091" preserveAspectRatio="none" pointer-events="none" href="data:image/webp;base64,{lighting_payload}"/>
<image data-weather-pass="materials" x="0" y="0" width="4932" height="3091" preserveAspectRatio="none" pointer-events="none" href="data:image/png;base64,{payload}"/>
</svg>\n'''
(ROOT/'design/LAYER-METEO-PIOGGIA.svg').write_text(svg,encoding='utf8')
for period in ['giorno','notte']:
    original=Image.open(OUT/f'base-{period}.png').convert('RGBA')
    composite=composite_soft_light(original,Image.alpha_composite(lighting_hd,effects))
    review=composite.resize((1596,1000),Image.Resampling.LANCZOS)
    review.save(OUT/f'composite-{period}-review.png')
    review.save(OUT/f'composite-{period}-v3.png')
metadata={'version':3,'iteration':4,'compositing':'soft-light','variant':variant,'seed':20260916,'viewport':[W,H],'shading_resolution':[SW,SH],'material_texture_bytes':texture.stat().st_size,'atmosphere_texture_bytes':lighting_texture.stat().st_size,'svg_bytes':(ROOT/'design/LAYER-METEO-PIOGGIA.svg').stat().st_size,'excluded_material_effect_pixels':0,'interior_atmosphere_effect_pixels':int(np.count_nonzero(la[house_hd])),'material_pixels':{n:int(np.count_nonzero(ids==idx)) for n,idx in classes.items()}, 'cotto_clusters':cot_clusters,'giardino_clusters':grass_clusters,'coverage':{
'cotto_wetness_percent':100.0,
'cotto_film_only_percent':float(100*np.count_nonzero((cot_fields['film']>.12)&(cot_fields['water']<=.12))/np.count_nonzero(coarse_ids==classes['cotto'])),
'cotto_medium_percent':float(100*np.count_nonzero((cot_fields['water']>.12)&(cot_fields['water']<.68))/np.count_nonzero(coarse_ids==classes['cotto'])),
'cotto_major_percent':float(100*np.count_nonzero(cot_fields['water']>=.68)/np.count_nonzero(coarse_ids==classes['cotto'])),
'giardino_pooling_percent':float(100*np.count_nonzero(grass_fields['water']>.12)/np.count_nonzero(coarse_ids==classes['giardino']))},'source_hashes':hashes()}
(OUT/'generation.json').write_text(json.dumps(metadata,indent=2),encoding='utf8')
print(json.dumps(metadata))
