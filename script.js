"use strict";

/* ============ State ============ */
let localStream = null;
let peer = null;
let myId = null;
let myName = "Guest";
let roomId = null;
let isHost = false;

const dataConns = new Map();   // peerId -> DataConnection
const mediaCalls = new Map();  // peerId -> MediaConnection
const roster = new Map();      // peerId -> name   (host keeps this authoritative)

let micOn = true;
let camOn = true;
let sharing = false;
let cameraTrackBackup = null;
let timerHandle = null;
let timerSeconds = 0;

/* ============ DOM ============ */
const $ = (id) => document.getElementById(id);
const lobby = $("lobby"), room = $("room");
const previewVideo = $("previewVideo"), previewOff = $("previewOff");
const previewMic = $("previewMic"), previewCam = $("previewCam");
const nameInput = $("nameInput"), joinInput = $("joinInput");
const createBtn = $("createBtn"), joinBtn = $("joinBtn");
const lobbyStatus = $("lobbyStatus"), roomStatus = $("roomStatus");
const videoGrid = $("videoGrid");
const roomIdLabel = $("roomIdLabel"), copyLinkBtn = $("copyLinkBtn");
const micBtn = $("micBtn"), camBtn = $("camBtn"), shareBtn = $("shareBtn"), leaveBtn = $("leaveBtn");
const callTimer = $("callTimer");

/* ============ Helpers ============ */
function genRoomId() {
  return Math.random().toString(36).slice(2, 6) + "-" + Math.random().toString(36).slice(2, 6);
}
function extractRoomId(raw) {
  raw = raw.trim();
  try {
    const u = new URL(raw);
    const q = u.searchParams.get("room");
    if (q) return q;
  } catch (_) { /* not a URL */ }
  return raw;
}
function setStatus(el, msg, isError = false) {
  el.textContent = msg || "";
  el.style.color = isError ? "var(--danger)" : "var(--warn)";
}
function fmtTime(s) {
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}
function startTimer() {
  timerSeconds = 0;
  timerHandle = setInterval(() => {
    timerSeconds++;
    callTimer.textContent = fmtTime(timerSeconds);
  }, 1000);
}
function stopTimer() {
  clearInterval(timerHandle);
  callTimer.textContent = "00:00";
}

/* ============ Lobby: camera preview ============ */
async function initPreview() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    previewVideo.srcObject = localStream;
  } catch (err) {
    setStatus(lobbyStatus, "Camera/Mic access nahi mila: " + err.message, true);
  }
}
initPreview();

previewMic.addEventListener("click", () => {
  micOn = !micOn;
  localStream?.getAudioTracks().forEach(t => (t.enabled = micOn));
  previewMic.classList.toggle("off", !micOn);
  previewMic.classList.toggle("on", micOn);
  previewMic.textContent = micOn ? "🎤" : "🔇";
});
previewCam.addEventListener("click", () => {
  camOn = !camOn;
  localStream?.getVideoTracks().forEach(t => (t.enabled = camOn));
  previewCam.classList.toggle("off", !camOn);
  previewCam.classList.toggle("on", camOn);
  previewCam.textContent = camOn ? "📷" : "🚫";
  previewOff.classList.toggle("show", !camOn);
});

/* ============ Tile management ============ */
function ensureTile(id, name, isLocal) {
  let tile = document.getElementById("tile-" + id);
  if (tile) return tile;
  tile = document.createElement("div");
  tile.className = "tile" + (isLocal ? " local" : "");
  tile.id = "tile-" + id;
  tile.innerHTML = `
    <video autoplay playsinline ${isLocal ? "muted" : ""}></video>
    <div class="avatar-fallback">${(name || "G").charAt(0).toUpperCase()}</div>
    <div class="mic-off-badge">🔇</div>
    <span class="name-tag">${isLocal ? "Aap (" + name + ")" : name}</span>
  `;
  videoGrid.appendChild(tile);
  return tile;
}
function removeTile(id) {
  document.getElementById("tile-" + id)?.remove();
}
function setTileStream(id, stream) {
  const tile = document.getElementById("tile-" + id);
  if (tile) tile.querySelector("video").srcObject = stream;
}

/* ============ Signaling / roster protocol ============ */
function broadcast(msg, exceptId) {
  dataConns.forEach((conn, id) => {
    if (id !== exceptId && conn.open) conn.send(msg);
  });
}

function attachDataConn(conn) {
  dataConns.set(conn.peer, conn);
  conn.on("data", (msg) => handleData(conn.peer, msg));
  conn.on("close", () => cleanupPeer(conn.peer));
}

function handleData(fromId, msg) {
  if (msg.type === "hello") {
    roster.set(fromId, msg.name);
    ensureTile(fromId, msg.name, false);
    if (isHost) {
      const rosterArr = [...roster.entries()]
        .filter(([id]) => id !== fromId)
        .map(([id, name]) => ({ id, name }));
      dataConns.get(fromId)?.send({ type: "roster", roster: rosterArr, hostName: myName });
      broadcast({ type: "peer-joined", id: fromId, name: msg.name }, fromId);
    }
  } else if (msg.type === "roster") {
    // received by a joiner from host: connect+call every existing member
    msg.roster.forEach(({ id, name }) => {
      roster.set(id, name);
      ensureTile(id, name, false);
      connectAndCall(id);
    });
  } else if (msg.type === "peer-joined") {
    roster.set(msg.id, msg.name);
  } else if (msg.type === "bye") {
    cleanupPeer(fromId);
  }
}

function connectAndCall(targetId) {
  if (targetId === myId || dataConns.has(targetId)) return;
  const conn = peer.connect(targetId);
  conn.on("open", () => {
    attachDataConn(conn);
    conn.send({ type: "hello", name: myName });
  });
  const call = peer.call(targetId, localStream);
  registerCall(targetId, call);
}

function registerCall(id, call) {
  mediaCalls.set(id, call);
  call.on("stream", (remoteStream) => {
    ensureTile(id, roster.get(id) || "Guest", false);
    setTileStream(id, remoteStream);
  });
  call.on("close", () => cleanupPeer(id));
  call.on("error", () => cleanupPeer(id));
}

function cleanupPeer(id) {
  mediaCalls.get(id)?.close();
  dataConns.get(id)?.close();
  mediaCalls.delete(id);
  dataConns.delete(id);
  roster.delete(id);
  removeTile(id);
}

/* ============ Create / Join ============ */
function initPeerCommon(onOpen) {
  peer.on("open", (id) => {
    myId = id;
    onOpen(id);
  });
  peer.on("connection", (conn) => {
    conn.on("open", () => attachDataConn(conn));
  });
  peer.on("call", (call) => {
    call.answer(localStream);
    registerCall(call.peer, call);
  });
  peer.on("error", (err) => {
    console.error(err);
    setStatus(lobbyStatus, "Connection error: " + err.type, true);
    setStatus(roomStatus, "Connection error: " + err.type, true);
  });
  peer.on("disconnected", () => peer.reconnect());
}

createBtn.addEventListener("click", () => {
  if (!localStream) return setStatus(lobbyStatus, "Camera/Mic tayyar nahi.", true);
  myName = nameInput.value.trim() || "Host";
  roomId = genRoomId();
  isHost = true;
  setStatus(lobbyStatus, "Meeting ban rahi hai...");
  peer = new Peer(roomId, { debug: 1 });
  initPeerCommon(() => enterRoom());
});

joinBtn.addEventListener("click", () => {
  if (!localStream) return setStatus(lobbyStatus, "Camera/Mic tayyar nahi.", true);
  const raw = joinInput.value.trim();
  if (!raw) return setStatus(lobbyStatus, "Meeting ID ya link daalein.", true);
  myName = nameInput.value.trim() || "Guest";
  roomId = extractRoomId(raw);
  isHost = false;
  setStatus(lobbyStatus, "Meeting join ho rahi hai...");
  peer = new Peer({ debug: 1 });
  initPeerCommon(() => {
    const conn = peer.connect(roomId);
    conn.on("open", () => {
      attachDataConn(conn);
      conn.send({ type: "hello", name: myName });
      roster.set(roomId, "Host");
      enterRoom();
    });
    conn.on("error", () => setStatus(lobbyStatus, "Meeting nahi mili. ID check karein.", true));
  });
});

/* Support links like index.html?room=abcd-1234 */
window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(location.search);
  const r = params.get("room");
  if (r) joinInput.value = r;
});

function enterRoom() {
  lobby.classList.remove("active");
  room.classList.add("active");
  roomIdLabel.textContent = roomId;
  videoGrid.innerHTML = "";
  ensureTile(myId, myName, true);
  setTileStream(myId, localStream);
  startTimer();
  setStatus(roomStatus, isHost ? "Aap host hain. Link share karein taake doosre shamil ho sakein." : "Meeting mein shamil ho gaye.");
  updateControlUI();
}

/* ============ Controls ============ */
function updateControlUI() {
  micBtn.classList.toggle("on", micOn);
  micBtn.classList.toggle("off", !micOn);
  micBtn.querySelector(".lbl").textContent = micOn ? "Mute" : "Unmute";
  camBtn.classList.toggle("on", camOn);
  camBtn.classList.toggle("off", !camOn);
  camBtn.querySelector(".lbl").textContent = camOn ? "Camera" : "Cam Off";
  document.getElementById("tile-" + myId)?.classList.toggle("muted", !micOn);
  document.getElementById("tile-" + myId)?.classList.toggle("camoff", !camOn);
}

micBtn.addEventListener("click", () => {
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => (t.enabled = micOn));
  updateControlUI();
});
camBtn.addEventListener("click", () => {
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => (t.enabled = camOn));
  updateControlUI();
});

copyLinkBtn.addEventListener("click", async () => {
  const link = `${location.origin}${location.pathname}?room=${roomId}`;
  try {
    await navigator.clipboard.writeText(link);
    setStatus(roomStatus, "Link copy ho gaya: " + link);
  } catch {
    setStatus(roomStatus, "Link: " + link);
  }
});

shareBtn.addEventListener("click", async () => {
  if (!sharing) {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = displayStream.getVideoTracks()[0];
      cameraTrackBackup = localStream.getVideoTracks()[0];
      mediaCalls.forEach((call) => {
        const sender = call.peerConnection?.getSenders().find(s => s.track && s.track.kind === "video");
        sender?.replaceTrack(screenTrack);
      });
      const tile = document.getElementById("tile-" + myId);
      tile.querySelector("video").srcObject = displayStream;
      sharing = true;
      shareBtn.classList.add("sharing");
      screenTrack.onended = stopSharing;
    } catch (err) {
      setStatus(roomStatus, "Screen share cancel ho gayi.", true);
    }
  } else {
    stopSharing();
  }
});
function stopSharing() {
  if (!cameraTrackBackup) return;
  mediaCalls.forEach((call) => {
    const sender = call.peerConnection?.getSenders().find(s => s.track && s.track.kind === "video");
    sender?.replaceTrack(cameraTrackBackup);
  });
  document.getElementById("tile-" + myId).querySelector("video").srcObject = localStream;
  sharing = false;
  shareBtn.classList.remove("sharing");
}

leaveBtn.addEventListener("click", () => {
  broadcast({ type: "bye" });
  mediaCalls.forEach(c => c.close());
  dataConns.forEach(c => c.close());
  mediaCalls.clear(); dataConns.clear(); roster.clear();
  peer?.destroy();
  stopTimer();
  videoGrid.innerHTML = "";
  room.classList.remove("active");
  lobby.classList.add("active");
  setStatus(lobbyStatus, "Aap meeting se nikal gaye.");
});

/* ============ PWA install prompt ============ */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("installToast").classList.remove("hidden");
});
$("installBtn")?.addEventListener("click", async () => {
  $("installToast").classList.add("hidden");
  deferredPrompt?.prompt();
  deferredPrompt = null;
});
$("dismissInstall")?.addEventListener("click", () => $("installToast").classList.add("hidden"));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(console.error);
  });
}
