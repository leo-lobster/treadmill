# Treadmill

A browser dashboard that talks to your treadmill directly over Bluetooth. Open the page, click Connect, walk.

## Why this exists

The stock app wants an account, your phone number, a notification permission to advertise at you, and 200 MB of your storage. This is a single HTML file plus three JS files. No account. No server. No telemetry. Your walks live in your own browser's localStorage — yours, exportable, gone the moment you say so.

It pairs over **Web Bluetooth**, so any Chromium browser works (Chrome / Edge / Brave / Arc, desktop or Android). Add it to your home screen and it behaves like a native app, offline included. Safari doesn't implement Web Bluetooth, so iOS / macOS Safari is out.

## Get going

1. Open the page
2. Click **Connect** in the header
3. Pick your treadmill in the Bluetooth prompt
4. Hit Start

That's it. The browser remembers the device, so next time it's a single click.

## What it does

- **Live readout.** Speed, distance, duration, steps, calories, and live state — updated every BLE notification.
- **Speed control.** 1–6 kph slider plus ±0.1 kph buttons. Slider and buttons stay in sync; whichever you touch wins.
- **Daily goal.** Pick minutes-per-day. Today's progress card, 7-day bar chart, weekday streak (weekends optional). Configurable minimum session length for the "two short walks count more than one" rule.
- **Auto-logged history.** Every walk is recorded as it happens. Pause-resume within 60 s merges into a single session so quick stops don't fragment it. Export / import as JSON for backup or moving between machines.
- **Smart reminders.** Browser notifications when you've been at the desk too long, when the day is slipping past with the goal unmet, and milestone celebrations at 25 / 50 / 75 / 100 %. Cooldowns shrink as evening approaches. Gated on weekday + your active hours.
- **Installable PWA.** Works offline. Service worker keeps reminders firing even when the tab is closed (where the browser supports periodic background sync).
- **Zero backend.** Static files. Host it anywhere, including `localhost`. No accounts, no analytics, no third-party calls.
