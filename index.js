
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const exec = promisify(execFile);

const BOT_NAME = "ZORA BOT";
const PAIRING_CODE = "ZORAXBOT";

// GANTI DENGAN NOMOR WHATSAPP BOT
// Contoh: 6281234567890
const PHONE_NUMBER = "628xxxxxxxxxx";

const PREFIX = ".";
const SESSION_DIR = "./session";
const TEMP_DIR = "./temp";

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);

    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }

    return buffer;
}

function getMessageContent(message) {
    let msg = message;

    while (msg) {
        if (msg.imageMessage) {
            return { message: msg.imageMessage, type: "image" };
        }

        if (msg.videoMessage) {
            return { message: msg.videoMessage, type: "video" };
        }

        if (msg.audioMessage) {
            return { message: msg.audioMessage, type: "audio" };
        }

        if (msg.stickerMessage) {
            return { message: msg.stickerMessage, type: "sticker" };
        }

        if (msg.documentMessage) {
            return { message: msg.documentMessage, type: "document" };
        }

        if (msg.ephemeralMessage) {
            msg = msg.ephemeralMessage.message;
        } else if (msg.viewOnceMessage) {
            msg = msg.viewOnceMessage.message;
        } else if (msg.viewOnceMessageV2) {
            msg = msg.viewOnceMessageV2.message;
        } else if (msg.documentWithCaptionMessage) {
            msg = msg.documentWithCaptionMessage.message;
        } else {
            break;
        }
    }

    return null;
}

function getQuotedMedia(message) {
    const context =
        message.message?.extendedTextMessage?.contextInfo ||
        message.message?.imageMessage?.contextInfo ||
        message.message?.videoMessage?.contextInfo ||
        message.message?.audioMessage?.contextInfo;

    if (!context?.quotedMessage) return null;

    return getMessageContent(context.quotedMessage);
}

async function ffmpeg(input, output, args = []) {
    await exec("ffmpeg", [
        "-y",
        "-i", input,
        ...args,
        output
    ]);

    return output;
}

async function sendText(sock, jid, text, quoted) {
    return sock.sendMessage(jid, { text }, { quoted });
}

async function startBot() {
    const { state, saveCreds } =
        await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["ZORA BOT", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
            console.log("ZORA BOT sedang menghubungkan...");
        }

        if (connection === "open") {
            console.log("ZORA BOT berhasil terhubung!");
        }

        if (connection === "close") {
            const status =
                lastDisconnect?.error?.output?.statusCode;

            if (status !== DisconnectReason.loggedOut) {
                console.log("Koneksi terputus. Menghubungkan ulang...");
                await sleep(3000);
                startBot();
            } else {
                console.log("Sesi logout. Hapus sesi hanya jika ingin pairing ulang.");
            }
        }
    });

    // PAIRING NOMOR TELEPON
    if (!state.creds.registered) {
        if (!/^[0-9]{10,15}$/.test(PHONE_NUMBER)) {
            console.log("Isi PHONE_NUMBER dengan nomor WhatsApp yang benar.");
            return;
        }

        try {
            const code = await sock.requestPairingCode(
                PHONE_NUMBER,
                PAIRING_CODE
            );

            console.log("\n================================");
            console.log("          ZORA BOT");
            console.log("================================");
            console.log("Nomor:", PHONE_NUMBER);
            console.log("Kode pairing:", code);
            console.log("================================\n");
        } catch (error) {
            console.error("Gagal meminta kode pairing:", error.message);
        }
    }

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;
                if (!jid || jid === "status@broadcast") continue;

                const body =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    "";

                if (!body.startsWith(PREFIX)) continue;

                const args = body.slice(1).trim().split(/\s+/);
                const command = (args.shift() || "").toLowerCase();

                const quoted = msg.message.extendedTextMessage
                    ?.contextInfo?.quotedMessage;

                const media =
                    getMessageContent(msg.message) ||
                    (quoted ? getMessageContent(quoted) : null);

                const reply = text =>
                    sendText(sock, jid, text, msg);

                switch (command) {
                    case "menu":
                    case "help":
                        await reply(
`╭━━━〔 ${BOT_NAME} 〕━━━
┃
┃ .menu
┃ .ping
┃ .info
┃
┃ MEDIA
┃ .sticker
┃ .toimg
┃
┃ AUDIO
┃ .tomp3
┃ .bass
┃ .slow
┃ .fast
┃
┃ VIDEO
┃ .stcaudio
┃
╰━━━━━━━━━━━━━━━━━━`
                        );
                        break;

                    case "ping":
                        await reply("Pong! ZORA BOT aktif.");
                        break;

                    case "info":
                        await reply(
`BOT: ${BOT_NAME}
VERSION: 1.0.0
PLATFORM: WhatsApp
LIBRARY: Baileys
STATUS: Online`
                        );
                        break;

                    case "sticker":
                    case "s": {
                        if (!media || !["image", "video"].includes(media.type)) {
                            await reply("Kirim atau balas gambar/video dengan .sticker");
                            break;
                        }

                        const input = path.join(TEMP_DIR, `${Date.now()}_in`);
                        const output = path.join(TEMP_DIR, `${Date.now()}.webp`);

                        const buffer = await downloadMedia(
                            media.message,
                            media.type
                        );

                        fs.writeFileSync(input, buffer);

                        const inputArgs = media.type === "video"
                            ? ["-t", "8", "-vf", "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white", "-loop", "0"]
                            : ["-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white"];

                        await ffmpeg(input, output, [
                            ...inputArgs,
                            "-vcodec", "libwebp"
                        ]);

                        await sock.sendMessage(jid, {
                            sticker: fs.readFileSync(output)
                        }, { quoted: msg });

                        fs.unlinkSync(input);
                        fs.unlinkSync(output);
                        break;
                    }

                    case "toimg": {
                        if (!media || media.type !== "sticker") {
                            await reply("Balas sticker dengan .toimg");
                            break;
                        }

                        const input = path.join(TEMP_DIR, `${Date.now()}.webp`);
                        const output = path.join(TEMP_DIR, `${Date.now()}.png`);

                        const buffer = await downloadMedia(
                            media.message,
                            "sticker"
                        );

                        fs.writeFileSync(input, buffer);
                        await ffmpeg(input, output, []);

                        await sock.sendMessage(jid, {
                            image: fs.readFileSync(output),
                            caption: "ZORA BOT"
                        }, { quoted: msg });

                        fs.unlinkSync(input);
                        fs.unlinkSync(output);
                        break;
                    }

                    case "tomp3": {
                        if (!media || media.type !== "audio") {
                            await reply("Balas pesan audio dengan .tomp3");
                            break;
                        }

                        const input = path.join(TEMP_DIR, `${Date.now()}_in`);
                        const output = path.join(TEMP_DIR, `${Date.now()}.mp3`);

                        fs.writeFileSync(
                            input,
                            await downloadMedia(media.message, "audio")
                        );

                        await ffmpeg(input, output, [
                            "-vn",
                            "-acodec", "libmp3lame",
                            "-q:a", "2"
                        ]);

                        await sock.sendMessage(jid, {
                            audio: fs.readFileSync(output),
                            mimetype: "audio/mpeg",
                            fileName: "zora.mp3"
                        }, { quoted: msg });

                        fs.unlinkSync(input);
                        fs.unlinkSync(output);
                        break;
                    }

                    case "bass":
                    case "slow":
                    case "fast": {
                        if (!media || media.type !== "audio") {
                            await reply("Balas pesan audio dengan ." + command);
                            break;
                        }

                        const input = path.join(TEMP_DIR, `${Date.now()}_in`);
                        const output = path.join(TEMP_DIR, `${Date.now()}.mp3`);

                        fs.writeFileSync(
                            input,
                            await downloadMedia(media.message, "audio")
                        );

                        let filter = "volume=1";

                        if (command === "bass") {
                            filter = "bass=g=10";
                        }

                        if (command === "slow") {
                            filter = "atempo=0.8";
                        }

                        if (command === "fast") {
                            filter = "atempo=1.25";
                        }

                        await ffmpeg(input, output, [
                            "-vn",
                            "-af", filter,
                            "-acodec", "libmp3lame"
                        ]);

                        await sock.sendMessage(jid, {
                            audio: fs.readFileSync(output),
                            mimetype: "audio/mpeg",
                            fileName: "zora.mp3"
                        }, { quoted: msg });

                        fs.unlinkSync(input);
                        fs.unlinkSync(output);
                        break;
                    }

                    case "stcaudio":
                        await reply(
                            "Fitur stcaudio belum diaktifkan pada versi ini."
                        );
                        break;

                    default:
                        await reply(
                            `Perintah tidak dikenal: ${PREFIX}${command}\nKetik .menu`
                        );
                }

            } catch (error) {
                console.error("Command error:", error);
                await sock.sendMessage(
                    msg.key.remoteJid,
                    { text: "Terjadi error saat menjalankan perintah." },
                    { quoted: msg }
                ).catch(() => {});
            }
        }
    });

    return sock;
}

startBot().catch(console.error);
