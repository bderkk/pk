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

    // ── Template generation ──────────────────────────────────────────────────
    function generateTemplates() {
        if (!window.cv) return;
        const fontStr = 'bold 44px Arial';
        const tCanvas = document.createElement('canvas');
        tCanvas.width = 60; tCanvas.height = 60;
        const tCtx = tCanvas.getContext('2d', { willReadFrequently: true });
        tCtx.textBaseline = 'top';

        RANKS.forEach(r => {
            tCtx.fillStyle = 'white'; tCtx.fillRect(0, 0, 60, 60);
            tCtx.fillStyle = 'black'; tCtx.font = fontStr;
            tCtx.fillText(r === 'T' ? '10' : r, 5, 5);
            let mat = cv.imread(tCanvas);
            cv.cvtColor(mat, mat, cv.COLOR_RGBA2GRAY);
            cv.threshold(mat, mat, 128, 255, cv.THRESH_BINARY_INV);
            let rect = cv.boundingRect(mat);
            if (rect.width > 0 && rect.height > 0) {
                let crop = mat.roi(rect).clone();
                cv.resize(crop, crop, new cv.Size(30, 30));
                templates.ranks[r] = crop;
            }
            mat.delete();
        });

        const suitText = { s: '♠', h: '♥', d: '♦', c: '♣' };
        SUITS.forEach(s => {
            tCtx.fillStyle = 'white'; tCtx.fillRect(0, 0, 60, 60);
            tCtx.fillStyle = 'black'; tCtx.font = fontStr;
            tCtx.fillText(suitText[s.id], 5, 5);
            let mat = cv.imread(tCanvas);
            cv.cvtColor(mat, mat, cv.COLOR_RGBA2GRAY);
            cv.threshold(mat, mat, 128, 255, cv.THRESH_BINARY_INV);
            let rect = cv.boundingRect(mat);
            if (rect.width > 0 && rect.height > 0) {
                let crop = mat.roi(rect).clone();
                cv.resize(crop, crop, new cv.Size(30, 30));
                templates.suits[s.id] = crop;
            }
            mat.delete();
        });
        templatesGenerated = true;
    }

    // ── Camera ───────────────────────────────────────────────────────────────
    async function startCamera() {
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (animFrameId) cancelAnimationFrame(animFrameId);
        cardFrameCount = {};

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: state.facingMode, width: { ideal: 640 }, height: { ideal: 480 } }
            });
            videoElement.srcObject = stream;
            videoElement.style.transform = state.facingMode === 'user' ? 'scaleX(-1)' : 'none';
            canvas.style.transform   = state.facingMode === 'user' ? 'scaleX(-1)' : 'none';

            videoElement.onloadedmetadata = () => {
                videoElement.play();
                const vw = videoElement.videoWidth  || 640;
                const vh = videoElement.videoHeight || 480;
                canvas.width  = vw; canvas.height  = vh;
                processCanvas.width = vw; processCanvas.height = vh;
                animFrameId = requestAnimationFrame(processFrame);
            };
        } catch (err) {
            console.warn('Camera error:', err);
        }
    }

    cameraToggleBtn.addEventListener('click', () => {
        state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
        startCamera();
    });

    // ── OpenCV helpers ───────────────────────────────────────────────────────
    function orderPoints(pts) {
        pts.sort((a, b) => a.x - b.x);
        let left  = [pts[0], pts[1]].sort((a, b) => a.y - b.y);
        let right = [pts[2], pts[3]].sort((a, b) => a.y - b.y);
        return [left[0], right[0], right[1], left[1]]; // TL TR BR BL
    }

    function matchTemplateMat(imgMat, tempDict) {
        if (imgMat.cols === 0 || imgMat.rows === 0) return null;
        let bestScore = -1, bestKey = null;
        let resized = new cv.Mat();
        cv.resize(imgMat, resized, new cv.Size(30, 30));

        for (let key in tempDict) {
            let result = new cv.Mat();
            cv.matchTemplate(resized, tempDict[key], result, cv.TM_CCOEFF_NORMED);
            let mm = cv.minMaxLoc(result);
            if (mm.maxVal > bestScore) { bestScore = mm.maxVal; bestKey = key; }
            result.delete();
        }
        resized.delete();
        return bestScore > 0.45 ? bestKey : null;
    }

    // ── Real-time Modal Logic ────────────────────────────────────────────────
    function showDetectionModal(cards) {
        if (!isDetecting) return;
        isDetecting = false;
        pendingDetectedCards = cards;
        
        detectedCardsDisplay.innerHTML = '';
        cards.forEach(card => {
            const pRank = card[0] === 'T' ? '10' : card[0];
            const suitObj = SUITS.find(s => s.id === card[1]);
            const colorCl = ['h','d'].includes(card[1]) ? 'text-red-500' : 'text-slate-800';
            const html = `<div class="w-12 h-16 bg-white border border-slate-300 rounded shadow flex flex-col items-center justify-center leading-none ${colorCl}"><span class="text-xl font-bold">${pRank}</span><span class="text-lg">${suitObj.icon}</span></div>`;
            detectedCardsDisplay.insertAdjacentHTML('beforeend', html);
        });

        detectionStatus.classList.add('opacity-0');
        detectionModal.classList.remove('hidden');
        // trigger reflow
        void detectionModal.offsetWidth;
        detectionModalContent.classList.remove('scale-95', 'opacity-0');
    }

    function hideDetectionModal() {
        detectionModalContent.classList.add('scale-95', 'opacity-0');
        setTimeout(() => {
            detectionModal.classList.add('hidden');
            detectionStatus.classList.remove('opacity-0');
            pendingDetectedCards.forEach(c => cardFrameCount[c] = 0); // Reset stability
            pendingDetectedCards = [];
            isDetecting = true;
        }, 300);
    }

    // ── Main frame loop ──────────────────────────────────────────────────────
    function processFrame() {
        animFrameId = requestAnimationFrame(processFrame);

        if (!videoElement.srcObject || videoElement.readyState < 2) return;

        // Keep overlay canvas dimensions in sync with video
        if (videoElement.videoWidth > 0 && canvas.width !== videoElement.videoWidth) {
            canvas.width  = videoElement.videoWidth;
            canvas.height = videoElement.videoHeight;
            processCanvas.width  = canvas.width;
            processCanvas.height = canvas.height;
        }

        // Clear overlay — video element shows through (canvas is transparent)
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!window.cvReady || !window.cv || typeof cv.Mat !== 'function') return;
        if (!templatesGenerated) generateTemplates();

        // Copy video frame to offscreen canvas for OpenCV
        processCtx.drawImage(videoElement, 0, 0, processCanvas.width, processCanvas.height);

        try {
            let src  = cv.imread(processCanvas);
            let gray = new cv.Mat();
            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

            let blur = new cv.Mat();
            cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

            let edges = new cv.Mat();
            cv.Canny(blur, edges, 50, 150, 3, false);

            let contours  = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            let currentDetected = []; // {card, bbox}

            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area    = cv.contourArea(contour);

                if (area < 4000 || area > 80000) continue;

                let peri   = cv.arcLength(contour, true);
                let approx = new cv.Mat();
                cv.approxPolyDP(contour, approx, 0.02 * peri, true);

                if (approx.rows === 4) {
                    let points = [];
                    for (let j = 0; j < 4; j++)
                        points.push({ x: approx.data32S[j*2], y: approx.data32S[j*2+1] });
                    let ordered = orderPoints(points);

                    const W = 200, H = 300;
                    let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                        ordered[0].x, ordered[0].y,
                        ordered[1].x, ordered[1].y,
                        ordered[2].x, ordered[2].y,
                        ordered[3].x, ordered[3].y
                    ]);
                    let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, W,0, W,H, 0,H]);
                    let M      = cv.getPerspectiveTransform(srcTri, dstTri);
                    let warped = new cv.Mat();
                    cv.warpPerspective(gray, warped, M, new cv.Size(W, H));

                    let cornerMat    = warped.roi(new cv.Rect(0, 0, 50, 110));
                    let cornerThresh = new cv.Mat();
                    cv.adaptiveThreshold(cornerMat, cornerThresh, 255,
                        cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 4);

                    let kernel = cv.Mat.ones(2, 2, cv.CV_8U);
                    cv.morphologyEx(cornerThresh, cornerThresh, cv.MORPH_OPEN, kernel);

                    let cc = new cv.MatVector();
                    let ch = new cv.Mat();
                    cv.findContours(cornerThresh, cc, ch, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                    let symRects = [];
                    for (let k = 0; k < cc.size(); k++) {
                        let cr = cv.boundingRect(cc.get(k));
                        if (cr.width > 5 && cr.height > 10 && cr.width < 45 && cr.height < 45)
                            symRects.push(cr);
                    }
                    symRects.sort((a, b) => a.y - b.y);

                    if (symRects.length >= 2) {
                        let rMat = cornerThresh.roi(symRects[0]);
                        let sMat = cornerThresh.roi(symRects[1]);
                        let bRank = matchTemplateMat(rMat, templates.ranks);
                        let bSuit = matchTemplateMat(sMat, templates.suits);

                        if (bRank && bSuit) {
                            let bbox = cv.boundingRect(contour);
                            currentDetected.push({ card: bRank + bSuit, bbox });
                        }
                        rMat.delete(); sMat.delete();
                    }

                    cornerMat.delete(); cornerThresh.delete(); kernel.delete();
                    cc.delete(); ch.delete();
                    warped.delete(); M.delete(); srcTri.delete(); dstTri.delete();
                }
                approx.delete();
            }

            // Deduplicate (keep first occurrence)
            let seen = new Set();
            let unique = currentDetected.filter(d => {
                if (seen.has(d.card)) return false;
                seen.add(d.card); return true;
            });

            // Draw green (or red) rectangles + labels on transparent overlay canvas
            unique.forEach(({ card, bbox }) => {
                const isRed = card[1] === 'h' || card[1] === 'd';
                const color = isRed ? '#f87171' : '#34D399';

                ctx.strokeStyle = color;
                ctx.lineWidth   = 3;
                ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);

                // Label background
                ctx.fillStyle = 'rgba(0,0,0,0.65)';
                ctx.fillRect(bbox.x, bbox.y - 30, 58, 26);
                ctx.fillStyle = color;
                ctx.font      = 'bold 18px Arial';
                ctx.fillText(formatCard(card), bbox.x + 4, bbox.y - 9);
            });

            lastScannedCards = unique.map(d => d.card);

            if (isDetecting) {
                let newCounts = {};
                let stableNewCards = [];
                const allAssigned = [...state.hole, ...state.board];

                for (const card of lastScannedCards) {
                    newCounts[card] = (cardFrameCount[card] || 0) + 1;
                    if (newCounts[card] >= STABLE_FRAMES && !allAssigned.includes(card)) {
                        stableNewCards.push(card);
                    }
                }
                cardFrameCount = newCounts;

                if (stableNewCards.length > 0) {
                    showDetectionModal(stableNewCards);
                }
            } else {
                cardFrameCount = {};
            }

            src.delete(); gray.delete(); blur.delete(); edges.delete();
            contours.delete(); hierarchy.delete();
        } catch (_) {
            // Transient OpenCV errors during frame processing
        }
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
        importScripts("https://cdn.jsdelivr.net/npm/pokersolver@2.1.4/pokersolver.js");
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

        if (prob > 0.5) winProbText.classList.add('win-gradient', 'text-emerald-400');
        else winProbText.classList.remove('win-gradient', 'text-emerald-400');

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
