// content.js — sayfaya enjekte edilen script
//
// Bu script her frame'de (üst sayfa + varsa iframe'ler) bağımsız olarak
// çalışır. Kontrol paneli/balon ikonu SADECE üst (top) frame'de gösterilir
// (aksi halde her iframe kendi ikonunu da gösterir ve ekranda birden fazla
// ikon belirir). Video senkron mantığı ise HER frame'de aktif olabilir,
// çünkü çoğu film izleme sitesinde gerçek <video> etiketi üst sayfada değil,
// gömülü bir iframe içinde barınır.
//
// Üst frame'deki panelden "Oda Oluştur / Katıl / Ayrıl" yapıldığında, bu
// bilgi (roomId + clientId) background.js üzerinden o sekmedeki TÜM
// frame'lere yayınlanır (bkz. broadcast/relay) VE arka planda hatırlanır.
// Bazı sitelerde gerçek video, bir "kontrol/reklam" ara sayfasından geçip
// başka bir iframe'e yönlenir — bu yeni bir doküman anlamına gelir ve o
// frame'in state'i (roomId, port, joined) sıfırlanır. Bunu telafi etmek
// için her frame kendi init() sırasında background'a "bu sekmede aktif
// oda var mı?" diye sorar (get-room-info) ve varsa otomatik katılır.
//
// clientId, sessionStorage'da tutulur (chrome.storage.local DEĞİL) —
// bu sayede her sekme/pencere kendi kimliğini üretir. Aksi halde aynı
// bilgisayardaki normal + InPrivate pencereler aynı kimliği paylaşır ve
// katılımcı sayısı hep "1" görünür.
//
// MV3 service worker'ı (background.js) bir süre işlem olmazsa otomatik
// uykuya geçer ve bu, açık portları koparır. Port koparsa ve biz odadaysak,
// otomatik olarak yeniden bağlanıp odaya tekrar katılıyoruz — aksi halde
// o pencere/frame sessizce "eski" duruma donup kalır (katılımcı sayısı,
// senkron vb. güncellenmeyi keser).
//
// applyRemoteVideo() gelen güncellemenin "kendi gönderdiğimiz" olup olmadığını
// clientId'ye bakarak FİLTRELEMİYOR — echo/geri besleme döngüsü zaten
// background.js'teki oturum bazlı (tabId:frameId) zaman damgası takibiyle ve
// buradaki remoteApplying bayrağıyla engelleniyor.

(() => {
  const DRIFT_THRESHOLD_SEC = 1.5;
  const REMOTE_GUARD_MS = 700;
  const RECONNECT_DELAY_MS = 400;
  const isTopFrame = window.top === window.self;

  let port = null;
  let video = null;
  let videoWatcher = null;
  let remoteApplying = false;
  let remoteGuardTimer = null;
  let roomId = null;
  let clientId = null;
  let displayName = null;
  let joined = false;

  let root = null; // shadow host
  let shadow = null;
  let els = {};

  // ---------- yardımcılar ----------

  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function randomRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) {
      out += chars[(Math.random() * chars.length) | 0];
    }
    return out;
  }

  function getState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["wp_name"], (data) => {
        resolve(data);
      });
    });
  }

  function setState(obj) {
    chrome.storage.local.set(obj);
  }

  function getSessionClientId() {
    let id;
    try {
      id = sessionStorage.getItem("wp_clientId");
    } catch (e) {
      id = null;
    }
    if (!id) {
      id = uuid();
      try {
        sessionStorage.setItem("wp_clientId", id);
      } catch (e) {
        /* sessionStorage erişilemiyorsa sorun değil, oturum boyunca bellekte tutulur */
      }
    }
    return id;
  }

  function broadcast(payload) {
    chrome.runtime.sendMessage({ type: "relay", payload }).catch(() => {});
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return null;
    // En büyük görünür video elementini seç (reklam/önizleme videolarını atla).
    videos.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });
    return videos[0];
  }

  function attachVideoListeners(v) {
    if (!v || v === video) return;
    detachVideoListeners();
    video = v;
    video.addEventListener("play", onLocalPlay);
    video.addEventListener("pause", onLocalPause);
    video.addEventListener("seeked", onLocalSeeked);
    if (isTopFrame) {
      setStatus(joined ? "Video bulundu, senkron aktif" : "Video bulundu");
    }
  }

  function detachVideoListeners() {
    if (!video) return;
    video.removeEventListener("play", onLocalPlay);
    video.removeEventListener("pause", onLocalPause);
    video.removeEventListener("seeked", onLocalSeeked);
    video = null;
  }

  function startVideoWatcher() {
    if (videoWatcher) return;
    videoWatcher = setInterval(() => {
      const found = findVideo();
      if (found && found !== video) attachVideoListeners(found);
    }, 1500);
  }

  function guardRemote(fn) {
    remoteApplying = true;
    fn();
    clearTimeout(remoteGuardTimer);
    remoteGuardTimer = setTimeout(() => {
      remoteApplying = false;
    }, REMOTE_GUARD_MS);
  }

  function pushVideoState() {
    if (!joined || !video || !port || remoteApplying) return;
    port.postMessage({
      type: "video-push",
      video: {
        time: video.currentTime,
        playing: !video.paused,
        ts: Date.now(),
        by: clientId,
      },
    });
  }

  function onLocalPlay() {
    pushVideoState();
  }
  function onLocalPause() {
    pushVideoState();
  }
  function onLocalSeeked() {
    pushVideoState();
  }

  function applyRemoteVideo(state) {
    if (!video || !state) return;
    guardRemote(() => {
      const drift = Math.abs(video.currentTime - state.time);
      if (drift > DRIFT_THRESHOLD_SEC) {
        video.currentTime = state.time;
      }
      if (state.playing && video.paused) {
        video.play().catch(() => {});
      } else if (!state.playing && !video.paused) {
        video.pause();
      }
    });
  }

  // ---------- UI (Shadow DOM) — sadece üst frame'de kurulur ----------

  function buildUI() {
    root = document.createElement("div");
    root.id = "watchparty-root";
    root.style.position = "fixed";
    root.style.zIndex = "2147483647";
    root.style.bottom = "16px";
    root.style.right = "16px";
    document.documentElement.appendChild(root);
    shadow = root.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = WATCHPARTY_CSS;
    shadow.appendChild(style);

    const bubble = document.createElement("button");
    bubble.className = "wp-bubble";
    bubble.textContent = "🎬";
    bubble.title = "WatchParty";
    bubble.addEventListener("click", togglePanel);
    shadow.appendChild(bubble);

    const panel = document.createElement("div");
    panel.className = "wp-panel wp-hidden";
    panel.innerHTML = `
      <div class="wp-header">
        <span>WatchParty</span>
        <button class="wp-close" title="Kapat">✕</button>
      </div>
      <div class="wp-status" data-el="status">Hazır</div>

      <div class="wp-section" data-el="joinSection">
        <label>Adın</label>
        <input type="text" data-el="nameInput" maxlength="24" placeholder="Örn. Beshlee" />

        <label>Oda kodu</label>
        <input type="text" data-el="roomInput" maxlength="8" placeholder="ör. A1B2C3" style="text-transform:uppercase" />

        <div class="wp-row">
          <button class="wp-btn wp-btn-primary" data-el="createBtn">Oda Oluştur</button>
          <button class="wp-btn" data-el="joinBtn">Odaya Katıl</button>
        </div>
      </div>

      <div class="wp-section wp-hidden" data-el="roomSection">
        <div class="wp-room-info">
          Oda: <strong data-el="roomCodeLabel"></strong>
          <button class="wp-copy" data-el="copyBtn" title="Kodu kopyala">Kopyala</button>
          <span class="wp-count" data-el="countLabel"></span>
        </div>

        <div class="wp-chat" data-el="chatLog"></div>

        <div class="wp-row">
          <input type="text" data-el="chatInput" placeholder="Mesaj yaz..." />
          <button class="wp-btn wp-btn-primary" data-el="sendBtn">Gönder</button>
        </div>

        <button class="wp-btn wp-leave" data-el="leaveBtn">Odadan Ayrıl</button>
      </div>
    `;
    shadow.appendChild(panel);

    els = {
      panel,
      bubble,
      status: panel.querySelector('[data-el="status"]'),
      joinSection: panel.querySelector('[data-el="joinSection"]'),
      roomSection: panel.querySelector('[data-el="roomSection"]'),
      nameInput: panel.querySelector('[data-el="nameInput"]'),
      roomInput: panel.querySelector('[data-el="roomInput"]'),
      createBtn: panel.querySelector('[data-el="createBtn"]'),
      joinBtn: panel.querySelector('[data-el="joinBtn"]'),
      roomCodeLabel: panel.querySelector('[data-el="roomCodeLabel"]'),
      copyBtn: panel.querySelector('[data-el="copyBtn"]'),
      countLabel: panel.querySelector('[data-el="countLabel"]'),
      chatLog: panel.querySelector('[data-el="chatLog"]'),
      chatInput: panel.querySelector('[data-el="chatInput"]'),
      sendBtn: panel.querySelector('[data-el="sendBtn"]'),
      leaveBtn: panel.querySelector('[data-el="leaveBtn"]'),
      closeBtn: panel.querySelector(".wp-close"),
    };

    els.closeBtn.addEventListener("click", togglePanel);
    els.createBtn.addEventListener("click", () => handleJoin(randomRoomCode()));
    els.joinBtn.addEventListener("click", () =>
      handleJoin(els.roomInput.value.trim().toUpperCase())
    );
    els.copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(roomId || "").catch(() => {});
      setStatus("Kod kopyalandı");
    });
    els.leaveBtn.addEventListener("click", handleLeave);
    els.sendBtn.addEventListener("click", sendChatMessage);
    els.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChatMessage();
    });
  }

  function togglePanel() {
    if (els.panel) els.panel.classList.toggle("wp-hidden");
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function setCount(n) {
    if (els.countLabel) {
      els.countLabel.textContent = n ? `👥 ${n}` : "";
    }
  }

  function addChatLine(name, text, mine) {
    if (!els.chatLog) return;
    const line = document.createElement("div");
    line.className = "wp-chat-line" + (mine ? " wp-mine" : "");
    const who = document.createElement("span");
    who.className = "wp-chat-name";
    who.textContent = name + ": ";
    line.appendChild(who);
    line.appendChild(document.createTextNode(text));
    els.chatLog.appendChild(line);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function sendChatMessage() {
    const text = els.chatInput.value.trim();
    if (!text || !joined || !port) return;
    port.postMessage({
      type: "chat-push",
      message: { name: displayName, text, ts: Date.now(), clientId },
    });
    els.chatInput.value = "";
  }

  // ---------- oda katılma/ayrılma ----------
  // Üst frame'deki panel butonlarından tetiklenir; asıl katılma işlemi
  // background.js üzerinden TÜM frame'lere yayınlanır (doJoin/doLeave).

  function handleJoin(code) {
    if (!code) {
      setStatus("Geçerli bir oda kodu gir");
      return;
    }
    displayName = (els.nameInput.value.trim() || "Misafir").slice(0, 24);
    setState({ wp_name: displayName });
    if (!clientId) clientId = getSessionClientId();
    setStatus("Odaya bağlanılıyor...");
    broadcast({ type: "room-info", roomId: code, clientId, name: displayName });
  }

  function handleLeave() {
    broadcast({ type: "room-leave" });
  }

  function doJoin(newRoomId, incomingClientId, incomingName) {
    roomId = newRoomId;
    if (incomingClientId) clientId = incomingClientId;
    if (incomingName) displayName = incomingName;
    ensurePort();
    port.postMessage({ type: "join", roomId, clientId, name: displayName });
  }

  function doLeave() {
    if (port) port.postMessage({ type: "leave" });
    joined = false;
    roomId = null;
    if (isTopFrame && els.panel) {
      els.joinSection.classList.remove("wp-hidden");
      els.roomSection.classList.add("wp-hidden");
      els.chatLog.innerHTML = "";
      setStatus("Odadan ayrıldın");
    }
  }

  // ---------- background.js ile port iletişimi ----------

  function ensurePort() {
    if (port) return;
    port = chrome.runtime.connect({ name: "watchparty" });
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "joined":
          joined = true;
          if (isTopFrame) {
            els.joinSection.classList.add("wp-hidden");
            els.roomSection.classList.remove("wp-hidden");
            els.roomCodeLabel.textContent = msg.roomId;
            setStatus(
              video ? "Bağlandı — senkron aktif" : "Bağlandı — video aranıyor"
            );
          }
          break;
        case "video-update":
          applyRemoteVideo(msg.video);
          break;
        case "chat-update":
          msg.messages.forEach((m) => {
            if (!m) return;
            addChatLine(m.name || "?", m.text || "", m.clientId === clientId);
          });
          break;
        case "presence-update":
          setCount(msg.count);
          break;
        case "error":
          setStatus("Hata: " + msg.message);
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // background.js (MV3 service worker) bir süre boşta kalınca uykuya
      // dalar ve bu, açık portları koparır. Odadaysak, kısa bir gecikmeyle
      // otomatik olarak yeniden bağlanıp odaya tekrar katılıyoruz.
      if (joined && roomId) {
        setTimeout(() => {
          if (!port) {
            ensurePort();
            port.postMessage({ type: "join", roomId, clientId, name: displayName });
          }
        }, RECONNECT_DELAY_MS);
      }
    });
  }

  // ---------- başlangıç ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle-panel" && isTopFrame) togglePanel();
    if (msg.type === "room-info") doJoin(msg.roomId, msg.clientId, msg.name);
    if (msg.type === "room-leave") doLeave();
  });

  async function init() {
    const stored = await getState();
    displayName = stored.wp_name || "Misafir";

    if (isTopFrame) {
      buildUI();
      els.nameInput.value = displayName;
    }

    const initial = findVideo();
    if (initial) attachVideoListeners(initial);
    startVideoWatcher();

    // Bu sekmede zaten aktif bir oda varsa (örn. bu frame bir "kontrol/
    // reklam" ara sayfasından sonra videoyu barındıran asıl iframe olarak
    // yeniden yüklendi), otomatik olarak o odaya katıl.
    chrome.runtime.sendMessage({ type: "get-room-info" }, (info) => {
      if (info && info.roomId) {
        doJoin(info.roomId, info.clientId, info.name);
      }
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }

  window.addEventListener("beforeunload", () => {
    if (port && joined) port.postMessage({ type: "leave" });
  });

  // MV3 service worker, sekme arka planda uzun süre kaldığında uykuya dalıp
  // polling'i sessizce durdurabilir; bunu port kopmadan da fark edebiliriz.
  // Sekme tekrar görünür olduğunda katılımı tazeleyerek (idempotent "join")
  // olası kopuk/uykudaki durumdan kurtarıyoruz.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !joined || !roomId) return;
    if (!port) ensurePort();
    port.postMessage({ type: "join", roomId, clientId, name: displayName });
  });
})();
