
(function () {
    const STATE_KEY = 'treadmill_notification_state';
    const CHECK_INTERVAL_MS = 5 * 60 * 1000;
    const ACTIVITY_TTL_MS = 5 * 60 * 1000;
    const MIN_COOLDOWN_MS = 15 * 60 * 1000;
    const DESK_TIME_MIN = 60;
    const RECENT_WALK_MIN = 60;
    const FIRST_WALK_HOUR = 10;

    function loadState() {
        try {
            return Object.assign(
                { permissionAsked: false, lastFired: 0, lastTrigger: null, lastDayKey: '', firedMilestones: [] },
                JSON.parse(localStorage.getItem(STATE_KEY) || '{}')
            );
        } catch {
            return { permissionAsked: false, lastFired: 0, lastTrigger: null, lastDayKey: '', firedMilestones: [] };
        }
    }

    function saveState(state) {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        if (window.goals && window.goals.idbPut) {
            window.goals.idbPut('notificationState', state).catch(() => {});
        }
    }

    function todayKey() {
        return new Date().toLocaleDateString('sv-SE');
    }

    const NOTIFICATION_ICON = 'icons/icon-192.png';

    let lastActivityTs = Date.now();
    let activeStreakStart = Date.now();
    let lastSessionFinishedTs = 0;
    let idleDetector = null;
    let idleSince = 0;

    function noteActivity() {
        const now = Date.now();
        // With the IdleDetector running, page events are not the source of truth for the desk streak.
        if (!idleDetector && now - lastActivityTs > ACTIVITY_TTL_MS) {
            activeStreakStart = now;
        }
        lastActivityTs = now;
    }

    let activityWriteThrottle = 0;
    function onUserActivity() {
        noteActivity();
        const now = Date.now();
        if (now - activityWriteThrottle > 30000 && window.goals && window.goals.idbPut) {
            activityWriteThrottle = now;
            window.goals.idbPut('lastUserActivity', now).catch(() => {});
            window.goals.idbPut('activeStreakStart', activeStreakStart).catch(() => {});
        }
    }

    function detectorSaysActive(detector) {
        return detector.userState === 'active' && detector.screenState === 'unlocked';
    }

    // Page events only see activity inside this window. The IdleDetector sees the whole machine,
    // which is what "time at the desk" means when the app sits in the background.
    function isUserActive() {
        if (idleDetector) return detectorSaysActive(idleDetector);
        return Date.now() - lastActivityTs < ACTIVITY_TTL_MS;
    }

    function getActiveStreakMin() {
        if (!isUserActive()) return 0;
        return Math.floor((Date.now() - activeStreakStart) / 60000);
    }

    async function getIdlePermission() {
        if (!('IdleDetector' in window)) return 'unsupported';
        try {
            return (await navigator.permissions.query({ name: 'idle-detection' })).state;
        } catch {
            return 'unsupported';
        }
    }

    // IdleDetector.requestPermission() needs a user gesture, so it is only called from a click;
    // on page load the detector starts only if permission was granted earlier.
    async function startIdleDetector(askPermission) {
        if (!('IdleDetector' in window) || idleDetector) return;
        try {
            const perm = askPermission ? await IdleDetector.requestPermission() : await getIdlePermission();
            if (perm !== 'granted' || idleDetector) return;
            const detector = new IdleDetector();
            detector.addEventListener('change', () => {
                if (detectorSaysActive(detector)) {
                    if (idleSince && Date.now() - idleSince > ACTIVITY_TTL_MS) {
                        activeStreakStart = Date.now();
                    }
                    idleSince = 0;
                    onUserActivity();
                } else if (!idleSince) {
                    idleSince = Date.now();
                }
            });
            await detector.start({ threshold: 60000 });
            idleDetector = detector;
        } catch {
        }
    }

    function bindActivityListeners() {
        ['mousemove', 'keydown', 'touchstart', 'click', 'wheel'].forEach(ev => {
            window.addEventListener(ev, onUserActivity, { passive: true });
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') onUserActivity();
        });
        onUserActivity();
    }

    function computePaceDeficitMin(progress, cfg, now) {
        const minsNow = now.getHours() * 60 + now.getMinutes();
        const minsStart = cfg.activeHoursStart * 60;
        const minsEnd = cfg.activeHoursEnd * 60;
        const totalActive = minsEnd - minsStart;
        if (totalActive <= 0) return 0;
        const elapsed = Math.max(0, Math.min(totalActive, minsNow - minsStart));
        const expectedMin = cfg.dailyMinutes * (elapsed / totalActive);
        const actualMin = progress.totalSeconds / 60;
        return Math.max(0, expectedMin - actualMin);
    }

    function computeUrgency(progress, cfg, now) {
        now = now || new Date();
        const remainingMin = Math.ceil(progress.remainingSeconds / 60);
        if (remainingMin <= 0) return 0;
        const minsNow = now.getHours() * 60 + now.getMinutes();
        const minsEnd = cfg.activeHoursEnd * 60;
        const remainingActiveMin = minsEnd - minsNow;
        if (remainingActiveMin <= 0) return 999;
        const timeUrgency = remainingMin / remainingActiveMin;
        const paceUrgency = computePaceDeficitMin(progress, cfg, now) / 20;
        return Math.max(timeUrgency, paceUrgency);
    }

    function tierFromUrgency(u) {
        if (u < 0.4) return 'chill';
        if (u < 0.7) return 'normal';
        if (u < 1.0) return 'pressing';
        return 'urgent';
    }

    function cooldownForUrgency(u) {
        if (u < 0.4) return 90 * 60 * 1000;
        if (u < 0.7) return 45 * 60 * 1000;
        if (u < 1.0) return 25 * 60 * 1000;
        return 15 * 60 * 1000;
    }

    function activeMinutesLeft(cfg, now) {
        now = now || new Date();
        const minsNow = now.getHours() * 60 + now.getMinutes();
        return Math.max(0, cfg.activeHoursEnd * 60 - minsNow);
    }

    function buildMessage(trigger, progress, cfg, urgency, now) {
        now = now || new Date();
        const remMin = Math.ceil(progress.remainingSeconds / 60);
        const tier = tierFromUrgency(urgency);
        const paceDef = Math.round(computePaceDeficitMin(progress, cfg, now));

        if (trigger === 'desk-time') {
            const streakMin = getActiveStreakMin();
            return {
                title: 'Time to move',
                body: remMin > 0
                    ? `${streakMin} min at the desk. ${remMin}m still to walk today.`
                    : `${streakMin} min at the desk — stretch your legs.`
            };
        }
        if (trigger === 'first-walk') {
            return {
                title: 'First walk?',
                body: `No sessions yet today. ${cfg.dailyMinutes}m to fit in — best to start early.`
            };
        }

        const minsLeft = activeMinutesLeft(cfg);

        if (paceDef >= 10) {
            if (paceDef >= 30) {
                return { title: 'Falling behind', body: `${paceDef}m behind today's pace · ${remMin}m to goal. Walk now to catch up.` };
            }
            if (paceDef >= 20) {
                return { title: 'Catch up time', body: `${paceDef}m behind pace · ${remMin}m to go. Quick session?` };
            }
            return { title: 'A bit behind', body: `${paceDef}m behind pace · ${remMin}m still to do today.` };
        }
        if (tier === 'chill') {
            return { title: 'Walk time', body: `${remMin}m left for today — plenty of time still.` };
        }
        if (tier === 'normal') {
            return { title: 'Walk check-in', body: `${remMin}m still to do today. Fit a session in?` };
        }
        if (tier === 'pressing') {
            return { title: 'Squeeze it in', body: `${remMin}m needed, only ${minsLeft}m left in active hours.` };
        }

        return { title: 'Move now', body: `${remMin}m to go, only ${minsLeft}m of active time. Walk now.` };
    }

    function decideTrigger(progress, cfg, urgency, now) {
        now = now || new Date();
        const dow = now.getDay();
        const hour = now.getHours();

        if (cfg.excludeWeekends && (dow === 0 || dow === 6)) return null;
        if (hour < cfg.activeHoursStart || hour >= cfg.activeHoursEnd) return null;
        if (window.treadmill && window.treadmill.isWalking()) return null;
        if (!isUserActive()) return null;
        if (progress.goalMet && progress.splitMet) return null;
        if (!('Notification' in window) || Notification.permission !== 'granted') return null;

        const state = loadState();
        if (Date.now() - state.lastFired < MIN_COOLDOWN_MS) return null;

        const streakMin = getActiveStreakMin();
        const minsSinceLastWalk = lastSessionFinishedTs
            ? (Date.now() - lastSessionFinishedTs) / 60000
            : Infinity;

        const sameTriggerAsLast = state.lastTrigger && (Date.now() - state.lastFired < 4 * 60 * 60 * 1000);

        if (streakMin >= DESK_TIME_MIN && minsSinceLastWalk >= RECENT_WALK_MIN) {
            if (!(sameTriggerAsLast && state.lastTrigger === 'desk-time')) {
                return 'desk-time';
            }
        }

        if (progress.qualifyingCount === 0 && hour >= FIRST_WALK_HOUR) {
            if (!(sameTriggerAsLast && state.lastTrigger === 'first-walk')) {
                return 'first-walk';
            }
        }

        const cd = Math.max(MIN_COOLDOWN_MS, cooldownForUrgency(urgency));
        if (Date.now() - state.lastFired < cd) return null;
        return 'time-pressure';
    }

    async function fire(trigger, progress, cfg, urgency) {
        const msg = buildMessage(trigger, progress, cfg, urgency);
        let shown = false;
        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
            try {
                const reg = await navigator.serviceWorker.ready;
                await reg.showNotification(msg.title, {
                    body: msg.body,
                    tag: 'treadmill-' + trigger,
                    renotify: false,
                    icon: NOTIFICATION_ICON,
                    badge: NOTIFICATION_ICON,
                    data: { trigger, urgency, ts: Date.now() }
                });
                shown = true;
            } catch {}
        }
        if (!shown) {
            try {
                new Notification(msg.title, {
                    body: msg.body,
                    tag: 'treadmill-' + trigger,
                    icon: NOTIFICATION_ICON
                });
                shown = true;
            } catch {}
        }
        if (shown) {
            const state = loadState();
            state.lastFired = Date.now();
            state.lastTrigger = trigger;
            state.lastDayKey = todayKey();
            saveState(state);
        }
        return shown;
    }

    let checkTimer = null;

    function check() {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        // Keeps the service worker's copy of "last active" fresh while the user works in other apps.
        if (idleDetector && isUserActive()) onUserActivity();
        const sessions = window.loadSessions
            ? window.loadSessions()
            : JSON.parse(localStorage.getItem('treadmill_sessions') || '[]');
        const cfg = window.goals ? window.goals.loadConfig() : null;
        if (!cfg) return;
        const progress = window.goals.getTodaysProgress(sessions, cfg);
        const urgency = computeUrgency(progress, cfg);
        const trigger = decideTrigger(progress, cfg, urgency);
        if (trigger) {
            fire(trigger, progress, cfg, urgency);
        }
    }

    const MILESTONES = [
        { pct: 25,  title: 'Quarter way there',  body: (p, cfg) => `${Math.round(p.totalSeconds/60)}m down. Keep going!` },
        { pct: 50,  title: 'Halfway there 🎯',   body: (p, cfg) => `Half of today's ${cfg.dailyMinutes}m goal in the bag.` },
        { pct: 75,  title: 'Almost there',       body: (p, cfg) => `Three quarters done — ${Math.ceil(p.remainingSeconds/60)}m to go.` },
        { pct: 100, title: 'Goal hit! 🎉',       body: (p, cfg) => `${Math.round(p.totalSeconds/60)}m walked today. Nice work.` }
    ];

    function checkMilestones() {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const sessions = window.loadSessions
            ? window.loadSessions()
            : JSON.parse(localStorage.getItem('treadmill_sessions') || '[]');
        const cfg = window.goals ? window.goals.loadConfig() : null;
        if (!cfg) return;
        const progress = window.goals.getTodaysProgress(sessions, cfg);
        if (cfg.excludeWeekends && progress.isWeekend) return;

        const state = loadState();

        const k = todayKey();
        if (state.lastDayKey !== k) {
            state.lastDayKey = k;
            state.firedMilestones = [];
        }

        const pctNow = Math.min(100, Math.round(progress.percent * 100));
        const toFire = MILESTONES.filter(m => pctNow >= m.pct && !state.firedMilestones.includes(m.pct));
        if (!toFire.length) return;

        const top = toFire[toFire.length - 1];
        (async () => {
            const body = top.body(progress, cfg);
            let shown = false;
            if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    await reg.showNotification(top.title, {
                        body,
                        tag: 'treadmill-milestone-' + top.pct,
                        renotify: false,
                        icon: NOTIFICATION_ICON,
                        badge: NOTIFICATION_ICON,
                        data: { trigger: 'milestone', pct: top.pct }
                    });
                    shown = true;
                } catch {}
            }
            if (!shown) {
                try {
                    new Notification(top.title, { body, tag: 'treadmill-milestone-' + top.pct, icon: NOTIFICATION_ICON });
                    shown = true;
                } catch {}
            }
            if (shown) {

                const s = loadState();
                s.firedMilestones = Array.from(new Set([
                    ...(s.firedMilestones || []),
                    ...MILESTONES.filter(m => m.pct <= top.pct).map(m => m.pct)
                ]));
                s.lastDayKey = todayKey();
                saveState(s);
            }
        })();
    }

    function reschedule() {
        if (checkTimer) clearInterval(checkTimer);
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        checkTimer = setInterval(check, CHECK_INTERVAL_MS);

        setTimeout(check, 3000);
    }

    function onSessionFinished() {
        lastSessionFinishedTs = Date.now();
        activeStreakStart = Date.now();
        if (window.goals && window.goals.idbPut) {
            window.goals.idbPut('lastSessionFinishedTs', lastSessionFinishedTs).catch(() => {});
            window.goals.idbPut('activeStreakStart', activeStreakStart).catch(() => {});
        }
    }

    async function requestPermission() {
        if (!('Notification' in window)) return 'unsupported';
        // Started before any await so the request still runs inside the click's user activation.
        const idleRequest = startIdleDetector(true);
        const state = loadState();
        state.permissionAsked = true;
        saveState(state);
        if (Notification.permission !== 'default') {
            await idleRequest;
            return Notification.permission;
        }
        try {
            const perm = await Notification.requestPermission();
            if (perm === 'granted') {
                new Notification('Reminders on', {
                    body: 'Smart nudges only when you\'re actually at the computer.',
                    tag: 'treadmill-welcome'
                });
                if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                    try {
                        const reg = await navigator.serviceWorker.ready;
                        if (reg.periodicSync) {
                            await reg.periodicSync.register('goal-check', {
                                minInterval: 30 * 60 * 1000
                            });
                        }
                    } catch {}
                }
                reschedule();
            }
            await idleRequest;
            return perm;
        } catch {
            return 'denied';
        }
    }

    function maybeShowInlinePrompt() {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'default') return;
        const state = loadState();
        if (state.permissionAsked) return;
        const banner = document.getElementById('notifPrompt');
        if (!banner) return;
        banner.style.display = 'flex';
        document.getElementById('notifPromptYes').onclick = async () => {
            banner.style.display = 'none';
            await requestPermission();
        };
        document.getElementById('notifPromptNo').onclick = () => {
            banner.style.display = 'none';
            const s = loadState();
            s.permissionAsked = true;
            saveState(s);
        };
    }

    function init() {
        bindActivityListeners();
        startIdleDetector();
        if ('Notification' in window && Notification.permission === 'granted') {
            reschedule();
            if (navigator.serviceWorker) {
                navigator.serviceWorker.ready.then(reg => {
                    if (reg.periodicSync) {
                        reg.periodicSync.register('goal-check', { minInterval: 30 * 60 * 1000 })
                            .catch(() => {});
                    }
                }).catch(() => {});
            }
        }
        maybeShowInlinePrompt();
    }

    window.notifications = {
        init,
        requestPermission,
        getIdlePermission,
        reschedule,
        check,
        checkMilestones,
        onSessionFinished,
        isUserActive,
        getActiveStreakMin,

        _state: {
            getActivityTs: () => lastActivityTs,
            getStreakStart: () => activeStreakStart,
            getLastSession: () => lastSessionFinishedTs,
            setStreakStart: (ts) => { activeStreakStart = ts; },
            setLastActivity: (ts) => { lastActivityTs = ts; },
            setLastSession: (ts) => { lastSessionFinishedTs = ts; }
        },
        _urgencyNow: () => {
            const sessions = window.loadSessions
                ? window.loadSessions()
                : JSON.parse(localStorage.getItem('treadmill_sessions') || '[]');
            const cfg = window.goals.loadConfig();
            const progress = window.goals.getTodaysProgress(sessions, cfg);
            const now = new Date();
            const u = computeUrgency(progress, cfg, now);
            return { urgency: u, tier: tierFromUrgency(u),
                     cooldownMin: cooldownForUrgency(u) / 60000,
                     remainingGoalMin: Math.ceil(progress.remainingSeconds / 60),
                     activeMinutesLeft: activeMinutesLeft(cfg),
                     activeStreakMin: getActiveStreakMin(),
                     paceDeficitMin: Math.round(computePaceDeficitMin(progress, cfg, now)) };
        },
        _decideNow: () => {
            const sessions = window.loadSessions
                ? window.loadSessions()
                : JSON.parse(localStorage.getItem('treadmill_sessions') || '[]');
            const cfg = window.goals.loadConfig();
            const progress = window.goals.getTodaysProgress(sessions, cfg);
            const u = computeUrgency(progress, cfg);
            return decideTrigger(progress, cfg, u);
        }
    };
})();
