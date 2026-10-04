"""A roof with a courtyard in it is read with the courtyard cut out (the schools with atria in Kobylisy)."""

import tempfile
import unittest
from pathlib import Path

import numpy as np

import ipr_buildings as ipr

GML = """<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:gml="http://www.opengis.net/gml"
  xmlns:bldg="http://www.opengis.net/citygml/building/2.0"><core:cityObjectMember><bldg:Building gml:id="_1">
  <bldg:boundedBy><bldg:RoofSurface><bldg:lod3MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon>
    <gml:exterior><gml:LinearRing><gml:posList srsDimension="3">0 0 10 40 0 10 40 40 10 0 40 10 0 0 10</gml:posList></gml:LinearRing></gml:exterior>
    <gml:interior><gml:LinearRing><gml:posList srsDimension="3">10 10 10 10 30 10 30 30 10 30 10 10 10 10 10</gml:posList></gml:LinearRing></gml:interior>
  </gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod3MultiSurface></bldg:RoofSurface></bldg:boundedBy>
</bldg:Building></core:cityObjectMember></core:CityModel>"""


def plan_area(tris):
    return sum(abs(np.cross(t[1] - t[0], t[2] - t[0])[2]) / 2 for t in tris)


class OpeningTests(unittest.TestCase):
    def test_a_roof_keeps_its_inner_ring_as_a_hole(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "sheet.gml"
            path.write_text(GML)
            [(gid, [(kind, outer, holes)])] = list(ipr.buildings(path))
        self.assertEqual((gid, kind, len(outer), [len(h) for h in holes]), ("_1", 1, 4, [4]))
        self.assertAlmostEqual(plan_area(ipr.triangulate(outer, holes)), 1600 - 400)
        self.assertAlmostEqual(plan_area(ipr.triangulate(outer)), 1600)

    def test_only_openings_of_courtyard_size_are_cut(self):
        window = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], float)
        yard = np.array([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], float)
        self.assertLess(ipr._plan_area(window), ipr.OPENING)
        self.assertGreaterEqual(ipr._plan_area(yard), ipr.OPENING)


if __name__ == "__main__":
    unittest.main()
