
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const exec = promisify(execFile);

const BOT_NAME = "ZORA BOT";
const PHONE_NUMBER = "628xxxxxxxxxx"; // GANTI NOMOR BOT
const PREFIX = ".";
const SESSION_DIR = "./session";
const TEMP_DIR = "./temp";

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }

    return buffer;
}

function getMedia(message) {
    let msg = message;

    while (msg) {
        if (msg.imageMessage)
            return { message: msg.imageMessage, type: "image" };

        if (msg.videoMessage)
            return { message: msg.videoMessage, type: "video" };

        if (msg.audioMessage)
            return { message: msg.audioMessage, type: "audio" };

        if (msg.stickerMessage)
            return { message: msg.stickerMessage, type: "sticker" };

        if (msg.ephemeralMessage) {
            msg = msg.ephemeralMessage.message;
        } else if (msg.viewOnceMessage) {
            msg = msg.viewOnceMessage.message;
        } else if (msg.viewOnceMessageV2) {
            msg = msg.viewOnceMessageV2.message;
        } else {
            break;
        }
    }

    return null;
}

function getQuotedMedia(message) {
    const context =
        message.message?.extendedTextMessage?.contextInfo;

    return context?.quotedMessage
        ? getMedia(context.quotedMessage)
        : null;
}

async function runFFmpeg(input, output, args) {
    await exec("ffmpeg", [
        "-y",
        "-i", input,
        ...args,
        output
    ]);
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
        browser: ["ZORA BOT", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    });

    sock.ev.on("creds.update", saveCreds);

    let pairingRequested = false;

    sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
            console.log("[ZORA BOT] Menghubungkan ke WhatsApp...");
        }

        if (connection === "open") {
            console.log("[ZORA BOT] BERHASIL TERHUBUNG!");
        }

        if (
            connection === "close" &&
            lastDisconnect?.error?.output?.statusCode !==
            DisconnectReason.loggedOut
        ) {
            console.log("[ZORA BOT] Koneksi terputus. Mencoba ulang...");
            await sleep(3000);
            startBot();
        }

        if (
            connection === "close" &&
            lastDisconnect?.error?.output?.statusCode ===
            DisconnectReason.loggedOut
        ) {
            console.log("[ZORA BOT] Sesi logout. Pairing ulang diperlukan.");
        }
    });

    // PAIRING CODE
    if (!state.creds.registered && !pairingRequested) {
        pairingRequested = true;

        if (!/^[0-9]{10,15}$/.test(PHONE_NUMBER)) {
            console.log("\n[ERROR] Nomor belum benar!");
            console.log('Ubah PHONE_NUMBER menjadi contoh "6281234567890"');
            return;
        }

        console.log("\n================================");
        console.log("          ZORA BOT");
        console.log("================================");
        console.log("Meminta pairing code...");
        console.log("Nomor:", PHONE_NUMBER);

        try {
            await sleep(3000);

            const code = await sock.requestPairingCode(
                PHONE_NUMBER
            );

            console.log("\n================================");
            console.log("       ZORA BOT PAIRING");
            console.log("================================");
            console.log("PAIRING CODE:", code);
            console.log("================================\n");
            console.log("Buka WhatsApp > Perangkat tertaut");
            console.log("Pilih Tautkan dengan nomor telepon.");
        } catch (error) {
            console.error("\n[PAIRING ERROR]", error.message);
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

                const media =
                    getMedia(msg.message) ||
                    getQuotedMedia(msg);

                const reply = text =>
                    sendText(sock, jid, text, msg);

                switch (command) {
                    case "menu":
                    case "help":
                        await reply(
`╭━━━〔 ZORA BOT 〕━━━
┃
┃ GENERAL
┃ .menu
┃ .ping
┃ .info
┃
┃ STICKER
┃ .sticker
┃ .toimg
┃
┃ AUDIO
┃ .tomp3
┃ .bass
┃ .slow
┃ .fast
┃
╰━━━━━━━━━━━━━━━━━━`
                        );
                        break;

                    case "ping":
                        await reply("Pong! ZORA BOT aktif.");
                        break;

                    case "info":
                        await reply(
`BOT: ZORA BOT
VERSION: 1.0.0
PLATFORM: WhatsApp
STATUS: ONLINE`
                        );
                        break;

                    case "sticker":
                    case "s": {
                        if (!media ||
                            !["image", "video"].includes(media.type)) {
                            await reply("Kirim atau balas gambar/video dengan .sticker");
                            break;
                        }

                        const id = Date.now();
                        const input = path.join(TEMP_DIR, `${id}_input`);
                        const output = path.join(TEMP_DIR, `${id}.webp`);

                        fs.writeFileSync(
                            input,
                            await downloadMedia(media.message, media.type)
                        );

                        const filters =
                            "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white";

                        await runFFmpeg(input, output, [
                            ...(media.type === "video"
                                ? ["-t", "8"]
                                : []),
                            "-vf", filters,
                            "-vcodec", "libwebp",
                            "-loop", "0"
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

                        const id = Date.now();
                        const input = path.join(TEMP_DIR, `${id}.webp`);
                        const output = path.join(TEMP_DIR, `${id}.png`);

                        fs.writeFileSync(
                            input,
                            await downloadMedia(media.message, "sticker")
                        );

                        await runFFmpeg(input, output, []);

                        await sock.sendMessage(jid, {
                            image: fs.readFileSync(output),
                            caption: "ZORA BOT"
                        }, { quoted: msg });

                        fs.unlinkSync(input);
                        fs.unlinkSync(output);
                        break;
                    }

                    case "tomp3":
                    case "bass":
                    case "slow":
                    case "fast": {
                        if (!media || media.type !== "audio") {
                            await reply("Balas pesan audio dengan ." + command);
                            break;
                        }

                        const id = Date.now();
                        const input = path.join(TEMP_DIR, `${id}_input`);
                        const output = path.join(TEMP_DIR, `${id}.mp3`);

                        fs.writeFileSync(
                            input,
                            await downloadMedia(media.message, "audio")
                        );

                        let filters = [];

                        if (command === "bass") filters = ["-af", "bass=g=10"];
                        if (command === "slow") filters = ["-af", "atempo=0.8"];
                        if (command === "fast") filters = ["-af", "atempo=1.25"];

                        await runFFmpeg(input, output, [
                            "-vn",
                            ...filters,
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

                    case "stcaudio":
                        await reply(
                            "Fitur stcaudio belum tersedia di versi ini."
                        );
                        break;

                    default:
                        await reply(
                            `Perintah tidak ditemukan: ${PREFIX}${command}\nKetik .menu`
                        );
                }
            } catch (error) {
                console.error("[COMMAND ERROR]", error);
                await sendText(
                    sock,
                    msg.key.remoteJid,
                    "Terjadi kesalahan saat menjalankan perintah.",
                    msg
                ).catch(() => {});
            }
        }
    });

    return sock;
}

startBot().catch(error => {
    console.error("[FATAL ERROR]", error);
});
