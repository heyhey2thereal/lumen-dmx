/**
 * LUMEN ENGINE v3.0
 * Correction des erreurs de sélecteurs et boucle de rendu
 */

const state = {
    audio: { ctx: null, isPlaying: false, time: 0, startAt: 0 },
    patch: [],
    selectedId: null,
    pxPerSec: 60,
    three: {}
};

// Initialisation au chargement
window.onload = () => {
    initThree();
    setupEventListeners();
    
    // Boucle de rendu permanente
    function animate() {
        updateTime();
        renderScene();
        requestAnimationFrame(animate);
    }
    animate();
};

function initThree() {
    const container = document.getElementById('three-canvas');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020203);

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 8, 15);
    camera.lookAt(0, 2, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    // Environnement
    scene.add(new THREE.GridHelper(20, 20, 0x111111, 0x050505));
    scene.add(new THREE.AmbientLight(0xffffff, 0.3));

    state.three = { scene, camera, renderer, meshes: {}, beams: {} };
    
    // Gérer le redimensionnement
    window.addEventListener('resize', () => {
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
    });
}

function addFixture(type) {
    const id = Date.now();
    const fix = {
        id,
        name: type.toUpperCase() + " " + (state.patch.length + 1),
        type,
        x: (state.patch.length * 1.8) - 5,
        dim: 100, pan: 50, tilt: 50, color: '#00d2d3',
        fx: false
    };
    
    state.patch.push(fix);

    // Création du modèle 3D
    const group = new THREE.Group();
    
    // Tête mobile
    const head = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.5, 16),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    
    // Faisceau
    const beamGeo = new THREE.ConeGeometry(0.5, 12, 32);
    beamGeo.translate(0, -6, 0);
    const beamMat = new THREE.MeshBasicMaterial({
        color: fix.color,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    
    head.add(beam);
    group.add(head);
    group.position.set(fix.x, 5, 0);
    group.rotation.x = Math.PI; // Suspendu

    state.three.scene.add(group);
    state.three.meshes[id] = head;
    state.three.beams[id] = beam;

    updateTimeline();
    selectFixture(id);
    document.getElementById('patch-modal').style.display = 'none';
}

function selectFixture(id) {
    state.selectedId = id;
    const fix = state.patch.find(f => f.id === id);
    
    document.getElementById('ins-msg').style.display = 'none';
    document.getElementById('inspector-ui').style.display = 'block';
    document.getElementById('ins-name').textContent = fix.name;
    
    // Mettre à jour les faders
    document.getElementById('f-dim').value = fix.dim;
    document.getElementById('f-pan').value = fix.pan;
    document.getElementById('f-tilt').value = fix.tilt;
    document.getElementById('f-color').value = fix.color;
    document.getElementById('fx-sine-btn').classList.toggle('active', fix.fx);
}

function setupEventListeners() {
    // Boutons Modal
    document.getElementById('patch-toggle').onclick = () => document.getElementById('patch-modal').style.display = 'flex';
    document.getElementById('close-modal').onclick = () => document.getElementById('patch-modal').style.display = 'none';

    // Faders
    document.getElementById('f-dim').oninput = (e) => updateParam('dim', e.target.value);
    document.getElementById('f-pan').oninput = (e) => updateParam('pan', e.target.value);
    document.getElementById('f-tilt').oninput = (e) => updateParam('tilt', e.target.value);
    document.getElementById('f-color').oninput = (e) => updateParam('color', e.target.value);
    
    document.getElementById('fx-sine-btn').onclick = () => {
        const fix = state.patch.find(f => f.id === state.selectedId);
        fix.fx = !fix.fx;
        document.getElementById('fx-sine-btn').classList.toggle('active', fix.fx);
    };

    // Transport
    document.getElementById('play-btn').onclick = () => {
        if (!state.audio.ctx) state.audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
        state.audio.isPlaying = !state.audio.isPlaying;
        state.audio.startAt = state.audio.ctx.currentTime - state.audio.time;
        document.getElementById('play-btn').textContent = state.audio.isPlaying ? "PAUSE" : "PLAY";
    };
    
    document.getElementById('stop-btn').onclick = () => {
        state.audio.isPlaying = false;
        state.audio.time = 0;
        document.getElementById('play-btn').textContent = "PLAY";
    };
}

function updateParam(param, val) {
    if (!state.selectedId) return;
    const fix = state.patch.find(f => f.id === state.selectedId);
    fix[param] = (param === 'color') ? val : parseInt(val);
}

function updateTime() {
    if (state.audio.isPlaying && state.audio.ctx) {
        state.audio.time = state.audio.ctx.currentTime - state.audio.startAt;
    }
    document.getElementById('clock').textContent = formatTime(state.audio.time);
    document.getElementById('playhead').style.left = (state.audio.time * state.pxPerSec) + 'px';
}

function renderScene() {
    const time = Date.now() * 0.002;
    state.patch.forEach(fix => {
        const head = state.three.meshes[fix.id];
        const beam = state.three.beams[fix.id];
        
        if (!head) return;

        // Calcul Pan/Tilt avec FX optionnel
        let p = fix.pan;
        let t = fix.tilt;
        if (fix.fx) {
            p += Math.sin(time + fix.x) * 20;
            t += Math.cos(time + fix.x) * 10;
        }

        head.rotation.z = (p - 50) * 0.03;
        head.rotation.x = (t - 50) * 0.03;
        
        beam.material.color.set(fix.color);
        beam.material.opacity = (fix.dim / 100) * 0.4;
        beam.visible = fix.dim > 0;
    });
    
    state.three.renderer.render(state.three.scene, state.three.camera);
}

function updateTimeline() {
    const list = document.getElementById('tracks-list');
    list.innerHTML = state.patch.map(f => `
        <div class="track-row" onclick="selectFixture(${f.id})">${f.name}</div>
    `).join('');
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 100);
    return `${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
}
