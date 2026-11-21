// WebGL2 renderer: Milky Way background, catalogue stars and the user's photos.
// Everything is drawn through the same `Projection`, so the live view and the poster export share code.

import { bvColor, vec, frameOf, mulMV, wrapPi } from './math.js';

const PROJECT_GLSL = `
uniform mat3 uMat;      // equatorial -> view frame (row vectors in columns, see setProj)
uniform int uMode;      // 0 stereographic, 1 plate carree
uniform float uScale;   // pixels per radian at the centre
uniform vec2 uRes;
uniform vec2 uLL0;      // plate carree centre (lon, lat)
uniform float uLonRef;  // keep longitudes continuous around this offset
uniform float uLonAdd;  // +-2pi copy for shapes that straddle the map edge
vec4 projectDir(vec3 v) {
  vec3 c = uMat * v;
  vec2 p;
  if (uMode == 0) {
    if (c.z < -0.8) return vec4(2.0, 2.0, 2.0, 1.0);
    p = c.xy * (2.0 / (1.0 + c.z)) * uScale;
  } else {
    float lon = atan(c.y, c.x) - uLL0.x;
    lon -= 6.283185307179586 * floor((lon - uLonRef + 3.141592653589793) / 6.283185307179586);
    p = vec2(-(lon + uLonAdd), asin(clamp(c.z, -1.0, 1.0)) - uLL0.y) * uScale;
  }
  return vec4(p * 2.0 / uRes, 0.0, 1.0);
}`;

const BG_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const BG_FS = `#version 300 es
precision highp float;
uniform mat3 uMat; uniform int uMode; uniform float uScale; uniform vec2 uRes; uniform vec2 uLL0;
uniform sampler2D uTex; uniform float uGain; uniform float uBlur;
out vec4 o;
void main() {
  vec2 p = (gl_FragCoord.xy - uRes * 0.5) / uScale;
  vec3 c;
  if (uMode == 0) {
    float r2 = dot(p, p), z = (4.0 - r2) / (4.0 + r2);
    c = vec3(p * (1.0 + z) * 0.5, z);
  } else {
    float lon = -p.x + uLL0.x, lat = p.y + uLL0.y;
    if (abs(lat) > 1.5707963 || abs(p.x) > 3.14159266) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    c = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  }
  vec3 v = c * uMat;                       // transpose(uMat) * c : view frame -> equatorial
  vec2 uv = vec2(0.5 - atan(v.y, v.x) / 6.283185307179586, 0.5 - asin(clamp(v.z, -1.0, 1.0)) / 3.141592653589793);
  // The RA seam makes one of these two parameterisations discontinuous; take gradients from the smooth one.
  vec2 uvB = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
  vec2 dxA = dFdx(uv), dyA = dFdy(uv), dxB = dFdx(uvB), dyB = dFdy(uvB);
  bool b = dot(dxA, dxA) + dot(dyA, dyA) > dot(dxB, dxB) + dot(dyB, dyB);
  vec2 gx = b ? dxB : dxA, gy = b ? dyB : dyA;
  // Zoomed far in, the map's own grain would show as blocks: never sample finer than uBlur (in uv).
  float g = max(length(gx), length(gy));
  if (g < uBlur) { gx *= uBlur / max(g, 1e-9); gy *= uBlur / max(g, 1e-9); }
  vec3 col = textureGrad(uTex, uv, gx, gy).rgb * uGain;
  o = vec4(col, 1.0);
}`;

const STAR_VS = `#version 300 es
precision highp float;
${PROJECT_GLSL}
in vec3 aPos; in float aMag; in vec3 aCol;
uniform float uLimMag; uniform float uPx;
out vec3 vCol; out float vA;
void main() {
  gl_Position = projectDir(aPos);
  float b = uLimMag - aMag;
  gl_PointSize = uPx * clamp(1.6 + 1.05 * b, 1.6, 15.0);
  vA = clamp(0.25 + b * 0.9, 0.0, 1.0);
  vCol = aCol;
}`;

const STAR_FS = `#version 300 es
precision highp float;
in vec3 vCol; in float vA; out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float core = exp(-d * d * 9.0), halo = exp(-d * d * 2.2) * 0.35;
  o = vec4(mix(vCol, vec3(1.0), core * 0.7) * (core + halo) * vA, 0.0);
}`;

const PHOTO_VS = `#version 300 es
precision highp float;
${PROJECT_GLSL}
in vec2 aUV;
uniform vec3 uC, uRight, uUp; uniform vec2 uHalf;
out vec2 vUV;
void main() {
  vec2 q = vec2(aUV.x - 0.5, 0.5 - aUV.y) * 2.0 * uHalf;
  gl_Position = projectDir(normalize(uC + uRight * q.x + uUp * q.y));
  vUV = aUV;
}`;

const PHOTO_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform float uOpacity, uFeather, uAspect, uMelt;
in vec2 vUV; out vec4 o;
void main() {
  vec3 t = texture(uTex, vUV).rgb;
  vec2 e = min(vUV, 1.0 - vUV) * vec2(uAspect, 1.0);
  float a = uOpacity * (uFeather > 0.0 ? smoothstep(0.0, uFeather, min(e.x, e.y)) : 1.0);
  // "Melt": let the photo's dark sky background fall away so only its light is added.
  float l = dot(t, vec3(0.299, 0.587, 0.114));
  a *= mix(1.0, smoothstep(0.02, 0.22, l), uMelt);
  o = vec4(t * a, a);
}`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) + '\n' + src);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    u[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, u };
}

const GRID = 24; // photo mesh subdivisions

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.bg = compile(gl, BG_VS, BG_FS);
    this.star = compile(gl, STAR_VS, STAR_FS);
    this.photo = compile(gl, PHOTO_VS, PHOTO_FS);

    this.quad = gl.createVertexArray();
    gl.bindVertexArray(this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const qloc = gl.getAttribLocation(this.bg.prog, 'aPos');
    gl.enableVertexAttribArray(qloc);
    gl.vertexAttribPointer(qloc, 2, gl.FLOAT, false, 0, 0);

    // Photo mesh: a GRID x GRID sheet of UVs.
    const uv = [], idx = [];
    for (let j = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++) uv.push(i / GRID, j / GRID);
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const a = j * (GRID + 1) + i, b = a + 1, c = a + GRID + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    this.mesh = gl.createVertexArray();
    gl.bindVertexArray(this.mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.photo.prog, 'aUV');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    this.meshCount = idx.length;
    gl.bindVertexArray(null);

    this.bgTex = this.#texture(new Uint8Array([4, 4, 6, 255]), 1, 1, true);
    this.bgReady = false;
    this.photoTex = new Map(); // photo id -> { tex, w, h }
    this.starCount = 0;
    this.starMags = null;
  }

  #texture(source, w, h, repeat) {
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (source instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return tex;
  }

  /** Equirectangular J2000 map, RA increasing to the left, RA 0h in the middle. */
  setBackground(image) {
    const old = this.bgTex;
    this.bgTex = this.#texture(image, 0, 0, true);
    this.gl.deleteTexture(old);
    this.bgReady = true;
  }

  /** data: Float32Array of [ra, dec, mag, bv] rows sorted by magnitude. */
  setStars(data) {
    const gl = this.gl, n = data.length / 4, buf = new Float32Array(n * 7);
    this.starMags = new Float32Array(n);
    this.starVecs = new Float32Array(n * 3); // unit vectors, same order: used for the alignment rings
    for (let i = 0; i < n; i++) {
      const v = vec(data[i * 4], data[i * 4 + 1]), c = bvColor(data[i * 4 + 3]);
      buf.set([v[0], v[1], v[2], data[i * 4 + 2], c[0], c[1], c[2]], i * 7);
      this.starMags[i] = data[i * 4 + 2];
      this.starVecs.set(v, i * 3);
    }
    this.starVao = gl.createVertexArray();
    gl.bindVertexArray(this.starVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    const attr = (name, size, off) => {
      const l = gl.getAttribLocation(this.star.prog, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, 28, off);
    };
    attr('aPos', 3, 0); attr('aMag', 1, 12); attr('aCol', 3, 16);
    gl.bindVertexArray(null);
    this.starCount = n;
  }

  setPhotoTexture(id, bitmap) {
    this.removePhotoTexture(id);
    this.photoTex.set(id, { tex: this.#texture(bitmap, 0, 0, false), w: bitmap.width, h: bitmap.height });
  }

  removePhotoTexture(id) {
    const t = this.photoTex.get(id);
    if (t) { this.gl.deleteTexture(t.tex); this.photoTex.delete(id); }
  }

  #setProj(p, proj, lonRef = 0, lonAdd = 0) {
    const gl = this.gl, u = p.u;
    // uniformMatrix3fv is column-major; passing our row-major matrix with transpose=true keeps `uMat * v` meaning M·v.
    gl.uniformMatrix3fv(u.uMat, true, proj.mat);
    gl.uniform1i(u.uMode, proj.mode);
    gl.uniform1f(u.uScale, proj.scale);
    gl.uniform2f(u.uRes, proj.w, proj.h);
    gl.uniform2f(u.uLL0, proj.lon0, proj.lat0);
    if (u.uLonRef) gl.uniform1f(u.uLonRef, lonRef);
    if (u.uLonAdd) gl.uniform1f(u.uLonAdd, lonAdd);
  }

  /**
   * @param proj  Projection sized in device pixels (proj.w x proj.h must match the canvas)
   * @param scene { photos: [{id, ra, dec, rot, fovW, aspect, flip, opacity, feather, melt, visible}], limMag, starPx, gain, stars }
   */
  render(proj, scene) {
    const gl = this.gl;
    gl.viewport(0, 0, proj.w, proj.h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.useProgram(this.bg.prog);
    this.#setProj(this.bg, proj);
    gl.uniform1f(this.bg.u.uGain, scene.gain ?? 1);
    gl.uniform1f(this.bg.u.uBlur, (scene.blurDeg ?? 0) / 360);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.uniform1i(this.bg.u.uTex, 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    if (this.starCount && scene.stars !== false) {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.star.prog);
      this.#setProj(this.star, proj);
      gl.uniform1f(this.star.u.uLimMag, scene.limMag);
      gl.uniform1f(this.star.u.uPx, scene.starPx ?? 1);
      // Stars are sorted by magnitude: draw only the prefix brighter than the limit.
      let lo = 0, hi = this.starCount;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.starMags[mid] < scene.limMag + 0.3) lo = mid + 1; else hi = mid; }
      gl.bindVertexArray(this.starVao);
      gl.drawArrays(gl.POINTS, 0, lo);
    }

    if (scene.photos?.length) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.photo.prog);
      gl.bindVertexArray(this.mesh);
      const u = this.photo.u;
      gl.uniform1i(u.uTex, 0);
      for (const ph of scene.photos) {
        const t = this.photoTex.get(ph.id);
        if (!t || ph.visible === false || ph.ra == null) continue;
        const f = frameOf(ph);
        const c = mulMV(proj.mat, f.c);
        if (proj.mode === 0 && c[2] < -0.3) continue; // behind the viewer
        const lonRef = proj.mode === 1 ? wrapPi(Math.atan2(c[1], c[0]) - proj.lon0) : 0;
        gl.uniform3fv(u.uC, f.c); gl.uniform3fv(u.uRight, f.right); gl.uniform3fv(u.uUp, f.up);
        gl.uniform2f(u.uHalf, f.halfW, f.halfH);
        gl.uniform1f(u.uOpacity, ph.opacity ?? 1);
        gl.uniform1f(u.uFeather, ph.feather ?? 0.08);
        gl.uniform1f(u.uMelt, ph.melt ?? 0);
        gl.uniform1f(u.uAspect, ph.aspect);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        for (const add of proj.mode === 1 ? [0, Math.PI * 2, -Math.PI * 2] : [0]) {
          this.#setProj(this.photo, proj, lonRef, add);
          gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_SHORT, 0);
        }
      }
    }
    gl.bindVertexArray(null);
  }
}
