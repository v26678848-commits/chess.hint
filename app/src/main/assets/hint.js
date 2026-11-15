// ==UserScript==
// @name         chess hint (v86)
// @version      86.0
// @match        https://www.chess.com/*
// @match        https://lichess.org/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    if (window.__HINT_INJECTED__) return;
    window.__HINT_INJECTED__ = true;

    const IS_LICHESS = location.hostname.includes('lichess.org');

    const CONFIG = {
        ENGINE_MOVETIME: 3000,
        HINT_DELAY_MS: 150,
        STABLE_MS: 180,
        MIN_ELO: 1320,
        MAX_ELO: 3190,
        DEFAULT_ELO: 3190,
        DEFAULT_COLORS: { best: '#5f9c6b', mid: '#6b8fb8', worst: '#b07070' },
        ENGINE_STARTUP_TIMEOUT_MS: 15000,
        CDN_STOCKFISH_URL: 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js',
        MAX_FEN_CACHE: 500
    };

    // Порядок загрузки движка: файл из assets по адресу сайта -> через мост -> CDN
    const ENGINE_SOURCES = ['asset', 'native', 'cdn'];

    const loadSetting = (k, d) => { try { const v = localStorage.getItem(k); return v !== null ? v : d; } catch(e) { return d; } };
    const saveSetting = (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} };

    function getViewportHeight() { return document.documentElement.clientHeight || window.innerHeight; }
    function getViewportWidth() { return document.documentElement.clientWidth || window.innerWidth; }

    function loadPanelPosition() {
        try {
            const s = localStorage.getItem('__hint_pos');
            if (s) {
                const p = JSON.parse(s);
                if (typeof p.x === 'number' && typeof p.y === 'number') {
                    return {
                        x: Math.max(4, Math.min(getViewportWidth() - 44, p.x)),
                        y: Math.max(4, Math.min(getViewportHeight() - 44, p.y))
                    };
                }
            }
        } catch (e) {}
        return { x: getViewportWidth() - 44 - 8, y: 8 };
    }

    const state = {
        fen: null, worker: null, engineReady: false, engineStart: 0,
        lastDepth: 0, myColor: 'w', lastMutationTime: 0,
        engineSource: null,
        currentMultiPv: parseInt(loadSetting('__hint_pv', 3), 10) || 3,
        currentElo: parseInt(loadSetting('__hint_elo', CONFIG.DEFAULT_ELO), 10) || CONFIG.DEFAULT_ELO,
        colors: {
            best: loadSetting('__hint_color_best', CONFIG.DEFAULT_COLORS.best),
            mid: loadSetting('__hint_color_mid', CONFIG.DEFAULT_COLORS.mid),
            worst: loadSetting('__hint_color_worst', CONFIG.DEFAULT_COLORS.worst)
        },
        panelPos: loadPanelPosition(),
    };

    const engine = {
        busy: false, queue: null, activeFen: null, watchdog: null,
        pendingOps: [],   // команды setoption, которые ждут окончания поиска
        depthByFen: new Map(),
        latestPvs: { 1: null, 2: null, 3: null }
    };

    const perf = { pendingHint: null, hintRafPending: false, hintDelayTimer: null, lastRenderedKey: null };
    const candidate = { fen: null, since: 0, timer: null };
    const _grid = Array.from({ length: 8 }, () => Array(8).fill(''));
    let watchedBoard = null, boardObserver = null;
    let eloDebounce = null;
    let pollIntervalId = null;

    let ui = { container: null, toggleBtn: null, panel: null, statusEl: null };

    function injectCustomCSS() {
        if (document.getElementById('__hint_styles')) return;
        if (!document.head) return;
        const style = document.createElement('style');
        style.id = '__hint_styles';
        style.textContent = `
            .__hint_slider { -webkit-appearance: none; width: 100%; height: 3px; background: rgba(255,255,255,0.14); border-radius: 2px; outline: none; margin: 10px 0; transition: opacity 0.2s; }
            .__hint_slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #e9e9e9; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.35); }
            .__hint_slider:disabled { cursor: not-allowed; }
            .__hint_slider:disabled::-webkit-slider-thumb { background: #777; cursor: not-allowed; }
            .__hint_color_input { -webkit-appearance: none; border: none; width: 22px; height: 22px; border-radius: 50%; padding: 0; background: none; cursor: pointer; }
            .__hint_color_input::-webkit-color-swatch-wrapper { padding: 0; }
            .__hint_color_input::-webkit-color-swatch { border: 1px solid rgba(255,255,255,0.18); border-radius: 50%; }
            .__hint_toggle_btn {
                width: 44px; height: 44px; border-radius: 14px;
                background: rgba(30,30,33,0.82);
                color: #ddd;
                backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                border: 1px solid rgba(255,255,255,0.08);
                cursor: grab; display: flex; align-items: center; justify-content: center;
                box-shadow: 0 2px 10px rgba(0,0,0,0.28);
                touch-action: none; user-select: none; -webkit-user-select: none;
                -webkit-tap-highlight-color: transparent;
                transition: transform 0.12s, background 0.2s;
            }
            .__hint_toggle_btn:active { cursor: grabbing; transform: scale(0.95); }
            .__hint_panel_inner { display: flex; flex-direction: column; gap: 16px; }
            .__hint_reset_btn {
                margin-top: 4px; padding: 9px; border-radius: 10px;
                background: rgba(255,255,255,0.06); color: #cfcfcf;
                border: 1px solid rgba(255,255,255,0.08);
                font-size: 12px; cursor: pointer;
                text-align: center; transition: background 0.2s;
            }
            .__hint_reset_btn:active { background: rgba(255,255,255,0.03); }
            .__hint_color_dot {
                width: 8px; height: 8px; border-radius: 50%;
                display: inline-block; margin-right: 8px;
                vertical-align: middle;
            }
            #__hint_status {
                font-size: 11px; padding: 7px 10px; border-radius: 8px;
                background: rgba(255,255,255,0.04); color: #8d8d92;
                word-break: break-word; line-height: 1.3;
            }
        `;
        document.head.appendChild(style);
    }

    function updateEngineStatus(text, kind) {
        if (!ui.statusEl) return;
        ui.statusEl.textContent = text;
        const colors = { loading: '#8d8d92', ok: '#86b38e', error: '#c98a8a' };
        ui.statusEl.style.color = colors[kind] || '#888';
    }

    function getTurnFromFen(fen) { if (!fen) return 'w'; return (fen.split(' ')[1] || 'w'); }
    function cpToWinPct(cp) { const w = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); return Math.round(Math.max(0, Math.min(100, w))); }

    function parseEval(line, turn) {
        const m = line.match(/\bscore (cp|mate) (-?\d+)\b/);
        if (!m) return { display: '', winPct: null, isMate: false };
        const kind = m[1]; let n = parseInt(m[2], 10);
        if (turn === 'b') n = -n;
        if (kind === 'mate') return { display: (n >= 0 ? '+M' : '-M') + Math.abs(n), winPct: n > 0 ? 100 : 0, isMate: true };
        const v = n / 100;
        if (Math.abs(v) < 0.05) return { display: '0.0', winPct: 50, isMate: false };
        const s = Math.abs(v).toFixed(1).replace(/\.0$/, '');
        return { display: v > 0 ? '+' + s : '-' + s, winPct: cpToWinPct(n), isMate: false };
    }

    function getBracketPath(cx, cy, size, arm) {
        const h = size / 2, l = arm;
        const x1 = cx - h, x2 = cx + h, y1 = cy - h, y2 = cy + h;
        return `M ${x1+l} ${y1} L ${x1} ${y1} L ${x1} ${y1+l} M ${x2-l} ${y1} L ${x2} ${y1} L ${x2} ${y1+l} M ${x2} ${y2-l} L ${x2} ${y2} L ${x2-l} ${y2} M ${x1+l} ${y2} L ${x1} ${y2} L ${x1} ${y2-l}`;
    }

    // ===== ДОСКА И ПОЗИЦИЯ =====

    const TYPE_MAP = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
    const SQ_KEY_RE = /^[a-h][1-8]$/;

    function extractPiece(el) {
        const cl = el.classList;
        let type = null;
        for (const t of ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn']) {
            if (cl.contains(t)) { type = TYPE_MAP[t]; break; }
        }
        let color = cl.contains('white') ? 'w' : cl.contains('black') ? 'b' : null;
        if (!type || !color) {
            for (const c of cl) { if (/^[wb][pnbrqk]$/.test(c)) { color = c[0]; type = c[1]; break; } }
        }
        if (!type || !color) {
            const dp = el.getAttribute && el.getAttribute('data-piece');
            if (dp && dp.length === 2) {
                const m = dp.match(/^([wb])([pnbrqk])$/i);
                if (m) return { color: m[1].toLowerCase(), type: m[2].toLowerCase() };
            }
        }
        return (type && color) ? { color, type } : null;
    }

    // Клетка из класса square-XY (chess.com): X — вертикаль 1..8, Y — горизонталь 1..8
    function squareFromClass(el) {
        for (const c of el.classList) {
            const m = c.match(/^square-([1-8])([1-8])$/);
            if (m) return { file: parseInt(m[1], 10) - 1, rank: parseInt(m[2], 10) - 1 };
        }
        return null;
    }

    // Клетка из ключа chessground (lichess): cgKey = "e4"
    function squareFromKey(k) {
        if (typeof k === 'string' && SQ_KEY_RE.test(k)) {
            return { file: k.charCodeAt(0) - 97, rank: parseInt(k[1], 10) - 1 };
        }
        return null;
    }

    // Запасной способ — по координатам на экране (во время анимации может ошибаться)
    function squareFromRect(el, br, cellW, cellH, flipped) {
        const r = el.getBoundingClientRect();
        if (r.width < 4) return null;
        const col = Math.floor((r.left + r.width / 2 - br.left) / cellW);
        const row = Math.floor((r.top + r.height / 2 - br.top) / cellH);
        if (col < 0 || col > 7 || row < 0 || row > 7) return null;
        return { file: flipped ? 7 - col : col, rank: flipped ? row : 7 - row };
    }

    function findBoard() {
        if (watchedBoard && watchedBoard.isConnected) {
            const r = watchedBoard.getBoundingClientRect();
            if (r.width > 100 && r.height > 100) return watchedBoard;
        }
        if (IS_LICHESS) {
            const b = document.querySelector('cg-board');
            if (b && b.getBoundingClientRect().width > 100) return b;
        } else {
            for (const sel of ['wc-chess-board', 'chess-board', '.board']) {
                for (const el of document.querySelectorAll(sel)) {
                    if (el.getBoundingClientRect().width > 100) return el;
                }
            }
        }
        return null;
    }

    function isFlipped(board) {
        if (!board) return false;
        if (IS_LICHESS) {
            const w = board.closest('.cg-wrap') || board;
            return w.classList.contains('orientation-black');
        }
        return board.classList.contains('flipped') || board.getAttribute('data-orientation') === 'black';
    }

    // Чей ход по часам. Возвращает 'w' | 'b' | null.
    function turnFromClocks(flipped) {
        const bottomColor = flipped ? 'b' : 'w';
        const topColor = flipped ? 'w' : 'b';
        if (IS_LICHESS) {
            const run = document.querySelector('.rclock.running');
            if (!run) return null;
            if (run.classList.contains('rclock-bottom')) return bottomColor;
            if (run.classList.contains('rclock-top')) return topColor;
            return null;
        }
        const active = document.querySelector('.clock-player-turn, [class*="clock-player-turn"]');
        if (!active) return null;
        const clockEl = active.closest('[class*="clock"]') || active;
        const cn = typeof clockEl.className === 'string' ? clockEl.className : '';
        if (/\bclock-white\b/.test(cn)) return 'w';
        if (/\bclock-black\b/.test(cn)) return 'b';
        return cn.includes('top') ? topColor : bottomColor;
    }

    function detectMyColor(board) {
        const flipped = isFlipped(board);
        if (!IS_LICHESS) {
            try {
                const g = board.game;
                if (g) {
                    if (typeof g.getPlayingAs === 'function') {
                        const pa = g.getPlayingAs();
                        if (pa === 1) return 'w';
                        if (pa === 2) return 'b';
                    }
                    for (const fn of ['getPlayingColor', 'getMyColor', 'getPlayerColor']) {
                        if (typeof g[fn] === 'function') {
                            const c = g[fn]();
                            if (c === 'w' || c === 'b') return c;
                            if (c === 'white') return 'w';
                            if (c === 'black') return 'b';
                        }
                    }
                }
            } catch (e) {}
            const attr = board.getAttribute && board.getAttribute('data-user-color');
            if (attr === 'w' || attr === 'b') return attr;
        }
        return flipped ? 'b' : 'w';
    }

    // chess.com: движок игры знает права на рокировку, взятие на проходе и чей ход.
    // Берём его FEN только если расстановка совпала с тем, что мы прочитали из DOM.
    function readGameFen(board, placement) {
        try {
            const g = board.game;
            if (!g || typeof g.getFEN !== 'function') return null;
            const f = g.getFEN();
            if (typeof f !== 'string') return null;
            const parts = f.trim().split(/\s+/);
            if (parts.length < 4 || parts[0] !== placement) return null;
            if (!/^[wb]$/.test(parts[1])) return null;
            return parts;
        } catch (e) { return null; }
    }

    // Подсвеченные клетки последнего хода (две штуки, иначе null)
    function getLastMoveSquares(root, br, flipped) {
        const out = [];
        if (IS_LICHESS) {
            const cellW = br.width / 8, cellH = br.height / 8;
            for (const el of root.querySelectorAll('square.last-move')) {
                const s = squareFromRect(el, br, cellW, cellH, flipped);
                if (s) out.push(s);
            }
        } else {
            for (const el of root.querySelectorAll('.highlight')) {
                const s = squareFromClass(el);
                if (s) out.push(s);
            }
        }
        return out;
    }

    // Из двух подсвеченных клеток: на одной стоит фигура (куда сходили), другая пуста.
    function analyzeLastMove(squares) {
        if (squares.length !== 2) return null;
        const occ = squares.filter(s => _grid[s.rank][s.file]);
        if (occ.length !== 1) return null;
        const to = occ[0];
        const from = squares[0] === to ? squares[1] : squares[0];
        const pc = _grid[to.rank][to.file];
        return { mover: pc === pc.toUpperCase() ? 'w' : 'b', pc, from, to };
    }

    // Поле взятия на проходе после хода пешки на две клетки (только если есть кому брать)
    function epSquare(lm) {
        if (!lm || lm.pc.toLowerCase() !== 'p') return '-';
        if (lm.from.file !== lm.to.file || Math.abs(lm.to.rank - lm.from.rank) !== 2) return '-';
        const enemy = lm.mover === 'w' ? 'p' : 'P';
        const f = lm.to.file, r = lm.to.rank;
        const has = (ff) => ff >= 0 && ff <= 7 && _grid[r][ff] === enemy;
        if (!has(f - 1) && !has(f + 1)) return '-';
        const mid = (lm.from.rank + lm.to.rank) / 2;
        return String.fromCharCode(97 + f) + (mid + 1);
    }

    // Позиция выглядит как настоящая: по одному королю, пешки не на крайних горизонталях
    function validatePlacement() {
        let wK = 0, bK = 0, wN = 0, bN = 0, wP = 0, bP = 0;
        let wKpos = null, bKpos = null;
        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const pc = _grid[r][f];
                if (!pc) continue;
                const isWhite = pc === pc.toUpperCase();
                if (isWhite) wN++; else bN++;
                if (pc === 'K') { wK++; wKpos = { r, f }; }
                else if (pc === 'k') { bK++; bKpos = { r, f }; }
                else if (pc === 'P' || pc === 'p') {
                    if (r === 0 || r === 7) return false;
                    if (isWhite) wP++; else bP++;
                }
            }
        }
        if (wK !== 1 || bK !== 1) return false;
        if (wN > 16 || bN > 16 || wP > 8 || bP > 8) return false;
        if (Math.abs(wKpos.r - bKpos.r) <= 1 && Math.abs(wKpos.f - bKpos.f) <= 1) return false;
        return true;
    }

    function getFenFromDom(board) {
        const root = board.shadowRoot ? board.shadowRoot : board;
        const els = root.querySelectorAll(IS_LICHESS ? 'piece' : '.piece, [data-piece]');
        if (els.length < 2) return null;
        const br = board.getBoundingClientRect();
        if (br.width < 50) return null;
        const flipped = isFlipped(board);
        for (let r = 0; r < 8; r++) _grid[r].fill('');
        const cellW = br.width / 8, cellH = br.height / 8;

        for (const p of els) {
            const cl = p.classList;
            // Призраки и исчезающие фигуры (анимации, перетаскивание) — не часть позиции
            if (cl.contains('ghost') || cl.contains('fading')) continue;
            const info = extractPiece(p);
            if (!info) continue;

            let sq = IS_LICHESS ? squareFromKey(p.cgKey) : squareFromClass(p);
            if (!sq) {
                if (cl.contains('dragging')) return null;   // фигура в воздухе — ждём
                sq = squareFromRect(p, br, cellW, cellH, flipped);
            }
            if (!sq) continue;
            if (_grid[sq.rank][sq.file]) return null;       // две фигуры на клетке — идёт анимация
            _grid[sq.rank][sq.file] = info.color === 'w' ? info.type.toUpperCase() : info.type;
        }

        if (!validatePlacement()) return null;

        let boardStr = '';
        for (let r = 7; r >= 0; r--) {
            let empty = 0;
            for (let f = 0; f < 8; f++) {
                const pc = _grid[r][f];
                if (pc) { if (empty) { boardStr += empty; empty = 0; } boardStr += pc; } else empty++;
            }
            if (empty) boardStr += empty;
            if (r > 0) boardStr += '/';
        }

        const myColor = detectMyColor(board);

        // Права на рокировку по расстановке (если король/ладья ходили и вернулись — не узнать)
        let castling = '';
        if (_grid[0][4] === 'K') { if (_grid[0][7] === 'R') castling += 'K'; if (_grid[0][0] === 'R') castling += 'Q'; }
        if (_grid[7][4] === 'k') { if (_grid[7][7] === 'r') castling += 'k'; if (_grid[7][0] === 'r') castling += 'q'; }
        if (!castling) castling = '-';
        let ep = '-';
        let turn = null;

        const gameFen = IS_LICHESS ? null : readGameFen(board, boardStr);
        if (gameFen) {
            turn = gameFen[1];
            castling = gameFen[2];
            ep = gameFen[3];
        } else {
            const lm = analyzeLastMove(getLastMoveSquares(root, br, flipped));
            if (lm) {
                turn = lm.mover === 'w' ? 'b' : 'w';
                ep = epSquare(lm);
            } else {
                turn = turnFromClocks(flipped);
            }
            if (!turn) turn = myColor;   // не удалось определить — считаем, что ходим мы
        }

        return { fen: boardStr + ' ' + turn + ' ' + castling + ' ' + ep + ' 0 1', turn, myColor };
    }

    // ===== ЗАГРУЗКА ДВИЖКА =====

    // В воркере из blob: запросы .wasm перенаправляем на нужный адрес
    function wasmFetchPatch(base) {
        return '(function(){try{var _f=self.fetch.bind(self);self.fetch=function(u,o){try{var s=(typeof u==="string")?u:(u&&u.url)||"";if(/\\.wasm([?#]|$)/.test(s)){var n=s.split(/[?#]/)[0].split("/").pop();return _f(' +
            JSON.stringify(base) + '+n,o);}}catch(e){}return _f(u,o);};}catch(e){}})();\n';
    }

    function createWorker(source) {
        const assetBase = location.origin + '/__hint/';

        if (source === 'asset') {
            // Тот же сайт, поэтому .wasm рядом (engine.wasm) подхватывается сам
            return new Worker(assetBase + 'engine.js');
        }

        if (source === 'native') {
            if (!window.NativeHint || typeof window.NativeHint.getStockfishJs !== 'function') {
                throw new Error('мост NativeHint недоступен');
            }
            let nativeErr = '';
            try { nativeErr = window.NativeHint.getStockfishError() || ''; } catch (e) {}
            const js = window.NativeHint.getStockfishJs();
            if (typeof js !== 'string' || js.length < 10000) {
                throw new Error('engine.js слишком короткий: ' + (js ? js.length : 0) + (nativeErr ? ' (' + nativeErr + ')' : ''));
            }
            const blob = new Blob([wasmFetchPatch(assetBase) + js], { type: 'application/javascript' });
            return new Worker(URL.createObjectURL(blob) + '#' + assetBase + 'engine.wasm');
        }

        if (source === 'cdn') {
            // Воркер напрямую с чужого домена запрещён, поэтому оборачиваем в blob + importScripts
            const url = CONFIG.CDN_STOCKFISH_URL;
            const base = url.replace(/[^/]+$/, '');
            const code = wasmFetchPatch(base) + 'importScripts(' + JSON.stringify(url) + ');';
            const blob = new Blob([code], { type: 'application/javascript' });
            return new Worker(URL.createObjectURL(blob) + '#' + url.replace(/\.js$/, '.wasm'));
        }

        throw new Error('неизвестный источник: ' + source);
    }

    function isEloMax() { return state.currentElo >= CONFIG.MAX_ELO; }

    function sendStrengthOptions(w) {
        if (isEloMax()) {
            w.postMessage('setoption name UCI_LimitStrength value false');
        } else {
            w.postMessage('setoption name UCI_LimitStrength value true');
            w.postMessage('setoption name UCI_Elo value ' + state.currentElo);
        }
    }

    // setoption нельзя слать во время поиска: сначала stop, и только после bestmove — опции.
    function whenIdle(fn) {
        if (!state.worker || !state.engineReady) return;
        if (engine.busy) {
            engine.pendingOps.push(fn);
            try { state.worker.postMessage('stop'); } catch (e) {}
        } else {
            fn();
        }
    }

    function updateMultiPvUiState() {
        const isMax = isEloMax();
        const sliderPv = document.getElementById('__hint_slider_pv');
        const labelPv = document.getElementById('__hint_label_pv');
        const warning = document.getElementById('__hint_elo_warning');
        if (sliderPv) { sliderPv.disabled = !isMax; sliderPv.style.opacity = isMax ? '1' : '0.3'; }
        if (labelPv) { labelPv.style.opacity = isMax ? '1' : '0.3'; }
        if (warning) { warning.style.display = isMax ? 'none' : 'block'; }
    }

    function applyEloSetting() {
        if (!state.worker || !state.engineReady) { updateMultiPvUiState(); return; }
        whenIdle(() => sendStrengthOptions(state.worker));
        if (!isEloMax()) {
            clearHint();
            engine.queue = null;
        } else if (state.fen && getTurnFromFen(state.fen) === state.myColor) {
            if (engine.busy) engine.queue = state.fen;
            else analyze(state.fen);
        }
        updateMultiPvUiState();
    }

    function resetEngineState(worker, source) {
        if (engine.watchdog) { clearTimeout(engine.watchdog); engine.watchdog = null; }
        engine.busy = false;
        engine.queue = null;
        engine.activeFen = null;
        engine.pendingOps = [];
        engine.depthByFen.clear();
        engine.latestPvs = { 1: null, 2: null, 3: null };
        state.worker = worker;
        state.engineSource = source;
        state.engineReady = false;
    }

    function startEngine(idx, errors) {
        if (idx >= ENGINE_SOURCES.length) {
            console.error('[hint] движок не загружен', errors);
            updateEngineStatus('Движок не загружен: ' + errors.join('; '), 'error');
            return;
        }
        const source = ENGINE_SOURCES[idx];

        let worker;
        try {
            worker = createWorker(source);
        } catch (e) {
            errors.push(source + ': ' + (e && e.message ? e.message : e));
            startEngine(idx + 1, errors);
            return;
        }

        resetEngineState(worker, source);
        console.log('[hint] пробую движок:', source);
        updateEngineStatus('Движок стартует (' + source + ')…', 'loading');

        let finished = false;

        const startupTimer = setTimeout(() => {
            if (state.worker === worker && !state.engineReady) {
                console.error('[hint] engine startup timeout', source);
                updateEngineStatus(
                    'Движок не ответил за ' + (CONFIG.ENGINE_STARTUP_TIMEOUT_MS / 1000) +
                    'с (' + source + '). Проверь wasm/логи (chrome://inspect).',
                    'error'
                );
            }
        }, CONFIG.ENGINE_STARTUP_TIMEOUT_MS);

        // Ошибка до готовности -> пробуем следующий источник
        const fail = (msg) => {
            if (finished || state.worker !== worker || state.engineReady) return;
            finished = true;
            clearTimeout(startupTimer);
            try { worker.terminate(); } catch (e) {}
            errors.push(source + ': ' + msg);
            startEngine(idx + 1, errors);
        };

        worker.onmessage = (e) => {
            if (state.worker !== worker) return;
            const line = typeof e.data === 'string' ? e.data : '';
            if (line === 'uciok') {
                worker.postMessage('setoption name MultiPV value ' + state.currentMultiPv);
                worker.postMessage('setoption name Hash value 32');
                sendStrengthOptions(worker);
                worker.postMessage('isready');
            } else if (line === 'readyok') {
                finished = true;
                clearTimeout(startupTimer);
                state.engineReady = true;
                updateEngineStatus('Движок готов (' + source + ')', 'ok');
                if (state.fen && isEloMax()) {
                    const turn = getTurnFromFen(state.fen);
                    if (turn === state.myColor) analyze(state.fen);
                }
            } else if (line.startsWith('info ')) {
                if (engine.activeFen !== state.fen) return;
                if (!isEloMax()) return;
                if (!/\bpv\b/.test(line)) return;
                // Нижняя/верхняя граница оценки — не настоящая линия, из-за неё стрелки мигают
                if (/\b(lowerbound|upperbound)\b/.test(line)) return;
                const dm = line.match(/\bdepth (\d+)\b/);
                if (!dm) return;
                const depth = parseInt(dm[1], 10);
                const curDepth = engine.depthByFen.get(engine.activeFen) || 0;
                if (depth < curDepth) return;
                if (depth > curDepth) engine.depthByFen.set(engine.activeFen, depth);
                const mpvM = line.match(/\bmultipv (\d+)\b/);
                const mpvIdx = mpvM ? parseInt(mpvM[1], 10) : 1;
                if (mpvIdx < 1 || mpvIdx > 3) return;
                const pvm = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
                if (!pvm) return;
                engine.latestPvs[mpvIdx] = { mv: pvm[1], eval: parseEval(line, getTurnFromFen(state.fen)) };
                if (engine.latestPvs[1]) {
                    state.lastDepth = depth;
                    drawMultiHint();
                }
            } else if (line.startsWith('bestmove')) {
                if (engine.watchdog) { clearTimeout(engine.watchdog); engine.watchdog = null; }
                engine.busy = false; engine.activeFen = null;
                // Поиск закончился — теперь можно менять опции
                const ops = engine.pendingOps;
                engine.pendingOps = [];
                for (const fn of ops) {
                    try { fn(); } catch (err) { console.error('[hint] op failed', err); }
                }
                if (engine.queue) { const n = engine.queue; engine.queue = null; analyze(n); }
            }
        };

        worker.onerror = (e) => {
            const msg = e && e.message ? e.message : 'не удалось загрузить скрипт';
            console.error('[hint] worker error', source, msg, e && e.filename, e && e.lineno);
            if (state.worker === worker && state.engineReady) {
                updateEngineStatus('Ошибка воркера: ' + msg, 'error');
                return;
            }
            fail(msg);
        };

        worker.onmessageerror = (e) => {
            console.error('[hint] messageerror', e);
        };

        worker.postMessage('uci');
    }

    function initEngine() {
        state.engineStart = performance.now();
        updateEngineStatus('Загрузка движка…', 'loading');
        startEngine(0, []);
    }

    function analyze(fen) {
        if (!state.worker || !state.engineReady || !fen) return;
        if (!isEloMax()) return;
        if (engine.busy) {
            if (engine.activeFen !== fen) {
                engine.queue = fen;
                try { state.worker.postMessage('stop'); } catch(e) {}
            }
            return;
        }
        if (engine.depthByFen.size > CONFIG.MAX_FEN_CACHE) engine.depthByFen.clear();
        engine.busy = true; engine.activeFen = fen;
        engine.depthByFen.set(fen, 0);
        engine.latestPvs = { 1: null, 2: null, 3: null };
        state.lastDepth = 0;
        state.worker.postMessage('position fen ' + fen);
        state.worker.postMessage('go movetime ' + CONFIG.ENGINE_MOVETIME);

        if (engine.watchdog) clearTimeout(engine.watchdog);
        engine.watchdog = setTimeout(() => {
            if (!engine.busy || engine.activeFen !== fen) return;
            try { state.worker.postMessage('stop'); } catch(e) {}
        }, CONFIG.ENGINE_MOVETIME + 1000);
    }

    // Новая позиция принимается, только если она продержалась STABLE_MS без изменений
    // (иначе во время анимации хода движок получил бы полуготовую позицию).
    function processFen(info) {
        if (!info || !info.fen) return;
        if (info.fen === state.fen) { candidate.fen = null; return; }
        const now = performance.now();
        if (candidate.fen !== info.fen) {
            candidate.fen = info.fen;
            candidate.since = now;
            if (candidate.timer) clearTimeout(candidate.timer);
            candidate.timer = setTimeout(() => { candidate.timer = null; onMutation(true); }, CONFIG.STABLE_MS + 30);
            return;
        }
        if (now - candidate.since < CONFIG.STABLE_MS) return;
        candidate.fen = null;
        acceptFen(info);
    }

    function acceptFen(info) {
        state.fen = info.fen;
        state.myColor = info.myColor;
        clearHint();
        if (!isEloMax()) {
            if (engine.busy && state.worker) try { state.worker.postMessage('stop'); } catch(e){}
            engine.queue = null;
            return;
        }
        if (info.turn && info.turn !== info.myColor) {
            if (engine.busy && state.worker) try { state.worker.postMessage('stop'); } catch(e){}
            engine.queue = null;
            return;
        }
        analyze(info.fen);
    }

    function onMutation(force) {
        if (document.hidden) return;
        const now = performance.now();
        if (!force && now - state.lastMutationTime < 150) return;
        state.lastMutationTime = now;
        const board = findBoard();
        if (!board) return;
        watchedBoard = board;
        const info = getFenFromDom(board);
        if (info) processFen(info);
    }

    function clearHint() {
        if (perf.hintDelayTimer) { clearTimeout(perf.hintDelayTimer); perf.hintDelayTimer = null; }
        perf.pendingHint = null;
        perf.lastRenderedKey = null;
        if (watchedBoard) {
            const root = watchedBoard.shadowRoot || watchedBoard;
            const host = root.querySelector('.__hint_host');
            if (host && host.shadowRoot) host.shadowRoot.innerHTML = '';
        }
    }

    function drawMultiHint() {
        if (!isEloMax()) return;
        perf.pendingHint = { fen: state.fen };
        if (perf.hintDelayTimer) clearTimeout(perf.hintDelayTimer);
        perf.hintDelayTimer = setTimeout(() => {
            perf.hintDelayTimer = null;
            if (!perf.hintRafPending) {
                perf.hintRafPending = true;
                requestAnimationFrame(renderMultiHint);
            }
        }, CONFIG.HINT_DELAY_MS);
    }

    function renderMultiHint() {
        perf.hintRafPending = false;
        if (!perf.pendingHint || state.fen !== perf.pendingHint.fen) return;
        if (!isEloMax()) { clearHint(); return; }

        const board = findBoard();
        if (!board) return;

        const pvs = engine.latestPvs;
        const evalText = pvs[1] && pvs[1].eval ? pvs[1].eval.display : '';
        const boardRoot = board.shadowRoot || board;
        const br = board.getBoundingClientRect();
        const flipped = isFlipped(board);

        let host = boardRoot.querySelector('.__hint_host');
        const alive = !!(host && host.shadowRoot && host.shadowRoot.firstChild);
        // В ключе — ходы, размер доски и ориентация: при их смене стрелки перерисуются
        const cacheKey = [
            state.fen, state.lastDepth, state.currentMultiPv, evalText,
            pvs[1] ? pvs[1].mv : '', pvs[2] ? pvs[2].mv : '', pvs[3] ? pvs[3].mv : '',
            Math.round(br.width), Math.round(br.height), flipped ? 1 : 0
        ].join('_');
        if (alive && perf.lastRenderedKey === cacheKey) return;
        perf.lastRenderedKey = cacheKey;

        if (!host) {
            host = document.createElement('div');
            host.className = '__hint_host';
            host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9999;';
            if (getComputedStyle(board).position === 'static') board.style.position = 'relative';
            boardRoot.appendChild(host);
        }
        let shadow = host.shadowRoot;
        if (!shadow) shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '';

        const W = br.width, H = br.height;
        const cell = Math.min(W, H) / 8;
        const offX = (W - cell * 8) / 2, offY = (H - cell * 8) / 2;

        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.style.cssText = 'position:absolute;inset:0;overflow:visible;';
        svg.setAttribute('overflow', 'visible');

        const sqXY = (sq) => {
            const f = sq.charCodeAt(0) - 97, r = parseInt(sq[1], 10) - 1;
            return { x: (flipped ? 7 - f : f) * cell + cell / 2 + offX, y: (flipped ? r : 7 - r) * cell + cell / 2 + offY };
        };

        const ARROW_STYLE = {
            best:  { w: 0.075, op: 0.9,  br: 0.95 },
            mid:   { w: 0.055, op: 0.65, br: 0.7 },
            worst: { w: 0.045, op: 0.5,  br: 0.5 }
        };

        const drawOne = (uci, evalObj, rank) => {
            if (!uci) return;
            const color = state.colors[rank];
            const st = ARROW_STYLE[rank];
            const a = sqXY(uci.slice(0, 2));
            const b = sqXY(uci.slice(2, 4));

            // Путь: прямая, а для коня — мягкая «Г» (сначала по длинной стороне)
            const dF = Math.abs(uci.charCodeAt(2) - uci.charCodeAt(0));
            const dR = Math.abs(parseInt(uci[3], 10) - parseInt(uci[1], 10));
            const isKnight = (dF === 1 && dR === 2) || (dF === 2 && dR === 1);
            const pts = [a];
            if (isKnight) pts.push(dR === 2 ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
            const prev = pts[pts.length - 1];
            const ang = Math.atan2(b.y - prev.y, b.x - prev.x);
            const ux = Math.cos(ang), uy = Math.sin(ang);

            const lineW = cell * st.w;
            const headLen = cell * 0.26, headHalf = cell * 0.14;
            const tip = { x: b.x - ux * cell * 0.1, y: b.y - uy * cell * 0.1 };
            const baseC = { x: tip.x - ux * headLen, y: tip.y - uy * headLen };
            const lineEnd = { x: baseC.x + ux * headLen * 0.3, y: baseC.y + uy * headLen * 0.3 };

            let d = 'M ' + a.x + ' ' + a.y;
            for (let i = 1; i < pts.length; i++) d += ' L ' + pts[i].x + ' ' + pts[i].y;
            d += ' L ' + lineEnd.x + ' ' + lineEnd.y;

            const headPts =
                tip.x + ',' + tip.y + ' ' +
                (baseC.x - uy * headHalf) + ',' + (baseC.y + ux * headHalf) + ' ' +
                (baseC.x + uy * headHalf) + ',' + (baseC.y - ux * headHalf);

            // Группа с общей прозрачностью: наложения не дают тёмных стыков
            const g = document.createElementNS(ns, 'g');
            g.setAttribute('opacity', st.op);

            const halo = document.createElementNS(ns, 'path');
            halo.setAttribute('d', d);
            halo.setAttribute('fill', 'none');
            halo.setAttribute('stroke', 'rgba(0,0,0,0.28)');
            halo.setAttribute('stroke-width', lineW + cell * 0.035);
            halo.setAttribute('stroke-linecap', 'round');
            halo.setAttribute('stroke-linejoin', 'round');
            g.appendChild(halo);

            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', lineW);
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            g.appendChild(path);

            const head = document.createElementNS(ns, 'polygon');
            head.setAttribute('points', headPts);
            head.setAttribute('fill', color);
            head.setAttribute('stroke', 'rgba(0,0,0,0.28)');
            head.setAttribute('stroke-width', cell * 0.02);
            head.setAttribute('stroke-linejoin', 'round');
            g.appendChild(head);
            svg.appendChild(g);

            // Тонкие угловые скобки вокруг клетки назначения
            const br = document.createElementNS(ns, 'path');
            br.setAttribute('d', getBracketPath(b.x, b.y, cell * 0.82, cell * 0.2));
            br.setAttribute('fill', 'none');
            br.setAttribute('stroke', color);
            br.setAttribute('stroke-opacity', st.br);
            br.setAttribute('stroke-width', cell * 0.04);
            br.setAttribute('stroke-linecap', 'round');
            br.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(br);

            // Плашка оценки: «+1.2 · 64%» у лучшего хода, у остальных только оценка
            if (evalObj && evalObj.display) {
                let ev = evalObj.display;
                let pct = evalObj.winPct;
                if (state.myColor === 'b') {
                    if (ev.startsWith('+')) ev = '-' + ev.slice(1);
                    else if (ev.startsWith('-')) ev = '+' + ev.slice(1);
                    if (pct !== null && pct !== undefined) pct = 100 - pct;
                }
                const text = (rank === 'best' && !evalObj.isMate && pct !== null && pct !== undefined)
                    ? ev + ' · ' + pct + '%' : ev;

                const fs = cell * 0.19;
                const h = cell * 0.31;
                const padX = cell * 0.11;
                const dotR = cell * 0.035;
                const gap = cell * 0.07;
                const textW = text.length * fs * 0.56;
                const w = padX * 2 + dotR * 2 + gap + textW;
                let px = b.x + cell * 0.12;
                let py = b.y - cell * 0.5 - h / 2;
                px = Math.max(2, Math.min(W - w - 2, px));
                py = Math.max(2, Math.min(H - h - 2, py));

                const pill = document.createElementNS(ns, 'rect');
                pill.setAttribute('x', px); pill.setAttribute('y', py);
                pill.setAttribute('width', w); pill.setAttribute('height', h);
                pill.setAttribute('rx', h / 2);
                pill.setAttribute('fill', 'rgba(26,26,29,0.82)');
                svg.appendChild(pill);

                const dot = document.createElementNS(ns, 'circle');
                dot.setAttribute('cx', px + padX + dotR);
                dot.setAttribute('cy', py + h / 2);
                dot.setAttribute('r', dotR);
                dot.setAttribute('fill', color);
                svg.appendChild(dot);

                const t = document.createElementNS(ns, 'text');
                t.setAttribute('x', px + padX + dotR * 2 + gap);
                t.setAttribute('y', py + h / 2);
                t.setAttribute('dominant-baseline', 'central');
                t.setAttribute('fill', '#ececec');
                t.setAttribute('font-family', 'system-ui, sans-serif');
                t.setAttribute('font-weight', '500');
                t.setAttribute('font-size', fs);
                t.textContent = text;
                svg.appendChild(t);
            }
        };

        // Худший рисуем первым, лучший окажется сверху
        if (state.currentMultiPv >= 3 && pvs[3]) drawOne(pvs[3].mv, pvs[3].eval, 'worst');
        if (state.currentMultiPv >= 2 && pvs[2]) drawOne(pvs[2].mv, pvs[2].eval, 'mid');
        if (state.currentMultiPv >= 1 && pvs[1]) drawOne(pvs[1].mv, pvs[1].eval, 'best');

        shadow.appendChild(svg);
    }

    // ===== ПАНЕЛЬ УПРАВЛЕНИЯ =====

    function applyButtonPosition() {
        if (!ui.container || !state.panelPos) return;
        ui.container.style.left = state.panelPos.x + 'px';
        ui.container.style.top = state.panelPos.y + 'px';
    }

    function openPanel() {
        if (!ui.panel) return;
        const vw = getViewportWidth();
        const vh = getViewportHeight();
        const btnX = state.panelPos.x;
        const btnY = state.panelPos.y;
        const btnW = 44, btnH = 44;
        const gap = 8, margin = 8;
        const panelW = Math.min(230, vw - 2 * margin);

        const spaceBelow = vh - (btnY + btnH + gap) - margin;
        const spaceAbove = btnY - gap - margin;

        if (spaceBelow >= spaceAbove && spaceBelow > 100) {
            ui.panel.style.top = (btnY + btnH + gap) + 'px';
            ui.panel.style.bottom = 'auto';
            ui.panel.style.maxHeight = spaceBelow + 'px';
        } else if (spaceAbove > 100) {
            ui.panel.style.bottom = (vh - btnY + gap) + 'px';
            ui.panel.style.top = 'auto';
            ui.panel.style.maxHeight = spaceAbove + 'px';
        } else {
            ui.panel.style.top = (btnY + btnH + gap) + 'px';
            ui.panel.style.bottom = 'auto';
            ui.panel.style.maxHeight = Math.max(100, spaceBelow) + 'px';
        }

        const spaceRight = vw - (btnX + btnW + gap) - margin;
        const spaceLeft = btnX - gap - margin;

        if (spaceRight >= panelW) {
            ui.panel.style.left = (btnX + btnW + gap) + 'px';
            ui.panel.style.right = 'auto';
        } else if (spaceLeft >= panelW) {
            ui.panel.style.right = (vw - btnX + gap) + 'px';
            ui.panel.style.left = 'auto';
        } else {
            if (btnX < vw / 2) {
                ui.panel.style.left = margin + 'px';
                ui.panel.style.right = 'auto';
            } else {
                ui.panel.style.right = margin + 'px';
                ui.panel.style.left = 'auto';
            }
        }

        ui.panel.style.width = panelW + 'px';
        ui.panel.style.display = 'flex';
    }

    function closePanel() {
        if (ui.panel) ui.panel.style.display = 'none';
    }

    function createControlPanel() {
        if (document.getElementById('__hint_controls')) return;
        injectCustomCSS();

        const container = document.createElement('div');
        container.id = '__hint_controls';
        container.style.cssText = 'position:fixed;z-index:100001;width:44px;height:44px;';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = '__hint_toggle_btn';
        toggleBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="1.6" stroke-linecap="round">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>
            </svg>
        `;
        container.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.id = '__hint_controls_panel';
        panel.style.cssText = `
            display:none; position:fixed; z-index:100000; flex-direction:column;
            background: rgba(28,28,31,0.9);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            color: #e6e6e6; padding: 16px; border-radius: 16px;
            font-size: 13px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.35);
            border: 1px solid rgba(255,255,255,0.07);
            overflow-y: auto;
            transition: opacity 0.15s ease;
        `;

        const inner = document.createElement('div');
        inner.className = '__hint_panel_inner';

        const statusDiv = document.createElement('div');
        statusDiv.id = '__hint_status';
        statusDiv.textContent = 'Движок не инициализирован';
        inner.appendChild(statusDiv);

        const labelElo = document.createElement('div');
        labelElo.style.cssText = 'display:flex;justify-content:space-between;font-weight:500;';
        const updateEloLabel = () => {
            labelElo.innerHTML = `<span>Сила движка</span><b>${state.currentElo >= CONFIG.MAX_ELO ? 'MAX' : state.currentElo}</b>`;
        };
        updateEloLabel();

        const sliderElo = document.createElement('input');
        sliderElo.type = 'range';
        sliderElo.min = CONFIG.MIN_ELO;
        sliderElo.max = CONFIG.MAX_ELO;
        sliderElo.step = 10;
        sliderElo.value = state.currentElo;
        sliderElo.className = '__hint_slider';
        sliderElo.oninput = (e) => {
            const val = parseInt(e.target.value, 10);
            state.currentElo = val;
            saveSetting('__hint_elo', val);
            updateEloLabel();
            updateMultiPvUiState();
            if (eloDebounce) clearTimeout(eloDebounce);
            eloDebounce = setTimeout(applyEloSetting, 250);
        };

        const labelPv = document.createElement('div');
        labelPv.id = '__hint_label_pv';
        labelPv.style.cssText = 'display:flex;justify-content:space-between;font-weight:500;transition:opacity 0.2s;';
        labelPv.innerHTML = `<span>Количество ходов</span><b>${state.currentMultiPv}</b>`;

        const sliderPv = document.createElement('input');
        sliderPv.id = '__hint_slider_pv';
        sliderPv.type = 'range';
        sliderPv.min = 1;
        sliderPv.max = 3;
        sliderPv.step = 1;
        sliderPv.value = state.currentMultiPv;
        sliderPv.className = '__hint_slider';
        sliderPv.oninput = (e) => {
            if (!isEloMax()) return;
            const val = parseInt(e.target.value, 10);
            state.currentMultiPv = val;
            saveSetting('__hint_pv', val);
            labelPv.innerHTML = `<span>Количество ходов</span><b>${val}</b>`;
            clearHint();
            if (state.worker && state.engineReady) {
                whenIdle(() => state.worker.postMessage('setoption name MultiPV value ' + val));
                if (state.fen && getTurnFromFen(state.fen) === state.myColor) {
                    if (engine.busy) engine.queue = state.fen;
                    else analyze(state.fen);
                }
            }
        };

        const warning = document.createElement('div');
        warning.id = '__hint_elo_warning';
        warning.style.cssText = 'display:none;padding:9px 10px;background:rgba(255,255,255,0.04);border-left:2px solid #a8906a;border-radius:6px;font-size:11px;color:#bfae8f;line-height:1.4;margin-top:-4px;';
        warning.textContent = 'При ограничении ELO подсказки отключены. Поставь MAX для анализа.';

        const colorsDiv = document.createElement('div');
        colorsDiv.style.cssText = 'display:flex;flex-direction:column;gap:12px;margin-top:4px;';

        const mkColorInput = (label, initial, onChange) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:500;';
            wrap.innerHTML = `<div><span class="__hint_color_dot" style="background:${initial}"></span><span>${label}</span></div>`;
            const inp = document.createElement('input');
            inp.type = 'color';
            inp.value = initial;
            inp.className = '__hint_color_input';
            inp.oninput = (e) => {
                const color = e.target.value;
                wrap.querySelector('.__hint_color_dot').style.background = color;
                onChange(color);
                clearHint();
                drawMultiHint();
            };
            wrap.appendChild(inp);
            return wrap;
        };

        colorsDiv.appendChild(mkColorInput('Ход 1 (Best)', state.colors.best, v => { state.colors.best = v; saveSetting('__hint_color_best', v); }));
        colorsDiv.appendChild(mkColorInput('Ход 2 (Mid)', state.colors.mid, v => { state.colors.mid = v; saveSetting('__hint_color_mid', v); }));
        colorsDiv.appendChild(mkColorInput('Ход 3 (Worst)', state.colors.worst, v => { state.colors.worst = v; saveSetting('__hint_color_worst', v); }));

        const resetBtn = document.createElement('button');
        resetBtn.className = '__hint_reset_btn';
        resetBtn.textContent = 'Сбросить настройки';
        resetBtn.onclick = () => {
            state.currentElo = CONFIG.MAX_ELO;
            state.currentMultiPv = 3;
            state.colors.best = CONFIG.DEFAULT_COLORS.best;
            state.colors.mid = CONFIG.DEFAULT_COLORS.mid;
            state.colors.worst = CONFIG.DEFAULT_COLORS.worst;

            saveSetting('__hint_elo', state.currentElo);
            saveSetting('__hint_pv', state.currentMultiPv);
            saveSetting('__hint_color_best', state.colors.best);
            saveSetting('__hint_color_mid', state.colors.mid);
            saveSetting('__hint_color_worst', state.colors.worst);

            sliderElo.value = state.currentElo; updateEloLabel();
            sliderPv.value = state.currentMultiPv; labelPv.innerHTML = `<span>Количество ходов</span><b>3</b>`;

            const colorWraps = colorsDiv.children;
            const colVals = [state.colors.best, state.colors.mid, state.colors.worst];
            for (let i = 0; i < 3; i++) {
                const wrap = colorWraps[i];
                wrap.querySelector('input').value = colVals[i];
                wrap.querySelector('.__hint_color_dot').style.background = colVals[i];
            }

            if (state.worker && state.engineReady) {
                whenIdle(() => state.worker.postMessage('setoption name MultiPV value ' + state.currentMultiPv));
            }
            applyEloSetting();
            updateMultiPvUiState();
            clearHint();
            drawMultiHint();
        };

        inner.appendChild(labelElo);
        inner.appendChild(sliderElo);
        inner.appendChild(warning);
        inner.appendChild(labelPv);
        inner.appendChild(sliderPv);
        inner.appendChild(colorsDiv);
        inner.appendChild(resetBtn);

        panel.appendChild(inner);

        document.body.appendChild(container);
        document.body.appendChild(panel);

        ui.container = container;
        ui.toggleBtn = toggleBtn;
        ui.panel = panel;
        ui.statusEl = statusDiv;
        applyButtonPosition();
        updateMultiPvUiState();

        let drag = {
            active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0,
            moved: false, pointerId: null, panelWasOpen: false
        };

        const onPointerDown = (e) => {
            drag.active = true;
            drag.startX = e.clientX;
            drag.startY = e.clientY;
            drag.startLeft = state.panelPos.x;
            drag.startTop = state.panelPos.y;
            drag.moved = false;
            drag.pointerId = e.pointerId;
            drag.panelWasOpen = (panel.style.display === 'flex');
            try { toggleBtn.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        };

        const onPointerMove = (e) => {
            if (!drag.active || e.pointerId !== drag.pointerId) return;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;

            if (!drag.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
                drag.moved = true;
                if (panel.style.display === 'flex') closePanel();
            }
            if (!drag.moved) return;

            let nx = drag.startLeft + dx;
            let ny = drag.startTop + dy;
            nx = Math.max(4, Math.min(getViewportWidth() - 44, nx));
            ny = Math.max(4, Math.min(getViewportHeight() - 44, ny));
            state.panelPos.x = nx;
            state.panelPos.y = ny;
            applyButtonPosition();
        };

        const onPointerUp = (e) => {
            if (!drag.active || e.pointerId !== drag.pointerId) return;
            drag.active = false;
            try { toggleBtn.releasePointerCapture(drag.pointerId); } catch (err) {}

            if (drag.moved) {
                saveSetting('__hint_pos', JSON.stringify(state.panelPos));
                if (drag.panelWasOpen) openPanel();
            } else {
                if (panel.style.display === 'flex') {
                    closePanel();
                } else {
                    openPanel();
                }
            }
        };

        toggleBtn.addEventListener('pointerdown', onPointerDown);
        toggleBtn.addEventListener('pointermove', onPointerMove);
        toggleBtn.addEventListener('pointerup', onPointerUp);
        toggleBtn.addEventListener('pointercancel', onPointerUp);
    }

    window.addEventListener('resize', () => {
        if (!state.panelPos) return;
        state.panelPos.x = Math.max(4, Math.min(getViewportWidth() - 44, state.panelPos.x));
        state.panelPos.y = Math.max(4, Math.min(getViewportHeight() - 44, state.panelPos.y));
        applyButtonPosition();
        if (ui.panel && ui.panel.style.display === 'flex') openPanel();
    });

    function attachObserver(board) {
        if (boardObserver) boardObserver.disconnect();
        // Стрелка-функция: иначе MutationObserver передал бы список мутаций вместо force
        boardObserver = new MutationObserver(() => onMutation(false));
        const target = board.shadowRoot || board;
        try { boardObserver.observe(target, { childList: true, subtree: true }); } catch (e) {}
    }

    // Когда страница скрыта, опрос останавливается — не жжём CPU в фоне
    function startPolling() {
        if (pollIntervalId !== null) return;
        pollIntervalId = setInterval(() => {
            const b = findBoard();
            if (b && b !== watchedBoard) {
                watchedBoard = b;
                attachObserver(b);
            }
            onMutation(false);
        }, 300);
    }
    function stopPolling() {
        if (pollIntervalId !== null) {
            clearInterval(pollIntervalId);
            pollIntervalId = null;
        }
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopPolling();
        else { startPolling(); onMutation(true); }
    });

    function boot() {
        if (!document.body) { setTimeout(boot, 50); return; }

        createControlPanel();
        initEngine();

        const b0 = findBoard();
        if (b0) { watchedBoard = b0; attachObserver(b0); }
        onMutation(false);
        startPolling();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
