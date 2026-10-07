'use client';

import { useEffect, useRef } from 'react';
import { whenIdle } from '@/lib/idle';

// Flowing silk ribbons as one full-screen fragment shader. A bundle of thin
// strands follows a shared, slowly-moving centreline; strands fan out with
// distance from a pinch point, which gives the "silk" look. Additive glow in
// the Control Room cyan → emerald range.

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uScroll;
uniform vec2 uPointer;
uniform int uStrands;
out vec4 outColor;

const vec3 CYAN = vec3(0.133, 0.827, 0.933);
const vec3 EMERALD = vec3(0.204, 0.827, 0.600);
const vec3 DEEP = vec3(0.039, 0.18, 0.22);

float centre(float x, float t) {
  return 0.42 * sin(x * 1.15 + t * 0.12 + 0.6)
       + 0.18 * sin(x * 2.4 - t * 0.09 + 1.3)
       + 0.06 * sin(x * 5.1 + t * 0.21);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime + uScroll * 2.2;
  vec2 pinch = vec2(-0.05, -0.12) + uPointer * vec2(0.10, 0.06);

  vec3 col = vec3(0.0);
  float n = float(uStrands);
  for (int i = 0; i < 64; i++) {
    if (i >= uStrands) break;
    float k = float(i) / n - 0.5;
    float dx = uv.x - pinch.x;
    float spread = (0.02 + 0.55 * dx * dx + 0.09 * abs(dx)) * (1.0 + 0.25 * sin(t * 0.3 + float(i)));
    float y = centre(uv.x, t + k * 1.7) * 0.55 + pinch.y + k * spread
            + 0.25 * dx * dx * sign(dx) ;
    float d = abs(uv.y - y);
    float w = 0.0011 + 0.0016 * (1.0 - abs(k) * 1.6);
    float glow = w / (d + 0.0025);
    glow = pow(glow, 1.35);
    float fadeX = smoothstep(-1.15, -0.35, uv.x) * (1.0 - smoothstep(0.75, 1.35, uv.x));
    vec3 tint = mix(CYAN, EMERALD, smoothstep(-0.6, 0.9, uv.x + k * 0.6));
    col += tint * glow * fadeX * 0.1;
    // Second, fainter bundle on a slower path for depth.
    float y2 = centre(uv.x * 0.8 + 1.7, t * 0.7 - k * 1.3) * 0.5 + 0.18 + k * spread * 1.6;
    float g2 = pow(w / (abs(uv.y - y2) + 0.004), 1.25);
    col += mix(EMERALD, CYAN, 0.35) * g2 * fadeX * 0.035;
  }

  // Bright core near the pinch, soft ambient haze.
  float core = 0.02 / (length((uv - pinch) * vec2(0.6, 1.4)) + 0.05);
  col += mix(CYAN, EMERALD, 0.4) * core * 0.18;
  col += DEEP * 0.35 * smoothstep(1.2, 0.0, length(uv - pinch * 0.5));

  col = col / (1.0 + col);           // soft tonemap
  col = pow(col, vec3(0.92));
  outColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) throw new Error('shader alloc failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
  }
  return s;
}

export function RibbonCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setup only touches refs; it runs once on mount by design
  useEffect(() => {
    // Compile the shader after first paint; the static glow shows meanwhile.
    let teardown: (() => void) | undefined;
    const cancel = whenIdle(() => {
      teardown = setup();
    });
    return () => {
      cancel();
      teardown?.();
    };
  }, []);

  function setup(): (() => void) | undefined {
    const canvas = ref.current;
    if (!canvas) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    // Without WebGL the static glow underneath simply stays.
    if (!gl) return;

    let prog: WebGLProgram;
    try {
      prog = gl.createProgram() as WebGLProgram;
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link failed');
    } catch {
      return;
    }
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uScroll = gl.getUniformLocation(prog, 'uScroll');
    const uPointer = gl.getUniformLocation(prog, 'uPointer');
    const uStrands = gl.getUniformLocation(prog, 'uStrands');
    gl.uniform1i(uStrands, coarse ? 22 : 44);

    // Lighter on phones; never above 1.5x device pixels.
    const dprCap = coarse ? 1 : 1.5;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Pointer and scroll are eased so the field drifts rather than jumps.
    const target = { x: 0, y: 0 };
    const eased = { x: 0, y: 0, scroll: 0 };
    const onPointer = (e: PointerEvent) => {
      target.x = (e.clientX / window.innerWidth) * 2 - 1;
      target.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    let raf = 0;
    let visible = true;
    const start = performance.now();
    const frame = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      const scroll = window.scrollY / Math.max(1, window.innerHeight);
      eased.x += (target.x - eased.x) * 0.04;
      eased.y += (target.y - eased.y) * 0.04;
      eased.scroll += (scroll - eased.scroll) * 0.08;
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform1f(uScroll, eased.scroll);
      gl.uniform2f(uPointer, eased.x, eased.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // First frame drawn: fade the ribbons in over the static glow.
      if (canvas.style.opacity !== '1') canvas.style.opacity = '1';
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    // Pause when off-screen or the tab is hidden.
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) kick();
    });
    io.observe(canvas);
    const onVis = () => !document.hidden && kick();
    document.addEventListener('visibilitychange', onVis);

    kick();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVis);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      {/* The static glow is there from the first paint; the WebGL ribbons
          fade in over it once the shader has drawn (it compiles when idle). */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 50% at 45% 60%, rgba(34,211,238,0.22), transparent 70%), radial-gradient(50% 40% at 75% 30%, rgba(52,211,153,0.16), transparent 70%), #0a0c0f',
        }}
      />
      <canvas
        ref={ref}
        className="absolute inset-0 h-full w-full opacity-0 transition-opacity duration-700"
      />
      {/* Vignette keeps text legible over the brightest strands. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_40%,transparent_40%,rgba(10,12,15,0.85))]" />
    </div>
  );
}
