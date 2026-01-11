import WebSocket from "ws";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

let mainWs;
let voiceWs;
let heartbeatInterval;
let voiceHeartbeatInterval;
let sessionId;
let voiceServerData;
let lastSequence = null;
let voiceLastSequence = null;
let voiceStateReceived = false;
let voiceServerReceived = false;

export function connectToGateway() {
  return new Promise((resolve) => {
    mainWs = new WebSocket(GATEWAY_URL);

    mainWs.on("open", () => {
      console.log("Connected to Discord Gateway");
    });

    mainWs.on("message", (data) => {
      const payload = JSON.parse(data);
      const { op, d, t, s } = payload;

      // Track the sequence number
      if (s !== null) {
        lastSequence = s;
      }

      switch (op) {
        case 10: // Hello
          startHeartbeat(d.heartbeat_interval);
          identify();
          break;
        case 11: // Heartbeat ACK
          break;
      }

      if (t === "READY") {
        console.log("Bot is ready!", d.user.username);
        resolve();
      }

      if (t === "VOICE_STATE_UPDATE") {
        console.log("Voice state update received:", d);
        // Make sure it's for our bot
        if (d.user_id === process.env.BOT_USER_ID) {
          voiceStateReceived = true;
          sessionId = d.session_id; // Get session_id from HERE, not from READY
          tryConnectToVoice();
        }
      }

      if (t === "VOICE_SERVER_UPDATE") {
        console.log("Voice server update received:", d);
        voiceServerData = d;
        voiceServerReceived = true;
        tryConnectToVoice();
      }
    });

    mainWs.on("close", (code) => {
      console.log("Main gateway disconnected:", code);
      clearInterval(heartbeatInterval);
    });

    mainWs.on("error", (err) => {
      console.error("Main gateway error:", err);
    });
  });
}

function tryConnectToVoice() {
  // Only connect once we have BOTH events
  if (
    voiceStateReceived &&
    voiceServerReceived &&
    voiceServerData &&
    sessionId
  ) {
    console.log("Both events received, connecting to voice gateway...");
    console.log("Session ID:", sessionId);
    console.log("Voice token:", voiceServerData.token);
    connectToVoiceGateway();

    // Reset for next connection
    voiceStateReceived = false;
    voiceServerReceived = false;
  }
}

function startHeartbeat(interval) {
  // Send first heartbeat after random jitter
  setTimeout(() => {
    mainWs.send(JSON.stringify({ op: 1, d: lastSequence }));
  }, Math.random() * interval);

  heartbeatInterval = setInterval(() => {
    console.log("regular heartbeat!");
    mainWs.send(JSON.stringify({ op: 1, d: lastSequence }));
  }, interval);
}

function identify() {
  mainWs.send(
    JSON.stringify({
      op: 2,
      d: {
        token: process.env.DISCORD_TOKEN,
        intents: (1 << 0) | (1 << 7), // GUILDS + GUILD_VOICE_STATES
        properties: {
          os: "linux",
          browser: "my-bot",
          device: "my-bot",
        },
      },
    })
  );
}

// Call this to join a voice channel
export function joinVoiceChannel(guildId, channelId) {
  console.log(`Joining voice channel ${channelId} in guild ${guildId}`);

  mainWs.send(
    JSON.stringify({
      op: 4, // Voice State Update
      d: {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: false,
        self_deaf: false,
      },
    })
  );
}

// Call this to leave a voice channel
export function leaveVoiceChannel(guildId) {
  mainWs.send(
    JSON.stringify({
      op: 4,
      d: {
        guild_id: guildId,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      },
    })
  );
}

function connectToVoiceGateway() {
  const voiceUrl = `wss://${voiceServerData.endpoint}?v=8`;
  console.log("Connecting to voice gateway:", voiceUrl);

  voiceWs = new WebSocket(voiceUrl);

  voiceWs.on("open", () => {
    console.log("Connected to Voice Gateway");

    const identifyPayload = {
      op: 0, // Identify
      d: {
        server_id: voiceServerData.guild_id,
        user_id: process.env.BOT_USER_ID,
        session_id: sessionId,
        token: voiceServerData.token,
      },
    };

    console.log(
      "Sending voice identify:",
      JSON.stringify(identifyPayload, null, 2)
    );
    voiceWs.send(JSON.stringify(identifyPayload));
  });

  voiceWs.on("message", (data) => {
    const payload = JSON.parse(data);
    const { op, d, seq } = payload;

    // Track the voice sequence number
    if (seq !== undefined) {
      voiceLastSequence = seq;
    }

    console.log("Voice gateway received:", op, d);

    switch (op) {
      case 8: // Hello
        startVoiceHeartbeat(d.heartbeat_interval);
        break;

      case 2: // Ready
        console.log("Voice ready!");
        console.log("SSRC:", d.ssrc);
        console.log("IP:", d.ip);
        console.log("Port:", d.port);
        // Here you would set up UDP connection for actual audio
        selectProtocol(d);
        break;

      case 4: // Session Description
        console.log("Voice session established!");
        console.log("Mode:", d.mode);
        // Now you can start sending/receiving audio
        break;

      case 6: // Heartbeat ACK
        break;
    }
  });

  voiceWs.on("close", (code, reason) => {
    console.log(
      "Voice gateway disconnected! Code:",
      code,
      "Reason:",
      reason.toString()
    );
    clearInterval(voiceHeartbeatInterval);
  });

  voiceWs.on("error", (err) => {
    console.error("Voice gateway error:", err);
  });
}

function startVoiceHeartbeat(interval) {
  // Send first heartbeat after random jitter
  setTimeout(() => {
    sendVoiceHeartbeat();
  }, Math.random() * interval);

  voiceHeartbeatInterval = setInterval(() => {
    console.log("voice heartbeat!");
    sendVoiceHeartbeat();
  }, interval);
}

function sendVoiceHeartbeat() {
  voiceWs.send(
    JSON.stringify({
      op: 3,
      d: {
        t: Date.now(),
        seq_ack: voiceLastSequence,
      },
    })
  );
}

function selectProtocol(readyData) {
  // This tells Discord how we want to send/receive audio
  // You'd normally do IP discovery via UDP first
  voiceWs.send(
    JSON.stringify({
      op: 1, // Select Protocol
      d: {
        protocol: "udp",
        data: {
          address: readyData.ip, // Your external IP (from UDP discovery)
          port: readyData.port, // Your external port (from UDP discovery)
          mode: "aead_xchacha20_poly1305_rtpsize", // Encryption mode
        },
      },
    })
  );
}
