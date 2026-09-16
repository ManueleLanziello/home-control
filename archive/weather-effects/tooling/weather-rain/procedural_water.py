"""Deterministic water clusters. Layer 15 admission is the only spatial input."""
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

def smooth_noise(rng,shape,cols,rows):
    h,w=shape
    raw=np.uint8(rng.random((rows,cols))*255)
    return np.asarray(Image.fromarray(raw).resize((w,h),Image.Resampling.BICUBIC),dtype=np.float32)/255

def sample(field,x,y):
    h,w=field.shape
    x=np.clip(x,0,w-1.001);y=np.clip(y,0,h-1.001)
    x0=x.astype(np.int32);y0=y.astype(np.int32)
    dx=x-x0;dy=y-y0
    return ((1-dx)*(1-dy)*field[y0,x0]+dx*(1-dy)*field[y0,x0+1]+(1-dx)*dy*field[y0+1,x0]+dx*dy*field[y0+1,x0+1]).astype(np.float32)

def components(binary):
    """4-neighbour components at the coarse synthesis grid; no optional libraries."""
    h,w=binary.shape
    labels=np.zeros((h,w),dtype=np.int32)
    sizes=[]
    for y,x in zip(*np.where(binary)):
        if labels[y,x]: continue
        label=len(sizes)+1
        queue=deque([(int(y),int(x))]);labels[y,x]=label;size=0
        while queue:
            py,px=queue.popleft();size+=1
            for ny,nx in [(py-1,px),(py+1,px),(py,px-1),(py,px+1)]:
                if 0<=ny<h and 0<=nx<w and binary[ny,nx] and not labels[ny,nx]:
                    labels[ny,nx]=label;queue.append((ny,nx))
        sizes.append((label,size))
    return labels,sizes

def generate_water(admitted,seed,profile):
    rng=np.random.default_rng(seed)
    h,w=admitted.shape
    y,x=np.mgrid[0:h,0:w].astype(np.float32)
    field=.64*smooth_noise(rng,(h,w),9,8)+.27*smooth_noise(rng,(h,w),23,19)+.09*smooth_noise(rng,(h,w),63,49)
    # Warp only synthetic water structure; never the scene or semantic shapes.
    wx=x+(smooth_noise(rng,(h,w),11,13)-.5)*w*.055
    wy=y+(smooth_noise(rng,(h,w),14,9)-.5)*h*.060
    field=sample(field,wx,wy)
    if not np.any(admitted):
        return {k:np.zeros_like(field) for k in ['water','reflection','film','labels']},[]
    settings={'cotto':(.79,6,1,180),'giardino':(.93,2,0,100)}
    quantile,limit,major_limit,min_size=settings[profile]
    threshold=float(np.quantile(field[admitted],quantile))
    labels,sizes=components((field>threshold)&admitted)
    selected=sorted([(lab,size) for lab,size in sizes if size>=min_size],key=lambda t:(-t[1],t[0]))[:limit]
    upper=max(float(np.quantile(field[admitted],.995)),threshold+.01)
    water=np.zeros_like(field);reflection=np.zeros_like(field);output_labels=np.zeros_like(labels)
    independent=smooth_noise(rng,(h,w),27,21)
    cloud=smooth_noise(rng,(h,w),12,14)
    normals=.65*smooth_noise(rng,(h,w),111,93)+.35*smooth_noise(rng,(h,w),251,187)
    normal_y,normal_x=np.gradient(normals)
    info=[]
    for index,(label,size) in enumerate(selected,1):
        region=labels==label
        # Keep a hierarchy: one dominant puddle at most, medium clusters elsewhere.
        strength=1.0 if index<=major_limit else (.60 if profile=='cotto' else .50)
        pool=np.clip((field-threshold)/(upper-threshold),0,1)*region
        pool=np.asarray(Image.fromarray(np.uint8(pool*255)).filter(ImageFilter.GaussianBlur(1.0)),dtype=np.float32)/255
        pool*=admitted
        pool*=strength
        # Fragmentation is low-frequency and internal, not white noise.
        pool*=np.clip(.65+.6*independent,0,1)
        water=np.maximum(water,pool)
        py,px=np.where(region);cx=float(px.mean());cy=float(py.mean())
        angle=float(rng.uniform(-np.pi,np.pi))
        span=max(float(np.ptp(px)),float(np.ptp(py)),5)
        u=((x-cx)*np.cos(angle)+(y-cy)*np.sin(angle))/span
        v=(-(x-cx)*np.sin(angle)+(y-cy)*np.cos(angle))/span
        offset=float(rng.uniform(-.26,.26));width=float(rng.uniform(.14,.32))
        swath=np.exp(-((u-offset)/width)**2)*(.34+.66*cloud)
        wave_gloss=np.exp(-np.abs(normal_x*np.cos(angle)+normal_y*np.sin(angle)-.012)*32)**3
        secondary=np.clip(.08+.37*swath+.25*independent+.30*wave_gloss+.08*v,0,1)
        reflection=np.maximum(reflection,pool*secondary)
        output_labels[region]=index
        info.append({'cluster':index,'coarse_pixels':size,'angle_radians':angle,'reflection_offset':offset,'strength':strength})
    film_threshold=float(np.quantile(field[admitted],.52 if profile=='cotto' else .78))
    film=np.clip((field-film_threshold)/max(upper-film_threshold,.01),0,1)*admitted
    return {'water':water,'reflection':reflection,'film':film,'labels':output_labels},info
