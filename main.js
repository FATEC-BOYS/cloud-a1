/* ======= Elementos ======= */
const video = document.getElementById('video');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const statusEl = document.getElementById('status');
const fpsEl = document.getElementById('fps');
const motionEl = document.getElementById('motion');
const centroidEl = document.getElementById('centroid');
const roiCountEl = document.getElementById('roiCount');

const selRes = document.getElementById('resolution');
const rngThr = document.getElementById('threshold');
const chkMask = document.getElementById('showMask');
const chkDrawRoi = document.getElementById('drawRoi');

const btnStart = document.getElementById('start');
const btnStop = document.getElementById('stop');
const btnResetRoi = document.getElementById('resetRoi');

/* ======= Estado ======= */
let stream = null;
let running = false;
let lastFrameTS = performance.now();
let frames = 0, fps = 0;
let animId = 0;

/* processamento em baixa resolução para performance */
const proc = {
  w: 320, h: 180,
  cvs: document.createElement('canvas'),
  ctx: null,
  prev: null, // ImageData do frame anterior
};
proc.cvs.width = proc.w; proc.cvs.height = proc.h;
proc.ctx = proc.cvs.getContext('2d', { willReadFrequently: true });

/* ROIs e contagem */
const rois = []; // {x,y,w,h}
let roiCount = 0;
let lastInside = false;

/* ======= Utils ======= */
function parseRes(v){
  const [w,h] = v.split('x').map(Number);
  return { width: w, height: h };
}
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function inRect(x,y,r){ return x>=r.x && y>=r.y && x<=r.x+r.w && y<=r.y+r.h; }

/* ======= Câmera ======= */
async function start(){
  const { width, height } = parseRes(selRes.value);
  stop(); // garante que não duplica
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width, height, facingMode: 'user' },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    setupCanvas();
    running = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    statusEl.textContent = `rodando ${width}×${height}`;
    loop();
  }catch(err){
    console.error(err);
    statusEl.textContent = 'erro ao iniciar câmera';
  }
}

function stop(){
  running = false;
  cancelAnimationFrame(animId);
  if(stream){
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  btnStart.disabled = false;
  btnStop.disabled = true;
  statusEl.textContent = 'parado';
}

function setupCanvas(){
  // videoWidth/Height válidos após play()
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  canvas.width = vw; canvas.height = vh;
}

/* ======= Análise por diferença de quadros ======= */
function analyze(){
  // downscale para proc.w x proc.h
  proc.ctx.drawImage(video, 0, 0, proc.w, proc.h);
  const cur = proc.ctx.getImageData(0, 0, proc.w, proc.h);

  // se não tem frame anterior, salva e sai
  if(!proc.prev){ proc.prev = cur; return { motionPct: 0, centroid: null, bbox: null, mask: null }; }

  const thr = Number(rngThr.value); // 0-100
  // threshold em 0-255
  const TH = clamp(Math.floor((thr/100)*255), 5, 255);

  const { data: A } = cur;
  const { data: B } = proc.prev;
  const mask = new Uint8ClampedArray(proc.w*proc.h); // 0/255
  let active = 0;

  // diferença absoluta e binarização
  for(let i=0, p=0; i<A.length; i+=4, p++){
    const dr = Math.abs(A[i] - B[i]);
    const dg = Math.abs(A[i+1] - B[i+1]);
    const db = Math.abs(A[i+2] - B[i+2]);
    const d = (dr + dg + db) / 3;
    if(d > TH){ mask[p] = 255; active++; }
  }

  // calcula centroid & bbox do maior blob de forma simples:
  // aqui, aproximamos pegando TODOS pixels ativos (método leve).
  // (Se quiser precisão por componente conexa, podemos implementar depois.)
  if(active === 0){
    proc.prev = cur;
    return { motionPct: 0, centroid: null, bbox: null, mask };
  }

  // centroid aproximado (média das coordenadas ativas)
  let sx=0, sy=0, minx=Infinity, miny=Infinity, maxx=-1, maxy=-1;
  for(let p=0; p<mask.length; p++){
    if(mask[p]){
      const x = p % proc.w;
      const y = (p - x) / proc.w;
      sx += x; sy += y;
      if(x<minx) minx=x;
      if(y<miny) miny=y;
      if(x>maxx) maxx=x;
      if(y>maxy) maxy=y;
    }
  }
  const cx = Math.round(sx/active);
  const cy = Math.round(sy/active);
  const motionPct = Math.round((active / mask.length) * 100);

  proc.prev = cur;
  return {
    motionPct,
    centroid: { x: cx, y: cy },
    bbox: { x: minx, y: miny, w: maxx-minx+1, h: maxy-miny+1 },
    mask
  };
}

/* ======= Desenho ======= */
function drawOverlay(res){
  // desenha frame
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // desenha máscara (opcional) — upsample simples
  if(chkMask.checked && res.mask){
    const mCvs = document.createElement('canvas');
    mCvs.width = proc.w; mCvs.height = proc.h;
    const mctx = mCvs.getContext('2d');
    const img = mctx.createImageData(proc.w, proc.h);
    for(let p=0, i=0; p<res.mask.length; p++, i+=4){
      const v = res.mask[p];
      // azul translúcido
      img.data[i] = 80; img.data[i+1] = 160; img.data[i+2] = 255; img.data[i+3] = v ? 90 : 0;
    }
    mctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(mCvs, 0, 0, canvas.width, canvas.height);
  }

  // mapeia coords do espaço de processamento para canvas de exibição
  const scaleX = canvas.width / proc.w;
  const scaleY = canvas.height / proc.h;

  // bbox
  if(res.bbox){
    ctx.strokeStyle = 'rgba(0, 200, 255, .9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      res.bbox.x * scaleX,
      res.bbox.y * scaleY,
      res.bbox.w * scaleX,
      res.bbox.h * scaleY
    );
  }

  // centroid
  if(res.centroid){
    ctx.fillStyle = '#2ecc71';
    ctx.beginPath();
    ctx.arc(res.centroid.x * scaleX, res.centroid.y * scaleY, 6, 0, Math.PI*2);
    ctx.fill();
  }

  // ROIs
  ctx.strokeStyle = 'rgba(255,255,255,.6)';
  ctx.setLineDash([6,4]);
  rois.forEach(r => {
    ctx.strokeRect(r.x * scaleX, r.y * scaleY, r.w * scaleX, r.h * scaleY);
  });
  ctx.setLineDash([]);
}

/* ======= Loop ======= */
function loop(){
  if(!running) return;

  // FPS
  frames++;
  const t = performance.now();
  if(t - lastFrameTS >= 1000){
    fps = frames; frames = 0; lastFrameTS = t;
    fpsEl.textContent = String(fps);
  }

  const res = analyze();
  motionEl.textContent = res.motionPct.toString();

  // conversão do centroid para espaço do canvas (exibição)
  let centroidCanvas = null;
  if(res.centroid){
    const scaleX = canvas.width / proc.w;
    const scaleY = canvas.height / proc.h;
    centroidCanvas = { x: res.centroid.x * scaleX, y: res.centroid.y * scaleY };
    centroidEl.textContent = `${Math.round(centroidCanvas.x)}, ${Math.round(centroidCanvas.y)}`;
  } else {
    centroidEl.textContent = '-';
  }

  // ROI counting: sobe quando centroid entra em qualquer ROI (bordas incluídas)
  if(centroidCanvas){
    const hit = rois.some(r => inRect(centroidCanvas.x, centroidCanvas.y, {x: r.x*(canvas.width/proc.w), y: r.y*(canvas.height/proc.h), w: r.w*(canvas.width/proc.w), h: r.h*(canvas.height/proc.h)}));
    if(hit && !lastInside){
      roiCount++;
      roiCountEl.textContent = String(roiCount);
    }
    lastInside = hit;
  } else {
    lastInside = false;
  }

  drawOverlay(res);
  animId = requestAnimationFrame(loop);
}

/* ======= Interações ======= */
btnStart.addEventListener('click', start);
btnStop.addEventListener('click', stop);
btnResetRoi.addEventListener('click', () => { rois.length = 0; roiCount = 0; roiCountEl.textContent = '0'; });

selRes.addEventListener('change', () => { if(running) start(); });

/* desenhar ROI com mouse/arraste */
let dragging = false;
let startPt = null;
canvas.addEventListener('mousedown', (e) => {
  if(!chkDrawRoi.checked) return;
  dragging = true;
  const rect = canvas.getBoundingClientRect();
  startPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
});
canvas.addEventListener('mousemove', (e) => {
  if(!dragging || !chkDrawRoi.checked) return;
  // só para “feedback”, redesenha com retângulo provisório
  const rect = canvas.getBoundingClientRect();
  const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height); // fundo
  // não apagamos tudo para não piscar HUD; simples para demo
  const x = Math.min(startPt.x, cur.x), y = Math.min(startPt.y, cur.y);
  const w = Math.abs(cur.x - startPt.x), h = Math.abs(cur.y - startPt.y);
  ctx.strokeStyle = 'rgba(255,255,255,.8)';
  ctx.setLineDash([6,4]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
});
canvas.addEventListener('mouseup', (e) => {
  if(!dragging || !chkDrawRoi.checked) return;
  dragging = false;
  const rect = canvas.getBoundingClientRect();
  const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const x = Math.min(startPt.x, end.x), y = Math.min(startPt.y, end.y);
  const w = Math.abs(end.x - startPt.x), h = Math.abs(end.y - startPt.y);
  if(w < 8 || h < 8) return; // ignora ROI minúscula

  // salvar ROI no espaço de processamento (proc.w/ proc.h)
  const scaleX = proc.w / canvas.width;
  const scaleY = proc.h / canvas.height;
  rois.push({ x: Math.round(x * scaleX), y: Math.round(y * scaleY), w: Math.round(w * scaleX), h: Math.round(h * scaleY) });
});

/* ======= Notas de uso =======
- HTTPS/localhost obrigatório para getUserMedia.
- Se o vídeo ficar torto, ajuste o CSS do canvas (ele já escala responsivo).
- Para performance em máquinas fracas, use proc.w/h menores (ex.: 224×126).
- Quer detecção por “zonas quentes”? Podemos manter um heatmap decaindo com alpha.
- Quer múltiplos blobs? Implemento label por componente conexa (8-neigh).
*/
