"""Authoritative offline material extraction; never infer materials from base RGB."""
from pathlib import Path
import copy, hashlib, json, re, xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'design/weather-preview/pioggia'
PALETTE={'#FF0000':'cotto','#FFFF00':'legno','#E97132':'beige','#4EA72E':'giardino','#00B0F0':'pond','#000000':'excluded'}
NS='{http://www.w3.org/2000/svg}'
ET.register_namespace('',NS[1:-1])

def normalize(source=None):
    source=source or ROOT/'design/LAYER-15-MAPPATURA.svg'
    doc=ET.parse(source).getroot()
    base=ET.parse(ROOT/'design/LAYER-00-GIORNO.svg').getroot()
    w,h=int(base.attrib['width']),int(base.attrib['height'])
    group=doc.find(NS+'g')
    transform=group.attrib.get('transform','')
    match=re.fullmatch(r'translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)',transform)
    if not match: raise ValueError('Root material transform is not an authoritative translation')
    gx,gy=map(float,match.groups())
    frames=[n for n in group if n.tag==NS+'rect' and n.attrib.get('fill')=='none' and float(n.attrib.get('width',0))==w and float(n.attrib.get('height',0))==h]
    if len(frames)!=1: raise ValueError('Expected one useful frame matching original viewport')
    frame=frames[0]
    fx,fy=float(frame.attrib['x'])+gx,float(frame.attrib['y'])+gy
    base_frame=base.find(NS+'defs/'+NS+'clipPath/'+NS+'rect')
    if base_frame is None or float(base_frame.attrib['width'])!=w or float(base_frame.attrib['height'])!=h:
        raise ValueError('Original base viewport clip is unavailable')
    bx,by=float(base_frame.attrib['x']),float(base_frame.attrib['y'])
    dx,dy=bx+gx,by+gy
    output=ET.Element(NS+'svg',{'width':str(w),'height':str(h),'viewBox':f'0 0 {w} {h}'})
    wrapper=ET.SubElement(output,NS+'g',{'transform':f'translate({-dx:g} {-dy:g})'})
    shapes=ET.SubElement(wrapper,NS+'g',{'transform':transform})
    counts={name:0 for name in PALETTE.values()}
    description=[]
    for node in group:
        if node.tag not in [NS+'rect',NS+'path',NS+'ellipse',NS+'circle']: continue
        fill=node.attrib.get('fill','#000000').upper()
        if fill=='NONE': continue # technical frames are not material/exclusion fills
        if fill not in PALETTE: raise ValueError('Unknown material fill '+fill)
        counts[PALETTE[fill]]+=1
        cloned=copy.deepcopy(node)
        for key in list(cloned.attrib):
            if key.startswith('stroke'): del cloned.attrib[key]
        cloned.set('fill',fill)
        shapes.append(cloned)
        description.append({'tag':node.tag.split('}')[1],'material':PALETTE[fill],'fill':fill,'geometry':{k:v for k,v in node.attrib.items() if k in ['x','y','width','height','d','transform']}})
    if any(counts[name]==0 for name in PALETTE.values()): raise ValueError('Missing semantic class')
    metadata={'source_root':dict(doc.attrib),'frame':dict(frame.attrib),'source_group_transform':transform,'frame_in_source_viewport':[fx,fy],'base_clip':dict(base_frame.attrib),'base_clip_in_source_viewport':[dx,dy],'normalization_translation':[-dx,-dy],'technical_frame_half_pixel_correction':[fx-dx,fy-dy],'scale':[1,1],'target_viewport':[0,0,w,h],'author_coordinate_translation':[-bx,-by],'classes':counts,'shapes':description}
    return ET.tostring(output,encoding='unicode'),metadata

def hashes():
    files=['LAYER-00-GIORNO.svg','LAYER-00-NOTTE.svg','LAYER-15-MAPPATURA.svg','LAYER-14-OVERLAY.svg','weather-reference/REF-METEO-PIOGGIA.png']
    return {n:hashlib.sha256((ROOT/'design'/n).read_bytes()).hexdigest() for n in files}

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    svg,metadata=normalize()
    (OUT/'material-mask-normalized.svg').write_text(svg,encoding='utf8')
    (OUT/'material-mask.json').write_text(json.dumps(metadata,indent=2),encoding='utf8')
    baseline=OUT/'source-hashes.json'
    if baseline.exists():
        if json.loads(baseline.read_text())!=hashes(): raise ValueError('Authoritative source changed during generation')
    else:
        baseline.write_text(json.dumps(hashes(),indent=2),encoding='utf8')
    print(json.dumps({k:metadata[k] for k in ['source_root','normalization_translation','classes']}))
