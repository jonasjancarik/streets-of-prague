"""Bridge support at shared terrain nodes survives drawable-polygon clipping."""
import copy
import unittest
import numpy as np
from ipr_terrain import pull_to_bridges


class GroundPullTests(unittest.TestCase):
    def fixture(self):
        tiles={(0,0):np.full((3,3),192.4,dtype=np.float32),(1,0):np.full((3,3),192.4,dtype=np.float32)}
        h=np.full((3,3),np.nan,dtype=np.float32);h[1,0]=192.05
        return tiles,{}, {(1,0):[(1,'bridge',h,[])]}

    def test_one_sided_bridge_payload_corrects_both_ground_copies(self):
        tiles,labels,found=self.fixture();before=copy.deepcopy(tiles);deck=found[(1,0)][0][2].copy()
        self.assertEqual(pull_to_bridges(tiles,labels,found,2),2)
        self.assertEqual(tiles[(0,0)][1,2],tiles[(1,0)][1,0])
        self.assertEqual(tiles[(0,0)][1,2],np.float32(192.05))
        for key,mask in [((0,0),(1,2)),((1,0),(1,0))]:
            before[key][mask]=np.float32(192.05);np.testing.assert_array_equal(tiles[key],before[key])
        np.testing.assert_array_equal(found[(1,0)][0][2],deck)

    def test_actual_ujezd_survey_and_deck_records(self):
        tiles={(2,0):np.full((63,63),192,np.float32),(3,0):np.full((63,63),192,np.float32)}
        h=np.full((63,63),np.nan,np.float32)
        for y,ground in [(7,192.40663146972656),(8,191.99327087402344)]:
            tiles[(2,0)][y,62]=tiles[(3,0)][y,0]=ground
            h[y,0]=192.05674743652344
        self.assertEqual(pull_to_bridges(tiles,{}, {(3,0):[(1,'bridge',h,[])]},62),4)
        for y in (7,8):
            self.assertEqual(tiles[(2,0)][y,62],tiles[(3,0)][y,0])
            self.assertEqual(round((float(tiles[(2,0)][y,62])-100)*10),921)

    def test_duplicate_support_applied_once_and_tile_order_independent(self):
        tiles,labels,found=self.fixture();h=found[(1,0)][0][2].copy();h[:]=np.nan;h[1,2]=192.05;found[(0,0)]=[(1,'bridge',h,[])]
        a=copy.deepcopy(tiles);b=dict(reversed(list(copy.deepcopy(tiles).items())))
        self.assertEqual(pull_to_bridges(a,labels,found,2),2)
        pull_to_bridges(b,labels,dict(reversed(list(found.items()))),2)
        for key in a:np.testing.assert_array_equal(a[key],b[key])

    def test_separate_elevated_level_does_not_replace_low_deck(self):
        tiles,labels,found=self.fixture();high=found[(1,0)][0][2].copy();high[1,0]=205
        found[(1,0)].append((2,'bridge',high,[]));pull_to_bridges(tiles,labels,found,2)
        self.assertEqual(tiles[(0,0)][1,2],np.float32(192.05))
        self.assertEqual(tiles[(1,0)][1,0],np.float32(192.05))

    def test_nearby_levels_keep_existing_order_without_maximum_or_average(self):
        tiles,labels,found=self.fixture()
        for a in tiles.values(): a[:]=200
        low=found[(1,0)][0][2];low[1,0]=199.75
        high=low.copy();high[1,0]=200.5;found[(1,0)].append((2,'bridge',high,[]))
        pull_to_bridges(tiles,labels,found,2)
        for key,xy in [((0,0),(1,2)),((1,0),(1,0))]:self.assertEqual(tiles[key][xy],np.float32(200.3125))

    def test_water_and_tunnels_unaffected(self):
        tiles,labels,found=self.fixture();labels={(0,0):np.zeros((3,3),np.uint8),(1,0):np.zeros((3,3),np.uint8)}
        for key,xy in [((0,0),(1,2)),((1,0),(1,0))]: labels[key][xy]=1
        self.assertEqual(pull_to_bridges(tiles,labels,found,2),0)
        tiles,labels,found=self.fixture();found[(1,0)][0]=(-1,'tunnel',found[(1,0)][0][2],[])
        self.assertEqual(pull_to_bridges(tiles,labels,found,2),0)

    def test_distinct_terrace_ground_heights_not_merged(self):
        tiles,labels,found=self.fixture();labels={(0,0):np.full((3,3),2,np.uint8),(1,0):np.full((3,3),3,np.uint8)}
        tiles[(0,0)][1,2]=198;pull_to_bridges(tiles,labels,found,2)
        self.assertEqual(tiles[(0,0)][1,2],198)
        self.assertEqual(tiles[(1,0)][1,0],np.float32(192.05))

    def test_conflicting_same_level_support_rejected_before_mutation(self):
        tiles,labels,found=self.fixture();h=np.full((3,3),np.nan,np.float32);h[1,2]=192.1;found[(0,0)]=[(1,'bridge',h,[])]
        before=copy.deepcopy(tiles)
        with self.assertRaisesRegex(ValueError,'conflicting bridge support'):pull_to_bridges(tiles,labels,found,2)
        for key in tiles:np.testing.assert_array_equal(tiles[key],before[key])

    def test_conflicting_plain_ground_rejected_before_mutation(self):
        tiles,labels,found=self.fixture();tiles[(0,0)][1,2]=192.3;before=copy.deepcopy(tiles)
        with self.assertRaisesRegex(ValueError,'conflicting plain ground'):pull_to_bridges(tiles,labels,found,2)
        for key in tiles:np.testing.assert_array_equal(tiles[key],before[key])

    def test_vertical_and_four_tile_corner_support(self):
        tiles={(i,j):np.full((3,3),192.4,np.float32) for i in range(2) for j in range(2)}
        h=np.full((3,3),np.nan,np.float32);h[0,0]=192.05
        count=pull_to_bridges(tiles,{}, {(1,1):[(1,'bridge',h,[])]},2)
        self.assertEqual(count,4)
        for key,xy in [((0,0),(2,2)),((1,0),(2,0)),((0,1),(0,2)),((1,1),(0,0))]:self.assertEqual(tiles[key][xy],np.float32(192.05))

    def test_interior_rule_matches_legacy_pull(self):
        tiles,labels,found=self.fixture();h=found[(1,0)][0][2];h[1,0]=np.nan;h[1,1]=193.2
        before=tiles[(0,0)].copy();pull_to_bridges(tiles,labels,found,2)
        np.testing.assert_array_equal(tiles[(0,0)],before)
        a=np.float32(192.4);apart=np.float32(193.2)-a;expected=a+apart*np.clip((1.5-abs(apart))/1,0,1)
        self.assertEqual(tiles[(1,0)][1,1],expected)


if __name__=='__main__':unittest.main()
