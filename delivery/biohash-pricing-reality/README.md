# biohash-oracle-lab — pricing-reality cinematic mode

Drop-in delivery package for `/Users/conradlitchfield/biohash-oracle-lab/`.

## Install

Download `delivery/biohash-pricing-reality.zip` from this branch, then:

```
cd /Users/conradlitchfield/biohash-oracle-lab
unzip -o ~/Downloads/biohash-pricing-reality.zip
```

That writes:
- `src/camera/camera.js` (NEW)
- `src/scenes/pricing-reality-scenes.js` (NEW)
- `src/modes/pricing-reality.js` (NEW)
- `src/main.js` (REPLACED — only delta is a 5-line `?mode=pricing-reality` dispatch block; default mode is byte-identical)

The existing files are **not** touched:
- `index.html`
- `src/style.js`, `src/animation.js`, `src/render-frame.js`, `src/data-loader.js`
- `src/panels/panel-cycle-stream.js`, `src/panels/panel-cross-peptide.js`
- `data/oracle-snapshot.json`

## Run

```
python3 -m http.server 8000
# default mode (unchanged):
open http://localhost:8000/
# cinematic narrative video (40s):
open http://localhost:8000/?mode=pricing-reality
# seek + freeze (for screenshotting):
open "http://localhost:8000/?mode=pricing-reality&t=24&paused=1"
```

## Controls

| Key   | Action          |
|-------|-----------------|
| Space | Pause / resume  |
| R     | Restart         |
| ←/→   | Scrub ±1s       |
| 0     | Seek to start   |
