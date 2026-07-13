// CONFIGURATION DMX PRO
const state = {
    audio: { ctx: null, buffer: null, source: null, isPlaying: false, time: 0, startAt: 0 },
    patch: { fixtures: [], selectedId: null },
    clips: { list: [] },
    ui: { pxPerSec: 50, panelOpen: false },
    three: { scene: null, camera: null, renderer: null, groups: {}, beams: {} }
};

const LIB = [
    { id: 'spot', name: 'ROBE POINTE', type: 'beam', color: '#00f2ff' },
    { id: 'wash', name: 'MARTIN AURA', type: 'wash', color: '#f39c12' },
    { id: 'beam', name: 'SHARPY', type: 'beam', color: '#ffffff' }
];

// INITIALISATION
function init() {
    setup3D();
    setupDOM();
    
    // Boucle de rendu permanente (60 FPS)
    function loop() {
        updateTime();
        render3D();
        requestAnimationFrame(loop);
    }
    loop();
}

function setup3D() {
    const container = document.getElementById('render-canvas');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020305);

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 7, 15);
    camera.lookAt(0, 2, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    // Grille & Truss
    scene.add(new THREE.GridHelper(20, 20, 0x111111, 0x080808));
    const truss = new THREE.Mesh(new THREE.BoxGeometry(15, 0.2, 0.2), new THREE.MeshStandardMaterial({color: 0x111111}));
    truss.position.y = 5;
    scene.add(truss);
    scene.add(new THREE.AmbientLight(0xffffff, 0.2));

    state.three = { scene, camera, renderer, groups: {}, beams: {} };
}

function patchFixture(typeId) {
    const proto = LIB.find(l => l.id === typeId);
    const id = Date.now();
    const fix = { 
        ...proto, id, 
        x: (state.patch.fixtures.length * 1.5) - 4,
        pan: 50, tilt: 50, dim: 100, color: proto.color,
        fxSine: false 
    };
    
    state.patch.fixtures.push(fix);
    
    // MODEL 3D
    const group = new THREE.Group();
    const head = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.4), new THREE.MeshStandardMaterial({color: 0x111111}));
    
    // BEAM (FAISCEAU) - Volumétrique
    const beamGeo = new THREE.ConeGeometry(0.4, 10, 32);
    beamGeo.translate(0, -5, 0);
    const beamMat = new THREE.MeshBasicMaterial({
        color: fix.color,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    
    head.add(body);
    head.add(beam);
    group.add(head);
    group.position.set(fix.x, 4.8, 0);
    group.rotation.x = Math.PI; // Tête vers le bas
    
    state.three.scene.add(group);
    state.three.groups[id] = head;
    state.three.beams[id] = beam;

    renderTimeline();
    selectFixture(id);
    togglePanel(null);
}

function updateTime() {
    if (state.audio.isPlaying) {
        state.audio.time = state.audio.ctx.currentTime - state.audio.startAt;
    }
    
    // UI Update
    document.getElementById('timecode').textContent = formatTime(state.audio.time);
    document.getElementById('playhead').style.left = (state.audio.time * state.ui.pxPerSec) + 'px';
}

function render3D() {
    const t = Date.now() * 0.002;
    
    state.patch.fixtures.forEach(fix => {
        const head = state.three.groups[fix.id];
        const beam = state.three.beams[fix.id];
        
        if (!head) return;

        // Automation FX (Sine wave)
        let pan = fix.pan;
        let tilt = fix.tilt;
        if (fix.fxSine) {
            pan += Math.sin(t + fix.x) * 20;
            tilt += Math.cos(t + fix.x) * 10;
        }

        head.rotation.z = (pan - 50) * 0.03;
        head.rotation.x = (tilt - 50) * 0.03;
        
        beam.material.color.set(fix.color);
        beam.material.opacity = (fix.dim / 100) * 0.5;
        beam.visible = fix.dim > 0;
    });

    state.three.renderer.render(state.three.scene, state.three.camera);
}

function selectFixture(id) {
    state.patch.selectedId = id;
    const fix = state.patch.fixtures.find(f => f.id === id);
    
    document.getElementById('ins-none').style.display = 'none';
    document.getElementById('ins-controls').style.display = 'block';
    document.getElementById('ins-name').textContent = fix.name;
    document.getElementById('ins-type').textContent = fix.type;
    
    // Init faders
    document.getElementById('f-dim').value = fix.dim;
    document.getElementById('f-pan').value = fix.pan;
    document.getElementById('f-tilt').value = fix.tilt;
    document.getElementById('f-color').value = fix.color;
    
    document.getElementById('btn-fx-sine').classList.toggle('active', fix.fxSine);
}

function setupDOM() {
    // Inputs
    document.getElementById('f-dim').oninput = (e) => updateParam('dim', e.target.value);
    document.getElementById('f-pan').oninput = (e) => updateParam('pan', e.target.value);
    document.getElementById('f-tilt').oninput = (e) => updateParam('tilt', e.target.value);
    document.getElementById('f-color').oninput = (e) => updateParam('color', e.target.value);
    document.getElementById('btn-fx-sine').onclick = () => {
        const fix = state.patch.fixtures.find(f => f.id === state.patch.selectedId);
        fix.fxSine = !fix.fxSine;
        document.getElementById('btn-fx-sine').classList.toggle('active', fix.fxSine);
    };

    // Timeline Scrubbing
    document.getElementById('tl-ruler').onmousedown = (e) => {
        const rect = e.target.getBoundingClientRect();
        state.audio.time = (e.clientX - rect.left) / state.ui.pxPerSec;
    };

    // Transport
    document.getElementById('btn-play').onclick = () => {
        if (!state.audio.ctx) state.audio.ctx = new AudioContext();
        state.audio.isPlaying = !state.audio.isPlaying;
        state.audio.startAt = state.audio.ctx.currentTime - state.audio.time;
        document.getElementById('btn-play').textContent = state.audio.isPlaying ? "PAUSE" : "PLAY";
    };
    
    document.getElementById('btn-stop').onclick = () => {
        state.audio.isPlaying = false;
        state.audio.time = 0;
        document.getElementById('btn-play').textContent = "PLAY";
    };
}

function updateParam(p, v) {
    if (!state.patch.selectedId) return;
    const fix = state.patch.fixtures.find(f => f.id === state.patch.selectedId);
    fix[p] = (p === 'color') ? v : parseInt(v);
}

function togglePanel(panel) {
    const ov = document.getElementById('bottom-overlay');
    if (!panel) { ov.style.display = 'none'; return; }
    ov.style.display = 'flex';
    
    const content = document.getElementById('overlay-content');
    if (panel === 'lib') {
        content.innerHTML = `<div class="lib-grid">
            ${LIB.map(l => `<div class="lib-item" onclick="patchFixture('${l.id}')"><strong>${l.name}</strong><br><small>${l.type}</small></div>`).join('')}
        </div>`;
    }
}

function renderTimeline() {
    const list = document.getElementById('tracks-list');
    list.innerHTML = state.patch.fixtures.map(f => `
        <div class="track-row">
            <div class="track-name" onclick="selectFixture(${f.id})">${f.name}</div>
            <div class="track-lane"></div>
        </div>
    `).join('');
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 100);
    return `${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
}

window.onload = init;
