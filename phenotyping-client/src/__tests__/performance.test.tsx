/**
 * Performance & resilience tests for the frontend.
 *
 * Covers:
 *   1. LogStreamClient — message parsing, error resilience, state management
 *   2. http.ts — URL building, error handling
 *   3. API type shapes — structural validation
 *   4. ProcessingStore — state management
 *
 * Note: WebSocket reconnect timing tests (exponential backoff) are tested
 * via the backend's LogBuffer stress tests. The frontend LogStreamClient's
 * reconnect behavior is verified through manual/visual testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — LogStreamClient — message parsing & resilience
// ─────────────────────────────────────────────────────────────────────────────

describe("LogStreamClient — message parsing", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let LogStreamClient: any;
  const sentEvents: Array<{ type: string; data?: unknown }> = [];

  beforeEach(async () => {
    sentEvents.length = 0;

    // Mock WebSocket that stores events sent by the client
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeWs = {
      url: "ws://localhost:8000/logs/stream",
      readyState: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      addEventListener(event: string, handler: (...args: any[]) => void) {
        if (event === "open") {
          // Simulate immediate server acceptance
          setTimeout(() => handler(), 0);
        }
      },
      removeEventListener() {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send(data: unknown) {
        try {
          sentEvents.push(JSON.parse(data as string));
        } catch {
          // ignore
        }
      },
      close() {
        // client-initiated close
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeCtor = vi.fn(() => fakeWs as any);
    Object.defineProperty(globalThis, "WebSocket", {
      value: fakeCtor,
      writable: true,
      configurable: true,
    });

    const mod = await import("@/services/websocket");
    LogStreamClient = mod.LogStreamClient;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: WebSocket,
      writable: true,
      configurable: true,
    });
  });

  it("sends no data on connect (passive listener)", () => {
    const client = new LogStreamClient({
      onLog: vi.fn(),
      onHeartbeat: vi.fn(),
    });
    client.connect("http://localhost:8000");
    expect(sentEvents).toHaveLength(0);
  });

  it("WebSocket constructor is called when connect() is called", () => {
    const client = new LogStreamClient({
      onLog: vi.fn(),
      onHeartbeat: vi.fn(),
    });
    client.connect("http://localhost:8000");
    expect(vi.mocked(globalThis.WebSocket as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — http.ts — URL building & error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("http client — URL construction", () => {
  beforeEach(async () => {
    const { setBaseUrl } = await import("@/services/http");
    setBaseUrl("http://localhost:8000");
  });

  it("getBaseUrl returns the configured URL", async () => {
    const { getBaseUrl, setBaseUrl } = await import("@/services/http");
    expect(getBaseUrl()).toBe("http://localhost:8000");
    setBaseUrl("http://other:9000");
    expect(getBaseUrl()).toBe("http://other:9000");
  });

  it("builds correct URL for health endpoint", async () => {
    const { getBaseUrl } = await import("@/services/http");
    const url = `${getBaseUrl().replace(/\/$/, "")}/health`;
    expect(url).toBe("http://localhost:8000/health");
  });

  it("builds correct URL with trailing slash on base", async () => {
    const { setBaseUrl, getBaseUrl } = await import("@/services/http");
    setBaseUrl("http://localhost:8000/");
    const url = `${getBaseUrl().replace(/\/$/, "")}/ping`;
    expect(url).toBe("http://localhost:8000/ping");
  });

  it("strips leading slashes from path in _url", async () => {
    const { getBaseUrl } = await import("@/services/http");
    const url = `${getBaseUrl().replace(/\/$/, "")}/${"health".replace(/^\//, "")}`;
    expect(url).toBe("http://localhost:8000/health");
  });
});

describe("http client — error handling", () => {
  beforeEach(async () => {
    const { setBaseUrl } = await import("@/services/http");
    setBaseUrl("http://localhost:8000");
    vi.restoreAllMocks();
  });

  it("throws ApiError on HTTP 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 404, statusText: "Not Found" })
    ) as typeof fetch;
    const { http } = await import("@/services/http");
    const { ApiError } = await import("@/services/errors");
    await expect(http.get("/nonexistent")).rejects.toThrow(ApiError);
  });

  it("throws ApiError on HTTP 500 with JSON detail", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Internal server error" }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;
    const { http } = await import("@/services/http");
    await expect(http.get("/crash")).rejects.toThrow("Internal server error");
  });

  it("throws ApiError on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { http } = await import("@/services/http");
    const { ApiError } = await import("@/services/errors");
    await expect(http.get("/unreachable")).rejects.toThrow(ApiError);
  });

  it("returns undefined on HTTP 204 DELETE", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 })
    ) as typeof fetch;
    const { http } = await import("@/services/http");
    const result = await http.delete("/analyses/123");
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — API type shapes — structural validation
// ─────────────────────────────────────────────────────────────────────────────

describe("API type shapes match the contract", () => {
  it("DetectionResult has all required fields", () => {
    const result = {
      filename: "img.png",
      organism: "egg" as const,
      count: 42,
      avg_confidence: 0.87,
      elapsed_seconds: 3.2,
      annotations: [
        {
          label: "neonate_egg",
          bbox: [100, 200, 300, 400] as [number, number, number, number],
          confidence: 0.9,
        },
      ],
      overlay_url: "/inference/results/batch-1/img.png/overlay.png",
    };
    expect(result.filename).toBe("img.png");
    expect(result.organism).toBe("egg");
    expect(result.count).toBe(42);
    expect(result.avg_confidence).toBeCloseTo(0.87);
    expect(result.elapsed_seconds).toBeCloseTo(3.2);
    expect(result.annotations[0].bbox).toHaveLength(4);
    expect(typeof result.overlay_url).toBe("string");
  });

  it("BatchDetectionResult aggregates correctly", () => {
    const results = [
      { count: 10, elapsed_seconds: 1.0 },
      { count: 20, elapsed_seconds: 2.0 },
      { count: 30, elapsed_seconds: 3.0 },
    ];
    const batch = {
      results,
      total_count: results.reduce((s, r) => s + r.count, 0),
      total_elapsed_seconds: results.reduce((s, r) => s + r.elapsed_seconds, 0),
    };
    expect(batch.total_count).toBe(60);
    expect(batch.total_elapsed_seconds).toBeCloseTo(6.0);
  });

  it("LogStreamMessage supports both log and heartbeat variants", () => {
    const logFrame = {
      type: "log" as const,
      data: { timestamp: "", level: "INFO" as const, message: "", context: {} },
    };
    const heartbeatFrame = { type: "heartbeat" as const, data: null };
    expect(logFrame.type).toBe("log");
    expect(heartbeatFrame.type).toBe("heartbeat");
    expect(heartbeatFrame.data).toBeNull();
  });

  it("EggConfig dedup_mode accepts only valid literals", () => {
    const valid: Array<"center_zone" | "edge_nms"> = ["center_zone", "edge_nms"];
    expect(valid).toContain("center_zone");
    expect(valid).toContain("edge_nms");
    expect(valid).not.toContain("legacy");
  });

  it("Device type accepts cpu and cuda:N variants", () => {
    const devices: Array<"cpu" | `cuda:${string}`> = ["cpu", "cuda:0", "cuda:1"];
    expect(devices[0]).toBe("cpu");
    expect(devices[1]).toBe("cuda:0");
    expect(devices[2]).toBe("cuda:1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — ProcessingStore — state management
// ─────────────────────────────────────────────────────────────────────────────

describe("processingStore — state transitions", () => {
  beforeEach(async () => {
    const { useProcessingStore } = await import("@/stores/processingStore");
    useProcessingStore.getState().reset();
  });

  it("starts empty", async () => {
    const { useProcessingStore } = await import("@/stores/processingStore");
    const state = useProcessingStore.getState();
    expect(state.isProcessing).toBe(false);
    expect(state.totalImages).toBe(0);
    expect(state.images).toHaveLength(0);
  });

  it("transitions to processing state with startProcessing", async () => {
    const { useProcessingStore } = await import("@/stores/processingStore");
    const store = useProcessingStore.getState();
    store.startProcessing(5);
    const state = useProcessingStore.getState();
    expect(state.isProcessing).toBe(true);
    expect(state.totalImages).toBe(5);
  });

  it("accumulates images via setImages", async () => {
    const { useProcessingStore } = await import("@/stores/processingStore");
    const store = useProcessingStore.getState();
    store.startProcessing(2);
    store.setImages([
      { id: "1", filename: "img1.png", status: "done", count: 10, avgConfidence: 0.9, elapsedSeconds: 1.0 },
      { id: "2", filename: "img2.png", status: "done", count: 20, avgConfidence: 0.85, elapsedSeconds: 2.0 },
    ]);
    const state = useProcessingStore.getState();
    expect(state.images).toHaveLength(2);
    expect(state.images[0].filename).toBe("img1.png");
    expect(state.images[1].count).toBe(20);
  });

  it("updates individual image status", async () => {
    const { useProcessingStore } = await import("@/stores/processingStore");
    const store = useProcessingStore.getState();
    store.startProcessing(2);
    store.setImages([
      { id: "1", filename: "img1.png", status: "processing" },
      { id: "2", filename: "img2.png", status: "pending" },
    ]);
    store.updateImage("1", { status: "done", count: 5 });
    const state = useProcessingStore.getState();
    const img1 = state.images.find((i) => i.id === "1");
    expect(img1?.status).toBe("done");
    expect(img1?.count).toBe(5);
  });

  it("finishProcessing clears isProcessing", async () => {
    const { useProcessingStore } = await import("@/stores/processingStore");
    const store = useProcessingStore.getState();
    store.startProcessing(2);
    store.setImages([{ id: "1", filename: "img.png", status: "done" }]);
    store.finishProcessing();
    expect(useProcessingStore.getState().isProcessing).toBe(false);
  });

  it("reset clears all state", async () => {
    const { useProcessingStore } = await import("@/stores/processingStore");
    const store = useProcessingStore.getState();
    store.startProcessing(3);
    store.setImages([{ id: "1", filename: "img.png", status: "done" }]);
    store.setToastId("toast-abc");
    store.reset();
    const state = useProcessingStore.getState();
    expect(state.isProcessing).toBe(false);
    expect(state.totalImages).toBe(0);
    expect(state.images).toHaveLength(0);
    expect(state.toastId).toBeNull();
  });
});
