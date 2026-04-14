"""Tests for app/services/log_buffer.py — ring buffer and subscriber fan-out."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.services.log_buffer import LogBuffer


class TestLogBuffer:
    """Unit tests for LogBuffer — ring size, subscriber fan-out, overflow handling."""

    @pytest.fixture
    def buf(self):
        return LogBuffer()

    # ── get_recent ─────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_get_recent_empty(self, buf):
        """Returns empty list when no logs have been pushed."""
        assert buf.get_recent() == []
        assert buf.get_recent(limit=10) == []

    @pytest.mark.asyncio
    async def test_get_recent_returns_last_n(self, buf):
        """Returns only the last N entries in chronological order."""
        for i in range(5):
            await buf._push_async(
                json.dumps({"timestamp": f"2026-01-0{i+1}T00:00:00Z", "level": "INFO", "message": f"log {i}"}),
                "INFO",
                f"log {i}",
                {},
            )

        recent = buf.get_recent(limit=3)
        assert len(recent) == 3
        assert recent[0]["message"] == "log 2"
        assert recent[2]["message"] == "log 4"

    @pytest.mark.asyncio
    async def test_get_recent_limit_respects_ring_size(self, buf):
        """Even if limit > ring size, only ring entries are returned."""
        # Push 3 entries (under the 1000 ring maxlen)
        for i in range(3):
            await buf._push_async(
                json.dumps({"timestamp": f"2026-01-0{i+1}T00:00:00Z", "level": "INFO", "message": f"log {i}"}),
                "INFO",
                f"log {i}",
                {},
            )

        # request more than we have
        recent = buf.get_recent(limit=100)
        assert len(recent) == 3

    @pytest.mark.asyncio
    async def test_ring_maxlen_1000(self, buf):
        """The ring buffer evicts oldest entries at maxlen=1000."""
        # Push 1005 entries
        for i in range(1005):
            await buf._push_async(
                json.dumps({"timestamp": f"2026-01-{(i % 31)+1:02d}T00:00:00Z", "level": "INFO", "message": f"log {i}"}),
                "INFO",
                f"log {i}",
                {},
            )

        recent = buf.get_recent(limit=2000)
        # Should have exactly 1000 entries (ring capacity)
        assert len(recent) == 1000
        # Oldest 5 should be evicted
        assert recent[0]["message"] == "log 5"
        assert recent[-1]["message"] == "log 1004"

    # ── subscribe / unsubscribe ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_subscribe_returns_id_and_queue(self, buf):
        """subscribe() returns a unique client_id and a fresh asyncio.Queue."""
        client_id, queue = await buf.subscribe()

        assert isinstance(client_id, str)
        assert isinstance(queue, asyncio.Queue)
        assert queue.maxsize == 500

    @pytest.mark.asyncio
    async def test_multiple_subscribers_get_separate_queues(self, buf):
        """Each subscribe() call gets its own queue."""
        id1, q1 = await buf.subscribe()
        id2, q2 = await buf.subscribe()

        assert id1 != id2
        assert q1 is not q2

    @pytest.mark.asyncio
    async def test_unsubscribe_returns_zero_dropped_when_empty(self, buf):
        """Unsubscribe returns 0 dropped when the queue was never full."""
        client_id, _ = await buf.subscribe()
        dropped = await buf.unsubscribe(client_id)
        assert dropped == 0

    @pytest.mark.asyncio
    async def test_unsubscribe_removes_subscriber(self, buf):
        """After unsubscribe, the client_id is no longer tracked."""
        client_id, _ = await buf.subscribe()
        await buf.unsubscribe(client_id)

        # Another subscribe should return a new id
        new_id, _ = await buf.subscribe()
        assert new_id != client_id

    # ── push_async fan-out ────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_push_fans_out_to_all_subscribers(self, buf):
        """A single push reaches all subscriber queues."""
        _, q1 = await buf.subscribe()
        _, q2 = await buf.subscribe()

        await buf._push_async(
            json.dumps({"timestamp": "2026-01-01T00:00:00Z", "level": "INFO", "message": "test fan-out"}),
            "INFO",
            "test fan-out",
            {"key": "value"},
        )

        # Both queues should have the entry
        frame1 = await asyncio.wait_for(q1.get(), timeout=1.0)
        assert frame1["type"] == "log"
        assert frame1["data"]["message"] == "test fan-out"

        frame2 = await asyncio.wait_for(q2.get(), timeout=1.0)
        assert frame2["data"]["message"] == "test fan-out"

    @pytest.mark.asyncio
    async def test_push_to_disconnected_subscriber_no_error(self, buf):
        """Pushing after a subscriber has disconnected does not raise."""
        _, q = await buf.subscribe()
        await buf.unsubscribe(q)

        # Should not raise even though queue was disconnected
        await buf._push_async(
            json.dumps({"timestamp": "2026-01-01T00:00:00Z", "level": "INFO", "message": "orphan push"}),
            "INFO",
            "orphan push",
            {},
        )

    # ── overflow / dropped ─────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_queue_overflow_drops_oldest(self, buf):
        """When a subscriber's queue is full, the oldest entry is dropped."""
        client_id, queue = await buf.subscribe()

        # Fill the queue to capacity (500 entries) — push synchronously
        # to ensure the queue never empties between pushes
        for i in range(500):
            await buf._push_async(
                json.dumps({"timestamp": f"2026-01-01T00:00:{i:02d}Z", "level": "INFO", "message": f"entry {i}"}),
                "INFO",
                f"entry {i}",
                {},
            )

        # Queue is now full (500 entries). Push one more — oldest should be dropped.
        await buf._push_async(
            json.dumps({"timestamp": "2026-01-01T01:00:00Z", "level": "INFO", "message": "overflow entry"}),
            "INFO",
            "overflow entry",
            {},
        )

        # Queue should still have exactly 500 entries (oldest was evicted, overflow added)
        assert queue.qsize() == 500

        # Drain and verify: oldest entries were evicted, newest overflow entry is present
        frames = []
        while not queue.empty():
            frames.append(queue.get_nowait())

        assert len(frames) == 500
        # First entry should be "entry 1" (entry 0 was dropped)
        assert frames[0]["data"]["message"] == "entry 1"
        # Last entry should be "overflow entry"
        assert frames[-1]["data"]["message"] == "overflow entry"

        # Unsubscribe should report exactly 1 dropped (entry 0)
        dropped = await buf.unsubscribe(client_id)
        assert dropped == 1

    # ── heartbeat ────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_heartbeat_sends_heartbeat_frame(self, buf):
        """start_heartbeat() sends a heartbeat frame every ~1 second."""
        _, queue = await buf.subscribe()
        buf.start_heartbeat()

        # Wait for at least one heartbeat (allow up to 2.5s)
        frame = await asyncio.wait_for(queue.get(), timeout=2.5)
        assert frame["type"] == "heartbeat"
        assert frame["data"] is None

        buf.stop_heartbeat()

    @pytest.mark.asyncio
    async def test_stop_heartbeat_cancels_task(self, buf):
        """stop_heartbeat() stops the heartbeat task."""
        buf.start_heartbeat()
        buf.stop_heartbeat()

        assert buf._heartbeat_task is None or buf._heartbeat_task.done()

    @pytest.mark.asyncio
    async def test_heartbeat_idempotent(self, buf):
        """Calling start_heartbeat() twice is safe (no duplicate tasks)."""
        buf.start_heartbeat()
        first_task = buf._heartbeat_task
        buf.start_heartbeat()  # idempotent call

        # Same task is reused
        assert buf._heartbeat_task is first_task
        buf.stop_heartbeat()
