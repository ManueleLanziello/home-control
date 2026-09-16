"""V3 invariants on the real semantic admission fields; no hardware/providers."""
import base64,io,json,unittest
from xml.etree import ElementTree as ET
import numpy as np
from PIL import Image
from material_masks import OUT,ROOT,NS,normalize
from procedural_water import generate_water

class ProceduralWaterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.saved=np.load(OUT/'fields-v3.npz')
        cls.cot=cls.saved['coarse_ids']==1
        cls.grass=cls.saved['coarse_ids']==4

    def test_fixed_seed_matches_saved_fields_and_repeated_run(self):
        for mask,seed,profile,prefix in [(self.cot,20260916,'cotto','cotto'),(self.grass,20260917,'giardino','giardino')]:
            one,info=generate_water(mask,seed,profile)
            two,other=generate_water(mask,seed,profile)
            self.assertEqual(info,other)
            for name in ['water','reflection','film']:
                np.testing.assert_array_equal(one[name],two[name])
            for name in ['water','reflection']:
                np.testing.assert_array_equal(one[name],self.saved[prefix+'_'+name])

    def test_pooling_and_reflection_never_escape_two_admitted_materials(self):
        for prefix,mask in [('cotto',self.cot),('giardino',self.grass)]:
            for name in ['water','reflection']:
                self.assertEqual(np.count_nonzero(self.saved[prefix+'_'+name][~mask]),0)

    def test_reflection_is_correlated_but_has_distinct_internal_structure(self):
        water=self.saved['cotto_water'];reflection=self.saved['cotto_reflection']
        active=water>.12
        self.assertTrue(np.all(reflection<=water+1e-6))
        self.assertGreater(np.corrcoef(water[active],reflection[active])[0,1],.7)
        self.assertGreater(np.std(reflection[active]/water[active]),.03)
        self.assertFalse(np.array_equal(water,reflection))

    def test_hierarchy_and_sparse_weaker_garden(self):
        cot,clusters=generate_water(self.cot,20260916,'cotto')
        grass,grclusters=generate_water(self.grass,20260917,'giardino')
        self.assertLessEqual(len(clusters),6);self.assertLessEqual(len(grclusters),2)
        self.assertLessEqual(sum(c['strength']==1 for c in clusters),1)
        self.assertTrue(all(c['strength']<=.5 for c in grclusters))
        cotton_fraction=np.count_nonzero(cot['water']>.12)/np.count_nonzero(self.cot)
        garden_fraction=np.count_nonzero(grass['water']>.12)/np.count_nonzero(self.grass)
        self.assertLess(garden_fraction,cotton_fraction/2)
        self.assertLess(garden_fraction,.06)
        self.assertGreater(np.count_nonzero(cot['water']>=.68),0)

    def test_atmosphere_payload_protects_exact_house_interior(self):
        svg=ET.parse(ROOT/'design/LAYER-METEO-PIOGGIA.svg').getroot()
        href=svg.find(NS+"image[@data-weather-pass='atmosphere']").attrib['href']
        self.assertTrue(href.startswith('data:image/webp;base64,'))
        atmo=Image.open(io.BytesIO(base64.b64decode(href.split(',',1)[1]))).convert('RGBA')
        self.assertEqual(atmo.size,(4932,3091))
        _,meta=normalize()
        rect=max((s['geometry'] for s in meta['shapes'] if s['material']=='excluded'),key=lambda r:float(r['width'])*float(r['height']))
        y,x=np.mgrid[0:3091,0:4932];dx,dy=meta['author_coordinate_translation']
        interior=(x>=float(rect['x'])+dx)&(x<float(rect['x'])+dx+float(rect['width']))&(y>=float(rect['y'])+dy)&(y<float(rect['y'])+dy+float(rect['height']))
        alpha=np.asarray(atmo.getchannel('A'))
        self.assertEqual(np.count_nonzero(alpha[interior]),0)
        self.assertGreater(np.count_nonzero(alpha[~interior]),0)

    def test_empty_admission_produces_no_water_or_reflection(self):
        fields,clusters=generate_water(np.zeros((32,40),dtype=bool),20260916,'cotto')
        self.assertEqual(clusters,[])
        self.assertTrue(all(np.count_nonzero(f)==0 for f in fields.values()))

if __name__=='__main__':unittest.main()
