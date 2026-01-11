import WebSocket from "ws";
import dgram from "dgram";
import { randomBytes } from "crypto";
import fs from "fs";
import { spawn } from "child_process";
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

// Recording state
let isRecording = false;
let recordingStreams = new Map(); // SSRC -> { decoder, pcmChunks, lastSequence }
let recordingStartTime = null;

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
        console.log("Secret key SET TO:", secretKey.toString("hex"));
        playAudio("./song.mp3");
        startRecording();
        break;

      case 6: // Heartbeat ACK
        break;
    }
  });

  voiceWs.on("close", (code, reason) => {
    const filename = stopRecording();
    console.log("Saved to: ", filename);
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
    } else {
      // This is voice data - handle recording if enabled
      handleIncomingVoicePacket(msg);
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
let playbackStartTime = null;
let framesSent = 0;

// Pre-buffer configuration: buffer ~300ms before starting playback
const PRE_BUFFER_FRAMES = 15;

// Pre-encode a silence frame for queue underrun
const silenceFrame = opusEncoder.encode(Buffer.alloc(960 * 2 * 2));

// Send a single audio frame over UDP
function sendAudioFrame(opusFrame) {
  const rtpHeader = createRtpHeader(
    sequenceNumber,
    timestamp,
    voiceUdpInfo.ssrc
  );

  const packet = encryptAudio(rtpHeader, opusFrame);
  udpSocket.send(packet, voiceUdpInfo.discordPort, voiceUdpInfo.discordIp);

  sequenceNumber = (sequenceNumber + 1) & 0xffff;
  timestamp = (timestamp + 960) >>> 0; // 960 samples at 48kHz = 20ms
}

// Drift-compensated audio frame sender using high-resolution timer
function startSendingFrames() {
  playbackStartTime = process.hrtime.bigint();
  framesSent = 0;

  function sendNext() {
    if (!isPlaying) return;

    const elapsed = Number(process.hrtime.bigint() - playbackStartTime) / 1_000_000; // ms
    const expectedFrames = Math.floor(elapsed / 20);

    // Send all frames that should have been sent by now
    while (framesSent < expectedFrames) {
      if (audioFrameQueue.length > 0) {
        sendAudioFrame(audioFrameQueue.shift());
      } else if (currentAudioStream) {
        // Queue underrun but stream still active - send silence
        sendAudioFrame(silenceFrame);
      } else {
        // Stream ended and queue empty - stop playback
        console.log("Audio playback finished");
        stopAudio();
        return;
      }
      framesSent++;
    }

    // Schedule next check with drift compensation
    const nextFrameTime = (framesSent + 1) * 20;
    const delay = Math.max(1, nextFrameTime - elapsed);
    audioInterval = setTimeout(sendNext, delay);
  }

  sendNext();
}

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
  let playbackStarted = false;

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

    // Start playback only after buffering enough frames (prevents choppy start)
    if (!playbackStarted && audioFrameQueue.length >= PRE_BUFFER_FRAMES) {
      playbackStarted = true;
      console.log(`Pre-buffered ${PRE_BUFFER_FRAMES} frames, starting playback...`);
      startSendingFrames();
    }
  });

  ffmpeg.on("end", () => {
    console.log("Audio file read complete, finishing playback...");
    // If stream ends before we started (very short file), start now
    if (!playbackStarted && audioFrameQueue.length > 0) {
      playbackStarted = true;
      startSendingFrames();
    }
  });

  ffmpeg.on("error", (err) => {
    console.error("FFmpeg error:", err);
    stopAudio();
  });
}

export function stopAudio() {
  if (currentAudioStream) {
    currentAudioStream.destroy();
    currentAudioStream = null;
  }
  if (audioInterval) {
    clearTimeout(audioInterval);
    audioInterval = null;
  }
  audioFrameQueue = [];
  isPlaying = false;
  playbackStartTime = null;
  framesSent = 0;
  if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
    setSpeaking(false);
  }
}

// ============ Voice Recording Functions ============

function handleIncomingVoicePacket(packet) {
  if (!isRecording || !secretKey || !sodiumReady) {
    return;
  }

  // Minimum RTP packet size: 12 byte header + some audio + 4 byte nonce
  if (packet.length < 20) {
    return;
  }

  // Parse RTP header
  const version = (packet[0] >> 6) & 0x03;
  if (version !== 2) {
    return; // Not a valid RTP packet
  }

  // Check payload type - must be 120 for Opus audio
  const payloadType = packet[1] & 0x7f;
  if (payloadType !== 120) {
    return; // Not Opus audio (might be RTCP)
  }

  const hasExtension = (packet[0] & 0x10) !== 0;
  const sequence = packet.readUInt16BE(2);
  const rtpTimestamp = packet.readUInt32BE(4);
  const ssrc = packet.readUInt32BE(8);

  // For testing: try to decrypt our own packets too
  const isOwnPacket = ssrc === voiceUdpInfo.ssrc;
  if (isOwnPacket) {
    console.log("Attempting to decrypt OWN packet for testing...");
  }

  // Packet structure: [RTP header + extension (AAD)] [encrypted data] [4-byte nonce]
  // Calculate full header length including extension
  let headerLength = 12;
  if (hasExtension) {
    // Extension: 4-byte header + N*4 bytes of data
    const extLengthWords = packet.readUInt16BE(14); // Length in 32-bit words
    headerLength = 12 + 4 + extLengthWords * 4;
  }

  const rtpHeader = packet.slice(0, headerLength); // Full header as AAD
  const encryptedPayload = packet.slice(headerLength, packet.length - 4);
  const nonceBytes = packet.slice(packet.length - 4);

  // Debug: show first packet details
  if (!recordingStreams.has(ssrc)) {
    console.log("=== FIRST PACKET FROM SSRC", ssrc, "===");
    console.log("Full packet hex:", packet.toString("hex"));
    console.log("Packet length:", packet.length);
    console.log("Header length (incl ext):", headerLength);
    console.log("RTP header:", rtpHeader.toString("hex"));
    console.log("Encrypted payload length:", encryptedPayload.length);
    console.log("Nonce bytes:", nonceBytes.toString("hex"));
  }

  // Reconstruct the 24-byte nonce
  // The nonce bytes appear to be little-endian, but we need big-endian like we use for sending
  const nonce = Buffer.alloc(24);
  const nonceValue = nonceBytes.readUInt32LE(0); // Read as little-endian
  nonce.writeUInt32BE(nonceValue, 0); // Write as big-endian (matching our encrypt)

  try {
    // Decrypt using XChaCha20-Poly1305
    const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // nsec (unused)
      encryptedPayload,
      rtpHeader, // Additional authenticated data (12-byte base header only)
      nonce,
      secretKey
    );

    if (!decrypted) {
      return;
    }

    // Decrypted data is the Opus audio (extension was in AAD, not encrypted)
    const opusData = Buffer.from(decrypted);

    // Get or create decoder for this SSRC
    if (!recordingStreams.has(ssrc)) {
      recordingStreams.set(ssrc, {
        decoder: new OpusEncoder(48000, 2),
        pcmChunks: [],
        lastSequence: sequence,
        lastTimestamp: rtpTimestamp,
      });
      console.log(`Recording new speaker: SSRC ${ssrc}`);
    }

    const stream = recordingStreams.get(ssrc);

    // Decode Opus to PCM
    const pcm = stream.decoder.decode(opusData);
    stream.pcmChunks.push(pcm);
    stream.lastSequence = sequence;
    stream.lastTimestamp = rtpTimestamp;
  } catch (err) {
    console.error("Voice packet processing failed:", err.message);
  }
}

export function startRecording() {
  if (!secretKey) {
    console.error("Cannot start recording: voice session not established");
    return false;
  }

  if (!sodiumReady) {
    console.error("Cannot start recording: encryption not ready");
    return false;
  }

  console.log("Starting voice recording...");
  isRecording = true;
  recordingStreams.clear();
  recordingStartTime = Date.now();
  return true;
}

export function stopRecording() {
  if (!isRecording) {
    console.log("Not currently recording");
    return null;
  }

  console.log("Stopping voice recording...");
  isRecording = false;

  // Collect all PCM data from all streams
  const allPcmChunks = [];
  for (const [ssrc, stream] of recordingStreams) {
    console.log(`SSRC ${ssrc}: ${stream.pcmChunks.length} chunks`);
    allPcmChunks.push(...stream.pcmChunks);
  }

  if (allPcmChunks.length === 0) {
    console.log("No audio data recorded");
    recordingStreams.clear();
    return null;
  }

  // Combine all PCM data
  const combinedPcm = Buffer.concat(allPcmChunks);
  console.log(`Total PCM data: ${combinedPcm.length} bytes`);

  // Generate output filename
  const filename = `recording_${recordingStartTime}.mp3`;

  // Use ffmpeg to convert PCM to MP3
  const ffmpeg = spawn("ffmpeg", [
    "-f",
    "s16le", // Input format: signed 16-bit little-endian
    "-ar",
    "48000", // Sample rate: 48kHz
    "-ac",
    "2", // Channels: stereo
    "-i",
    "pipe:0", // Input from stdin
    "-b:a",
    "128k", // Bitrate: 128kbps
    "-y", // Overwrite output file
    filename,
  ]);

  ffmpeg.on("error", (err) => {
    console.error("FFmpeg error:", err);
  });

  ffmpeg.on("close", (code) => {
    if (code === 0) {
      console.log(`Recording saved to ${filename}`);
    } else {
      console.error(`FFmpeg exited with code ${code}`);
    }
  });

  // Write PCM data to ffmpeg stdin
  ffmpeg.stdin.write(combinedPcm);
  ffmpeg.stdin.end();

  // Clear recording state
  recordingStreams.clear();
  recordingStartTime = null;

  return filename;
}
