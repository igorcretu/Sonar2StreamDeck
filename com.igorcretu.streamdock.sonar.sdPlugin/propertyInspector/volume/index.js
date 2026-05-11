const $local = false, $back = false,
    $dom = { main: $('.sdpi-wrapper') },
    $propEvent = {
        // action.js calls this with data.payload, so 'data' here IS payload
        didReceiveSettings(data) {
            const s = data?.settings || {};
            const channels = s.channels || (s.channel ? [s.channel] : ['game']);
            document.querySelectorAll('.ch-btn').forEach(btn => {
                btn.classList.toggle('active', channels.includes(btn.dataset.ch));
            });
            if (s.step != null) document.getElementById('step').value = s.step;
        },
        sendToPropertyInspector(data) {},
        didReceiveGlobalSettings(data) {},
    };

function saveSettings() {
    const channels = [];
    document.querySelectorAll('.ch-btn.active').forEach(btn => channels.push(btn.dataset.ch));
    if (channels.length === 0) channels.push('game');
    $websocket.saveData({
        channels,
        channel: channels[0],
        step: Number(document.getElementById('step').value) || 3,
    });
}

document.querySelectorAll('.ch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        saveSettings();
    });
});
document.getElementById('step').addEventListener('change', saveSettings);
