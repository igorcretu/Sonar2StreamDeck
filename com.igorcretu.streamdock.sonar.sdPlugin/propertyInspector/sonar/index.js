const $local = false, $back = false,
    $dom = { main: $('.sdpi-wrapper') };

function guessDeviceEmoji(name) {
    const n = (name || '').toLowerCase();
    if (/headset|headphone|arctis|nova|steelseries/.test(n)) return '🎧';
    if (/realtek|integrated|built.?in|laptop/.test(n)) return '💻';
    if (/hdmi|displayport|monitor/.test(n)) return '🖥️';
    return '🔊';
}

let _currentSettings = {};

const $propEvent = {
    // action.js passes data.payload here
    didReceiveSettings(data) {
        _currentSettings = data?.settings || {};
        restoreChannels(_currentSettings);
        // Request device list from plugin (socket is open at this point)
        $websocket.sendToPlugin({ event: 'getDevices' });
    },
    sendToPropertyInspector(data) {
        if (data?.devices) {
            document.getElementById('loadingMsg').style.display = 'none';
            renderDeviceList(data.devices);
        }
    },
    didReceiveGlobalSettings(data) {},
};

// ── Channel toggle buttons ─────────────────────────────────────────────

function restoreChannels(s) {
    const channels = s.channels || ['game'];
    document.querySelectorAll('.ch-btn').forEach(btn => {
        btn.classList.toggle('active', channels.includes(btn.dataset.ch));
    });
}

document.querySelectorAll('.ch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        saveSettings();
    });
});

// ── Device icon list ───────────────────────────────────────────────────

function renderDeviceList(devices) {
    const list = document.getElementById('deviceIconList');
    list.innerHTML = '';
    const icons = _currentSettings.deviceIcons || {};

    devices.forEach(dev => {
        const row = document.createElement('div');
        row.className = 'device-row';

        const thumb = document.createElement('div');
        thumb.className = 'device-thumb';
        thumb.title = 'Click to change icon';

        if (icons[dev.id]) {
            const img = document.createElement('img');
            img.src = icons[dev.id];
            thumb.appendChild(img);
        } else {
            const ph = document.createElement('span');
            ph.className = 'placeholder';
            ph.textContent = guessDeviceEmoji(dev.name);
            thumb.appendChild(ph);
        }

        const name = document.createElement('span');
        name.className = 'device-name';
        name.textContent = dev.name;

        const changeLabel = document.createElement('span');
        changeLabel.className = 'device-change';
        changeLabel.textContent = icons[dev.id] ? 'Change' : '+ Icon';

        const resetLabel = document.createElement('span');
        resetLabel.className = 'device-change';
        resetLabel.style.color = '#f87171';
        resetLabel.style.display = icons[dev.id] ? 'inline' : 'none';
        resetLabel.textContent = '✕';
        resetLabel.title = 'Reset to default icon';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';

        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = e => {
                const dataUrl = e.target.result;
                if (!_currentSettings.deviceIcons) _currentSettings.deviceIcons = {};
                _currentSettings.deviceIcons[dev.id] = dataUrl;
                thumb.innerHTML = '';
                const img = document.createElement('img');
                img.src = dataUrl;
                thumb.appendChild(img);
                changeLabel.textContent = 'Change';
                resetLabel.style.display = 'inline';
                saveSettings();
            };
            reader.readAsDataURL(file);
        });

        resetLabel.addEventListener('click', () => {
            if (_currentSettings.deviceIcons) delete _currentSettings.deviceIcons[dev.id];
            thumb.innerHTML = '';
            const ph = document.createElement('span');
            ph.className = 'placeholder';
            ph.textContent = guessDeviceEmoji(dev.name);
            thumb.appendChild(ph);
            changeLabel.textContent = '+ Icon';
            resetLabel.style.display = 'none';
            saveSettings();
        });

        thumb.addEventListener('click', () => fileInput.click());
        changeLabel.addEventListener('click', () => fileInput.click());

        row.appendChild(thumb);
        row.appendChild(name);
        row.appendChild(changeLabel);
        row.appendChild(resetLabel);
        row.appendChild(fileInput);
        list.appendChild(row);
    });
}

// ── Save ───────────────────────────────────────────────────────────────

function saveSettings() {
    const channels = [];
    document.querySelectorAll('.ch-btn.active').forEach(btn => channels.push(btn.dataset.ch));
    if (channels.length === 0) channels.push('game');
    $websocket.saveData({
        ..._currentSettings,
        channels,
        channel: channels[0],
    });
}
