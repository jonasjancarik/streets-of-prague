"""Chunk scheduling stays completion ordered without submitting the whole map."""

import gc
import multiprocessing
import os
import unittest
from unittest.mock import patch

import build_tiles
from test_parallel_map import FakeExecutor, process_value


class ChunkSchedulingTests(unittest.TestCase):
    def fake(self, **kwargs):
        executor = FakeExecutor(**kwargs)
        factory = self.enterContext(patch.object(build_tiles, "ProcessPoolExecutor", return_value=executor))
        return executor, factory

    def complete_newest(self, executor):
        def wait(futures, *, return_when):
            self.assertIs(return_when, build_tiles.FIRST_COMPLETED)
            future = max(futures, key=lambda f: f.job)
            executor.complete(future)
            return {future}, set(futures) - {future}
        self.enterContext(patch.object(build_tiles, "wait", side_effect=wait))

    def test_large_build_keeps_only_two_futures_per_worker(self):
        # The current 139 x 105 tile Praha grid has 252 chunks (8 tiles a side).
        for count, workers in ((252, 4), (4096, 8)):
            with self.subTest(count=count, workers=workers):
                executor, factory = self.fake()
                with patch.object(build_tiles, "build_chunk", side_effect=lambda job: (job, job * 2)):
                    results = build_tiles.chunk_results(range(count), workers)
                    self.addCleanup(results.close)
                    factory.assert_not_called()
                    found = []
                    for consumed in range(1, count + 1):
                        found.append(next(results))
                        self.assertLessEqual(len(executor.submitted) - consumed, 2 * workers - 1)
                        self.assertLessEqual(executor.max_live, 2 * workers)
                        if consumed == 1:
                            self.assertEqual(len(executor.submitted), 2 * workers)
                            gc.collect()
                            self.assertEqual(sum(ref() is not None for ref in executor.refs), 2 * workers - 1)
                    with self.assertRaises(StopIteration):
                        next(results)
                self.assertEqual(sorted(found), [(job, job * 2) for job in range(count)])
                self.assertTrue(executor.exited)
                factory.assert_called_once_with(workers, initializer=build_tiles.setup)

    def test_slow_first_chunk_does_not_delay_reporting_or_refill(self):
        executor, _ = self.fake(mode="on_result")
        self.complete_newest(executor)
        with patch.object(build_tiles, "build_chunk", side_effect=lambda job: job):
            results = list(build_tiles.chunk_results(range(10), 2))
        self.assertEqual(results, [3, 4, 5, 6, 7, 8, 9, 2, 1, 0])
        self.assertEqual(results, executor.completed)
        self.assertEqual(executor.requested, results)

    def test_serial_empty_and_single_paths_remain_lazy(self):
        _, factory = self.fake()
        with patch.object(build_tiles, "build_chunk", side_effect=[0, ValueError("serial failure")]) as build:
            results = build_tiles.chunk_results(range(4), 1)
            build.assert_not_called()
            self.assertEqual(next(results), 0)
            with self.assertRaisesRegex(ValueError, "serial failure"):
                next(results)
            self.assertEqual(build.call_count, 2)
        with patch.object(build_tiles, "build_chunk", side_effect=lambda job: job):
            self.assertEqual(list(build_tiles.chunk_results([], 8)), [])
            self.assertEqual(list(build_tiles.chunk_results([7], 8)), [7])
        factory.assert_not_called()

    def test_failed_chunk_propagates_and_cancels_queued_work(self):
        executor, _ = self.fake(mode="on_result")
        self.complete_newest(executor)
        with patch.object(build_tiles, "build_chunk", side_effect=ValueError("chunk failed")):
            with self.assertRaisesRegex(ValueError, "chunk failed"):
                next(build_tiles.chunk_results(range(100), 2))
        self.assertEqual(executor.submitted, [0, 1, 2, 3])
        self.assertEqual(executor.completed, [3])
        self.assertCountEqual(executor.cancelled, [0, 1, 2])
        self.assertTrue(executor.exited)
        self.assertIs(executor.exit_exception, ValueError)

    def test_submit_failure_cancels_work_already_submitted(self):
        executor, _ = self.fake(mode="on_result", fail_submit=2)
        with self.assertRaisesRegex(RuntimeError, "submit failed"):
            next(build_tiles.chunk_results(range(100), 2))
        self.assertCountEqual(executor.cancelled, [0, 1])
        self.assertTrue(executor.exited)
        self.assertIs(executor.exit_exception, RuntimeError)

    def test_closing_paused_results_cancels_work_and_exits_pool(self):
        executor, _ = self.fake(mode="on_result")
        self.complete_newest(executor)
        with patch.object(build_tiles, "build_chunk", side_effect=lambda job: job):
            results = build_tiles.chunk_results(range(100), 2)
            self.assertEqual(next(results), 3)
            results.close()
        self.assertEqual(executor.submitted, [0, 1, 2, 3])
        self.assertEqual(executor.completed, [3])
        self.assertCountEqual(executor.cancelled, [0, 1, 2])
        self.assertTrue(executor.exited)
        self.assertIs(executor.exit_exception, GeneratorExit)

    def test_real_process_pool_equivalence_and_shutdown(self):
        before = {child.pid for child in multiprocessing.active_children()}
        with patch.object(build_tiles, "build_chunk", process_value), patch.object(build_tiles, "setup", os.getpid):
            results = list(build_tiles.chunk_results(range(40), 2))
            self.assertEqual(sorted(value for _, value in results), list(range(0, 80, 2)))
            self.assertTrue(all(pid != os.getpid() for pid, _ in results))
            self.assertFalse({pid for pid, _ in results} & {child.pid for child in multiprocessing.active_children()})
            iterator = build_tiles.chunk_results(range(100), 2)
            self.addCleanup(iterator.close)
            next(iterator)
            children = {child.pid for child in multiprocessing.active_children()} - before
            self.assertTrue(children)
            iterator.close()
            self.assertFalse(children & {child.pid for child in multiprocessing.active_children()})

    def test_failed_run_does_not_publish_metadata_or_assemble(self):
        import test_build_cache

        # Reuse the isolated miniature OSM fixture; never touch the active map.
        fixture = test_build_cache.ChunkBuildTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.run_build()
        meta = build_tiles.layers.folder("ujezd") / "meta.json"
        before = meta.read_bytes()
        with patch.object(build_tiles, "chunk_results", side_effect=ValueError("worker failed")), \
                patch.object(build_tiles.layers, "write_meta") as write_meta, \
                patch.object(build_tiles.layers, "assemble") as assemble:
            with self.assertRaisesRegex(ValueError, "worker failed"):
                fixture.run_build("--jobs", "2")
        write_meta.assert_not_called()
        assemble.assert_not_called()
        self.assertEqual(meta.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
