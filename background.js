// background.js — MV3 service worker
//
// Bütün Firebase Realtime Database (REST) trafiği burada yapılır. Sebep:
// content script'ler ziyaret edilen sitenin Content-Security-Policy (CSP)
// kurallarına tabidir ve bazı siteler firebasedatabase.app'e fetch/EventSource
// isteklerini engelleyebilir. Service worker ise sayfanın CSP'sinden bağımsızdır.
//
// content.js her odaya katıldığında chrome.runtime.connect({name:"watchparty"})
// ile bir port açar; bu port üzerinden mesajlaşılır. Sayfa birden fazla frame
// (iframe) içeriyorsa her frame kendi portunu açar, bu yüzden oturumlar
// "tabId:frameId" anahtarıyla ayrı ayrı tutulur — aksi halde farklı
// frame'lerin bağlantıları birbirine karışır.
//
// tabRooms: her sekme (tabId) için "şu an aktif olan oda" bilgisini saklar.
// Bazı sitelerde gerçek video, bir "kontrol/reklam" ara sayfasından geçip
// başka bir iframe'e yönlenir (yeni bir doküman = content.js'in state'inin
// sıfırlanması). Yeni yüklenen frame, init() sırasında background'a
// "bu sekmede aktif oda var mı?" diye sorar (get-room-info) ve varsa
// otomatik katılır — böylece yönlenme sonrası senkron kesilmez.
//
// Oda temizliği: bir odadaki son kişi ayrılınca (buton veya sekme kapanışı)
// o oda hemen silinir. Eskiden burada, biri odaya katıldığında arka planda
// 24 saatten eski VE üyesi kalmamış odaları tarayan bir güvenlik ağı vardı;
// bu tarama `rooms` kökünü topluca listemeyi gerektiriyordu, bu da herkesin
// tüm aktif oda kodlarını keşfedebilmesi anlamına geliyordu. Firebase
// kuralları (bkz. database.rules.json) bu listelemeyi artık engelliyor,
// dolayısıyla tarama kaldırıldı — tarayıcı çökmesi gibi nadir durumlarda
// terk edilmiş bir oda kaydı (sadece isim + son görülme zamanı içerir)
// süresiz kalabilir, ama bu düşük riskli kabul edildi.

importScripts("config.js");

const POLL_MS = 1000;
// "tabId:frameId" -> { port, roomId, clientId, timer, lastVideoTs, lastChatKey }
const sessions = new Map();
// tabId -> { roomId, clientId, name }
const tabRooms = new Map();

function dbUrl(path) {
  const base = WATCHPARTY_CONFIG.FIREBASE_DB_URL.replace(/\/$/, "");
  return `${base}/${path}.json`;
}

async function dbGet(path) {
  const res = await fetch(dbUrl(path));
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function dbPut(path, data) {
  const res = await fetch(dbUrl(path), {
    method: "PUT",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`PUT ${path} -> ${res.status}`);
  return res.json();
}

async function dbPatch(path, data) {
  const res = await fetch(dbUrl(path), {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status}`);
  return res.json();
}

async function dbPush(path, data) {
  const res = await fetch(dbUrl(path), {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}

async function deleteRoomIfEmpty(roomId) {
  try {
    const members = await dbGet(`rooms/${roomId}/members`);
    if (!members || Object.keys(members).length === 0) {
      await dbPut(`rooms/${roomId}`, null);
    }
  } catch (e) {
    /* sessizce yut, kritik değil */
  }
}

function startPolling(sessionKey) {
  const s = sessions.get(sessionKey);
  if (!s || s.timer) return;
  s.timer = setInterval(async () => {
    if (!s.roomId) return;
    try {
      const room = await dbGet(`rooms/${s.roomId}`);
      if (!room) return;

      if (room.video && room.video.ts !== s.lastVideoTs) {
        s.lastVideoTs = room.video.ts;
        s.port.postMessage({ type: "video-update", video: room.video });
      }

      if (room.chat) {
        const keys = Object.keys(room.chat).sort();
        const newKeys = s.lastChatKey
          ? keys.filter((k) => k > s.lastChatKey)
          : keys.slice(-20);
        if (newKeys.length) {
          s.lastChatKey = keys[keys.length - 1];
          s.port.postMessage({
            type: "chat-update",
            messages: newKeys.map((k) => room.chat[k]),
          });
        }
      }

      const memberCount = room.members ? Object.keys(room.members).length : 0;
      s.port.postMessage({ type: "presence-update", count: memberCount });
    } catch (e) {
      s.port.postMessage({ type: "error", message: String(e) });
    }
  }, POLL_MS);
}

function stopPolling(sessionKey) {
  const s = sessions.get(sessionKey);
  if (s && s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "watchparty") return;
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  const frameId = port.sender ? port.sender.frameId : 0;
  if (tabId == null) return;
  const sessionKey = `${tabId}:${frameId}`;

  sessions.set(sessionKey, {
    port,
    roomId: null,
    clientId: null,
    timer: null,
    lastVideoTs: null,
    lastChatKey: null,
  });

  port.onMessage.addListener(async (msg) => {
    const s = sessions.get(sessionKey);
    if (!s) return;
    try {
      switch (msg.type) {
        case "join": {
          // İçerik betiği, aynı odaya birden fazla kez "join" gönderebilir
          // (kendi yayınını geri alma, sekme tekrar görünür olunca tazeleme,
          // vb.). Bunlar zararsız tazelemelerdir; imleci sadece GERÇEKTEN
          // farklı bir odaya geçerken (ya da bu oturum ilk kez katılıyorsa)
          // sıfırlıyoruz — aksi halde her tazelemede son sohbet mesajları
          // "yeni" sanılıp ekranda tekrar tekrar belirir.
          const isNewRoom = s.roomId !== msg.roomId;
          s.roomId = msg.roomId;
          s.clientId = msg.clientId;
          if (isNewRoom) {
            s.lastVideoTs = null;
            s.lastChatKey = null;
          }

          await dbPatch(`rooms/${msg.roomId}/members/${msg.clientId}`, {
            name: msg.name,
            lastSeen: Date.now(),
          });

          // Aynı sekmedeki birden fazla frame (örn. bir reklam iframe'i)
          // aynı odaya paralel katılabilir; ikisi de createdAt'ı aynı anda
          // boş görüp yazmaya çalışabilir. Kaybeden taraf için Firebase
          // kuralı (alan artık dolu olduğundan) reddeder — bu zararlı bir
          // hata değil, sadece bir yarış durumu, o yüzden sessizce yutuyoruz.
          const createdAt = await dbGet(`rooms/${msg.roomId}/createdAt`);
          if (!createdAt) {
            await dbPut(`rooms/${msg.roomId}/createdAt`, Date.now()).catch(() => {});
          }

          startPolling(sessionKey);
          port.postMessage({ type: "joined", roomId: msg.roomId });
          break;
        }

        case "leave": {
          if (s.roomId && s.clientId) {
            const rid = s.roomId;
            const cid = s.clientId;
            dbPut(`rooms/${rid}/members/${cid}`, null)
              .then(() => deleteRoomIfEmpty(rid))
              .catch(() => {});
          }
          stopPolling(sessionKey);
          s.roomId = null;
          break;
        }

        case "video-push": {
          if (!s.roomId) return;
          // Kendi gönderdiğimiz güncellemeyi tekrar bize yollamasın diye
          // zaman damgasını önceden "görülmüş" say.
          s.lastVideoTs = msg.video.ts;
          await dbPut(`rooms/${s.roomId}/video`, msg.video);
          break;
        }

        case "chat-push": {
          if (!s.roomId) return;
          await dbPush(`rooms/${s.roomId}/chat`, msg.message);
          break;
        }
      }
    } catch (e) {
      port.postMessage({ type: "error", message: String(e) });
    }
  });

  port.onDisconnect.addListener(() => {
    const s = sessions.get(sessionKey);
    if (s && s.roomId && s.clientId) {
      const rid = s.roomId;
      const cid = s.clientId;
      dbPut(`rooms/${rid}/members/${cid}`, null)
        .then(() => deleteRoomIfEmpty(rid))
        .catch(() => {});
    }
    stopPolling(sessionKey);
    sessions.delete(sessionKey);
  });
});

// content.js'lerden gelen mesajlar:
//  - "relay": bu sekmedeki TÜM frame'lere (iframe'ler dahil) dağıtılır.
//    Ayrıca "room-info"/"room-leave" payload'ları tabRooms'a kaydedilir/silinir.
//  - "get-room-info": yeni yüklenen bir frame, bu sekmede aktif oda var mı
//    diye sorar; varsa geri döner (otomatik katılım için).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "relay" && sender.tab) {
    const tabId = sender.tab.id;
    if (msg.payload && msg.payload.type === "room-info") {
      tabRooms.set(tabId, {
        roomId: msg.payload.roomId,
        clientId: msg.payload.clientId,
        name: msg.payload.name,
      });
    } else if (msg.payload && msg.payload.type === "room-leave") {
      tabRooms.delete(tabId);
    }
    chrome.tabs.sendMessage(tabId, msg.payload).catch(() => {});
    return;
  }

  if (msg.type === "get-room-info" && sender.tab) {
    sendResponse(tabRooms.get(sender.tab.id) || null);
    return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabRooms.delete(tabId);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" }).catch(() => {});
  }
});
