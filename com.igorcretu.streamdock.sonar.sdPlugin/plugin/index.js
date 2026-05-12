const POLL_MS = 5000;
const CORE_PROPS_PATH = 'C:\\ProgramData\\SteelSeries\\GG\\coreProps.json';

const CHANNEL_LABELS = {
    master: 'Master',
    game: 'Game',
    chatRender: 'Chat',
    media: 'Media',
    aux: 'Aux',
    chatCapture: 'Mic',
};

// volumeSettings API uses 'chatRender'/'chatCapture'; classicRedirections API uses 'chat'/'mic'
const REDIR_CH = { chatRender: 'chat', chatCapture: 'mic' };
const toRedirCh = ch => REDIR_CH[ch] || ch;

// ── Shared Sonar URL cache ─────────────────────────────────────────────

let _sonarBaseUrl = null;
let _sonarLastError = null;
let _ggLastLaunchTime = 0;

function tryLaunchSteelSeriesGG() {
    const now = Date.now();
    if (now - _ggLastLaunchTime < 30000) return; // 30 s cooldown
    _ggLastLaunchTime = now;
    try {
        const fs = require('fs');
        const path = require('path');
        const ggArgs = ['-dataPath=C:\\ProgramData\\SteelSeries\\GG', '-dbEnv=production'];
        const candidates = [
            'C:\\Program Files\\SteelSeries\\GG\\SteelSeriesGGEZ.exe',
            'C:\\Program Files (x86)\\SteelSeries\\GG\\SteelSeriesGGEZ.exe',
        ];
        const exe = candidates.find(p => fs.existsSync(p));
        if (!exe) { console.warn('[Sonar] SteelSeries GG not found'); return; }
        const cwd = path.dirname(exe);

        // Strategy 1: electron.shell (available in Electron renderer)
        try {
            const { shell } = require('electron');
            // openPath doesn't support args, so write a .bat and open that
            const bat = require('os').tmpdir() + '\\start_gg.bat';
            fs.writeFileSync(bat, `@echo off\nstart "" "${exe}" ${ggArgs.join(' ')}\n`);
            shell.openPath(bat);
            console.log('[Sonar] Launched via electron.shell + bat');
            return;
        } catch (e1) { console.warn('[Sonar] electron.shell failed:', e1.message); }

        // Strategy 2: spawn with cwd
        try {
            const { spawn } = require('child_process');
            const child = spawn(exe, ggArgs, { detached: true, stdio: 'ignore', cwd });
            child.unref();
            console.log('[Sonar] Launched via spawn');
            return;
        } catch (e2) { console.warn('[Sonar] spawn failed:', e2.message); }

        // Strategy 3: cmd /c start
        try {
            const { exec } = require('child_process');
            exec(`cmd /c start "" "${exe}" ${ggArgs.join(' ')}`, { cwd });
            console.log('[Sonar] Launched via cmd start');
        } catch (e3) { console.error('[Sonar] All launch strategies failed:', e3.message); }

    } catch (e) {
        console.error('[Sonar] Launch error:', e.message);
    }
}

async function getSonarBaseUrl() {
    if (_sonarBaseUrl) return _sonarBaseUrl;
    let ggAddr = '127.0.0.1:6327';

    if (typeof require !== 'undefined') {
        try {
            const fs = require('fs');
            const props = JSON.parse(fs.readFileSync(CORE_PROPS_PATH, 'utf8'));
            ggAddr = props.ggEncryptedAddress || ggAddr;
            const address = await new Promise((resolve, reject) => {
                const https = require('https');
                const req = https.get(`https://${ggAddr}/subApps`, { rejectUnauthorized: false }, res => {
                    let raw = '';
                    res.on('data', c => raw += c);
                    res.on('end', () => {
                        try { resolve(JSON.parse(raw)?.subApps?.sonar?.metadata?.webServerAddress || ''); }
                        catch (e) { reject(e); }
                    });
                });
                req.on('error', reject);
                req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
            });
            if (address) { _sonarBaseUrl = address.replace(/\/$/, ''); return _sonarBaseUrl; }
        } catch (e) {
            _sonarLastError = 'req:' + e.message.slice(0, 30);
        }
    }

    try {
        const resp = await fetch(`https://${ggAddr}/subApps`);
        if (resp.ok) {
            const address = (await resp.json())?.subApps?.sonar?.metadata?.webServerAddress;
            if (address) { _sonarBaseUrl = address.replace(/\/$/, ''); return _sonarBaseUrl; }
        }
    } catch (e) { _sonarLastError = 'https:' + e.message.slice(0, 30); }

    try {
        const fileResp = await fetch('file:///C:/ProgramData/SteelSeries/GG/coreProps.json');
        if (fileResp.ok) {
            const props = await fileResp.json();
            ggAddr = props.ggEncryptedAddress || ggAddr;
            const resp2 = await fetch(`https://${ggAddr}/subApps`);
            if (resp2.ok) {
                const address = (await resp2.json())?.subApps?.sonar?.metadata?.webServerAddress;
                if (address) { _sonarBaseUrl = address.replace(/\/$/, ''); return _sonarBaseUrl; }
            }
        }
    } catch (e) { _sonarLastError = 'file:' + e.message.slice(0, 30); }

    return null;
}

// ── Sonar HTTP helper (bypasses browser CORS for PUT/POST) ────────────

function sonarRequest(url, method) {
    return new Promise((resolve, reject) => {
        try {
            const http = require('http');
            const parsed = new URL(url);
            const req = http.request({
                hostname: parsed.hostname,
                port: parseInt(parsed.port),
                path: parsed.pathname,
                method: method || 'GET',
            }, res => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: () => { try { return Promise.resolve(JSON.parse(raw)); } catch(e) { return Promise.reject(e); } },
                }));
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('sonar timeout')); });
            req.end();
        } catch (e) {
            // require not available — fall back to fetch
            fetch(url, { method: method || 'GET' }).then(resolve).catch(reject);
        }
    });
}

// ── Canvas helpers ─────────────────────────────────────────────────────

function sendImage(context, dataUrl) {
    $websocket.send(JSON.stringify({
        event: 'setImage', context,
        payload: { target: 0, image: dataUrl }
    }));
}

async function makeDeviceImage(channelLabel, deviceName, isOff, iconDataUrl) {
    const canvas = document.createElement('canvas');
    canvas.width = 144; canvas.height = 144;
    const ctx = canvas.getContext('2d');
    ctx.textAlign = 'center';

    if (isOff) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 28px sans-serif';
        ctx.fillText('Sonar', 72, 68);
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText('Off', 72, 102);
        return canvas.toDataURL();
    }

    const src = iconDataUrl || guessDeviceIconPath(deviceName);
    await new Promise(resolve => {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, 144, 144); resolve(); };
        img.onerror = resolve;
        img.src = src;
    });

    return canvas.toDataURL();
}

function makeVolumeImage(channelLabel, volumePct, muted) {
    const canvas = document.createElement('canvas');
    canvas.width = 144; canvas.height = 144;
    const ctx = canvas.getContext('2d');
    ctx.textAlign = 'center';

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 144, 144);

    // Channel badge — full width strip at top
    ctx.fillStyle = muted ? '#991b1b' : '#1d4ed8';
    ctx.fillRect(0, 0, 144, 40);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(channelLabel.toUpperCase(), 72, 30);

    if (muted) {
        ctx.fillStyle = '#f87171';
        ctx.font = 'bold 36px sans-serif';
        ctx.fillText('MUTED', 72, 106);
    } else {
        // Volume bar
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(10, 50, 124, 14);
        ctx.fillStyle = volumePct > 85 ? '#f59e0b' : '#22c55e';
        if (volumePct > 0) ctx.fillRect(10, 50, Math.round(124 * volumePct / 100), 14);

        // Big percentage
        ctx.fillStyle = '#f1f5f9';
        ctx.font = 'bold 52px sans-serif';
        ctx.fillText(`${volumePct}%`, 72, 118);
    }

    return canvas.toDataURL();
}

// ── Shared helpers ─────────────────────────────────────────────────────

function guessDeviceIconPath(name) {
    const n = (name || '').toLowerCase();
    if (/headset|headphone|arctis|nova|steelseries/.test(n)) return 'icons/headphones.png';
    if (/realtek|integrated|built.?in|laptop/.test(n)) return 'icons/laptop.png';
    if (/hdmi|displayport|monitor/.test(n)) return 'icons/display.png';
    return 'icons/speaker.png';
}

function shorten(name) {
    const m = name.match(/\((.+)\)$/);
    if (m) name = m[1].trim();
    for (const noise of ['(R)', '(TM)', 'USB Audio Device', 'Digital Audio']) {
        name = name.replace(noise, '').trim();
    }
    name = name.replace(/^\d+-\s*/, '').trim();
    if (name.length > 14) {
        const words = name.split(' ');
        name = words.length >= 2 ? words.slice(-2).join(' ') : name.slice(0, 13) + '...';
    }
    return name;
}

// ── Plugin actions ─────────────────────────────────────────────────────

const $plugin = {
    name: 'sonar',

    // ── Game output device cycler ──────────────────────────────────────
    game: new Action({
        default: { channels: ['game'] },
        _state: {},

        async _willAppear({ context }) {
            this._state[context] = this._state[context] || {};
            await this.refreshDisplay(context);
            this._state[context].timer = setInterval(() => this.refreshDisplay(context), POLL_MS);
        },

        _willDisappear({ context }) {
            clearInterval(this._state[context]?.timer);
            delete this._state[context];
        },

        didReceiveSettings({ context, payload }) {
            this.data[context] = Object.assign({ ...this.default }, payload?.settings || {});
            this.refreshDisplay(context);
        },

        keyUp({ context }) { this.cycleDevice(context); },

        // PI requests the device list to populate icon assignment
        async sendToPlugin({ action, context, payload }) {
            if (payload?.event !== 'getDevices') return;
            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) return;
            try {
                const resp = await fetch(`${baseUrl}/audioDevices`);
                const devices = await resp.json();
                const outputs = devices
                    .filter(d => d.dataFlow === 'render' && !d.isVad)
                    .map(d => ({ id: d.id, name: shorten(d.friendlyName) }));
                $websocket.sendToPropertyInspector(action, context, { devices: outputs });
            } catch (e) {
                console.error('[Sonar] sendToPlugin getDevices error:', e.message);
            }
        },

        async refreshDisplay(context) {
            const settings = this.data[context] || {};
            const channels = settings.channels?.length ? settings.channels : ['game'];
            const primaryCh = channels[0];
            const label = CHANNEL_LABELS[primaryCh] || primaryCh;

            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) {
                tryLaunchSteelSeriesGG();
                sendImage(context, await makeDeviceImage(label, '', true));
                $websocket.setTitle(context, '');
                return;
            }
            try {
                const [devResp, redirResp] = await Promise.all([
                    fetch(`${baseUrl}/audioDevices`),
                    fetch(`${baseUrl}/classicRedirections`)
                ]);
                if (!devResp.ok || !redirResp.ok) throw new Error('bad response');

                const devices = await devResp.json();
                const redirections = await redirResp.json();
                const realOutputs = devices.filter(d => d.dataFlow === 'render' && !d.isVad);
                const currentId = redirections.find(r => r.id === toRedirCh(primaryCh))?.deviceId;

                this._state[context] = { ...this._state[context], devices: realOutputs, currentDeviceId: currentId };

                const name = devices.find(d => d.id === currentId)?.friendlyName || 'Unknown';
                const iconDataUrl = settings.deviceIcons?.[currentId];
                sendImage(context, await makeDeviceImage(label, shorten(name), false, iconDataUrl));
                $websocket.setTitle(context, '');
            } catch (e) {
                if (e.message?.includes('ECONNREFUSED') || e.message?.includes('fetch')) {
                    _sonarBaseUrl = null;
                }
                sendImage(context, await makeDeviceImage(label, '', true));
                $websocket.setTitle(context, '');
            }
        },

        async cycleDevice(context) {
            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) return;

            const settings = this.data[context] || {};
            const channels = settings.channels?.length ? settings.channels : ['game'];
            const primaryCh = channels[0];

            let { devices, currentDeviceId } = this._state[context] || {};
            if (!devices?.length) { await this.refreshDisplay(context); return; }

            const idx = devices.findIndex(d => d.id === currentDeviceId);
            const next = devices[(idx + 1) % devices.length];

            const results = await Promise.allSettled(channels.map(ch =>
                sonarRequest(
                    `${baseUrl}/classicRedirections/${toRedirCh(ch)}/deviceId/${next.id}`,
                    'PUT'
                )
            ));
            results.forEach((r, i) => {
                if (r.status === 'rejected') console.error(`[Sonar] PUT ${channels[i]} threw:`, r.reason?.message);
                else if (!r.value?.ok) console.error(`[Sonar] PUT ${channels[i]} failed: HTTP ${r.value?.status}`);
            });
            const anyOk = results.some(r => r.status === 'fulfilled' && r.value?.ok);
            if (anyOk) {
                this._state[context].currentDeviceId = next.id;
                await this.refreshDisplay(context);
            } else {
                $websocket.showAlert(context);
            }
        },
    }),

    // ── Channel volume dial ────────────────────────────────────────────
    volume: new Action({
        default: { channel: 'game', step: 3 },
        _state: {},

        async _willAppear({ context }) {
            this._state[context] = this._state[context] || {};
            await this.refreshDisplay(context);
            this._state[context].timer = setInterval(() => this.refreshDisplay(context), POLL_MS);
        },

        _willDisappear({ context }) {
            clearInterval(this._state[context]?.timer);
            delete this._state[context];
        },

        didReceiveSettings({ context, payload }) {
            this.data[context] = Object.assign({ ...this.default }, payload?.settings || {});
            this.refreshDisplay(context);
        },

        keyUp({ context }) { this.toggleMute(context); },

        dialDown({ context }) { this.toggleMute(context); },

        async dialRotate({ context, payload }) {
            const ticks = payload?.ticks ?? 0;
            if (!ticks) return;

            const settings = this.data[context] || {};
            const channels = this._getChannels(settings);
            const step = (Number(settings.step) || 3) / 100;
            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) return;

            const primaryCh = channels[0];
            const currentVol = this._state[context]?.volume ?? 0.5;
            const currentMuted = this._state[context]?.muted ?? false;
            // Round to 4 decimal places to avoid floating-point noise in the URL
            const newVol = Math.round(Math.min(1, Math.max(0, currentVol + ticks * step)) * 10000) / 10000;

            const results = await Promise.allSettled(channels.map(ch =>
                sonarRequest(`${baseUrl}/volumeSettings/classic/${ch}/Volume/${newVol}`, 'PUT')
            ));
            results.forEach((r, i) => {
                if (r.status === 'rejected') console.error(`[Sonar] PUT volume ${channels[i]} threw:`, r.reason?.message);
                else if (!r.value?.ok) console.error(`[Sonar] PUT volume ${channels[i]} failed: HTTP ${r.value?.status}`);
            });
            if (results.some(r => r.status === 'fulfilled' && r.value?.ok)) {
                this._state[context].volume = newVol;
                const label = this._getLabel(settings);
                sendImage(context, makeVolumeImage(label, Math.round(newVol * 100), currentMuted));
                $websocket.setTitle(context, '');
            }
        },

        async toggleMute(context) {
            const settings = this.data[context] || {};
            const channels = this._getChannels(settings);
            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) return;

            const currentVol = this._state[context]?.volume ?? 0.5;
            const newMuted = !(this._state[context]?.muted ?? false);

            const muteResults = await Promise.allSettled(channels.map(ch =>
                sonarRequest(`${baseUrl}/volumeSettings/classic/${ch}/Mute/${newMuted}`, 'PUT')
            ));
            muteResults.forEach((r, i) => {
                if (r.status === 'rejected') console.error(`[Sonar] PUT mute ${channels[i]} threw:`, r.reason?.message);
                else if (!r.value?.ok) console.error(`[Sonar] PUT mute ${channels[i]} failed: HTTP ${r.value?.status}`);
            });
            if (muteResults.some(r => r.status === 'fulfilled' && r.value?.ok)) {
                this._state[context].muted = newMuted;
                const label = this._getLabel(settings);
                sendImage(context, makeVolumeImage(label, Math.round(currentVol * 100), newMuted));
                $websocket.setTitle(context, '');
            }
        },

        async refreshDisplay(context) {
            const settings = this.data[context] || {};
            const channels = this._getChannels(settings);
            const label = this._getLabel(settings);
            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) {
                tryLaunchSteelSeriesGG();
                sendImage(context, makeVolumeImage(label, 0, false));
                $websocket.setTitle(context, '');
                return;
            }
            try {
                const resp = await sonarRequest(`${baseUrl}/volumeSettings/classic`);
                if (!resp.ok) throw new Error('bad response');
                const data = await resp.json();

                // master lives under data.masters.classic; others under data.devices.{ch}.classic
                const primaryCh = channels[0];
                const ch = primaryCh === 'master'
                    ? data?.masters?.classic
                    : data?.devices?.[primaryCh]?.classic;
                const vol = ch?.volume ?? 0.5;
                const muted = ch?.muted ?? false;

                this._state[context].volume = vol;
                this._state[context].muted = muted;

                sendImage(context, makeVolumeImage(label, Math.round(vol * 100), muted));
                $websocket.setTitle(context, '');
            } catch (e) {
                if (e.message?.includes('ECONNREFUSED') || e.message?.includes('fetch')) {
                    _sonarBaseUrl = null;
                }
                sendImage(context, makeVolumeImage(label, 0, false));
                $websocket.setTitle(context, '');
            }
        },

        // Returns array of channel IDs to control (supports multi-channel)
        _getChannels(settings) {
            if (settings.channels && settings.channels.length > 0) return settings.channels;
            return [settings.channel || 'game'];
        },

        // Label shown on the button — primary channel name or "Multi"
        _getLabel(settings) {
            const channels = this._getChannels(settings);
            if (channels.length === 1) return CHANNEL_LABELS[channels[0]] || channels[0];
            return channels.map(c => CHANNEL_LABELS[c]?.[0] || c[0]).join('+');
        },
    }),
};
