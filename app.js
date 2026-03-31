document.addEventListener('DOMContentLoaded', () => {
    const state = {
        hole: [null, null],
        board: [null, null, null, null, null],
        activeSlot: { type: 'hole', index: 0 },
        pickingRank: null,
        numOpponents: 1,
        facingMode: 'environment'
    };

    const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const SUITS = [
        { id: 's', icon: '♠', color: 'text-slate-800 bg-slate-100' },
        { id: 'h', icon: '♥', color: 'text-red-500 bg-red-100' },
        { id: 'd', icon: '♦', color: 'text-red-500 bg-red-100' },
        { id: 'c', icon: '♣', color: 'text-slate-800 bg-slate-100' }
    ];
    
    const videoElement = document.getElementById('camera-feed');
    const scanBtn = document.getElementById('scan-btn');
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

    async function startCamera() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: state.facingMode }
                });
                videoElement.srcObject = stream;
            } catch (err) {
                console.warn("Camera access denied or not available");
            }
        }
    }

    cameraToggleBtn.addEventListener('click', () => {
        state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
        startCamera();
    });

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
            
            if (state.activeSlot && state.activeSlot.type === type && state.activeSlot.index === index) {
                slot.classList.add('active');
            }

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
        
        Array.from(suitPickerCont.children).forEach(btn => {
            btn.classList.add('opacity-30', 'pointer-events-none');
        });
        
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
        const btns = Array.from(rankPickerCont.children);
        btns.forEach((btn, idx) => {
            if (RANKS[idx] === rank) {
                btn.classList.remove('bg-slate-700');
                btn.classList.add('bg-blue-600', 'text-white');
            } else {
                btn.classList.remove('bg-blue-600', 'text-white');
                btn.classList.add('bg-slate-700');
            }
        });

        Array.from(suitPickerCont.children).forEach(btn => {
            btn.classList.remove('opacity-30', 'pointer-events-none');
        });
    }

    function selectSuit(suit) {
        if (!state.pickingRank || !state.activeSlot) return;
        
        const cardStr = state.pickingRank + suit;
        state[state.activeSlot.type][state.activeSlot.index] = cardStr;
        
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

    cardSlots.forEach(slot => {
        slot.addEventListener('click', () => {
            openPicker(slot.dataset.type, parseInt(slot.dataset.index));
        });
    });

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

    const fullDeck = RANKS.flatMap(r => SUITS.map(s => r + s.id));

    scanBtn.addEventListener('click', () => {
        const originalHtml = scanBtn.innerHTML;
        scanBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Procesando IA...';
        setTimeout(() => {
            const allCardsStr = [...state.hole, ...state.board].filter(c => c);
            const remaining = fullDeck.filter(c => !allCardsStr.includes(c));
            
            if (!state.hole[0]) state.hole[0] = remaining.splice(Math.floor(Math.random()*remaining.length), 1)[0];
            if (!state.hole[1]) state.hole[1] = remaining.splice(Math.floor(Math.random()*remaining.length), 1)[0];
            
            scanBtn.innerHTML = originalHtml;
            updateUI();
        }, 800);
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
            handDescText.innerText = `Jugada evaluada: ${handObj.name}`;
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
            
            if (prob > 0.5) {
                winProbText.classList.add('win-gradient');
            } else {
                winProbText.classList.remove('win-gradient');
            }

            const fairShare = 1 / (state.numOpponents + 1);
            
            if (prob > fairShare * 1.5) {
                adviceText.innerText = '🔥 APOSTAR / RE-SUBIR';
                adviceText.className = 'text-lg font-extrabold text-emerald-400 drop-shadow-[0_0_10px_rgba(52,211,153,0.5)]';
            } else if (prob > fairShare * 0.9) {
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
        let wins = 0;
        let ties = 0;
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
            while (simBoard.length < 5) {
                simBoard.push(deck[deckIndex++]);
            }
            
            let mySimCards = [...myCards, ...simBoard];
            let myHand = Hand.solve(mySimCards);
            let opponentsHands = [];
            
            for (let o = 0; o < numOpponents; o++) {
                let oppCard1 = deck[deckIndex++];
                let oppCard2 = deck[deckIndex++];
                opponentsHands.push(Hand.solve([oppCard1, oppCard2, ...simBoard]));
            }
            
            let allHands = [myHand, ...opponentsHands];
            let winners = Hand.winners(allHands);
            
            if (winners.length === 1 && winners[0] === myHand) {
                wins++;
            } else if (winners.includes(myHand)) {
                ties++;
            }
        }
        return (wins + (ties / winners.length)) / iterations;
    }

    initPickers();
    updateUI();
    startCamera();
});
