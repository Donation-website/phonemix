/**
 * Liquid Photo Pro - GPU Fluid Engine (Navier-Stokes Solver)
 * Fixed: Flip Y, Vibration, and Simulation Stability
 */

export default class FluidEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { alpha: false, depth: false, antialias: false });
        if (!this.gl) throw new Error("WebGL 2.0 required");

        // Finomhangolt paraméterek a stabilitásért
        this.params = {
            SIM_RES: 128,
            DYE_RES: 1024,
            DENSITY_DISSIPATION: 0.97,
            VELOCITY_DISSIPATION: 0.98,
            PRESSURE: 0.8,
            CURL: 2.0, // Alacsonyabb érték a vibrálás ellen
            SPLAT_RADIUS: 0.005
        };

        this.pointers = [];
        this.gravity = { x: 0, y: 0 };
        this.init();
        this.setupEvents();
    }

    init() {
        const gl = this.gl;

        // Shader programok összeállítása
        this.programs = {
            advection: this.createProgram(this.baseVS, this.advectionFS),
            splat: this.createProgram(this.baseVS, this.splatFS),
            divergence: this.createProgram(this.baseVS, this.divergenceFS),
            pressure: this.createProgram(this.baseVS, this.pressureFS),
            gradient: this.createProgram(this.baseVS, this.gradientFS),
            display: this.createProgram(this.baseVS, this.displayFS)
        };

        this.velocity = this.createDoubleFBO(this.params.SIM_RES, this.params.SIM_RES);
        this.density = this.createDoubleFBO(this.params.DYE_RES, this.params.DYE_RES);
        this.divergence = this.createFBO(this.params.SIM_RES, this.params.SIM_RES);
        this.pressure = this.createDoubleFBO(this.params.SIM_RES, this.params.SIM_RES);

        this.initQuad();
    }

    setBaseImage(image) {
        const gl = this.gl;
        // JAVÍTÁS: Kép megfordítása a WebGL koordinátákhoz
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.density.read.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, image);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // Visszaállítás
    }

    updateGravity(gx, gy) {
        this.gravity.x = gx * 0.5; 
        this.gravity.y = -gy * 0.5; 
    }

    run() {
        const step = () => {
            this.update();
            this.render();
            requestAnimationFrame(step);
        };
        step();
    }

    update() {
        const gl = this.gl;
        const texelSize = 1.0 / this.params.SIM_RES;
        
        // Mozgás átvitele
        gl.useProgram(this.programs.advection);
        gl.uniform1f(gl.getUniformLocation(this.programs.advection, 'uDissipation'), this.params.VELOCITY_DISSIPATION);
        gl.uniform1f(gl.getUniformLocation(this.programs.advection, 'uDt'), 0.016);
        this.renderTo(this.velocity.write, this.programs.advection, { uTarget: this.velocity.read.texture, uVelocity: this.velocity.read.texture });
        this.velocity.swap();

        // Színek mozgatása
        gl.uniform1f(gl.getUniformLocation(this.programs.advection, 'uDissipation'), this.params.DENSITY_DISSIPATION);
        this.renderTo(this.density.write, this.programs.advection, { uTarget: this.density.read.texture, uVelocity: this.velocity.read.texture });
        this.density.swap();

        // Interakciók
        this.pointers.forEach(p => {
            if (p.moved) {
                this.splat(p.x, p.y, p.dx, p.dy, p.color);
                p.moved = false;
            }
        });

        if (Math.abs(this.gravity.x) > 0.05 || Math.abs(this.gravity.y) > 0.05) {
            this.applyGravity();
        }

        // Fizikai kényszerek (Divergencia -> Nyomás -> Gradiens kivonás)
        this.renderTo(this.divergence, this.programs.divergence, { uVelocity: this.velocity.read.texture, uTexelSize: texelSize });
        
        gl.useProgram(this.programs.pressure);
        gl.uniform1f(gl.getUniformLocation(this.programs.pressure, 'uTexelSize'), texelSize);
        for (let i = 0; i < 20; i++) {
            this.renderTo(this.pressure.write, this.programs.pressure, { uPressure: this.pressure.read.texture, uDivergence: this.divergence.texture });
            this.pressure.swap();
        }

        this.renderTo(this.velocity.write, this.programs.gradient, { uPressure: this.pressure.read.texture, uVelocity: this.velocity.read.texture, uTexelSize: texelSize });
        this.velocity.swap();
    }

    render() {
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.renderTo(null, this.programs.display, { uTexture: this.density.read.texture });
    }

    splat(x, y, dx, dy, color) {
        this.renderTo(this.velocity.write, this.programs.splat, { uTarget: this.velocity.read.texture, aspect: this.canvas.width/this.canvas.height, point: [x, y], color: [dx, dy, 0], radius: this.params.SPLAT_RADIUS });
        this.velocity.swap();
        this.renderTo(this.density.write, this.programs.splat, { uTarget: this.density.read.texture, aspect: this.canvas.width/this.canvas.height, point: [x, y], color: [color.r, color.g, color.b], radius: this.params.SPLAT_RADIUS });
        this.density.swap();
    }

    applyGravity() {
        this.renderTo(this.velocity.write, this.programs.splat, { uTarget: this.velocity.read.texture, aspect: 1, point: [0.5, 0.5], color: [this.gravity.x, this.gravity.y, 0], radius: 1.0 });
        this.velocity.swap();
    }

    setupEvents() {
        this.canvas.addEventListener('mousemove', e => {
            this.updatePointer(0, e.offsetX, e.offsetY);
        });
        this.canvas.addEventListener('touchmove', e => {
            if(e.touches.length > 0) {
                const rect = this.canvas.getBoundingClientRect();
                this.updatePointer(0, e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
            }
        }, { passive: false });
    }

    updatePointer(id, x, y) {
        let p = this.pointers[id] || { x: 0, y: 0, dx: 0, dy: 0, color: { r: 1, g: 1, b: 1 }, moved: false };
        p.dx = (x / this.canvas.clientWidth - p.x) * 10.0;
        p.dy = (1.0 - y / this.canvas.clientHeight - p.y) * 10.0;
        p.x = x / this.canvas.clientWidth;
        p.y = 1.0 - y / this.canvas.clientHeight;
        p.moved = true;
        this.pointers[id] = p;
    }

    // WebGL Segédfüggvények
    createProgram(vsSource, fsSource) {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSource); gl.compileShader(vs);
        if(!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vs));
        
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSource); gl.compileShader(fs);
        if(!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fs));

        const prog = gl.createProgram();
        gl.attachShader(prog, vs); gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        return prog;
    }

    createFBO(w, h) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        return { texture, fbo, w, h };
    }

    createDoubleFBO(w, h) {
        let fbo1 = this.createFBO(w, h);
        let fbo2 = this.createFBO(w, h);
        return { read: fbo1, write: fbo2, swap() { let t = fbo1; fbo1 = fbo2; fbo2 = t; this.read = fbo1; this.write = fbo2; } };
    }

    renderTo(target, program, uniforms) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
        gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
        gl.useProgram(program);
        Object.keys(uniforms).forEach(name => {
            const loc = gl.getUniformLocation(program, name);
            const val = uniforms[name];
            if (Array.isArray(val)) val.length === 2 ? gl.uniform2fv(loc, val) : gl.uniform3fv(loc, val);
            else if (typeof val === 'number') gl.uniform1f(loc, val);
            else { 
                const unit = name === 'uVelocity' ? 1 : 0;
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, val);
                gl.uniform1i(loc, unit);
            }
        });
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    initQuad() {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }

    // Shaders
    get baseVS() { return `#version 300 es\nprecision highp float; layout(location=0) in vec2 pos; out vec2 vUv; void main() { vUv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`; }
    get advectionFS() { return `#version 300 es\nprecision highp float; in vec2 vUv; uniform sampler2D uTarget; uniform sampler2D uVelocity; uniform float uDissipation; uniform float uDt; out vec4 outCol; void main() { vec2 coord = vUv - texture(uVelocity, vUv).xy * uDt * 0.1; outCol = texture(uTarget, coord) * uDissipation; }`; }
    get splatFS() { return `#version 300 es\nprecision highp float; in vec2 vUv; uniform sampler2D uTarget; uniform vec2 point; uniform vec3 color; uniform float radius; uniform float aspect; out vec4 outCol; void main() { vec2 p = vUv - point; p.x *= aspect; float d = exp(-dot(p, p) / radius); outCol = texture(uTarget, vUv) + vec4(color * d, 1.0); }`; }
    get divergenceFS() { return `#version 300 es\nprecision highp float; in vec2 vUv; uniform sampler2D uVelocity; uniform float uTexelSize; out vec4 outCol; void main() { float L = texture(uVelocity, vUv - vec2(uTexelSize, 0.0)).x; float R = texture(uVelocity, vUv + vec2(uTexelSize, 0.0)).x; float T = texture(uVelocity, vUv + vec2(0.0, uTexelSize)).y; float B = texture(uVelocity, vUv - vec2(0.0, uTexelSize)).y; outCol = vec4(0.5 * (R - L + T - B), 0, 0, 1); }`; }
    get pressureFS() { return `#version 300 es\nprecision highp float; in vec2 vUv; uniform sampler2D uPressure; uniform sampler2D uDivergence; uniform float uTexelSize; out vec4 outCol; void main() { float L = texture(uPressure, vUv - vec2(uTexelSize, 0.0)).x; float R = texture(uPressure, vUv + vec2(uTexelSize, 0.0)).x; float T = texture(uPressure, vUv + vec2(0.0, uTexelSize)).x; float B = texture(uPressure, vUv - vec2(0.0, uTexelSize)).x; float d = texture(uDivergence, vUv).x; outCol = vec4(0.25 * (L + R + B + T - d), 0, 0, 1); }`; }
    get gradientFS() { return `#version 300 es\nprecision highp float; in vec2 vUv; uniform sampler2D uPressure; uniform sampler2D uVelocity; uniform float uTexelSize; out vec4 outCol; void main() { float L = texture(uPressure, vUv - vec2(uTexelSize, 0.0)).x; float R = texture(uPressure, vUv + vec2(uTexelSize, 0.0)).x; float T = texture(uPressure, vUv + vec2(0.0, uTexelSize)).x; float B = texture(uPressure, vUv - vec2(0.0, uTexelSize)).x; vec2 vel = texture(uVelocity, vUv).xy; outCol = vec4(vel - vec2(R - L, T - B), 0, 1); }`; }
    get displayFS() { return `#version 300 es\nprecision highp float; in vec2 vUv; uniform sampler2D uTexture; out vec4 outCol; void main() { outCol = texture(uTexture, vUv); }`; }
}
