// ============================================================
// LUMEN — Console DMX : état global
// ============================================================
const state = {
  audio: {
    ctx: null,
    buffer: null,
    fileName: null,
    peaks: null,        // waveform peaks (min/max par colonne) précalculés
    duration: 0,
    bpm: null,
    bpmConfidence: null,
    beatOffset: 0,       // décalage du premier beat (s)
    source: null,
    gainNode: null,
    isPlaying: false,
    startedAt: 0,        // ctx.currentTime au moment du dernier play
    startedAtPos: 0,      // position audio (s) au moment du dernier play
    pausedAt: 0,
  },
  tap: { times: [] },
  timeline: {
    pxPerSecond: 60,
    scrollLeft: 0,
    snapToBeat: false,
  },
  library: {
    search: '',
    category: 'all',
  },
  patch: {
    fixtures: [],   // {id, defId, name, universe, address, modeIndex, colorHue}
    nextId: 1,
    selectedId: null,
    universe: 1,
  },
  rafId: null,
};

function fmtTime(s){
  if(!isFinite(s) || s<0) s=0;
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60);
  const ms = Math.floor((s - Math.floor(s))*100);
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
}

function getAudioCtx(){
  if(!state.audio.ctx){
    state.audio.ctx = new (window.AudioContext||window.webkitAudioContext)();
  }
  return state.audio.ctx;
}

function currentPlayhead(){
  const a = state.audio;
  if(!a.buffer) return 0;
  if(a.isPlaying){
    const elapsed = a.ctx.currentTime - a.startedAt;
    return Math.min(a.startedAtPos + elapsed, a.duration);
  }
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
  state.audio.peaks = computePeaks(audioBuffer, 4); // 4 colonnes de pixels / seconde de base
  const result = detectBPM(audioBuffer);
  state.audio.bpm = result.bpm;
  state.audio.bpmConfidence = result.confidence;
  state.audio.beatOffset = result.offset;
  renderHeader();
  renderTimeline();
}

// Précalcule min/max par petites tranches pour un rendu waveform rapide
function computePeaks(buffer, samplesPerSecond){
  const data = buffer.numberOfChannels > 1
    ? mixToMono(buffer)
    : buffer.getChannelData(0);
  const totalCols = Math.ceil(buffer.duration * samplesPerSecond * 30); // résolution fine, on sous-échantillonnera au rendu
  const blockSize = Math.max(1, Math.floor(data.length / totalCols));
  const peaks = new Float32Array(totalCols * 2);
  for(let i=0;i<totalCols;i++){
    let min=1, max=-1;
    const start = i*blockSize;
    const end = Math.min(start+blockSize, data.length);
    for(let j=start;j<end;j++){
      const v = data[j];
      if(v<min) min=v;
      if(v>max) max=v;
    }
    peaks[i*2]=min; peaks[i*2+1]=max;
  }
  return {cols: totalCols, data: peaks, perSecond: totalCols/buffer.duration};
}

function mixToMono(buffer){
  const len = buffer.length;
  const out = new Float32Array(len);
  const n = buffer.numberOfChannels;
  for(let c=0;c<n;c++){
    const ch = buffer.getChannelData(c);
    for(let i=0;i<len;i++) out[i]+=ch[i]/n;
  }
  return out;
}

// ============================================================
// DÉTECTION BPM AUTOMATIQUE
// Méthode : enveloppe d'énergie basse fréquence -> pics d'onset ->
// autocorrélation des intervalles entre pics pour estimer le tempo.
// ============================================================
function detectBPM(buffer){
  const sr = buffer.sampleRate;
  const data = buffer.numberOfChannels>1 ? mixToMono(buffer) : buffer.getChannelData(0);

  // 1) Enveloppe d'énergie (RMS) par fenêtres de ~10ms, avec accent sur les basses
  const hop = Math.floor(sr*0.01);
  const winCount = Math.floor(data.length/hop);
  const energy = new Float32Array(winCount);
  for(let i=0;i<winCount;i++){
    let sum=0;
    const start=i*hop;
    for(let j=0;j<hop;j++){
      const v = data[start+j]||0;
      sum += v*v;
    }
    energy[i] = Math.sqrt(sum/hop);
  }

  // 2) Flux d'énergie (dérivée positive = onset)
  const flux = new Float32Array(winCount);
  for(let i=1;i<winCount;i++){
    const d = energy[i]-energy[i-1];
    flux[i] = d>0 ? d : 0;
  }

  // Lissage léger
  const smooth = new Float32Array(winCount);
  const smoothWin = 3;
  for(let i=0;i<winCount;i++){
    let s=0,c=0;
    for(let k=-smoothWin;k<=smoothWin;k++){
      const idx=i+k;
      if(idx>=0&&idx<winCount){s+=flux[idx];c++;}
    }
    smooth[i]=s/c;
  }

  // 3) Autocorrélation sur la plage de tempo 60–180 BPM
  const framesPerSec = 1/0.01;
  const minBpm=60, maxBpm=180;
  let bestLag=0, bestScore=-Infinity;
  const minLag = Math.floor(framesPerSec*60/maxBpm);
  const maxLag = Math.floor(framesPerSec*60/minBpm);
  for(let lag=minLag; lag<=maxLag; lag++){
    let score=0;
    for(let i=0;i+lag<winCount;i++){
      score += smooth[i]*smooth[i+lag];
    }
    if(score>bestScore){bestScore=score; bestLag=lag;}
  }
  let bpm = bestLag>0 ? 60*framesPerSec/bestLag : 120;

  // Recentrer dans une plage musicale usuelle (évite les octaves ×2 / ÷2 aberrantes)
  while(bpm<80) bpm*=2;
  while(bpm>170) bpm/=2;
  bpm = Math.round(bpm*10)/10;

  // 4) Offset du premier beat : premier onset significatif
  let offsetFrame=0;
  const threshold = Math.max(...smooth)*0.3;
  for(let i=0;i<winCount;i++){
    if(smooth[i]>threshold){offsetFrame=i;break;}
  }
  const offset = offsetFrame/framesPerSec;

  // confiance approximative basée sur le pic d'autocorrélation vs moyenne
  const avgScore = bestScore>0 ? bestScore : 1;
  const confidence = Math.min(100, Math.round((bestScore/(avgScore+1e-9))*35));

  return {bpm, offset, confidence: isFinite(confidence)?confidence:50};
}

// ============================================================
// TRANSPORT (play / pause / stop / seek)
// ============================================================
function playAudio(){
  const a = state.audio;
  if(!a.buffer || a.isPlaying) return;
  const ctx = getAudioCtx();
  if(ctx.state==='suspended') ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = a.buffer;
  const gain = ctx.createGain();
  gain.gain.value = 1;
  src.connect(gain).connect(ctx.destination);
  const offset = a.pausedAt || 0;
  src.start(0, offset);
  src.onended = () => {
    if(a.isPlaying && currentPlayhead()>=a.duration-0.05){
      stopAudio();
    }
  };
  a.source = src;
  a.gainNode = gain;
  a.startedAt = ctx.currentTime;
  a.startedAtPos = offset;
  a.isPlaying = true;
  renderHeader();
  startRAF();
}

function pauseAudio(){
  const a = state.audio;
  if(!a.isPlaying) return;
  a.pausedAt = currentPlayhead();
  try{ a.source.onended=null; a.source.stop(); }catch(e){}
  a.isPlaying = false;
  renderHeader();
  stopRAF();
  renderTimeline();
}

function stopAudio(){
  const a = state.audio;
  try{ if(a.source){a.source.onended=null; a.source.stop();} }catch(e){}
  a.isPlaying = false;
  a.pausedAt = 0;
  renderHeader();
  stopRAF();
  renderTimeline();
}

function seekTo(seconds){
  const a = state.audio;
  if(!a.buffer) return;
  seconds = Math.max(0, Math.min(seconds, a.duration));
  const wasPlaying = a.isPlaying;
  if(wasPlaying){
    try{ a.source.onended=null; a.source.stop(); }catch(e){}
    a.isPlaying=false;
  }
  a.pausedAt = seconds;
  if(wasPlaying) playAudio();
  else { renderHeader(); renderTimeline(); }
}

function startRAF(){
  stopRAF();
  const loop = () => {
    renderHeader(true);
    renderTimeline(true);
    state.rafId = requestAnimationFrame(loop);
  };
  state.rafId = requestAnimationFrame(loop);
}
function stopRAF(){
  if(state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

// ============================================================
// TAP TEMPO
// ============================================================
function tapTempo(){
  const now = performance.now();
  state.tap.times.push(now);
  if(state.tap.times.length>8) state.tap.times.shift();
  if(state.tap.times.length<2) { renderHeader(); return; }
  const intervals=[];
  for(let i=1;i<state.tap.times.length;i++){
    intervals.push(state.tap.times[i]-state.tap.times[i-1]);
  }
  const avg = intervals.reduce((a,b)=>a+b,0)/intervals.length;
  const bpm = Math.round((60000/avg)*10)/10;
  state.audio.bpm = bpm;
  state.audio.bpmConfidence = 100;
  clearTimeout(state.tap._resetTimer);
  state.tap._resetTimer = setTimeout(()=>{state.tap.times=[];},2000);
  renderHeader();
  renderTimeline();
}

// ============================================================
// RENDU — HEADER (transport, BPM, import)
// ============================================================
function renderHeader(skipStructure){
  const el = document.getElementById('header');
  const a = state.audio;
  const pos = currentPlayhead();

  if(!skipStructure || !el.dataset.built){
    el.dataset.built = '1';
    el.innerHTML = `
      <div class="brand"><span class="mark"></span><div><b>LUMEN</b><span style="display:block">CONSOLE DMX</span></div></div>
      <div class="transport">
        <button id="btn-stop" title="Stop">${svgStop()}</button>
        <button id="btn-play" class="play" title="Lecture / Pause">${svgPlay()}</button>
      </div>
      <div class="timecode" id="timecode">00:00.00<span class="sub">TIMECODE</span></div>
      <div class="bpm-block">
        <div class="bpm-value" id="bpm-value">--<span class="lbl">BPM</span></div>
        <div class="bpm-actions">
          <button id="btn-tap">TAP</button>
          <button id="btn-snap">SNAP</button>
        </div>
      </div>
      <div class="file-import">
        <span class="track-name" id="track-name">Aucun fichier</span>
        <label class="import-btn" for="audio-file-input">${svgImport()} Importer audio</label>
        <input type="file" id="audio-file-input" accept="audio/*" style="display:none">
        <div class="proj-actions">
          <button id="btn-export">Exporter projet</button>
          <button id="btn-import-proj">Charger projet</button>
          <input type="file" id="proj-file-input" accept="application/json" style="display:none">
        </div>
      </div>
    `;
    document.getElementById('btn-play').onclick = ()=> a.isPlaying?pauseAudio():playAudio();
    document.getElementById('btn-stop').onclick = stopAudio;
    document.getElementById('btn-tap').onclick = tapTempo;
    document.getElementById('btn-snap').onclick = ()=>{
      state.timeline.snapToBeat = !state.timeline.snapToBeat;
      document.getElementById('btn-snap').classList.toggle('active', state.timeline.snapToBeat);
      renderTimeline();
    };
    document.getElementById('audio-file-input').onchange = (e)=>{
      const f = e.target.files[0];
      if(f) importAudioFile(f);
    };
    document.getElementById('btn-export').onclick = exportProject;
    document.getElementById('btn-import-proj').onclick = ()=>document.getElementById('proj-file-input').click();
    document.getElementById('proj-file-input').onchange = (e)=>{
      const f = e.target.files[0];
      if(f) importProject(f);
    };
  }

  document.getElementById('btn-play').innerHTML = a.isPlaying ? svgPause() : svgPlay();
  document.getElementById('timecode').innerHTML = `${fmtTime(pos)}<span class="sub">TIMECODE</span>`;
  document.getElementById('bpm-value').innerHTML = (a.bpm? a.bpm.toFixed(1) : '--') + '<span class="lbl">BPM</span>';
  document.getElementById('track-name').textContent = a.fileName || 'Aucun fichier';
}

function svgPlay(){return `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;}
function svgPause(){return `<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`;}
function svgStop(){return `<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>`;}
function svgImport(){return `<svg viewBox="0 0 24 24"><path d="M12 3v10.5m0 0l4-4m-4 4l-4-4M5 19h14v2H5z"/></svg>`;}

// ============================================================
// RENDU — TIMELINE (waveform + grille de beats + playhead)
// ============================================================
function renderTimeline(skipStructure){
  const wrap = document.getElementById('timeline-wrap');
  const a = state.audio;

  if(!skipStructure || !wrap.dataset.built){
    wrap.dataset.built = '1';
    wrap.innerHTML = `
      <div class="tl-toolbar">
        <div class="grp">
          <button id="zoom-out">−</button>
          <label style="padding:0 4px;">ZOOM</label>
          <button id="zoom-in">+</button>
        </div>
        <input type="range" class="zoom-range" id="zoom-range" min="10" max="400" value="${state.timeline.pxPerSecond}">
        <div class="grp">
          <button id="beat-grid-toggle" class="active">GRILLE BEAT</button>
        </div>
        <label id="tl-duration" style="margin-left:auto;color:var(--muted);font-family:var(--font-mono);"></label>
      </div>
      <div id="timeline-canvas-wrap">
        <canvas id="timeline-canvas"></canvas>
        <div class="empty-audio" id="empty-audio">
          ${svgWave()}
          <span>IMPORTE UN FICHIER AUDIO POUR COMMENCER</span>
        </div>
      </div>
    `;
    document.getElementById('zoom-in').onclick = ()=> setZoom(state.timeline.pxPerSecond*1.4);
    document.getElementById('zoom-out').onclick = ()=> setZoom(state.timeline.pxPerSecond/1.4);
    document.getElementById('zoom-range').oninput = (e)=> setZoom(parseFloat(e.target.value));
    document.getElementById('beat-grid-toggle').onclick = (e)=>{
      state.timeline.showBeatGrid = state.timeline.showBeatGrid===false ? true : false;
      e.target.classList.toggle('active', state.timeline.showBeatGrid!==false);
      drawTimeline();
    };
    state.timeline.showBeatGrid = true;
    const canvasWrap = document.getElementById('timeline-canvas-wrap');
    canvasWrap.addEventListener('click', (e)=>{
      if(!a.buffer) return;
      const rect = canvasWrap.getBoundingClientRect();
      const x = e.clientX - rect.left + canvasWrap.scrollLeft;
      let t = x/state.timeline.pxPerSecond;
      if(state.timeline.snapToBeat && a.bpm){
        const beatLen = 60/a.bpm;
        const n = Math.round((t-a.beatOffset)/beatLen);
        t = a.beatOffset + n*beatLen;
      }
      seekTo(t);
    });
    window.addEventListener('resize', drawTimeline);
  }

  document.getElementById('empty-audio').style.display = a.buffer ? 'none' : 'flex';
  document.getElementById('tl-duration').textContent = a.buffer ? `DURÉE ${fmtTime(a.duration)}` : '';
  drawTimeline();
}

function setZoom(v){
  v = Math.max(10, Math.min(400, v));
  state.timeline.pxPerSecond = v;
  document.getElementById('zoom-range').value = v;
  drawTimeline();
}

function drawTimeline(){
  const canvas = document.getElementById('timeline-canvas');
  if(!canvas) return;
  const wrap = document.getElementById('timeline-canvas-wrap');
  const a = state.audio;
  const dpr = window.devicePixelRatio || 1;
  const cssHeight = wrap.clientHeight;
  const totalSeconds = a.buffer ? a.duration : 60;
  const cssWidth = Math.max(wrap.clientWidth, totalSeconds*state.timeline.pxPerSecond);

  canvas.style.width = cssWidth+'px';
  canvas.style.height = cssHeight+'px';
  canvas.width = cssWidth*dpr;
  canvas.height = cssHeight*dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssWidth,cssHeight);

  // fond + grille temporelle (secondes)
  ctx.fillStyle = '#0e1116';
  ctx.fillRect(0,0,cssWidth,cssHeight);

  const pxPerSec = state.timeline.pxPerSecond;
  ctx.strokeStyle = '#1d222a';
  ctx.lineWidth = 1;
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.fillStyle = '#4d545c';
  const secStep = pxPerSec<25 ? 10 : (pxPerSec<60?5:1);
  for(let s=0; s<=totalSeconds; s+=secStep){
    const x = Math.round(s*pxPerSec)+0.5;
    ctx.beginPath(); ctx.moveTo(x,18); ctx.lineTo(x,cssHeight); ctx.stroke();
    ctx.fillText(fmtTime(s).slice(0,5), x+3, 12);
  }

  // grille de beats (si BPM détecté et grille activée)
  if(a.buffer && a.bpm && state.timeline.showBeatGrid!==false){
    const beatLen = 60/a.bpm;
    let n=0;
    ctx.strokeStyle = 'rgba(62,214,196,0.28)';
    while(a.beatOffset + n*beatLen < totalSeconds){
      const t = a.beatOffset + n*beatLen;
      const x = Math.round(t*pxPerSec)+0.5;
      const isBar = n%4===0;
      ctx.strokeStyle = isBar ? 'rgba(245,166,35,0.5)' : 'rgba(62,214,196,0.22)';
      ctx.beginPath(); ctx.moveTo(x,18); ctx.lineTo(x,cssHeight); ctx.stroke();
      n++;
    }
  }

  // waveform
  if(a.buffer && a.peaks){
    const {data, perSecond} = a.peaks;
    const midY = 18 + (cssHeight-18)/2;
    const ampScale = (cssHeight-18)/2 - 6;
    ctx.fillStyle = '#3ed6c4';
    ctx.strokeStyle = '#3ed6c4';
    const colsVisible = Math.ceil(cssWidth);
    for(let x=0; x<colsVisible; x++){
      const t = x/pxPerSec;
      const idx = Math.floor(t*perSecond);
      if(idx<0||idx>=data.length/2) continue;
      const min = data[idx*2], max = data[idx*2+1];
      const y1 = midY - max*ampScale;
      const y2 = midY - min*ampScale;
      ctx.fillRect(x, Math.min(y1,y2), 1, Math.max(2,Math.abs(y2-y1)));
    }
    ctx.strokeStyle = '#243139';
    ctx.beginPath(); ctx.moveTo(0,midY); ctx.lineTo(cssWidth,midY); ctx.stroke();
  }

  // playhead
  if(a.buffer){
    const pos = currentPlayhead();
    const x = pos*pxPerSec;
    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,cssHeight); ctx.stroke();
    ctx.fillStyle = '#f5a623';
    ctx.beginPath(); ctx.moveTo(x-5,0); ctx.lineTo(x+5,0); ctx.lineTo(x,8); ctx.closePath(); ctx.fill();

    // auto-scroll pour garder le playhead visible
    if(a.isPlaying){
      const wrapEl = wrap;
      const viewLeft = wrapEl.scrollLeft;
      const viewRight = viewLeft + wrapEl.clientWidth;
      if(x<viewLeft+40 || x>viewRight-40){
        wrapEl.scrollLeft = Math.max(0, x - wrapEl.clientWidth*0.3);
      }
    }
  }
}

function svgWave(){return `<svg viewBox="0 0 24 24"><path d="M2 12h2v3H2zm4-5h2v8H6zm4-4h2v16h-2zm4 6h2v5h-2zm4-3h2v8h-2z"/></svg>`;}

// ============================================================
// BIBLIOTHÈQUE DE FIXTURES
// ============================================================
const FIXTURE_LIBRARY = [
  { id:'par-rgbw', name:'PAR LED RGBW', category:'par', hue:200,
    modes:[
      {name:'4ch Basique', channels:['Rouge','Vert','Bleu','Blanc']},
      {name:'6ch Dimmer+Strobe', channels:['Dimmer','Rouge','Vert','Bleu','Blanc','Strobe']},
      {name:'8ch Complet', channels:['Dimmer','Rouge','Vert','Bleu','Blanc','Strobe','Programme','Vitesse']},
    ]},
  { id:'par-rgbaw-uv', name:'PAR LED RGBAW+UV', category:'par', hue:200,
    modes:[
      {name:'6ch Basique', channels:['Rouge','Vert','Bleu','Ambre','Blanc','UV']},
      {name:'8ch Complet', channels:['Dimmer','Rouge','Vert','Bleu','Ambre','Blanc','UV','Strobe']},
    ]},
  { id:'par-can-classic', name:'PAR 64 Classique', category:'par', hue:200,
    modes:[{name:'1ch Dimmer', channels:['Dimmer']}]},
  { id:'moving-wash', name:'Lyre Wash LED', category:'wash', hue:150,
    modes:[
      {name:'8ch Standard', channels:['Pan','Tilt','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc']},
      {name:'12ch Étendu', channels:['Pan','Tilt','Pan Fine','Tilt Fine','Vitesse PT','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc','Zoom']},
      {name:'16ch Pro', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc','Ambre','UV','Zoom','Programme','Reset']},
    ]},
  { id:'moving-spot', name:'Lyre Spot LED', category:'spot', hue:280,
    modes:[
      {name:'14ch Standard', channels:['Pan','Tilt','Pan Fine','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Gobo1','Gobo2','Focus','Prisme','Zoom','Reset']},
      {name:'18ch Pro', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc','Gobo1','Gobo2','Rotation Gobo','Focus','Prisme','Zoom','Reset']},
    ]},
  { id:'moving-beam', name:'Lyre Beam 230', category:'beam', hue:330,
    modes:[
      {name:'13ch Standard', channels:['Pan','Tilt','Pan Fine','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Gobo','Rotation Gobo','Prisme','Focus','Reset']},
      {name:'16ch Pro', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Couleur Fine','Gobo','Rotation Gobo','Prisme','Rotation Prisme','Focus','Frost','Reset']},
    ]},
  { id:'moving-hybrid', name:'Lyre Hybride Spot/Wash/Beam', category:'spot', hue:280,
    modes:[{name:'20ch Pro', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc','CTO','Gobo','Rotation Gobo','Prisme','Focus','Zoom','Frost','Programme','Reset']}]},
  { id:'led-bar-pixel', name:'Bar LED Pixel RGB', category:'bar', hue:20,
    modes:[
      {name:'3ch Global', channels:['Rouge','Vert','Bleu']},
      {name:'Pixel 8x RGB (24ch)', channels:Array.from({length:8},(_,i)=>[`Px${i+1} R`,`Px${i+1} V`,`Px${i+1} B`]).flat()},
    ]},
  { id:'led-bar-wash', name:'Bar Wash LED Asymétrique', category:'bar', hue:20,
    modes:[{name:'7ch', channels:['Dimmer','Rouge','Vert','Bleu','Blanc','Strobe','Angle']}]},
  { id:'strobe', name:'Strobe LED', category:'strobe', hue:0,
    modes:[
      {name:'2ch Basique', channels:['Dimmer','Vitesse Flash']},
      {name:'4ch Couleur', channels:['Dimmer','Vitesse Flash','Couleur','Programme']},
    ]},
  { id:'blinder', name:'Blinder LED 4 lampes', category:'blinder', hue:45,
    modes:[{name:'2ch', channels:['Dimmer','Strobe']}]},
  { id:'fog-machine', name:'Machine à fumée', category:'fog', hue:190,
    modes:[
      {name:'1ch Simple', channels:['Sortie Fumée']},
      {name:'2ch Timer', channels:['Sortie Fumée','Minuteur']},
    ]},
  { id:'haze-machine', name:'Machine à haze', category:'fog', hue:190,
    modes:[{name:'2ch', channels:['Sortie Haze','Ventilateur']}]},
  { id:'laser-rgb', name:'Laser RGB Animation', category:'laser', hue:120,
    modes:[{name:'8ch DMX', channels:['Mode','Programme','Vitesse Programme','Rotation X','Rotation Y','Zoom','Couleur','Strobe']}]},
  { id:'uv-bar', name:'Bar UV Fluo', category:'bar', hue:270,
    modes:[{name:'1ch', channels:['Dimmer UV']}]},
  { id:'pixel-matrix', name:'Matrice LED Pixel 8x8', category:'pixel', hue:20,
    modes:[
      {name:'Global RGB (3ch)', channels:['Rouge','Vert','Bleu']},
      {name:'Contrôle 4 zones (12ch)', channels:Array.from({length:4},(_,i)=>[`Zone${i+1} R`,`Zone${i+1} V`,`Zone${i+1} B`]).flat()},
    ]},
  { id:'follow-spot', name:'Poursuite LED', category:'spot', hue:280,
    modes:[{name:'6ch', channels:['Dimmer','Strobe','Zoom','Focus','Iris','CTO']}]},
  { id:'dimmer-pack', name:'Bloc Gradateur 6ch', category:'other', hue:60,
    modes:[{name:'6ch Direct', channels:['Canal 1','Canal 2','Canal 3','Canal 4','Canal 5','Canal 6']}]},
];

const CATEGORY_LABELS = {
  all:'Tout', par:'PAR', wash:'Wash', spot:'Spot/Poursuite', beam:'Beam',
  bar:'Bar/Pixel', strobe:'Strobe', fog:'Fumée/Haze', laser:'Laser',
  blinder:'Blinder', pixel:'Matrice', other:'Autre'
};

function getFixtureDef(defId){ return FIXTURE_LIBRARY.find(f=>f.id===defId); }

// ============================================================
// RENDU — BIBLIOTHÈQUE (gauche)
// ============================================================
function renderLibrary(){
  const el = document.getElementById('library');
  const cats = ['all', ...Array.from(new Set(FIXTURE_LIBRARY.map(f=>f.category)))];

  el.innerHTML = `
    <div class="panel-title"><span>BIBLIOTHÈQUE</span><span>${FIXTURE_LIBRARY.length} modèles</span></div>
    <div class="search-box"><input type="text" id="lib-search" placeholder="Rechercher une fixture..."></div>
    <div class="cat-tabs" id="cat-tabs">
      ${cats.map(c=>`<button data-cat="${c}" class="${c===state.library.category?'active':''}">${CATEGORY_LABELS[c]||c}</button>`).join('')}
    </div>
    <div id="fixture-list"></div>
  `;
  document.getElementById('lib-search').oninput = (e)=>{
    state.library.search = e.target.value.toLowerCase();
    renderFixtureList();
  };
  document.getElementById('cat-tabs').onclick = (e)=>{
    const btn = e.target.closest('button[data-cat]');
    if(!btn) return;
    state.library.category = btn.dataset.cat;
    el.querySelectorAll('#cat-tabs button').forEach(b=>b.classList.toggle('active', b===btn));
    renderFixtureList();
  };
  renderFixtureList();
}

function renderFixtureList(){
  const list = document.getElementById('fixture-list');
  const {search, category} = state.library;
  const items = FIXTURE_LIBRARY.filter(f=>{
    if(category!=='all' && f.category!==category) return false;
    if(search && !f.name.toLowerCase().includes(search)) return false;
    return true;
  });
  if(items.length===0){
    list.innerHTML = `<div class="empty-patch">Aucune fixture trouvée</div>`;
    return;
  }
  list.innerHTML = items.map(f=>`
    <div class="fixture-card" draggable="true" data-def="${f.id}">
      <div class="name">${f.name}</div>
      <div class="meta"><span>${f.modes.length} mode${f.modes.length>1?'s':''}</span><b>${f.modes[0].channels.length}–${f.modes[f.modes.length-1].channels.length} ch</b></div>
      <span class="icon-tag">${CATEGORY_LABELS[f.category]}</span>
    </div>
  `).join('');
  list.querySelectorAll('.fixture-card').forEach(card=>{
    card.addEventListener('dragstart', (e)=>{
      e.dataTransfer.setData('text/plain', card.dataset.def);
    });
    card.addEventListener('dblclick', ()=> addFixtureToPatch(card.dataset.def));
  });
}

// ============================================================
// PATCH — logique
// ============================================================
function nextFreeAddress(universe, channelCount){
  const used = state.patch.fixtures
    .filter(f=>f.universe===universe)
    .map(f=>({start:f.address, end:f.address+getFixtureDef(f.defId).modes[f.modeIndex].channels.length-1}))
    .sort((a,b)=>a.start-b.start);
  let addr = 1;
  for(const u of used){
    if(addr+channelCount-1 < u.start) break;
    if(addr <= u.end) addr = u.end+1;
  }
  if(addr+channelCount-1>512) addr=1;
  return addr;
}

function addFixtureToPatch(defId){
  const def = getFixtureDef(defId);
  if(!def) return;
  const modeIndex = 0;
  const chCount = def.modes[modeIndex].channels.length;
  const universe = state.patch.universe;
  const address = nextFreeAddress(universe, chCount);
  const existingCount = state.patch.fixtures.filter(f=>f.defId===defId).length;
  const fixture = {
    id: state.patch.nextId++,
    defId, modeIndex, universe, address,
    name: `${def.name} ${existingCount+1}`,
    hue: def.hue,
  };
  state.patch.fixtures.push(fixture);
  state.patch.selectedId = fixture.id;
  renderPatch();
  renderInspector();
}

function removeFixture(id){
  state.patch.fixtures = state.patch.fixtures.filter(f=>f.id!==id);
  if(state.patch.selectedId===id) state.patch.selectedId=null;
  renderPatch();
  renderInspector();
}

function fixtureChannelSpan(f){
  const def = getFixtureDef(f.defId);
  const count = def.modes[f.modeIndex].channels.length;
  return {start:f.address, end:f.address+count-1, count};
}

function computeConflicts(){
  const conflicts = new Set();
  const byUniverse = {};
  state.patch.fixtures.forEach(f=>{
    (byUniverse[f.universe] = byUniverse[f.universe]||[]).push(f);
  });
  Object.values(byUniverse).forEach(list=>{
    for(let i=0;i<list.length;i++){
      const a = fixtureChannelSpan(list[i]);
      for(let j=i+1;j<list.length;j++){
        const b = fixtureChannelSpan(list[j]);
        if(a.start<=b.end && b.start<=a.end){
          conflicts.add(list[i].id); conflicts.add(list[j].id);
        }
      }
    }
  });
  return conflicts;
}

// ============================================================
// RENDU — PATCH (tableau)
// ============================================================
function renderPatch(){
  const wrap = document.getElementById('patch-wrap');
  if(!wrap.dataset.built){
    wrap.dataset.built='1';
    wrap.innerHTML = `
      <div class="patch-toolbar">
        <span class="count"><b id="patch-count">0</b> fixtures patchées</span>
        <div class="universe-select">
          <label>UNIVERS ACTIF</label>
          <select id="universe-select">
            ${Array.from({length:8},(_,i)=>i+1).map(u=>`<option value="${u}">Univers ${u}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="patch-table-wrap"></div>
    `;
    document.getElementById('universe-select').onchange = (e)=>{
      state.patch.universe = parseInt(e.target.value);
    };
    const tw = document.getElementById('patch-table-wrap');
    tw.addEventListener('dragover', (e)=>e.preventDefault());
    tw.addEventListener('drop', (e)=>{
      e.preventDefault();
      const defId = e.dataTransfer.getData('text/plain');
      if(defId) addFixtureToPatch(defId);
    });
  }
  document.getElementById('patch-count').textContent = state.patch.fixtures.length;
  const conflicts = computeConflicts();
  const tableWrap = document.getElementById('patch-table-wrap');

  if(state.patch.fixtures.length===0){
    tableWrap.innerHTML = `<div class="empty-patch">Glisse une fixture depuis la bibliothèque, ou double-clique dessus,<br>pour l'ajouter au patch.</div>`;
    return;
  }

  tableWrap.innerHTML = `
    <table class="patch-table">
      <thead><tr>
        <th>Nom</th><th>Modèle</th><th>Univers</th><th>Adresse</th><th>Mode</th><th>Canaux</th><th></th>
      </tr></thead>
      <tbody>
        ${state.patch.fixtures.map(f=>{
          const def = getFixtureDef(f.defId);
          const span = fixtureChannelSpan(f);
          const isConflict = conflicts.has(f.id);
          const isSelected = state.patch.selectedId===f.id;
          return `<tr data-id="${f.id}" class="${isConflict?'conflict':''} ${isSelected?'selected':''}">
            <td class="name-cell"><span class="color-dot" style="background:hsl(${f.hue} 70% 55%)"></span>
              <input type="text" class="fname-input" data-id="${f.id}" value="${f.name}" style="width:130px;background:transparent;border:none;color:inherit;padding:2px;">
            </td>
            <td>${def.name}</td>
            <td><input type="number" min="1" max="8" class="universe-input" data-id="${f.id}" value="${f.universe}"></td>
            <td><input type="number" min="1" max="512" class="address-input" data-id="${f.id}" value="${f.address}"></td>
            <td>
              <select class="mode-select" data-id="${f.id}">
                ${def.modes.map((m,i)=>`<option value="${i}" ${i===f.modeIndex?'selected':''}>${m.name}</option>`).join('')}
              </select>
            </td>
            <td class="chan-range">${span.start}–${span.end}</td>
            <td><button class="del-btn" data-id="${f.id}" title="Supprimer">✕</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll('tr[data-id]').forEach(tr=>{
    tr.addEventListener('click', (e)=>{
      if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='BUTTON') return;
      state.patch.selectedId = parseInt(tr.dataset.id);
      renderPatch(); renderInspector();
    });
  });
  tableWrap.querySelectorAll('.fname-input').forEach(inp=>{
    inp.addEventListener('change', (e)=>{
      const f = state.patch.fixtures.find(x=>x.id===parseInt(e.target.dataset.id));
      f.name = e.target.value || f.name;
      renderInspector();
    });
  });
  tableWrap.querySelectorAll('.universe-input').forEach(inp=>{
    inp.addEventListener('change', (e)=>{
      const f = state.patch.fixtures.find(x=>x.id===parseInt(e.target.dataset.id));
      f.universe = Math.max(1, Math.min(8, parseInt(e.target.value)||1));
      renderPatch(); renderInspector();
    });
  });
  tableWrap.querySelectorAll('.address-input').forEach(inp=>{
    inp.addEventListener('change', (e)=>{
      const f = state.patch.fixtures.find(x=>x.id===parseInt(e.target.dataset.id));
      f.address = Math.max(1, Math.min(512, parseInt(e.target.value)||1));
      renderPatch(); renderInspector();
    });
  });
  tableWrap.querySelectorAll('.mode-select').forEach(sel=>{
    sel.addEventListener('change', (e)=>{
      const f = state.patch.fixtures.find(x=>x.id===parseInt(e.target.dataset.id));
      f.modeIndex = parseInt(e.target.value);
      renderPatch(); renderInspector();
    });
  });
  tableWrap.querySelectorAll('.del-btn').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      removeFixture(parseInt(btn.dataset.id));
    });
  });
}

// ============================================================
// RENDU — INSPECTEUR (droite)
// ============================================================
function renderInspector(){
  const el = document.getElementById('inspector');
  const f = state.patch.fixtures.find(x=>x.id===state.patch.selectedId);
  if(!f){
    el.innerHTML = `<div class="insp-empty">Sélectionne une fixture patchée<br>pour voir son détail DMX.</div>`;
    return;
  }
  const def = getFixtureDef(f.defId);
  const mode = def.modes[f.modeIndex];
  el.innerHTML = `
    <div class="insp-header">
      <div class="fname">${f.name}</div>
      <div class="ftype">${def.name.toUpperCase()} · ${CATEGORY_LABELS[def.category]}</div>
    </div>
    <div class="insp-section">
      <h4>ADRESSAGE</h4>
      <div class="insp-field"><label>Univers</label><span>${f.universe}</span></div>
      <div class="insp-field"><label>Adresse de départ</label><span>${f.address}</span></div>
      <div class="insp-field"><label>Mode</label><span>${mode.name}</span></div>
      <div class="insp-field"><label>Nombre de canaux</label><span>${mode.channels.length}</span></div>
    </div>
    <div class="insp-section">
      <h4>MAPPING DES CANAUX</h4>
      <div class="channel-map">
        ${mode.channels.map((ch,i)=>`
          <div class="channel-row">
            <span class="ch-num">${f.address+i}</span>
            <span class="ch-name">${ch}</span>
            <span class="ch-val">000</span>
          </div>`).join('')}
      </div>
    </div>
  `;
}

// ============================================================
// PROJET — export / import JSON
// ============================================================
function exportProject(){
  const data = {
    version:1,
    audioFileName: state.audio.fileName,
    bpm: state.audio.bpm,
    beatOffset: state.audio.beatOffset,
    patch: state.patch.fixtures,
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lumen-projet.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importProject(file){
  try{
    const text = await file.text();
    const data = JSON.parse(text);
    if(data.patch){
      state.patch.fixtures = data.patch;
      state.patch.nextId = Math.max(1,...data.patch.map(f=>f.id))+1;
    }
    if(data.bpm) state.audio.bpm = data.bpm;
    if(data.beatOffset!=null) state.audio.beatOffset = data.beatOffset;
    renderHeader(); renderPatch(); renderInspector(); renderTimeline();
  }catch(err){
    alert('Fichier de projet invalide.');
  }
}

// ============================================================
// INIT
// ============================================================
function init(){
  renderHeader();
  renderLibrary();
  renderTimeline();
  renderPatch();
  renderInspector();
}
document.addEventListener('DOMContentLoaded', init);
if(document.readyState!=='loading') init();
