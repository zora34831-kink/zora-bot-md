
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFile } = require("child_process");
const { promisify } = require("util");

const exec = promisify(execFile);

const BOT_NAME = "ZORA BOT";
const PREFIX = ".";
const SESSION = "./session";
const TEMP = "./temp";

if (!fs.existsSync(TEMP)) {
    fs.mkdirSync(TEMP, { recursive: true });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => resolve(answer.trim()));
    });
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
    const context = message.message?.extendedTextMessage?.contextInfo;

    return context?.quotedMessage
        ? getMedia(context.quotedMessage)
        : null;
}

async function ffmpeg(input, output, args = []) {
    await exec("ffmpeg", [
        "-y", "-i", input, ...args, output
    ]);
}

async function reply(sock, jid, text, quoted) {
    return sock.sendMessage(jid, { text }, { quoted });
}

async function startBot() {
    const { state, saveCreds } =
        await useMultiFileAuthState(SESSION);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ["ZORA BOT", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    let pairingStarted = false;

    sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
            console.log("[ZORA BOT] Menghubungkan...");
        }

        if (connection === "open") {
            console.log("[ZORA BOT] BERHASIL LOGIN!");
            console.log("[ZORA BOT] Bot aktif.");
        }

        if (connection === "close") {
            const status =
                lastDisconnect?.error?.output?.statusCode;

            console.log("[ZORA BOT] Koneksi terputus:", status);

            if (status !== DisconnectReason.loggedOut) {
                console.log("[ZORA BOT] Mencoba koneksi ulang...");
                await sleep(3000);
                startBot();
            } else {
                console.log("[ZORA BOT] Sesi logout. Pairing ulang diperlukan.");
            }
        }
    });

    // PAIRING NOMOR TELEPON
    if (!state.creds.registered && !pairingStarted) {
        pairingStarted = true;

        console.log("\n================================");
        console.log("          ZORA BOT");
        console.log("================================");

        let phone = await ask("Masukkan nomor WhatsApp (628xxx): ");

        phone = phone.replace(/[^0-9]/g, "");

        if (!/^[0-9]{10,15}$/.test(phone)) {
            console.log("Nomor tidak valid. Gunakan format 628xxx.");
            rl.close();
            return;
        }

        try {
            console.log("\nMeminta kode pairing...");

            await sleep(3000);

            const code = await sock.requestPairingCode(phone);

            console.log("\n================================");
            console.log("       ZORA BOT PAIRING");
            console.log("================================");
            console.log("NOMOR:", phone);
            console.log("KODE:", code);
            console.log("================================");
            console.log("Masukkan kode melalui WhatsApp");
            console.log("Perangkat tertaut > Tautkan dengan nomor telepon\n");

        } catch (error) {
            console.log("PAIRING ERROR:", error.message);
        }

        rl.close();
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

                switch (command) {
                    case "menu":
                    case "help":
                        await reply(sock, jid,
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
╰━━━━━━━━━━━━━━━━━━`, msg);
                        break;

                    case "ping":
                        await reply(sock, jid, "Pong! ZORA BOT aktif.", msg);
                        break;

                    case "info":
                        await reply(sock, jid,
`BOT: ZORA BOT
VERSION: 1.0.0
PLATFORM: WhatsApp
STATUS: ONLINE`, msg);
                        break;

                    case "sticker":
                    case "s": {
                        if (!media || !["image", "video"].includes(media.type)) {
                            await reply(sock, jid, "Kirim atau balas gambar/video dengan .sticker", msg);
                            break;
                        }

                        const id = Date.now();
                        const input = path.join(TEMP, `${id}_input`);
                        const output = path.join(TEMP, `${id}.webp`);

                        fs.writeFileSync(input,
                            await downloadMedia(media.message, media.type));

                        const filters =
                            "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white";

                        await ffmpeg(input, output, [
                            ...(media.type === "video" ? ["-t", "8"] : []),
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
                            await reply(sock, jid, "Balas sticker dengan .toimg", msg);
                            break;
                        }

                        const id = Date.now();
                        const input = path.join(TEMP, `${id}.webp`);
                        const output = path.join(TEMP, `${id}.png`);

                        fs.writeFileSync(input,
                            await downloadMedia(media.message, "sticker"));

                        await ffmpeg(input, output);

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
                            await reply(sock, jid, "Balas audio dengan ." + command, msg);
                            break;
                        }

                        const id = Date.now();
                        const input = path.join(TEMP, `${id}_input`);
                        const output = path.join(TEMP, `${id}.mp3`);

                        fs.writeFileSync(input,
                            await downloadMedia(media.message, "audio"));

                        let filters = [];

                        if (command === "bass") filters = ["-af", "bass=g=10"];
                        if (command === "slow") filters = ["-af", "atempo=0.8"];
                        if (command === "fast") filters = ["-af", "atempo=1.25"];

                        await ffmpeg(input, output, [
                            "-vn", ...filters,
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
                        await reply(sock, jid,
                            "Fitur stcaudio belum tersedia.", msg);
                        break;

                    default:
                        await reply(sock, jid,
                            `Perintah tidak ditemukan. Ketik ${PREFIX}menu`, msg);
                }

            } catch (error) {
                console.error("[COMMAND ERROR]", error);
                await reply(sock, msg.key.remoteJid,
                    "Terjadi kesalahan saat menjalankan perintah.", msg)
                    .catch(() => {});
            }
        }
    });

    return sock;
}

startBot().catch(error => {
    console.error("[FATAL]", error);
});
