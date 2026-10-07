"""Young woods and clearings are found where a mapped wood is low in the surface model and the
older model or the photo agrees, the same on both sides of a tile border, and go stale with the
wood outlines and heights."""

import unittest
from contextlib import contextmanager
from unittest import mock

import numpy as np

import layers
import young_woods

T = 120.0
META = {"tile": T, "terrain": {"n": 31, "step": 4.0}}
BOX = [0.0, 0.0, T, T]
TILE = {"i": 0, "j": 0, "box": BOX}
WOOD = [[[[0, 0], [120, 0], [120, 120], [0, 120], [0, 0]]]]
EVERYWHERE = [[[[-500, -500], [500, -500], [500, 500], [-500, 500], [-500, -500]]]]
GRASS, CANOPY, ROCK = (0.55, 0.6, 0.35), (0.22, 0.3, 0.2), (0.6, 0.6, 0.58)


def flat(value):
    return lambda X, Y: np.full(X.shape, value, np.float32)


def left_half(low, high):
    return lambda X, Y: np.where(X < 60, low, high).astype(np.float32)


def square(x0, y0, x1, y1, inside, outside):
    return lambda X, Y: np.where((X >= x0) & (X < x1) & (Y >= y0) & (Y < y1), inside, outside).astype(np.float32)


@contextmanager
def world(canopy, ground=flat(300.0), photo=GRASS, earlier=None, no_photo=False, no_surface=False):
    """A made-up place: canopy height (m above the ground) now and in the earlier model, as
    functions of the map's x and y; the photo one colour, or a function giving brightness."""
    def dsm(area, t, res, cache=True):
        X, Y = young_woods.gc.grid(t, res)
        return np.zeros(X.shape, np.float32) if no_surface else (ground(X, Y) + canopy(X, Y)).astype(np.float32)

    def terrain(area, meta, t):
        c = np.arange(31) * 4.0
        X, Y = np.meshgrid(t["i"] * T + c, t["j"] * T + c)
        return ground(X, Y).astype(np.float32), 4.0

    def picture(url, kind, area, t, res):
        if no_photo:
            raise OSError("offline")
        X, Y = young_woods.gc.grid(t, res)
        if callable(photo):
            return np.repeat(photo(X, Y)[:, :, None], 3, axis=2) * np.array([0.92, 1.0, 0.6], np.float32)
        return np.broadcast_to(np.array(photo, np.float32), (*X.shape, 3)).copy()

    def export(url, name, area, t, res, src_res, **kw):
        X, Y = young_woods.gc.grid(t, res)
        return (ground(X, Y) + (earlier or canopy)(X, Y)).astype(np.float32)[:, :, None]

    gc = young_woods.gc
    with mock.patch.object(gc, "ipr_dsm", side_effect=dsm), mock.patch.object(gc, "terrain", side_effect=terrain), \
         mock.patch.object(gc, "photo", side_effect=picture), mock.patch.object(gc, "export", side_effect=export):
        yield


def masks(wood=WOOD, tile=TILE, around=(), **place):
    with world(**place):
        return young_woods.young_mask("x", META, tile, wood, around)


class YoungMaskTests(unittest.TestCase):
    def test_a_low_canopy_is_young_and_a_tall_one_is_not(self):
        young, _, in_wood = masks(canopy=left_half(3.0, 18.0))
        self.assertTrue(in_wood.all())
        self.assertTrue(young[:, 5:55].all())
        self.assertFalse(young[:, 65:].any())

    def test_where_the_surface_model_has_nothing_nothing_is_young(self):
        young, clear, _ = masks(canopy=flat(3.0), no_surface=True)
        self.assertFalse(young.any() or clear.any())

    def test_low_growth_outside_the_wood_is_left_alone(self):
        young, _, _ = masks(wood=[[[[60, 0], [120, 0], [120, 120], [60, 120], [60, 0]]]], canopy=left_half(3.0, 18.0))
        self.assertFalse(young[:, :55].any())

    def test_patches_under_the_minimum_are_dropped(self):
        self.assertFalse(masks(canopy=square(50, 50, 60, 60, 3.0, 18.0))[0].any())  # 100 m2

    def test_a_closed_wood_that_only_reads_low_is_not_young(self):
        # Tall in the earlier model and dark in the photo: the surface model is wrong there.
        place = dict(canopy=left_half(3.0, 18.0), earlier=flat(20.0))
        self.assertFalse(masks(photo=CANOPY, **place)[0].any())
        # Tall then, low and sunlit now: felled and growing back.
        self.assertTrue(masks(photo=GRASS, **place)[0][:, 5:55].all())
        # Low then and now, whatever the photo: scrub, or a hedge.
        self.assertTrue(masks(photo=CANOPY, canopy=left_half(3.0, 18.0), earlier=left_half(2.0, 18.0))[0][:, 5:55].all())
        # Neither the photo nor the earlier model... the photo alone is not enough to refuse.
        self.assertTrue(masks(no_photo=True, canopy=left_half(3.0, 18.0))[0][:, 5:55].all())

    def test_bare_ground_inside_the_wood_is_a_clearing_not_a_young_wood(self):
        young, clear, _ = masks(canopy=square(30, 30, 70, 70, 0.3, 18.0))  # 1,600 m2 of grass
        self.assertFalse(young.any())
        self.assertTrue(clear[56:84, 36:64].all())
        self.assertFalse(masks(canopy=square(90, 90, 100, 100, 0.3, 18.0))[1].any())  # a gap between crowns

    def test_a_low_surface_under_a_canopy_or_over_rock_is_not_a_clearing(self):
        bare = square(30, 30, 70, 70, 0.3, 18.0)
        self.assertFalse(masks(canopy=bare, photo=CANOPY)[1].any())
        self.assertFalse(masks(canopy=bare, photo=ROCK)[1].any())
        self.assertFalse(masks(canopy=bare, no_photo=True)[1].any())

    def test_a_steep_slope_is_not_a_clearing(self):
        self.assertFalse(masks(canopy=flat(0.3), ground=lambda X, Y: 300.0 + Y)[1].any())  # 45 degrees
        self.assertTrue(masks(canopy=flat(0.3), ground=lambda X, Y: 300.0 + 0.2 * Y, around=EVERYWHERE)[1].all())

    def test_two_tiles_agree_along_their_border(self):
        # A wavy clearing and a young wood across the border between tile 0 and tile 1, told by
        # the photo's brightness and by the canopy: each tile's own strip of the other's margin
        # must come out the same as the other tile has it.
        canopy = lambda X, Y: np.where((Y > 20) & (Y < 50), 3.0, np.where((Y > 70 + 8 * np.sin(X / 7)) & (Y < 100), 0.3, 18.0))
        photo = lambda X, Y: np.where(Y < 78 + 6 * np.cos(X / 9), 0.3, 0.6).astype(np.float32)
        with world(canopy=canopy, photo=photo):
            a = young_woods.wide_masks("x", META, TILE, EVERYWHERE)
            b = young_woods.wide_masks("x", META, {"i": 1, "j": 0, "box": [T, 0.0, 2 * T, T]}, EVERYWHERE)
        M = young_woods.MARGIN
        self.assertGreater(M, 8)
        for k in (0, 1):  # young, clearing
            self.assertTrue(a[k][M:-M, M:-M].any() and b[k][M:-M, M:-M].any())
            # Columns of the map from 8 m west of the border to 8 m east of it, in both.
            np.testing.assert_array_equal(a[k][M:-M, -M - 8:-M + 8], b[k][M:-M, M - 8:M + 8])

    def test_polygons_stay_inside_the_wood_and_tile_and_reach_its_edge(self):
        with world(canopy=left_half(3.0, 18.0)):
            young, _, _, tw = young_woods.wide_masks("x", META, TILE, WOOD, EVERYWHERE)
        polys = young_woods.vectorise(young, tw, WOOD, clip=BOX)
        self.assertEqual(len(polys), 1)
        xs = [x for ring in polys[0] for x, _ in ring]
        ys = [y for ring in polys[0] for _, y in ring]
        self.assertEqual(min(xs), 0)  # where it goes on next door
        self.assertEqual((min(ys), max(ys)), (0, 120))
        self.assertTrue(55 < max(xs) < 65)


class YoungLayerTests(unittest.TestCase):
    def tile(self, **areas):
        return {"areas": areas}

    def test_key_follows_the_wood_outlines_and_heights_but_not_the_young_woods(self):
        t = self.tile(wood=WOOD)
        key = layers.young_key(t, "h1")
        t["areas"] = {**t["areas"], "young_wood": WOOD, "wood_clearing": WOOD}
        self.assertEqual(layers.young_key(t, "h1"), key)
        self.assertNotEqual(layers.young_key(t, "h2"), key)
        self.assertNotEqual(layers.young_key(self.tile(wood=WOOD, dtm_wood=WOOD), "h1"), key)

    def test_key_agrees_with_the_one_the_build_makes(self):
        t = self.tile(wood=WOOD)
        self.assertEqual(young_woods.tile_key(young_woods.wood_of(t), "h1"), layers.young_key(t, "h1"))


if __name__ == "__main__":
    unittest.main()
