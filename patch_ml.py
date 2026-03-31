import re

with open('app.js', 'r', encoding='utf-8') as f:
    code = f.read()

# Replace templates block + OpenCV helpers + processFrame up to initPickers()
new_code = """
    // ── ONNX Web Inference ───────────────────────────────────────────────────
    let ortSession = null;
    let isModelLoading = false;
    const MODEL_CLASSES = ['10c','10d','10h','10s','2c','2d','2h','2s','3c','3d','3h','3s','4c','4d','4h','4s','5c','5d','5h','5s','6c','6d','6h','6s','7c','7d','7h','7s','8c','8d','8h','8s','9c','9d','9h','9s','Ac','Ad','Ah','As','Jc','Jd','Jh','Js','Kc','Kd','Kh','Ks','Qc','Qd','Qh','Qs'];

    function getStandardCard(clsName) {
        if (!clsName) return null;
        let c = clsName.toLowerCase();
        let r = c.slice(0, -1);
        if (r === '10') r = 'T';
        else r = r.toUpperCase();
        let s = c.slice(-1);
        return r + s; // yields 'Ac', 'Ts', '2h'
    }

    async function ensureModel() {
        if (ortSession || isModelLoading) return;
        isModelLoading = true;
        try {
            if (typeof ort !== 'undefined') {
                ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
                ortSession = await ort.InferenceSession.create('yolov8s_playing_cards.onnx');
                detectionStatus.innerHTML = '<div class="w-2 h-2 rounded-full bg-emerald-500 mr-2"></div> ML Activo';
            }
        } catch (err) {
            console.error('ONNX model load error:', err);
            detectionStatus.innerHTML = '<div class="w-2 h-2 rounded-full bg-red-500 mr-2"></div> ML Error';
        }
        isModelLoading = false;
    }

    async function processFrame() {
        if (!ortSession) {
            await ensureModel();
            animFrameId = requestAnimationFrame(processFrame);
            return;
        }

        if (!videoElement.srcObject || videoElement.readyState < 2) {
            animFrameId = requestAnimationFrame(processFrame);
            return;
        }

        if (videoElement.videoWidth > 0 && canvas.width !== videoElement.videoWidth) {
            canvas.width  = videoElement.videoWidth;
            canvas.height = videoElement.videoHeight;
            processCanvas.width = 416;
            processCanvas.height = 416;
        }

        if (!processCanvas.width || !processCanvas.height) {
            animFrameId = requestAnimationFrame(processFrame);
            return;
        }

        if (!isDetecting) {
            ctx.clearRect(0, 0, canvas.width, canvas.height); // clear overlay
            animFrameId = requestAnimationFrame(processFrame);
            return; // Pause ML effectively
        }

        try {
            const ctxP = processCanvas.getContext('2d', { willReadFrequently: true });
            ctxP.drawImage(videoElement, 0, 0, 416, 416);
            let imgData = ctxP.getImageData(0, 0, 416, 416).data;

            // Prepare NCHW Float32 tensor for ONNX
            const float32Data = new Float32Array(3 * 416 * 416);
            for (let i = 0; i < 416 * 416; i++) {
                float32Data[i] = imgData[i * 4] / 255.0;            
                float32Data[416 * 416 + i] = imgData[i * 4 + 1] / 255.0;
                float32Data[2 * 416 * 416 + i] = imgData[i * 4 + 2] / 255.0;
            }

            const tensor = new ort.Tensor('float32', float32Data, [1, 3, 416, 416]);
            const results = await ortSession.run({ images: tensor });
            const output = results[ortSession.outputNames[0]];

            const numClasses = output.dims[1] - 4; // usually 52
            const numAnchors = output.dims[2];
            const data = output.data;

            let boxes = [];
            for (let i = 0; i < numAnchors; i++) {
                let maxConf = 0;
                let maxCls = -1;
                for (let c = 0; c < numClasses; c++) {
                    const conf = data[(4 + c) * numAnchors + i];
                    if (conf > maxConf) { maxConf = conf; maxCls = c; }
                }
                
                if (maxConf > 0.45) {
                    const xc = data[0 * numAnchors + i];
                    const yc = data[1 * numAnchors + i];
                    const w  = data[2 * numAnchors + i];
                    const h  = data[3 * numAnchors + i];
                    
                    const sx = canvas.width / 416;
                    const sy = canvas.height / 416;
                    
                    boxes.push({
                        x: (xc - w/2) * sx,
                        y: (yc - h/2) * sy,
                        w: w * sx,
                        h: h * sy,
                        conf: maxConf,
                        cardStr: getStandardCard(MODEL_CLASSES[maxCls])
                    });
                }
            }

            // Standard NMS implementation
            boxes.sort((a,b) => b.conf - a.conf);
            let nmsBoxes = [];
            for (let b of boxes) {
                let keep = true;
                for (let kept of nmsBoxes) {
                    const interX = Math.max(0, Math.min(b.x+b.w, kept.x+kept.w) - Math.max(b.x, kept.x));
                    const interY = Math.max(0, Math.min(b.y+b.h, kept.y+kept.h) - Math.max(b.y, kept.y));
                    const interArea = interX * interY;
                    const unionArea = b.w*b.h + kept.w*kept.h - interArea;
                    if (interArea / unionArea > 0.45) { keep = false; break; }
                }
                if (keep) nmsBoxes.push(b);
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            let currentDetectedNames = [];

            nmsBoxes.forEach(b => {
                if (!b.cardStr) return;
                const color = ['h','d'].includes(b.cardStr[1]) ? '#f87171' : '#34D399';
                ctx.strokeStyle = color;
                ctx.lineWidth = 3;
                ctx.strokeRect(b.x, b.y, b.w, b.h);

                ctx.fillStyle = 'rgba(0,0,0,0.65)';
                ctx.fillRect(b.x, b.y - 30, 58, 26);
                ctx.fillStyle = color;
                ctx.font = 'bold 18px Arial';
                ctx.fillText(formatCard(b.cardStr), b.x + 4, b.y - 9);
                
                currentDetectedNames.push(b.cardStr);
            });

            // Stability check for ML detection output
            let newCounts = {};
            let stableNewCards = [];
            const allAssigned = [...state.hole, ...state.board];

            for (const c of currentDetectedNames) {
                newCounts[c] = (cardFrameCount[c] || 0) + 1;
                // STABLE_FRAMES can be 4 since ML is very stable
                if (newCounts[c] >= 4 && !allAssigned.includes(c)) {
                    stableNewCards.push(c);
                }
            }
            cardFrameCount = newCounts;

            if (stableNewCards.length > 0) {
                showDetectionModal(stableNewCards);
            }

        } catch (err) {
            console.error("Frame error ML:", err);
        }

        animFrameId = requestAnimationFrame(processFrame);
    }
"""

pattern = re.compile(r"// ── Template generation ──────────────────────────────────────────────────.*?// ── Card picker UI ───────────────────────────────────────────────────────", re.DOTALL)

res = pattern.sub(new_code + "\n\n    // ── Card picker UI ───────────────────────────────────────────────────────", code)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(res)
