const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const $ = (sel) => document.querySelector(sel);

const lobby = $('#lobby');
const callScreen = $('#call');
const roomInput = $('#room-input');
const joinBtn = $('#join-btn');
const createBtn = $('#create-btn');
const roomLinkBox = $('#room-link-box');
const roomLink = $('#room-link');
const copyBtn = $('#copy-btn');
const localVideo = $('#local-video');
const remoteVideo = $('#remote-video');
const videoContainer = $('#video-container');
const drawCanvas = $('#draw-canvas');
const drawCtx = drawCanvas.getContext('2d');
const waiting = $('#waiting');
const remotePip = $('#remote-pip');
const displayRoom = $('#display-room');
const callStatus = $('#call-status');
const toggleMic = $('#toggle-mic');
const toggleCam = $('#toggle-cam');
const flipCam = $('#flip-cam');
const shareScreen = $('#share-screen');
const endCall = $('#end-call');
const drawToolbar = $('#draw-toolbar');
const drawToggle = $('#draw-toggle');
const drawColor = $('#draw-color');
const drawSize = $('#draw-size');
const drawClear = $('#draw-clear');
const screenBadge = $('#screen-badge');

let ws = null;
let pc = null;
let localStream = null;
let cameraStream = null;
let screenStream = null;
let cameraVideoTrack = null;
let roomId = null;
let isInitiator = false;
let micEnabled = true;
let camEnabled = true;
let facingMode = 'user';
let isScreenSharing = false;
let remoteScreenSharing = false;
let isDrawing = false;
let drawEnabled = true;
let remoteStream = null;
let remoteConnected = false;
let pendingCandidates = [];
let lastDrawPoint = null;
let makingOffer = false;
let ignoreOffer = false;

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomFromUrl() {
  return new URLSearchParams(window.location.search).get('room');
}

function showScreen(screen) {
  lobby.classList.remove('active');
  callScreen.classList.remove('active');
  screen.classList.add('active');
}

function sendSignal(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function resizeCanvas() {
  const rect = videoContainer.getBoundingClientRect();
  drawCanvas.width = rect.width;
  drawCanvas.height = rect.height;
}

function clearCanvas(broadcast = true) {
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  if (broadcast) sendSignal({ type: 'draw-clear' });
}

function updateScreenUI() {
  const active = isScreenSharing || remoteScreenSharing;
  drawToolbar.classList.toggle('hidden', !active);
  screenBadge.classList.toggle('hidden', !active);
  remoteVideo.classList.toggle('screen-mode', active);
  shareScreen.classList.toggle('active-share', isScreenSharing);
  if (active) {
    resizeCanvas();
    drawCanvas.classList.toggle('drawing', drawEnabled);
  } else {
    clearCanvas(false);
    drawCanvas.classList.remove('drawing');
  }
}

function setScreenSharingState(sharing, fromRemote = false) {
  if (fromRemote) {
    remoteScreenSharing = sharing;
  } else {
    isScreenSharing = sharing;
  }
  updateScreenUI();
}

function updateVideoLayout() {
  if (remoteConnected && remoteStream && !isScreenSharing) {
    remoteVideo.srcObject = remoteStream;
    remoteVideo.classList.remove('hidden');
    localVideo.srcObject = cameraStream;
    remotePip.classList.remove('hidden');
    waiting.classList.add('hidden');
    videoContainer.classList.add('connected');
  } else if (!remoteConnected && cameraStream && !isScreenSharing) {
    remoteVideo.srcObject = cameraStream;
    remoteVideo.classList.remove('hidden');
    remotePip.classList.add('hidden');
    waiting.classList.remove('hidden');
    videoContainer.classList.remove('connected');
  }
}

async function getMedia() {
  const constraints = {
    audio: true,
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
  };
  cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
  localStream = cameraStream;
  cameraVideoTrack = cameraStream.getVideoTracks()[0];
  localVideo.srcObject = cameraStream;
  updateVideoLayout();
}

function getVideoSender() {
  return pc?.getSenders().find((s) => s.track?.kind === 'video');
}

async function replaceVideoTrack(track) {
  const sender = getVideoSender();
  if (sender) await sender.replaceTrack(track);
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false,
    });
    const screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.onended = () => stopScreenShare();

    await replaceVideoTrack(screenTrack);
    remoteVideo.srcObject = screenStream;
    remoteVideo.classList.remove('hidden');
    waiting.classList.add('hidden');
    setScreenSharingState(true);
    sendSignal({ type: 'screen-share', active: true });
    callStatus.textContent = 'Демонстрация экрана';
  } catch {
    // user cancelled
  }
}

async function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  if (cameraVideoTrack) {
    await replaceVideoTrack(cameraVideoTrack);
  }
  setScreenSharingState(false);
  sendSignal({ type: 'screen-share', active: false });
  updateVideoLayout();
  callStatus.textContent = remoteConnected ? 'На связи' : 'Ожидание друга...';
}

function drawStroke(from, to, color, width, local = true) {
  if (!from || !to) return;
  const x1 = from.x * drawCanvas.width;
  const y1 = from.y * drawCanvas.height;
  const x2 = to.x * drawCanvas.width;
  const y2 = to.y * drawCanvas.height;

  drawCtx.strokeStyle = color;
  drawCtx.lineWidth = width;
  drawCtx.lineCap = 'round';
  drawCtx.lineJoin = 'round';
  drawCtx.beginPath();
  drawCtx.moveTo(x1, y1);
  drawCtx.lineTo(x2, y2);
  drawCtx.stroke();

  if (local) {
    sendSignal({ type: 'draw', from, to, color, width });
  }
}

function getNormPoint(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

async function flushCandidates() {
  const candidates = pendingCandidates.splice(0);
  for (const candidate of candidates) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('ICE candidate error:', err);
    }
  }
}

async function addRemoteCandidate(candidate) {
  if (!pc || !candidate) return;
  if (!pc.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.warn('ICE candidate error:', err);
  }
}

function connectSignaling() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    sendSignal({ type: 'join', roomId });
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'joined':
        displayRoom.textContent = roomId;
        if (msg.peers === 0) {
          isInitiator = true;
          callStatus.textContent = 'Ожидание друга...';
          updateVideoLayout();
        } else {
          isInitiator = false;
          callStatus.textContent = 'Подключение...';
          await createPeerConnection();
          // Ждём offer от инициатора — не создаём свой
        }
        break;

      case 'peer-joined':
        callStatus.textContent = 'Друг подключился...';
        if (isInitiator) {
          await createPeerConnection();
          await sendOffer();
        }
        break;

      case 'offer':
        await handleOffer(msg.sdp);
        break;

      case 'answer':
        await handleAnswer(msg.sdp);
        break;

      case 'ice-candidate':
        await addRemoteCandidate(msg.candidate);
        break;

      case 'screen-share':
        setScreenSharingState(msg.active, true);
        callStatus.textContent = msg.active ? 'Друг демонстрирует экран' : 'На связи';
        break;

      case 'draw':
        drawStroke(msg.from, msg.to, msg.color, msg.width, false);
        break;

      case 'draw-clear':
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        break;

      case 'peer-left':
        remoteConnected = false;
        remoteStream = null;
        callStatus.textContent = 'Друг отключился';
        remoteScreenSharing = false;
        if (isScreenSharing) await stopScreenShare();
        updateScreenUI();
        updateVideoLayout();
        if (pc) {
          pc.close();
          pc = null;
        }
        pendingCandidates = [];
        isInitiator = true;
        break;
    }
  };

  ws.onclose = () => {
    callStatus.textContent = 'Соединение потеряно';
  };
}

async function createPeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  pendingCandidates = [];

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  pc.ontrack = (event) => {
    remoteStream = event.streams[0];
    remoteConnected = true;
    if (!isScreenSharing) {
      remoteVideo.srcObject = remoteStream;
    }
    waiting.classList.add('hidden');
    remotePip.classList.remove('hidden');
    localVideo.srcObject = cameraStream;
    videoContainer.classList.add('connected');
    callStatus.textContent = remoteScreenSharing ? 'Друг демонстрирует экран' : 'На связи';
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: 'ice-candidate', candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      callStatus.textContent = remoteScreenSharing ? 'Друг демонстрирует экран' : 'На связи';
    } else if (pc.connectionState === 'failed') {
      callStatus.textContent = 'Ошибка соединения — попробуйте переподключиться';
    } else if (pc.connectionState === 'disconnected') {
      callStatus.textContent = 'Соединение прервано...';
    }
  };
}

async function sendOffer() {
  if (!pc || makingOffer) return;
  makingOffer = true;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: pc.localDescription });
  } finally {
    makingOffer = false;
  }
}

async function handleOffer(sdp) {
  if (!pc) await createPeerConnection();

  const offerCollision = makingOffer || (pc.signalingState !== 'stable' && !isInitiator);
  ignoreOffer = !isInitiator && offerCollision;
  if (ignoreOffer) return;

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushCandidates();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({ type: 'answer', sdp: pc.localDescription });
}

async function handleAnswer(sdp) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushCandidates();
}

async function startCall(id) {
  roomId = id.toUpperCase();
  showScreen(callScreen);

  try {
    await getMedia();
    connectSignaling();
    window.addEventListener('resize', resizeCanvas);
  } catch {
    alert('Не удалось получить доступ к камере/микрофону. Разрешите доступ в настройках браузера.');
    showScreen(lobby);
  }
}

async function hangUp() {
  if (isScreenSharing) await stopScreenShare();
  if (ws) {
    sendSignal({ type: 'leave' });
    ws.close();
    ws = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  localStream = null;
  cameraVideoTrack = null;
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remoteStream = null;
  remoteConnected = false;
  remoteScreenSharing = false;
  pendingCandidates = [];
  makingOffer = false;
  waiting.classList.remove('hidden');
  remotePip.classList.add('hidden');
  drawToolbar.classList.add('hidden');
  screenBadge.classList.add('hidden');
  videoContainer.classList.remove('connected');
  window.removeEventListener('resize', resizeCanvas);
  showScreen(lobby);
  history.replaceState(null, '', '/');
}

function onDrawStart(e) {
  if (!drawEnabled || !(isScreenSharing || remoteScreenSharing)) return;
  e.preventDefault();
  isDrawing = true;
  lastDrawPoint = getNormPoint(e);
}

function onDrawMove(e) {
  if (!isDrawing || !lastDrawPoint) return;
  e.preventDefault();
  const point = getNormPoint(e);
  drawStroke(lastDrawPoint, point, drawColor.value, Number(drawSize.value));
  lastDrawPoint = point;
}

function onDrawEnd() {
  isDrawing = false;
  lastDrawPoint = null;
}

drawCanvas.addEventListener('mousedown', onDrawStart);
drawCanvas.addEventListener('mousemove', onDrawMove);
drawCanvas.addEventListener('mouseup', onDrawEnd);
drawCanvas.addEventListener('mouseleave', onDrawEnd);
drawCanvas.addEventListener('touchstart', onDrawStart, { passive: false });
drawCanvas.addEventListener('touchmove', onDrawMove, { passive: false });
drawCanvas.addEventListener('touchend', onDrawEnd);

drawToggle.addEventListener('click', () => {
  drawEnabled = !drawEnabled;
  drawToggle.classList.toggle('active', drawEnabled);
  drawCanvas.classList.toggle('drawing', drawEnabled);
});

drawClear.addEventListener('click', () => clearCanvas(true));

shareScreen.addEventListener('click', async () => {
  if (isScreenSharing) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
});

joinBtn.addEventListener('click', () => {
  const id = roomInput.value.trim();
  if (!id) {
    roomInput.focus();
    return;
  }
  startCall(id);
});

function getPublicOrigin() {
  return location.origin;
}

createBtn.addEventListener('click', () => {
  const id = generateRoomId();
  roomInput.value = id;
  roomLink.value = `${getPublicOrigin()}?room=${id}`;
  roomLinkBox.classList.remove('hidden');
});

copyBtn.addEventListener('click', () => {
  roomLink.select();
  navigator.clipboard.writeText(roomLink.value);
  copyBtn.title = 'Скопировано!';
  setTimeout(() => { copyBtn.title = 'Копировать'; }, 2000);
});

roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

toggleMic.addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((t) => { t.enabled = micEnabled; });
  toggleMic.classList.toggle('muted', !micEnabled);
  toggleMic.querySelector('.icon-on').classList.toggle('hidden', !micEnabled);
  toggleMic.querySelector('.icon-off').classList.toggle('hidden', micEnabled);
});

toggleCam.addEventListener('click', () => {
  camEnabled = !camEnabled;
  const track = cameraVideoTrack || localStream?.getVideoTracks()[0];
  if (track) track.enabled = camEnabled;
  toggleCam.classList.toggle('muted', !camEnabled);
  toggleCam.querySelector('.icon-on').classList.toggle('hidden', !camEnabled);
  toggleCam.querySelector('.icon-off').classList.toggle('hidden', camEnabled);
});

flipCam.addEventListener('click', async () => {
  if (!localStream || isScreenSharing) return;
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  const oldTrack = cameraVideoTrack;
  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode },
  });
  const newTrack = newStream.getVideoTracks()[0];
  await replaceVideoTrack(newTrack);
  oldTrack.stop();
  cameraStream.removeTrack(oldTrack);
  cameraStream.addTrack(newTrack);
  cameraVideoTrack = newTrack;
  localVideo.srcObject = cameraStream;
  if (!remoteConnected) updateVideoLayout();
});

endCall.addEventListener('click', hangUp);

const urlRoom = getRoomFromUrl();
if (urlRoom) {
  roomInput.value = urlRoom;
  roomLink.value = `${location.origin}?room=${urlRoom}`;
  roomLinkBox.classList.remove('hidden');
}
