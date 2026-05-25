"""Centerline extraction for larvae masks.

Four strategies are exposed:

1. ``hybrid_centerline`` — recommended primary. Implements the hybrid
   algorithm specified in ``tasks/backend/change.md``: medial-axis
   skeletonisation → branch pruning → 2-pass geodesic endpoint discovery →
   skeleton shortest path → arc-length resample + B-spline smoothing →
   width = ``dt * 2`` (bilinear). More robust on curved (C/U/S) larvae than
   the legacy variants; widths from ``dt * 2`` are exact perpendicular
   diameters by the medial-axis identity.

2. ``medial_axis_centerline`` — legacy primary. Same skeleton/dt as hybrid
   but no prune and no spline; orders skeleton pixels into the longest
   endpoint-to-endpoint path. Returns ``None`` if the skeleton fragments.

3. ``dijkstra_centerline`` — legacy fallback. Per-pixel cost field that
   prefers the ridge of the distance transform, scipy Dijkstra between the
   two contour-points farthest apart. Slower but resilient on noisy masks.

4. ``fallback_centerline`` — naive scan-line fallback. Always returns a
   path; never raises.

The dispatcher ``extract_centerline(mask, method=...)`` selects the primary
strategy and automatically falls back on failure. All functions operate on
the local cropped mask coordinate frame. Centerline points are float32
``(N, 2)`` in ``(x, y)`` order; widths are ``(N,)`` float32 in pixels.
"""

from __future__ import annotations

import heapq
import logging
import math
from collections import deque
from typing import Literal

import cv2
import networkx as nx
import numpy as np
from scipy.interpolate import splev, splprep
from scipy.ndimage import label
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from skimage.morphology import medial_axis

CenterlineMethod = Literal["hybrid", "legacy_dijkstra"]

logger = logging.getLogger(__name__)

# 8-connectivity neighbours used everywhere in this module.
_NEIGHBOURS: tuple[tuple[int, int], ...] = (
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (0, 1),
    (1, -1),
    (1, 0),
    (1, 1),
)


# ── Legacy: medial-axis longest path (no prune, no smoothing) ────────────────


def _bfs_farthest(
    skeleton: np.ndarray, start: tuple[int, int]
) -> tuple[tuple[int, int], dict[tuple[int, int], tuple[int, int] | None]]:
    """BFS from ``start`` over an 8-connected boolean skeleton.

    Returns the farthest reachable pixel (in BFS-hop distance) plus the
    predecessor map needed to reconstruct the path.
    """
    h, w = skeleton.shape
    parents: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
    queue: deque[tuple[int, int]] = deque([start])
    farthest = start
    while queue:
        y, x = queue.popleft()
        farthest = (y, x)
        for dy, dx in _NEIGHBOURS:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and skeleton[ny, nx]:
                node = (ny, nx)
                if node not in parents:
                    parents[node] = (y, x)
                    queue.append(node)
    return farthest, parents


def _reconstruct_path(
    parents: dict[tuple[int, int], tuple[int, int] | None],
    end: tuple[int, int],
) -> list[tuple[int, int]]:
    path: list[tuple[int, int]] = []
    cur: tuple[int, int] | None = end
    while cur is not None:
        path.append(cur)
        cur = parents[cur]
    path.reverse()
    return path


def medial_axis_centerline(
    mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Compute centerline + widths via medial-axis skeletonisation.

    Returns ``(points_xy, widths_px)`` where ``widths_px[i]`` is the local
    larva diameter at ``points_xy[i]`` (twice the distance transform), or
    ``None`` if the skeleton has more than one connected component or is
    too short to be meaningful.
    """
    if mask.size == 0:
        return None
    binary = mask > 0
    if not binary.any():
        return None

    skeleton, distance = medial_axis(binary, return_distance=True)
    if not skeleton.any():
        return None

    components, n_components = label(skeleton, structure=np.ones((3, 3), dtype=int))
    if n_components != 1:
        return None

    ys, xs = np.where(skeleton)
    if len(xs) < 5:
        return None

    start = (int(ys[0]), int(xs[0]))
    far_a, _ = _bfs_farthest(skeleton, start)
    far_b, parents = _bfs_farthest(skeleton, far_a)
    path_yx = _reconstruct_path(parents, far_b)
    if len(path_yx) < 5:
        return None

    points = np.array([(x, y) for y, x in path_yx], dtype=np.float32)
    widths = np.array([distance[y, x] * 2.0 for y, x in path_yx], dtype=np.float32)
    return points, widths


# ── Legacy: distance-ridge Dijkstra ──────────────────────────────────────────


def _farthest_contour_endpoints(
    mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Two contour points farthest apart, nudged inward toward the centroid."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    main = max(contours, key=cv2.contourArea)
    pts = main.reshape(-1, 2)
    if len(pts) < 2:
        return None

    step = max(1, len(pts) // 50)
    sampled = pts[::step]
    if len(sampled) < 2:
        return None

    diffs = sampled[:, None, :] - sampled[None, :, :]
    dists = np.sqrt((diffs * diffs).sum(axis=2))
    flat = int(np.argmax(dists))
    i, j = divmod(flat, len(sampled))
    if i == j:
        return None
    a = sampled[i].astype(np.float32)
    b = sampled[j].astype(np.float32)

    centroid = pts.mean(axis=0).astype(np.float32)
    a = a + 0.05 * (centroid - a)
    b = b + 0.05 * (centroid - b)
    h, w = mask.shape
    a = np.clip(a, [0, 0], [w - 1, h - 1])
    b = np.clip(b, [0, 0], [w - 1, h - 1])
    return a.astype(np.int32), b.astype(np.int32)


def _build_cost_field(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Cost field that is small along the distance-transform ridge."""
    dt = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    dt_norm = dt / (dt.max() + 1e-6)
    cost_dt = 1.0 / (dt_norm + 0.1)
    grad_x = cv2.Sobel(dt, cv2.CV_64F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(dt, cv2.CV_64F, 0, 1, ksize=3)
    grad_mag = np.sqrt(grad_x**2 + grad_y**2)
    grad_mag = grad_mag / (grad_mag.max() + 1e-6)
    cost = cost_dt + 0.5 * grad_mag
    cost = np.where(mask > 0, cost, 1000.0)
    return cost, dt


def _dijkstra_path(
    mask: np.ndarray,
    cost: np.ndarray,
    start: np.ndarray,
    end: np.ndarray,
) -> list[tuple[int, int]] | None:
    """Run scipy Dijkstra from ``start`` to ``end`` over an 8-connected graph."""
    h, w = cost.shape
    rows: list[int] = []
    cols: list[int] = []
    data: list[float] = []
    for y in range(h):
        for x in range(w):
            if mask[y, x] == 0:
                continue
            cur = y * w + x
            cur_cost = cost[y, x]
            for dy, dx in _NEIGHBOURS:
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] > 0:
                    weight = (cur_cost + cost[ny, nx]) / 2.0
                    if abs(dx) + abs(dy) == 2:
                        weight *= 1.414
                    rows.append(cur)
                    cols.append(ny * w + nx)
                    data.append(weight)
    if not rows:
        return None

    n = h * w
    adj = csr_matrix((data, (rows, cols)), shape=(n, n))
    start_idx = int(start[1]) * w + int(start[0])
    end_idx = int(end[1]) * w + int(end[0])
    try:
        _, predecessors = dijkstra(adj, indices=start_idx, return_predecessors=True)
    except (ValueError, np.linalg.LinAlgError):
        return None

    path: list[tuple[int, int]] = []
    cur_idx = end_idx
    visited = 0
    while cur_idx != -9999 and cur_idx != start_idx:
        y, x = divmod(int(cur_idx), w)
        path.append((x, y))
        cur_idx = int(predecessors[cur_idx])
        visited += 1
        if visited > n:
            return None
    if cur_idx != start_idx:
        return None
    sy, sx = divmod(start_idx, w)
    path.append((sx, sy))
    path.reverse()
    return path


def dijkstra_centerline(
    mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Distance-ridge shortest path centerline. Slow but resilient."""
    if mask.size == 0 or not (mask > 0).any():
        return None
    endpoints = _farthest_contour_endpoints(mask)
    if endpoints is None:
        return None
    start, end = endpoints
    cost, dt = _build_cost_field(mask)
    path = _dijkstra_path(mask, cost, start, end)
    if path is None or len(path) < 5:
        return None

    points = np.array(path, dtype=np.float32)
    h, w = dt.shape
    widths = np.empty(len(points), dtype=np.float32)
    for i, (x, y) in enumerate(points):
        ix, iy = int(x), int(y)
        if 0 <= ix < w and 0 <= iy < h:
            widths[i] = float(dt[iy, ix]) * 2.0
        else:
            widths[i] = 1.0
    return points, widths


# ── Hybrid: skeleton + geodesic endpoints + B-spline (change.md) ─────────────


def _skeleton_to_graph(skel: np.ndarray, dt: np.ndarray) -> nx.Graph:
    """Build an 8-connectivity graph over skeleton pixels.

    Each node key is ``(y, x)``. Edge weights are Euclidean step length
    (1.0 for orthogonal, sqrt(2) for diagonal). Distance-transform values
    are stored as a node attribute for fast lookup later.
    """
    g = nx.Graph()
    ys, xs = np.where(skel)
    h, w = skel.shape
    for y, x in zip(ys, xs):
        g.add_node((int(y), int(x)), dt=float(dt[y, x]))
    for y, x in zip(ys, xs):
        for dy, dx in _NEIGHBOURS:
            ny, nx_ = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx_ < w and skel[ny, nx_]:
                weight = math.sqrt(dy * dy + dx * dx)
                g.add_edge((int(y), int(x)), (int(ny), int(nx_)), weight=weight)
    return g


def _trace_branch_to_junction(
    g: nx.Graph, endpoint: tuple[int, int]
) -> tuple[list[tuple[int, int]], float]:
    """Walk from ``endpoint`` along internal (deg==2) nodes until hitting a
    junction or another endpoint. Returns the branch's nodes (excluding the
    terminal junction/endpoint) and its total length.
    """
    branch_nodes: list[tuple[int, int]] = [endpoint]
    branch_length = 0.0
    prev: tuple[int, int] | None = None
    cur = endpoint
    while True:
        neighbors = [n for n in g.neighbors(cur) if n != prev]
        if len(neighbors) == 0:
            break
        if len(neighbors) > 1:
            # cur itself is a junction — happens only on first step from a
            # degree-1 endpoint that already neighbours a junction.
            break
        nxt = neighbors[0]
        branch_length += g[cur][nxt]["weight"]
        if g.degree(nxt) != 2:
            # nxt is a junction or another endpoint — stop without including it.
            break
        branch_nodes.append(nxt)
        prev = cur
        cur = nxt
    return branch_nodes, branch_length


def _prune_short_branches(g: nx.Graph, min_branch_ratio: float) -> nx.Graph:
    """Iteratively remove short side branches (prolegs / boundary noise).

    A branch is "short" when its length is less than ``min_branch_ratio``
    times the total skeleton length. Iterates until no short branch remains
    or the graph is already a simple two-endpoint path.
    """
    g = g.copy()
    while True:
        endpoints = [n for n in g.nodes if g.degree(n) == 1]
        if len(endpoints) <= 2:
            break
        total_length = sum(d["weight"] for _, _, d in g.edges(data=True))
        if total_length <= 0:
            break
        threshold = min_branch_ratio * total_length

        removed_any = False
        for ep in list(endpoints):
            if ep not in g:
                continue
            branch_nodes, branch_length = _trace_branch_to_junction(g, ep)
            if branch_length < threshold:
                g.remove_nodes_from(branch_nodes)
                removed_any = True
        if not removed_any:
            break
    return g


def _geodesic_distance_map(
    mask: np.ndarray, seed_yx: tuple[int, int]
) -> np.ndarray:
    """8-connected weighted Dijkstra from ``seed_yx`` over ``mask``.

    Returns a float32 distance map; pixels outside the mask are ``+inf``.
    """
    h, w = mask.shape
    dist = np.full((h, w), np.inf, dtype=np.float32)
    sy, sx = seed_yx
    if not (0 <= sy < h and 0 <= sx < w) or not mask[sy, sx]:
        return dist
    dist[sy, sx] = 0.0
    heap: list[tuple[float, int, int]] = [(0.0, sy, sx)]
    while heap:
        d, y, x = heapq.heappop(heap)
        if d > dist[y, x]:
            continue
        for dy, dx in _NEIGHBOURS:
            ny, nx_ = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx_ < w and mask[ny, nx_]:
                step = math.sqrt(dy * dy + dx * dx)
                nd = d + step
                if nd < dist[ny, nx_]:
                    dist[ny, nx_] = nd
                    heapq.heappush(heap, (nd, ny, nx_))
    return dist


def _find_endpoints_geodesic(
    mask: np.ndarray,
) -> tuple[tuple[int, int], tuple[int, int]] | None:
    """2-pass weighted-BFS endpoints: arbitrary → far_a → far_b.

    Geodesic (in-mask) distance — robust on C/U/S poses where Euclidean
    would falsely call the two ends "close".
    """
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return None
    seed = (int(ys[0]), int(xs[0]))

    d1 = _geodesic_distance_map(mask, seed)
    if not np.isfinite(d1).any():
        return None
    d1_finite = np.where(np.isfinite(d1), d1, -1.0)
    ep_a = np.unravel_index(int(np.argmax(d1_finite)), d1.shape)

    d2 = _geodesic_distance_map(mask, (int(ep_a[0]), int(ep_a[1])))
    if not np.isfinite(d2).any():
        return None
    d2_finite = np.where(np.isfinite(d2), d2, -1.0)
    ep_b = np.unravel_index(int(np.argmax(d2_finite)), d2.shape)
    return (int(ep_a[0]), int(ep_a[1])), (int(ep_b[0]), int(ep_b[1]))


def _snap_to_skeleton(
    point: tuple[int, int], skel: np.ndarray
) -> tuple[int, int]:
    """Nearest skeleton pixel to ``point`` (Euclidean)."""
    ys, xs = np.where(skel)
    if len(ys) == 0:
        return point
    dy = ys - point[0]
    dx = xs - point[1]
    idx = int(np.argmin(dy * dy + dx * dx))
    return (int(ys[idx]), int(xs[idx]))


def _longest_path_in_tree(g: nx.Graph) -> list[tuple[int, int]]:
    """Tree-diameter via two Dijkstra passes. Requires ``g`` to be a tree."""
    if g.number_of_nodes() == 0:
        return []
    start = next(iter(g.nodes))
    distances = nx.single_source_dijkstra_path_length(g, start, weight="weight")
    far_a = max(distances, key=distances.get)
    distances = nx.single_source_dijkstra_path_length(g, far_a, weight="weight")
    far_b = max(distances, key=distances.get)
    return nx.shortest_path(g, source=far_a, target=far_b, weight="weight")


def _find_centerline_path(
    g: nx.Graph, ep_a: tuple[int, int], ep_b: tuple[int, int]
) -> list[tuple[int, int]]:
    """Shortest path on skeleton from ``ep_a`` to ``ep_b``.

    Falls back to the tree-diameter longest path if the endpoints are not
    co-connected (e.g. they fell into different components after pruning).
    Drops cycles via MST first to keep the longest-path step polynomial.
    """
    if not nx.is_tree(g):
        g = nx.minimum_spanning_tree(g, weight="weight")
    if ep_a in g and ep_b in g:
        try:
            return nx.shortest_path(g, source=ep_a, target=ep_b, weight="weight")
        except nx.NetworkXNoPath:
            pass
    return _longest_path_in_tree(g)


def _resample_path(
    path_yx: list[tuple[int, int]], n_points: int
) -> np.ndarray:
    """Arc-length resample. Returns ``(n_points, 2)`` float64 in (x, y)."""
    pts = np.array([(x, y) for y, x in path_yx], dtype=np.float64)
    if len(pts) < 2:
        return pts
    deltas = np.diff(pts, axis=0)
    seg_lengths = np.sqrt((deltas**2).sum(axis=1))
    cumlen = np.concatenate([[0.0], np.cumsum(seg_lengths)])
    total_len = float(cumlen[-1])
    if total_len <= 0:
        return pts
    target_lens = np.linspace(0.0, total_len, n_points)
    resampled = np.empty((n_points, 2), dtype=np.float64)
    resampled[:, 0] = np.interp(target_lens, cumlen, pts[:, 0])
    resampled[:, 1] = np.interp(target_lens, cumlen, pts[:, 1])
    return resampled


def _smooth_centerline_spline(
    path_xy: np.ndarray,
    smoothness: float | None,
    n_output: int,
) -> np.ndarray:
    """Parametric cubic B-spline through ``path_xy``.

    Falls through to the input unchanged when scipy can't fit (too few
    distinct points, duplicate parameterisation, etc.).
    """
    if len(path_xy) < 4:
        return path_xy
    x = path_xy[:, 0]
    y = path_xy[:, 1]
    # Drop consecutive duplicates — splprep raises on zero-length segments.
    keep = np.concatenate(([True], (np.diff(x) != 0) | (np.diff(y) != 0)))
    x = x[keep]
    y = y[keep]
    if len(x) < 4:
        return path_xy
    s = float(len(x)) if smoothness is None else float(smoothness)
    try:
        tck, _u = splprep([x, y], s=s, k=3)
        u_fine = np.linspace(0.0, 1.0, n_output)
        x_fit, y_fit = splev(u_fine, tck)
    except (TypeError, ValueError):
        return path_xy
    return np.column_stack([np.asarray(x_fit), np.asarray(y_fit)])


def _measure_widths_from_dt(
    path_xy: np.ndarray, dt: np.ndarray
) -> np.ndarray:
    """Bilinear-interpolated ``dt * 2`` along the path."""
    h, w = dt.shape
    xs = np.clip(path_xy[:, 0], 0, w - 1)
    ys = np.clip(path_xy[:, 1], 0, h - 1)
    x0 = np.floor(xs).astype(np.int64)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y0 = np.floor(ys).astype(np.int64)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = xs - x0
    fy = ys - y0
    dt_interp = (
        dt[y0, x0] * (1.0 - fx) * (1.0 - fy)
        + dt[y0, x1] * fx * (1.0 - fy)
        + dt[y1, x0] * (1.0 - fx) * fy
        + dt[y1, x1] * fx * fy
    )
    return (dt_interp * 2.0).astype(np.float32)


def hybrid_centerline(
    mask: np.ndarray,
    *,
    n_output_points: int = 100,
    min_branch_ratio: float = 0.15,
    smoothness: float | None = None,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Skeleton + 2-pass geodesic + B-spline centerline (change.md spec).

    Returns ``(points_xy, widths_px)`` or ``None`` when the mask is too
    degenerate even for the hybrid algorithm — the caller should fall back
    to ``dijkstra_centerline`` then ``fallback_centerline``.
    """
    if mask.size == 0:
        return None
    binary = mask > 0
    if int(binary.sum()) < 20:
        return None

    skel, dt = medial_axis(binary, return_distance=True)
    if int(skel.sum()) < 2:
        return None

    g = _skeleton_to_graph(skel, dt)
    g = _prune_short_branches(g, min_branch_ratio=min_branch_ratio)
    if g.number_of_nodes() < 2:
        return None

    endpoints = _find_endpoints_geodesic(binary)
    if endpoints is None:
        return None
    ep_a, ep_b = endpoints

    skel_pruned = np.zeros_like(skel)
    for (y, x) in g.nodes:
        skel_pruned[y, x] = True
    if not skel_pruned.any():
        return None

    ep_a_skel = _snap_to_skeleton(ep_a, skel_pruned)
    ep_b_skel = _snap_to_skeleton(ep_b, skel_pruned)

    try:
        path_yx = _find_centerline_path(g, ep_a_skel, ep_b_skel)
    except (nx.NetworkXError, nx.NodeNotFound, ValueError):
        return None
    if len(path_yx) < 5:
        return None

    path_xy = _resample_path(path_yx, n_points=n_output_points)
    path_xy = _smooth_centerline_spline(
        path_xy, smoothness=smoothness, n_output=n_output_points
    )
    widths = _measure_widths_from_dt(path_xy, dt)
    return path_xy.astype(np.float32), widths


# ── Naive fallback ───────────────────────────────────────────────────────────


def fallback_centerline(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Naive scan-line centerline. Always returns something on a non-empty mask."""
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return (
            np.zeros((0, 2), dtype=np.float32),
            np.zeros((0,), dtype=np.float32),
        )
    x_span = float(np.ptp(xs))
    y_span = float(np.ptp(ys))
    points: list[tuple[float, float]] = []
    widths: list[float] = []
    if x_span >= y_span:
        for col in range(int(xs.min()), int(xs.max()) + 1):
            ys_col = np.where(mask[:, col] > 0)[0]
            if len(ys_col) == 0:
                continue
            cy = (float(ys_col.min()) + float(ys_col.max())) / 2.0
            width = float(ys_col.max() - ys_col.min())
            points.append((float(col), cy))
            widths.append(width)
    else:
        for row in range(int(ys.min()), int(ys.max()) + 1):
            xs_row = np.where(mask[row, :] > 0)[0]
            if len(xs_row) == 0:
                continue
            cx = (float(xs_row.min()) + float(xs_row.max())) / 2.0
            width = float(xs_row.max() - xs_row.min())
            points.append((cx, float(row)))
            widths.append(width)
    return (
        np.array(points, dtype=np.float32),
        np.array(widths, dtype=np.float32),
    )


# ── Dispatcher ───────────────────────────────────────────────────────────────


def extract_centerline(
    mask: np.ndarray,
    *,
    method: CenterlineMethod = "hybrid",
    n_output_points: int = 100,
    min_branch_ratio: float = 0.15,
    smoothness: float | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Pick a centerline strategy by ``method`` and fall back on failure.

    ``hybrid`` (default): hybrid → dijkstra → naive scan-line.
    ``legacy_dijkstra``: medial-axis longest path → dijkstra → naive.

    Always returns a result. The result may have zero rows when the mask
    is empty.
    """
    if method == "hybrid":
        primary = hybrid_centerline(
            mask,
            n_output_points=n_output_points,
            min_branch_ratio=min_branch_ratio,
            smoothness=smoothness,
        )
        if primary is not None:
            return primary
        secondary = dijkstra_centerline(mask)
        if secondary is not None:
            logger.debug("centerline fallback: hybrid → dijkstra")
            return secondary
        logger.debug("centerline fallback: hybrid → dijkstra → naive scan-line")
        return fallback_centerline(mask)

    # legacy_dijkstra
    primary = medial_axis_centerline(mask)
    if primary is not None:
        return primary
    secondary = dijkstra_centerline(mask)
    if secondary is not None:
        logger.debug("centerline fallback: medial-axis → dijkstra")
        return secondary
    logger.debug("centerline fallback: medial-axis → dijkstra → naive scan-line")
    return fallback_centerline(mask)
