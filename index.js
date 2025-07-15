// Main bot file for Telegram: index.js (Definitive Stable Version)

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
const searchCache = {};
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
    try {
        const db = readDb();
        const userProfile = db.users[chatId];
        const text = userProfile
            ? `Welcome back, ${userProfile.name}! This is your main menu.`
            : "Welcome to the Dating Bot! Please create a profile to get started.";
        
        const keyboard = userProfile ? KEYBOARDS.main(chatId) : KEYBOARDS.createProfile;
        await bot.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (error) {
        console.error(`Error in sendMainMenu for chat ${chatId}:`, error.code);
    }
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
        if (state.action === 'creating_profile') return handleCreationWizard(msg);
        if (state.action === 'editing_field') return handleFieldEdit(msg);
        if (state.action === 'granting_coins_id') return handleCoinGrant(msg, 'amount');
        if (state.action === 'granting_coins_amount') return handleCoinGrant(msg, 'confirm');
        if (state.action === 'managing_users') return handleUserManagement(msg);
        if (state.action === 'managing_sub_admins_promote') return handleSubAdminPromotion(msg, 'promote');
        if (state.action === 'managing_sub_admins_demote') return handleSubAdminPromotion(msg, 'demote');
        if (state.action === 'searching_interests') {
             const searchState = userState[chatId]?.search;
             if (searchState) {
                searchState.interests = text;
                executeSearch(chatId, state.messageId);
             }
        }
        if (state.action === 'reporting') return handleReportSubmission(msg);
        if (state.action === 'broadcasting') return handleBroadcast(msg);
        return;
    }

    if (!text) return;

    switch (text) {
        case '✨ My Profile': viewProfile(chatId); break;
        case '🔍 Search': startSearch(chatId); break;
        case '❤️ My Matches': handleMyMatches(chatId); break;
        case '💰 Coin Store': showCoinStore(chatId); break;
        case '📢 Get Referral Link': sendReferralLink(chatId); break;
        case '🚀 Create Profile': startProfileCreation(chatId); break;
        case '👑 Admin Panel':
            if (String(chatId) === ADMIN_CHAT_ID) {
                bot.sendMessage(chatId, "👑 Welcome to the Admin Panel.", { reply_markup: KEYBOARDS.admin }).catch(console.error);
            }
            break;
        case '🛡️ Sub-Admin Panel':
             if (db.subAdmins.includes(String(chatId))) {
                bot.sendMessage(chatId, "🛡️ Welcome to the Sub-Admin Panel.", { reply_markup: KEYBOARDS.subAdmin }).catch(console.error);
            }
            break;
        case '⬅️ Back to Main Menu': sendMainMenu(chatId); break;
        case '📊 Server Stats': showServerStats(chatId); break;
        case '👥 Manage Users': listAllUsers(chatId, null, 0); break;
        case '🚨 Manage Reports': listOpenReports(chatId, null, 0); break;
        case '🛡️ Manage Sub-Admins': manageSubAdmins(chatId); break;
        case '💰 Grant Coins': promptForCoinGrant(chatId); break;
        case '📢 Broadcast': promptForBroadcast(chatId); break;
        case '👥 View Users': listAllUsers(chatId, null, 0, true); break;
    }
});

bot.on('callback_query', (query) => {
    const { message, data } = query;
    const chatId = message.chat.id;
    bot.answerCallbackQuery(query.id).catch(console.error);

    try {
        const [action, p1, p2, p3] = data.split('_');

        switch (action) {
            case 'admin': handleAdminActions(query); break;
            case 'profile':
                if (p1 === 'edit') showEditMenu(chatId, message.message_id);
                if (p1 === 'view' && p2 === 'back') {
                    bot.deleteMessage(chatId, message.message_id).catch(console.error);
                    viewProfile(chatId);
                }
                break;
            case 'edit':
                if (p1 === 'field') promptForField(chatId, p2, message.message_id);
                break;
            case 'viewers': handleProfileViewers(query); break;
            case 'like': handleLikeAction(query); break;
            case 'search':
                if(p1 === 'criteria') handleSearchActions(query);
                if(p1 === 'result') {
                    bot.deleteMessage(chatId, message.message_id).catch(()=>{});
                    showSearchResult(chatId, p2);
                }
                break;
            case 'report':
                if(p1 === 'prompt') promptForReportReason(chatId, p2);
                break;
            case 'store': handleStoreActions(query); break;
        }
    } catch (error) {
        console.error("Error in callback query handler:", error);
        bot.sendMessage(chatId, "An error occurred. Please try again.").catch(console.error);
    }
});

// --- COMMANDS ---
bot.onText(/\/start(?: (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const referralCode = match ? match[1] : null;
    handleStartCommand(chatId, referralCode);
});

bot.onText(/\/daily/, (msg) => handleDailyBonus(msg.chat.id));

// --- ALL FUNCTIONS ARE NOW DEFINED BELOW ---

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

// --- PROFILE VIEW & EDIT ---
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

async function showEditMenu(chatId, messageId) {
    const text = "What would you like to edit? Select a field below.";
    const keyboard = {
        inline_keyboard: [
            [{ text: "👤 Name", callback_data: "edit_field_name" }, { text: "🎂 Age", callback_data: "edit_field_age" }],
            [{ text: "⚧️ Gender", callback_data: "edit_field_gender" }, { text: "🏙️ City", callback_data: "edit_field_city" }],
            [{ text: "🎨 Interests", callback_data: "edit_field_interests" }],
            [{ text: "⬅️ Back to Profile", callback_data: "profile_view_back" }]
        ]
    };
    try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
    } catch (e) {
        await bot.sendMessage(chatId, text, { reply_markup: keyboard }).catch(console.error);
    }
}

function promptForField(chatId, field, messageId) {
    userState[chatId] = { action: 'editing_field', field: field };
    let promptText = `Please send the new value for your *${field}*.`;
    if (field === 'interests') {
        promptText += "\n(Please separate multiple interests with a comma)";
    }
    bot.editMessageText(promptText, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }).catch(e => {
        bot.sendMessage(chatId, promptText, { parse_mode: "Markdown" }).catch(console.error);
    });
}

function handleFieldEdit(msg) {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    if (!state || state.action !== 'editing_field') return;

    const { field } = state;
    const newValue = msg.text;

    const db = readDb();
    const profile = db.users[chatId];

    if (field === 'age' && (isNaN(parseInt(newValue)) || parseInt(newValue) < 18)) {
        bot.sendMessage(chatId, "Invalid age. Please enter a number and make sure you are over 18.");
        return;
    }

    if (field === 'interests') {
        profile[field] = newValue.split(',').map(s => s.trim());
    } else {
        profile[field] = newValue;
    }
    
    writeDb(db);
    bot.sendMessage(chatId, `✅ Your *${field}* has been updated successfully!`, { parse_mode: "Markdown" });
    delete userState[chatId];
    
    viewProfile(chatId);
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

// --- COIN STORE & VIEWERS ---

function showCoinStore(chatId) {
    const db = readDb();
    const profile = db.users[chatId];
    if (!profile) {
        return bot.sendMessage(chatId, "Please create a profile first.").catch(console.error);
    }
    const text = `💰 **Coin Store**\n\nYour balance: ${profile.coins} coins.\n\n` +
                 `Use your coins to get noticed!\n\n` +
                 `🚀 **Profile Boost (50 Coins)**\n` +
                 `Your profile will appear at the top of search results for 24 hours.\n\n` +
                 `👀 **See Who Viewed You (15 Coins)**\n` +
                 `Unlock the list of users who have recently viewed your profile.`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "🚀 Boost My Profile (50 Coins)", callback_data: "store_boost" }],
            [{ text: "👀 See Viewers (15 Coins)", callback_data: "viewers_show" }]
        ]
    };
    bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard }).catch(console.error);
}

function handleStoreActions(query) {
    const { message, data } = query;
    const [_, action] = data.split('_');

    switch (action) {
        case 'boost': buyProfileBoost(query); break;
    }
}

function buyProfileBoost(query) {
    const chatId = query.message.chat.id;
    const db = readDb();
    const profile = db.users[chatId];
    const cost = 50;

    if (profile.coins < cost) {
        return bot.answerCallbackQuery(query.id, { text: "You don't have enough coins!", show_alert: true });
    }

    profile.coins -= cost;
    const now = new Date();
    const currentBoost = (profile.boostUntil && new Date(profile.boostUntil) > now) ? new Date(profile.boostUntil) : now;
    profile.boostUntil = new Date(currentBoost.getTime() + 24 * 60 * 60 * 1000);
    writeDb(db);

    bot.answerCallbackQuery(query.id, { text: "Success! Your profile is boosted for 24 hours.", show_alert: true });
    bot.deleteMessage(chatId, query.message.message_id).catch(console.error);
}

async function handleProfileViewers(query) {
    const chatId = query.message.chat.id;
    const db = readDb();
    const profile = db.users[chatId];
    const cost = 15;

    if (profile.coins < cost) {
        return bot.answerCallbackQuery(query.id, { text: `You need ${cost} coins to see your viewers!`, show_alert: true });
    }

    profile.coins -= cost;
    writeDb(db);

    const viewers = profile.viewers || [];
    if (viewers.length === 0) {
        return bot.editMessageText("No one has viewed your profile recently.", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Profile", callback_data: "profile_view_back" }]] } }).catch(console.error);
    }

    let text = "Here are the recent viewers of your profile:\n\n";
    const recentViewers = viewers.slice(-10).reverse();
    for (const viewer of recentViewers) {
        const viewerProfile = db.users[viewer.id];
        if (viewerProfile) {
            text += `- **${viewerProfile.name}** viewed on ${new Date(viewer.date).toLocaleDateString()}\n`;
        }
    }

    await bot.answerCallbackQuery(query.id, { text: `${cost} coins spent!` });
    await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Profile", callback_data: "profile_view_back" }]] }
    }).catch(console.error);
}

// --- SEARCH & MATCHING ---

function startSearch(chatId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: "By Gender & Age", callback_data: "search_criteria_gender" }],
            [{ text: "By Interests", callback_data: "search_criteria_interests_prompt" }]
        ]
    };
    bot.sendMessage(chatId, "How would you like to search?", { reply_markup: keyboard });
}

async function handleSearchActions(query) {
    const { message, data } = query;
    const chatId = message.chat.id;
    const [_, __, field, value] = data.split('_');

    userState[chatId] = userState[chatId] || { search: {} };

    if (field === 'gender') {
        userState[chatId].search.gender = value;
        await promptSearchCriteria(chatId, 'age', message.message_id);
    } else if (field === 'age') {
        userState[chatId].search.age = value;
        await executeSearch(chatId, message.message_id);
    } else if (field === 'interests') {
        if(value === 'prompt') {
            userState[chatId].action = 'searching_interests';
            userState[chatId].messageId = message.message_id;
            await bot.editMessageText("Please type the interests you're looking for, separated by commas.", { chat_id: chatId, message_id: message.message_id });
        }
    }
}

async function promptSearchCriteria(chatId, criteria, messageId) {
    let text, keyboard;
    if (criteria === 'gender') {
        text = "Who are you interested in?";
        keyboard = { inline_keyboard: [[{ text: "Male", callback_data: "search_criteria_gender_male" }, { text: "Female", callback_data: "search_criteria_gender_female" }, { text: "Other", callback_data: "search_criteria_gender_other" }]] };
    } else if (criteria === 'age') {
        text = "What age range?";
        keyboard = {
            inline_keyboard: [
                [{ text: "18-25", callback_data: "search_criteria_age_18-25" }, { text: "26-35", callback_data: "search_criteria_age_26-35" }],
                [{ text: "36-45", callback_data: "search_criteria_age_36-45" }, { text: "45+", callback_data: "search_criteria_age_45-99" }]
            ]
        };
    }
    
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: keyboard }).catch(console.error);
}

function executeSearch(chatId, messageId) {
    const db = readDb();
    const searchCriteria = userState[chatId]?.search;
    if (!searchCriteria) return bot.sendMessage(chatId, "Search expired. Please start again.").catch(console.error);
    
    const [minAge, maxAge] = searchCriteria.age ? searchCriteria.age.split('-').map(Number) : [0, 99];
    const searchInterests = searchCriteria.interests ? searchCriteria.interests.split(',').map(i => i.trim().toLowerCase()) : [];
    
    const now = new Date();
    const results = Object.values(db.users).filter(u => {
        if (String(u.id) === String(chatId) || u.banned) return false;
        if (searchCriteria.gender && u.gender !== searchCriteria.gender) return false;
        if (searchCriteria.age && (u.age < minAge || u.age > maxAge)) return false;
        if (searchInterests.length > 0) {
            const userInterests = (u.interests || []).map(i => i.toLowerCase());
            const hasInterest = searchInterests.some(si => userInterests.includes(si));
            if (!hasInterest) return false;
        }
        return true;
    }).sort((a, b) => {
        const aBoosted = a.boostUntil && new Date(a.boostUntil) > now;
        const bBoosted = b.boostUntil && new Date(b.boostUntil) > now;
        if (aBoosted && !bBoosted) return -1;
        if (!aBoosted && bBoosted) return 1;
        return 0;
    });

    if (results.length === 0) {
        bot.editMessageText("😔 No users found matching your criteria.", { chat_id: chatId, message_id: messageId }).catch(console.error);
        delete userState[chatId];
        return;
    }

    searchCache[chatId] = { results, index: -1 };
    bot.deleteMessage(chatId, messageId).catch(()=>{});
    bot.sendMessage(chatId, `Found ${results.length} potential matches! Boosted profiles are shown first.`).catch(console.error);
    showSearchResult(chatId, 'next');
    delete userState[chatId];
}

async function showSearchResult(chatId, direction) {
    const cache = searchCache[chatId];
    if (!cache || cache.results.length === 0) return bot.sendMessage(chatId, "Search session expired or no results found.").catch(console.error);

    if (direction === 'next') cache.index++;
    if (direction === 'prev') cache.index--;

    if (cache.index >= cache.results.length) {
        cache.index = cache.results.length - 1;
        return bot.sendMessage(chatId, "You've reached the end of the search results.").catch(console.error);
    }
    if (cache.index < 0) {
        cache.index = 0;
        return bot.sendMessage(chatId, "You're at the beginning of the search results.").catch(console.error);
    }

    const profile = cache.results[cache.index];
    
    const db = readDb();
    const targetProfile = db.users[profile.id];
    if (targetProfile) {
        if (!targetProfile.viewers) targetProfile.viewers = [];
        if (!targetProfile.viewers.find(v => v.id === chatId)) {
            targetProfile.viewers.push({ id: chatId, date: new Date().toISOString() });
            targetProfile.viewers = targetProfile.viewers.slice(-20);
            writeDb(db);
        }
    }

    const profileText = getProfileText(profile);
    const keyboard = {
        inline_keyboard: [
            [{ text: "❤️ Like (10 Coins)", callback_data: `like_${profile.id}` }, { text: "👎 Next", callback_data: "search_result_next" }],
            [{ text: `🚩 Report ${profile.name}`, callback_data: `report_prompt_${profile.id}` }]
        ]
    };
    
    try {
        await bot.sendMessage(chatId, profileText, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (error) {
        console.error("Error showing search result:", error.code);
    }
}

// --- SERVER LISTENER ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot is set up to receive updates at ${RENDER_URL}`);
});
