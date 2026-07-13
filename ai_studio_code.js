// ÉTAT GLOBAL
const state = {
    audio: { isPlaying: false, time: 0, startAt: 0, ctx: null },
    patch: [],
    selectedId: null,
    pxPerSec: 60,
    three: { scene: null, camera: null, renderer: null, meshes: {}, beams: {} }
};

// INITIALISATION SÉCURISÉE
window.addEventListener('DOMContentLoaded', () => {
    initThree();
    setupUI();
    animate();
});

function initThree() {
    const container = document.getElementById('three-canvas');
    if (!container) return;

    state.three.scene = new THREE.Scene();
    state.three.scene.background = new THREE.Color(0x020204);

    state.three.camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    state.three.camera.position.set(0, 10, 20);
    state.three.camera.lookAt(0, 2, 0);

    state.three.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.three.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(state.three.renderer.domElement);

    state.three.scene.add(new THREE.GridHelper(20, 20, 0x111111, 0x080808));
    state.three.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
}

function animate() {
    updateTime();
    updateFixtures();
    if (state.three.renderer) {
        state.three.renderer.render(state.three.scene, state.three.camera);
    }
    requestAnimationFrame(animate);
}

function updateTime() {
    if (state.audio.isPlaying && state.audio.ctx) {
        state.audio.time = state.audio.ctx.currentTime - state.audio.startAt;
    }
    const clock = document.getElementById('clock');
    const playhead = document.getElementById('playhead');
    if (clock) clock.textContent = formatTime(state.audio.time);
    if (playhead) playhead.style.left = (state.audio.time * state.pxPerSec) + 'px';
}

function addFixture(type) {
    const id = Date.now();
    const fix = {
        id, name: type.toUpperCase() + " " + (state.patch.length + 1),
        type, x: (state.patch.length * 2.2) - 5,
        dim: 100, pan: 50, tilt: 50, color: '#00d2d3', fx: false
    };
    state.patch.push(fix);

    // 3D MODEL
    const group = new THREE.Group();
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5), new THREE.MeshStandardMaterial({color: 0x111111}));
    const beam = new THREE.Mesh(
        new THREE.ConeGeometry(0.4, 12, 32),
        new THREE.MeshBasicMaterial({ color: fix.color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    beam.geometry.translate(0, -6, 0);
    head.add(beam);
    group.add(head);
    group.position.set(fix.x, 6, 0);
    group.rotation.x = Math.PI;

    state.three.scene.add(group);
    state.three.meshes[id] = head;
    state.three.beams[id] = beam;

    updateTracks();
    selectFixture(id);
    document.getElementById('patch-modal').style.display = 'none';
}

function selectFixture(id) {
    state.selectedId = id;
    const fix = state.patch.find(f => f.id === id);
    document.getElementById('ins-msg').style.display = 'none';
    document.getElementById('inspector-ui').style.display = 'block';
    document.getElementById('ins-name').textContent = fix.name;
    document.getElementById('f-dim').value = fix.dim;
    document.getElementById('f-pan').value = fix.pan;
    document.getElementById('f-tilt').value = fix.tilt;
    document.getElementById('f-color').value = fix.color;
    document.getElementById('fx-sine-btn').classList.toggle('active', fix.fx);
}

function setupUI() {
    document.getElementById('patch-toggle').onclick = () => document.getElementById('patch-modal').style.display = 'flex';
    document.getElementById('close-modal').onclick = () => document.getElementById('patch-modal').style.display = 'none';
    
    document.getElementById('play-btn').onclick = () => {
        if (!state.audio.ctx) state.audio.ctx = new AudioContext();
        state.audio.isPlaying = !state.audio.isPlaying;
        state.audio.startAt = state.audio.ctx.currentTime - state.audio.time;
        document.getElementById('play-btn').textContent = state.audio.isPlaying ? "PAUSE" : "PLAY";
    };

    document.getElementById('stop-btn').onclick = () => {
        state.audio.isPlaying = false;
        state.audio.time = 0;
        document.getElementById('play-btn').textContent = "PLAY";
    };

    // Inputs
    ['f-dim', 'f-pan', 'f-tilt', 'f-color'].forEach(id => {
        document.getElementById(id).oninput = (e) => {
            if (!state.selectedId) return;
            const fix = state.patch.find(f => f.id === state.selectedId);
            const val = e.target.id === 'f-color' ? e.target.value : parseInt(e.target.value);
            fix[e.target.id.split('-')[1]] = val;
        };
    });

    document.getElementById('fx-sine-btn').onclick = () => {
        const fix = state.patch.find(f => f.id === state.selectedId);
        fix.fx = !fix.fx;
        document.getElementById('fx-sine-btn').classList.toggle('active', fix.fx);
    };
}

function updateFixtures() {
    const t = Date.now() * 0.002;
    state.patch.forEach(fix => {
        const head = state.three.meshes[fix.id];
        const beam = state.three.beams[fix.id];
        if (!head) return;

        let p = fix.pan, tilt = fix.tilt;
        if (fix.fx) { p += Math.sin(t + fix.x) * 15; tilt += Math.cos(t + fix.x) * 10; }

        head.rotation.z = (p - 50) * 0.03;
        head.rotation.x = (tilt - 50) * 0.03;
        beam.material.color.set(fix.color);
        beam.material.opacity = (fix.dim / 100) * 0.4;
        beam.visible = fix.dim > 0;
    });
}

function updateTracks() {
    const list = document.getElementById('tracks-list');
    list.innerHTML = state.patch.map(f => `<div class="track-row" onclick="selectFixture(${f.id})">${f.name}</div>`).join('');
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 100);
    return `${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
}