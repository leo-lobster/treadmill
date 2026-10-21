
const CACHE_NAME = 'treadmill-v6';
const SHELL = [
    './',
    './index.html',
    './treadmill.js',
    './goals.js',
    './notifications.js',
    './manifest.webmanifest',
    './icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/favicon-32.png',
    './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys =>
                Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
            )
        ])
    );
});

// Network first: a new deploy shows up on the next online launch. The cache only answers
// when offline, or when the local dev server isn't running.
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(
        fetch(request).then(resp => {
            if (resp.ok && resp.type === 'basic') {
                const respClone = resp.clone();
                caches.open(CACHE_NAME).then(c => c.put(request, respClone)).catch(() => {});
            }
            return resp;
        }).catch(() =>
            caches.match(request, { ignoreSearch: true }).then(cached =>
                cached || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error())
            )
        )
    );
});

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('treadmill-shared', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
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

async function idbPut(key, value) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function getLocalDateKey(ts) {
    return new Date(ts).toLocaleDateString('sv-SE');
}

function isWeekendKey(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const day = new Date(y, m - 1, d).getDay();
    return day === 0 || day === 6;
}

function computeProgress(sessions, cfg) {
    const todayKey = getLocalDateKey(Date.now());
    const todays = (sessions || []).filter(s =>
        s && typeof s.date === 'number' && getLocalDateKey(s.date) === todayKey
    );
    const minSecs = cfg.minSessionMinutes * 60;
    const goalSecs = cfg.dailyMinutes * 60;
    const totalSeconds = todays.reduce((sum, s) => sum + (s.duration || 0), 0);
    const qualifyingCount = todays.filter(s => (s.duration || 0) >= minSecs).length;
    const goalMet = totalSeconds >= goalSecs;
    const splitMet = qualifyingCount >= 2;
    return {
        totalSeconds,
        qualifyingCount,
        goalMet,
        splitMet,
        remainingSeconds: Math.max(0, goalSecs - totalSeconds),
        isWeekend: isWeekendKey(todayKey)
    };
}

const DEFAULTS = {
    dailyMinutes: 120, minSessionMinutes: 5,
    activeHoursStart: 8, activeHoursEnd: 21, excludeWeekends: true
};

const MIN_COOLDOWN_MS = 15 * 60 * 1000;
const ACTIVITY_TTL_MS = 5 * 60 * 1000;
const DESK_TIME_MIN = 60;
const RECENT_WALK_MIN = 60;
const FIRST_WALK_HOUR = 10;

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
    const minsNow = now.getHours() * 60 + now.getMinutes();
    return Math.max(0, cfg.activeHoursEnd * 60 - minsNow);
}

function buildMessage(trigger, progress, cfg, urgency, deskMin, now) {
    const remMin = Math.ceil(progress.remainingSeconds / 60);
    const tier = tierFromUrgency(urgency);
    const paceDef = Math.round(computePaceDeficitMin(progress, cfg, now));

    if (trigger === 'desk-time') {
        return {
            title: 'Time to move',
            body: remMin > 0
                ? `${deskMin} min at the desk. ${remMin}m still to walk today.`
                : `${deskMin} min at the desk — stretch your legs.`
        };
    }
    if (trigger === 'first-walk') {
        return {
            title: 'First walk?',
            body: `No sessions yet today. ${cfg.dailyMinutes}m to fit in — best to start early.`
        };
    }
    const minsLeft = activeMinutesLeft(cfg, now);
    if (paceDef >= 10) {
        if (paceDef >= 30) return { title: 'Falling behind', body: `${paceDef}m behind today's pace · ${remMin}m to goal. Walk now to catch up.` };
        if (paceDef >= 20) return { title: 'Catch up time', body: `${paceDef}m behind pace · ${remMin}m to go. Quick session?` };
        return { title: 'A bit behind', body: `${paceDef}m behind pace · ${remMin}m still to do today.` };
    }
    if (tier === 'chill') return { title: 'Walk time', body: `${remMin}m left for today — plenty of time still.` };
    if (tier === 'normal') return { title: 'Walk check-in', body: `${remMin}m still to do today. Fit a session in?` };
    if (tier === 'pressing') return { title: 'Squeeze it in', body: `${remMin}m needed, only ${minsLeft}m left in active hours.` };
    return { title: 'Move now', body: `${remMin}m to go, only ${minsLeft}m of active time. Walk now.` };
}

async function runGoalCheck() {
    const cfg = Object.assign({}, DEFAULTS, (await idbGet('goalConfig')) || {});
    const sessions = (await idbGet('sessions')) || [];
    const state = (await idbGet('notificationState')) || { lastFired: 0, lastTrigger: null };

    const progress = computeProgress(sessions, cfg);
    const now = new Date();
    const hour = now.getHours();
    const dow = now.getDay();
    if (cfg.excludeWeekends && (dow === 0 || dow === 6)) return;
    if (hour < cfg.activeHoursStart || hour >= cfg.activeHoursEnd) return;
    if (progress.goalMet && progress.splitMet) return;

    const lastActivity = (await idbGet('lastUserActivity')) || 0;
    if (Date.now() - lastActivity > ACTIVITY_TTL_MS) return;

    if (Date.now() - state.lastFired < MIN_COOLDOWN_MS) return;

    const streakStart = (await idbGet('activeStreakStart')) || lastActivity;
    const deskMin = Math.floor((Date.now() - streakStart) / 60000);
    const lastSession = (await idbGet('lastSessionFinishedTs')) || 0;
    const minsSinceLastWalk = lastSession
        ? (Date.now() - lastSession) / 60000
        : Infinity;

    const sameTriggerRecent = state.lastTrigger && (Date.now() - state.lastFired < 4 * 60 * 60 * 1000);
    const urgency = computeUrgency(progress, cfg, now);
    let trigger = null;

    if (deskMin >= DESK_TIME_MIN && minsSinceLastWalk >= RECENT_WALK_MIN) {
        if (!(sameTriggerRecent && state.lastTrigger === 'desk-time')) trigger = 'desk-time';
    }
    if (!trigger && progress.qualifyingCount === 0 && hour >= FIRST_WALK_HOUR) {
        if (!(sameTriggerRecent && state.lastTrigger === 'first-walk')) trigger = 'first-walk';
    }
    if (!trigger) {
        const cd = Math.max(MIN_COOLDOWN_MS, cooldownForUrgency(urgency));
        if (Date.now() - state.lastFired < cd) return;
        trigger = 'time-pressure';
    }

    const msg = buildMessage(trigger, progress, cfg, urgency, deskMin, now);
    await self.registration.showNotification(msg.title, {
        body: msg.body,
        tag: 'treadmill-' + trigger,
        renotify: false,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        data: { trigger, urgency, ts: Date.now() }
    });

    state.lastFired = Date.now();
    state.lastTrigger = trigger;
    state.lastDayKey = getLocalDateKey(Date.now());
    await idbPut('notificationState', state);
}

self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'goal-check') {
        event.waitUntil(runGoalCheck().catch(() => {}));
    }
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'goal-check') {
        event.waitUntil(runGoalCheck().catch(() => {}));
    }
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of allClients) {
            if (c.url.includes('index.html') || c.url.endsWith('/')) {
                await c.focus();
                return;
            }
        }
        await clients.openWindow('./index.html');
    })());
});
