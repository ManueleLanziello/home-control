"""Static CSS soft-light equivalent for offline preview, W3C compositing-1 10.1.10."""
import numpy as np
from PIL import Image

def composite_soft_light(base, effect):
    base=base.convert('RGBA');effect=effect.convert('RGBA')
    assert base.size==effect.size
    output=Image.new('RGBA',base.size)
    for y in range(0,base.height,128):
        box=(0,y,base.width,min(y+128,base.height))
        backdrop=np.asarray(base.crop(box),dtype=np.float32)/255
        source=np.asarray(effect.crop(box),dtype=np.float32)/255
        cb=backdrop[:,:,:3];cs=source[:,:,:3];a=source[:,:,3:4]
        d=np.where(cb<=.25,((16*cb-12)*cb+4)*cb,np.sqrt(cb))
        blend=np.where(cs<=.5,cb-(1-2*cs)*cb*(1-cb),cb+(2*cs-1)*(d-cb))
        rgb=(1-a)*cb+a*blend
        rgba=np.concatenate([rgb,backdrop[:,:,3:4]],axis=2)
        output.paste(Image.fromarray(np.uint8(np.clip(rgba,0,1)*255+.5),'RGBA'),box)
    return output
