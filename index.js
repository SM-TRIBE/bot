// Main bot file for Telegram: index.js (Keyboard Buttons & Sub-Admin Update)

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!TELEGRAM_TOKEN || !RENDER_URL || !ADMIN_CHAT_ID) {
    console.error("FATAL ERROR: TELEGRAM_TOKEN, RENDER_EXTERNAL_URL, and ADMIN_CHAT_ID must be set.");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${RENDER_URL}/bot${TELEGRAM_TOKEN}`);

const app = express();
app.use(express.json());

// --- DATABASE SETUP ---
const dbPath = path.join(__dirname, 'data', 'db.json');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

function readDb() {
    try {
        if (!fs.existsSync(dbPath)) {
            const defaultDb = { users: {}, matches: {}, reports: [], subAdmins: [] };
            fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2));
            return defaultDb;
        }
        const data = fs.readFileSync(dbPath);
        const jsonData = JSON.parse(data);
        if (!jsonData.reports) jsonData.reports = [];
        if (!jsonData.subAdmins) jsonData.subAdmins = [];
        Object.values(jsonData.users).forEach(user => {
            if (!user.viewers) user.viewers = [];
        });
        return jsonData;
    } catch (error) {
        console.error('Error reading database:', error);
        return { users: {}, matches: {}, reports: [], subAdmins: [] };
    }
}

function writeDb(data) {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error writing to database:', error);
    }
}

// In-memory state and cache
const userState = {};

// --- KEYBOARD DEFINITIONS ---
const KEYBOARDS = {
    main: (chatId) => {
        const db = readDb();
        const isAdmin = String(chatId) === ADMIN_CHAT_ID;
        const isSubAdmin = db.subAdmins.includes(String(chatId));

        if (isAdmin) {
            return {
                keyboard: [[{ text: '✨ My Profile' }, { text: '🔍 Search' }], [{ text: '❤️ My Matches' }, { text: '💰 Coin Store' }], [{ text: '👑 Admin Panel' }]],
                resize_keyboard: true
            };
        }
        if (isSubAdmin) {
            return {
                keyboard: [[{ text: '✨ My Profile' }, { text: '🔍 Search' }], [{ text: '❤️ My Matches' }, { text: '💰 Coin Store' }], [{ text: '🛡️ Sub-Admin Panel' }]],
                resize_keyboard: true
            };
        }
        return {
            keyboard: [[{ text: '✨ My Profile' }, { text: '🔍 Search' }], [{ text: '❤️ My Matches' }, { text: '💰 Coin Store' }]],
            resize_keyboard: true
        };
    },
    createProfile: { keyboard: [[{ text: '🚀 Create Profile' }]], resize_keyboard: true },
    admin: {
        keyboard: [
            [{ text: '📊 Server Stats' }, { text: '👥 Manage Users' }],
            [{ text: '🚨 Manage Reports' }, { text: '🛡️ Manage Sub-Admins' }],
            [{ text: '📢 Broadcast' }, { text: '⬅️ Back to Main Menu' }]
        ],
        resize_keyboard: true
    },
    subAdmin: {
        keyboard: [
            [{ text: '👥 View Users' }],
            [{ text: '⬅️ Back to Main Menu' }]
        ],
        resize_keyboard: true
    }
};

// --- HELPER FUNCTIONS ---

function getProfileText(profile, extended = false, forAdmin = false) {
    if (!profile) return "Profile not found.";
    let text = `👤 **Name:** ${profile.name || 'N/A'}\n`;
    text += `🎂 **Age:** ${profile.age || 'N/A'}\n`;
    text += `⚧️ **Gender:** ${profile.gender || 'N/A'}\n`;
    text += `🏙️ **City:** ${profile.city || 'N/A'}\n`;
    text += `🎨 **Interests:** ${(profile.interests || []).join(', ') || 'N/A'}\n`;
    if (extended) {
        text += `📝 **Limits:** ${profile.limits || 'Not set'}\n`;
        text += `ℹ️ **Extra Info:** ${profile.extraInfo || 'Not set'}\n`;
        text += `\n💰 **Coins:** ${profile.coins}\n`;
        if (profile.boostUntil && new Date(profile.boostUntil) > new Date()) {
            text += `🚀 **Profile Boosted!**\n`;
        }
    }
    if (forAdmin) {
        text += `\n--- Admin Info ---\n`;
        text += `**User ID:** \`${profile.id}\`\n`;
        text += `**Banned:** ${profile.banned ? 'Yes' : 'No'}\n`;
    }
    return text;
}

async function sendMainMenu(chatId) {
    const db = readDb();
    const userProfile = db.users[chatId];
    const text = userProfile
        ? `Welcome back, ${userProfile.name}! This is your main menu.`
        : "Welcome to the Dating Bot! Please create a profile to get started.";
    
    const keyboard = userProfile ? KEYBOARDS.main(chatId) : KEYBOARDS.createProfile;
    await bot.sendMessage(chatId, text, { reply_markup: keyboard }).catch(console.error);
}

// --- WEBHOOK & MESSAGE ROUTERS ---

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/', (req, res) => {
    res.send('Telegram Dating Bot is running!');
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const db = readDb();
    
    if (db.users[chatId]?.banned) {
        return bot.sendMessage(chatId, "You have been banned from using this bot.").catch(console.error);
    }
    
    // Handle state-based inputs first
    const state = userState[chatId];
    if (state) {
        // ... (state handling logic will go here)
        return;
    }

    // Handle keyboard button presses
    switch (text) {
        case '✨ My Profile':
            viewProfile(chatId);
            break;
        case '🔍 Search':
            // Start search logic
            break;
        case '❤️ My Matches':
            // Show matches logic
            break;
        case '💰 Coin Store':
            // Show store logic
            break;
        case '🚀 Create Profile':
            startProfileCreation(chatId);
            break;
        case '👑 Admin Panel':
            if (String(chatId) === ADMIN_CHAT_ID) {
                bot.sendMessage(chatId, "👑 Welcome to the Admin Panel.", { reply_markup: KEYBOARDS.admin });
            }
            break;
        case '🛡️ Sub-Admin Panel':
             if (db.subAdmins.includes(String(chatId))) {
                bot.sendMessage(chatId, "🛡️ Welcome to the Sub-Admin Panel.", { reply_markup: KEYBOARDS.subAdmin });
            }
            break;
        case '⬅️ Back to Main Menu':
            sendMainMenu(chatId);
            break;
        // Admin panel buttons
        case '📊 Server Stats':
            showServerStats(chatId);
            break;
        case '👥 Manage Users':
            // Admin manage users logic
            break;
        case '🚨 Manage Reports':
            // Admin manage reports logic
            break;
        case '🛡️ Manage Sub-Admins':
            // Admin manage sub-admins logic
            break;
        case '📢 Broadcast':
            // Admin broadcast logic
            break;
        // Sub-admin panel buttons
        case '👥 View Users':
            // Sub-admin view users logic
            break;
        default:
            // If no button matches and no state is active, check for commands
            if (text && text.startsWith('/')) {
                const command = text.split(' ')[0];
                switch (command) {
                    case '/start':
                        sendMainMenu(chatId);
                        break;
                    case '/daily':
                        handleDailyBonus(chatId);
                        break;
                }
            }
    }
});


// --- PROFILE CREATION ---

function startProfileCreation(chatId) {
    const db = readDb();
    if (!db.users[chatId]) {
        db.users[chatId] = { id: chatId, coins: 100, likes: [], photos: [], viewers: [], lastDaily: null, boostUntil: null, banned: false };
        writeDb(db);
    }
    userState[chatId] = { action: 'creating_profile', step: 'name' };
    bot.sendMessage(chatId, "👋 Let's create your profile!\n\nFirst, what's your name?", { reply_markup: { remove_keyboard: true } }).catch(console.error);
}

// --- PROFILE VIEW ---
async function viewProfile(chatId) {
    const db = readDb();
    const profile = db.users[chatId];
    if (!profile) return bot.sendMessage(chatId, "Please create a profile first.").catch(console.error);

    const profileText = getProfileText(profile, true);
    // For viewing, we can use inline buttons as they are context-specific actions
    const keyboard = {
        inline_keyboard: [
            [{ text: "✏️ Edit Profile", callback_data: "profile_edit" }],
            [{ text: `👀 Who Viewed Me (${profile.viewers?.length || 0})`, callback_data: "viewers_show" }]
        ]
    };

    if (profile.photos && profile.photos.length > 0) {
        await bot.sendPhoto(chatId, profile.photos[0], { caption: profileText, parse_mode: 'Markdown', reply_markup: keyboard }).catch(console.error);
    } else {
        await bot.sendMessage(chatId, profileText, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(console.error);
    }
}


// --- DAILY COIN FIX ---
function handleDailyBonus(chatId) {
    const db = readDb();
    const profile = db.users[chatId];
    if (!profile) return bot.sendMessage(chatId, "You need a profile to claim a bonus. Use /start to create one.").catch(console.error);

    const now = new Date();
    const lastDaily = profile.lastDaily ? new Date(profile.lastDaily) : null;

    // Correctly check if 24 hours have passed
    if (lastDaily && (now.getTime() - lastDaily.getTime()) < 24 * 60 * 60 * 1000) {
        const timeLeft = 24 * 60 * 60 * 1000 - (now.getTime() - lastDaily.getTime());
        const hours = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        return bot.sendMessage(chatId, `You have already claimed your daily bonus. Please wait ${hours}h ${minutes}m.`).catch(console.error);
    }

    const bonus = 25;
    profile.coins += bonus;
    profile.lastDaily = now.toISOString();
    writeDb(db);

    bot.sendMessage(chatId, `🎉 You have claimed your daily bonus of ${bonus} coins! Your new balance is ${profile.coins}.`).catch(console.error);
}


// --- ADMIN COIN GRANT ---
function promptForCoinGrant(adminId) {
    userState[adminId] = { action: 'granting_coins_id' };
    bot.sendMessage(adminId, "Enter the User ID of the recipient.").catch(console.error);
}

// This would be part of the message handler for states
// if (state.action === 'granting_coins_id') {
//     const targetId = msg.text;
//     // ... validation ...
//     userState[chatId] = { action: 'granting_coins_amount', targetId: targetId };
//     bot.sendMessage(chatId, `How many coins to grant to ${targetId}?`);
// }
// if (state.action === 'granting_coins_amount') {
//     const amount = parseInt(msg.text, 10);
//     // ... validation and granting logic ...
// }


// --- SERVER LISTENER ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot is set up to receive updates at ${RENDER_URL}`);
});
