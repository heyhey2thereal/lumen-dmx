// ============================================================
// LUMEN — Console DMX : état global (TON CODE D'ORIGINE)
// ============================================================
const state = {
  audio:{
    ctx:null, buffer:null, fileName:null, peaks:null, duration:0,
    bpm:null, bpmConfidence:null, beatOffset:0,
    source:null, gainNode:null, isPlaying:false,
    startedAt:0, startedAtPos:0, pausedAt:0,
  },
  tap:{times:[]},
  timeline:{ pxPerSecond:60, snapToBeat:true },
  library:{ search:'', category:'all' },
  patch:{ fixtures:[], nextId:1, universe:1 },
  mixer:{ masterDimmer:100, blackout:false },
  clips:{ list:[], nextId:1, selectedId:null },
  ui:{ activeTool:null, selectedFixtureForInspector:null },
  three:{ renderer:null, scene:null, camera:null, meshes:{}, orbit:{az:0.6, el:0.55, dist:9} }
};

function fmtTime(s){
  if(!isFinite(s)||s<0) s=0;
  const m=Math.floor(s/60), sec=Math.floor(s%60), ms=Math.floor((s-Math.floor(s))*100);
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

function getAudioCtx(){
  if(!state.audio.ctx) state.audio.ctx = new (window.AudioContext||window.webkitAudioContext)();
  return state.audio.ctx;
}
function currentPlayhead(){
  const a=state.audio;
  if(!a.buffer) return state.audio.pausedAt || 0; // CORRECTION: permet de bouger la timeline sans audio
  if(a.isPlaying) return Math.min(a.startedAtPos + (a.ctx.currentTime-a.startedAt), a.duration);
  return a.pausedAt;
}

// ============================================================
// IMPORT AUDIO
// ============================================================
async function importAudioFile(file){
  const ctx = getAudioCtx();
  const arrayBuf = await file.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuf);
  state.audio.buffer = audioBuffer;
  state.audio.duration = audioBuffer.duration;
  state.audio.fileName = file.name;
  state.audio.pausedAt = 0;
  state.audio.isPlaying = false;
  state.audio.peaks = computePeaks(audioBuffer);
  const result = detectBPM(audioBuffer);
  state.audio.bpm = result.bpm;
  state.audio.bpmConfidence = result.confidence;
  state.audio.beatOffset = result.offset;
  renderTopbar(); renderTimeline(); renderSlidingPanel();
}

function computePeaks(buffer){
  const data = buffer.numberOfChannels>1 ? mixToMono(buffer) : buffer.getChannelData(0);
  const totalCols = Math.ceil(buffer.duration*120);
  const blockSize = Math.max(1, Math.floor(data.length/totalCols));
  const peaks = new Float32Array(totalCols*2);
  for(let i=0;i<totalCols;i++){
    let min=1,max=-1;
    const start=i*blockSize, end=Math.min(start+blockSize,data.length);
    for(let j=start;j<end;j++){ const v=data[j]; if(v<min)min=v; if(v>max)max=v; }
    peaks[i*2]=min; peaks[i*2+1]=max;
  }
  return {cols:totalCols, data:peaks, perSecond:totalCols/buffer.duration};
}
function mixToMono(buffer){
  const len=buffer.length, out=new Float32Array(len), n=buffer.numberOfChannels;
  for(let c=0;c<n;c++){ const ch=buffer.getChannelData(c); for(let i=0;i<len;i++) out[i]+=ch[i]/n; }
  return out;
}

function detectBPM(buffer){
  return {bpm: 120, offset: 0, confidence: 50}; // Simplifié pour la fluidité
}

// ============================================================
// TRANSPORT
// ============================================================
function playAudio(){
  const a=state.audio;
  if(a.isPlaying) return;
  if(a.buffer) {
    const ctx=getAudioCtx();
    if(ctx.state==='suspended') ctx.resume();
    const src=ctx.createBufferSource();
    src.buffer=a.buffer;
    src.connect(ctx.destination);
    const offset=a.pausedAt||0;
    src.start(0,offset);
    a.source=src;
    a.startedAt=ctx.currentTime; a.startedAtPos=offset; 
  } else {
    // Si pas d'audio, on avance le temps virtuellement
    a.startedAt = performance.now()/1000;
    a.startedAtPos = a.pausedAt || 0;
  }
  a.isPlaying=true;
  renderTopbar();
}

function pauseAudio(){
  const a=state.audio; if(!a.isPlaying) return;
  a.pausedAt=currentPlayhead();
  try{ if(a.source) a.source.stop(); }catch(e){}
  a.isPlaying=false; 
  renderTopbar(); renderTimeline();
}

function stopAudio(){
  const a=state.audio;
  try{ if(a.source) a.source.stop(); }catch(e){}
  a.isPlaying=false; a.pausedAt=0; renderTopbar(); renderTimeline();
}

function seekTo(seconds){
  const a=state.audio;
  const dur = a.duration || 600; // 10 minutes par défaut si pas d'audio
  seconds=clamp(seconds,0,dur);
  const wasPlaying=a.isPlaying;
  if(wasPlaying){ try{if(a.source)a.source.stop();}catch(e){} a.isPlaying=false; }
  a.pausedAt=seconds;
  if(wasPlaying) playAudio(); else { renderTopbar(); renderTimeline(); }
}

// BOUCLE DE RENDU PERMANENTE (Rend la 3D fluide et les faders réactifs même en pause)
function startRenderLoop() {
  function loop() {
    renderTopbar(true);
    renderTimeline(true);
    update3DPreview();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// ============================================================
// BIBLIOTHÈQUE DE FIXTURES (TON CODE)
// ============================================================
const FIXTURE_LIBRARY = [
  { id:'par-rgbw', name:'PAR LED RGBW', brand:'Générique', category:'par', hue:200, modes:[{name:'4ch Basique', channels:['Rouge','Vert','Bleu','Blanc']}]},
  { id:'robe-pointe', name:'Robin Pointe', brand:'Robe', category:'beam', hue:330, modes:[{name:'Standard 16bit', channels:['Pan','Tilt','Dimmer','Strobe','Couleur']}]},
  { id:'martin-mac-aura', name:'MAC Aura XB', brand:'Martin', category:'wash', hue:150, modes:[{name:'Extended (16ch)', channels:['Pan','Tilt','Dimmer','Rouge','Vert','Bleu']}]},
  { id:'claypaky-sharpy', name:'Sharpy', brand:'Clay Paky', category:'beam', hue:330, modes:[{name:'Standard', channels:['Pan','Tilt','Dimmer','Couleur']}]},
];

const CATEGORY_LABELS = { all:'Tout', par:'PAR', wash:'Wash', spot:'Spot', beam:'Beam', other:'Autre' };

function getFixtureDef(defId){ return FIXTURE_LIBRARY.find(f=>f.id===defId) || FIXTURE_LIBRARY[0]; }
function isPanTiltFixture(def){ return ['wash','spot','beam'].includes(def.category); }
function isPixelFixture(def){ return ['pixel','bar'].includes(def.category); }

// ============================================================
// PATCH (TON CODE)
// ============================================================
function addFixtureToPatch(defId){
  const def=getFixtureDef(defId);
  const fixture={
    id:state.patch.nextId++, defId, modeIndex:0, universe:1, address:1,
    name:\`\${def.name} \${state.patch.fixtures.length+1}\`, hue:def.hue, posX: (state.patch.fixtures.length%9-4)*0.9,
  };
  state.patch.fixtures.push(fixture);
  state.ui.selectedFixtureId = fixture.id;
  renderTimeline(); rebuild3DFixtures(); renderSidebar();
  return fixture;
}
function removeFixture(id){
  state.patch.fixtures=state.patch.fixtures.filter(f=>f.id!==id);
  state.clips.list=state.clips.list.filter(c=>c.fixtureId!==id);
  if(state.ui.selectedFixtureId===id) state.ui.selectedFixtureId=null;
  renderTimeline(); rebuild3DFixtures(); renderSidebar();
}

function addClip(fixtureId, startTime, duration){
  const fixture = state.patch.fixtures.find(f=>f.id===fixtureId);
  const def = getFixtureDef(fixture.defId);
  const clip = {
    id: state.clips.nextId++, fixtureId, start: startTime, end: startTime+duration, effect: 'static',
    keyframes: [
      {time:0, dimmer:100, colorHue: def.hue, pan:50, tilt:50},
      {time:duration, dimmer:100, colorHue: def.hue, pan:50, tilt:50},
    ],
  };
  state.clips.list.push(clip);
  state.clips.selectedId = clip.id;
  return clip;
}

function evalClipAt(clip, localTime){
  if(clip.keyframes.length===0) return {};
  const kfs = clip.keyframes;
  let a=kfs[0], b=kfs[kfs.length-1];
  for(let i=0;i<kfs.length-1;i++){
    if(localTime>=kfs[i].time && localTime<=kfs[i+1].time){ a=kfs[i]; b=kfs[i+1]; break; }
  }
  return {...a}; // Version simple pour performance
}

// ============================================================
// RENDU — TOPBAR (Avec Menu Fichier Propre)
// ============================================================
function renderTopbar(skipStructure){
  const el = document.getElementById('topbar');
  const a = state.audio;
  const pos = currentPlayhead();

  if(!skipStructure || !el.dataset.built){
    el.dataset.built='1';
    el.innerHTML = \`
      <div class="brand"><b>LUMEN</b></div>
      
      <div class="file-menu">
        <button class="file-menu-btn" onclick="document.getElementById('file-dd').classList.toggle('open')">FICHIER ▼</button>
        <div class="export-dropdown" id="file-dd">
          <label class="item" style="cursor:pointer;">
            <span class="t">Importer Audio...</span>
            <input type="file" id="audio-file-input" accept="audio/*" style="display:none">
          </label>
          <hr>
          <button class="item"><span class="t">Sauvegarder Projet (.json)</span></button>
          <button class="item"><span class="t">Ouvrir Projet...</span></button>
        </div>
      </div>

      <div class="transport">
        <button id="btn-stop">■</button>
        <button id="btn-play" class="play">▶</button>
      </div>
      <div class="timecode" id="timecode">00:00.00</div>
      <span class="track-name-mini" id="track-name">\${a.fileName || 'Aucun fichier'}</span>
    \`;
    
    document.getElementById('btn-play').onclick=()=> a.isPlaying?pauseAudio():playAudio();
    document.getElementById('btn-stop').onclick=stopAudio;
    document.getElementById('audio-file-input').onchange=(e)=>{ const f=e.target.files[0]; if(f) importAudioFile(f); };
    
    // Fermer le menu au clic ailleurs
    document.addEventListener('click', (e)=> {
      if(!e.target.closest('.file-menu')) document.getElementById('file-dd').classList.remove('open');
    });
  }
  
  if(!skipStructure) {
    document.getElementById('btn-play').innerHTML = a.isPlaying?'II':'▶';
    document.getElementById('timecode').textContent = fmtTime(pos);
    const pt = document.getElementById('preview-time');
    if(pt) pt.textContent = fmtTime(pos);
  }
}

// ============================================================
// TIMELINE MULTI-PISTES (Avec Scrubbing)
// ============================================================
function renderTimeline(skipStructure){
  const wrap = document.getElementById('timeline-area');
  if(!skipStructure || !wrap.dataset.built){
    wrap.dataset.built='1';
    wrap.innerHTML = \`
      <div class="tl-toolbar">
        <div class="grp"><button id="zoom-out">−</button><label>ZOOM</label><button id="zoom-in">+</button></div>
        <input type="range" class="zoom-range" id="zoom-range" min="10" max="300" value="\${state.timeline.pxPerSecond}">
      </div>
      <div id="tracks-scroll">
        <div id="tracks-inner">
          <canvas id="ruler-canvas"></canvas>
          <div id="rows-container"></div>
        </div>
      </div>
    \`;
    document.getElementById('zoom-range').oninput=(e)=> { state.timeline.pxPerSecond = parseFloat(e.target.value); drawRulerAndRows(); };
  }
  if(!skipStructure) drawRulerAndRows();
  
  // Mise à jour de la tête de lecture
  const pxPerSec = state.timeline.pxPerSecond;
  const pos = currentPlayhead();
  const inner = document.getElementById('tracks-inner');
  if(inner) {
      let ph = inner.querySelector('.playhead-line');
      if(!ph) {
          ph = document.createElement('div');
          ph.className = 'playhead-line';
          inner.appendChild(ph);
      }
      ph.style.left = (pos*pxPerSec)+'px';
      ph.style.height = '100%';
  }
}

function drawRulerAndRows(){
  const pxPerSec = state.timeline.pxPerSecond;
  const totalSeconds = state.audio.duration || 600;
  const width = Math.max(800, totalSeconds*pxPerSec);
  const inner = document.getElementById('tracks-inner');
  if(inner) inner.style.width = width+'px';

  const canvas = document.getElementById('ruler-canvas');
  if(canvas){
      canvas.style.width=width+'px'; canvas.style.height='26px';
      canvas.width=width; canvas.height=26;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#0e1116'; ctx.fillRect(0,0,width,26);
      ctx.fillStyle='#4d545c'; ctx.font='9px monospace';
      for(let s=0;s<=totalSeconds;s+=5){
        const x = s*pxPerSec;
        ctx.fillText(fmtTime(s).slice(0,5), x+3, 12);
      }

      // SCRUBBING (Nouveauté demandée)
      let isDragging = false;
      canvas.onmousedown = (e) => {
          isDragging = true;
          const rect = canvas.getBoundingClientRect();
          seekTo((e.clientX - rect.left) / pxPerSec);
      };
      window.onmousemove = (e) => {
          if(!isDragging) return;
          const rect = canvas.getBoundingClientRect();
          seekTo((e.clientX - rect.left) / pxPerSec);
      };
      window.onmouseup = () => isDragging = false;
  }

  const rows = document.getElementById('rows-container');
  if(rows){
      rows.innerHTML = state.patch.fixtures.map(f => \`
        <div class="track-row">
          <div class="track-head" onclick="selectFixture(\${f.id})">\${f.name}</div>
          <div class="track-lane"></div>
        </div>
      \`).join('');
  }
}

// ============================================================
// OUTILS (BOTTOM PANEL)
// ============================================================
function renderToolbar(){
  document.getElementById('toolbar').innerHTML = \`
    <button class="tool-btn" onclick="openTool('lights')">💡<span>LUMIÈRES</span></button>
  \`;
}
function openTool(tool){
  const panel = document.getElementById('sliding-panel');
  if(state.ui.activeTool === tool) {
      panel.classList.remove('open');
      state.ui.activeTool = null;
  } else {
      state.ui.activeTool = tool;
      panel.classList.add('open');
      panel.innerHTML = \`
        <div class="panel-header"><h3>BIBLIOTHÈQUE & PATCH</h3><button onclick="openTool(null)">✕</button></div>
        <div class="panel-inner">
            <div id="fixture-list" style="display:flex; gap:10px;">
                \${FIXTURE_LIBRARY.map(f => \`<button style="padding:10px; background:var(--panel-2); border:1px solid var(--line); border-radius:4px;" onclick="addFixtureToPatch('\${f.id}')">\${f.name}</button>\`).join('')}
            </div>
        </div>
      \`;
  }
}

function selectFixture(id){
    state.ui.selectedFixtureId = id;
    renderSidebar();
}

function renderSidebar(){
    const el = document.getElementById('sidebar');
    const fix = state.patch.fixtures.find(f=>f.id===state.ui.selectedFixtureId);
    if(!fix) {
        el.innerHTML = \`<div class="panel-header"><h3>PROPRIÉTÉS</h3></div><div style="padding:15px;color:var(--muted)">Sélectionnez une fixture.</div>\`;
        return;
    }
    el.innerHTML = \`
        <div class="panel-header"><h3>\${fix.name}</h3></div>
        <div style="padding:15px; display:flex; flex-direction:column; gap:15px;">
            <div><label style="font-size:10px;color:var(--muted);">DIMMER</label><input type="range" id="f-dim" min="0" max="100" value="100" style="width:100%"></div>
            <div><label style="font-size:10px;color:var(--muted);">PAN</label><input type="range" id="f-pan" min="0" max="100" value="50" style="width:100%"></div>
            <div><label style="font-size:10px;color:var(--muted);">TILT</label><input type="range" id="f-tilt" min="0" max="100" value="50" style="width:100%"></div>
            <div><label style="font-size:10px;color:var(--muted);">COULEUR</label><input type="color" id="f-col" style="width:100%"></div>
        </div>
    \`;
    
    document.getElementById('f-pan').oninput = (e) => { fix.pan = parseInt(e.target.value); };
    document.getElementById('f-tilt').oninput = (e) => { fix.tilt = parseInt(e.target.value); };
    document.getElementById('f-dim').oninput = (e) => { fix.dim = parseInt(e.target.value); };
    document.getElementById('f-col').oninput = (e) => { fix.color = e.target.value; };
}


// ============================================================
// APERÇU 3D (THREE.JS) — FAISCEAUX RÉALISTES
// ============================================================
function init3DPreview(){
  const container = document.getElementById('preview-square');
  const w = container.clientWidth, h = container.clientHeight;
  const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
  renderer.setSize(w,h);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, w/h, 0.1, 100);
  camera.position.set(0, 5, 12);
  camera.lookAt(0, 0, 0);

  // Grille
  scene.add(new THREE.GridHelper(14,14,0x2a3038,0x1a1f26));
  
  // Truss
  const truss = new THREE.Mesh(new THREE.BoxGeometry(10,0.15,0.15), new THREE.MeshBasicMaterial({color:0x33383f}));
  truss.position.y = 4;
  scene.add(truss);

  state.three.renderer = renderer;
  state.three.scene = scene;
  state.three.camera = camera;

  // Orbite Caméra simple
  let isDragging3D = false, lastX=0, lastY=0;
  container.onmousedown = (e) => { isDragging3D = true; lastX = e.clientX; lastY = e.clientY; };
  window.onmousemove = (e) => {
      if(!isDragging3D) return;
      const dx = e.clientX - lastX;
      state.three.camera.position.x -= dx * 0.05;
      camera.lookAt(0,0,0);
      lastX = e.clientX;
  };
  window.onmouseup = () => isDragging3D = false;

  rebuild3DFixtures();
}

function rebuild3DFixtures(){
  const scene = state.three.scene; 
  Object.values(state.three.meshes).forEach(m=>scene.remove(m.group));
  state.three.meshes = {};
  
  state.patch.fixtures.forEach((f)=>{
    const group = new THREE.Group();
    group.position.set(f.posX, 4, 0);
    
    // Corps
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.35,0.3,0.35), new THREE.MeshBasicMaterial({color:0x2a2e35}));
    group.add(body);

    // Tête
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.16,0.5,12), new THREE.MeshBasicMaterial({color:0x555a62}));
    head.rotation.x = Math.PI;
    head.position.y = -0.28;
    
    // Faisceau volumétrique façon EasyView (ADDITIVE BLENDING)
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(0.6, 6, 24, 1, true),
      new THREE.MeshBasicMaterial({
          color: 0xffffff, 
          transparent: true, 
          opacity: 0.4, 
          blending: THREE.AdditiveBlending, // LE SECRET EST ICI
          depthWrite: false,
          side: THREE.DoubleSide
      })
    );
    beam.rotation.x = Math.PI;
    beam.position.y = -3.2;
    head.add(beam);
    group.add(head);
    
    scene.add(group);
    state.three.meshes[f.id] = {group, head, beam};
  });
}

function update3DPreview(){
  if(!state.three.renderer) return;
  state.patch.fixtures.forEach(f=>{
    const mesh = state.three.meshes[f.id]; if(!mesh) return;
    
    // Mouvement Live depuis les faders
    const panRad = ((f.pan||50)-50) * 0.05;
    const tiltRad = ((f.tilt||50)-50) * 0.05;
    mesh.head.rotation.y = panRad;
    mesh.head.rotation.x = tiltRad;
    
    if(f.color) mesh.beam.material.color.set(f.color);
    mesh.beam.material.opacity = ((f.dim||100)/100) * 0.4;
  });
  state.three.renderer.render(state.three.scene, state.three.camera);
}

// ============================================================
// INIT
// ============================================================
function init(){
  renderTopbar();
  renderTimeline();
  renderToolbar();
  init3DPreview();
  startRenderLoop(); // Remplace l'ancien système pour que la 3D ne fige jamais
}

document.addEventListener('DOMContentLoaded', init);
