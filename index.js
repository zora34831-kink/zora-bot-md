
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import pino from "pino";
import qrcode from "qrcode-terminal";

const BOT_NAME = "ZORA BOT";
const VERSION = "1.0.0";
const PREFIX = ".";

let reconnecting = false;

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("./session");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["ZORA BOT", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nSCAN QR WHATSAPP ZORA BOT:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "connecting") {
      console.log("Menghubungkan ke WhatsApp...");
    }

    if (connection === "open") {
      reconnecting = false;
      console.log(`
╔══════════════════════════╗
       ZORA BOT ONLINE
       VERSION ${VERSION}
╚══════════════════════════╝
      `);
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      console.log("Koneksi terputus:", code);

      if (
        code !== DisconnectReason.loggedOut &&
        !reconnecting
      ) {
        reconnecting = true;
        setTimeout(() => {
          reconnecting = false;
          startBot().catch(console.error);
        }, 3000);
      } else if (code === DisconnectReason.loggedOut) {
        console.log("Session logout. Hubungkan ulang.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;

      if (
        !jid ||
        jid === "status@broadcast" ||
        jid.endsWith("@newsletter")
      ) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      if (!text.startsWith(PREFIX)) continue;

      const parts = text.trim().split(/\s+/);
      const command = parts.shift().slice(1).toLowerCase();
      const args = parts;

      try {
        switch (command) {

          case "menu":
          case "help":
            await sock.sendMessage(jid, {
              text: `
╭━━━「 ${BOT_NAME} 」
┃
┃ Version : ${VERSION}
┃ Prefix  : ${PREFIX}
┃
┣━━ STICKER
┃ .sticker
┃ .toimg
┃ .take
┃
┣━━ AUDIO
┃ .tomp3
┃ .bass
┃ .slow
┃ .fast
┃
┣━━ SPECIAL
┃ .stcaudio
┃
┣━━ GENERAL
┃ .ping
┃ .info
┃ .owner
┃
╰━━「 BY ZORA 」
              `
            }, { quoted: msg });
            break;

          case "ping":
            await sock.sendMessage(jid, {
              text: "Pong! ZORA BOT aktif."
            }, { quoted: msg });
            break;

          case "info":
            await sock.sendMessage(jid, {
              text:
                `╭━━「 ${BOT_NAME} 」\n` +
                `┃ Version: ${VERSION}\n` +
                `┃ Status: Online\n` +
                `┃ Platform: Node.js\n` +
                `╰━━ BY ZORA`
            }, { quoted: msg });
            break;

          case "owner":
            await sock.sendMessage(jid, {
              text: "Owner: ZORA"
            }, { quoted: msg });
            break;

          case "sticker":
          case "s":
            await sock.sendMessage(jid, {
              text:
                "Kirim atau reply gambar dengan caption .sticker. " +
                "Fitur konversi sticker sedang disiapkan."
            }, { quoted: msg });
            break;

          case "stcaudio":
            await sock.sendMessage(jid, {
              text:
                "Fitur STCAUDIO sedang disiapkan.\n\n" +
                "Format target: satu video MP4 dengan gambar/animasi dan audio."
            }, { quoted: msg });
            break;

          case "toimg":
          case "take":
          case "tomp3":
          case "bass":
          case "slow":
          case "fast":
            await sock.sendMessage(jid, {
              text: `Fitur .${command} sedang disiapkan.`
            }, { quoted: msg });
            break;

          default:
            await sock.sendMessage(jid, {
              text: "Command tidak ditemukan. Ketik .menu"
            }, { quoted: msg });
        }

      } catch (error) {
        console.error("Command error:", error);
      }
    }
  });
}

startBot().catch(console.error);
