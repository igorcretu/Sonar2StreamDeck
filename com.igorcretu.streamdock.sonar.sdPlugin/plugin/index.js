const POLL_MS = 1000;
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
let _ggLastLaunchTime = 0;

function tryLaunchSteelSeriesGG() {
    const now = Date.now();
    if (now - _ggLastLaunchTime < 30000) return;
    _ggLastLaunchTime = now;
    $websocket.openUrl('file:///C:/Program%20Files/SteelSeries/GG/SteelSeriesGGEZ.exe');
}

async function getSonarBaseUrl() {
    if (_sonarBaseUrl) return _sonarBaseUrl;
    // Hard cap: never block longer than 5 s total
    return Promise.race([_discoverSonarUrl(), new Promise(r => setTimeout(() => r(null), 5000))]);
}

async function _discoverSonarUrl() {
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
        } catch (e) { /* require path not available in renderer */ }
    }

    try {
        const resp = await fetch(`https://${ggAddr}/subApps`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
            const address = (await resp.json())?.subApps?.sonar?.metadata?.webServerAddress;
            if (address) { _sonarBaseUrl = address.replace(/\/$/, ''); return _sonarBaseUrl; }
        }
    } catch (e) { /* GG not running */ }

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

// ── Toast notification helper ──────────────────────────────────────────
// GG's native overlay is only triggered by authenticated WebSocket messages
// from Sonar itself. As a fallback we use Windows toast notifications.
function showToast(title, message) {
    try {
        const { execFile } = require('child_process');
        const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode('${title.replace(/'/g, '')}')) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode('${message.replace(/'/g, '')}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('SteelSeries Sonar')
$notifier.Show($toast)
`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
            { timeout: 5000 }, () => {});
    } catch (e) { /* toast not critical */ }
}

// withOverlay: kept as a no-op wrapper so callers don't need updating.
// The native GG overlay fires internally only for hardware shortcuts;
// toast notifications above handle the user-facing feedback instead.
async function withOverlay(_baseUrl, fn) {
    return fn();
}

// ── Canvas helpers ─────────────────────────────────────────────────────

const BG_SRC = 'icons/blank-bg.jpg';
let _bgImage = null;

function loadBg() {
    if (_bgImage) return Promise.resolve(_bgImage);
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => { _bgImage = img; resolve(img); };
        img.onerror = () => resolve(null);
        img.src = BG_SRC;
    });
}

const CHANNEL_COLORS = {
    master: '#94a3b8',
    game: '#3b82f6',
    chatRender: '#22c55e',
    media: '#a855f7',
    aux: '#f97316',
    chatCapture: '#ec4899',
};

function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

function sendImage(context, dataUrl) {
    $websocket.send(JSON.stringify({
        event: 'setImage', context,
        payload: { target: 0, image: dataUrl }
    }));
}

async function makeDeviceImage(channelKey, channelLabel, deviceName, isOff, iconDataUrl) {
    const canvas = document.createElement('canvas');
    canvas.width = 144; canvas.height = 144;
    const ctx = canvas.getContext('2d');

    const bg = await loadBg();
    if (bg) {
        ctx.drawImage(bg, 0, 0, 144, 144);
    } else {
        ctx.fillStyle = '#0a0e1a';
        ctx.fillRect(0, 0, 144, 144);
    }

    if (isOff) {
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = 'bold 19px sans-serif';
        ctx.fillText('SONAR', 72, 66);
        ctx.fillStyle = '#ef4444';
        ctx.font = '15px sans-serif';
        ctx.fillText('offline', 72, 90);
        return canvas.toDataURL();
    }

    // Custom icons are full-button images – draw at full size.
    // Guessed built-in icons are small glyphs – center them.
    const src = iconDataUrl || guessDeviceIconPath(deviceName);
    await new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            if (iconDataUrl) {
                ctx.drawImage(img, 0, 0, 144, 144);
            } else {
                ctx.drawImage(img, 20, 20, 104, 104);
            }
            resolve();
        };
        img.onerror = resolve;
        img.src = src;
    });

    return canvas.toDataURL();
}

async function makeVolumeImage(channelKey, channelLabel, volumePct, muted) {
    const canvas = document.createElement('canvas');
    canvas.width = 144; canvas.height = 144;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, 144, 144);

    const color = muted ? '#ef4444' : (CHANNEL_COLORS[channelKey] || '#3b82f6');

    // Circular arc dial – 7 o'clock → 5 o'clock clockwise (300°)
    const cx = 72, cy = 88, R = 46;
    const START = 2 * Math.PI / 3;   // 7 o'clock in canvas coords
    const SWEEP = 5 * Math.PI / 3;   // 300°

    // Track
    ctx.beginPath();
    ctx.arc(cx, cy, R, START, START + SWEEP);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Glow + fill
    const fillEnd = START + (Math.min(100, Math.max(0, volumePct)) / 100) * SWEEP;
    const arcEnd = muted ? START + SWEEP : fillEnd;
    if (volumePct > 0 || muted) {
        ctx.beginPath();
        ctx.arc(cx, cy, R, START, arcEnd);
        ctx.strokeStyle = color + '30';
        ctx.lineWidth = 17;
        ctx.lineCap = 'round';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, R, START, arcEnd);
        ctx.strokeStyle = color;
        ctx.lineWidth = 9;
        ctx.lineCap = 'round';
        ctx.stroke();
    }

    // Center text
    ctx.textAlign = 'center';
    if (muted) {
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText('MUTED', cx, cy + 8);
    } else {
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${volumePct >= 100 ? '34' : '40'}px sans-serif`;
        ctx.fillText(`${volumePct}`, cx, cy + 14);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText('%', cx, cy + 30);
    }

    // Channel label pill – top center
    ctx.font = 'bold 19px sans-serif';
    const lbl = channelLabel.toUpperCase();
    const lw = ctx.measureText(lbl).width + 22;
    ctx.fillStyle = color + '50';
    rrect(ctx, 72 - lw / 2, 7, lw, 30, 7);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(lbl, 72, 28);

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

function cleanName(name) {
    const m = name.match(/\((.+)\)$/);
    if (m) name = m[1].trim();
    for (const noise of ['(R)', '(TM)', 'USB Audio Device', 'Digital Audio']) {
        name = name.replace(noise, '').trim();
    }
    name = name.replace(/^\d+-\s*/, '').trim();
    return name;
}

// ── Plugin actions ─────────────────────────────────────────────────────

const $plugin = {
    name: 'sonar',

    // ── Game output device cycler ──────────────────────────────────────
    game: new Action({
        default: { channels: ['game'], excludedDeviceIds: [] },
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
                const resp = await sonarRequest(`${baseUrl}/audioDevices`);
                const devices = await resp.json();
                const outputs = devices
                    .filter(d => d.dataFlow === 'render' && !d.isVad)
                    .map(d => ({ id: d.id, name: cleanName(d.friendlyName) }));
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
                sendImage(context, await makeDeviceImage(primaryCh, label, '', true));
                $websocket.setTitle(context, '');
                return;
            }
            try {
                const [devResp, redirResp] = await Promise.all([
                    sonarRequest(`${baseUrl}/audioDevices`),
                    sonarRequest(`${baseUrl}/classicRedirections`),
                ]);
                if (!devResp.ok || !redirResp.ok) throw new Error('bad response');

                const devices = await devResp.json();
                const redirections = await redirResp.json();
                const realOutputs = devices.filter(d => d.dataFlow === 'render' && !d.isVad);
                const realCaptures = devices.filter(d => d.dataFlow === 'capture' && !d.isVad);
                const currentId = redirections.find(r => r.id === toRedirCh(primaryCh))?.deviceId;
                const currentMicId = redirections.find(r => r.id === 'mic')?.deviceId;

                const excludedIds = settings.excludedDeviceIds || [];
                const cycleOutputs = excludedIds.length
                    ? realOutputs.filter(d => !excludedIds.includes(d.id))
                    : realOutputs;

                this._state[context] = {
                    ...this._state[context],
                    devices: cycleOutputs.length ? cycleOutputs : realOutputs,
                    currentDeviceId: currentId,
                    captureDevices: realCaptures,
                    currentMicDeviceId: currentMicId,
                };

                const iconDataUrl = settings.deviceIcons?.[currentId];
                sendImage(context, await makeDeviceImage(primaryCh, label, '', false, iconDataUrl));
                $websocket.setTitle(context, '');
            } catch (e) {
                _sonarBaseUrl = null; // always re-discover on any failure
                sendImage(context, await makeDeviceImage(primaryCh, label, '', true));
                $websocket.setTitle(context, '');
            }
        },

        async cycleDevice(context) {
            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) { tryLaunchSteelSeriesGG(); return; }

            const settings = this.data[context] || {};
            const channels = settings.channels?.length ? settings.channels : ['game'];
            const primaryCh = channels[0];

            let { devices, currentDeviceId, captureDevices, currentMicDeviceId } = this._state[context] || {};
            if (!devices?.length) { await this.refreshDisplay(context); return; }

            const idx = devices.findIndex(d => d.id === currentDeviceId);
            const next = devices[(idx + 1) % devices.length];

            const puts = channels.map(ch =>
                sonarRequest(`${baseUrl}/classicRedirections/${toRedirCh(ch)}/deviceId/${next.id}`, 'PUT')
            );

            // Also cycle microphone capture device in lockstep
            let nextMic = null;
            if (captureDevices?.length) {
                const micIdx = captureDevices.findIndex(d => d.id === currentMicDeviceId);
                nextMic = captureDevices[(micIdx + 1) % captureDevices.length];
                puts.push(sonarRequest(`${baseUrl}/classicRedirections/mic/deviceId/${nextMic.id}`, 'PUT'));
            }

            const results = await withOverlay(baseUrl, () => Promise.allSettled(puts));
            const anyOk = results.some(r => r.status === 'fulfilled' && r.value?.ok);
            if (anyOk) {
                this._state[context].currentDeviceId = next.id;
                if (nextMic) this._state[context].currentMicDeviceId = nextMic.id;
                const label = settings.label || primaryCh.toUpperCase();
                showToast(label, next.friendlyName + (nextMic ? `\nMic → ${nextMic.friendlyName}` : ''));
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

            const results = await withOverlay(baseUrl, () => Promise.allSettled(channels.map(ch =>
                sonarRequest(`${baseUrl}/volumeSettings/classic/${ch}/Volume/${newVol}`, 'PUT')
            )));
            results.forEach((r, i) => {
                if (r.status === 'rejected') console.error(`[Sonar] PUT volume ${channels[i]} threw:`, r.reason?.message);
                else if (!r.value?.ok) console.error(`[Sonar] PUT volume ${channels[i]} failed: HTTP ${r.value?.status}`);
            });
            if (results.some(r => r.status === 'fulfilled' && r.value?.ok)) {
                this._state[context].volume = newVol;
                const label = this._getLabel(settings);
                sendImage(context, await makeVolumeImage(primaryCh, label, Math.round(newVol * 100), currentMuted));
                $websocket.setTitle(context, '');
            }
        },

        async toggleMute(context) {
            const settings = this.data[context] || {};
            const channels = this._getChannels(settings);
            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) { tryLaunchSteelSeriesGG(); return; }

            const currentVol = this._state[context]?.volume ?? 0.5;
            const newMuted = !(this._state[context]?.muted ?? false);

            const muteResults = await withOverlay(baseUrl, () => Promise.allSettled(channels.map(ch =>
                sonarRequest(`${baseUrl}/volumeSettings/classic/${ch}/Mute/${newMuted}`, 'PUT')
            )));
            muteResults.forEach((r, i) => {
                if (r.status === 'rejected') console.error(`[Sonar] PUT mute ${channels[i]} threw:`, r.reason?.message);
                else if (!r.value?.ok) console.error(`[Sonar] PUT mute ${channels[i]} failed: HTTP ${r.value?.status}`);
            });
            if (muteResults.some(r => r.status === 'fulfilled' && r.value?.ok)) {
                this._state[context].muted = newMuted;
                const label = this._getLabel(settings);
                showToast(label, newMuted ? 'Muted' : `Unmuted — ${Math.round(currentVol * 100)}%`);
                sendImage(context, await makeVolumeImage(channels[0], label, Math.round(currentVol * 100), newMuted));
                $websocket.setTitle(context, '');
            }
        },

        async refreshDisplay(context) {
            const settings = this.data[context] || {};
            const channels = this._getChannels(settings);
            const label = this._getLabel(settings);
            const primaryCh = channels[0];
            const baseUrl = await getSonarBaseUrl();
            if (!baseUrl) {
                sendImage(context, await makeVolumeImage(primaryCh, label, 0, false));
                $websocket.setTitle(context, '');
                return;
            }
            try {
                const resp = await sonarRequest(`${baseUrl}/volumeSettings/classic`);
                if (!resp.ok) throw new Error('bad response');
                const data = await resp.json();

                // master lives under data.masters.classic; others under data.devices.{ch}.classic
                const ch = primaryCh === 'master'
                    ? data?.masters?.classic
                    : data?.devices?.[primaryCh]?.classic;
                const vol = ch?.volume ?? 0.5;
                const muted = ch?.muted ?? false;

                this._state[context].volume = vol;
                this._state[context].muted = muted;

                sendImage(context, await makeVolumeImage(primaryCh, label, Math.round(vol * 100), muted));
                $websocket.setTitle(context, '');
            } catch (e) {
                if (e.message?.includes('ECONNREFUSED') || e.message?.includes('fetch')) {
                    _sonarBaseUrl = null;
                }
                sendImage(context, await makeVolumeImage(primaryCh, label, 0, false));
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
