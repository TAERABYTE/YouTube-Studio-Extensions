# 🎛️ YouTube-Studio-Extensions

> **YouTube Studio** : tool for music producer 🎧

Hear YouTube the way the track was actually mastered. A lightweight browser extension that bypasses YouTube's loudness normalization and shows the real loudness of every video, so you can use YouTube as an honest **reference track** for your mixes.

<!-- ![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Chrome](https://img.shields.io/badge/Chrome-111%2B-4285F4?logo=googlechrome&logoColor=white)
![Firefox](https://img.shields.io/badge/Firefox-128%2B-FF7139?logo=firefoxbrowser&logoColor=white)
![No dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) -->

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔊 | **Normalization bypass** | Plays the video at your slider volume instead of YouTube's turned-down level |
| 📈 | **dB restored** | Shows how many dB YouTube was cutting (e.g. `+7.9`) right in the player |
| 📏 | **LUFS readout** | Displays the estimated integrated loudness of the video (e.g. `-6.1 LUFS`) |
| 🔁 | **One-click toggle** | Switch normalization on/off instantly for A/B comparison |
| 💾 | **Remembers your choice** | Your on/off setting persists across videos and sessions |
| 🪶 | **Zero dependencies** | Pure vanilla JS, no tracking, no network requests |

Works on 🎬 **YouTube**, 📱 **m.youtube.com**, 🎵 **YouTube Music** and 🧩 **embedded players**.

---

## 🚀 Installation

### 🟦 Chrome / Edge / Brave

1. 📥 Download or clone this repository
2. 🌐 Open `chrome://extensions`
3. 🛠️ Turn on **Developer mode** (top right)
4. 📂 Click **Load unpacked** and select the project folder

### 🦊 Firefox

1. 📥 Download or clone this repository
2. 🌐 Open `about:debugging#/runtime/this-firefox`
3. 📂 Click **Load Temporary Add-on…** and select `manifest.json`

---

## 🎚️ Usage

Open any video and look for the new button on the **left side of the player's right-hand controls**.

| Button | Meaning |
|---|---|
| `+7.9` | ✅ Normalization **off**: 7.9 dB of loudness restored |
| `+–` | ✅ Normalization **off**: waiting for volume data |
| ~~`dB`~~ | ⛔ Normalization **on**: YouTube's default behavior |

🖱️ **Click** the button to toggle.
👆 **Hover** over it to see the full details, including the video's LUFS.

> 💡 **Tip:** Compare your own master against a reference with normalization off, then toggle it back on to hear how YouTube will actually play your track.

---

## 🧠 How it works

YouTube measures each video's loudness and lowers `HTMLMediaElement.volume` for anything louder than its target of **−14 LUFS**.

This extension:

1. 🎯 Intercepts the `volume` setter and applies your slider value instead
2. 🧮 Calculates the restored gain: `20 × log10(slider / normalized)`
3. 📊 Reads the video's `loudnessDb` from the player and converts it: `−14 + loudnessDb = LUFS`

> ⚠️ YouTube only turns loud videos **down**, never quiet ones up. Videos quieter than −14 LUFS show `+0.0` dB, but their LUFS value is still displayed.

---

## 📁 Project structure

```
YouTube-Studio-Extensions/
├── 📄 manifest.json   # Extension config (Manifest V3)
├── ⚙️ inject.js       # Volume interception + player button
├── 🎨 styles.css      # Button styling
└── 🖼️ icons/
    └── icon-128.png   # Extension logo
```

---

## 🗺️ Roadmap

- [x] 🔊 Loudness normalization bypass
- [x] 📈 Restored gain (dB) display
- [x] 📏 LUFS readout
- [ ] 🎛️ Real-time EQ / frequency graph
- [ ] 🌈 Spectrum analyzer
- [ ] 📊 Live loudness meter (Momentary / Short-term LUFS)
- [ ] 🎚️ True Peak & dynamic range (PLR)
- [ ] 🔀 Stereo field / correlation meter
- [ ] ⚙️ Settings popup

💬 Have an idea? Feel free to open an issue!

---