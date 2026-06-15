const APP_NAME = "Sit Straight";
const STORAGE_KEY = "sitstraight_calibration";
const FRAME_INTERVAL_MS = 80;
const JPEG_QUALITY = 0.6;
const SLOUCH_THRESHOLD = 90;
const ALERT_DELAY_MS = 10000;
const NOTIFICATION_COOLDOWN_MS = 15000;
const WS_RECONNECT_DELAY_MS = 3000;

const video = document.getElementById('webcam');
const canvas = document.getElementById('pose-canvas');
const ctx = canvas.getContext('2d');
const cameraLoading = document.getElementById('camera-loading');
const btnCalibrate = document.getElementById('btn-calibrate');
const btnReset = document.getElementById('btn-reset-calibration');
const btnNotifications = document.getElementById('btn-notifications');
const alertOverlay = document.getElementById('slouch-alert-overlay');
const calibrationOverlay = document.getElementById('calibration-overlay');
const countdownText = document.getElementById('countdown-text');
const statusBadge = document.getElementById('status-badge');
const scoreDisplay = document.getElementById('score-display');

const offscreenCanvas = document.createElement('canvas');
const offscreenCtx = offscreenCanvas.getContext('2d');
offscreenCanvas.width = 320;
offscreenCanvas.height = 240;

let calibrationData = null;
let isCalibrated = false;
let isWebcamActive = false;
let ws = null;
let shouldCalibrateFrame = false;
let frameIntervalId = null;

let currentScore = 100;
let lastAlertTime = 0;
let slouchStartTime = null;
let isAlertActive = false;

let notificationsEnabled = false;
if (Notification.permission === 'granted') {
  notificationsEnabled = true;
  btnNotifications.textContent = 'Notifications Enabled';
  btnNotifications.classList.remove('btn-secondary');
  btnNotifications.classList.add('btn-primary');
}

function setStatus(label, variant = 'default') {
  statusBadge.textContent = label;
  statusBadge.classList.remove('badge-calibrated', 'badge-warning');

  if (variant === 'calibrated') {
    statusBadge.classList.add('badge-calibrated');
  } else if (variant === 'warning') {
    statusBadge.classList.add('badge-warning');
  }
}

function renderScore(score) {
  scoreDisplay.textContent = score === null ? 'Score --' : `Score ${score}`;
}

btnNotifications.addEventListener('click', async () => {
  if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      notificationsEnabled = true;
      btnNotifications.textContent = 'Notifications Enabled';
      btnNotifications.classList.remove('btn-secondary');
      btnNotifications.classList.add('btn-primary');
      new Notification(APP_NAME, { body: "System notifications are active!" });
    }
  } else if (Notification.permission === 'granted') {
    notificationsEnabled = true;
  }
});

const savedCalibration = localStorage.getItem(STORAGE_KEY);
if (savedCalibration) {
  try {
    calibrationData = JSON.parse(savedCalibration);
    isCalibrated = true;
    updateCalibrationUI();
    setStatus('Calibrated', 'calibrated');
  } catch (e) {
    console.error('Failed to parse saved calibration data', e);
  }
}

let audioCtx = null;
let sirenOsc = null;
let sirenGain = null;
let lfo = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

window.addEventListener('click', () => getAudioContext());

function startSiren() {
  if (sirenOsc) return;

  const ctx = getAudioContext();

  sirenGain = ctx.createGain();
  sirenGain.gain.setValueAtTime(0.2, ctx.currentTime);
  sirenGain.connect(ctx.destination);

  sirenOsc = ctx.createOscillator();
  sirenOsc.type = 'sawtooth';
  sirenOsc.frequency.setValueAtTime(550, ctx.currentTime);
  sirenOsc.connect(sirenGain);

  lfo = ctx.createOscillator();
  lfo.frequency.value = 2;

  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 150;

  lfo.connect(lfoGain);
  lfoGain.connect(sirenOsc.frequency);

  lfo.start();
  sirenOsc.start();
}

function stopSiren() {
  if (sirenOsc) {
    try {
      sirenOsc.stop();
      sirenOsc.disconnect();
      lfo.stop();
      lfo.disconnect();
      sirenGain.disconnect();
    } catch (e) { }
    sirenOsc = null;
    lfo = null;
    sirenGain = null;
  }
}

// --- WebSocket Connection ---
function connectBackend() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log(`[${APP_NAME}] WebSocket connected`);
    setStatus('Connected');
    ws.send(JSON.stringify({
      action: "init",
      calibrationData: calibrationData
    }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (data.landmarks) {
      drawSkeleton(data.landmarks);
    }

    if (data.status === "initialized") {
      if (data.isCalibrated) {
        isCalibrated = true;
        updateCalibrationUI();
        setStatus('Calibrated', 'calibrated');
      } else {
        isCalibrated = false;
        setStatus('Ready');
      }
    } else if (data.status === "reset") {
      isCalibrated = false;
      setStatus('Ready');
      renderScore(null);
    } else if (data.status === "no_body") {
      setStatus('No body', 'warning');
      updateScore(null);
      if (isWebcamActive) btnCalibrate.disabled = false;
    } else if (data.status === "partial_body") {
      setStatus('Partial body', 'warning');
      if (isWebcamActive) btnCalibrate.disabled = false;
    } else if (data.status === "calibrated") {
      calibrationData = data.calibrationData;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(calibrationData));
      isCalibrated = true;
      updateCalibrationUI();
      setStatus('Calibrated', 'calibrated');
    } else if (data.status === "tracking") {
      updateScore(data.score);
    } else if (data.status === "ready_to_calibrate") {
      setStatus('Ready');
      updateScore(null);
    }

    ctx.restore();
  };

  ws.onclose = () => {
    console.log(`[${APP_NAME}] WebSocket disconnected. Retrying in ${WS_RECONNECT_DELAY_MS / 1000}s...`);
    ws = null;
    setStatus('Disconnected', 'warning');
    setTimeout(connectBackend, WS_RECONNECT_DELAY_MS);
  };
}

// --- Camera ---
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });

    video.srcObject = stream;
    isWebcamActive = true;
    setStatus('Camera ready');

    video.addEventListener('loadedmetadata', () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      cameraLoading.classList.add('hidden');
      btnCalibrate.disabled = false;

      if (!frameIntervalId) {
        frameIntervalId = setInterval(streamFrame, FRAME_INTERVAL_MS);
      }
    });
  } catch (error) {
    console.error('Error opening webcam:', error);
  }
}

// --- Frame Streaming ---
function streamFrame() {
  if (!isWebcamActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

  offscreenCtx.drawImage(video, 0, 0, offscreenCanvas.width, offscreenCanvas.height);
  const dataUrl = offscreenCanvas.toDataURL('image/jpeg', JPEG_QUALITY);

  const actionType = shouldCalibrateFrame ? 'calibrate' : 'frame';
  if (shouldCalibrateFrame) {
    shouldCalibrateFrame = false;
  }

  ws.send(JSON.stringify({
    action: actionType,
    image: dataUrl
  }));
}

// --- Skeleton Drawing ---
function drawSkeleton(landmarks) {
  const nose = landmarks["0"];
  const lEar = landmarks["7"];
  const rEar = landmarks["8"];
  const lShoulder = landmarks["11"];
  const rShoulder = landmarks["12"];

  if (!nose || !lEar || !rEar || !lShoulder || !rShoulder) return;

  const points = [nose, lEar, rEar, lShoulder, rShoulder];

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#dc2626';

  // Shoulders line
  ctx.beginPath();
  ctx.moveTo(lShoulder.x * canvas.width, lShoulder.y * canvas.height);
  ctx.lineTo(rShoulder.x * canvas.width, rShoulder.y * canvas.height);
  ctx.stroke();

  // Spine connector
  const midShoulderX = (lShoulder.x + rShoulder.x) / 2;
  const midShoulderY = (lShoulder.y + rShoulder.y) / 2;
  ctx.beginPath();
  ctx.moveTo(midShoulderX * canvas.width, midShoulderY * canvas.height);
  ctx.lineTo(nose.x * canvas.width, nose.y * canvas.height);
  ctx.stroke();

  // Face connector
  ctx.beginPath();
  ctx.moveTo(lEar.x * canvas.width, lEar.y * canvas.height);
  ctx.lineTo(nose.x * canvas.width, nose.y * canvas.height);
  ctx.lineTo(rEar.x * canvas.width, rEar.y * canvas.height);
  ctx.stroke();

  // Joints
  points.forEach((pt) => {
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 3, 0, 2 * Math.PI);
    ctx.fill();
  });
}

// --- Calibration ---
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
  localStorage.removeItem(STORAGE_KEY);
  btnReset.disabled = true;
  btnCalibrate.disabled = false;


  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "reset" }));
  }

  currentScore = 100;
  renderScore(null);
  setStatus('Ready');
  clearAlert();
});

function updateCalibrationUI() {
  btnCalibrate.disabled = true;
  btnReset.disabled = false;
}


// --- Score & Alert ---
function updateScore(score) {
  if (score === null) {
    renderScore(null);
    return;
  }

  currentScore = score;
  renderScore(currentScore);

  if (currentScore >= SLOUCH_THRESHOLD) {
    setStatus('Good', 'calibrated');
    clearAlert();
  } else {
    setStatus('Slouching', 'warning');
    handleSlouchDetected();
  }
}

function handleSlouchDetected() {
  if (!slouchStartTime) {
    slouchStartTime = Date.now();
  }

  const elapsed = Date.now() - slouchStartTime;

  if (elapsed >= ALERT_DELAY_MS) {
    triggerAlert();
  }
}

function triggerAlert() {
  if (isAlertActive) return;
  isAlertActive = true;

  alertOverlay.classList.remove('hidden');
  startSiren();

  if (notificationsEnabled && document.hidden) {
    const now = Date.now();
    if (now - lastAlertTime > NOTIFICATION_COOLDOWN_MS) {
      new Notification(APP_NAME, {
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
}

// --- Initialization ---
window.addEventListener('DOMContentLoaded', () => {
  connectBackend();
  startCamera();
});
