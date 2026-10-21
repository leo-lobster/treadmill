
const SERVICE_UUID = "0000fba0-0000-1000-8000-00805f9b34fb";
const NOTIFY_CHAR_UUID = "0000fba2-0000-1000-8000-00805f9b34fb";
const WRITE_CHAR_UUID = "0000fba1-0000-1000-8000-00805f9b34fb";

const connectBtn = document.getElementById('connectBtn');
const statusDiv = document.getElementById('status');
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
let lastSession = null;

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
function addSession(session) {
    const sessions = loadSessions();
    sessions.unshift(session);
    saveSessions(sessions);
    renderSessionTable();
}
function deleteSession(idx) {
    const sessions = loadSessions();
    sessions.splice(idx, 1);
    saveSessions(sessions);
    renderSessionTable();
}
function renderSessionTable() {
    const sessions = loadSessions();
    historyTableBody.innerHTML = '';
    sessions.forEach((s, i) => {
        let avgSpeedDisplay = '-';
        if (typeof s.avgSpeed === 'number' && !isNaN(s.avgSpeed)) {
            avgSpeedDisplay = s.avgSpeed.toFixed(2) + ' ' + (s.speedUnit || '');
        } else if (typeof s.avgSpeed === 'string' && !isNaN(parseFloat(s.avgSpeed))) {
            avgSpeedDisplay = parseFloat(s.avgSpeed).toFixed(2) + ' ' + (s.speedUnit || '');
        }
        let dateStr = '-';
        if (typeof s.date === 'number' || typeof s.date === 'string') {
            dateStr = dateFns.formatRelative(new Date(s.date), new Date());
        }
        const stepsDisplay = (typeof s.steps === 'number') ? s.steps.toLocaleString() : (s.steps || '—');
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${dateStr}</td>
            <td>${formatDuration(s.duration)}</td>
            <td class="num">${stepsDisplay}</td>
            <td class="num">${s.calories || '—'}</td>
            <td class="num">${avgSpeedDisplay}</td>
            <td class="num"><button class="history-action-btn" title="Delete" onclick="window.deleteSessionFromTable(${i})">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button></td>
        `;
        historyTableBody.appendChild(tr);
    });
    if (sessions.length === 0) {
        historyTableBody.innerHTML = '<tr><td colspan="6" class="history-empty">No sessions yet — your walks will appear here.</td></tr>';
    }
}
window.deleteSessionFromTable = function (idx) {
    deleteSession(idx);
    if (window.goals && window.goals.refresh) window.goals.refresh();
};

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
}
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

async function connectBluetooth() {
    setStatus('Connecting');
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    try {
        console.log("Requesting Bluetooth device...");
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
            services: [SERVICE_UUID]
        });
        console.log("Device selected:", device);
        setStatus('Connecting');
        device.addEventListener('gattserverdisconnected', onDisconnected);
        server = await device.gatt.connect();
        console.log("GATT server connected:", server);
        let services = await server.getPrimaryServices();
        console.log("Primary services:", services.map(s => s.uuid));
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
        console.log("Notify characteristic:", notifyChar);
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
        console.log("Write characteristic:", writeChar);
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        connected = true;
        setStatus('Stopped');
        setConnectButtonState(true);
        updateRunningState(3);

        if (loadingOverlay) loadingOverlay.style.display = 'none';
    } catch (err) {
        console.error("Bluetooth connection error:", err);
        showToast("Bluetooth error: " + err);
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

    console.log("Received notification, byteLength:", value.byteLength);
    let hexStr = [];
    for (let i = 0; i < value.byteLength; ++i) {
        hexStr.push(value.getUint8(i).toString(16).padStart(2, "0"));
    }
    console.log("Payload (hex):", hexStr.join(" "));

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

    console.log("Parsed treadmill data:", treadmillData);
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
            console.log("Sending pending data packet:", Array.from(pendingData).map(b => b.toString(16).padStart(2, "0")).join(" "));
            writeChar.writeValue(pendingData).then(() => {
                console.log("Pending data sent.");
                pendingData = null;
            }).catch(err => {
                console.error("Failed to send pending data:", err);
            });
        } else {

            const heartbeat = new Uint8Array([0x6a, 0x05, 0xfd, 0xf8, 0x43]);
            console.log("Sending heartbeat packet:", Array.from(heartbeat).map(b => b.toString(16).padStart(2, "0")).join(" "));
            writeChar.writeValue(heartbeat).catch(err => {
                console.error("Failed to send heartbeat:", err);
            });
        }
    }
}

async function sendCommand(packet) {
    if (!writeChar) return;
    try {
        console.log("Sending command packet:", Array.from(packet).map(b => b.toString(16).padStart(2, "0")).join(" "));
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

function saveCurrentSession(session) {
    localStorage.setItem('treadmill_current_session', JSON.stringify(session));
}
function loadCurrentSession() {
    try {
        return JSON.parse(localStorage.getItem('treadmill_current_session')) || null;
    } catch { return null; }
}
function clearCurrentSession() {
    localStorage.removeItem('treadmill_current_session');
}

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

const restored = loadCurrentSession();
if (restored && !sessionActive) {
    sessionActive = true;
    sessionStartData = restored;
}

if (exportHistoryBtn) {
    exportHistoryBtn.addEventListener('click', () => {
        const sessions = loadSessions();
        const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'treadmill_sessions.json';
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
                if (Array.isArray(imported)) {
                    saveSessions(imported);
                    renderSessionTable();
                    if (window.goals && window.goals.refresh) window.goals.refresh();
                    showToast('History imported successfully.');
                } else {
                    showToast('Invalid file format.');
                }
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
