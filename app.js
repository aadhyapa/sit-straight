// Sit Straight App Logic (Python-Connected WebSocket Client)

// DOM Elements
const video = document.getElementById('webcam');
const canvas = document.getElementById('pose-canvas');
const ctx = canvas.getContext('2d');
const cameraLoading = document.getElementById('camera-loading');

const statusBadge = document.getElementById('status-badge') || { textContent: '', className: '' };
const btnCalibrate = document.getElementById('btn-calibrate');
const btnReset = document.getElementById('btn-reset-calibration');
const calibrationStatus = document.getElementById('calibration-status');
const btnNotifications = document.getElementById('btn-notifications');
const alertOverlay = document.getElementById('slouch-alert-overlay');

const calibrationOverlay = document.getElementById('calibration-overlay');
const countdownText = document.getElementById('countdown-text');

// Offscreen Canvas for Frame Extraction
const offscreenCanvas = document.createElement('canvas');
const offscreenCtx = offscreenCanvas.getContext('2d');
offscreenCanvas.width = 320; // 320x240 is fast to decode and transmit
offscreenCanvas.height = 240;

// Application State
let activeStream = null;
let calibrationData = null;
let isCalibrated = false;
let isWebcamActive = false;
let ws = null;
let shouldCalibrateFrame = false;

let currentScore = 100;
let lastAlertTime = 0;
let slouchStartTime = null;
let isAlertActive = false;

// Notifications
let notificationsEnabled = false;
if (Notification.permission === 'granted') {
  notificationsEnabled = true;
  btnNotifications.textContent = 'Notifications Enabled';
  btnNotifications.classList.remove('btn-secondary');
  btnNotifications.classList.add('btn-primary');
}

btnNotifications.addEventListener('click', async () => {
  if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      notificationsEnabled = true;
      btnNotifications.textContent = 'Notifications Enabled';
      btnNotifications.classList.remove('btn-secondary');
      btnNotifications.classList.add('btn-primary');
      new Notification("Sit Straight", { body: "System notifications are active!" });
    }
  } else if (Notification.permission === 'granted') {
    notificationsEnabled = true;
  }
});

// Load Calibration from LocalStorage on load
const savedCalibration = localStorage.getItem('auraposture_calibration');
if (savedCalibration) {
  try {
    calibrationData = JSON.parse(savedCalibration);
    isCalibrated = true;
    updateCalibrationUI();
  } catch (e) {
    console.error('Failed to parse saved calibration data', e);
  }
}

let audioCtx = null;
let sirenOsc = null;
let sirenGain = null;
let lfo = null;

function startSiren() {
  if (sirenOsc) return; // already playing

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  sirenGain = audioCtx.createGain();
  sirenGain.gain.setValueAtTime(0.2, audioCtx.currentTime);
  sirenGain.connect(audioCtx.destination);

  sirenOsc = audioCtx.createOscillator();
  sirenOsc.type = 'sawtooth';
  sirenOsc.frequency.setValueAtTime(550, audioCtx.currentTime);
  sirenOsc.connect(sirenGain);

  lfo = audioCtx.createOscillator();
  lfo.frequency.value = 2; // oscillations per second

  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 150; // Pitch swing range

  lfo.connect(lfoGain);
  lfoGain.connect(sirenOsc.frequency);

  lfo.start();
  sirenOsc.start();
}

function stopSiren() {
  if (sirenOsc) {
    try {
      sirenOsc.stop();
      lfo.stop();
    } catch (e) { }
    sirenOsc = null;
    lfo = null;
    sirenGain = null;
  }
}

// Auto-resume AudioContext on user click to bypass browser autoplay policies
window.addEventListener('click', () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
});

function updateStatusBadge() {
  if (isAlertActive) {
    statusBadge.textContent = 'ALERT';
    statusBadge.className = 'badge badge-warning';
  } else if (!ws || ws.readyState !== WebSocket.OPEN) {
    statusBadge.textContent = 'Disconnected';
    statusBadge.className = 'badge badge-warning';
  } else if (isCalibrated) {
    statusBadge.textContent = '';
    statusBadge.className = 'badge badge-calibrated';
  } else {
    statusBadge.textContent = 'Ready';
    statusBadge.className = 'badge';
  }
}

// WebSocket Connection Setup
function connectBackend() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  statusBadge.textContent = 'Connecting...';
  statusBadge.className = 'badge';

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("[Sit Straight] WebSocket connected to Python backend");
    // Send stored calibration baseline if we have it
    ws.send(JSON.stringify({
      action: "init",
      calibrationData: calibrationData
    }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // Clear and prepare canvas
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (data.landmarks) {
      drawSkeleton(data.landmarks);
    }

    if (data.status === "initialized") {
      if (data.isCalibrated) {
        isCalibrated = true;
        updateCalibrationUI();
      } else {
        isCalibrated = false;
        statusBadge.textContent = 'Ready';
        statusBadge.className = 'badge';
      }
      updateStatusBadge();
    } else if (data.status === "reset") {
      isCalibrated = false;
      updateStatusBadge();
    } else if (data.status === "no_body") {
      updateScoreDisplay(null);
    } else if (data.status === "partial_body") {
      updateScoreDisplay(null);
      calibrationStatus.textContent = 'Body only partially visible.';
      calibrationStatus.className = 'status-message text-danger';
    } else if (data.status === "calibrated") {
      calibrationData = data.calibrationData;
      localStorage.setItem('auraposture_calibration', JSON.stringify(calibrationData));
      isCalibrated = true;
      updateCalibrationUI();
      updateStatusBadge();
    } else if (data.status === "tracking") {
      updateScoreDisplay(data.score);
    } else if (data.status === "ready_to_calibrate") {
      updateScoreDisplay(null);
    }

    ctx.restore();
  };

  ws.onclose = () => {
    console.log("[Sit Straight] WebSocket disconnected. Retrying in 3 seconds...");
    updateStatusBadge();
    setTimeout(connectBackend, 3000);
  };
}

// Start camera stream
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });

    video.srcObject = stream;
    activeStream = stream;
    isWebcamActive = true;

    video.addEventListener('loadedmetadata', () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      cameraLoading.classList.add('hidden');
      btnCalibrate.disabled = false;

      // Stream camera frames to WebSocket at 12 FPS
      setInterval(streamFrame, 80);
    });
  } catch (error) {
    console.error('Error opening webcam:', error);
    calibrationStatus.textContent = 'Webcam error: Please check browser permissions.';
    calibrationStatus.className = 'status-message text-danger';
  }
}

// Extract frame, compress as JPEG, and send to Python server
function streamFrame() {
  if (!isWebcamActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

  // Render video frame to offscreen canvas
  offscreenCtx.drawImage(video, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

  // Convert to highly-compressed light jpeg data URL
  const dataUrl = offscreenCanvas.toDataURL('image/jpeg', 0.6);

  const actionType = shouldCalibrateFrame ? 'calibrate' : 'frame';
  if (shouldCalibrateFrame) {
    shouldCalibrateFrame = false;
  }

  ws.send(JSON.stringify({
    action: actionType,
    image: dataUrl
  }));
}

// Draw skeleton using coordinates received from server
function drawSkeleton(landmarks) {
  const nose = landmarks["0"];
  const lEar = landmarks["7"];
  const rEar = landmarks["8"];
  const lShoulder = landmarks["11"];
  const rShoulder = landmarks["12"];

  if (!nose || !lEar || !rEar || !lShoulder || !rShoulder) return;

  const points = [nose, lEar, rEar, lShoulder, rShoulder];

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#dc2626'; // solid red lines, no glow

  // Draw shoulders line
  ctx.beginPath();
  ctx.moveTo(lShoulder.x * canvas.width, lShoulder.y * canvas.height);
  ctx.lineTo(rShoulder.x * canvas.width, rShoulder.y * canvas.height);
  ctx.stroke();

  // Draw spine connector
  const midShoulderX = (lShoulder.x + rShoulder.x) / 2;
  const midShoulderY = (lShoulder.y + rShoulder.y) / 2;
  ctx.beginPath();
  ctx.moveTo(midShoulderX * canvas.width, midShoulderY * canvas.height);
  ctx.lineTo(nose.x * canvas.width, nose.y * canvas.height);
  ctx.stroke();

  // Draw face connector
  ctx.beginPath();
  ctx.moveTo(lEar.x * canvas.width, lEar.y * canvas.height);
  ctx.lineTo(nose.x * canvas.width, nose.y * canvas.height);
  ctx.lineTo(rEar.x * canvas.width, rEar.y * canvas.height);
  ctx.stroke();

  // Draw joints (smaller and red, no glow)
  points.forEach((pt) => {
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 3, 0, 2 * Math.PI);
    ctx.fill();
  });
}

// Calibration actions
btnCalibrate.addEventListener('click', () => {
  if (!isWebcamActive) return;

  calibrationOverlay.classList.remove('hidden');
  countdownText.textContent = '3';
  btnCalibrate.disabled = true;

  let countdown = 3;
  const interval = setInterval(() => {
    countdown--;
    if (countdown > 0) {
      countdownText.textContent = countdown.toString();
    } else {
      clearInterval(interval);
      countdownText.textContent = 'Hold still...';
      shouldCalibrateFrame = true;
      setTimeout(() => {
        countdownText.textContent = 'Ready';
        setTimeout(() => {
          calibrationOverlay.classList.add('hidden');
        }, 1000);
      }, 1000);
    }
  }, 1000);
});

btnReset.addEventListener('click', () => {
  calibrationData = null;
  isCalibrated = false;
  shouldCalibrateFrame = false;
  localStorage.removeItem('auraposture_calibration');
  btnReset.disabled = true;
  btnCalibrate.disabled = false;
  calibrationStatus.textContent = 'Calibration reset. Please calibrate again.';
  calibrationStatus.className = 'status-message';

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "reset" }));
  }

  currentScore = 100;
  clearAlert();
});

function updateCalibrationUI() {
  btnCalibrate.disabled = true;
  btnReset.disabled = false;
  calibrationStatus.textContent = '';
  calibrationStatus.className = 'status-message text-success';
  updateStatusBadge();
}

function updateScoreDisplay(score) {
  if (score === null) {
    return;
  }

  currentScore = score;

  // Sensitivity is hardcoded to 10%, meaning slouchThreshold = 90
  const slouchThreshold = 85;

  if (score >= slouchThreshold) {
    clearAlert();
  } else {
    handleSlouchDetected();
  }
}

function handleSlouchDetected() {
  if (!slouchStartTime) {
    slouchStartTime = Date.now();
  }

  // Alert delay is hardcoded to 10 seconds
  const cooldownLimit = 10000;
  const elapsed = Date.now() - slouchStartTime;

  if (elapsed >= cooldownLimit) {
    triggerAlert();
  }
}

function triggerAlert() {
  if (isAlertActive) return;
  isAlertActive = true;

  updateStatusBadge();

  alertOverlay.classList.remove('hidden');

  startSiren();

  if (notificationsEnabled && document.hidden) {
    const now = Date.now();
    if (now - lastAlertTime > 15000) {
      new Notification("Sit Straight", {
        body: "Sit up straight to protect your spine.",
        icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='%23ef4444'/><text x='35' y='65' fill='white' font-size='45' font-weight='bold'>!</text></svg>"
      });
      lastAlertTime = now;
    }
  }
}

function clearAlert() {
  slouchStartTime = null;
  if (!isAlertActive) return;

  isAlertActive = false;
  alertOverlay.classList.add('hidden');

  stopSiren();

  updateStatusBadge();
}

// Initialization
window.addEventListener('DOMContentLoaded', () => {
  connectBackend();
  startCamera();
});
