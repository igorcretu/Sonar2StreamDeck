# Sonar Controls for StreamDock

A [StreamDock](https://www.hotspottek.com/) plugin that integrates with [SteelSeries Sonar](https://steelseries.com/gg/sonar) to control audio output devices and channel volumes directly from your dock.

---

## Actions

### 🔊 Game Device Cycler

Press the button to cycle through your audio output devices across one or more Sonar channels simultaneously.

- Cycles all available render devices in order
- Works across any combination of channels: **Game**, **Chat**, **Media**, **Aux**
- Displays an auto-detected icon based on device type:
  - 🎧 Headsets (Arctis, Nova, SteelSeries, etc.)
  - 💻 Integrated / laptop speakers (Realtek, built-in)
  - 🖥️ HDMI / DisplayPort / monitor outputs
  - 🔊 Everything else (external speakers, etc.)
- Upload a **custom icon** per device via the property inspector

### 🎚️ Volume Knob

Rotate the dial to adjust volume, press to mute/unmute.

- Works on any StreamDock dial/knob
- Also works as a regular button (press = toggle mute)
- Configurable step size (1–10%)
- Supports multiple channels at once — rotate one knob to control Game + Chat together
- Displays current volume as a percentage with a live bar, turns red when muted

---

## Requirements

- [SteelSeries GG](https://steelseries.com/gg) with **Sonar** enabled and running
- [HotSpot StreamDock](https://www.hotspottek.com/) software

---

## Installation

1. Download or clone this repo
2. Copy the `com.igorcretu.streamdock.sonar.sdPlugin` folder to your StreamDock plugins directory:
   ```
   %APPDATA%\HotSpot\StreamDock\plugins\
   ```
3. Restart StreamDock
4. The **Sonar** category will appear in the action list

---

## Configuration

### Game Device Cycler

Open the property inspector for the button:

- **Channels** — toggle which Sonar channels get switched when you press the button (Game, Chat, Media, Aux). All active channels are switched to the same device.
- **Device Icons** — click a device thumbnail (or the `+ Icon` label) to upload a custom image for that device. Click the red **✕** to revert to the auto-detected icon.

### Volume Knob

- **Channels** — select which channels the knob controls. Select multiple to control them in sync.
- **Step** — how many percent each tick of the dial changes the volume (default: 3%).

---

## How it works

The plugin communicates with Sonar's local HTTP API (discovered via SteelSeries GG's `coreProps.json`). All requests are made using Node.js's `http` module directly to avoid browser CORS restrictions on `PUT` requests.

---

## License

MIT
