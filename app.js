// ============================================================
// LUMEN — Console DMX : état global
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
  three:{ renderer:null, scene:null, camera:null, meshes:{}, orbit:{az:0.6, el:0.55, dist:9} },
  rafId:null,
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
  if(!a.buffer) return 0;
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

// ============================================================
// DÉTECTION BPM (enveloppe d'énergie + autocorrélation)
// ============================================================
function detectBPM(buffer){
  const sr = buffer.sampleRate;
  const data = buffer.numberOfChannels>1 ? mixToMono(buffer) : buffer.getChannelData(0);
  const hop = Math.floor(sr*0.01);
  const winCount = Math.floor(data.length/hop);
  const energy = new Float32Array(winCount);
  for(let i=0;i<winCount;i++){
    let sum=0; const start=i*hop;
    for(let j=0;j<hop;j++){ const v=data[start+j]||0; sum+=v*v; }
    energy[i]=Math.sqrt(sum/hop);
  }
  const flux=new Float32Array(winCount);
  for(let i=1;i<winCount;i++){ const d=energy[i]-energy[i-1]; flux[i]=d>0?d:0; }
  const smooth=new Float32Array(winCount);
  for(let i=0;i<winCount;i++){
    let s=0,c=0;
    for(let k=-3;k<=3;k++){ const idx=i+k; if(idx>=0&&idx<winCount){s+=flux[idx];c++;} }
    smooth[i]=s/c;
  }
  const framesPerSec=100, minBpm=60, maxBpm=180;
  let bestLag=0, bestScore=-Infinity;
  const minLag=Math.floor(framesPerSec*60/maxBpm), maxLag=Math.floor(framesPerSec*60/minBpm);
  for(let lag=minLag; lag<=maxLag; lag++){
    let score=0;
    for(let i=0;i+lag<winCount;i++) score+=smooth[i]*smooth[i+lag];
    if(score>bestScore){bestScore=score; bestLag=lag;}
  }
  let bpm = bestLag>0 ? 60*framesPerSec/bestLag : 120;
  while(bpm<80) bpm*=2;
  while(bpm>170) bpm/=2;
  bpm = Math.round(bpm*10)/10;
  let offsetFrame=0;
  const threshold = Math.max(...smooth)*0.3;
  for(let i=0;i<winCount;i++){ if(smooth[i]>threshold){offsetFrame=i;break;} }
  const offset = offsetFrame/framesPerSec;
  const confidence = Math.min(100, Math.round((bestScore/(bestScore>0?bestScore:1))*35));
  return {bpm, offset, confidence:isFinite(confidence)?confidence:50};
}

// ============================================================
// TRANSPORT
// ============================================================
function playAudio(){
  const a=state.audio;
  if(!a.buffer||a.isPlaying) return;
  const ctx=getAudioCtx();
  if(ctx.state==='suspended') ctx.resume();
  const src=ctx.createBufferSource();
  src.buffer=a.buffer;
  const gain=ctx.createGain(); gain.gain.value=1;
  src.connect(gain).connect(ctx.destination);
  const offset=a.pausedAt||0;
  src.start(0,offset);
  src.onended=()=>{ if(a.isPlaying && currentPlayhead()>=a.duration-0.05) stopAudio(); };
  a.source=src; a.gainNode=gain;
  a.startedAt=ctx.currentTime; a.startedAtPos=offset; a.isPlaying=true;
  renderTopbar(); startRAF();
}
function pauseAudio(){
  const a=state.audio; if(!a.isPlaying) return;
  a.pausedAt=currentPlayhead();
  try{ a.source.onended=null; a.source.stop(); }catch(e){}
  a.isPlaying=false; renderTopbar(); stopRAF(); renderTimeline();
}
function stopAudio(){
  const a=state.audio;
  try{ if(a.source){a.source.onended=null; a.source.stop();} }catch(e){}
  a.isPlaying=false; a.pausedAt=0; renderTopbar(); stopRAF(); renderTimeline();
}
function seekTo(seconds){
  const a=state.audio; if(!a.buffer) return;
  seconds=clamp(seconds,0,a.duration);
  const wasPlaying=a.isPlaying;
  if(wasPlaying){ try{a.source.onended=null; a.source.stop();}catch(e){} a.isPlaying=false; }
  a.pausedAt=seconds;
  if(wasPlaying) playAudio(); else { renderTopbar(); renderTimeline(); }
}
function startRAF(){
  stopRAF();
  const loop=()=>{ renderTopbar(true); renderTimeline(true); update3DPreview(); state.rafId=requestAnimationFrame(loop); };
  state.rafId=requestAnimationFrame(loop);
}
function stopRAF(){ if(state.rafId) cancelAnimationFrame(state.rafId); state.rafId=null; }

function setManualBpm(bpm){
  if(!isFinite(bpm) || bpm<=0) return;
  bpm = clamp(bpm, 20, 300);
  state.audio.bpm = Math.round(bpm*10)/10;
  state.audio.bpmConfidence = 100; // saisi manuellement = confiance totale
  state.audio.beatOffset = state.audio.beatOffset || 0;
  renderTopbar(); renderTimeline();
  const panel = document.getElementById('sliding-panel');
  if(panel && panel.classList.contains('open') && state.ui.activeTool==='music') renderMusicPanel(panel);
}

function tapTempo(){
  const now=performance.now();
  // si la dernière frappe date de plus de 2s, on recommence une nouvelle série
  if(state.tap.times.length && now-state.tap.times[state.tap.times.length-1]>2000) state.tap.times=[];
  state.tap.times.push(now);
  if(state.tap.times.length>8) state.tap.times.shift();
  flashTapButtons();
  if(state.tap.times.length<2){ renderTopbar(); return; }
  const intervals=[];
  for(let i=1;i<state.tap.times.length;i++) intervals.push(state.tap.times[i]-state.tap.times[i-1]);
  const avg=intervals.reduce((a,b)=>a+b,0)/intervals.length;
  state.audio.bpm=Math.round((60000/avg)*10)/10;
  state.audio.bpmConfidence=100;
  clearTimeout(state.tap._resetTimer);
  state.tap._resetTimer=setTimeout(()=>{state.tap.times=[];},2000);
  renderTopbar(); renderTimeline();
  const panel = document.getElementById('sliding-panel');
  if(panel && panel.classList.contains('open') && state.ui.activeTool==='music') renderMusicPanel(panel);
}
function flashTapButtons(){
  document.querySelectorAll('#btn-tap, #btn-tap-2').forEach(btn=>{
    if(!btn) return;
    btn.style.background='var(--amber)'; btn.style.color='#1a1200';
    setTimeout(()=>{ btn.style.background=''; btn.style.color=''; }, 110);
  });
}

// ============================================================
// BIBLIOTHÈQUE DE FIXTURES
// Modèles génériques + modèles inspirés de vraies marques (Robe, Martin,
// Clay Paky, Chauvet, ADJ, GLP, Elation, JB-Lighting...).
// NOTE : ce ne sont pas des exports littéraux de la librairie Avolites
// (fichiers .d4 propriétaires, non accessibles individuellement) mais des
// layouts de canaux réalistes basés sur les modes DMX habituels de ces
// familles de produits. Modifiable dans le mapping de canaux si besoin.
// ============================================================
const FIXTURE_LIBRARY = [
  // ---- GÉNÉRIQUES ----
  { id:'par-rgbw', name:'PAR LED RGBW', brand:'Générique', category:'par', hue:200,
    modes:[
      {name:'4ch Basique', channels:['Rouge','Vert','Bleu','Blanc']},
      {name:'6ch Dimmer+Strobe', channels:['Dimmer','Rouge','Vert','Bleu','Blanc','Strobe']},
      {name:'8ch Complet', channels:['Dimmer','Rouge','Vert','Bleu','Blanc','Strobe','Programme','Vitesse']},
    ]},
  { id:'par-rgbaw-uv', name:'PAR LED RGBAW+UV', brand:'Générique', category:'par', hue:200,
    modes:[{name:'8ch Complet', channels:['Dimmer','Rouge','Vert','Bleu','Ambre','Blanc','UV','Strobe']}]},
  { id:'dimmer-pack', name:'Bloc Gradateur 6ch', brand:'Générique', category:'other', hue:60,
    modes:[{name:'6ch Direct', channels:['Canal 1','Canal 2','Canal 3','Canal 4','Canal 5','Canal 6']}]},

  // ---- ROBE ----
  { id:'robe-pointe', name:'Robin Pointe', brand:'Robe', category:'beam', hue:330,
    modes:[
      {name:'Standard 16bit (23ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Couleur Fine','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme','Rotation Prisme','Focus','Frost','Zoom','Zoom Fine','Animation','Iris','CTO','Programme','Reset']},
    ]},
  { id:'robe-viva-wash', name:'Viva CMY Wash', brand:'Robe', category:'wash', hue:150,
    modes:[{name:'18ch Pro', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Cyan','Magenta','Jaune','CTO','Zoom','Zoom Fine','Frost','Rouge','Vert','Bleu','Reset']}]},
  { id:'robe-megapointe', name:'MegaPointe', brand:'Robe', category:'spot', hue:280,
    modes:[{name:'25ch Pro', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','CTO','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme 1','Prisme 2','Rotation Prisme','Focus','Zoom','Zoom Fine','Frost 1','Frost 2','Animation','Iris','Iris Vitesse','Programme','Reset']}]},

  // ---- MARTIN ----
  { id:'martin-mac-aura', name:'MAC Aura XB', brand:'Martin', category:'wash', hue:150,
    modes:[{name:'Extended (16ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc','CTO','Zoom','Effet Anneau','Vitesse Effet','Reset']}]},
  { id:'martin-mac-viper', name:'MAC Viper Performance', brand:'Martin', category:'beam', hue:330,
    modes:[{name:'Standard (28ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Couleur Fine','CTO','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme','Rotation Prisme','Focus','Focus Fine','Zoom','Zoom Fine','Frost','Iris','Iris Vitesse','Animation 1','Animation 2','Macro','Vitesse Macro','Programme','Reset']}]},
  { id:'martin-rush-par', name:'RUSH PAR 2 RGBW', brand:'Martin', category:'par', hue:200,
    modes:[{name:'5ch', channels:['Dimmer','Rouge','Vert','Bleu','Blanc']}]},

  // ---- CLAY PAKY ----
  { id:'claypaky-sharpy', name:'Sharpy', brand:'Clay Paky', category:'beam', hue:330,
    modes:[{name:'Standard (16ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Gobo','Rotation Gobo','Prisme','Rotation Prisme','Focus','Programme','Reset','Lampe']}]},
  { id:'claypaky-mythos', name:'Mythos', brand:'Clay Paky', category:'spot', hue:280,
    modes:[{name:'Standard (30ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','CMY Cyan','CMY Magenta','CMY Jaune','CTO','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme','Rotation Prisme','Frost 1','Frost 2','Focus','Zoom','Zoom Fine','Iris','Animation','Vitesse Animation','Effet','Macro','Vitesse Macro','Dimmer Fine','Programme','Reset']}]},

  // ---- CHAUVET ----
  { id:'chauvet-rogue-r2', name:'Rogue R2 Spot', brand:'Chauvet', category:'spot', hue:280,
    modes:[{name:'Standard (17ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme','Focus','Frost','Zoom','Programme','Reset']}]},
  { id:'chauvet-colorado', name:'COLORado PXL Bar', brand:'Chauvet', category:'bar', hue:20,
    modes:[{name:'Pixel 12x RGBW (48ch)', channels:Array.from({length:12},(_,i)=>[`Px${i+1} R`,`Px${i+1} V`,`Px${i+1} B`,`Px${i+1} Bl`]).flat()}]},
  { id:'chauvet-strike4', name:'Strike 4 Blinder/Strobe', brand:'Chauvet', category:'strobe', hue:0,
    modes:[{name:'6ch', channels:['Dimmer','Strobe','Rouge','Vert','Bleu','Blanc']}]},

  // ---- ADJ ----
  { id:'adj-vizi-beam', name:'Vizi Beam 5RX', brand:'ADJ', category:'beam', hue:330,
    modes:[{name:'Standard (16ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Gobo','Rotation Gobo','Prisme','Focus','Frost','Programme','Vitesse Programme','Reset']}]},
  { id:'adj-inno-pocket', name:'Inno Pocket Spot', brand:'ADJ', category:'spot', hue:280,
    modes:[{name:'11ch', channels:['Pan','Tilt','Vitesse PT','Dimmer','Strobe','Couleur','Gobo','Focus','Prisme','Programme','Reset']}]},
  { id:'adj-flat-par', name:'Flat PAR TW12', brand:'ADJ', category:'par', hue:200,
    modes:[{name:'4ch', channels:['Dimmer','Strobe','Blanc Chaud','Blanc Froid']}]},

  // ---- GLP ----
  { id:'glp-jdc1', name:'JDC1 (Strobe/Blinder hybride)', brand:'GLP', category:'strobe', hue:0,
    modes:[{name:'8ch', channels:['Dimmer Haut','Dimmer Bas','Strobe','Rouge','Vert','Bleu','Blanc','Programme']}]},
  { id:'glp-impression-x4', name:'Impression X4 Wash', brand:'GLP', category:'wash', hue:150,
    modes:[{name:'Standard (20ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc','CTO','Zoom','Zoom Fine','Effet Pixel','Vitesse Effet','Frost','Programme','Macro','Reset']}]},

  // ---- ELATION ----
  { id:'elation-platinum-hfx', name:'Platinum HFX', brand:'Elation', category:'beam', hue:330,
    modes:[{name:'Standard (20ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme','Rotation Prisme','Focus','Zoom','Frost','Animation','Programme','Vitesse Programme','Reset']}]},
  { id:'elation-cuepix', name:'CuePix Blinder Pixel', brand:'Elation', category:'bar', hue:20,
    modes:[{name:'Pixel 4x RGB (12ch)', channels:Array.from({length:4},(_,i)=>[`Px${i+1} R`,`Px${i+1} V`,`Px${i+1} B`]).flat()}]},

  // ---- JB-LIGHTING ----
  { id:'jb-varyscan', name:'Varyscan P9', brand:'JB-Lighting', category:'spot', hue:280,
    modes:[{name:'Standard (24ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','CMY Cyan','CMY Magenta','CMY Jaune','CTO','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme','Focus','Zoom','Zoom Fine','Frost','Iris','Animation','Macro','Programme','Reset']}]},

  // ---- AYRTON ----
  { id:'ayrton-perfo', name:'Perfo S', brand:'Ayrton', category:'beam', hue:330,
    modes:[{name:'Standard (26ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Couleur Fine','CTO','Gobo','Rotation Gobo','Prisme 1','Prisme 2','Focus','Zoom','Zoom Fine','Frost','Iris','Animation','Vitesse Animation','Macro','Vitesse Macro','Effet Pixel','Programme','Reset']}]},
  { id:'ayrton-diablo', name:'Diablo', brand:'Ayrton', category:'wash', hue:150,
    modes:[{name:'Standard (22ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc','CTO','Zoom','Zoom Fine','Effet Pixel','Vitesse Effet','Frost','Macro','Vitesse Macro','Programme','Groupe Pixel','Reset']}]},

  // ---- VARI-LITE ----
  { id:'varilite-vl3500', name:'VL3500 Spot', brand:'Vari-Lite', category:'spot', hue:280,
    modes:[{name:'Standard (28ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','CMY Cyan','CMY Magenta','CMY Jaune','CTO','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme','Rotation Prisme','Iris','Iris Vitesse','Focus','Zoom','Zoom Fine','Frost','Animation','Macro','Vitesse Macro','Dimmer Fine','Programme','Reset']}]},

  // ---- HIGH END SYSTEMS ----
  { id:'hes-shapeshifter', name:'SHAPESHIFTER', brand:'High End Systems', category:'wash', hue:150,
    modes:[{name:'Standard (30ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Rouge','Vert','Bleu','Blanc','Ambre','UV','Zoom','Zoom Fine','Effet Pixel 1','Effet Pixel 2','Vitesse Effet','Frost','Macro','Vitesse Macro','Groupe','Rotation Tete','Programme','Reset','Fan','Config1','Config2','Config3','Config4']}]},

  // ---- SGM ----
  { id:'sgm-p6', name:'P-6 Strobe/Blinder', brand:'SGM', category:'strobe', hue:0,
    modes:[{name:'8ch', channels:['Dimmer','Strobe','Vitesse Strobe','Rouge','Vert','Bleu','Blanc','Programme']}]},

  // ---- CHROMA-Q ----
  { id:'chromaq-color-force', name:'Color Force II 72', brand:'Chroma-Q', category:'bar', hue:20,
    modes:[{name:'8ch RGBAL+Dimmer', channels:['Dimmer','Rouge','Vert','Bleu','Ambre','Lime','Strobe','Programme']}]},

  // ---- ASTERA ----
  { id:'astera-titan-tube', name:'Titan Tube (sans fil)', brand:'Astera', category:'bar', hue:20,
    modes:[{name:'8ch RGBMA+Dimmer', channels:['Dimmer','Rouge','Vert','Bleu','Blanc Chaud','Blanc Froid','Ambre','Menthe','Strobe']}]},

  // ---- CAMEO ----
  { id:'cameo-opus-sp5', name:'OPUS SP5', brand:'Cameo', category:'spot', hue:280,
    modes:[{name:'Standard (20ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Gobo Fixe','Gobo Rotatif','Rotation Gobo','Prisme','Focus','Zoom','Frost','Iris','Animation','Macro','Programme','Reset']}]},

  // ---- SHOWTEC ----
  { id:'showtec-phantom-140', name:'Phantom 140 LED Spot', brand:'Showtec', category:'spot', hue:280,
    modes:[{name:'Standard (18ch)', channels:['Pan','Pan Fine','Tilt','Tilt Fine','Vitesse PT','Dimmer','Strobe','Couleur','Gobo','Rotation Gobo','Prisme','Focus','Zoom','Frost','Macro','Vitesse Macro','Programme','Reset']}]},

  // ---- MACHINES À BROUILLARD SPÉCIALISÉES ----
  { id:'looksolutions-unique2', name:'Unique 2.1 (hazer)', brand:'Look Solutions', category:'fog', hue:190,
    modes:[{name:'3ch', channels:['Sortie Haze','Ventilateur','Vitesse Pompe']}]},
  { id:'mdg-atmeq', name:'ATMe (hazer)', brand:'MDG', category:'fog', hue:190,
    modes:[{name:'2ch', channels:['Sortie Haze','Ventilateur']}]},

  // ---- EFFETS DIVERS ----
  { id:'fog-machine', name:'Machine à fumée', brand:'Générique', category:'fog', hue:190,
    modes:[{name:'2ch Timer', channels:['Sortie Fumée','Minuteur']}]},
  { id:'haze-machine', name:'Machine à haze', brand:'Générique', category:'fog', hue:190,
    modes:[{name:'2ch', channels:['Sortie Haze','Ventilateur']}]},
  { id:'laser-rgb', name:'Laser RGB Animation', brand:'Générique', category:'laser', hue:120,
    modes:[{name:'8ch DMX', channels:['Mode','Programme','Vitesse Programme','Rotation X','Rotation Y','Zoom','Couleur','Strobe']}]},
  { id:'pixel-matrix-8x8', name:'Matrice LED Pixel 8x8', brand:'Générique', category:'pixel', hue:20,
    modes:[
      {name:'Global RGB (3ch)', channels:['Rouge','Vert','Bleu']},
      {name:'4 zones (12ch)', channels:Array.from({length:4},(_,i)=>[`Zone${i+1} R`,`Zone${i+1} V`,`Zone${i+1} B`]).flat()},
      {name:'8x8 complet (192ch)', channels:Array.from({length:64},(_,i)=>[`Px${i+1} R`,`Px${i+1} V`,`Px${i+1} B`]).flat()},
    ]},
  { id:'follow-spot', name:'Poursuite LED', brand:'Générique', category:'spot', hue:280,
    modes:[{name:'6ch', channels:['Dimmer','Strobe','Zoom','Focus','Iris','CTO']}]},
];

const CATEGORY_LABELS = {
  all:'Tout', par:'PAR', wash:'Wash', spot:'Spot', beam:'Beam',
  bar:'Bar/Pixel', strobe:'Strobe', fog:'Fumée/Haze', laser:'Laser',
  pixel:'Matrice', other:'Autre'
};

function getFixtureDef(defId){ return FIXTURE_LIBRARY.find(f=>f.id===defId); }
function isPanTiltFixture(def){ return ['wash','spot','beam'].includes(def.category); }
function isPixelFixture(def){ return ['pixel','bar'].includes(def.category); }

// ============================================================
// PATCH — logique
// ============================================================
function nextFreeAddress(universe, channelCount){
  const used = state.patch.fixtures.filter(f=>f.universe===universe)
    .map(f=>({start:f.address, end:f.address+getFixtureDef(f.defId).modes[f.modeIndex].channels.length-1}))
    .sort((a,b)=>a.start-b.start);
  let addr=1;
  for(const u of used){ if(addr+channelCount-1<u.start) break; if(addr<=u.end) addr=u.end+1; }
  if(addr+channelCount-1>512) addr=1;
  return addr;
}
function addFixtureToPatch(defId){
  const def=getFixtureDef(defId); if(!def) return;
  const modeIndex=0;
  const chCount=def.modes[modeIndex].channels.length;
  const universe=state.patch.universe;
  const address=nextFreeAddress(universe, chCount);
  const existingCount=state.patch.fixtures.filter(f=>f.defId===defId).length;
  const fixture={
    id:state.patch.nextId++, defId, modeIndex, universe, address,
    name:`${def.name} ${existingCount+1}`, hue:def.hue,
  };
  state.patch.fixtures.push(fixture);
  renderPatchTable(); renderTimeline();
  return fixture;
}
function removeFixture(id){
  state.patch.fixtures=state.patch.fixtures.filter(f=>f.id!==id);
  state.clips.list=state.clips.list.filter(c=>c.fixtureId!==id);
  renderPatchTable(); renderTimeline();
}
function fixtureChannelSpan(f){
  const def=getFixtureDef(f.defId);
  const count=def.modes[f.modeIndex].channels.length;
  return {start:f.address, end:f.address+count-1, count};
}
function computeConflicts(){
  const conflicts=new Set(); const byUniverse={};
  state.patch.fixtures.forEach(f=>{ (byUniverse[f.universe]=byUniverse[f.universe]||[]).push(f); });
  Object.values(byUniverse).forEach(list=>{
    for(let i=0;i<list.length;i++){
      const a=fixtureChannelSpan(list[i]);
      for(let j=i+1;j<list.length;j++){
        const b=fixtureChannelSpan(list[j]);
        if(a.start<=b.end && b.start<=a.end){ conflicts.add(list[i].id); conflicts.add(list[j].id); }
      }
    }
  });
  return conflicts;
}

// ============================================================
// CLIPS + KEYFRAMES — placer une fixture sur la timeline et l'animer
// ============================================================
function defaultKeyframeFor(def){
  const kf = {dimmer:100, colorHue: def.hue, effect:'static'};
  if(isPanTiltFixture(def)){ kf.pan=50; kf.tilt=50; }
  return kf;
}
function addClip(fixtureId, startTime, duration){
  const fixture = state.patch.fixtures.find(f=>f.id===fixtureId);
  const def = getFixtureDef(fixture.defId);
  const clip = {
    id: state.clips.nextId++,
    fixtureId,
    start: startTime,
    end: startTime+duration,
    effect: isPixelFixture(def) ? 'static_color' : 'static',
    keyframes: [
      {time:0, ...defaultKeyframeFor(def)},
      {time:duration, ...defaultKeyframeFor(def)},
    ],
  };
  state.clips.list.push(clip);
  state.clips.selectedId = clip.id;
  return clip;
}
function removeClip(id){
  state.clips.list = state.clips.list.filter(c=>c.id!==id);
  if(state.clips.selectedId===id) state.clips.selectedId=null;
}
function getClip(id){ return state.clips.list.find(c=>c.id===id); }
function addKeyframeToClip(clipId, localTime, values){
  const clip=getClip(clipId); if(!clip) return;
  localTime = clamp(localTime, 0, clip.end-clip.start);
  const existing = clip.keyframes.find(k=>Math.abs(k.time-localTime)<0.05);
  if(existing) Object.assign(existing, values);
  else { clip.keyframes.push({time:localTime, ...values}); clip.keyframes.sort((a,b)=>a.time-b.time); }
}

// Interpole les valeurs d'un clip à un instant local donné (0..duration)
function evalClipAt(clip, localTime){
  const kfs = clip.keyframes;
  if(kfs.length===0) return {};
  if(localTime<=kfs[0].time) return {...kfs[0]};
  if(localTime>=kfs[kfs.length-1].time) return {...kfs[kfs.length-1]};
  let a=kfs[0], b=kfs[kfs.length-1];
  for(let i=0;i<kfs.length-1;i++){
    if(localTime>=kfs[i].time && localTime<=kfs[i+1].time){ a=kfs[i]; b=kfs[i+1]; break; }
  }
  const span = b.time-a.time || 1;
  const t = (localTime-a.time)/span;
  const lerp=(x,y)=> x + (y-x)*t;
  const out = {...a};
  ['pan','tilt','dimmer','colorHue'].forEach(k=>{
    if(a[k]!=null && b[k]!=null) out[k]=lerp(a[k],b[k]);
  });
  // effet dynamique surcouche (indépendant des keyframes pan/tilt statiques)
  return applyEffectOverlay(clip, out, localTime, span, a, b);
}

function applyEffectOverlay(clip, base, localTime, span, a, b){
  const out={...base};
  const t = localTime; // temps local en secondes depuis le début du clip
  switch(clip.effect){
    case 'circle': {
      const speed = 0.6; // tours/sec
      const angle = t*speed*Math.PI*2;
      out.pan = clamp(50 + Math.cos(angle)*35, 0, 100);
      out.tilt = clamp(50 + Math.sin(angle)*20, 0, 100);
      break;
    }
    case 'figure8': {
      const speed=0.5, angle=t*speed*Math.PI*2;
      out.pan = clamp(50 + Math.sin(angle)*35, 0, 100);
      out.tilt = clamp(50 + Math.sin(angle*2)*20, 0, 100);
      break;
    }
    case 'chase_beat': {
      const bpm = state.audio.bpm || 120;
      const beatLen = 60/bpm;
      const step = Math.floor(t/beatLen);
      const positions=[15,35,65,85,50];
      out.pan = positions[step%positions.length];
      out.tilt = 50;
      break;
    }
    case 'strobe_sync': {
      const bpm = state.audio.bpm || 120;
      const beatLen = 60/bpm;
      const phase = (t%beatLen)/beatLen;
      out.dimmer = phase<0.15 ? 100 : 0;
      break;
    }
    case 'matrix_wave': {
      out.pixelEffect = {type:'wave', speed:1.2, t};
      break;
    }
    case 'matrix_chase': {
      out.pixelEffect = {type:'chase', speed:2, t};
      break;
    }
    case 'pixel_rainbow': {
      out.pixelEffect = {type:'rainbow', speed:0.5, t};
      break;
    }
    case 'static_color':
    case 'static':
    default: break;
  }
  return out;
}

const EFFECTS_PANTILT = [
  {id:'static', label:'Statique (keyframes)'},
  {id:'circle', label:'Cercle Pan/Tilt'},
  {id:'figure8', label:'Figure en 8'},
  {id:'chase_beat', label:'Chase sur le beat'},
  {id:'strobe_sync', label:'Strobe synchro beat'},
];
const EFFECTS_PIXEL = [
  {id:'static_color', label:'Couleur statique'},
  {id:'matrix_wave', label:'Vague matrice'},
  {id:'matrix_chase', label:'Chase matrice'},
  {id:'pixel_rainbow', label:'Arc-en-ciel pixel'},
  {id:'strobe_sync', label:'Strobe synchro beat'},
];

// ============================================================
// RENDU — TOPBAR
// ============================================================
function renderTopbar(skipStructure){
  const el = document.getElementById('topbar');
  const a = state.audio;
  const pos = currentPlayhead();

  if(!skipStructure || !el.dataset.built){
    el.dataset.built='1';
    el.innerHTML = `
      <div class="brand"><img src="logo.png" alt="" id="brand-logo" onerror="this.style.display='none';document.getElementById('brand-mark-fallback').style.display='inline-block';" style="width:20px;height:20px;object-fit:contain;border-radius:4px;"><span class="mark" id="brand-mark-fallback" style="display:none;"></span><b>LUMEN</b></div>
      <div class="transport">
        <button id="btn-stop" title="Stop">${svgStop()}</button>
        <button id="btn-play" class="play" title="Lecture">${svgPlay()}</button>
      </div>
      <div class="timecode" id="timecode">00:00.00</div>
      <div class="bpm-mini">
        <input type="number" id="bpm-input" min="40" max="240" step="0.1" placeholder="--" style="width:52px;background:transparent;border:none;color:var(--cyan);font-size:12px;padding:0;">
        <span style="color:var(--muted);font-size:10px;">BPM</span>
        <button id="btn-tap">TAP</button>
      </div>
      <span class="track-name-mini" id="track-name">Aucun fichier</span>
      <div class="bpm-mini" style="gap:6px;">
        <span style="color:var(--muted);font-size:9.5px;letter-spacing:1px;">MASTER</span>
        <input type="range" id="master-dimmer" min="0" max="100" value="${state.mixer.masterDimmer}" style="width:60px;">
        <span id="master-dimmer-val" style="font-family:var(--font-mono);font-size:10.5px;color:var(--amber);width:28px;">${state.mixer.masterDimmer}%</span>
      </div>
      <button id="btn-blackout" title="Blackout général" style="background:${state.mixer.blackout?'var(--red)':'var(--panel-2)'};color:${state.mixer.blackout?'#fff':'var(--muted)'};border:1px solid var(--line);border-radius:7px;padding:8px 12px;font-size:11px;font-weight:700;letter-spacing:.5px;">BLACKOUT</button>
      <div class="spacer"></div>
      <label class="import-btn" for="audio-file-input">${svgImport()} Audio</label>
      <input type="file" id="audio-file-input" accept="audio/*" style="display:none">
      <div class="export-menu">
        <button class="export-btn" id="export-toggle">${svgExport()} Exporter</button>
        <div class="export-dropdown" id="export-dropdown">
          <button class="item" id="exp-json"><span class="t">Projet LUMEN (.json)</span><span class="d">Sauvegarde complète, rechargeable ici</span></button>
          <hr>
          <button class="item" id="exp-mydmx"><span class="t">MyDMX 3.0</span><span class="d">Export XML de patch + scènes</span><span class="badge">BEST-EFFORT</span></button>
          <button class="item" id="exp-grandma"><span class="t">grandMA showfile</span><span class="d">Export XML de patch + cues</span><span class="badge">BEST-EFFORT</span></button>
          <button class="item" id="exp-csv"><span class="t">Feuille de patch (.csv)</span><span class="d">Nom, univers, adresse, mode, canaux</span></button>
          <hr>
          <button class="item" id="exp-load"><span class="t">Charger un projet...</span><span class="d">Importer un .json LUMEN</span></button>
          <input type="file" id="proj-file-input" accept="application/json" style="display:none">
        </div>
      </div>
    `;
    document.getElementById('btn-play').onclick=()=> a.isPlaying?pauseAudio():playAudio();
    document.getElementById('btn-stop').onclick=stopAudio;
    document.getElementById('btn-tap').onclick=tapTempo;
    document.getElementById('bpm-input').onchange=(e)=>{ setManualBpm(parseFloat(e.target.value)); };
    document.getElementById('master-dimmer').oninput=(e)=>{
      state.mixer.masterDimmer=+e.target.value;
      document.getElementById('master-dimmer-val').textContent=e.target.value+'%';
    };
    document.getElementById('btn-blackout').onclick=(e)=>{
      state.mixer.blackout=!state.mixer.blackout;
      e.target.style.background = state.mixer.blackout?'var(--red)':'var(--panel-2)';
      e.target.style.color = state.mixer.blackout?'#fff':'var(--muted)';
    };
    document.getElementById('audio-file-input').onchange=(e)=>{ const f=e.target.files[0]; if(f) importAudioFile(f); };
    const dd = document.getElementById('export-dropdown');
    document.getElementById('export-toggle').onclick=(e)=>{ e.stopPropagation(); dd.classList.toggle('open'); };
    document.addEventListener('click', ()=> dd.classList.remove('open'));
    document.getElementById('exp-json').onclick=exportProjectJSON;
    document.getElementById('exp-mydmx').onclick=exportMyDMX;
    document.getElementById('exp-grandma').onclick=exportGrandMA;
    document.getElementById('exp-csv').onclick=exportPatchCSV;
    document.getElementById('exp-load').onclick=()=>document.getElementById('proj-file-input').click();
    document.getElementById('proj-file-input').onchange=(e)=>{ const f=e.target.files[0]; if(f) importProject(f); };
  }
  document.getElementById('btn-play').innerHTML = a.isPlaying?svgPause():svgPlay();
  document.getElementById('timecode').textContent = fmtTime(pos);
  const bpmInput = document.getElementById('bpm-input');
  if(bpmInput && document.activeElement!==bpmInput) bpmInput.value = a.bpm ? a.bpm.toFixed(1) : '';
  document.getElementById('track-name').textContent = a.fileName || 'Aucun fichier';
  const pt = document.getElementById('preview-time');
  if(pt) pt.textContent = fmtTime(pos);
}
function svgPlay(){return `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;}
function svgPause(){return `<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`;}
function svgStop(){return `<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>`;}
function svgImport(){return `<svg viewBox="0 0 24 24"><path d="M12 3v10.5m0 0l4-4m-4 4l-4-4M5 19h14v2H5z"/></svg>`;}
function svgExport(){return `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor;"><path d="M12 21V8.5m0 0l-4 4m4-4l4 4M5 3h14v2H5z"/></svg>`;}

// ============================================================
// RENDU — TIMELINE MULTI-PISTES
// ============================================================
function renderTimeline(skipStructure){
  const wrap = document.getElementById('timeline-area');
  const a = state.audio;
  if(!skipStructure || !wrap.dataset.built){
    wrap.dataset.built='1';
    wrap.innerHTML = `
      <div class="tl-toolbar">
        <div class="grp"><button id="zoom-out">−</button><label>ZOOM</label><button id="zoom-in">+</button></div>
        <input type="range" class="zoom-range" id="zoom-range" min="10" max="300" value="${state.timeline.pxPerSecond}">
        <div class="grp"><button id="snap-toggle" class="${state.timeline.snapToBeat?'active':''}">SNAP BEAT</button></div>
        <span id="tl-duration"></span>
      </div>
      <div id="tracks-scroll"><div id="tracks-inner">
        <canvas id="ruler-canvas"></canvas>
        <div id="rows-container"></div>
      </div></div>
    `;
    document.getElementById('zoom-in').onclick=()=>setZoom(state.timeline.pxPerSecond*1.4);
    document.getElementById('zoom-out').onclick=()=>setZoom(state.timeline.pxPerSecond/1.4);
    document.getElementById('zoom-range').oninput=(e)=>setZoom(parseFloat(e.target.value));
    document.getElementById('snap-toggle').onclick=(e)=>{
      state.timeline.snapToBeat=!state.timeline.snapToBeat;
      e.target.classList.toggle('active', state.timeline.snapToBeat);
    };
  }
  document.getElementById('tl-duration').textContent = a.buffer ? `DURÉE ${fmtTime(a.duration)}` : 'Importe un audio pour définir la durée';
  drawRulerAndRows();
}
function setZoom(v){
  v=clamp(v,10,300);
  state.timeline.pxPerSecond=v;
  document.getElementById('zoom-range').value=v;
  drawRulerAndRows();
}
function totalTimelineSeconds(){ return state.audio.buffer ? state.audio.duration : 60; }

function drawRulerAndRows(){
  const pxPerSec = state.timeline.pxPerSecond;
  const totalSeconds = totalTimelineSeconds();
  const width = Math.max(600, totalSeconds*pxPerSec);
  const inner = document.getElementById('tracks-inner');
  if(inner) inner.style.width = width+'px';

  // ---- règle temporelle + grille de beat ----
  const canvas = document.getElementById('ruler-canvas');
  const dpr = window.devicePixelRatio||1;
  canvas.style.width=width+'px'; canvas.style.height='26px';
  canvas.width=width*dpr; canvas.height=26*dpr;
  const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,width,26);
  ctx.fillStyle='#0e1116'; ctx.fillRect(0,0,width,26);
  ctx.font='9px JetBrains Mono, monospace'; ctx.fillStyle='#4d545c';
  const secStep = pxPerSec<25?10:(pxPerSec<60?5:1);
  ctx.strokeStyle='#1d222a';
  for(let s=0;s<=totalSeconds;s+=secStep){
    const x=Math.round(s*pxPerSec)+0.5;
    ctx.beginPath();ctx.moveTo(x,16);ctx.lineTo(x,26);ctx.stroke();
    ctx.fillText(fmtTime(s).slice(0,5), x+3, 12);
  }
  const a=state.audio;
  if(a.bpm){
    const beatLen=60/a.bpm; let n=0;
    while(a.beatOffset+n*beatLen<totalSeconds){
      const t=a.beatOffset+n*beatLen, x=Math.round(t*pxPerSec)+0.5;
      ctx.strokeStyle = n%4===0 ? 'rgba(245,166,35,0.6)' : 'rgba(62,214,196,0.3)';
      ctx.beginPath();ctx.moveTo(x,18);ctx.lineTo(x,26);ctx.stroke();
      n++;
    }
  }

  // ---- lignes de pistes (une par fixture patchée + 1 master audio) ----
  const rows = document.getElementById('rows-container');
  rows.style.position='relative'; rows.style.width=width+'px';
  const fixtures = state.patch.fixtures;
  let html = `<div class="track-row"><div class="track-head"><span class="color-dot" style="background:var(--cyan)"></span><span class="tname">🎵 Audio</span></div><div class="track-lane master" data-role="master"><canvas id="waveform-canvas"></canvas></div></div>`;
  fixtures.forEach(f=>{
    html += `<div class="track-row" data-fixture-track="${f.id}">
      <div class="track-head"><span class="color-dot" style="background:hsl(${f.hue} 70% 55%)"></span><span class="tname">${f.name}</span>
        <button class="ms-btn" data-ms="mute" data-id="${f.id}" style="margin-left:auto;font-size:8.5px;padding:1px 4px;border-radius:3px;border:1px solid var(--line);color:${f.muted?'#fff':'var(--muted)'};background:${f.muted?'var(--red)':'transparent'};">M</button>
        <button class="ms-btn" data-ms="solo" data-id="${f.id}" style="font-size:8.5px;padding:1px 4px;border-radius:3px;border:1px solid var(--line);color:${f.solo?'#1a1200':'var(--muted)'};background:${f.solo?'var(--amber)':'transparent'};">S</button>
      </div>
      <div class="track-lane" data-fixture-lane="${f.id}"></div>
    </div>`;
  });
  if(fixtures.length===0){
    html += `<div class="empty-tracks">Patch des fixtures depuis l'onglet "Lumières" en bas pour qu'elles apparaissent ici comme pistes.</div>`;
  }
  rows.innerHTML = html;
  drawWaveformTrack(width);
  rows.querySelectorAll('.ms-btn').forEach(btn=>{
    btn.addEventListener('click',(e)=>{
      e.stopPropagation();
      const f = state.patch.fixtures.find(x=>x.id===+btn.dataset.id);
      if(btn.dataset.ms==='mute') f.muted=!f.muted; else f.solo=!f.solo;
      drawRulerAndRows();
    });
  });

  // clips
  fixtures.forEach(f=>{
    const lane = rows.querySelector(`[data-fixture-lane="${f.id}"]`);
    if(!lane) return;
    const clips = state.clips.list.filter(c=>c.fixtureId===f.id);
    clips.forEach(clip=>{
      const div=document.createElement('div');
      div.className='clip'+(state.clips.selectedId===clip.id?' selected':'');
      div.style.left=(clip.start*pxPerSec)+'px';
      div.style.width=Math.max(10,(clip.end-clip.start)*pxPerSec)+'px';
      div.style.background=`hsl(${f.hue} 65% 55%)`;
      div.textContent = clip.effect==='static'||clip.effect==='static_color' ? f.name : `${f.name} · ${effectLabel(clip.effect)}`;
      div.dataset.clipId = clip.id;
      div.addEventListener('click',(e)=>{ e.stopPropagation(); state.clips.selectedId=clip.id; openTool('anim'); drawRulerAndRows(); renderAnimPanel(); });
      const hl=document.createElement('div'); hl.className='handle l';
      const hr=document.createElement('div'); hr.className='handle r';
      div.appendChild(hl); div.appendChild(hr);
      attachClipDrag(div, clip, hl, hr);
      lane.appendChild(div);
    });
    lane.addEventListener('dblclick',(e)=>{
      if(e.target.classList.contains('clip')||e.target.classList.contains('handle')) return;
      const rect=lane.getBoundingClientRect();
      let t=(e.clientX-rect.left)/pxPerSec;
      if(state.timeline.snapToBeat && state.audio.bpm) t=snapToBeat(t);
      const dur = state.audio.bpm ? (60/state.audio.bpm)*4 : 2;
      addClip(f.id, Math.max(0,t), dur);
      drawRulerAndRows(); renderAnimPanel(); openTool('anim');
    });
  });

  // playhead
  const pos = currentPlayhead();
  const ph = document.createElement('div');
  ph.className='playhead-line';
  ph.style.left = (pos*pxPerSec)+'px';
  ph.style.height = rows.scrollHeight+26+'px';
  ph.style.top='0';
  inner.querySelectorAll('.playhead-line').forEach(n=>n.remove());
  inner.appendChild(ph);

  // seek au clic sur la règle
  canvas.onclick = (e)=>{
    const rect=canvas.getBoundingClientRect();
    let t=(e.clientX-rect.left)/pxPerSec;
    if(state.timeline.snapToBeat && state.audio.bpm) t=snapToBeat(t);
    seekTo(t);
  };

  // auto-scroll pendant lecture
  if(state.audio.isPlaying){
    const scrollEl=document.getElementById('tracks-scroll');
    const x=pos*pxPerSec;
    if(x<scrollEl.scrollLeft+60 || x>scrollEl.scrollLeft+scrollEl.clientWidth-60){
      scrollEl.scrollLeft = Math.max(0, x-scrollEl.clientWidth*0.3);
    }
  }
}
function drawWaveformTrack(width){
  const canvas = document.getElementById('waveform-canvas');
  if(!canvas) return;
  const height = 46;
  const dpr = window.devicePixelRatio||1;
  canvas.style.width=width+'px'; canvas.style.height=height+'px';
  canvas.width=width*dpr; canvas.height=height*dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,width,height);
  const a = state.audio;
  const pxPerSec = state.timeline.pxPerSecond;
  if(!a.buffer || !a.peaks){
    ctx.fillStyle = '#4d545c';
    ctx.font = '10px Space Grotesk, sans-serif';
    ctx.fillText('Importe un audio pour voir la waveform ici', 10, height/2+3);
    return;
  }
  const {data, perSecond} = a.peaks;
  const midY = height/2;
  const ampScale = height/2 - 4;
  ctx.fillStyle = '#3ed6c4';
  // On dessine par colonne de PIXEL ÉCRAN (indépendant du zoom : à fort zoom on
  // sous-échantillonne moins, à faible zoom on agrège plusieurs pics par colonne)
  const colsVisible = Math.ceil(width);
  for(let x=0; x<colsVisible; x++){
    const t0 = x/pxPerSec, t1=(x+1)/pxPerSec;
    const i0 = Math.floor(t0*perSecond), i1 = Math.max(i0+1, Math.floor(t1*perSecond));
    let min=1, max=-1;
    for(let i=i0; i<i1 && i<data.length/2; i++){
      if(data[i*2]<min) min=data[i*2];
      if(data[i*2+1]>max) max=data[i*2+1];
    }
    if(min>max) continue;
    const y1 = midY - max*ampScale, y2 = midY - min*ampScale;
    ctx.fillRect(x, Math.min(y1,y2), 1, Math.max(1.5, Math.abs(y2-y1)));
  }
  ctx.strokeStyle = '#1d3d38';
  ctx.beginPath(); ctx.moveTo(0,midY); ctx.lineTo(width,midY); ctx.stroke();
}

function snapToBeat(t){
  const beatLen=60/state.audio.bpm;
  const n=Math.round((t-state.audio.beatOffset)/beatLen);
  return Math.max(0, state.audio.beatOffset+n*beatLen);
}
function effectLabel(id){
  const all=[...EFFECTS_PANTILT,...EFFECTS_PIXEL];
  return (all.find(e=>e.id===id)||{label:id}).label;
}

function attachClipDrag(div, clip, hl, hr){
  const pxPerSec = ()=>state.timeline.pxPerSecond;
  let mode=null, startX=0, origStart=0, origEnd=0;
  function down(e, m){
    mode=m; startX=e.clientX; origStart=clip.start; origEnd=clip.end;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.stopPropagation();
  }
  function move(e){
    const dt=(e.clientX-startX)/pxPerSec();
    if(mode==='move'){
      const dur=origEnd-origStart;
      clip.start=Math.max(0,origStart+dt);
      clip.end=clip.start+dur;
    }else if(mode==='l'){
      clip.start=Math.min(origEnd-0.2, Math.max(0,origStart+dt));
    }else if(mode==='r'){
      clip.end=Math.max(origStart+0.2, origEnd+dt);
    }
    drawRulerAndRows();
  }
  function up(){
    mode=null;
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  }
  div.addEventListener('mousedown',(e)=>{ if(e.target===hl||e.target===hr) return; down(e,'move'); });
  hl.addEventListener('mousedown',(e)=>down(e,'l'));
  hr.addEventListener('mousedown',(e)=>down(e,'r'));
}

// ============================================================
// BARRE D'OUTILS DU BAS + PANNEAU COULISSANT
// ============================================================
function renderToolbar(){
  const el = document.getElementById('toolbar');
  el.innerHTML = `
    <button class="tool-btn" data-tool="music">${svgMusic()}<span>MUSIQUE</span></button>
    <button class="tool-btn" data-tool="lights">${svgBulb()}<span>LUMIÈRES</span></button>
    <button class="tool-btn" data-tool="anim">${svgWand()}<span>ANIMATION</span></button>
  `;
  el.querySelectorAll('.tool-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> openTool(btn.dataset.tool==state.ui.activeTool ? null : btn.dataset.tool));
  });
}
function svgMusic(){return `<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`;}
function svgBulb(){return `<svg viewBox="0 0 24 24"><path d="M9 21h6M12 3a6 6 0 00-3 11.2V17h6v-2.8A6 6 0 0012 3z"/></svg>`;}
function svgWand(){return `<svg viewBox="0 0 24 24"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 6.2l1.4-1.4M11.8 6.2l-1.4-1.4M17.8 11.8l1.4 1.4M3 21l9-9"/></svg>`;}

function openTool(tool){
  state.ui.activeTool = tool;
  document.querySelectorAll('.tool-btn').forEach(b=>b.classList.toggle('active', b.dataset.tool===tool));
  const panel = document.getElementById('sliding-panel');
  if(!tool){ panel.classList.remove('open'); panel.innerHTML=''; return; }
  panel.classList.add('open');
  renderSlidingPanel();
}
function renderSlidingPanel(){
  const tool = state.ui.activeTool;
  const panel = document.getElementById('sliding-panel');
  if(!tool || !panel.classList.contains('open')) return;
  if(tool==='music') renderMusicPanel(panel);
  else if(tool==='lights') renderLightsPanel(panel);
  else if(tool==='anim') renderAnimPanelFull(panel);
}

// ---- Panneau MUSIQUE ----
function renderMusicPanel(panel){
  const a = state.audio;
  panel.innerHTML = `
    <div class="panel-header"><h3>SYNCHRONISATION MUSIQUE</h3><button id="close-panel">✕</button></div>
    <div class="panel-inner">
      <div class="music-grid">
        <div class="music-card">
          <h4>ANALYSE AUDIO</h4>
          <div class="big-bpm">${a.bpm?a.bpm.toFixed(1):'--'} <span style="font-size:13px;color:var(--muted)">BPM</span></div>
          <div style="font-size:10.5px;color:var(--muted);margin-top:4px;">Confiance détection : ${a.bpmConfidence ?? '--'}%</div>
          <div style="font-size:10.5px;color:var(--muted);margin-top:2px;">Offset 1er beat : ${a.beatOffset?a.beatOffset.toFixed(2)+'s':'--'}</div>
          <div class="field-row" style="margin-top:10px;"><label>BPM manuel</label><input type="number" id="bpm-manual-input" min="20" max="300" step="0.1" value="${a.bpm?a.bpm.toFixed(1):''}" style="width:70px;"></div>
          <div class="field-row"><label>Offset (s)</label><input type="number" id="offset-manual-input" min="0" step="0.01" value="${a.beatOffset?a.beatOffset.toFixed(2):0}" style="width:70px;"></div>
          <button class="sync-btn" id="btn-tap-2" style="background:var(--panel-2);color:var(--text);border:1px solid var(--line);margin-top:6px;">TAP TEMPO</button>
        </div>
        <div class="music-card">
          <h4>SYNC AUTO SUR LA MUSIQUE</h4>
          <p style="font-size:10.5px;color:var(--muted);line-height:1.5;">Génère automatiquement des clips sur chaque piste patchée, calés sur la grille de beats détectée.</p>
          <div class="sync-opts">
            <label><input type="checkbox" id="sync-pantilt" checked> Fixtures Wash/Spot/Beam → effet Cercle</label>
            <label><input type="checkbox" id="sync-pixel" checked> Fixtures Bar/Matrice → effet Vague</label>
            <label><input type="checkbox" id="sync-strobe"> Ajouter un strobe synchro sur les temps forts</label>
          </div>
          <button class="sync-btn" id="btn-sync-music">⚡ Sync to Music</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('close-panel').onclick=()=>openTool(null);
  document.getElementById('btn-tap-2').onclick=tapTempo;
  document.getElementById('btn-sync-music').onclick=syncToMusic;
  document.getElementById('bpm-manual-input').onchange=(e)=>setManualBpm(parseFloat(e.target.value));
  document.getElementById('offset-manual-input').onchange=(e)=>{ state.audio.beatOffset=Math.max(0,parseFloat(e.target.value)||0); renderTimeline(); };
}

function syncToMusic(){
  const a = state.audio;
  if(!a.buffer || !a.bpm){ alert('Importe un fichier audio d\'abord (BPM requis).'); return; }
  const usePanTilt = document.getElementById('sync-pantilt').checked;
  const usePixel = document.getElementById('sync-pixel').checked;
  const useStrobe = document.getElementById('sync-strobe').checked;
  const barLen = (60/a.bpm)*4; // 1 mesure de 4 temps
  state.patch.fixtures.forEach(f=>{
    const def = getFixtureDef(f.defId);
    // nettoie les anciens clips auto de cette fixture
    state.clips.list = state.clips.list.filter(c=>c.fixtureId!==f.id);
    let t=0;
    while(t<a.duration){
      const dur=Math.min(barLen, a.duration-t);
      const clip=addClip(f.id, t, dur);
      if(isPanTiltFixture(def) && usePanTilt) clip.effect='circle';
      else if(isPixelFixture(def) && usePixel) clip.effect='matrix_wave';
      else if(useStrobe) clip.effect='strobe_sync';
      t+=barLen;
    }
  });
  drawRulerAndRows();
  alert('Clips générés et calés sur le tempo pour toutes les fixtures patchées.');
}

// ---- Panneau LUMIÈRES (bibliothèque + patch) ----
function renderLightsPanel(panel){
  panel.innerHTML = `
    <div class="panel-header"><h3>LUMIÈRES · BIBLIOTHÈQUE & PATCH</h3><button id="close-panel">✕</button></div>
    <div class="panel-inner"><div class="lib-layout">
      <div>
        <div class="search-box"><input type="text" id="lib-search" placeholder="Rechercher une fixture / marque..."></div>
        <div class="cat-tabs" id="cat-tabs"></div>
        <div id="fixture-list"></div>
      </div>
      <div class="patch-panel">
        <div class="count"><b id="patch-count">0</b> fixtures patchées · Univers <select id="universe-select">${Array.from({length:8},(_,i)=>i+1).map(u=>`<option value="${u}" ${u===state.patch.universe?'selected':''}>${u}</option>`).join('')}</select></div>
        <div id="patch-table-wrap" style="overflow-y:auto;flex:1;"></div>
      </div>
    </div></div>
  `;
  document.getElementById('close-panel').onclick=()=>openTool(null);
  document.getElementById('universe-select').onchange=(e)=>{ state.patch.universe=parseInt(e.target.value); };
  document.getElementById('lib-search').oninput=(e)=>{ state.library.search=e.target.value.toLowerCase(); renderFixtureList(); };
  const cats=['all', ...Array.from(new Set(FIXTURE_LIBRARY.map(f=>f.category)))];
  document.getElementById('cat-tabs').innerHTML = cats.map(c=>`<button data-cat="${c}" class="${c===state.library.category?'active':''}">${CATEGORY_LABELS[c]||c}</button>`).join('');
  document.getElementById('cat-tabs').onclick=(e)=>{
    const btn=e.target.closest('button[data-cat]'); if(!btn) return;
    state.library.category=btn.dataset.cat;
    document.querySelectorAll('#cat-tabs button').forEach(b=>b.classList.toggle('active', b===btn));
    renderFixtureList();
  };
  renderFixtureList();
  renderPatchTable();
}
function renderFixtureList(){
  const list=document.getElementById('fixture-list'); if(!list) return;
  const {search,category}=state.library;
  const items=FIXTURE_LIBRARY.filter(f=>{
    if(category!=='all' && f.category!==category) return false;
    if(search && !(f.name.toLowerCase().includes(search)||f.brand.toLowerCase().includes(search))) return false;
    return true;
  });
  if(items.length===0){ list.innerHTML=`<div style="grid-column:1/-1;color:var(--muted-2);font-size:11px;padding:14px;">Aucune fixture trouvée</div>`; return; }
  list.innerHTML = items.map(f=>`
    <div class="fixture-card" draggable="true" data-def="${f.id}">
      <div class="brand-tag">${f.brand}</div>
      <div class="name">${f.name}</div>
      <div class="meta"><span>${f.modes.length} mode${f.modes.length>1?'s':''}</span></div>
    </div>`).join('');
  list.querySelectorAll('.fixture-card').forEach(card=>{
    card.addEventListener('dblclick', ()=>{ addFixtureToPatch(card.dataset.def); renderPatchTable(); });
  });
}
function renderPatchTable(){
  const wrap=document.getElementById('patch-table-wrap'); if(!wrap) return;
  const countEl=document.getElementById('patch-count'); if(countEl) countEl.textContent=state.patch.fixtures.length;
  const conflicts=computeConflicts();
  if(state.patch.fixtures.length===0){
    wrap.innerHTML=`<div style="color:var(--muted-2);font-size:11px;padding:14px;text-align:center;">Double-clique une fixture pour la patcher.</div>`;
    return;
  }
  wrap.innerHTML = `<table class="patch-table"><thead><tr><th>Nom</th><th>Uni.</th><th>Adr.</th><th>Mode</th><th>Ch.</th><th></th></tr></thead><tbody>
    ${state.patch.fixtures.map(f=>{
      const def=getFixtureDef(f.defId); const span=fixtureChannelSpan(f);
      return `<tr class="${conflicts.has(f.id)?'conflict':''}">
        <td><span class="color-dot" style="background:hsl(${f.hue} 70% 55%);display:inline-block;margin-right:4px;"></span>${f.name}</td>
        <td><input type="number" min="1" max="8" class="universe-input" data-id="${f.id}" value="${f.universe}"></td>
        <td><input type="number" min="1" max="512" class="address-input" data-id="${f.id}" value="${f.address}"></td>
        <td><select class="mode-select" data-id="${f.id}">${def.modes.map((m,i)=>`<option value="${i}" ${i===f.modeIndex?'selected':''}>${m.name}</option>`).join('')}</select></td>
        <td class="chan-range">${span.start}-${span.end}</td>
        <td><button class="del-btn" data-id="${f.id}">✕</button></td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
  wrap.querySelectorAll('.universe-input').forEach(inp=>inp.addEventListener('change',e=>{ const f=state.patch.fixtures.find(x=>x.id===+e.target.dataset.id); f.universe=clamp(+e.target.value||1,1,8); renderPatchTable(); renderTimeline(); }));
  wrap.querySelectorAll('.address-input').forEach(inp=>inp.addEventListener('change',e=>{ const f=state.patch.fixtures.find(x=>x.id===+e.target.dataset.id); f.address=clamp(+e.target.value||1,1,512); renderPatchTable(); }));
  wrap.querySelectorAll('.mode-select').forEach(sel=>sel.addEventListener('change',e=>{ const f=state.patch.fixtures.find(x=>x.id===+e.target.dataset.id); f.modeIndex=+e.target.value; renderPatchTable(); }));
  wrap.querySelectorAll('.del-btn').forEach(btn=>btn.addEventListener('click',e=>{ removeFixture(+btn.dataset.id); renderTimeline(); }));
}

// ---- Panneau ANIMATION (keyframes du clip sélectionné) ----
function renderAnimPanel(){ renderSlidingPanel(); }
function renderAnimPanelFull(panel){
  const clip = getClip(state.clips.selectedId);
  panel.innerHTML = `<div class="panel-header"><h3>ANIMATION</h3><button id="close-panel">✕</button></div><div class="panel-inner" id="anim-inner"></div>`;
  document.getElementById('close-panel').onclick=()=>openTool(null);
  const inner = document.getElementById('anim-inner');
  if(!clip){
    inner.innerHTML = `<div class="anim-empty">Double-clique sur une piste dans la timeline pour créer un clip, puis sélectionne-le pour l'animer ici (pan/tilt, couleur, effets pixel...).</div>`;
    return;
  }
  const fixture = state.patch.fixtures.find(f=>f.id===clip.fixtureId);
  const def = getFixtureDef(fixture.defId);
  const effects = isPixelFixture(def) ? EFFECTS_PIXEL : (isPanTiltFixture(def) ? EFFECTS_PANTILT : [{id:'static',label:'Statique'}]);
  const localT = clamp(currentPlayhead()-clip.start, 0, clip.end-clip.start);
  const val = evalClipAt(clip, localT);

  inner.innerHTML = `<div class="anim-grid">
    <div class="anim-controls">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">${fixture.name} — clip ${fmtTime(clip.start)} → ${fmtTime(clip.end)}</div>
      <div class="field-row"><label>Effet</label>
        <select class="effect-select" id="clip-effect">${effects.map(e=>`<option value="${e.id}" ${e.id===clip.effect?'selected':''}>${e.label}</option>`).join('')}</select>
      </div>
      ${isPanTiltFixture(def) ? `
      <div class="field-row"><label>Pan</label><input type="range" id="kf-pan" min="0" max="100" value="${Math.round(val.pan??50)}"><span class="val" id="kf-pan-val">${Math.round(val.pan??50)}</span></div>
      <div class="field-row"><label>Tilt</label><input type="range" id="kf-tilt" min="0" max="100" value="${Math.round(val.tilt??50)}"><span class="val" id="kf-tilt-val">${Math.round(val.tilt??50)}</span></div>
      ` : ''}
      <div class="field-row"><label>Dimmer</label><input type="range" id="kf-dimmer" min="0" max="100" value="${Math.round(val.dimmer??100)}"><span class="val" id="kf-dimmer-val">${Math.round(val.dimmer??100)}%</span></div>
      <div class="field-row"><label>Couleur</label><input type="color" id="kf-color" value="${hueToHex(val.colorHue??fixture.hue)}"></div>
      <button class="add-kf-btn" id="add-kf-btn">+ Ajouter un keyframe à ${fmtTime(currentPlayhead())}</button>
      <button class="add-kf-btn" id="dup-clip-btn" style="background:var(--panel-2);color:var(--text);border:1px solid var(--line);">⧉ Dupliquer ce clip après</button>
      <button class="del-btn" id="del-clip-btn" style="align-self:flex-start;">✕ Supprimer ce clip</button>
    </div>
    <div>
      <div style="font-size:9.5px;letter-spacing:1.5px;color:var(--muted);margin-bottom:8px;">KEYFRAMES (${clip.keyframes.length})</div>
      <div class="kf-list">
        ${clip.keyframes.map((k,i)=>`<div class="kf-row"><span class="t">${fmtTime(clip.start+k.time)}</span><span class="desc">${keyframeDesc(k,def)}</span>${clip.keyframes.length>2?`<button class="del-btn kf-del" data-i="${i}">✕</button>`:''}</div>`).join('')}
      </div>
    </div>
  </div>`;

  document.getElementById('clip-effect').onchange=(e)=>{ clip.effect=e.target.value; drawRulerAndRows(); renderAnimPanelFull(panel); };
  document.getElementById('del-clip-btn').onclick=()=>{ removeClip(clip.id); drawRulerAndRows(); renderAnimPanelFull(panel); };
  document.getElementById('dup-clip-btn').onclick=()=>{
    const dur = clip.end-clip.start;
    const newClip = { id: state.clips.nextId++, fixtureId: clip.fixtureId, start: clip.end, end: clip.end+dur,
      effect: clip.effect, keyframes: clip.keyframes.map(k=>({...k})) };
    state.clips.list.push(newClip);
    state.clips.selectedId = newClip.id;
    drawRulerAndRows(); renderAnimPanelFull(panel);
  };
  const panEl=document.getElementById('kf-pan'), tiltEl=document.getElementById('kf-tilt'), dimEl=document.getElementById('kf-dimmer'), colorEl=document.getElementById('kf-color');
  if(panEl) panEl.oninput=(e)=>{ document.getElementById('kf-pan-val').textContent=e.target.value; };
  if(tiltEl) tiltEl.oninput=(e)=>{ document.getElementById('kf-tilt-val').textContent=e.target.value; };
  if(dimEl) dimEl.oninput=(e)=>{ document.getElementById('kf-dimmer-val').textContent=e.target.value+'%'; };
  document.getElementById('add-kf-btn').onclick=()=>{
    const values = {
      dimmer: dimEl?+dimEl.value:100,
      colorHue: colorEl?hexToHue(colorEl.value):fixture.hue,
    };
    if(panEl) values.pan=+panEl.value;
    if(tiltEl) values.tilt=+tiltEl.value;
    addKeyframeToClip(clip.id, localT, values);
    drawRulerAndRows(); renderAnimPanelFull(panel);
  };
  inner.querySelectorAll('.kf-del').forEach(btn=>btn.addEventListener('click',()=>{
    clip.keyframes.splice(+btn.dataset.i,1);
    renderAnimPanelFull(panel);
  }));
}
function keyframeDesc(k, def){
  const parts=[];
  if(k.pan!=null) parts.push(`Pan ${Math.round(k.pan)}`);
  if(k.tilt!=null) parts.push(`Tilt ${Math.round(k.tilt)}`);
  if(k.dimmer!=null) parts.push(`Dim ${Math.round(k.dimmer)}%`);
  return parts.join(' · ');
}
function hueToHex(h){
  return hslToHex(h,70,55);
}
function hslToHex(h,s,l){
  s/=100; l/=100;
  const k=n=>(n+h/30)%12;
  const a=s*Math.min(l,1-l);
  const f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1)));
  const toHex=x=>Math.round(255*x).toString(16).padStart(2,'0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
function hexToHue(hex){
  const r=parseInt(hex.substr(1,2),16)/255, g=parseInt(hex.substr(3,2),16)/255, b=parseInt(hex.substr(5,2),16)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b); let h=0;
  if(max!==min){
    const d=max-min;
    if(max===r) h=((g-b)/d)%6; else if(max===g) h=(b-r)/d+2; else h=(r-g)/d+4;
    h*=60; if(h<0) h+=360;
  }
  return h;
}

// ============================================================
// APERÇU 3D (three.js) — scène simplifiée avec truss + fixtures
// ============================================================
function init3DPreview(){
  const container = document.getElementById('preview-square');
  const w = container.clientWidth, h = container.clientHeight;
  const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
  renderer.setSize(w,h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, w/h, 0.1, 100);

  // sol
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(14,10),
    new THREE.MeshBasicMaterial({color:0x0d1014})
  );
  floor.rotation.x = -Math.PI/2; floor.position.y=-2;
  scene.add(floor);
  const grid = new THREE.GridHelper(14,14,0x2a3038,0x1a1f26);
  grid.position.y=-1.99;
  scene.add(grid);

  // truss
  const trussMat = new THREE.MeshBasicMaterial({color:0x33383f});
  const truss = new THREE.Mesh(new THREE.BoxGeometry(10,0.15,0.15), trussMat);
  truss.position.y = 3;
  scene.add(truss);

  state.three.renderer = renderer;
  state.three.scene = scene;
  state.three.camera = camera;
  state.three.truss = truss;
  updateCamera();

  // orbit manuel (drag souris)
  let dragging=false, lastX=0, lastY=0;
  const dom = renderer.domElement;
  dom.addEventListener('mousedown', e=>{ dragging=true; lastX=e.clientX; lastY=e.clientY; });
  window.addEventListener('mouseup', ()=> dragging=false);
  window.addEventListener('mousemove', e=>{
    if(!dragging) return;
    const dx=e.clientX-lastX, dy=e.clientY-lastY;
    lastX=e.clientX; lastY=e.clientY;
    state.three.orbit.az -= dx*0.008;
    state.three.orbit.el = clamp(state.three.orbit.el - dy*0.006, 0.15, 1.4);
    updateCamera();
  });
  dom.addEventListener('wheel', e=>{
    e.preventDefault();
    state.three.orbit.dist = clamp(state.three.orbit.dist + e.deltaY*0.01, 4, 20);
    updateCamera();
  }, {passive:false});

  window.addEventListener('resize', ()=>{
    const w2=container.clientWidth, h2=container.clientHeight;
    renderer.setSize(w2,h2);
    camera.aspect=w2/h2; camera.updateProjectionMatrix();
  });

  rebuild3DFixtures();
  renderer.render(scene,camera);
}
function updateCamera(){
  const {az,el,dist} = state.three.orbit;
  const cam = state.three.camera; if(!cam) return;
  cam.position.set(Math.sin(az)*Math.cos(el)*dist, Math.sin(el)*dist+1, Math.cos(az)*Math.cos(el)*dist);
  cam.lookAt(0,0.5,0);
}

// (re)crée un mesh par fixture patchée, positionné le long du truss
function rebuild3DFixtures(){
  const scene = state.three.scene; if(!scene) return;
  Object.values(state.three.meshes).forEach(m=>{ scene.remove(m.group); });
  state.three.meshes = {};
  const fixtures = state.patch.fixtures;
  const n = fixtures.length;
  fixtures.forEach((f,i)=>{
    const def = getFixtureDef(f.defId);
    const x = n>1 ? (i/(n-1)-0.5)*8.5 : 0;
    const group = new THREE.Group();
    group.position.set(x, 3, 0);

    const bodyColor = 0x2a2e35;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.35,0.3,0.35), new THREE.MeshBasicMaterial({color:bodyColor}));
    group.add(body);

    let beam=null, head=null;
    if(isPanTiltFixture(def)){
      const yoke = new THREE.Group();
      head = new THREE.Mesh(new THREE.ConeGeometry(0.16,0.5,12), new THREE.MeshBasicMaterial({color:0x555a62}));
      head.rotation.x = Math.PI;
      head.position.y=-0.28;
      yoke.add(head);
      beam = new THREE.Mesh(
        new THREE.ConeGeometry(0.5,4,20,1,true),
        new THREE.MeshBasicMaterial({color:0xffffff, transparent:true, opacity:0.16, side:THREE.DoubleSide})
      );
      beam.rotation.x = Math.PI;
      beam.position.y = -2.3;
      yoke.add(beam);
      group.add(yoke);
      state.three.meshes[f.id] = {group, head:yoke, beam, body, kind:'pantilt'};
    } else if(isPixelFixture(def)){
      const cells = def.modes[f.modeIndex].name.includes('192') ? 8 : (def.modes[f.modeIndex].channels.length/3);
      const cols = Math.min(8, Math.max(1,Math.round(Math.sqrt(cells))));
      const pixGroup = new THREE.Group();
      const pixCount = Math.min(16, Math.max(1,Math.round(cells)));
      const pixels=[];
      for(let p=0;p<pixCount;p++){
        const px=new THREE.Mesh(new THREE.BoxGeometry(0.09,0.09,0.05), new THREE.MeshBasicMaterial({color:0xffffff}));
        px.position.set((p%cols-cols/2)*0.11, -Math.floor(p/cols)*0.11, 0.2);
        pixGroup.add(px); pixels.push(px);
      }
      pixGroup.position.y=-0.2;
      group.add(pixGroup);
      state.three.meshes[f.id] = {group, pixels, body, kind:'pixel'};
    } else {
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.16,12,12), new THREE.MeshBasicMaterial({color:0xffffff}));
      glow.position.y=-0.25;
      group.add(glow);
      state.three.meshes[f.id] = {group, glow, body, kind:'static'};
    }
    scene.add(group);
  });
}

// appelé à chaque frame (RAF) et sur seek/édition pour refléter l'état courant
function update3DPreview(){
  if(!state.three.renderer) return;
  const pos = currentPlayhead();
  const anySolo = state.patch.fixtures.some(f=>f.solo);
  state.patch.fixtures.forEach(f=>{
    const mesh = state.three.meshes[f.id]; if(!mesh) return;
    const clip = state.clips.list.find(c=>c.fixtureId===f.id && pos>=c.start && pos<=c.end);
    const def = getFixtureDef(f.defId);
    let val = {dimmer:100, colorHue:f.hue, pan:50, tilt:50};
    if(clip) val = {...val, ...evalClipAt(clip, pos-clip.start)};
    const color = new THREE.Color(hslToHex(val.colorHue??f.hue,75,55));
    const audible = !state.mixer.blackout && !f.muted && (!anySolo || f.solo);
    const masterFactor = audible ? clamp(state.mixer.masterDimmer/100,0,1) : 0;
    const dimAlpha = clamp((val.dimmer??100)/100, 0, 1) * masterFactor;

    if(mesh.kind==='pantilt'){
      const panRad = ((val.pan-50)/50) * (Math.PI*0.75);
      const tiltRad = ((val.tilt-50)/50) * (Math.PI*0.4);
      mesh.head.rotation.y = panRad;
      mesh.head.rotation.x = tiltRad;
      mesh.beam.material.color.set(color);
      mesh.beam.material.opacity = 0.10 + dimAlpha*0.22;
    } else if(mesh.kind==='pixel'){
      const pe = val.pixelEffect;
      mesh.pixels.forEach((px,i)=>{
        let c = color.clone();
        if(pe){
          const phase = i*0.35 + (pe.t||0)*(pe.speed||1);
          if(pe.type==='wave'){ c = new THREE.Color(hslToHex(val.colorHue??f.hue,75, 35+Math.sin(phase)*20+20)); }
          else if(pe.type==='chase'){ c = (Math.floor(phase)%mesh.pixels.length===i) ? new THREE.Color(0xffffff) : new THREE.Color(hslToHex(val.colorHue??f.hue,60,20)); }
          else if(pe.type==='rainbow'){ c = new THREE.Color(hslToHex((i*24+ (pe.t||0)*60)%360,75,55)); }
        }
        px.material.color.set(c);
        px.material.opacity = dimAlpha;
      });
    } else if(mesh.kind==='static'){
      mesh.glow.material.color.set(color);
    }
  });
  if(state.three.renderer) state.three.renderer.render(state.three.scene, state.three.camera);
}

// ============================================================
// EXPORTS
// ============================================================
function exportProjectJSON(){
  const data = { version:1, audioFileName:state.audio.fileName, bpm:state.audio.bpm, beatOffset:state.audio.beatOffset,
    patch:state.patch.fixtures, clips:state.clips.list };
  downloadBlob(JSON.stringify(data,null,2), 'lumen-projet.json', 'application/json');
  document.getElementById('export-dropdown').classList.remove('open');
}
async function importProject(file){
  try{
    const data = JSON.parse(await file.text());
    if(data.patch){ state.patch.fixtures=data.patch; state.patch.nextId=Math.max(1,...data.patch.map(f=>f.id))+1; }
    if(data.clips){ state.clips.list=data.clips; state.clips.nextId=Math.max(1,...data.clips.map(c=>c.id))+1; }
    if(data.bpm) state.audio.bpm=data.bpm;
    if(data.beatOffset!=null) state.audio.beatOffset=data.beatOffset;
    renderTopbar(); renderTimeline(); rebuild3DFixtures();
  }catch(err){ alert('Fichier de projet invalide.'); }
}
function exportPatchCSV(){
  document.getElementById('export-dropdown').classList.remove('open');
  let csv = 'Nom;Marque;Modele;Univers;Adresse debut;Adresse fin;Mode;Nb canaux\n';
  state.patch.fixtures.forEach(f=>{
    const def=getFixtureDef(f.defId); const mode=def.modes[f.modeIndex]; const span=fixtureChannelSpan(f);
    csv += `${f.name};${def.brand};${def.name};${f.universe};${span.start};${span.end};${mode.name};${mode.channels.length}\n`;
  });
  downloadBlob(csv, 'lumen-feuille-de-patch.csv', 'text/csv');
}
function exportMyDMX(){
  document.getElementById('export-dropdown').classList.remove('open');
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<MyDMXProject generator="LUMEN" note="Export best-effort, structure approximative">\n  <Patch>\n`;
  state.patch.fixtures.forEach(f=>{
    const def=getFixtureDef(f.defId); const mode=def.modes[f.modeIndex];
    xml += `    <Fixture name="${escapeXml(f.name)}" manufacturer="${escapeXml(def.brand)}" model="${escapeXml(def.name)}" universe="${f.universe}" address="${f.address}" channelCount="${mode.channels.length}"/>\n`;
  });
  xml += `  </Patch>\n  <Scenes>\n`;
  state.clips.list.forEach(c=>{
    const f=state.patch.fixtures.find(x=>x.id===c.fixtureId);
    xml += `    <Scene fixture="${escapeXml(f?f.name:'?')}" start="${c.start.toFixed(2)}" end="${c.end.toFixed(2)}" effect="${c.effect}"/>\n`;
  });
  xml += `  </Scenes>\n</MyDMXProject>`;
  downloadBlob(xml, 'lumen-export-mydmx3.xml', 'application/xml');
}
function exportGrandMA(){
  document.getElementById('export-dropdown').classList.remove('open');
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Export best-effort LUMEN -> structure approximative grandMA, à vérifier avant import -->\n<GMA3 DataVersion="1">\n  <FixtureLibrary>\n`;
  state.patch.fixtures.forEach(f=>{
    const def=getFixtureDef(f.defId); const mode=def.modes[f.modeIndex];
    xml += `    <Fixture Name="${escapeXml(f.name)}" Manufacturer="${escapeXml(def.brand)}" FixtureType="${escapeXml(def.name)}" Universe="${f.universe}" Address="${f.address}" Channels="${mode.channels.length}"/>\n`;
  });
  xml += `  </FixtureLibrary>\n  <Cues>\n`;
  state.clips.list.forEach((c,i)=>{
    const f=state.patch.fixtures.find(x=>x.id===c.fixtureId);
    xml += `    <Cue No="${i+1}" Fixture="${escapeXml(f?f.name:'?')}" Time="${c.start.toFixed(2)}" Effect="${c.effect}"/>\n`;
  });
  xml += `  </Cues>\n</GMA3>`;
  downloadBlob(xml, 'lumen-export-grandma.xml', 'application/xml');
}
function escapeXml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function downloadBlob(content, filename, type){
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// INIT
// ============================================================
function init(){
  renderTopbar();
  renderTimeline();
  renderToolbar();
  init3DPreview();
  const scrollEl = document.getElementById('tracks-scroll');
  if(scrollEl) scrollEl.addEventListener('scroll', ()=>{
    document.getElementById('ruler-canvas').style.transform = `translateX(0)`;
  });
  update3DPreview();
}
document.addEventListener('DOMContentLoaded', init);
if(document.readyState!=='loading') init();
