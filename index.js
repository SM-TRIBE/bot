// Main bot file for Telegram: index.js (Keyboard Buttons & Referral System Update)

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
let BOT_USERNAME = '';
bot.getMe().then(me => {
    BOT_USERNAME = me.username;
    console.log(`Bot username set to: ${BOT_USERNAME}`);
});


// --- KEYBOARD DEFINITIONS ---
const KEYBOARDS = {
    main: (chatId) => {
        const db = readDb();
        const isAdmin = String(chatId) === ADMIN_CHAT_ID;
        const isSubAdmin = db.subAdmins.includes(String(chatId));

        let keyboard = [
            [{ text: '✨ My Profile' }, { text: '🔍 Search' }],
            [{ text: '❤️ My Matches' }, { text: '💰 Coin Store' }],
            [{ text: '📢 Get Referral Link' }]
        ];

        if (isAdmin) {
            keyboard.push([{ text: '👑 Admin Panel' }]);
        } else if (isSubAdmin) {
            keyboard.push([{ text: '🛡️ Sub-Admin Panel' }]);
        }
        return { keyboard, resize_keyboard: true };
    },
    createProfile: { keyboard: [[{ text: '🚀 Create Profile' }]], resize_keyboard: true },
    admin: {
        keyboard: [
            [{ text: '📊 Server Stats' }, { text: '👥 Manage Users' }],
            [{ text: '🚨 Manage Reports' }, { text: '🛡️ Manage Sub-Admins' }],
            [{ text: '💰 Grant Coins' }, { text: '📢 Broadcast' }],
            [{ text: '⬅️ Back to Main Menu' }]
        ],
        resize_keyboard: true
    },
    subAdmin: {
        keyboard: [[{ text: '👥 View Users' }], [{ text: '⬅️ Back to Main Menu' }]],
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
        text += `**Referred By:** ${profile.referredBy ? `\`${profile.referredBy}\`` : 'None'}\n`;
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
    
    const state = userState[chatId];
    if (state) {
        // Handle state-based inputs
        if (state.action === 'creating_profile') return handleCreationWizard(msg);
        if (state.action === 'granting_coins_id') return handleCoinGrant(msg, 'amount');
        if (state.action === 'granting_coins_amount') return handleCoinGrant(msg, 'confirm');
        if (state.action === 'managing_users') return handleUserManagement(msg);
        if (state.action === 'managing_sub_admins_promote') return handleSubAdminPromotion(msg, 'promote');
        if (state.action === 'managing_sub_admins_demote') return handleSubAdminPromotion(msg, 'demote');
        return;
    }

    if (!text) return; // Ignore non-text messages if not in a state

    // Handle keyboard button presses
    switch (text) {
        case '✨ My Profile': viewProfile(chatId); break;
        case '🔍 Search': bot.sendMessage(chatId, "This feature is coming soon!"); break;
        case '❤️ My Matches': bot.sendMessage(chatId, "This feature is coming soon!"); break;
        case '💰 Coin Store': bot.sendMessage(chatId, "This feature is coming soon!"); break;
        case '📢 Get Referral Link': sendReferralLink(chatId); break;
        case '🚀 Create Profile': startProfileCreation(chatId); break;
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
        case '⬅️ Back to Main Menu': sendMainMenu(chatId); break;
        // Admin panel buttons
        case '📊 Server Stats': showServerStats(chatId); break;
        case '👥 Manage Users': promptForUserId(chatId, 'view_manage'); break;
        case '🚨 Manage Reports': bot.sendMessage(chatId, "Report management is coming soon!"); break;
        case '🛡️ Manage Sub-Admins': manageSubAdmins(chatId); break;
        case '💰 Grant Coins': promptForCoinGrant(chatId); break;
        case '📢 Broadcast': bot.sendMessage(chatId, "Broadcast feature is coming soon!"); break;
        // Sub-admin panel buttons
        case '👥 View Users': promptForUserId(chatId, 'view_only'); break;
    }
});

bot.on('callback_query', (query) => {
    const { message, data } = query;
    const chatId = message.chat.id;

    if (data.startsWith('admin_promote_sub')) return handleSubAdminPromotion(query, 'promote_prompt');
    if (data.startsWith('admin_demote_sub')) return handleSubAdminPromotion(query, 'demote_prompt');
    if (data.startsWith('profile_edit')) return bot.sendMessage(chatId, "Profile editing is coming soon!");
    if (data.startsWith('viewers_show')) return bot.sendMessage(chatId, "Viewing who saw your profile is coming soon!");

});

// --- COMMANDS ---
bot.onText(/\/start(?: (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const referralCode = match ? match[1] : null;
    handleStartCommand(chatId, referralCode);
});

bot.onText(/\/daily/, (msg) => handleDailyBonus(msg.chat.id));

// --- REFERRAL SYSTEM ---

async function handleStartCommand(chatId, referralCode) {
    const db = readDb();
    
    if (db.users[chatId]) {
        return sendMainMenu(chatId);
    }

    let referredBy = null;
    let bonusCoins = 0;

    if (referralCode) {
        const referrerId = Object.keys(db.users).find(id => db.users[id].referralCode === referralCode);
        if (referrerId && String(referrerId) !== String(chatId)) {
            const referrerProfile = db.users[referrerId];
            referrerProfile.coins += 50;
            referredBy = referrerId;
            bonusCoins = 25;
            
            bot.sendMessage(referrerId, `🎉 Someone started the bot with your link! You've received 50 coins.`).catch(console.error);
        }
    }

    db.users[chatId] = {
        id: chatId,
        coins: 100 + bonusCoins,
        referralCode: uuidv4().substring(0, 8),
        referredBy: referredBy,
        likes: [], photos: [], viewers: [], lastDaily: null, boostUntil: null, banned: false
    };
    writeDb(db);
    
    await bot.sendMessage(chatId, "Welcome to the bot! Since you're new, let's create your profile.").catch(console.error);
    if (bonusCoins > 0) {
        await bot.sendMessage(chatId, `✨ You received a ${bonusCoins} coin bonus for using a referral link!`).catch(console.error);
    }
    startProfileCreation(chatId);
}

async function sendReferralLink(chatId) {
    const db = readDb();
    const user = db.users[chatId];
    if (!user || !user.referralCode) {
        return bot.sendMessage(chatId, "Could not find your referral code. Please try creating a profile first.").catch(console.error);
    }
    
    if (!BOT_USERNAME) {
        return bot.sendMessage(chatId, "The bot is still starting up, please try again in a moment.").catch(console.error);
    }
    
    const link = `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`;
    const text = `📢 **Your Referral Link**\n\nShare this link with your friends. When a new user joins using your link, you'll receive **50 coins**!\n\n\`${link}\``;
    
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(console.error);
}

// --- PROFILE CREATION ---

function startProfileCreation(chatId) {
    userState[chatId] = { action: 'creating_profile', step: 'name' };
    bot.sendMessage(chatId, "👋 Let's create your profile!\n\nFirst, what's your name?", { reply_markup: { remove_keyboard: true } }).catch(console.error);
}

function handleCreationWizard(msg) {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    if (!state || state.action !== 'creating_profile') return;

    const db = readDb();
    const profile = db.users[chatId];

    const nextStep = (step, question) => {
        userState[chatId].step = step;
        bot.sendMessage(chatId, question).catch(console.error);
    };

    switch(state.step) {
        case 'name':
            profile.name = msg.text;
            nextStep('age', 'Great! Now, how old are you?');
            break;
        case 'age':
            profile.age = msg.text;
            nextStep('gender', 'What is your gender?');
            break;
        case 'gender':
            profile.gender = msg.text;
            nextStep('city', 'What city do you live in?');
            break;
        case 'city':
            profile.city = msg.text;
            nextStep('interests', 'List some interests, separated by commas.');
            break;
        case 'interests':
            profile.interests = msg.text.split(',').map(s => s.trim());
            delete userState[chatId];
            writeDb(db);
            bot.sendMessage(chatId, "🎉 All done! Your profile has been created.").catch(console.error);
            sendMainMenu(chatId);
            return;
    }
    writeDb(db);
}

// --- PROFILE VIEW ---
async function viewProfile(chatId) {
    const db = readDb();
    const profile = db.users[chatId];
    if (!profile) return bot.sendMessage(chatId, "Please create a profile first.").catch(console.error);

    const profileText = getProfileText(profile, true);
    const keyboard = {
        inline_keyboard: [
            [{ text: "✏️ Edit Profile", callback_data: "profile_edit" }],
            [{ text: `👀 Who Viewed Me (${profile.viewers?.length || 0})`, callback_data: "viewers_show" }]
        ]
    };
    await bot.sendMessage(chatId, profileText, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(console.error);
}

// --- DAILY COIN ---
function handleDailyBonus(chatId) {
    const db = readDb();
    const profile = db.users[chatId];
    if (!profile) return bot.sendMessage(chatId, "You need a profile to claim a bonus. Use /start to create one.").catch(console.error);

    const now = new Date();
    const lastDaily = profile.lastDaily ? new Date(profile.lastDaily) : null;

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

// --- ADMIN FUNCTIONS ---

function showServerStats(adminId) {
    const db = readDb();
    const totalUsers = Object.keys(db.users).length;
    const text = `📊 **Server Statistics**\n\n- Total Users: ${totalUsers}`;
    bot.sendMessage(adminId, text, { parse_mode: 'Markdown' });
}

function promptForUserId(adminId, mode) {
    userState[adminId] = { action: 'managing_users', mode: mode };
    bot.sendMessage(adminId, "Enter the User ID to manage.");
}

function handleUserManagement(msg) {
    const adminId = msg.chat.id;
    const targetId = msg.text;
    const state = userState[adminId];
    if (!state || state.action !== 'managing_users') return;

    const db = readDb();
    const profile = db.users[targetId];
    if (!profile) {
        delete userState[adminId];
        return bot.sendMessage(adminId, "User not found.", { reply_markup: KEYBOARDS.admin });
    }
    
    const profileText = getProfileText(profile, true, true);
    let keyboard;

    if (state.mode === 'view_manage') { // Main Admin
        keyboard = {
            inline_keyboard: [
                [{ text: "💰 Grant Coins", callback_data: `admin_grant_${targetId}` }],
                profile.banned ? [{ text: "✅ Unban", callback_data: `admin_unban_${targetId}` }] : [{ text: "🚫 Ban", callback_data: `admin_ban_${targetId}` }]
            ]
        };
    } else { // Sub-Admin
        keyboard = {
            inline_keyboard: [
                profile.banned ? [{ text: "✅ Unban", callback_data: `admin_unban_${targetId}` }] : [{ text: "🚫 Ban", callback_data: `admin_ban_${targetId}` }]
            ]
        };
    }
    
    bot.sendMessage(adminId, profileText, { parse_mode: "Markdown", reply_markup: keyboard });
    delete userState[adminId];
}

function promptForCoinGrant(adminId) {
    userState[adminId] = { action: 'granting_coins_id' };
    bot.sendMessage(adminId, "Enter the User ID of the recipient.").catch(console.error);
}

function handleCoinGrant(msg, step) {
    const adminId = msg.chat.id;
    const state = userState[adminId];
    if (!state) return;

    if (step === 'amount') {
        const targetId = msg.text;
        const db = readDb();
        if (!db.users[targetId]) {
            delete userState[adminId];
            return bot.sendMessage(adminId, "User ID not found.", { reply_markup: KEYBOARDS.admin });
        }
        state.action = 'granting_coins_amount';
        state.targetId = targetId;
        return bot.sendMessage(adminId, `How many coins to grant to ${db.users[targetId].name}?`);
    }

    if (step === 'confirm') {
        const amount = parseInt(msg.text, 10);
        if (isNaN(amount) || amount <= 0) {
            delete userState[adminId];
            return bot.sendMessage(adminId, "Invalid amount.", { reply_markup: KEYBOARDS.admin });
        }
        
        const db = readDb();
        const targetProfile = db.users[state.targetId];
        targetProfile.coins += amount;
        writeDb(db);

        bot.sendMessage(adminId, `✅ Successfully granted ${amount} coins to ${targetProfile.name}.`, { reply_markup: KEYBOARDS.admin });
        bot.sendMessage(state.targetId, `An administrator has granted you ${amount} coins!`).catch(console.error);
        delete userState[adminId];
    }
}

function manageSubAdmins(adminId) {
    const db = readDb();
    let text = "🛡️ **Sub-Admin Management**\n\n";
    if (db.subAdmins.length === 0) {
        text += "There are no sub-admins.";
    } else {
        text += "Current Sub-Admins:\n";
        db.subAdmins.forEach(id => {
            const name = db.users[id]?.name || 'Unknown User';
            text += `- ${name} (\`${id}\`)\n`;
        });
    }
    const keyboard = {
        inline_keyboard: [
            [{ text: "➕ Promote User", callback_data: "admin_promote_sub" }],
            [{ text: "➖ Demote User", callback_data: "admin_demote_sub" }]
        ]
    };
    bot.sendMessage(adminId, text, { parse_mode: "Markdown", reply_markup: keyboard });
}

function handleSubAdminPromotion(queryOrMsg, action) {
    const adminId = queryOrMsg.message?.chat.id || queryOrMsg.chat.id;
    if (action === 'promote_prompt') {
        userState[adminId] = { action: 'managing_sub_admins_promote' };
        return bot.sendMessage(adminId, "Enter the User ID to promote to Sub-Admin.");
    }
    if (action === 'demote_prompt') {
        userState[adminId] = { action: 'managing_sub_admins_demote' };
        return bot.sendMessage(adminId, "Enter the User ID to demote.");
    }

    const targetId = queryOrMsg.text;
    const db = readDb();
    if (!db.users[targetId]) {
        return bot.sendMessage(adminId, "User not found.");
    }

    if (action === 'promote') {
        if (!db.subAdmins.includes(targetId)) {
            db.subAdmins.push(targetId);
            writeDb(db);
            bot.sendMessage(adminId, "✅ User promoted to Sub-Admin.");
            bot.sendMessage(targetId, "🎉 You have been promoted to Sub-Admin!");
        } else {
            bot.sendMessage(adminId, "This user is already a Sub-Admin.");
        }
    } else if (action === 'demote') {
        const index = db.subAdmins.indexOf(targetId);
        if (index > -1) {
            db.subAdmins.splice(index, 1);
            writeDb(db);
            bot.sendMessage(adminId, "✅ User demoted from Sub-Admin.");
            bot.sendMessage(targetId, "You have been demoted from your Sub-Admin role.");
        } else {
            bot.sendMessage(adminId, "This user is not a Sub-Admin.");
        }
    }
    delete userState[adminId];
}


// --- SERVER LISTENER ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot is set up to receive updates at ${RENDER_URL}`);
});
