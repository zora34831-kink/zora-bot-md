
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
const VERSION = "1.2.0";
const PREFIX = ".";
const SESSION = "./session";
const TEMP = "./temp";
const CUSTOM_PAIRING_CODE = "ZORAXBOT";

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

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

let reconnecting = false;
let pairingRequested = false;
let ownerJid = null;

function jidNumber(jid) {
    if (!jid || typeof jid !== "string") return "";
    return jid.split("@")[0].split(":")[0].replace(/\\D/g, "");
}

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

async function ffmpeg(input, output, args = []) {
    await exec("ffmpeg", [
        "-y", "-i", input, ...args, output
    ]);
}

async function reply(sock, jid, text, quoted) {
    return sock.sendMessage(
        jid,
        { text },
        { quoted }
    );
}

// ====================================
// START BOT
// ====================================

async function startBot() {
    const { state, saveCreds } =
        await useMultiFileAuthState(SESSION);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["ZORA BOT", "Chrome", VERSION],
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    // ====================================
    // PAIRING LOGIN - NO QR
    // ====================================

    if (!state.creds.registered && !pairingRequested) {
        pairingRequested = true;

        try {
            console.log("\n================================");
            console.log("          ZORA BOT");
            console.log("================================");

            let phone = await ask(
                "Masukkan nomor WhatsApp (628xxx): "
            );

            phone = phone.replace(/\D/g, "");

            if (!/^[0-9]{10,15}$/.test(phone)) {
                throw new Error(
                    "Nomor tidak valid. Gunakan format 628xxx."
                );
            }

            console.log("\nMenghubungkan ke WhatsApp...");

            // Tunggu socket mulai terhubung.
            await sleep(3000);

            let code;

            try {
                // Coba kode custom 8 karakter.
                code = await sock.requestPairingCode(
                    phone,
                    CUSTOM_PAIRING_CODE
                );
            } catch (customError) {
                console.log(
                    "Kode custom tidak diterima. Meminta kode otomatis..."
                );

                code = await sock.requestPairingCode(phone);
            }

            console.log("\n================================");
            console.log("       ZORA BOT PAIRING");
            console.log("================================");
            console.log("NOMOR:", phone);
            console.log("PAIRING CODE:", code);
            console.log("================================");
            console.log("Buka WhatsApp");
            console.log("Perangkat tertaut");
            console.log("Tautkan dengan nomor telepon");
            console.log("================================\n");

        } catch (error) {
            console.error(
                "\n[PAIRING ERROR]",
                error.message
            );

            pairingRequested = false;
        }
    }

    // ====================================
    // CONNECTION UPDATE - NO QR HANDLER
    // ====================================

    sock.ev.on("connection.update", async update => {
        const {
            connection,
            lastDisconnect
        } = update;

        if (connection === "connecting") {
            console.log("[ZORA BOT] Menghubungkan...");
        }

        if (connection === "open") {
            reconnecting = false;
            ownerJid = sock.user?.id || state.creds.me?.id || ownerJid;

            console.log("\n================================");
            console.log("       ZORA BOT ONLINE");
            console.log("================================");
            console.log("VERSION:", VERSION);
            console.log("STATUS: CONNECTED");
            console.log("================================\n");
        }

        if (connection === "close") {
            const status =
                lastDisconnect?.error?.output?.statusCode;

            console.log(
                "[ZORA BOT] Koneksi terputus:",
                status
            );

            if (status === DisconnectReason.loggedOut) {
                console.log(
                    "[ZORA BOT] Sesi logout. Pairing ulang diperlukan."
                );
                return;
            }

            if (!reconnecting) {
                reconnecting = true;

                console.log(
                    "[ZORA BOT] Menghubungkan ulang..."
                );

                setTimeout(() => {
                    pairingRequested = false;
                    startBot().catch(console.error);
                }, 5000);
            }
        }
    });

    // ====================================
    // MESSAGE HANDLER
    // ====================================

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
            try {
                if (!msg.message) continue;

                const jid = msg.key.remoteJid;

                if (!jid || jid === "status@broadcast") {
                    continue;
                }

                // Mode pribadi: hanya akun WhatsApp yang menautkan bot boleh memakai perintah.
                const senderJid = msg.key.fromMe
                    ? ownerJid
                    : (msg.key.participant || jid);
                const ownerNumber = jidNumber(ownerJid);
                const senderNumber = jidNumber(senderJid);
                if (!ownerNumber || !senderNumber || senderNumber !== ownerNumber) {
                    continue;
                }

                const body =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    "";

                if (!body.startsWith(PREFIX)) continue;

                const args = body
                    .slice(1)
                    .trim()
                    .split(/\s+/);

                const command =
                    (args.shift() || "").toLowerCase();

                const media =
                    getMedia(msg.message) ||
                    getQuotedMedia(msg);

                switch (command) {

                    // MENU
                    case "menu":
                    case "help":
                        await reply(sock, jid,
`╭━━━〔 ${BOT_NAME} 〕━━━
┃
┃ GENERAL
┃ .menu
┃ .ping
┃ .info
┃
┃ STICKER
┃ .sticker
┃ .stcaudio
┃ .toimg
┃
┃ AUDIO
┃ .tomp3
┃ .bass
┃ .slow
┃ .fast
┃
╰━━━━━━━━━━━━━━━━━━`,
                        msg);
                        break;

                    // PING
                    case "ping":
                        await reply(
                            sock,
                            jid,
                            "Pong! ZORA BOT aktif.",
                            msg
                        );
                        break;

                    // INFO
                    case "info":
                        await reply(sock, jid,
`BOT: ${BOT_NAME}
VERSION: ${VERSION}
PLATFORM: WhatsApp
STATUS: ONLINE`,
                        msg);
                        break;

                    // STICKER
                    case "sticker":
                    case "s": {
                        if (
                            !media ||
                            !["image", "video"].includes(media.type)
                        ) {
                            await reply(
                                sock,
                                jid,
                                "Kirim atau balas gambar/video dengan .sticker",
                                msg
                            );
                            break;
                        }

                        const id = Date.now();

                        const input = path.join(
                            TEMP,
                            `${id}_input`
                        );

                        const output = path.join(
                            TEMP,
                            `${id}.webp`
                        );

                        fs.writeFileSync(
                            input,
                            await downloadMedia(
                                media.message,
                                media.type
                            )
                        );

                        const filters =
                            "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white";

                        await ffmpeg(input, output, [
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

                    // VIDEO DENGAN AUDIO: output MP4 bergaya sticker, bukan sticker WebP native.
                    case "stcaudio": {
                        if (!media || media.type !== "video") {
                            await reply(sock, jid,
                                "Balas video yang memiliki suara dengan .stcaudio. Hasilnya berupa video MP4 bergaya sticker, karena sticker WhatsApp asli tidak mendukung audio.",
                                msg
                            );
                            break;
                        }

                        const id = Date.now();
                        const input = path.join(TEMP, `${id}_input.mp4`);
                        const output = path.join(TEMP, `${id}_stcaudio.mp4`);
                        try {
                            fs.writeFileSync(input, await downloadMedia(media.message, "video"));
                            await ffmpeg(input, output, [
                                "-t", "15",
                                "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black,fps=24",
                                "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
                                "-c:a", "aac", "-b:a", "96k",
                                "-movflags", "+faststart"
                            ]);
                            await sock.sendMessage(jid, {
                                video: fs.readFileSync(output),
                                mimetype: "video/mp4",
                                caption: "ZORA BOT • Video dengan audio"
                            }, { quoted: msg });
                        } finally {
                            if (fs.existsSync(input)) fs.unlinkSync(input);
                            if (fs.existsSync(output)) fs.unlinkSync(output);
                        }
                        break;
                    }

                    // STICKER TO IMAGE
                    case "toimg": {
                        if (!media || media.type !== "sticker") {
                            await reply(
                                sock,
                                jid,
                                "Balas sticker dengan .toimg",
                                msg
                            );
                            break;
                        }

                        const id = Date.now();

                        const input = path.join(
                            TEMP,
                            `${id}.webp`
                        );

                        const output = path.join(
                            TEMP,
                            `${id}.png`
                        );

                        fs.writeFileSync(
                            input,
                            await downloadMedia(
                                media.message,
                                "sticker"
                            )
                        );

                        await ffmpeg(input, output);

                        await sock.sendMessage(jid, {
                            image: fs.readFileSync(output),
                            caption: BOT_NAME
                        }, { quoted: msg });

                        fs.unlinkSync(input);
                        fs.unlinkSync(output);
                        break;
                    }

                    // AUDIO
                    case "tomp3":
                    case "bass":
                    case "slow":
                    case "fast": {
                        if (!media || media.type !== "audio") {
                            await reply(
                                sock,
                                jid,
                                "Balas pesan audio dengan ." + command,
                                msg
                            );
                            break;
                        }

                        const id = Date.now();

                        const input = path.join(
                            TEMP,
                            `${id}_input`
                        );

                        const output = path.join(
                            TEMP,
                            `${id}.mp3`
                        );

                        fs.writeFileSync(
                            input,
                            await downloadMedia(
                                media.message,
                                "audio"
                            )
                        );

                        let filters = [];

                        if (command === "bass") {
                            filters = ["-af", "bass=g=10"];
                        }

                        if (command === "slow") {
                            filters = ["-af", "atempo=0.8"];
                        }

                        if (command === "fast") {
                            filters = ["-af", "atempo=1.25"];
                        }

                        await ffmpeg(input, output, [
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

                    // UNKNOWN COMMAND
                    default:
                        await reply(
                            sock,
                            jid,
                            `Perintah tidak ditemukan. Ketik ${PREFIX}menu`,
                            msg
                        );
                }

            } catch (error) {
                console.error(
                    "[COMMAND ERROR]",
                    error
                );

                await reply(
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

// ====================================
// RUN
// ====================================

startBot().catch(error => {
    console.error("[FATAL ERROR]", error);
});
