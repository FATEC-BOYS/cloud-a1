import React, { useEffect, useRef, useState } from "react";

// Interface funcional e bonita: Transmissão em tempo real com análise espacial
// - Mantém TODA a lógica original (frame differencing + heatmap + ROI)
// - Melhora apenas a apresentação (Tailwind classes), sem libs novas
// - Pronta para Vite React TS

// Tipo para ROI
type Point = { x: number; y: number };

export default function RealtimeSpatialAnalysis() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null); // offscreen para análise
  const prevFrameRef = useRef<ImageData | null>(null);
  const rafRef = useRef<number | null>(null);

  // Estados principais
  const [running, setRunning] = useState(false);
  const [heatEnabled, setHeatEnabled] = useState(true);
  const [motionSensitivity, setMotionSensitivity] = useState(25); // 0..255
  const [gridSize, setGridSize] = useState(24); // px (célula)
  const [roiMode, setRoiMode] = useState<"none" | "polygon">("none");
  const [roi, setRoi] = useState<Point[]>([]);
  const [stats, setStats] = useState({ fps: 0, motion: 0, cellsActive: 0 });
  const [heatmap, setHeatmap] = useState<number[][]>([]); // heat acumulado

  // Helpers
  const getCanvasDims = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return { w: 0, h: 0 };
    const w = video.videoWidth || canvas.width || 0;
    const h = video.videoHeight || canvas.height || 0;
    return { w, h };
  };

  const startCamera = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (roiMode !== "polygon") return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setRoi((prev) => [...prev, { x, y }]);
  };

  const clearROI = () => setRoi([]);

  const pointInPolygon = (x: number, y: number, poly: Point[]) => {
    if (poly.length < 3) return true; // sem ROI => tudo vale
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-6) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };

  const analyze = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      rafRef.current = requestAnimationFrame(analyze);
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      rafRef.current = requestAnimationFrame(analyze);
      return;
    }

    const workCanvas = (workCanvasRef.current ||= document.createElement("canvas"));
    const wctx = workCanvas.getContext("2d");
    if (!wctx) {
      rafRef.current = requestAnimationFrame(analyze);
      return;
    }

    const { w, h } = getCanvasDims();
    if (!w || !h) {
      rafRef.current = requestAnimationFrame(analyze);
      return;
    }

    // Ajusta dimensões
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (workCanvas.width !== w) workCanvas.width = w;
    if (workCanvas.height !== h) workCanvas.height = h;

    // Desenha o vídeo no offscreen e lê pixels
    wctx.drawImage(video, 0, 0, w, h);
    const curr = wctx.getImageData(0, 0, w, h);

    // Inicializa heatmap se vazio
    if (heatmap.length === 0) {
      const cols = Math.ceil(w / gridSize);
      const rows = Math.ceil(h / gridSize);
      setHeatmap(Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0)));
    }

    const prev = prevFrameRef.current;
    let motionPixels = 0;

    if (prev) {
      const data = curr.data;
      const p = prev.data;
      const len = data.length;
      const th = motionSensitivity; // threshold por canal

      const cols = Math.ceil(w / gridSize);
      const rows = Math.ceil(h / gridSize);
      const frameGrid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));

      for (let i = 0; i < len; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const r0 = p[i];
        const g0 = p[i + 1];
        const b0 = p[i + 2];
        const dr = Math.abs(r - r0);
        const dg = Math.abs(g - g0);
        const db = Math.abs(b - b0);
        const isMotion = dr > th || dg > th || db > th;
        if (isMotion) {
          const idx = i / 4;
          const x = idx % w;
          const y = Math.floor(idx / w);
          if (pointInPolygon(x, y, roi)) {
            motionPixels++;
            const cx = Math.floor(x / gridSize);
            const cy = Math.floor(y / gridSize);
            frameGrid[cy][cx] += 1;
          }
        }
      }

      // Atualiza heatmap acumulado com leve decaimento para evitar saturação
      if (heatEnabled && heatmap.length) {
        const newHeat = heatmap.map((row, ry) =>
          row.map((val, rx) => Math.max(0, Math.floor(val * 0.98) + (frameGrid[ry]?.[rx] || 0)))
        );
        setHeatmap(newHeat);
      }

      // Desenha overlay
      ctx.clearRect(0, 0, w, h);

      // Heatmap em vermelho translúcido
      if (heatEnabled && heatmap.length) {
        const maxVal = heatmap.reduce((m, row) => Math.max(m, ...row), 1);
        for (let ry = 0; ry < heatmap.length; ry++) {
          for (let rx = 0; rx < heatmap[0].length; rx++) {
            const val = heatmap[ry][rx];
            if (val <= 0) continue;
            const alpha = Math.min(0.8, val / maxVal);
            const x = rx * gridSize;
            const y = ry * gridSize;
            ctx.fillStyle = `rgba(255,0,0,${alpha})`;
            ctx.fillRect(x, y, gridSize, gridSize);
          }
        }
      }

      // ROI
      if (roi.length >= 2) {
        ctx.strokeStyle = "#22c55e"; // emerald-500
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(roi[0].x, roi[0].y);
        for (let i = 1; i < roi.length; i++) ctx.lineTo(roi[i].x, roi[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = "rgba(34,197,94,0.15)";
        ctx.fill();
      }

      // Estatísticas simples
      const activeCells = heatmap.reduce((acc, row) => acc + row.filter((v) => v > 0).length, 0);
      setStats((s) => ({ ...s, motion: motionPixels, cellsActive: activeCells }));
    }

    prevFrameRef.current = curr;
    rafRef.current = requestAnimationFrame(analyze);
  };

  // Medidor de FPS (UI)
  useEffect(() => {
    let last = performance.now();
    let frames = 0;
    let alive = true;
    const loop = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        setStats((s) => ({ ...s, fps: frames }));
        frames = 0;
        last = now;
      }
      if (alive) requestAnimationFrame(loop);
    };
    loop();
    return () => {
      alive = false;
    };
  }, []);

  // Lifecycle de câmera e limpeza
  useEffect(() => {
    startCamera().catch(console.error);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const stream = videoRef.current?.srcObject as MediaStream | undefined;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Inicia/Pausa análise
  useEffect(() => {
    if (running) {
      rafRef.current = requestAnimationFrame(analyze);
    } else if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, heatEnabled, gridSize, motionSensitivity, roi]);

  const { w, h } = getCanvasDims();

  // Cores utilitárias
  const statusColor = running ? "bg-emerald-500" : "bg-rose-500";
  const statusText = running ? "Ao vivo" : "Pausado";

  return (
    <div className="relative min-h-screen bg-neutral-950 text-neutral-100">
      {/* BG decorativo suave */}
      <div className="pointer-events-none absolute inset-0 [background:radial-gradient(1200px_600px_at_50%_-100px,rgba(16,185,129,0.18),transparent_60%),radial-gradient(1200px_600px_at_100%_0,rgba(6,182,212,0.12),transparent_60%),radial-gradient(1200px_600px_at_0%_0,rgba(244,63,94,0.12),transparent_60%)]" />

      <div className="relative max-w-6xl mx-auto p-6 space-y-6">
        {/* Topbar */}
        <header className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-neutral-900/50 backdrop-blur px-4 py-3 shadow-lg">
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-lg bg-gradient-to-tr from-emerald-400 to-cyan-400" />
            <div>
              <h1 className="text-lg md:text-xl font-semibold leading-tight">Transmissão em tempo real</h1>
              <p className="text-xs text-neutral-400">Análise espacial com heatmap e ROI</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium ${statusColor} text-neutral-900 shadow`}>● {statusText}</span>
            <button
              onClick={() => setRunning((v) => !v)}
              className={`px-4 py-2 rounded-xl shadow transition-colors focus:outline-none focus:ring-2 focus:ring-white/20 ${running ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"}`}
            >
              {running ? "Pausar" : "Iniciar"}
            </button>
            <button
              onClick={() => {
                setHeatmap([]);
                prevFrameRef.current = null;
              }}
              className="px-4 py-2 rounded-xl shadow bg-neutral-800 hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 focus:ring-white/20"
            >
              Limpar
            </button>
          </div>
        </header>

        {/* Grid principal */}
        <section className="grid md:grid-cols-[2fr_1fr] gap-6 items-start">
          {/* Card do player */}
          <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-neutral-900/40 backdrop-blur shadow-2xl">
            {/* Cabeçalho do card */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <div className="flex items-center gap-2 text-sm text-neutral-300">
                <span className="inline-block size-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Feed da câmera</span>
              </div>
              <div className="text-xs text-neutral-400">{w}×{h}px</div>
            </div>

            {/* Área de vídeo */}
            <div className="relative">
              {/* Para manter proporção caso o vídeo demore */}
              <div className="aspect-video bg-neutral-950/40" />
              <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" playsInline muted />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full cursor-crosshair"
                onClick={onCanvasClick}
              />
            </div>

            {/* Rodapé do card (dicas) */}
            <div className="px-4 py-3 border-t border-white/10 text-xs text-neutral-400">
              {roiMode === "polygon" ? (
                <p>ROI ativa: clique para adicionar pontos e clique próximo ao primeiro para fechar o polígono. <button onClick={clearROI} className="underline decoration-dotted">Limpar ROI</button></p>
              ) : (
                <p>Dica: ative a ROI (polígono) no painel ao lado para restringir a análise a uma área específica.</p>
              )}
            </div>
          </div>

          {/* Painel lateral */}
          <aside className="p-5 rounded-2xl border border-white/10 bg-neutral-900/50 backdrop-blur shadow-xl space-y-5">
            <h2 className="text-base font-semibold text-emerald-400">Controles</h2>

            {/* Sensibilidade */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <label className="text-neutral-300">Sensibilidade ao movimento</label>
                <span className="px-2 py-0.5 rounded bg-neutral-800 text-neutral-200 text-xs">{motionSensitivity}</span>
              </div>
              <input
                type="range"
                min={5}
                max={80}
                value={motionSensitivity}
                onChange={(e) => setMotionSensitivity(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>

            {/* Grid size */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <label className="text-neutral-300">Tamanho da célula (px)</label>
                <span className="px-2 py-0.5 rounded bg-neutral-800 text-neutral-200 text-xs">{gridSize}</span>
              </div>
              <input
                type="range"
                min={8}
                max={64}
                step={1}
                value={gridSize}
                onChange={(e) => setGridSize(Number(e.target.value))}
                className="w-full accent-cyan-500"
              />
            </div>

            {/* Heatmap toggle */}
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-neutral-300">Exibir heatmap</div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input type="checkbox" className="sr-only peer" checked={heatEnabled} onChange={(e) => setHeatEnabled(e.target.checked)} />
                <div className="peer h-6 w-11 rounded-full bg-neutral-700 after:absolute after:top-[4px] after:left-[4px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-emerald-500 peer-checked:after:translate-x-5" />
              </label>
            </div>

            {/* ROI */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm text-neutral-300">ROI (polígono)</div>
                <button onClick={() => setRoiMode(roiMode === "polygon" ? "none" : "polygon")} className={`px-3 py-1.5 rounded-lg text-sm shadow ${roiMode === "polygon" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-neutral-800 hover:bg-neutral-700"}`}>
                  {roiMode === "polygon" ? "Ativada" : "Desligada"}
                </button>
              </div>
              <div className="flex gap-2">
                <button onClick={clearROI} className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm shadow">Limpar ROI</button>
                <button onClick={() => setRoi([])} className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm shadow">Reset</button>
              </div>
            </div>

            {/* Estatísticas */}
            <div className="pt-3 border-t border-white/10">
              <h3 className="text-sm font-semibold text-cyan-400 mb-2">Estatísticas</h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-xl bg-neutral-800/70 p-3 border border-white/10"><div className="text-xs text-neutral-400">FPS (UI)</div><div className="text-base font-semibold">{stats.fps}</div></div>
                <div className="rounded-xl bg-neutral-800/70 p-3 border border-white/10"><div className="text-xs text-neutral-400">Células ativas</div><div className="text-base font-semibold">{stats.cellsActive}</div></div>
                <div className="rounded-xl bg-neutral-800/70 p-3 border border-white/10 col-span-2"><div className="text-xs text-neutral-400">Pixels com movimento (frame)</div><div className="text-base font-semibold">{stats.motion}</div></div>
              </div>
            </div>

            {/* Ajuda / Integrações */}
            <div className="pt-3 border-t border-white/10 text-xs text-neutral-400 space-y-1">
              <p>Integrações possíveis: Web Workers, TensorFlow.js, ONNX Runtime Web, WebRTC/SFU, OpenCV.js.</p>
            </div>
          </aside>
        </section>

        <footer className="text-xs text-neutral-400 text-center">
          Protótipo front‑end. Em produção: SFU/MCU, autenticação de streams, limites de CPU/GPU e LGPD.
        </footer>
      </div>
    </div>
  );
}
