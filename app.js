document.addEventListener('DOMContentLoaded', () => {
    const state = {
        hole: [null, null],
        board: [null, null, null, null, null],
        activeSlot: { type: 'hole', index: 0 },
        pickingRank: null,
        numOpponents: 1,
        facingMode: 'environment',
        scannedCardsSet: new Set()
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
    
    const scanBtn = document.getElementById('scan-btn');
    const detectedCount = document.getElementById('detected-count');
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
    let isProcessingFrame = false;
    let lastScannedCards = [];

    function generateTemplates() {
        if (!window.cv) return;
        const fontStr = "bold 44px Arial";
        const tCanvas = document.createElement('canvas');
        tCanvas.width = 60; tCanvas.height = 60;
        const tCtx = tCanvas.getContext('2d', { willReadFrequently: true });
        tCtx.textBaseline = 'top';

        // Ranks
        RANKS.forEach(r => {
            tCtx.fillStyle = 'white'; tCtx.fillRect(0,0,60,60);
            tCtx.fillStyle = 'black'; tCtx.font = fontStr;
            tCtx.fillText(r === 'T' ? '10' : r, 5, 5);
            let mat = cv.imread(tCanvas);
            cv.cvtColor(mat, mat, cv.COLOR_RGBA2GRAY);
            cv.threshold(mat, mat, 128, 255, cv.THRESH_BINARY_INV);
            let rect = cv.boundingRect(mat);
            if(rect.width > 0 && rect.height > 0) {
                let crop = mat.roi(rect).clone();
                cv.resize(crop, crop, new cv.Size(30, 30));
                templates.ranks[r] = crop;
            }
            mat.delete();
        });
        
        // Suits
        const suitText = { 's':'♠', 'h':'♥', 'd':'♦', 'c':'♣' };
        SUITS.forEach(s => {
            tCtx.fillStyle = 'white'; tCtx.fillRect(0,0,60,60);
            tCtx.fillStyle = 'black'; tCtx.font = fontStr;
            tCtx.fillText(suitText[s.id], 5, 5);
            let mat = cv.imread(tCanvas);
            cv.cvtColor(mat, mat, cv.COLOR_RGBA2GRAY);
            cv.threshold(mat, mat, 128, 255, cv.THRESH_BINARY_INV);
            let rect = cv.boundingRect(mat);
            if(rect.width > 0 && rect.height > 0) {
                let crop = mat.roi(rect).clone();
                cv.resize(crop, crop, new cv.Size(30, 30));
                templates.suits[s.id] = crop;
            }
            mat.delete();
        });
        templatesGenerated = true;
    }

    async function startCamera() {
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: state.facingMode, width: { ideal: 640 }, height: { ideal: 480 } }
                });
                videoElement.srcObject = stream;
                
                // Flip horizontally if using front camera
                videoElement.style.transform = state.facingMode === 'user' ? 'scaleX(-1)' : 'none';
                canvas.style.transform = state.facingMode === 'user' ? 'scaleX(-1)' : 'none';

                videoElement.onloadedmetadata = () => {
                    videoElement.play();
                    canvas.width = videoElement.videoWidth;
                    canvas.height = videoElement.videoHeight;
                    if (!isProcessingFrame) {
                        isProcessingFrame = true;
                        requestAnimationFrame(processFrame);
                    }
                };
            } catch (err) {
                console.warn("Camera access denied or not available", err);
            }
        }
    }

    cameraToggleBtn.addEventListener('click', () => {
        state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
        startCamera();
    });

    function orderPoints(pts) {
        pts.sort((a,b) => a.x - b.x);
        let leftMost = [pts[0], pts[1]];
        let rightMost = [pts[2], pts[3]];
        leftMost.sort((a,b) => a.y - b.y);
        rightMost.sort((a,b) => a.y - b.y);
        return [leftMost[0], rightMost[0], rightMost[1], leftMost[1]]; // TL, TR, BR, BL
    }

    function matchTemplateMat(imgMat, tempDict) {
        if(imgMat.cols === 0 || imgMat.rows === 0) return null;
        let bestScore = -1;
        let bestKey = null;
        let resized = new cv.Mat();
        cv.resize(imgMat, resized, new cv.Size(30, 30));
        
        for(let key in tempDict) {
            let tMat = tempDict[key];
            let result = new cv.Mat();
            cv.matchTemplate(resized, tMat, result, cv.TM_CCOEFF_NORMED);
            let minMax = cv.minMaxLoc(result);
            if(minMax.maxVal > bestScore) {
                bestScore = minMax.maxVal;
                bestKey = key;
            }
            result.delete();
        }
        resized.delete();
        return bestScore > 0.45 ? bestKey : null; 
    }

    function processFrame() {
        if (videoElement.paused || videoElement.ended) {
            requestAnimationFrame(processFrame);
            return;
        }

        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

        if (window.cvReady && window.cv && typeof cv.Mat === 'function') {
            if(!templatesGenerated) generateTemplates();

            try {
                let src = cv.imread(canvas);
                let gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
                
                let blur = new cv.Mat();
                cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
                
                let edges = new cv.Mat();
                cv.Canny(blur, edges, 50, 150, 3, false);

                let contours = new cv.MatVector();
                let hierarchy = new cv.Mat();
                cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                let currentScanned = [];

                for (let i = 0; i < contours.size(); i++) {
                    let contour = contours.get(i);
                    let area = cv.contourArea(contour);
                    
                    if (area > 4000 && area < 80000) {
                        let peri = cv.arcLength(contour, true);
                        let approx = new cv.Mat();
                        cv.approxPolyDP(contour, approx, 0.02 * peri, true);
                        
                        if (approx.rows === 4) {
                            let points = [];
                            for(let j=0; j<4; j++){ points.push({x: approx.data32S[j*2], y: approx.data32S[j*2+1]}); }
                            let ordered = orderPoints(points);
                            
                            // Warp Perspective
                            let w = 200, h = 300;
                            let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                                ordered[0].x, ordered[0].y, ordered[1].x, ordered[1].y,
                                ordered[2].x, ordered[2].y, ordered[3].x, ordered[3].y
                            ]);
                            let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
                            let M = cv.getPerspectiveTransform(srcTri, dstTri);
                            let warped = new cv.Mat();
                            cv.warpPerspective(gray, warped, M, new cv.Size(w, h));

                            // Crop corner
                            let cornerMat = warped.roi(new cv.Rect(0, 0, 50, 110));
                            let cornerThresh = new cv.Mat();
                            cv.adaptiveThreshold(cornerMat, cornerThresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 4);
                            
                            // Remove noise
                            let kernel = cv.Mat.ones(2, 2, cv.CV_8U);
                            cv.morphologyEx(cornerThresh, cornerThresh, cv.MORPH_OPEN, kernel);

                            let cContours = new cv.MatVector();
                            let cHierarchy = new cv.Mat();
                            cv.findContours(cornerThresh, cContours, cHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
                            
                            let symRects = [];
                            for(let k=0; k<cContours.size(); k++){
                                let cnt = cContours.get(k);
                                let cr = cv.boundingRect(cnt);
                                if(cr.width > 5 && cr.height > 10 && cr.width < 45 && cr.height < 45) {
                                    symRects.push(cr);
                                }
                            }
                            symRects.sort((a,b)=> a.y - b.y);

                            if(symRects.length >= 2) {
                                let rRect = symRects[0];
                                let sRect = symRects[1];
                                let rMat = cornerThresh.roi(rRect);
                                let sMat = cornerThresh.roi(sRect);
                                
                                let bRank = matchTemplateMat(rMat, templates.ranks);
                                let bSuit = matchTemplateMat(sMat, templates.suits);

                                if(bRank && bSuit) {
                                    let cStr = bRank + bSuit;
                                    currentScanned.push(cStr);
                                    
                                    // Draw UI feedback
                                    cv.drawContours(src, contours, i, new cv.Scalar(52, 211, 153, 255), 3);
                                    cv.putText(src, cStr, new cv.Point(ordered[0].x, ordered[0].y - 10), cv.FONT_HERSHEY_SIMPLEX, 1, new cv.Scalar(52,211,153,255), 2);
                                }
                                rMat.delete(); sMat.delete();
                            }

                            cornerMat.delete(); cornerThresh.delete(); kernel.delete();
                            cContours.delete(); cHierarchy.delete();
                            warped.delete(); M.delete(); srcTri.delete(); dstTri.delete();
                        }
                        approx.delete();
                    }
                }
                
                cv.imshow(canvas, src);
                lastScannedCards = [...new Set(currentScanned)];
                detectedCount.innerText = lastScannedCards.length;

                src.delete(); gray.delete(); blur.delete(); edges.delete();
                contours.delete(); hierarchy.delete();
            } catch (err) {
                // Ignore transient OpenCV errors during frame parsing
            }
        }
        requestAnimationFrame(processFrame);
    }

    function initPickers() {
        RANKS.forEach(rank => {
            const btn = document.createElement('button');
            btn.className = 'py-2 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold text-center transition-colors';
            const displayRank = rank === 'T' ? '10' : rank;
            btn.innerText = displayRank;
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
            const type = slot.dataset.type;
            const index = parseInt(slot.dataset.index);
            const card = state[type][index];
            
            slot.classList.remove('active', 'filled');
            if (state.activeSlot && state.activeSlot.type === type && state.activeSlot.index === index) slot.classList.add('active');

            if (card) {
                slot.classList.add('filled');
                const pRank = card[0] === 'T' ? '10' : card[0];
                const pSuit = card[1];
                const suitObj = SUITS.find(s => s.id === pSuit);
                const colorClass = ['h','d'].includes(pSuit) ? 'text-red-500' : 'text-slate-800';
                slot.innerHTML = `<div class="flex flex-col items-center leading-none ${colorClass}"><span class="text-xl">${pRank}</span><span class="text-xs mt-1">${suitObj.icon}</span></div>`;
            } else {
                slot.innerHTML = type === 'hole' ? '?' : (index < 3 ? `F${index+1}` : (index === 3 ? 'T' : 'R'));
                slot.classList.add('text-slate-500');
            }
        });
        calculateOddsUI();
    }

    function openPicker(type, index) {
        state.activeSlot = { type, index };
        state.pickingRank = null;
        updateUI();
        Array.from(suitPickerCont.children).forEach(btn => btn.classList.add('opacity-30', 'pointer-events-none'));
        Array.from(rankPickerCont.children).forEach(btn => {
            btn.classList.remove('bg-blue-600', 'text-white');
            btn.classList.add('bg-slate-700');
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
            if (RANKS[idx] === rank) {
                btn.classList.remove('bg-slate-700');
                btn.classList.add('bg-blue-600', 'text-white');
            } else {
                btn.classList.remove('bg-blue-600', 'text-white');
                btn.classList.add('bg-slate-700');
            }
        });
        Array.from(suitPickerCont.children).forEach(btn => btn.classList.remove('opacity-30', 'pointer-events-none'));
    }

    function selectSuit(suit) {
        if (!state.pickingRank || !state.activeSlot) return;
        state[state.activeSlot.type][state.activeSlot.index] = state.pickingRank + suit;
        if (state.activeSlot.type === 'hole') {
            if (state.activeSlot.index === 0) openPicker('hole', 1);
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
        state.hole = [null, null];
        state.board = [null, null, null, null, null];
        state.activeSlot = { type: 'hole', index: 0 };
        updateUI();
    });

    opponentsInput.addEventListener('change', (e) => {
        state.numOpponents = parseInt(e.target.value) || 1;
        calculateOddsUI();
    });

    scanBtn.addEventListener('click', () => {
        if(lastScannedCards.length === 0) {
            scanBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-2"></i> Acércate más...';
            setTimeout(() => {
                scanBtn.innerHTML = `<i class="fa-solid fa-expand mr-2"></i> Auto Detectar (<span id="detected-count">${lastScannedCards.length}</span>)`;
            }, 1500);
            return;
        }

        const originalHtml = scanBtn.innerHTML;
        scanBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Escaneando...';
        
        setTimeout(() => {
            let existingCards = [...state.hole, ...state.board].filter(c => c);
            
            lastScannedCards.forEach(c => {
                if(existingCards.includes(c)) return; 
                
                if (!state.hole[0]) state.hole[0] = c;
                else if (!state.hole[1]) state.hole[1] = c;
                else if (!state.board[0]) state.board[0] = c;
                else if (!state.board[1]) state.board[1] = c;
                else if (!state.board[2]) state.board[2] = c;
                else if (!state.board[3]) state.board[3] = c;
                else if (!state.board[4]) state.board[4] = c;
            })
            
            scanBtn.innerHTML = `<i class="fa-solid fa-expand mr-2"></i> Auto Detectar (<span id="detected-count">${lastScannedCards.length}</span>)`;
            updateUI();
        }, 500);
    });

    function calculateOddsUI() {
        const myCards = state.hole.filter(c => c);
        const boardCards = state.board.filter(c => c);
        
        if (myCards.length < 2) {
            winProbText.innerHTML = '--%';
            winProbText.classList.remove('win-gradient');
            adviceText.innerText = 'ESPERANDO...';
            adviceText.className = 'text-lg font-extrabold text-slate-500';
            handDescText.innerText = 'Introduce tus 2 cartas';
            return;
        }

        if (boardCards.length >= 3 && window.Hand) {
            const handObj = Hand.solve([...myCards, ...boardCards]);
            handDescText.innerText = `Jugada: ${handObj.name}`;
        } else if (myCards.length === 2 && window.Hand) {
             const handObj = Hand.solve([...myCards]);
             handDescText.innerText = `Mano: ${handObj.name}`;
        }

        winProbText.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg text-slate-400"></i>';
        
        setTimeout(() => {
            if (!window.Hand) return;
            const prob = calculateOdds(myCards, boardCards, state.numOpponents, 2500);
            const probPct = (prob * 100).toFixed(1);
            winProbText.innerText = `${probPct}%`;
            
            if (prob > 0.5) winProbText.classList.add('win-gradient');
            else winProbText.classList.remove('win-gradient');

            const fairShare = 1 / (state.numOpponents + 1);
            
            if (prob > fairShare * 1.5) {
                adviceText.innerText = '🔥 APOSTAR / SUBIR';
                adviceText.className = 'text-lg font-extrabold text-emerald-400 drop-shadow-[0_0_10px_rgba(52,211,153,0.5)]';
            } else if (prob > fairShare * 0.85) {
                adviceText.innerText = '👀 IGUALAR (CALL)';
                adviceText.className = 'text-lg font-extrabold text-yellow-400 drop-shadow-[0_0_10px_rgba(250,204,21,0.5)]';
            } else {
                adviceText.innerText = '🛑 RETIRARSE (FOLD)';
                adviceText.className = 'text-lg font-extrabold text-red-500 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]';
            }
        }, 50);
    }

    function calculateOdds(myCards, boardCards, numOpponents, iterations) {
        if (!window.Hand) return 0;
        const fullDeck = RANKS.flatMap(r => SUITS.map(s => r + s.id));
        let wins = 0; let ties = 0;
        let knownCards = [...myCards, ...boardCards];
        let remainingDeck = fullDeck.filter(c => !knownCards.includes(c));

        for (let i = 0; i < iterations; i++) {
            let deck = [...remainingDeck];
            for (let j = deck.length - 1; j > 0; j--) {
                const k = Math.floor(Math.random() * (j + 1));
                [deck[j], deck[k]] = [deck[k], deck[j]];
            }
            let simBoard = [...boardCards];
            let deckIndex = 0;
            while (simBoard.length < 5) simBoard.push(deck[deckIndex++]);
            
            let myHand = Hand.solve([...myCards, ...simBoard]);
            let opponentsHands = [];
            
            for (let o = 0; o < numOpponents; o++) {
                opponentsHands.push(Hand.solve([deck[deckIndex++], deck[deckIndex++], ...simBoard]));
            }
            
            let allHands = [myHand, ...opponentsHands];
            let winners = Hand.winners(allHands);
            
            if (winners.length === 1 && winners[0] === myHand) wins++;
            else if (winners.includes(myHand)) ties++;
        }
        return (wins + (ties / winners.length)) / iterations;
    }

    initPickers();
    updateUI();
    startCamera();
});
