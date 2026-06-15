# Sit Straight

Real-time posture monitor that uses your webcam and on-device pose detection to alert you when you start to slouch.

## How it works

1. A Python backend runs a local web server and processes video frames using [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
2. Your browser streams compressed frames over WebSocket at ~12 FPS
3. The backend detects key landmarks (nose, ears, shoulders) and computes a posture score
4. If your score drops below the threshold for 10 seconds, an alert fires — a red border vignette, a siren, and (optionally) a desktop notification

Everything runs locally. No video ever leaves your machine.

## Requirements

- Python 3.9+
- A webcam
- macOS / Linux / Windows

## Setup

```bash
# Clone the repo
git clone https://github.com/yourname/sit-straight.git
cd sit-straight

# Install dependencies
pip install -r requirements.txt

# Download the MediaPipe pose model
curl -L -o pose_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
```

> The model file (`pose_landmarker.task`) is ~9 MB and must live in the project root alongside `app.py`.

## Running

```bash
python3 app.py
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

## Usage

1. **Allow camera access** when the browser prompts
2. **Calibrate** — sit up straight, click **Calibrate Baseline**, and hold still through the 3-second countdown. This records your ideal shoulder height and head position.
3. **Sit normally** — the app now tracks your posture in real time
4. **Reset** — click **Reset** to clear the calibration and start over
5. **Notifications** — click **Enable Notifications** to get alerts even when the tab is in the background

## Posture Score

The score (0–100) is computed from two metrics each frame:

| Metric | Weight | What it measures |
|--------|--------|-----------------|
| Head drop ratio | 70% | How much your head has dropped toward your shoulders vs. calibration |
| Vertical sinking ratio | 30% | How much your whole body has sunk down in frame vs. calibration |

A score below **90** sustained for **10 seconds** triggers an alert.

## Project Structure

```
sit-straight/
├── app.py                  # FastAPI backend + WebSocket + pose analysis
├── requirements.txt
├── pose_landmarker.task    # MediaPipe model (download separately)
└── static/
    ├── index.html
    ├── style.css
    └── app.js              # WebSocket client, camera, audio alert
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `fastapi` | Web framework + WebSocket server |
| `uvicorn[standard]` | ASGI server |
| `mediapipe` | On-device pose landmark detection |
| `opencv-python` | Image decoding (BGR→RGB conversion) |