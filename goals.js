
(function () {
    const DEFAULT_CONFIG = {
        dailyMinutes: 120,
        minSessionMinutes: 5,
        activeHoursStart: 8,
        activeHoursEnd: 21,
        excludeWeekends: true
    };

    const CONFIG_KEY = 'treadmill_goal_config';

    function loadConfig() {
        try {
            const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
            return Object.assign({}, DEFAULT_CONFIG, stored);
        } catch {
            return Object.assign({}, DEFAULT_CONFIG);
        }
    }

    function saveConfig(cfg) {
        const merged = Object.assign({}, DEFAULT_CONFIG, cfg);
        localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
        idbPut('goalConfig', merged).catch(() => {});
        return merged;
    }

    function getLocalDateKey(ts) {

        return new Date(ts).toLocaleDateString('sv-SE');
    }

    function isWeekend(dateKey) {

        const [y, m, d] = dateKey.split('-').map(Number);
        const day = new Date(y, m - 1, d).getDay();
        return day === 0 || day === 6;
    }

    function getSessionsForDate(sessions, dateKey) {
        return sessions.filter(s => s && typeof s.date === 'number' && getLocalDateKey(s.date) === dateKey);
    }

    function getTodaysProgress(sessions, cfg) {
        const todayKey = getLocalDateKey(Date.now());
        const todays = getSessionsForDate(sessions, todayKey).sort((a, b) => a.date - b.date);
        const minSecs = cfg.minSessionMinutes * 60;
        const goalSecs = cfg.dailyMinutes * 60;
        const totalSeconds = todays.reduce((sum, s) => sum + (s.duration || 0), 0);
        const qualifyingCount = todays.filter(s => (s.duration || 0) >= minSecs).length;
        const goalMet = totalSeconds >= goalSecs;
        const splitMet = qualifyingCount >= 2;
        const remainingSeconds = Math.max(0, goalSecs - totalSeconds);
        const percent = goalSecs > 0 ? Math.min(1, totalSeconds / goalSecs) : 0;
        return {
            dateKey: todayKey,
            sessions: todays,
            totalSeconds,
            qualifyingCount,
            goalMet,
            splitMet,
            remainingSeconds,
            percent,
            isWeekend: isWeekend(todayKey)
        };
    }

    function getLast7Days(sessions, cfg) {
        const days = [];
        const today = new Date();
        const goalSecs = cfg.dailyMinutes * 60;
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
            const key = d.toLocaleDateString('sv-SE');
            const dayTotal = sessions
                .filter(s => s && typeof s.date === 'number' && getLocalDateKey(s.date) === key)
                .reduce((sum, s) => sum + (s.duration || 0), 0);
            days.push({
                dateKey: key,
                label: d.toLocaleDateString(undefined, { weekday: 'short' }),
                totalSeconds: dayTotal,
                isWeekend: isWeekend(key),
                isToday: i === 0,
                goalMet: dayTotal >= goalSecs
            });
        }
        return days;
    }

    function getStreak(sessions, cfg) {

        const goalSecs = cfg.dailyMinutes * 60;
        let streak = 0;
        const today = new Date();
        for (let i = 0; i < 365; i++) {
            const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
            const key = d.toLocaleDateString('sv-SE');
            if (cfg.excludeWeekends && isWeekend(key)) continue;
            const dayTotal = sessions
                .filter(s => s && typeof s.date === 'number' && getLocalDateKey(s.date) === key)
                .reduce((sum, s) => sum + (s.duration || 0), 0);
            if (dayTotal >= goalSecs) {
                streak++;
            } else if (i === 0) {

                continue;
            } else {
                break;
            }
        }
        return streak;
    }

    function openIDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('treadmill-shared', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('kv');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbPut(key, value) {
        const db = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function idbGet(key) {
        const db = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('kv', 'readonly');
            const req = tx.objectStore('kv').get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function snapshotToIDB() {
        const sessions = (window.loadSessions ? window.loadSessions() :
            JSON.parse(localStorage.getItem('treadmill_sessions') || '[]'));
        const cfg = loadConfig();
        try {
            await Promise.all([
                idbPut('sessions', sessions),
                idbPut('goalConfig', cfg)
            ]);
        } catch {}
    }

    function fmtHM(seconds) {
        seconds = Math.max(0, Math.floor(seconds));
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
        return `${m}m`;
    }

    function fmtChip(seconds) {
        seconds = Math.max(0, Math.floor(seconds));
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function renderTodayCard(progress, cfg) {
        const root = document.getElementById('todayCardContent');
        if (!root) return;

        let statusLine = '';
        if (progress.isWeekend && cfg.excludeWeekends) {
            statusLine = 'Weekend — no goal today. Walk if you like.';
        } else if (progress.goalMet && progress.splitMet) {
            statusLine = 'Goal met — nice walk today.';
        } else if (progress.goalMet && !progress.splitMet) {
            statusLine = `Goal met, but in just ${progress.qualifyingCount} session${progress.qualifyingCount === 1 ? '' : 's'}.`;
        } else if (progress.sessions.length === 0) {
            statusLine = 'No walks yet today.';
        } else {
            const needSession = progress.qualifyingCount < 2;
            const partsToGo = [];
            if (progress.remainingSeconds > 0) partsToGo.push(`${fmtHM(progress.remainingSeconds)} to go`);
            if (needSession) partsToGo.push(`need ${2 - progress.qualifyingCount} more session${2 - progress.qualifyingCount === 1 ? '' : 's'}`);
            statusLine = partsToGo.join(' • ');
        }

        const minSecs = cfg.minSessionMinutes * 60;
        const chipsHtml = progress.sessions.length
            ? progress.sessions.map(s => {
                const isShort = (s.duration || 0) < minSecs;
                const cls = isShort ? 'session-chip session-chip--short' : 'session-chip';
                const prefix = isShort ? '· ' : '';
                const steps = (typeof s.steps === 'number') ? ` <span class="chip-meta">${s.steps.toLocaleString()} st</span>` : '';
                return `<span class="${cls}">${prefix}${fmtChip(s.duration || 0)}${steps}</span>`;
            }).join('')
            : '<span class="session-chip session-chip--empty">no sessions yet</span>';

        const headline = fmtHM(progress.totalSeconds);
        const sub = `of ${fmtHM(cfg.dailyMinutes * 60)}`;
        const pct = Math.round(progress.percent * 100);
        const fillPct = Math.min(100, Math.max(0, progress.percent * 100));
        const fillClass = (progress.goalMet && progress.splitMet) ? 'today-bar-fill today-bar-fill--met' : 'today-bar-fill';

        root.innerHTML = `
            <div class="today-headline">
                <div class="today-main">${headline}</div>
                <div class="today-sub">${sub} · ${pct}%</div>
            </div>
            <div class="today-bar">
                <div class="${fillClass}" style="width:${fillPct}%"></div>
                <div class="today-bar-stripe" style="--fill:${fillPct}%"></div>
            </div>
            <div class="today-status">${statusLine}</div>
            <div class="session-chips">${chipsHtml}</div>
        `;
    }

    function renderWeekCard(sessions, cfg) {
        const root = document.getElementById('weekCardContent');
        if (!root) return;

        const days = getLast7Days(sessions, cfg);
        const goalSecs = cfg.dailyMinutes * 60;
        const maxSecs = Math.max(goalSecs, ...days.map(d => d.totalSeconds));
        const streak = getStreak(sessions, cfg);

        const goalLineTop = `${(1 - goalSecs / maxSecs) * 100}%`;

        const bars = days.map(d => {
            const heightPct = maxSecs > 0 ? (d.totalSeconds / maxSecs) * 100 : 0;
            const classes = ['week-bar'];
            if (d.isWeekend && cfg.excludeWeekends) classes.push('week-bar--weekend');
            if (d.isToday) classes.push('week-bar--today');
            if (d.goalMet) classes.push('week-bar--goal');
            return `
                <div class="${classes.join(' ')}">
                    <div class="week-bar-track">
                        <div class="week-bar-fill" style="height:${heightPct}%"></div>
                    </div>
                    <div class="week-bar-label">${d.label}</div>
                </div>
            `;
        }).join('');

        const streakChip = streak > 0
            ? `<span class="streak-chip">🔥 ${streak}-day streak</span>`
            : `<span class="streak-chip streak-chip--idle">no streak yet</span>`;

        root.innerHTML = `
            <div class="week-chart">
                <div class="week-goal-line" style="top:${goalLineTop}" title="Daily goal: ${fmtHM(goalSecs)}"></div>
                ${bars}
            </div>
            <div class="week-footer">
                ${streakChip}
                <span class="week-goal-hint">goal line = ${fmtHM(goalSecs)}/day</span>
            </div>
        `;
    }

    let lastRefresh = 0;
    let pendingTimer = null;
    const REFRESH_MIN_MS = 5000;

    function refresh() {
        const sessions = window.loadSessions ? window.loadSessions() :
            JSON.parse(localStorage.getItem('treadmill_sessions') || '[]');
        const cfg = loadConfig();
        const progress = getTodaysProgress(sessions, cfg);
        renderTodayCard(progress, cfg);
        renderWeekCard(sessions, cfg);
        lastRefresh = Date.now();

        snapshotToIDB();

        if (window.notifications && window.notifications.checkMilestones) {
            window.notifications.checkMilestones();
        }
        return progress;
    }

    function refreshThrottled() {
        const since = Date.now() - lastRefresh;
        if (since >= REFRESH_MIN_MS) {
            refresh();
            return;
        }
        if (pendingTimer) return;
        pendingTimer = setTimeout(() => {
            pendingTimer = null;
            refresh();
        }, REFRESH_MIN_MS - since);
    }

    function openSettings() {
        const overlay = document.getElementById('settingsOverlay');
        if (!overlay) return;
        const cfg = loadConfig();
        document.getElementById('cfgDailyMinutes').value = cfg.dailyMinutes;
        document.getElementById('cfgMinSession').value = cfg.minSessionMinutes;
        document.getElementById('cfgStart').value = String(cfg.activeHoursStart).padStart(2, '0') + ':00';
        document.getElementById('cfgEnd').value = String(cfg.activeHoursEnd).padStart(2, '0') + ':00';
        document.getElementById('cfgExcludeWeekends').checked = !!cfg.excludeWeekends;

        const notifBtn = document.getElementById('cfgNotifBtn');
        if (notifBtn) {
            if (!('Notification' in window)) {
                notifBtn.textContent = 'Notifications not supported';
                notifBtn.disabled = true;
            } else if (Notification.permission === 'granted') {
                notifBtn.textContent = 'Notifications: enabled';
                notifBtn.disabled = true;
                if (window.notifications && window.notifications.getIdlePermission) {
                    window.notifications.getIdlePermission().then(state => {
                        if (state !== 'prompt') return;
                        notifBtn.textContent = 'Detect activity in other apps';
                        notifBtn.disabled = false;
                    });
                }
            } else if (Notification.permission === 'denied') {
                notifBtn.textContent = 'Notifications blocked in browser settings';
                notifBtn.disabled = true;
            } else {
                notifBtn.textContent = 'Enable reminders';
                notifBtn.disabled = false;
            }
        }

        const installBtn = document.getElementById('cfgInstallBtn');
        if (installBtn) {
            installBtn.style.display = window.__deferredInstallPrompt ? 'inline-block' : 'none';
        }
        overlay.style.display = 'flex';
    }

    function closeSettings() {
        const overlay = document.getElementById('settingsOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    function saveSettingsFromForm() {
        const parseHour = (v) => {
            const h = parseInt((v || '').split(':')[0], 10);
            return Number.isFinite(h) ? Math.max(0, Math.min(23, h)) : 0;
        };
        const next = {
            dailyMinutes: Math.max(1, parseInt(document.getElementById('cfgDailyMinutes').value, 10) || 120),
            minSessionMinutes: Math.max(0, parseInt(document.getElementById('cfgMinSession').value, 10) || 5),
            activeHoursStart: parseHour(document.getElementById('cfgStart').value),
            activeHoursEnd: parseHour(document.getElementById('cfgEnd').value),
            excludeWeekends: !!document.getElementById('cfgExcludeWeekends').checked
        };
        saveConfig(next);
        refresh();
        if (window.notifications && window.notifications.reschedule) {
            window.notifications.reschedule();
        }
        closeSettings();
    }

    function init() {

        snapshotToIDB();

        const gear = document.getElementById('settingsBtn');
        if (gear) gear.addEventListener('click', openSettings);
        const closeBtn = document.getElementById('settingsCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeSettings);
        const saveBtn = document.getElementById('settingsSaveBtn');
        if (saveBtn) saveBtn.addEventListener('click', saveSettingsFromForm);
        const overlay = document.getElementById('settingsOverlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeSettings();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && overlay.style.display === 'flex') closeSettings();
            });
        }
        const notifBtn = document.getElementById('cfgNotifBtn');
        if (notifBtn) {
            notifBtn.addEventListener('click', async () => {
                if (window.notifications && window.notifications.requestPermission) {
                    await window.notifications.requestPermission();
                }

                openSettings();
            });
        }
        const installBtn = document.getElementById('cfgInstallBtn');
        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                const p = window.__deferredInstallPrompt;
                if (!p) return;
                p.prompt();
                try { await p.userChoice; } catch {}
                window.__deferredInstallPrompt = null;
                installBtn.style.display = 'none';
            });
        }

        refresh();
    }

    window.goals = {
        init,
        refresh,
        refreshThrottled,
        loadConfig,
        saveConfig,
        getTodaysProgress,
        getLast7Days,
        getStreak,
        getLocalDateKey,
        isWeekend,
        snapshotToIDB,
        idbPut,
        idbGet
    };
})();
