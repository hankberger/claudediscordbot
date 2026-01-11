import WebSocket from "ws";
import dgram from "dgram";
import { randomBytes } from "crypto";
import pkg from "@discordjs/opus";
const { OpusEncoder } = pkg;
import prism from "prism-media";
import sodium from "libsodium-wrappers";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

let mainWs;
let voiceWs;
let heartbeatInterval;
let voiceHeartbeatInterval;
let sessionId;
let botUserId;
let voiceServerData;
let lastSequence = null;
let voiceLastSequence = null;
let voiceStateReceived = false;
let voiceServerReceived = false;

// UDP and audio state
let udpSocket;
let voiceUdpInfo = { ip: null, port: null, ssrc: null };
let secretKey = null;
let sequenceNumber = 0;
let timestamp = 0;
let currentAudioStream = null;
let audioInterval = null;

// Opus encoder: 48kHz, stereo
const opusEncoder = new OpusEncoder(48000, 2);

// Initialize sodium
let sodiumReady = false;
sodium.ready.then(() => {
  sodiumReady = true;
  console.log("Sodium encryption library ready");
});

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
        botUserId = d.user.id;
        console.log("Bot is ready!", d.user.username);
        resolve();
      }

      if (t === "VOICE_STATE_UPDATE") {
        console.log("Voice state update received:", d);
        // Make sure it's for our bot
        console.log(d.user_id, " USER ID");
        if (d.user_id === botUserId) {
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
  console.log("Try connect to voice!", {
    voiceStateReceived,
    voiceServerReceived,
    voiceServerData,
    sessionId,
  });
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
        user_id: botUserId,
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
        // Store SSRC and perform IP discovery
        voiceUdpInfo.ssrc = d.ssrc;
        performIpDiscovery(d.ip, d.port, d.ssrc);
        break;

      case 4: // Session Description
        console.log("Voice session established!");
        console.log("Mode:", d.mode);
        // Store the encryption key
        secretKey = Buffer.from(d.secret_key);
        console.log("Encryption key received, ready to send audio!");
        playAudio("./heyguys.mp3");
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
    //playAudio("./wave.mp3");
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

function selectProtocol() {
  // Send our discovered external IP/port to Discord
  console.log(
    "Selecting protocol with IP:",
    voiceUdpInfo.ip,
    "Port:",
    voiceUdpInfo.port
  );
  voiceWs.send(
    JSON.stringify({
      op: 1, // Select Protocol
      d: {
        protocol: "udp",
        data: {
          address: voiceUdpInfo.ip,
          port: voiceUdpInfo.port,
          mode: "aead_xchacha20_poly1305_rtpsize",
        },
      },
    })
  );
}

function performIpDiscovery(discordIp, discordPort, ssrc) {
  console.log("Starting IP discovery...");

  // Store Discord's voice server IP/port for sending audio later
  voiceUdpInfo.discordIp = discordIp;
  voiceUdpInfo.discordPort = discordPort;

  // Create UDP socket
  udpSocket = dgram.createSocket("udp4");

  udpSocket.on("error", (err) => {
    console.error("UDP socket error:", err);
  });

  udpSocket.on("message", (msg) => {
    // Check if this is an IP discovery response (type 0x02)
    const type = msg.readUInt16BE(0);
    if (type === 0x02) {
      // Extract IP address (null-terminated string starting at byte 8)
      const ipEnd = msg.indexOf(0, 8);
      const ip = msg.slice(8, ipEnd).toString("utf8");
      // Extract port (last 2 bytes, big-endian)
      const port = msg.readUInt16BE(msg.length - 2);

      voiceUdpInfo.ip = ip;
      voiceUdpInfo.port = port;

      console.log("IP Discovery complete! External IP:", ip, "Port:", port);

      // Now we can select the protocol
      selectProtocol();
    }
  });

  // Bind to any available port
  udpSocket.bind(() => {
    const localPort = udpSocket.address().port;
    console.log("UDP socket bound to local port:", localPort);

    // Build IP discovery request packet (74 bytes)
    // Type (2 bytes): 0x01 = request
    // Length (2 bytes): 70
    // SSRC (4 bytes)
    // Address (64 bytes, null-padded)
    // Port (2 bytes)
    const discoveryPacket = Buffer.alloc(74);
    discoveryPacket.writeUInt16BE(0x01, 0); // Type: request
    discoveryPacket.writeUInt16BE(70, 2); // Length
    discoveryPacket.writeUInt32BE(ssrc, 4); // SSRC
    // Rest is zeros (address and port fields for request)

    console.log("Sending IP discovery packet to", discordIp, ":", discordPort);
    udpSocket.send(discoveryPacket, discordPort, discordIp, (err) => {
      if (err) {
        console.error("Failed to send IP discovery packet:", err);
      }
    });
  });
}

function setSpeaking(speaking) {
  voiceWs.send(
    JSON.stringify({
      op: 5,
      d: {
        speaking: speaking ? 1 : 0,
        delay: 0,
        ssrc: voiceUdpInfo.ssrc,
      },
    })
  );
}

function createRtpHeader(sequence, timestamp, ssrc) {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // Version 2
  header[1] = 0x78; // Payload type 120 (dynamic, used for Opus)
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);
  return header;
}

// Nonce counter for encryption (incremented per packet)
let nonceCounter = 0;

function encryptAudio(header, audioData) {
  // For aead_xchacha20_poly1305_rtpsize mode:
  // - 24-byte nonce: 4-byte incrementing counter + 20 zero bytes
  // - The 4-byte nonce is appended to the packet after encryption
  // - Header is used as additional authenticated data (AAD)

  const nonce = Buffer.alloc(24);
  nonce.writeUInt32BE(nonceCounter, 0);
  nonceCounter = (nonceCounter + 1) >>> 0;

  // Encrypt using XChaCha20-Poly1305
  const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    audioData,
    header, // Additional authenticated data
    null, // nsec (unused)
    nonce,
    secretKey
  );

  // Packet structure: RTP header + encrypted audio + 4-byte nonce prefix
  const nonceAppend = nonce.slice(0, 4);
  return Buffer.concat([header, Buffer.from(encrypted), nonceAppend]);
}

// Queue for audio frames (paced at 20ms intervals)
let audioFrameQueue = [];
let isPlaying = false;

export function playAudio(filePath) {
  if (!secretKey) {
    console.error("Cannot play audio: voice session not established");
    return;
  }

  if (!udpSocket) {
    console.error("Cannot play audio: UDP socket not ready");
    return;
  }

  if (!sodiumReady) {
    console.error("Cannot play audio: encryption not ready");
    return;
  }

  console.log("Playing audio file:", filePath);

  // Stop any current playback
  stopAudio();

  // Set speaking state
  setSpeaking(true);
  isPlaying = true;
  audioFrameQueue = [];

  // Create ffmpeg transcoder to convert audio to PCM
  const ffmpeg = new prism.FFmpeg({
    args: [
      "-i",
      filePath,
      "-analyzeduration",
      "0",
      "-loglevel",
      "0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
    ],
  });

  currentAudioStream = ffmpeg;

  // Buffer for collecting PCM data
  const frameSize = 960 * 2 * 2; // 960 samples * 2 channels * 2 bytes per sample = 20ms of audio
  let pcmBuffer = Buffer.alloc(0);

  ffmpeg.on("data", (chunk) => {
    pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

    // Process complete frames and add to queue
    while (pcmBuffer.length >= frameSize) {
      const frame = pcmBuffer.slice(0, frameSize);
      pcmBuffer = pcmBuffer.slice(frameSize);

      // Encode to Opus and add to queue
      const opusFrame = opusEncoder.encode(frame);
      audioFrameQueue.push(opusFrame);
    }
  });

  ffmpeg.on("end", () => {
    console.log("Audio file read complete, finishing playback...");
  });

  ffmpeg.on("error", (err) => {
    console.error("FFmpeg error:", err);
    stopAudio();
  });

  // Get the Discord voice server address
  const discordVoiceHost = voiceServerData.endpoint.split(":")[0];
  const discordVoicePort =
    parseInt(voiceServerData.endpoint.split(":")[1]) || 443;

  // Start sending frames at 20ms intervals
  audioInterval = setInterval(() => {
    if (audioFrameQueue.length > 0) {
      const opusFrame = audioFrameQueue.shift();

      // Create RTP header
      const rtpHeader = createRtpHeader(
        sequenceNumber,
        timestamp,
        voiceUdpInfo.ssrc
      );

      // Encrypt and create packet
      const packet = encryptAudio(rtpHeader, opusFrame);

      // Send via UDP to the voice server's UDP port (from Ready event)
      udpSocket.send(packet, voiceUdpInfo.discordPort, voiceUdpInfo.discordIp);

      // Increment sequence and timestamp
      sequenceNumber = (sequenceNumber + 1) & 0xffff;
      timestamp = (timestamp + 960) >>> 0; // 960 samples at 48kHz = 20ms
    } else if (!currentAudioStream) {
      // Stream ended and queue is empty
      console.log("Audio playback finished");
      stopAudio();
    }
  }, 20); // 20ms per frame
}

export function stopAudio() {
  if (currentAudioStream) {
    currentAudioStream.destroy();
    currentAudioStream = null;
  }
  if (audioInterval) {
    clearInterval(audioInterval);
    audioInterval = null;
  }
  audioFrameQueue = [];
  isPlaying = false;
  if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
    setSpeaking(false);
  }
}
