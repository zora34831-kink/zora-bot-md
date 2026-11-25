
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadContentFromMessage
} from "@whiskeysockets/baileys";

import pino from "pino";
import qrcode from "qrcode-terminal";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

const BOT_NAME = "ZORA BOT";
const VERSION = "1.1.0";
const PREFIX = ".";
const MAX_DURATION = 30;

const pending = new Map();
let reconnecting = false;

function unwrap(message) {
  let m = message || {};

  for (let i = 0; i < 5; i++) {
    const next =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message;

    if (!next) break;
    m = next;
  }

  return m;
}

function findMedia(message) {
  const m = unwrap(message);

  const types = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["stickerMessage", "sticker"],
    ["documentMessage", "document"]
  ];

  for (const [key, type] of types) {
    const media = m[key];

    if (!media) continue;

    if (
      type === "document" &&
      !String(media.mimetype || "").startsWith("audio/")
    ) continue;

    return { media, type };
  }

  return null;
}

function getMedia(message) {
  const own = findMedia(message);
  if (own) return own;

  const m = unwrap(message);

  let context = null;

  for (const value of Object.values(m)) {
    if (value?.contextInfo) {
      context = value.contextInfo;
      break;
    }
  }

  if (context?.quotedMessage) {
    return findMedia(context.quotedMessage);
  }

  return null;
}

function getText(message) {
  const m = unwrap(message);

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.audioMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

function extension(media, type) {
  const mime = (media.mimetype || "").toLowerCase();

  if (type === "image") {
    if (mime.includes("png")) return "png";
    if (mime.includes("webp")) return "webp";
    return "jpg";
  }

  if (type === "video") return "mp4";
  if (type === "sticker") return "webp";

  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";

  return "audio";
}

async function download(media, type, dir, name) {
  const stream = await downloadContentFromMessage(
    media,
    type
  );

  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  if (!buffer.length) {
    throw new Error("Media gagal diunduh.");
  }

  const file = path.join(
    dir,
    name + "." + extension(media, type)
  );

  await fs.writeFile(file, buffer);

  return file;
}

async function ffmpeg(args) {
  try {
    await exec(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", ...args],
      { timeout: 120000 }
    );
  } catch (error) {
    throw new Error(
      error.stderr?.toString() || "FFmpeg error."
    );
  }
}

async function reply(sock, jid, msg, text) {
  return sock.sendMessage(
    jid,
    { text },
    { quoted: msg }
  );
}

// STICKER MAKER

async function sticker(sock, jid, msg, dir) {
  const item = getMedia(msg.message);

  if (
    !item ||
    !["image", "video"].includes(item.type)
  ) {
    throw new Error(
      "Reply gambar/video dengan .sticker."
    );
  }

  const input = await download(
    item.media,
    item.type,
    dir,
    "input"
  );

  const output = path.join(dir, "sticker.webp");

  if (item.type === "image") {
    await ffmpeg([
      "-i", input,
      "-frames:v", "1",
      "-vf",
      "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba",
      "-c:v", "libwebp",
      "-q:v", "75",
      output
    ]);
  } else {
    await ffmpeg([
      "-i", input,
      "-t", "6",
      "-vf",
      "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p",
      "-c:v", "libwebp",
      "-loop", "0",
      "-an",
      output
    ]);
  }

  await sock.sendMessage(
    jid,
    {
      sticker: await fs.readFile(output),
      mimetype: "image/webp"
    },
    { quoted: msg }
  );
}

// STICKER TO IMAGE

async function toimg(sock, jid, msg, dir) {
  const item = getMedia(msg.message);

  if (!item || item.type !== "sticker") {
    throw new Error("Reply stiker dengan .toimg.");
  }

  const input = await download(
    item.media,
    item.type,
    dir,
    "sticker"
  );

  const output = path.join(dir, "image.png");

  await ffmpeg([
    "-i", input,
    "-frames:v", "1",
    output
  ]);

  await sock.sendMessage(
    jid,
    {
      image: await fs.readFile(output),
      caption: "ZORA BOT"
    },
    { quoted: msg }
  );
}

// AUDIO EFFECTS

async function audio(sock, jid, msg, dir, command) {
  const item = getMedia(msg.message);

  if (!item || item.type !== "audio") {
    throw new Error(
      "Reply audio dengan ." + command
    );
  }

  const input = await download(
    item.media,
    item.type,
    dir,
    "audio"
  );

  const output = path.join(dir, command + ".mp3");

  const filters = {
    tomp3: null,
    bass: "bass=g=8",
    slow: "atempo=0.8",
    fast: "atempo=1.25"
  };

  const args = ["-i", input, "-vn"];

  if (filters[command]) {
    args.push("-af", filters[command]);
  }

  args.push(
    "-t", String(MAX_DURATION),
    "-c:a", "libmp3lame",
    "-q:a", "4",
    output
  );

  await ffmpeg(args);

  await sock.sendMessage(
    jid,
    {
      audio: await fs.readFile(output),
      mimetype: "audio/mpeg",
      fileName: command + ".mp3",
      ptt: false
    },
    { quoted: msg }
  );
}

// STCAUDIO

async function startStc(sock, jid, msg, dir, key) {
  const item = getMedia(msg.message);

  if (
    !item ||
    !["image", "video"].includes(item.type)
  ) {
    throw new Error(
      "Reply gambar/video dengan .stcaudio."
    );
  }

  const input = await download(
    item.media,
    item.type,
    dir,
    "visual"
  );

  const old = pending.get(key);

  if (old) {
    clearTimeout(old.timer);

    await fs.rm(
      old.dir,
      { recursive: true, force: true }
    );
  }

  const timer = setTimeout(async () => {
    const current = pending.get(key);

    if (current?.dir === dir) {
      pending.delete(key);

      await fs.rm(
        dir,
        { recursive: true, force: true }
      );
    }
  }, 120000);

  pending.set(key, {
    dir,
    input,
    type: item.type,
    timer
  });

  await reply(
    sock,
    jid,
    msg,
    "Gambar/video diterima!\n\nSekarang kirim audio dalam 2 menit."
  );
}

async function finishStc(
  sock,
  jid,
  msg,
  data,
  audioItem
) {
  const audioFile = await download(
    audioItem.media,
    audioItem.type,
    data.dir,
    "sound"
  );

  const output = path.join(
    data.dir,
    "ZORA-STCAUDIO.mp4"
  );

  const args = [];

  if (data.type === "image") {
    args.push(
      "-loop", "1",
      "-i", data.input,
      "-i", audioFile
    );
  } else {
    args.push(
      "-i", data.input,
      "-i", audioFile
    );
  }

  args.push(
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    "-t", String(MAX_DURATION),
    "-shortest",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output
  );

  await ffmpeg(args);

  await sock.sendMessage(
    jid,
    {
      video: await fs.readFile(output),
      mimetype: "video/mp4",
      fileName: "ZORA-STCAUDIO.mp4",
      caption: "ZORA STCAUDIO"
    },
    { quoted: msg }
  );
}

// MESSAGE HANDLER

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  if (
    !jid ||
    jid === "status@broadcast" ||
    jid.endsWith("@newsletter")
  ) return;

  const sender = msg.key.participant || jid;
  const key = jid + ":" + sender;

  const ownMedia = findMedia(msg.message);
  const waiting = pending.get(key);

  // Terima audio setelah perintah stcaudio

  if (waiting && ownMedia?.type === "audio") {
    try {
      await reply(
        sock,
        jid,
        msg,
        "Audio diterima. Membuat video..."
      );

      await finishStc(
        sock,
        jid,
        msg,
        waiting,
        ownMedia
      );
    } catch (error) {
      await reply(
        sock,
        jid,
        msg,
        "STCAUDIO gagal: " + error.message
      );
    } finally {
      clearTimeout(waiting.timer);
      pending.delete(key);

      await fs.rm(
        waiting.dir,
        { recursive: true, force: true }
      );
    }

    return;
  }

  const text = getText(msg.message);

  if (!text.startsWith(PREFIX)) return;

  const parts = text.split(/\s+/);

  const command = parts
    .shift()
    .slice(PREFIX.length)
    .toLowerCase();

  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "zora-")
  );

  try {
    switch (command) {
      case "menu":
      case "help":
        await reply(sock, jid, msg, [
          "╭━━━「 ZORA BOT 」",
          "┃ Version: " + VERSION,
          "┃",
          "┣━━ STICKER",
          "┃ .sticker",
          "┃ .toimg",
          "┃",
          "┣━━ AUDIO",
          "┃ .tomp3",
          "┃ .bass",
          "┃ .slow",
          "┃ .fast",
          "┃",
          "┣━━ SPECIAL",
          "┃ .stcaudio",
          "┃",
          "┣━━ GENERAL",
          "┃ .ping",
          "┃ .info",
          "┃",
          "╰━━ BY ZORA"
        ].join("\n"));
        break;

      case "ping":
        await reply(
          sock, jid, msg,
          "Pong! ZORA BOT aktif."
        );
        break;

      case "info":
        await reply(
          sock, jid, msg,
          "ZORA BOT\nVersion: " + VERSION +
          "\nStatus: Online\nNode.js + FFmpeg"
        );
        break;

      case "sticker":
      case "s":
        await sticker(sock, jid, msg, dir);
        break;

      case "toimg":
        await toimg(sock, jid, msg, dir);
        break;

      case "tomp3":
      case "bass":
      case "slow":
      case "fast":
        await audio(sock, jid, msg, dir, command);
        break;

      case "stcaudio":
        await startStc(
          sock, jid, msg, dir, key
        );
        break;

      default:
        await reply(
          sock, jid, msg,
          "Command tidak ditemukan. Ketik .menu"
        );
    }
  } catch (error) {
    console.error(error);

    await reply(
      sock, jid, msg,
      "Error: " + error.message
    );
  } finally {
    if (pending.get(key)?.dir !== dir) {
      await fs.rm(
        dir,
        { recursive: true, force: true }
      );
    }
  }
}

// START BOT

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("./session");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["ZORA BOT", "Chrome", VERSION],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", update => {
    const {
      connection,
      lastDisconnect,
      qr
    } = update;

    if (qr) {
      console.log("\nSCAN QR ZORA BOT:\n");

      qrcode.generate(qr, {
        small: true
      });
    }

    if (connection === "open") {
      reconnecting = false;

      console.log(
        "\nZORA BOT ONLINE - VERSION " + VERSION
      );
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      if (
        code !== DisconnectReason.loggedOut &&
        !reconnecting
      ) {
        reconnecting = true;

        setTimeout(() => {
          reconnecting = false;
          startBot().catch(console.error);
        }, 3000);
      } else {
        console.log(
          "WhatsApp logout. Pairing ulang diperlukan."
        );
      }
    }
  });

  sock.ev.on(
    "messages.upsert",
    async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        await handleMessage(sock, msg)
          .catch(console.error);
      }
    }
  );
}

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

startBot().catch(console.error);
