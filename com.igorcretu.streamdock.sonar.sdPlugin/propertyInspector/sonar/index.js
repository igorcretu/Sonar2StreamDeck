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
        document.getElementById('overlayEnabled').checked = _currentSettings.overlayEnabled !== false;
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

document.getElementById('overlayEnabled').addEventListener('change', e => {
    _currentSettings.overlayEnabled = e.target.checked;
    saveSettings();
});

// ── Device icon list ───────────────────────────────────────────────────

function renderDeviceList(devices) {
    const list = document.getElementById('deviceIconList');
    list.innerHTML = '';
    const icons = _currentSettings.deviceIcons || {};
    const excluded = _currentSettings.excludedDeviceIds || [];

    devices.forEach(dev => {
        const row = document.createElement('div');
        row.className = 'device-row';
        row.classList.toggle('excluded', excluded.includes(dev.id));

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

        const excludeToggle = document.createElement('span');
        excludeToggle.className = 'device-exclude-toggle';
        const setExcludeLabel = () => {
            const isExcluded = (_currentSettings.excludedDeviceIds || []).includes(dev.id);
            row.classList.toggle('excluded', isExcluded);
            excludeToggle.textContent = isExcluded ? 'Excluded' : 'Exclude';
            excludeToggle.classList.toggle('is-excluded', isExcluded);
        };
        setExcludeLabel();
        excludeToggle.addEventListener('click', () => {
            if (!_currentSettings.excludedDeviceIds) _currentSettings.excludedDeviceIds = [];
            const ids = _currentSettings.excludedDeviceIds;
            const idx = ids.indexOf(dev.id);
            if (idx === -1) ids.push(dev.id); else ids.splice(idx, 1);
            setExcludeLabel();
            saveSettings();
        });

        thumb.addEventListener('click', () => fileInput.click());
        changeLabel.addEventListener('click', () => fileInput.click());

        const main = document.createElement('div');
        main.className = 'device-row-main';
        main.appendChild(thumb);
        main.appendChild(name);
        main.appendChild(changeLabel);
        main.appendChild(resetLabel);
        main.appendChild(excludeToggle);
        main.appendChild(fileInput);
        row.appendChild(main);

        // Device type — drives the icon shown on the overlay notification (and the
        // key art, when no custom icon is set). "Auto" falls back to a name-based guess.
        const typeRow = document.createElement('div');
        typeRow.className = 'device-type-row';
        const typeLabel = document.createElement('label');
        typeLabel.textContent = 'Type:';
        const typeSelect = document.createElement('select');
        typeSelect.className = 'device-type-select';
        [['', 'Auto'], ['headphones', 'Headphones'], ['speaker', 'Speaker'], ['laptop', 'Laptop'], ['display', 'Display']]
            .forEach(([value, text]) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = text;
                typeSelect.appendChild(opt);
            });
        typeSelect.value = (_currentSettings.deviceTypes || {})[dev.id] || '';
        typeSelect.addEventListener('change', () => {
            if (!_currentSettings.deviceTypes) _currentSettings.deviceTypes = {};
            if (typeSelect.value) _currentSettings.deviceTypes[dev.id] = typeSelect.value;
            else delete _currentSettings.deviceTypes[dev.id];
            saveSettings();
        });
        typeRow.appendChild(typeLabel);
        typeRow.appendChild(typeSelect);
        row.appendChild(typeRow);

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
