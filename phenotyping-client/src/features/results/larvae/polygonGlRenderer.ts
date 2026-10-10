// polygonGlRenderer — WebGL2 renderer for the larvae polygon overlay.
//
// Draws what the SVG overlay draws for the bulk of the polygons — the dim
// veil with a hole per polygon, the hover spotlight veil, the translucent
// fills, the 1px outlines and the centerlines — in three draw calls. The
// geometry is uploaded once per edit; a pan / zoom frame only changes the
// view uniforms, so its cost no longer grows with the number of DOM nodes.
//
// Each polygon is one instanced quad (its oriented bounding box plus the
// anti-aliasing margin). The fragment shader walks the polygon's edges and
// gets, at the pixel centre:
//   - the nonzero winding number → inside / outside, exactly like SVG's
//     default fill-rule (self-intersecting outlines included);
//   - the distance to the outline and to the centerline → analytic
//     box-filtered coverage for the fill edge, the stroke (non-scaling width,
//     round joins) and the centerline (round caps / joins).
// Polygons are composited into a transmittance buffer with multiplicative
// blending — dst *= (1 − α) — which is exactly what painting one SVG element
// after another does, so overlapping polygons stack like they did in SVG and
// the result doesn't depend on draw order. A last full-screen pass turns the
// transmittances into the final premultiplied colour.
//
// Edges are stored in chunks of CHUNK_SEGMENTS behind a bounding-box header,
// so a pixel only visits the chunks that can change its winding number (the
// box straddles its row, to its right) or its coverage (the box is within
// the anti-aliasing margin) — a few chunks out of a dozen for a larva.

type Point = readonly [number, number];
type Polyline = readonly Point[];

/** Pan / zoom, in CSS pixels: screen = image * scale + (tx, ty). */
export interface GlView {
    scale: number;
    tx: number;
    ty: number;
}

export interface GlFrame {
    view: GlView;
    imageWidth: number;
    imageHeight: number;
    /**
     * Polygon indices rendered by the SVG layer instead (selected, hovered…).
     * Their fill, outline and centerline are skipped here; they are still
     * cut out of the dim veil.
     */
    hidden: readonly number[];
    /** Dim everything outside the polygons. */
    dim: boolean;
    /** Polygon indices cut out of the hover veil; null = no hover veil. */
    spotlight: readonly number[] | null;
    centerlines: boolean;
}

// Mirrors the idle PolygonShape, the Centerlines and the dim / spotlight
// masks in LarvaePolygonEditor.
const POLYGON_RGB = [0, 1, 1] as const; // #00FFFF
const FILL_OPACITY = 0.3;
const CENTERLINE_RGB = [1, 1, 1] as const;
const CENTERLINE_OPACITY = 0.9;
const DIM_OPACITY = 0.4;
const SPOTLIGHT_OPACITY = 0.3;
/** Stroke widths in CSS pixels (non-scaling, like vector-effect). */
const OUTLINE_WIDTH = 1;
const CENTERLINE_WIDTH = 1.5;

/** Segments per chunk; a chunk is one bounding-box texel + its segments. */
const CHUNK_SEGMENTS = 8;
const CHUNK_TEXELS = CHUNK_SEGMENTS + 1;
/** Padding segment: never the nearest one, never crosses a pixel's row. */
const PAD = 1e9;

/** Floats per polygon instance. */
const INSTANCE_FLOATS = 12;
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
/** Offset of the "hidden" flag inside an instance. */
const HIDDEN_FLOAT = 10;

// Instance layout:
//   i0 = (centre.x, centre.y, axis.x, axis.y)   oriented bounding box
//   i1 = (half-length, half-width, outlineTexel, outlineChunks)
//   i2 = (centerlineTexel, centerlineChunks, hidden, 0)
const POLY_VS = `#version 300 es
in vec2 a_corner;
in vec4 a_i0;
in vec4 a_i1;
in vec4 a_i2;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec2 u_res;
uniform float u_pxPerImg;
uniform float u_pad;
out vec2 v_img;
flat out vec4 v_i1;
flat out vec4 v_i2;
void main() {
    vec2 u = a_i0.zw;
    vec2 v = vec2(-u.y, u.x);
    float m = u_pad / u_pxPerImg;
    vec2 p = a_i0.xy + u * (a_corner.x * (a_i1.x + m)) + v * (a_corner.y * (a_i1.y + m));
    v_img = p;
    v_i1 = a_i1;
    v_i2 = a_i2;
    vec2 s = p * u_scale + u_offset;
    gl_Position = vec4(s.x / u_res.x * 2.0 - 1.0, 1.0 - s.y / u_res.y * 2.0, 0.0, 1.0);
}
`;

// Output (multiplied into the transmittance buffer as dst *= 1 - src):
//   r = polygon fill + outline opacity, g = dim-mask cut-out,
//   b = centerline opacity, a = spotlight cut-out (spotlight pass only).
const POLY_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_img;
flat in vec4 v_i1;
flat in vec4 v_i2;
uniform sampler2D u_segs;
uniform int u_texW;
uniform float u_pxPerImg;
uniform float u_marginImg;
uniform float u_outlineHalf;
uniform float u_centerHalf;
uniform float u_fillOpacity;
uniform float u_centerOpacity;
uniform bool u_centerlines;
uniform bool u_spotPass;
out vec4 o;

const int CHUNK = ${CHUNK_SEGMENTS};

/** Squared distance from p to segment s.xy → s.zw. */
float segDist2(vec2 p, vec4 s) {
    vec2 ba = s.zw - s.xy;
    vec2 pa = p - s.xy;
    float bb = dot(ba, ba);
    float h = bb > 0.0 ? clamp(dot(pa, ba) / bb, 0.0, 1.0) : 0.0;
    vec2 q = pa - ba * h;
    return dot(q, q);
}

/** Whether p lies within the margin of the box (x1, y1, x2, y2). */
bool nearBox(vec2 p, vec4 box) {
    vec2 d = max(max(box.xy - p, p - box.zw), vec2(0.0));
    return dot(d, d) < u_marginImg * u_marginImg;
}

void main() {
    vec2 p = v_img;
    int start = int(v_i1.z);
    int chunks = int(v_i1.w);
    ivec2 t = ivec2(start % u_texW, start / u_texW);
    float d2 = 1e30;
    int wind = 0;
    for (int c = 0; c < chunks; c++) {
        vec4 box = texelFetch(u_segs, t, 0);
        // Only edges spanning p's row, right of p, change the winding.
        bool crosses = p.y >= box.y && p.y <= box.w && p.x <= box.z;
        if (crosses || nearBox(p, box)) {
            for (int k = 1; k <= CHUNK; k++) {
                vec4 s = texelFetch(u_segs, ivec2(t.x + k, t.y), 0);
                d2 = min(d2, segDist2(p, s));
                // Nonzero winding number (Sunday's crossing test).
                float side = (s.z - s.x) * (p.y - s.y) - (p.x - s.x) * (s.w - s.y);
                if (s.y <= p.y) {
                    if (s.w > p.y && side > 0.0) wind++;
                } else if (s.w <= p.y && side < 0.0) {
                    wind--;
                }
            }
        }
        t.x += CHUNK + 1;
        if (t.x >= u_texW) t = ivec2(0, t.y + 1);
    }
    // Box-filtered coverage from the distance to the outline (device px).
    float d = sqrt(d2) * u_pxPerImg;
    float fill = wind != 0 ? clamp(0.5 + d, 0.0, 1.0) : clamp(0.5 - d, 0.0, 1.0);
    if (u_spotPass) {
        o = vec4(0.0, 0.0, 0.0, fill);
        return;
    }
    if (v_i2.z > 0.5) {
        o = vec4(0.0, fill, 0.0, 0.0);
        return;
    }
    float stroke = clamp(u_outlineHalf + 0.5 - d, 0.0, 1.0);
    float center = 0.0;
    int clChunks = int(v_i2.y);
    if (u_centerlines && clChunks > 0) {
        start = int(v_i2.x);
        t = ivec2(start % u_texW, start / u_texW);
        float c2 = 1e30;
        for (int c = 0; c < clChunks; c++) {
            if (nearBox(p, texelFetch(u_segs, t, 0))) {
                for (int k = 1; k <= CHUNK; k++) {
                    c2 = min(c2, segDist2(p, texelFetch(u_segs, ivec2(t.x + k, t.y), 0)));
                }
            }
            t.x += CHUNK + 1;
            if (t.x >= u_texW) t = ivec2(0, t.y + 1);
        }
        center = clamp(u_centerHalf + 0.5 - sqrt(c2) * u_pxPerImg, 0.0, 1.0);
    }
    float poly = 1.0 - (1.0 - u_fillOpacity * fill) * (1.0 - stroke);
    o = vec4(poly, fill, u_centerOpacity * center, 0.0);
}
`;

const COMPOSITE_VS = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Paint order, bottom to top (as in the SVG): dim veil, spotlight veil,
// polygons, centerlines. Output is premultiplied.
const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_trans;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec2 u_res;
uniform vec2 u_image;
uniform float u_dim;
uniform float u_spot;
uniform vec3 u_polyRgb;
uniform vec3 u_centerRgb;
out vec4 o;
void main() {
    vec4 t = texelFetch(u_trans, ivec2(gl_FragCoord.xy), 0);
    // Box-filtered coverage of the image rectangle (the veils' extent).
    vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
    vec2 r0 = u_offset;
    vec2 r1 = u_image * u_scale + u_offset;
    vec2 inRect = clamp(min(px - r0, r1 - px) + 0.5, 0.0, 1.0);
    float rect = inRect.x * inRect.y;
    float dimA = u_dim * t.g * rect;
    float spotA = u_spot * t.a * rect;
    float polyA = 1.0 - t.r;
    float centerA = 1.0 - t.b;
    vec4 c = vec4(0.0, 0.0, 0.0, dimA);
    c = vec4(0.0, 0.0, 0.0, spotA) + c * (1.0 - spotA);
    c = vec4(u_polyRgb * polyA, polyA) + c * (1.0 - polyA);
    c = vec4(u_centerRgb * centerA, centerA) + c * (1.0 - centerA);
    o = c;
}
`;

interface Program {
    program: WebGLProgram;
    uniforms: Record<string, WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]) {
    const program = gl.createProgram();
    const stages = [
        [gl.VERTEX_SHADER, vs],
        [gl.FRAGMENT_SHADER, fs],
    ] as const;
    for (const [type, src] of stages) {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        return null;
    }
    const uniforms: Program['uniforms'] = {};
    for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms } satisfies Program;
}

/**
 * Oriented bounding box (principal axis of the vertices) of a polygon and
 * its centerline, written into `out` at `o` as centre, axis, half extents.
 */
function writeObb(poly: Polyline, cl: Polyline | null, out: Float32Array, o: number) {
    const n = poly.length;
    let mx = 0;
    let my = 0;
    for (let k = 0; k < n; k++) {
        mx += poly[k][0];
        my += poly[k][1];
    }
    mx /= n;
    my /= n;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let k = 0; k < n; k++) {
        const dx = poly[k][0] - mx;
        const dy = poly[k][1] - my;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    let u1 = Infinity;
    let u2 = -Infinity;
    let v1 = Infinity;
    let v2 = -Infinity;
    const extend = (pts: Polyline) => {
        for (let k = 0; k < pts.length; k++) {
            const dx = pts[k][0] - mx;
            const dy = pts[k][1] - my;
            const pu = dx * ux + dy * uy;
            const pv = dy * ux - dx * uy;
            if (pu < u1) u1 = pu;
            if (pu > u2) u2 = pu;
            if (pv < v1) v1 = pv;
            if (pv > v2) v2 = pv;
        }
    };
    extend(poly);
    if (cl) extend(cl);
    const cu = (u1 + u2) / 2;
    const cv = (v1 + v2) / 2;
    out[o] = mx + ux * cu - uy * cv;
    out[o + 1] = my + uy * cu + ux * cv;
    out[o + 2] = ux;
    out[o + 3] = uy;
    out[o + 4] = (u2 - u1) / 2;
    out[o + 5] = (v2 - v1) / 2;
}

export class PolygonGlRenderer {
    private readonly gl: WebGL2RenderingContext;
    private readonly poly: Program;
    private readonly composite: Program;
    private readonly instBuf: WebGLBuffer;
    private readonly spotBuf: WebGLBuffer;
    private readonly polyVao: WebGLVertexArrayObject;
    private readonly spotVao: WebGLVertexArrayObject;
    private readonly emptyVao: WebGLVertexArrayObject;
    private readonly segTex: WebGLTexture;
    private readonly segTexWidth: number;
    private readonly transTex: WebGLTexture;
    private readonly transFbo: WebGLFramebuffer;
    private transSize = { w: 0, h: 0 };
    private cssSize = { w: 0, h: 0 };
    /** CPU copy of the instance buffer (spotlight uploads, hidden flags). */
    private instances = new Float32Array(0);
    private count = 0;
    private hidden = new Set<number>();
    private spotKey = '';
    private spotCount = 0;
    private isLost = false;
    private onContextLost: (() => void) | null = null;

    /** Returns null when WebGL2 (or anything it needs) is unavailable. */
    static create(canvas: HTMLCanvasElement, onLost?: () => void): PolygonGlRenderer | null {
        let gl: WebGL2RenderingContext | null = null;
        try {
            gl = canvas.getContext('webgl2', {
                alpha: true,
                premultipliedAlpha: true,
                antialias: false,
                stencil: false,
                depth: false,
                preserveDrawingBuffer: false,
            });
        } catch {
            return null;
        }
        if (!gl) return null;
        const poly = compile(gl, POLY_VS, POLY_FS, [
            'u_scale',
            'u_offset',
            'u_res',
            'u_pxPerImg',
            'u_pad',
            'u_marginImg',
            'u_segs',
            'u_texW',
            'u_outlineHalf',
            'u_centerHalf',
            'u_fillOpacity',
            'u_centerOpacity',
            'u_centerlines',
            'u_spotPass',
        ]);
        const composite = compile(gl, COMPOSITE_VS, COMPOSITE_FS, [
            'u_trans',
            'u_scale',
            'u_offset',
            'u_res',
            'u_image',
            'u_dim',
            'u_spot',
            'u_polyRgb',
            'u_centerRgb',
        ]);
        if (!poly || !composite) return null;
        const renderer = new PolygonGlRenderer(gl, poly, composite);
        renderer.onContextLost = () => {
            renderer.isLost = true;
            onLost?.();
        };
        canvas.addEventListener('webglcontextlost', renderer.onContextLost);
        return renderer;
    }

    private constructor(gl: WebGL2RenderingContext, poly: Program, composite: Program) {
        this.gl = gl;
        this.poly = poly;
        this.composite = composite;
        this.instBuf = gl.createBuffer();
        this.spotBuf = gl.createBuffer();

        const cornerBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
            gl.STATIC_DRAW,
        );
        const cornerLoc = gl.getAttribLocation(poly.program, 'a_corner');
        const instLocs = ['a_i0', 'a_i1', 'a_i2'].map((n) => gl.getAttribLocation(poly.program, n));
        const makeVao = (instances: WebGLBuffer) => {
            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
            gl.enableVertexAttribArray(cornerLoc);
            gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, instances);
            instLocs.forEach((loc, k) => {
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_BYTES, k * 16);
                gl.vertexAttribDivisor(loc, 1);
            });
            return vao;
        };
        this.polyVao = makeVao(this.instBuf);
        this.spotVao = makeVao(this.spotBuf);
        this.emptyVao = gl.createVertexArray();
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // A whole number of chunks per row, so a chunk never wraps.
        const maxSize = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
        this.segTexWidth = Math.floor(maxSize / CHUNK_TEXELS) * CHUNK_TEXELS;
        this.segTex = gl.createTexture();
        this.transTex = gl.createTexture();
        for (const tex of [this.segTex, this.transTex]) {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        this.transFbo = gl.createFramebuffer();
    }

    get lost(): boolean {
        return this.isLost || this.gl.isContextLost();
    }

    /**
     * Size the drawing buffer. `cssWidth/Height` is the canvas' layout size,
     * `deviceWidth/Height` its size in device pixels.
     */
    setSize(cssWidth: number, cssHeight: number, deviceWidth: number, deviceHeight: number) {
        const gl = this.gl;
        const canvas = gl.canvas as HTMLCanvasElement;
        this.cssSize = { w: cssWidth, h: cssHeight };
        const w = Math.max(1, deviceWidth);
        const h = Math.max(1, deviceHeight);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        if (this.transSize.w === w && this.transSize.h === h) return;
        this.transSize = { w, h };
        gl.bindTexture(gl.TEXTURE_2D, this.transTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.transFbo);
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            this.transTex,
            0,
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    /** Upload the polygon set (z-order) and each polygon's centerline. */
    setScene(polygons: readonly Polyline[], centerlines: readonly (Polyline | null | undefined)[]) {
        const gl = this.gl;
        const count = polygons.length;
        const chunksFor = (segments: number) => Math.ceil(segments / CHUNK_SEGMENTS);
        let chunkTotal = 0;
        for (let i = 0; i < count; i++) {
            const n = polygons[i].length;
            if (n < 2) continue;
            chunkTotal += chunksFor(n);
            const cl = centerlines[i];
            if (cl && cl.length >= 2) chunkTotal += chunksFor(cl.length - 1);
        }
        const texW = this.segTexWidth;
        const texH = Math.max(1, Math.ceil((chunkTotal * CHUNK_TEXELS) / texW));
        const texels = new Float32Array(texW * texH * 4);
        const inst = new Float32Array(count * INSTANCE_FLOATS);
        let next = 0;
        /**
         * Pack the edges of `pts` (closing edge included when `closed`) into
         * chunks; returns the first texel.
         */
        const pack = (pts: Polyline, closed: boolean) => {
            const first = next;
            const n = pts.length;
            const segments = closed ? n : n - 1;
            for (let c = 0; c * CHUNK_SEGMENTS < segments; c++) {
                const header = next * 4;
                let x1 = Infinity;
                let y1 = Infinity;
                let x2 = -Infinity;
                let y2 = -Infinity;
                for (let k = 0; k < CHUNK_SEGMENTS; k++) {
                    const o = (next + 1 + k) * 4;
                    const idx = c * CHUNK_SEGMENTS + k;
                    if (idx >= segments) {
                        texels.fill(PAD, o, o + 4);
                        continue;
                    }
                    const a = pts[idx];
                    const b = pts[idx + 1 === n ? 0 : idx + 1];
                    texels[o] = a[0];
                    texels[o + 1] = a[1];
                    texels[o + 2] = b[0];
                    texels[o + 3] = b[1];
                    if (a[0] < x1) x1 = a[0];
                    if (b[0] < x1) x1 = b[0];
                    if (a[1] < y1) y1 = a[1];
                    if (b[1] < y1) y1 = b[1];
                    if (a[0] > x2) x2 = a[0];
                    if (b[0] > x2) x2 = b[0];
                    if (a[1] > y2) y2 = a[1];
                    if (b[1] > y2) y2 = b[1];
                }
                texels[header] = x1;
                texels[header + 1] = y1;
                texels[header + 2] = x2;
                texels[header + 3] = y2;
                next += CHUNK_TEXELS;
            }
            return first;
        };
        for (let i = 0; i < count; i++) {
            const poly = polygons[i];
            const n = poly.length;
            const o = i * INSTANCE_FLOATS;
            // Fewer than two vertices draws nothing in SVG either.
            if (n < 2) continue;
            const clRaw = centerlines[i];
            const cl = clRaw && clRaw.length >= 2 ? clRaw : null;
            writeObb(poly, cl, inst, o);
            inst[o + 6] = pack(poly, true);
            inst[o + 7] = chunksFor(n);
            if (cl) {
                inst[o + 8] = pack(cl, false);
                inst[o + 9] = chunksFor(cl.length - 1);
            }
            inst[o + HIDDEN_FLOAT] = this.hidden.has(i) ? 1 : 0;
        }

        gl.bindTexture(gl.TEXTURE_2D, this.segTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, texW, texH, 0, gl.RGBA, gl.FLOAT, texels);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
        gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.instances = inst;
        this.count = count;
        this.spotKey = '';
    }

    private syncHidden(next: readonly number[]) {
        const want = new Set(next.filter((i) => i >= 0 && i < this.count));
        const changed: number[] = [];
        for (const i of this.hidden) if (!want.has(i)) changed.push(i);
        for (const i of want) if (!this.hidden.has(i)) changed.push(i);
        this.hidden = want;
        if (changed.length === 0) return;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
        for (const i of changed) {
            const o = i * INSTANCE_FLOATS + HIDDEN_FLOAT;
            this.instances[o] = want.has(i) ? 1 : 0;
            gl.bufferSubData(gl.ARRAY_BUFFER, o * 4, this.instances, o, 1);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    private syncSpotlight(next: readonly number[] | null) {
        const ids = next ? [...new Set(next.filter((i) => i >= 0 && i < this.count))] : [];
        const key = ids.join(',');
        if (key === this.spotKey) return;
        this.spotKey = key;
        this.spotCount = ids.length;
        const data = new Float32Array(ids.length * INSTANCE_FLOATS);
        ids.forEach((i, k) => {
            const o = i * INSTANCE_FLOATS;
            data.set(this.instances.subarray(o, o + INSTANCE_FLOATS), k * INSTANCE_FLOATS);
        });
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.spotBuf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    /** Blank the canvas (no image / nothing to draw). */
    clear() {
        const gl = this.gl;
        if (this.lost) return;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    draw(frame: GlFrame) {
        const gl = this.gl;
        if (this.lost) return;
        const canvas = gl.canvas as HTMLCanvasElement;
        const W = canvas.width;
        const H = canvas.height;
        gl.viewport(0, 0, W, H);
        if (this.cssSize.w <= 0 || this.cssSize.h <= 0) return;
        this.syncHidden(frame.hidden);
        this.syncSpotlight(frame.spotlight);

        // CSS px → device px, per axis (the device box may round).
        const rx = W / this.cssSize.w;
        const ry = H / this.cssSize.h;
        const ratio = (rx + ry) / 2;
        const { scale, tx, ty } = frame.view;
        const scaleX = scale * rx;
        const scaleY = scale * ry;
        const offX = tx * rx;
        const offY = ty * ry;
        const outlineHalf = (OUTLINE_WIDTH / 2) * ratio;
        const centerHalf = (CENTERLINE_WIDTH / 2) * ratio;

        // ── Polygons → transmittance buffer ────────────────────────────────
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.transFbo);
        gl.clearColor(1, 1, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        const p = this.poly;
        gl.useProgram(p.program);
        gl.uniform2f(p.uniforms.u_scale, scaleX, scaleY);
        gl.uniform2f(p.uniforms.u_offset, offX, offY);
        gl.uniform2f(p.uniforms.u_res, W, H);
        gl.uniform1f(p.uniforms.u_pxPerImg, scale * ratio);
        const pad = Math.max(outlineHalf, centerHalf) + 1;
        gl.uniform1f(p.uniforms.u_pad, pad);
        gl.uniform1f(p.uniforms.u_marginImg, pad / (scale * ratio));
        gl.uniform1i(p.uniforms.u_texW, this.segTexWidth);
        gl.uniform1f(p.uniforms.u_outlineHalf, outlineHalf);
        gl.uniform1f(p.uniforms.u_centerHalf, centerHalf);
        gl.uniform1f(p.uniforms.u_fillOpacity, FILL_OPACITY);
        gl.uniform1f(p.uniforms.u_centerOpacity, CENTERLINE_OPACITY);
        gl.uniform1i(p.uniforms.u_centerlines, frame.centerlines ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.segTex);
        gl.uniform1i(p.uniforms.u_segs, 0);
        if (this.count > 0) {
            gl.uniform1i(p.uniforms.u_spotPass, 0);
            gl.bindVertexArray(this.polyVao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
        }
        if (frame.spotlight && this.spotCount > 0) {
            gl.uniform1i(p.uniforms.u_spotPass, 1);
            gl.bindVertexArray(this.spotVao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spotCount);
        }

        // ── Transmittance → canvas ─────────────────────────────────────────
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.BLEND);
        const c = this.composite;
        gl.useProgram(c.program);
        gl.bindTexture(gl.TEXTURE_2D, this.transTex);
        gl.uniform1i(c.uniforms.u_trans, 0);
        gl.uniform2f(c.uniforms.u_scale, scaleX, scaleY);
        gl.uniform2f(c.uniforms.u_offset, offX, offY);
        gl.uniform2f(c.uniforms.u_res, W, H);
        gl.uniform2f(c.uniforms.u_image, frame.imageWidth, frame.imageHeight);
        gl.uniform1f(c.uniforms.u_dim, frame.dim ? DIM_OPACITY : 0);
        gl.uniform1f(c.uniforms.u_spot, frame.spotlight ? SPOTLIGHT_OPACITY : 0);
        gl.uniform3f(c.uniforms.u_polyRgb, ...POLYGON_RGB);
        gl.uniform3f(c.uniforms.u_centerRgb, ...CENTERLINE_RGB);
        gl.bindVertexArray(this.emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
    }

    /** Free the GPU resources. The context itself stays with the canvas. */
    dispose() {
        const gl = this.gl;
        if (this.onContextLost) {
            gl.canvas.removeEventListener('webglcontextlost', this.onContextLost);
            this.onContextLost = null;
        }
        gl.deleteBuffer(this.instBuf);
        gl.deleteBuffer(this.spotBuf);
        gl.deleteVertexArray(this.polyVao);
        gl.deleteVertexArray(this.spotVao);
        gl.deleteVertexArray(this.emptyVao);
        gl.deleteTexture(this.segTex);
        gl.deleteTexture(this.transTex);
        gl.deleteFramebuffer(this.transFbo);
        gl.deleteProgram(this.poly.program);
        gl.deleteProgram(this.composite.program);
        this.instances = new Float32Array(0);
        this.count = 0;
    }
}
