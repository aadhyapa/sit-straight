import base64
import json
import logging
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import os

# --- Constants ---
APP_NAME = "SitStraight"
VISIBILITY_THRESHOLD = 0.5
HEAD_WEIGHT = 0.7
SINKING_WEIGHT = 0.3

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(APP_NAME)

app = FastAPI()

# Initialize MediaPipe Pose Landmarker globally
logger.info("Initializing MediaPipe Pose Landmarker...")
model_path = os.path.join(os.path.dirname(__file__), "pose_landmarker.task")
if not os.path.exists(model_path):
    raise FileNotFoundError(f"Model file not found at {model_path}. Please make sure it is downloaded.")

base_options = python.BaseOptions(model_asset_path=model_path)
options = vision.PoseLandmarkerOptions(
    base_options=base_options,
    running_mode=vision.RunningMode.IMAGE
)
detector = vision.PoseLandmarker.create_from_options(options)
logger.info("MediaPipe Pose Landmarker successfully initialized!")



@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected via WebSocket")

    calibration_data = None

    try:
        while True:
            # Receive text data (JSON format)
            message = await websocket.receive_text()
            data = json.loads(message)

            action = data.get("action")

            # If initializing/synchronizing calibration data from client localStorage
            if action == "init":
                cal_payload = data.get("calibrationData")
                if cal_payload:
                    calibration_data = cal_payload
                    logger.info(f"Loaded existing calibration baseline: {calibration_data}")
                await websocket.send_json({"status": "initialized", "isCalibrated": calibration_data is not None})
                continue

            # If resetting calibration
            if action == "reset":
                calibration_data = None
                logger.info("Calibration reset by client")
                await websocket.send_json({"status": "reset"})
                continue

            # Process frames
            if action == "frame" or action == "calibrate":
                image_data = data.get("image")
                if not image_data:
                    continue

                # Decode base64 image
                try:
                    # Strip base64 metadata header if present
                    if "," in image_data:
                        image_data = image_data.split(",")[1]

                    decoded_bytes = base64.b64decode(image_data)
                    nparr = np.frombuffer(decoded_bytes, np.uint8)
                    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                    if frame is None:
                        await websocket.send_json({"status": "error", "message": "Failed to decode frame"})
                        continue
                except Exception as e:
                    logger.error(f"Image decode error: {e}")
                    await websocket.send_json({"status": "error", "message": "Decode failure"})
                    continue

                # Convert BGR to RGB
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                # Convert to MediaPipe Image format
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)

                # Run posture analysis
                detection_result = detector.detect(mp_image)

                if not detection_result.pose_landmarks:
                    await websocket.send_json({"status": "no_body"})
                    continue

                landmarks = detection_result.pose_landmarks[0]

                # Key joints (MediaPipe indices: Nose=0, LEar=7, REar=8, LShoulder=11, RShoulder=12)
                nose = landmarks[0]
                l_ear = landmarks[7]
                r_ear = landmarks[8]
                l_shoulder = landmarks[11]
                r_shoulder = landmarks[12]

                # Filter out low visibility detections
                required_joints = [nose, l_ear, r_ear, l_shoulder, r_shoulder]
                all_visible = all(joint.visibility > VISIBILITY_THRESHOLD for joint in required_joints)

                # Prepare coordinates to return to client for custom SVG skeleton drawing
                landmarks_dict = {
                    "0":  {"x": nose.x,       "y": nose.y,       "visibility": float(nose.visibility)},
                    "7":  {"x": l_ear.x,      "y": l_ear.y,      "visibility": float(l_ear.visibility)},
                    "8":  {"x": r_ear.x,      "y": r_ear.y,      "visibility": float(r_ear.visibility)},
                    "11": {"x": l_shoulder.x, "y": l_shoulder.y, "visibility": float(l_shoulder.visibility)},
                    "12": {"x": r_shoulder.x, "y": r_shoulder.y, "visibility": float(r_shoulder.visibility)},
                }

                if not all_visible:
                    await websocket.send_json({
                        "status": "partial_body",
                        "landmarks": landmarks_dict
                    })
                    continue

                # If the action is calibrate
                if action == "calibrate":
                    shoulder_y = (l_shoulder.y + r_shoulder.y) / 2.0
                    head_offset = shoulder_y - nose.y
                    shoulder_distance = abs(l_shoulder.x - r_shoulder.x)

                    calibration_data = {
                        "shoulderY": shoulder_y,
                        "headOffset": head_offset,
                        "shoulderDistance": shoulder_distance
                    }

                    logger.info(f"New calibration captured: {calibration_data}")
                    await websocket.send_json({
                        "status": "calibrated",
                        "calibrationData": calibration_data,
                        "landmarks": landmarks_dict
                    })
                    continue

                # Normal frame processing — calculate posture score if calibrated
                if calibration_data:
                    live_shoulder_y = (l_shoulder.y + r_shoulder.y) / 2.0
                    live_head_offset = live_shoulder_y - nose.y

                    # 1. Head Drop metric
                    head_ratio = live_head_offset / calibration_data["headOffset"] if calibration_data["headOffset"] != 0 else 1.0
                    # 2. Vertical Sinking metric
                    vertical_sinking_ratio = calibration_data["shoulderY"] / live_shoulder_y if live_shoulder_y != 0 else 1.0

                    raw_score = (head_ratio * HEAD_WEIGHT + vertical_sinking_ratio * SINKING_WEIGHT) * 100
                    score = max(0, min(100, int(raw_score)))

                    await websocket.send_json({
                        "status": "tracking",
                        "score": score,
                        "landmarks": landmarks_dict
                    })
                else:
                    await websocket.send_json({
                        "status": "ready_to_calibrate",
                        "landmarks": landmarks_dict
                    })

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")

# Mount static files LAST — the "/" catch-all must come after all other routes
# so it doesn't intercept WebSocket upgrades.
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
