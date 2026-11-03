"""Ordered sheet processing keeps only a small window of results in memory."""

import gc
import multiprocessing
import os
import unittest
import weakref
from concurrent.futures import Future
from unittest.mock import patch

import build_cache


def process_value(value):
    """Top-level function so the real process-pool check also works with spawn."""
    return os.getpid(), value * 2


class FakeFuture(Future):
    def __init__(self, executor, job):
        super().__init__()
        self.executor = executor
        self.job = job

    def result(self):
        self.executor.requested.append(self.job)
        if not self.done():
            if self.executor.mode == "reverse":
                for future in reversed(list(self.executor.pending)):
                    self.executor.complete(future)
            else:
                self.executor.complete(self)
        return super().result()

    def cancel(self):
        self.executor.cancelled.append(self.job)
        cancelled = super().cancel()
        if cancelled:
            self.executor.pending.pop(self, None)
        return cancelled


class FakeExecutor:
    """Control completion without sleeps; retain only genuinely pending futures."""

    def __init__(self, mode="immediate", fail_submit=None):
        self.mode = mode
        self.fail_submit = fail_submit
        self.pending = {}
        self.submitted = []
        self.requested = []
        self.completed = []
        self.cancelled = []
        self.refs = []
        self.max_live = 0
        self.exited = False
        self.exit_exception = None

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        self.exit_exception = kind
        # Match executor context cleanup: finish uncancelled running work.
        for future in list(self.pending):
            self.complete(future)
        self.exited = True

    def submit(self, function, job):
        if job == self.fail_submit:
            raise RuntimeError("submit failed")
        future = FakeFuture(self, job)
        self.pending[future] = function
        self.refs.append(weakref.ref(future))
        self.submitted.append(job)
        self.max_live = max(self.max_live, sum(ref() is not None for ref in self.refs))
        if self.mode == "immediate":
            self.complete(future)
        return future

    def complete(self, future):
        function = self.pending.pop(future)
        try:
            result = function(future.job)
        except Exception as error:
            future.set_exception(error)
        else:
            future.set_result(result)
        self.completed.append(future.job)

    def map(self, function, jobs):
        # The old implementation's eager map, for the regression's baseline run.
        futures = [self.submit(function, job) for job in jobs]
        futures.reverse()
        try:
            while futures:
                yield futures.pop().result()
        finally:
            for future in futures:
                future.cancel()


class ParallelMapTests(unittest.TestCase):
    def fake(self, **kwargs):
        executor = FakeExecutor(**kwargs)
        factory = self.enterContext(patch.object(build_cache, "ProcessPoolExecutor", return_value=executor))
        return executor, factory

    def test_paused_consumer_limits_submissions_and_retained_results(self):
        executor, factory = self.fake()
        results = build_cache.parallel_map(lambda job: bytearray(1024), range(100), 2)
        self.addCleanup(results.close)
        factory.assert_not_called()
        for consumed in range(1, 101):
            self.assertEqual(len(next(results)), 1024)
            self.assertLessEqual(len(executor.submitted) - consumed, 3)
            self.assertLessEqual(executor.max_live, 4)
            if consumed == 1:
                self.assertEqual(executor.submitted, [0, 1, 2, 3])
        with self.assertRaises(StopIteration):
            next(results)
        self.assertTrue(executor.exited)
        factory.assert_called_once_with(2)

    def test_reverse_completion_still_yields_input_order(self):
        executor, _ = self.fake(mode="reverse")
        self.assertEqual(list(build_cache.parallel_map(lambda job: job * 2, range(9), 2)), list(range(0, 18, 2)))
        self.assertEqual(executor.completed[:4], [3, 2, 1, 0])
        self.assertEqual(executor.requested, list(range(9)))
        self.assertTrue(executor.exited)

    def test_large_sheet_counts_keep_the_same_window_and_outputs(self):
        for count, workers in ((252, 4), (4096, 8)):
            with self.subTest(count=count, workers=workers):
                executor, _ = self.fake()
                self.assertEqual(list(build_cache.parallel_map(lambda job: job * 2, range(count), workers)),
                                 list(range(0, 2 * count, 2)))
                self.assertLessEqual(executor.max_live, 2 * workers)
                self.assertTrue(executor.exited)

    def test_serial_path_is_lazy_and_preserves_exceptions(self):
        _, factory = self.fake()
        calls = []

        def function(job):
            calls.append(job)
            if job == 1:
                raise ValueError("serial failure")
            return job

        results = build_cache.parallel_map(function, range(4), 1)
        self.assertEqual(calls, [])
        self.assertEqual(next(results), 0)
        self.assertEqual(calls, [0])
        with self.assertRaisesRegex(ValueError, "serial failure"):
            next(results)
        self.assertEqual(calls, [0, 1])
        factory.assert_not_called()

    def test_empty_and_one_job_do_not_start_processes(self):
        _, factory = self.fake()
        self.assertEqual(list(build_cache.parallel_map(process_value, [], 8)), [])
        self.assertEqual(list(build_cache.parallel_map(process_value, [3], 8)), [(os.getpid(), 6)])
        factory.assert_not_called()

    def test_exception_waits_for_its_position_and_cancels_the_rest(self):
        executor, _ = self.fake(mode="reverse")

        def function(job):
            if job == 2:
                raise ValueError("sheet failed")
            return job

        results = build_cache.parallel_map(function, range(20), 2)
        self.assertEqual(next(results), 0)
        self.assertIn(2, executor.completed)
        self.assertEqual(next(results), 1)
        with self.assertRaisesRegex(ValueError, "sheet failed"):
            next(results)
        self.assertEqual(executor.requested, [0, 1, 2])
        self.assertEqual(executor.submitted, list(range(6)))
        self.assertEqual(executor.cancelled, [3, 4, 5])
        self.assertTrue(executor.exited)
        self.assertIs(executor.exit_exception, ValueError)

    def test_close_cancels_pending_work_and_exits_pool(self):
        executor, _ = self.fake(mode="on_result")
        results = build_cache.parallel_map(lambda job: job, range(100), 2)
        self.assertEqual(next(results), 0)
        results.close()
        self.assertEqual(executor.submitted, [0, 1, 2, 3])
        self.assertEqual(executor.completed, [0])
        self.assertEqual(executor.cancelled, [1, 2, 3])
        self.assertEqual(executor.pending, {})
        self.assertTrue(executor.exited)
        self.assertIs(executor.exit_exception, GeneratorExit)

    def test_consumer_exception_can_close_the_iterator(self):
        executor, _ = self.fake(mode="on_result")
        results = build_cache.parallel_map(lambda job: job, range(100), 2)
        try:
            self.assertEqual(next(results), 0)
            with self.assertRaisesRegex(RuntimeError, "consumer failed"):
                raise RuntimeError("consumer failed")
        finally:
            results.close()
        self.assertTrue(executor.exited)
        self.assertEqual(executor.cancelled, [1, 2, 3])

    def test_submission_failure_cancels_already_submitted_work(self):
        executor, _ = self.fake(mode="on_result", fail_submit=2)
        with self.assertRaisesRegex(RuntimeError, "submit failed"):
            next(build_cache.parallel_map(lambda job: job, range(10), 2))
        self.assertEqual(executor.cancelled, [0, 1])
        self.assertTrue(executor.exited)
        self.assertIs(executor.exit_exception, RuntimeError)

    def test_consumed_future_is_released_before_consumer_resumes(self):
        executor, _ = self.fake()
        results = build_cache.parallel_map(lambda job: bytearray(1024), range(10), 2)
        self.addCleanup(results.close)
        first = next(results)
        gc.collect()
        self.assertEqual(len(first), 1024)
        self.assertIsNone(executor.refs[0]())
        self.assertEqual(sum(ref() is not None for ref in executor.refs), 3)

    def test_real_process_pool_preserves_order_and_joins_on_completion_and_close(self):
        before = {child.pid for child in multiprocessing.active_children()}
        results = list(build_cache.parallel_map(process_value, list(range(6)), 2))
        self.assertEqual([value for _, value in results], list(range(0, 12, 2)))
        self.assertTrue(all(pid != os.getpid() for pid, _ in results))
        self.assertFalse({pid for pid, _ in results} & {child.pid for child in multiprocessing.active_children()})

        iterator = build_cache.parallel_map(process_value, list(range(20)), 2)
        self.addCleanup(iterator.close)
        next(iterator)
        children = {child.pid for child in multiprocessing.active_children()} - before
        self.assertTrue(children)
        iterator.close()
        self.assertFalse(children & {child.pid for child in multiprocessing.active_children()})


if __name__ == "__main__":
    unittest.main()
