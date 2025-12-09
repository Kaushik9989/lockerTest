const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const net = require("net");
const path = require("path");

const BU_IP = "192.168.0.178"; // <-- change to your board IP
const BU_PORT = 4001; // <-- change to your board port

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));


app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// =========================
//  Kerong / NCU12L Protocol
// =========================

let client1 = null;
let isConnected = false;
let pollingCallback = null;

// Build unlock packet
function buildKerongUnlockPacket(compartmentId = 0x00, addr = 0x00) {
  const STX = 0x02;
  const CMD = 0x81;
  const ASK = 0x00;
  const DATALEN = 0x00;
  const ETX = 0x03;

  const LOCKNUM = compartmentId; // 0x00 to 0x0B
  const bytes = [STX, addr, LOCKNUM, CMD, ASK, DATALEN, ETX];
  const checksum = bytes.reduce((sum, byte) => sum + byte, 0) & 0xff;
  bytes.push(checksum);

  return Buffer.from(bytes);
}

// Build "get status" packet
function buildGetStatusPacket(addr = 0x00) {
  const STX = 0x02;
  const LOCKNUM = 0x00;
  const CMD = 0x80;
  const ASK = 0x00;
  const DATALEN = 0x00;
  const ETX = 0x03;

  let sum = STX + addr + LOCKNUM + CMD + ASK + DATALEN + ETX;
  const SUM = sum & 0xff;

  return Buffer.from([STX, addr, LOCKNUM, CMD, ASK, DATALEN, ETX, SUM]);
}

// Parse lock status from response bytes
function parseLockStatus(data) {
  const len = data.length;
  if (len < 10) return null;

  const hookLow = data[len - 2];
  const hookHigh = data[len - 1];
  const hookState = (hookHigh << 8) | hookLow;

  const status = {};
  for (let i = 0; i < 12; i++) {
    status[`Lock_${i}`] = hookState & (1 << i) ? "Locked" : "Unlocked";
  }
  return status;
}

// =========================
//  TCP Connection to BU
// =========================

function connectToBU(ip = BU_IP, port = BU_PORT) {
  return new Promise((resolve) => {
    console.log(`🔌 Connecting to BU at ${ip}:${port}...`);

    client1 = new net.Socket();

    client1.connect(port, ip, () => {
      console.log(`✅ Connected to BU at ${ip}:${port}`);
      isConnected = true;
      resolve(true);
    });

    client1.on("error", (err) => {
      console.error(`❌ TCP Error: ${err.message}`);
      isConnected = false;
      resolve(false);
    });

    client1.on("close", () => {
      console.warn("⚠️ BU connection closed. Reconnecting in 2s...");
      isConnected = false;
      setTimeout(() => connectToBU(ip, port), 2000);
    });

    // General data listener for polling
    client1.on("data", (data) => {
      console.log(`📥 [TCP] Data: ${data.toString("hex").toUpperCase()}`);
      if (pollingCallback) {
        pollingCallback(data);
      }
    });
  });
}

function sendPacket(packet) {
  return new Promise((resolve) => {
    if (!isConnected || !client1) {
      console.warn("⚠️ No active BU connection");
      return resolve(null);
    }

    client1.write(packet, (err) => {
      if (err) {
        console.error(`❌ Write Error: ${err.message}`);
        return resolve(null);
      }
      console.log("📤 Sent:", packet.toString("hex").toUpperCase());
    });

    // This will fire once for the next data chunk
    client1.once("data", (data) => {
      console.log(`📥 [sendPacket] Received: ${data.toString("hex").toUpperCase()}`);
      resolve(data);
    });
  });
}

function sendUnlock(compartmentId, addr = 0x00) {
  return sendPacket(buildKerongUnlockPacket(compartmentId, addr));
}

// =========================
//  Polling
// =========================

function startPollingMultiple(addresses = [0x00, 0x01], intervalMs = 500, ioInstance) {
  pollingCallback = (data) => {
    const status = parseLockStatus(data);
    if (status) {
      // Extract address from response: byte after STX is usually address
      const addrFromResponse = data[1];
      ioInstance.emit("lockerStatus", { addr: addrFromResponse, status });
    }
  };

  let currentIndex = 0;

  setInterval(() => {
    if (isConnected && client1) {
      const addr = addresses[currentIndex];
      const packet = buildGetStatusPacket(addr);
      client1.write(packet, (err) => {
        if (err) {
          console.error("❌ Polling write error:", err.message);
        } else {
          // console.log("📤 Polling sent:", packet.toString("hex").toUpperCase());
        }
      });

      currentIndex = (currentIndex + 1) % addresses.length;
    }
  }, intervalMs);
}

// =========================
//  Express Routes
// =========================

// View: Locker control UI
app.get("/", (req, res) => {
  // You can pass addresses / number of lockers if you want dynamic
  res.render("lockers", {
    addresses: [0, 1], // 0x00, 0x01
    lockersCount: 12,
  });
});

// API: Unlock
app.post("/api/locker/unlock", async (req, res) => {
  try {
    let { addr, compartmentId } = req.body;

    addr = Number(addr);
    compartmentId = Number(compartmentId);

    if (Number.isNaN(addr) || Number.isNaN(compartmentId)) {
      return res.status(400).json({
        ok: false,
        error: "addr and compartmentId must be numbers",
      });
    }

    const response = await sendUnlock(compartmentId, addr);
    return res.json({
      ok: true,
      addr,
      compartmentId,
      rawResponse: response ? response.toString("hex").toUpperCase() : null,
    });
  } catch (err) {
    console.error("❌ Unlock API error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});



// =========================
//  Socket.IO
// =========================

io.on("connection", (socket) => {
  console.log("🔗 Web client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ Web client disconnected:", socket.id);
  });
});

// =========================
//  Start Server
// =========================

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);

  const ok = await connectToBU();
  if (!ok) {
    console.warn("⚠️ BU not connected yet; reconnect logic will keep trying.");
  }

  // Poll addresses 0x00 and 0x01
  startPollingMultiple([0x00, 0x01], 500, io);
});