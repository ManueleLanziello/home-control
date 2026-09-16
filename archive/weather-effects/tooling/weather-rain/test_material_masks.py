"""Targeted tests for semantic normalization and protection in the actual SVG payload."""
import base64, hashlib, io, json, tempfile, unittest
from pathlib import Path
from xml.etree import ElementTree as ET
import numpy as np
from PIL import Image
from material_masks import ROOT, OUT, NS, PALETTE, normalize, hashes

class MaterialMasksTest(unittest.TestCase):
    def test_classes_and_frame(self):
        svg,meta=normalize()
        self.assertEqual(meta['classes'],{'cotto':2,'legno':1,'beige':3,'giardino':2,'pond':1,'excluded':2})
        self.assertEqual(meta['source_root']['width'],'4939')
        self.assertEqual(meta['source_root']['height'],'3100')
        self.assertNotIn('viewBox',meta['source_root'])
        self.assertEqual(meta['normalization_translation'],[-4,-3])
        self.assertEqual(meta['author_coordinate_translation'],[-133,-909])
        self.assertEqual(meta['scale'],[1,1])
        root=ET.fromstring(svg)
        self.assertEqual(root.attrib['viewBox'],'0 0 4932 3091')
        self.assertNotIn('stroke=',svg)
        night=ET.parse(ROOT/'design/LAYER-00-NOTTE.svg').getroot()
        night_clip=night.find(NS+'defs/'+NS+'clipPath/'+NS+'rect')
        self.assertEqual(night_clip.attrib,meta['base_clip'])
        self.assertEqual(night.find(NS+'g').attrib['transform'],'translate(-133 -909)')

    def test_normalization_is_invariant_to_source_root_translation(self):
        doc=ET.parse(ROOT/'design/LAYER-15-MAPPATURA.svg')
        doc.getroot().find(NS+'g').set('transform','translate(-500 -1200)')
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'source.svg';doc.write(p)
            _,meta=normalize(p)
        self.assertEqual(meta['normalization_translation'],[367,291])
        self.assertEqual(meta['author_coordinate_translation'],[-133,-909])

    def test_unknown_material_is_rejected(self):
        doc=ET.parse(ROOT/'design/LAYER-15-MAPPATURA.svg')
        doc.getroot().find(NS+'g').find(NS+'rect').set('fill','#123456')
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'source.svg';doc.write(p)
            with self.assertRaisesRegex(ValueError,'Unknown material fill'): normalize(p)

    def test_exact_classes_at_author_coordinates_and_paint_order(self):
        im=Image.open(OUT/'material-mask-hd.png').convert('RGBA')
        for x,y,color in [(500,1500,'#FF0000'),(600,2400,'#FFFF00'),(1250,2200,'#E97132'),(4000,2400,'#4EA72E'),(4413,1694,'#00B0F0'),(2000,2000,'#000000'),(1800,1200,'#000000')]:
            actual=im.getpixel((int(x-133),int(y-909)))
            expected=tuple(int(color[k:k+2],16) for k in (1,3,5))+(255,)
            self.assertEqual(actual,expected)

    def test_actual_payload_has_zero_effects_on_exclusions(self):
        svg=ET.parse(ROOT/'design/LAYER-METEO-PIOGGIA.svg').getroot()
        payload=svg.find(NS+"image[@data-weather-pass='materials']").attrib['href'].split(',',1)[1]
        effects=Image.open(io.BytesIO(base64.b64decode(payload))).convert('RGBA')
        self.assertEqual(effects.size,(4932,3091))
        rgba=np.asarray(Image.open(OUT/'material-mask-hd.png').convert('RGBA'))
        allowed=np.zeros(rgba.shape[:2],dtype=bool)
        for color,name in PALETTE.items():
            if name=='excluded': continue
            rgb=np.array([int(color[k:k+2],16) for k in (1,3,5)])
            allowed |= np.all(rgba[:,:,:3]==rgb,axis=2)&(rgba[:,:,3]>=128)
        self.assertEqual(np.count_nonzero(np.asarray(effects.getchannel('A'))[~allowed]),0)

    def test_sources_are_byte_for_byte_unchanged(self):
        expected=json.loads((OUT/'source-hashes.json').read_text())
        self.assertEqual(hashes(),expected)

if __name__=='__main__': unittest.main()
