document.addEventListener('DOMContentLoaded', () => {
    const state = {
        hole: [null, null],
        board: [null, null, null, null, null],
        activeSlot: { type: 'hole', index: 0 },
        pickingRank: null,
        numOpponents: 1,
        facingMode: 'environment',
    };

    const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const SUITS = [
        { id: 's', icon: '♠', color: 'text-slate-800 bg-slate-100' },
        { id: 'h', icon: '♥', color: 'text-red-500 bg-red-100' },
        { id: 'd', icon: '♦', color: 'text-red-500 bg-red-100' },
        { id: 'c', icon: '♣', color: 'text-slate-800 bg-slate-100' }
    ];

    const templates = { ranks: {}, suits: {} };
    let templatesGenerated = false;

    const videoElement = document.getElementById('camera-feed');
    const canvas = document.getElementById('overlay-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Offscreen canvas for OpenCV — video element stays visible
    const processCanvas = document.createElement('canvas');
    const processCtx = processCanvas.getContext('2d', { willReadFrequently: true });

    const detectionStatus = document.getElementById('detection-status');
    const detectionModal = document.getElementById('detection-modal');
    const detectionModalContent = document.getElementById('detection-modal-content');
    const detectedCardsDisplay = document.getElementById('detected-cards-display');
    const assignHoleBtn = document.getElementById('assign-hole-btn');
    const assignBoardBtn = document.getElementById('assign-board-btn');
    const discardDetBtn = document.getElementById('discard-det-btn');
    let isDetecting = true;
    let pendingDetectedCards = [];
    const cameraToggleBtn = document.getElementById('camera-toggle-btn');
    const clearBtn = document.getElementById('clear-btn');
    const cardSlots = document.querySelectorAll('.card-slot');
    const cardPicker = document.getElementById('card-picker');
    const pickerOverlay = document.getElementById('picker-overlay');
    const rankPickerCont = document.getElementById('rank-picker');
    const suitPickerCont = document.getElementById('suit-picker');
    const closePickerBtn = document.getElementById('close-picker-btn');
    const winProbText = document.getElementById('win-prob');
    const adviceText = document.getElementById('advice-text');
    const handDescText = document.getElementById('hand-desc');
    const opponentsInput = document.getElementById('opponents-input');

    let stream = null;
    let animFrameId = null;
    let lastScannedCards = [];
    let cardFrameCount = {};   // card -> consecutive frames seen
    const STABLE_FRAMES = 8;  // frames before auto-fill

    const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
    function formatCard(c) {
        return (c[0] === 'T' ? '10' : c[0]) + (SUIT_SYMBOLS[c[1]] || c[1]);
    }

    
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


    // ── Card picker UI ───────────────────────────────────────────────────────
    function initPickers() {
        RANKS.forEach(rank => {
            const btn = document.createElement('button');
            btn.className = 'py-2 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold text-center transition-colors';
            btn.innerText = rank === 'T' ? '10' : rank;
            btn.onclick = () => selectRank(rank);
            rankPickerCont.appendChild(btn);
        });
        SUITS.forEach(suit => {
            const btn = document.createElement('button');
            btn.className = `py-3 rounded text-xl flex justify-center items-center ${suit.color} border-2 border-transparent disabled:opacity-50 transition-colors`;
            btn.innerHTML = suit.icon;
            btn.onclick = () => selectSuit(suit.id);
            suitPickerCont.appendChild(btn);
        });
    }

    function updateUI() {
        cardSlots.forEach(slot => {
            const type  = slot.dataset.type;
            const index = parseInt(slot.dataset.index);
            const card  = state[type][index];

            slot.classList.remove('active', 'filled');
            if (state.activeSlot && state.activeSlot.type === type && state.activeSlot.index === index)
                slot.classList.add('active');

            if (card) {
                slot.classList.add('filled');
                const pRank   = card[0] === 'T' ? '10' : card[0];
                const suitObj = SUITS.find(s => s.id === card[1]);
                const colorCl = ['h','d'].includes(card[1]) ? 'text-red-500' : 'text-slate-800';
                slot.innerHTML = `<div class="flex flex-col items-center leading-none ${colorCl}"><span class="text-xl">${pRank}</span><span class="text-xs mt-1">${suitObj.icon}</span></div>`;
            } else {
                slot.innerHTML = type === 'hole'
                    ? '?'
                    : (index < 3 ? `F${index+1}` : (index === 3 ? 'T' : 'R'));
                slot.classList.add('text-slate-500');
            }
        });
        calculateOddsUI();
    }

    function openPicker(type, index) {
        isDetecting = false;
        pendingDetectedCards = [];
        cardFrameCount = {};
        state.activeSlot = { type, index };
        state.pickingRank = null;
        updateUI();
        Array.from(suitPickerCont.children).forEach(b => b.classList.add('opacity-30', 'pointer-events-none'));
        Array.from(rankPickerCont.children).forEach(b => {
            b.classList.remove('bg-blue-600', 'text-white');
            b.classList.add('bg-slate-700');
        });
        cardPicker.classList.remove('translate-y-full');
        pickerOverlay.classList.remove('hidden');
        setTimeout(() => pickerOverlay.classList.remove('opacity-0'), 10);
    }

    function closePicker() {
        cardPicker.classList.add('translate-y-full');
        pickerOverlay.classList.add('opacity-0');
        setTimeout(() => pickerOverlay.classList.add('hidden'), 300);
        state.activeSlot = null;
        isDetecting = true;
        updateUI();
    }

    function selectRank(rank) {
        state.pickingRank = rank;
        Array.from(rankPickerCont.children).forEach((btn, idx) => {
            const isSelected = RANKS[idx] === rank;
            btn.classList.toggle('bg-blue-600', isSelected);
            btn.classList.toggle('text-white',  isSelected);
            btn.classList.toggle('bg-slate-700', !isSelected);
        });
        Array.from(suitPickerCont.children).forEach(b => b.classList.remove('opacity-30', 'pointer-events-none'));
    }

    function selectSuit(suit) {
        if (!state.pickingRank || !state.activeSlot) return;
        state[state.activeSlot.type][state.activeSlot.index] = state.pickingRank + suit;
        if (state.activeSlot.type === 'hole') {
            if      (state.activeSlot.index === 0) openPicker('hole', 1);
            else if (state.activeSlot.index === 1 && !state.board[0]) openPicker('board', 0);
            else closePicker();
        } else {
            if (state.activeSlot.index < 4) openPicker('board', state.activeSlot.index + 1);
            else closePicker();
        }
        updateUI();
    }

    cardSlots.forEach(slot => slot.addEventListener('click', () => openPicker(slot.dataset.type, parseInt(slot.dataset.index))));
    closePickerBtn.addEventListener('click', closePicker);
    pickerOverlay.addEventListener('click', closePicker);

    clearBtn.addEventListener('click', () => {
        state.hole  = [null, null];
        state.board = [null, null, null, null, null];
        state.activeSlot = { type: 'hole', index: 0 };
        cardFrameCount = {};
        updateUI();
    });

    opponentsInput.addEventListener('change', e => {
        state.numOpponents = parseInt(e.target.value) || 1;
        calculateOddsUI();
    });

    // Modal Handlers
    assignHoleBtn.addEventListener('click', () => {
        pendingDetectedCards.forEach(c => {
            if (!state.hole[0]) state.hole[0] = c;
            else if (!state.hole[1]) state.hole[1] = c;
        });
        updateUI();
        hideDetectionModal();
    });

    assignBoardBtn.addEventListener('click', () => {
        pendingDetectedCards.forEach(c => {
            if (!state.board[0]) state.board[0] = c;
            else if (!state.board[1]) state.board[1] = c;
            else if (!state.board[2]) state.board[2] = c;
            else if (!state.board[3]) state.board[3] = c;
            else if (!state.board[4]) state.board[4] = c;
        });
        updateUI();
        hideDetectionModal();
    });

    discardDetBtn.addEventListener('click', hideDetectionModal);

    // ── Odds calculation (Web Worker) ────────────────────────────────────────
    const workerCode = `
        importScripts("https://cdn.jsdelivr.net/npm/pokersolver@2.1.4/dist/pokersolver.min.js");
        self.onmessage = function(e) {
            const { calcId, myCards, boardCards, numOpponents, iterations, RANKS, SUITS } = e.data;
            if (!self.Hand) { self.postMessage({ prob: 0, calcId }); return; }
            const fullDeck = RANKS.flatMap(r => SUITS.map(s => r + s.id));
            let wins = 0, ties = 0;
            const known = [...myCards, ...boardCards];
            let remainingDeck = fullDeck.filter(c => !known.includes(c));

            for (let i = 0; i < iterations; i++) {
                let deck = [...remainingDeck];
                for (let j = deck.length - 1; j > 0; j--) {
                    const k = Math.floor(Math.random() * (j + 1));
                    [deck[j], deck[k]] = [deck[k], deck[j]];
                }
                let simBoard = [...boardCards];
                let di = 0;
                while (simBoard.length < 5) simBoard.push(deck[di++]);

                let myHand = Hand.solve([...myCards, ...simBoard]);
                let oppHands = [];
                for (let o = 0; o < numOpponents; o++) {
                    oppHands.push(Hand.solve([deck[di++], deck[di++], ...simBoard]));
                }

                let winners = Hand.winners([myHand, ...oppHands]);
                if (winners.length === 1 && winners[0] === myHand) wins++;
                else if (winners.includes(myHand)) ties++;
            }
            self.postMessage({ prob: (wins + ties / (numOpponents + 1)) / iterations, calcId });
        };
    `;
    const workerBlob = new Blob([workerCode], {type: 'application/javascript'});
    const oddsWorker = new Worker(URL.createObjectURL(workerBlob));
    let currentOddsCalcId = 0;

    oddsWorker.onmessage = (e) => {
        const { prob, calcId } = e.data;
        if (calcId !== currentOddsCalcId) return;

        const probPct = (prob * 100).toFixed(1);
        winProbText.innerText = `${probPct}%`;

        winProbText.className = "text-3xl font-extrabold";
        if (prob > 0.5) winProbText.classList.add('win-gradient', 'text-emerald-400');
        else winProbText.classList.add('text-white');

        const fairShare = 1 / (state.numOpponents + 1);
        if (prob > fairShare * 1.5) {
            adviceText.innerText  = '🔥 APOSTAR / SUBIR';
            adviceText.className  = 'text-lg font-extrabold text-emerald-400 drop-shadow-[0_0_10px_rgba(52,211,153,0.5)]';
        } else if (prob > fairShare * 0.85) {
            adviceText.innerText  = '👀 IGUALAR (CALL)';
            adviceText.className  = 'text-lg font-extrabold text-yellow-400 drop-shadow-[0_0_10px_rgba(250,204,21,0.5)]';
        } else {
            adviceText.innerText  = '🛑 RETIRARSE (FOLD)';
            adviceText.className  = 'text-lg font-extrabold text-red-500 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]';
        }
    };

    function calculateOddsUI() {
        const myCards    = state.hole.filter(c => c);
        const boardCards = state.board.filter(c => c);

        if (myCards.length < 2) {
            winProbText.innerHTML = '--%';
            adviceText.innerText  = 'ESPERANDO...';
            adviceText.className  = 'text-lg font-extrabold text-slate-500';
            handDescText.innerText = 'Introduce tus 2 cartas';
            currentOddsCalcId++; // cancel previous
            return;
        }

        if (boardCards.length >= 3 && window.Hand) {
            const h = Hand.solve([...myCards, ...boardCards]);
            handDescText.innerText = `Jugada: ${h.name}`;
        } else if (window.Hand) {
            const h = Hand.solve([...myCards]);
            handDescText.innerText = `Mano: ${h.name}`;
        }

        winProbText.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg text-slate-400"></i>';
        adviceText.innerText  = 'CALCULANDO...';
        adviceText.className  = 'text-sm font-bold text-slate-400 mt-1';

        currentOddsCalcId++;
        let iterations = 2500;
        if (boardCards.length === 0) iterations = 800; // Less for preflop to respond faster

        oddsWorker.postMessage({
            calcId: currentOddsCalcId,
            myCards,
            boardCards,
            numOpponents: state.numOpponents,
            iterations,
            RANKS,
            SUITS
        });
    }

    // ── Boot ─────────────────────────────────────────────────────────────────
    initPickers();
    updateUI();
    startCamera();
});
