import sys
import unittest

from shapely.geometry import box

from street_lighting import HUNG, off_the_road, posts_in_road


class OffTheRoadTest(unittest.TestCase):
    # A street 8 m wide along x, houses 3 m behind each kerb for its first 100 m.
    def setUp(self):
        self.road = [box(0, -4, 300, 4)]
        self.houses = [box(0, 7, 100, 20), box(0, -20, 100, -7)]

    def test_post_in_the_middle_between_houses_is_hung(self):
        xy, kinds, (kerbed, hung, far) = off_the_road([(50, 0.2)], [0], self.road, self.houses)
        self.assertEqual((kinds, xy, hung), ([HUNG], [(50, 0.2)], 1), "it hangs where it was")
        self.assertEqual(posts_in_road(xy, kinds, self.road), [])

    def test_post_just_inside_the_kerb_is_put_on_the_pavement(self):
        xy, kinds, (kerbed, hung, far) = off_the_road([(50, 3.2)], [0], self.road, self.houses)
        self.assertEqual((kinds, kerbed), ([0], 1))
        self.assertAlmostEqual(xy[0][1], 4.5, places=3)
        self.assertEqual(posts_in_road(xy, kinds, self.road), [])

    def test_post_deep_in_an_open_road_goes_to_the_nearest_kerb(self):
        xy, kinds, (kerbed, hung, far) = off_the_road([(200, -1)], [2], self.road, self.houses)
        self.assertEqual((kinds, far), ([2], 1), "nothing to hang it from: it stays a gas lamp on its post")
        self.assertAlmostEqual(xy[0][1], -4.5, places=3)

    def test_post_between_two_roadways_is_hung_rather_than_moved_into_the_other(self):
        roads = [box(0, -4, 300, 4), box(0, 4.05, 300, 12)]
        xy, kinds, _ = off_the_road([(200, 3.4)], [0], roads, [])
        self.assertEqual(kinds, [HUNG])
        self.assertEqual(posts_in_road(xy, kinds, roads), [])

    def test_posts_on_the_pavement_and_lamps_without_posts_are_left(self):
        lamps, kinds = [(50, 5.5), (50, 0), (60, 0), (70, 3.9)], [0, 1, 6, 0]
        xy, got, counts = off_the_road(lamps, kinds, self.road, self.houses)
        self.assertEqual((xy, got, counts), (lamps, kinds, (0, 0, 0)), "a wall lamp, one set in the ground, and a post on the kerb's line")

    def test_the_check_finds_a_post_in_the_roadway(self):
        self.assertEqual(posts_in_road([(50, 0), (50, 6), (80, 1)], [0, 0, 7], self.road), [0])


def check_area(area):
    """The area's built lamps.bin.gz against its tiles' roadways: the posts standing in one."""
    import gzip
    import struct

    import build_lamps
    buf = gzip.decompress((build_lamps.OUT / f"{area}_now" / "lamps.bin.gz").read_bytes())
    n = struct.unpack_from("<I", buf)[0]
    xy = [struct.unpack_from("<ff", buf, 4 + i * 8) for i in range(n)]
    return [xy[i] for i in posts_in_road(xy, list(buf[4 + n * 8:4 + n * 9]), build_lamps.carriageways(area))], n


if __name__ == "__main__":
    # `uv run test_lamps_off_the_road.py --built ujezd centrum praha` checks the built files instead.
    if "--built" in sys.argv:
        failed = False
        for area in sys.argv[sys.argv.index("--built") + 1:]:
            bad, n = check_area(area)
            print(f"{area}: {n} lamps, {len(bad)} on posts in a roadway{': ' + ', '.join(f'({x:.1f}, {y:.1f})' for x, y in bad[:8]) if bad else ''}")
            failed = failed or bool(bad)
        sys.exit(1 if failed else 0)
    unittest.main()
