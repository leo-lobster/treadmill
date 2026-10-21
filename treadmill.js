
const SERVICE_UUID = "0000fba0-0000-1000-8000-00805f9b34fb";
const NOTIFY_CHAR_UUID = "0000fba2-0000-1000-8000-00805f9b34fb";
const WRITE_CHAR_UUID = "0000fba1-0000-1000-8000-00805f9b34fb";

// Packet logging floods the console (one line per BLE notification); opt in with ?debug or localStorage treadmill_debug=1.
const DEBUG = new URLSearchParams(location.search).has('debug') || localStorage.getItem('treadmill_debug') === '1';
const debugLog = DEBUG ? console.log.bind(console) : () => {};
const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");
const IS_MAC = /Mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

const connectBtn = document.getElementById('connectBtn');
const btNotice = document.getElementById('btNotice');
const speedDiv = document.getElementById('speed');
const distanceDiv = document.getElementById('distance');
const caloriesDiv = document.getElementById('calories');
const stepsDiv = document.getElementById('steps');
const durationDiv = document.getElementById('duration');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const speedUpBtn = document.getElementById('speedUpBtn');
const speedDownBtn = document.getElementById('speedDownBtn');
const speedSlider = document.getElementById('speedSlider');
const sliderValue = document.getElementById('sliderValue');
const statusChip = document.getElementById('statusChip');
const loadingOverlay = document.getElementById('loadingOverlay');
const countdownOverlay = document.getElementById('countdownOverlay');
const countdownNumber = document.getElementById('countdownNumber');
const historyTableBody = document.getElementById('historyTableBody');
const importHistoryBtn = document.getElementById('importHistoryBtn');
const exportHistoryBtn = document.getElementById('exportHistoryBtn');
const importHistoryInput = document.getElementById('importHistoryInput');
const snackbar = document.getElementById('snackbar');

let sessionActive = false;
let sessionStartData = null;

const TRASH_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const relativeDayFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function formatSessionDate(value) {
    const d = new Date(value);
    if (isNaN(d)) return '—';
    const startOfDay = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
    let day;
    if (daysAgo === 0 || daysAgo === 1) day = relativeDayFmt.format(-daysAgo, 'day');
    else if (daysAgo > 1 && daysAgo < 7) day = weekdayFmt.format(d);
    else day = dateFmt.format(d);
    return day.charAt(0).toUpperCase() + day.slice(1) + ', ' + timeFmt.format(d);
}

function loadSessions() {
    let sessions = [];
    try {
        sessions = JSON.parse(localStorage.getItem('treadmill_sessions') || '[]');
    } catch {}
    return Array.isArray(sessions) ? sessions : [];
}
function saveSessions(sessions) {
    localStorage.setItem('treadmill_sessions', JSON.stringify(sessions));
}
function deleteSession(idx) {
    const sessions = loadSessions();
    sessions.splice(idx, 1);
    saveSessions(sessions);
    renderSessionTable();
}
// Rows are built with textContent: imported history files are untrusted input.
function renderSessionTable() {
    const sessions = loadSessions();
    historyTableBody.replaceChildren();
    if (sessions.length === 0) {
        const td = historyTableBody.insertRow().insertCell();
        td.colSpan = 6;
        td.className = 'history-empty';
        td.textContent = 'No sessions yet — your walks will appear here.';
        return;
    }
    sessions.forEach((s, i) => {
        let avgSpeedDisplay = '—';
        const avgSpeed = parseFloat(s.avgSpeed);
        if (!isNaN(avgSpeed)) {
            avgSpeedDisplay = avgSpeed.toFixed(2) + ' ' + (s.speedUnit || '');
        }
        const stepsDisplay = (typeof s.steps === 'number') ? s.steps.toLocaleString() : (s.steps || '—');
        const tr = historyTableBody.insertRow();
        const addCell = (text, className) => {
            const td = tr.insertCell();
            td.textContent = text;
            if (className) td.className = className;
            return td;
        };
        addCell(formatSessionDate(s.date));
        addCell(formatDuration(s.duration || 0));
        addCell(stepsDisplay, 'num');
        addCell(s.calories || '—', 'num');
        addCell(avgSpeedDisplay, 'num');
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'history-action-btn';
        deleteBtn.title = 'Delete';
        deleteBtn.setAttribute('aria-label', 'Delete walk');
        deleteBtn.dataset.index = i;
        deleteBtn.innerHTML = TRASH_ICON_SVG;
        addCell('', 'num').appendChild(deleteBtn);
    });
}
historyTableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.history-action-btn');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    const session = loadSessions()[idx];
    if (!session || !confirm(`Delete the walk from ${formatSessionDate(session.date)}?`)) return;
    deleteSession(idx);
    if (window.goals && window.goals.refresh) window.goals.refresh();
});

window.loadSessions = loadSessions;
window.saveSessions = saveSessions;
window.renderSessionTable = renderSessionTable;

let device = null;
let server = null;
let notifyChar = null;
let writeChar = null;
let treadmillData = {};
let connected = false;
let runningState = 3;
let curTargetSpeed = 1000;

const PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
const PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

function setBtnLabel(btn, text) {
    if (!btn) return;
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = text;
    else btn.textContent = text;
}

function setBtnIcon(btn, svgHtml) {
    if (!btn) return;
    const ic = btn.querySelector('.btn-icon');
    if (ic) ic.innerHTML = svgHtml;
}

function setConnectButtonState(isConnected) {
    if (!connectBtn) return;
    setBtnLabel(connectBtn, isConnected ? 'Disconnect' : 'Connect');
    connectBtn.classList.toggle('btn-primary', !isConnected);
    connectBtn.classList.toggle('btn-connected', isConnected);
}

function setStatus(msg) {
    let displayMsg = msg;
    if (msg.toLowerCase().includes('connecting')) {
        displayMsg = 'Connecting';
    } else if (msg.toLowerCase().includes('not connected') || msg.toLowerCase().includes('disconnect')) {
        displayMsg = 'Disconnected';
    } else if (msg.toLowerCase().includes('paused')) {
        displayMsg = 'Paused';
    } else if (msg.toLowerCase().includes('running')) {
        displayMsg = 'Running';
    } else if (msg.toLowerCase().includes('stopped')) {
        displayMsg = 'Stopped';
    }
    if (statusChip) {
        const text = statusChip.querySelector('.chip-text');
        if (text) text.textContent = displayMsg;
        statusChip.classList.remove('chip-connected', 'chip-connecting', 'chip-disconnected', 'chip-paused');
        if (displayMsg === 'Running') {
            statusChip.classList.add('chip-connected');
        } else if (displayMsg === 'Connecting') {
            statusChip.classList.add('chip-connecting');
        } else if (displayMsg === 'Paused') {
            statusChip.classList.add('chip-paused');
        } else {
            statusChip.classList.add('chip-disconnected');
        }
    }
}
function updateDashboard(data) {
    speedDiv.textContent = data.speed || '—';
    distanceDiv.textContent = data.distance || '—';
    caloriesDiv.textContent = data.calories || '—';
    stepsDiv.textContent = (data.steps !== undefined && data.steps !== null && data.steps !== '-') ? data.steps : '—';
    if (data.duration && typeof data.duration === 'number') {
        durationDiv.textContent = formatDuration(data.duration);
    } else if (typeof data.duration === 'string' && !isNaN(parseFloat(data.duration))) {
        durationDiv.textContent = formatDuration(parseFloat(data.duration));
    } else {
        durationDiv.textContent = data.duration && data.duration !== '-' ? data.duration : '—';
    }
}
function enableControls(enable) {
    startBtn.disabled = !enable;
    stopBtn.disabled = !enable;
    speedUpBtn.disabled = !enable;
    speedDownBtn.disabled = !enable;
    speedSlider.disabled = !enable;
}
function updateRunningState(state) {
    runningState = state;
    const setStartUI = (label, running) => {
        setBtnLabel(startBtn, label);
        setBtnIcon(startBtn, running ? PAUSE_ICON_SVG : PLAY_ICON_SVG);
    };
    if (!connected) {
        enableControls(false);
        setStartUI('Start', false);
        setStatus('Disconnected');
    } else {
        switch (state) {
            case 0:
                enableControls(false);
                setStartUI('Start', false);
                break;
            case 1:
                enableControls(true);
                setStartUI('Pause', true);
                setStatus('Running');
                break;
            case 2:
                enableControls(true);
                setStartUI('Start', false);
                setStatus('Paused');
                break;
            case 3:
                enableControls(true);
                setStartUI('Start', false);
                setStatus('Stopped');
                break;
            default:
                enableControls(false);
                setStartUI('Start', false);
                setStatus('Disconnected');
        }
    }
    syncWakeLock();
}

// Keep the display (and with it the Mac) awake while the belt runs; a sleeping machine drops the BLE link mid-walk.
let wakeLock = null;
let wakeLockPending = false;
let wakeLockFailedAt = 0;
function syncWakeLock() {
    if (!('wakeLock' in navigator)) return;
    const wanted = connected && runningState === 1 && document.visibilityState === 'visible';
    if (wanted && !wakeLock && !wakeLockPending && Date.now() - wakeLockFailedAt > 30000) {
        wakeLockPending = true;
        navigator.wakeLock.request('screen').then(lock => {
            wakeLockPending = false;
            wakeLock = lock;
            lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
            syncWakeLock();
        }).catch(() => {
            wakeLockPending = false;
            wakeLockFailedAt = Date.now();
        });
    } else if (!wanted && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        lock.release().catch(() => {});
    }
}
document.addEventListener('visibilitychange', syncWakeLock);
function formatDuration(seconds) {
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    let parts = [];
    if (h > 0) parts.push(h + 'h');
    if (m > 0 || h > 0) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
}

let pendingData = null;
function send_data(packet) {
    pendingData = packet;
}

function bluetoothUnavailableMessage() {
    if (!window.isSecureContext) {
        return 'Bluetooth only works on a secure page. Open this app via https:// or http://localhost, not as a file or LAN address.';
    }
    if (!navigator.bluetooth) {
        return IS_MAC
            ? 'Safari and Firefox can\'t talk to Bluetooth devices. Open this page in Chrome, Edge, Brave or Arc.'
            : 'This browser has no Web Bluetooth. Open this page in Chrome, Edge, Brave or Arc.';
    }
    return '';
}

const BLUETOOTH_OFF_MESSAGE = IS_MAC
    ? 'Bluetooth is off or this browser may not use it. Turn it on in Control Center, and allow your browser under System Settings → Privacy & Security → Bluetooth.'
    : 'Bluetooth is off or no adapter was found.';

function showBluetoothNotice(message) {
    if (!btNotice) return;
    btNotice.textContent = message;
    btNotice.hidden = !message;
}

async function checkBluetoothSupport() {
    const unsupported = bluetoothUnavailableMessage();
    if (unsupported) {
        showBluetoothNotice(unsupported);
        connectBtn.disabled = true;
        return;
    }
    if (!navigator.bluetooth.getAvailability) return;
    const update = available => showBluetoothNotice(available ? '' : BLUETOOTH_OFF_MESSAGE);
    navigator.bluetooth.addEventListener('availabilitychanged', e => update(e.value));
    update(await navigator.bluetooth.getAvailability().catch(() => true));
}

function describeBluetoothError(err) {
    const text = String((err && err.message) || err);
    if (err && err.name === 'NotFoundError' && /cancel/i.test(text)) return '';
    if (/adapter not available|globally disabled|bluetooth.*(off|unavailable)/i.test(text)) return BLUETOOTH_OFF_MESSAGE;
    return 'Bluetooth error: ' + text;
}

async function connectBluetooth() {
    const unsupported = bluetoothUnavailableMessage();
    if (unsupported) {
        showToast(unsupported, 6000);
        return;
    }
    setStatus('Connecting');
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    try {
        debugLog("Requesting Bluetooth device...");
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
            services: [SERVICE_UUID]
        });
        debugLog("Device selected:", device);
        setStatus('Connecting');
        device.addEventListener('gattserverdisconnected', onDisconnected);
        server = await device.gatt.connect();
        debugLog("GATT server connected:", server);
        let services = await server.getPrimaryServices();
        debugLog("Primary services:", services.map(s => s.uuid));
        notifyChar = await server.getPrimaryService(SERVICE_UUID).then(
            service => service.getCharacteristic(NOTIFY_CHAR_UUID)
        ).catch(async () => {

            let services = await server.getPrimaryServices();
            for (let s of services) {
                try {
                    let c = await s.getCharacteristic(NOTIFY_CHAR_UUID);
                    if (c) return c;
                } catch {}
            }
            throw new Error("Notify characteristic not found");
        });
        debugLog("Notify characteristic:", notifyChar);
        writeChar = await server.getPrimaryService(SERVICE_UUID).then(
            service => service.getCharacteristic(WRITE_CHAR_UUID)
        ).catch(async () => {
            let services = await server.getPrimaryServices();
            for (let s of services) {
                try {
                    let c = await s.getCharacteristic(WRITE_CHAR_UUID);
                    if (c) return c;
                } catch {}
            }
            throw new Error("Write characteristic not found");
        });
        debugLog("Write characteristic:", writeChar);
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        connected = true;
        setStatus('Stopped');
        setConnectButtonState(true);
        updateRunningState(3);

        if (loadingOverlay) loadingOverlay.style.display = 'none';
    } catch (err) {
        console.error("Bluetooth connection error:", err);
        const message = describeBluetoothError(err);
        if (message) showToast(message, 6000);
        if (device && device.gatt.connected) device.gatt.disconnect();
        setStatus('Disconnected');
        connected = false;
        setConnectButtonState(false);
        if (loadingOverlay) loadingOverlay.style.display = 'none';

    }
}

function disconnectBluetooth() {
    if (device && device.gatt.connected) {
        device.gatt.disconnect();
    }
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    setStatus('Disconnected');
}

function onDisconnected() {
    connected = false;
    setStatus('Disconnected');
    setConnectButtonState(false);
    updateRunningState(3);
    if (sessionActive && sessionStartData) {
        finishSession('Disconnected');
    }
}

function handleNotification(event) {
    const value = event.target.value;

    if (DEBUG) debugLog(`Notification (${value.byteLength} bytes):`, toHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));

    if (value.byteLength < 31) {
        treadmillData = {
            speed: "-",
            distance: "-",
            calories: "-",
            steps: "-",
            duration: "-",
            status: "Invalid"
        };
        updateDashboard(treadmillData);
        updateRunningState(3);

        if (sessionActive && sessionStartData) {
            finishSession('Disconnected');
        }
        return;
    }

    function u16(offset) {
        return (value.getUint8(offset) << 8) | value.getUint8(offset + 1);
    }
    function u32(offset) {
        return (value.getUint8(offset) << 24) | (value.getUint8(offset + 1) << 16) | (value.getUint8(offset + 2) << 8) | value.getUint8(offset + 3);
    }

    const current_speed = u16(3);
    const distance = u32(7);
    const calories = (value.getUint8(18) << 8) | value.getUint8(19);
    const steps = u32(14);
    const duration = u32(20);
    const flags = value.getUint8(26);
    const unit_mode = (flags & 128) === 128 ? 1 : 0;
    const running_state_bits = flags & 24;
    let running_state = 3;
    if (running_state_bits === 24) running_state = 0;
    else if (running_state_bits === 8) running_state = 1;
    else if (running_state_bits === 16) running_state = 2;
    else running_state = 3;
    const statusArr = ["Starting", "Running", "Paused", "Stopped"];
    const speed_unit = unit_mode === 1 ? "mph" : "kph";
    const distance_unit = unit_mode === 1 ? "mi" : "km";
    treadmillData = {
        speed: (current_speed / 1000).toFixed(2) + " " + speed_unit,
        distance: (distance / 1000).toFixed(2) + " " + distance_unit,
        calories: calories + " kcal",
        steps: steps,
        duration: Math.round(duration / 1000),
        status: statusArr[running_state] || "Unknown",
        _raw: { current_speed, distance, calories, steps, duration, speed_unit }
    };

    debugLog("Parsed treadmill data:", treadmillData);
    updateDashboard(treadmillData);
    updateRunningState(running_state);

    const MERGE_WINDOW_MS = 60 * 1000;
    const MAX_TICK_MS = 10 * 1000;

    if (running_state === 1) {
        const now = Date.now();
        if (!sessionActive || !sessionStartData) {

            const sessions = loadSessions();
            const last = sessions[0];
            let resumed = null;
            if (last && typeof last.date === 'number' && typeof last.duration === 'number') {
                const lastEnd = last.date + last.duration * 1000;
                const inWindow = now - lastEnd < MERGE_WINDOW_MS && now - lastEnd > -MAX_TICK_MS;
                const prevKcal = parseFloat(last.calories) || 0;
                const countersConsistent = steps >= (last.steps || 0) && calories >= prevKcal;
                if (inWindow && countersConsistent) resumed = last;
            }
            if (resumed) {
                const prevKcal = parseFloat(resumed.calories) || 0;
                sessionStartData = {
                    date: resumed.date,
                    stepsBase: steps - (resumed.steps || 0),
                    calBase: calories - prevKcal,
                    durMsAccum: (resumed.duration || 0) * 1000,
                    lastTickMs: now,
                    speedSum: current_speed,
                    speedCount: 1,
                    speedUnit: speed_unit
                };
            } else {
                sessionStartData = {
                    date: now,
                    stepsBase: steps,
                    calBase: calories,
                    durMsAccum: 0,
                    lastTickMs: now,
                    speedSum: current_speed,
                    speedCount: 1,
                    speedUnit: speed_unit
                };
            }
            sessionActive = true;
        } else {
            const deltaMs = Math.max(0, Math.min(now - sessionStartData.lastTickMs, MAX_TICK_MS));
            sessionStartData.durMsAccum += deltaMs;
            sessionStartData.lastTickMs = now;
            sessionStartData.speedSum += current_speed;
            sessionStartData.speedCount += 1;
        }

        const durationSec = Math.round(sessionStartData.durMsAccum / 1000);
        const sessionSteps = Math.max(0, steps - sessionStartData.stepsBase);
        const sessionCal = Math.max(0, calories - sessionStartData.calBase);
        const avgSpeed = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
        upsertLiveSession({
            date: sessionStartData.date,
            duration: durationSec,
            steps: sessionSteps,
            calories: sessionCal + ' kcal',
            avgSpeed: avgSpeed,
            speedUnit: sessionStartData.speedUnit || ''
        });
    } else if (running_state === 2 && sessionActive && sessionStartData) {

        sessionStartData.lastTickMs = Date.now();
    } else if (running_state === 3 && sessionActive && sessionStartData) {
        finishSession('Stopped');
    }

    if (writeChar) {
        if (pendingData) {
            debugLog("Sending pending data packet:", toHex(pendingData));
            writeChar.writeValue(pendingData).then(() => {
                debugLog("Pending data sent.");
                pendingData = null;
            }).catch(err => {
                console.error("Failed to send pending data:", err);
            });
        } else {

            const heartbeat = new Uint8Array([0x6a, 0x05, 0xfd, 0xf8, 0x43]);
            debugLog("Sending heartbeat packet:", toHex(heartbeat));
            writeChar.writeValue(heartbeat).catch(err => {
                console.error("Failed to send heartbeat:", err);
            });
        }
    }
}

async function sendCommand(packet) {
    if (!writeChar) return;
    try {
        debugLog("Sending command packet:", toHex(packet));
        await writeChar.writeValue(packet);
    } catch (err) {
        console.error("Failed to send command:", err);
        showToast("Failed to send command: " + err);
    }
}

function makePacket(type, speed = 1000) {

    let arr = new Uint8Array(23);
    arr[0] = 0x6A;
    arr[1] = 0x17;

    arr[6] = (speed >> 8) & 0xFF;
    arr[7] = speed & 0xFF;
    arr[8] = type === "set_speed" ? 5 : 1;
    arr[9] = 0;
    arr[10] = 80;
    arr[11] = 0;

    let cmd = type === "pause" ? 2 : type === "stop" ? 0 : 4;
    arr[12] = cmd & 0xF7;

    let userId = 58965456623n;
    for (let i = 0; i < 8; ++i) {
        arr[13 + i] = Number((userId >> BigInt(56 - i * 8)) & 0xFFn);
    }

    let checksum = 0;
    for (let i = 1; i <= 20; ++i) {
        checksum ^= arr[i];
    }
    arr[21] = checksum;
    arr[22] = 0x43;
    return arr;
}

connectBtn.addEventListener('click', () => {
    if (!connected) connectBluetooth();
    else disconnectBluetooth();
});

startBtn.addEventListener('click', async () => {
    if (!connected) return;
    if (runningState === 1) {
        send_data(makePacket("pause"));
    } else {

        if (countdownOverlay && countdownNumber) {
            countdownOverlay.style.display = 'flex';
            countdownOverlay.style.opacity = '1';
            let count = 3;
            countdownNumber.textContent = count;
            countdownNumber.style.opacity = '1';
            countdownNumber.style.transform = 'scale(1)';

            (async () => {
                for (let i = 0; i < 3; i++) {
                    await new Promise(res => setTimeout(res, 700));
                    countdownNumber.style.transform = 'scale(1.3)';
                    countdownNumber.style.opacity = '0.5';
                    await new Promise(res => setTimeout(res, 200));
                    count--;
                    if (count > 0) {
                        countdownNumber.textContent = count;
                        countdownNumber.style.opacity = '1';
                        countdownNumber.style.transform = 'scale(1)';
                    }
                }
                await new Promise(res => setTimeout(res, 400));
                countdownOverlay.style.opacity = '0';
                await new Promise(res => setTimeout(res, 500));
                countdownOverlay.style.display = 'none';
                countdownOverlay.style.opacity = '1';
            })();
        }
        send_data(makePacket("start", curTargetSpeed));
    }
});

stopBtn.addEventListener('click', () => {
    if (!connected) return;
    send_data(makePacket("stop"));
});

function syncSliderToTargetSpeed() {
    const kph = curTargetSpeed / 1000;
    speedSlider.value = kph.toFixed(1);

    speedSlider.dispatchEvent(new Event('input', { bubbles: true }));
}

speedUpBtn.addEventListener('click', () => {
    if (!connected) return;
    curTargetSpeed = Math.min(curTargetSpeed + 100, 6000);
    syncSliderToTargetSpeed();
    send_data(makePacket("set_speed", curTargetSpeed));
});

speedDownBtn.addEventListener('click', () => {
    if (!connected) return;
    curTargetSpeed = Math.max(curTargetSpeed - 100, 1000);
    syncSliderToTargetSpeed();
    send_data(makePacket("set_speed", curTargetSpeed));
});

speedSlider.addEventListener('input', () => {
    sliderValue.textContent = parseFloat(speedSlider.value).toFixed(1);
});
speedSlider.addEventListener('change', () => {
    if (!connected) return;
    curTargetSpeed = Math.round(parseFloat(speedSlider.value) * 1000);
    send_data(makePacket("set_speed", curTargetSpeed));
});

updateDashboard({});
updateRunningState(3);
sliderValue.textContent = speedSlider.value;
renderSessionTable();
checkBluetoothSupport();

window.treadmill = {
    isWalking: () => sessionActive
};

function upsertLiveSession(session) {
    let sessions = loadSessions();
    if (sessions.length > 0 && sessions[0] && sessions[0].date === session.date) {
        sessions[0] = session;
    } else {
        sessions.unshift(session);
    }
    saveSessions(sessions);
    renderSessionTable();
    if (window.goals && window.goals.refreshThrottled) window.goals.refreshThrottled();
}

function finishSession(reason) {
    sessionActive = false;
    sessionStartData = null;
    if (window.goals && window.goals.refresh) window.goals.refresh();
    if (window.notifications && window.notifications.onSessionFinished) {
        window.notifications.onSessionFinished();
    }
}

function isValidSession(s) {
    return s !== null && typeof s === 'object'
        && typeof s.date === 'number' && Number.isFinite(s.date)
        && typeof s.duration === 'number' && Number.isFinite(s.duration) && s.duration >= 0;
}

// Import merges instead of replacing, so walks recorded on two machines can be combined.
// A walk is identified by its start time; on a clash the longer recording wins.
function mergeSessions(existing, incoming) {
    const byDate = new Map(existing.map(s => [s.date, s]));
    let added = 0, updated = 0;
    for (const s of incoming) {
        const prev = byDate.get(s.date);
        if (!prev) {
            byDate.set(s.date, s);
            added++;
        } else if (s.duration > (prev.duration || 0)) {
            byDate.set(s.date, s);
            updated++;
        }
    }
    const merged = Array.from(byDate.values()).sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0));
    return { merged, added, updated };
}

if (exportHistoryBtn) {
    exportHistoryBtn.addEventListener('click', () => {
        const sessions = loadSessions();
        const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `treadmill-history-${new Date().toLocaleDateString('sv-SE')}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        showToast('History exported.');
    });
}

if (importHistoryBtn && importHistoryInput) {
    importHistoryBtn.addEventListener('click', () => {
        importHistoryInput.value = '';
        importHistoryInput.click();
    });
    importHistoryInput.addEventListener('change', (e) => {
        const file = importHistoryInput.files && importHistoryInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const imported = JSON.parse(event.target.result);
                if (!Array.isArray(imported)) {
                    showToast('Invalid file format.');
                    return;
                }
                const valid = imported.filter(isValidSession);
                const skipped = imported.length - valid.length;
                const { merged, added, updated } = mergeSessions(loadSessions(), valid);
                saveSessions(merged);
                renderSessionTable();
                if (window.goals && window.goals.refresh) window.goals.refresh();
                const parts = [];
                if (added) parts.push(`${added} new walk${added === 1 ? '' : 's'}`);
                if (updated) parts.push(`${updated} updated`);
                if (skipped) parts.push(`${skipped} unreadable skipped`);
                showToast(parts.length ? 'Imported ' + parts.join(', ') + '.' : 'Nothing new to import.');
            } catch (err) {
                showToast('Failed to import: ' + err);
            }
        };
        reader.readAsText(file);
    });
}

(function () {
    const startDayKey = new Date().toLocaleDateString('sv-SE');
    setInterval(() => {
        const nowKey = new Date().toLocaleDateString('sv-SE');
        if (nowKey === startDayKey) return;
        if (runningState === 1 || sessionActive) {
            if (window.goals && window.goals.refresh) window.goals.refresh();
            return;
        }
        location.reload();
    }, 60 * 1000);
})();

function showToast(message, timeout = 3500) {
    const sb = document.getElementById('snackbar');
    if (!sb) return;
    sb.textContent = message;
    sb.classList.add('is-visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => sb.classList.remove('is-visible'), timeout);
}
window.showToast = showToast;
