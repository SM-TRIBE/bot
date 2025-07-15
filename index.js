// Main bot file for Telegram: index.js (Final Version with Advanced Features & Stability Fixes)

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path =require('path');
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
            const defaultDb = { users: {}, matches: {}, reports: [] };
            fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2));
            return defaultDb;
        }
        const data = fs.readFileSync(dbPath);
        const jsonData = JSON.parse(data);
        if (!jsonData.reports) jsonData.reports = [];
        Object.values(jsonData.users).forEach(user => {
            if (!user.viewers) user.viewers = [];
        });
        return jsonData;
    } catch (error) {
        console.error('Error reading database:', error);
        return { users: {}, matches: {}, reports: [] };
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

async function sendMainMenu(chatId, messageId = null) {
    const db = readDb();
    const userProfile = db.users[chatId];
    const text = userProfile
        ? `Welcome back, ${userProfile.name}! This is your main menu.`
        : "Welcome to the Dating Bot! Please create a profile to get started.";

    const keyboard = userProfile
        ? [
            [{ text: "✨ My Profile", callback_data: "profile_view" }],
            [{ text: "🔍 Search", callback_data: "search_start" }, { text: "❤️ My Matches", callback_data: "my_matches" }],
            [{ text: "💰 Coin Store", callback_data: "store_view" }, { text: "🎁 Gift Coins", callback_data: "gift_start" }]
          ]
        : [[{ text: "🚀 Create Profile", callback_data: "profile_create" }]];

    const options = { reply_markup: { inline_keyboard: keyboard } };

    try {
        if (messageId) {
            await bot.editMessageText(text, { ...options, chat_id: chatId, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, text, options);
        }
    } catch (error) {
        if (error.code === 'ETELEGRAM' && messageId) {
            await bot.sendMessage(chatId, text, options).catch(console.error);
        }
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
    const db = readDb();
    if (db.users[chatId]?.banned) {
        return bot.sendMessage(chatId, "You have been banned from using this bot.").catch(console.error);
    }

    if (msg.text && msg.text.startsWith('/')) return;

    const state = userState[chatId];
    if (!state) return;

    try {
        if (state.action === 'creating_profile') handleCreationWizard(msg);
        else if (state.action.startsWith('editing_')) handleFieldEdit(msg);
        else if (state.action === 'broadcasting') handleBroadcast(msg);
        else if (state.action === 'granting_coins') handleCoinGrant(msg);
        else if (state.action === 'reporting') handleReportSubmission(msg);
        else if (state.action === 'gifting_id') handleGifting(msg, 'amount');
        else if (state.action === 'gifting_amount') handleGifting(msg, 'confirm');
        else if (state.action.startsWith('admin_editing_')) handleAdminFieldEdit(msg);
        else if (state.action === 'admin_warning') handleAdminWarning(msg);
    } catch (error) {
        console.error("Error in message handler:", error);
        bot.sendMessage(chatId, "An error occurred. Please type /start to reset.").catch(console.error);
        delete userState[chatId];
    }
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const db = readDb();
    if (db.users[chatId]?.banned) {
        return bot.answerCallbackQuery(query.id, { text: "You are banned.", show_alert: true });
    }

    bot.answerCallbackQuery(query.id).catch(console.error);

    try {
        const [action] = query.data.split('_');
        switch (action) {
            case 'profile': handleProfileActions(query); break;
            case 'search': handleSearchActions(query); break;
            case 'like': handleLikeAction(query); break;
            case 'gallery': handleGallery(query); break;
            case 'my': if (query.data.split('_')[1] === 'matches') handleMyMatches(query); break;
            case 'wizard': handleCreationWizard(query); break;
            case 'store': handleStoreActions(query); break;
            case 'admin': handleAdminActions(query); break;
            case 'report': handleReportActions(query); break;
            case 'gift': handleGifting(query); break;
            case 'viewers': handleProfileViewers(query); break;
            case 'back': sendMainMenu(chatId, query.message.message_id); break;
            default: bot.sendMessage(chatId, "Unknown command.").catch(console.error);
        }
    } catch (error) {
        console.error("Error in callback query handler:", error);
        bot.sendMessage(chatId, "An error occurred. Please try again.").catch(console.error);
    }
});

// --- COMMANDS ---
bot.onText(/\/start/, (msg) => sendMainMenu(msg.chat.id));
bot.onText(/\/daily/, (msg) => handleDailyBonus(msg.chat.id));
bot.onText(/\/help/, (msg) => sendHelpMessage(msg.chat.id));
bot.onText(/\/admin/, (msg) => {
    if (String(msg.chat.id) === ADMIN_CHAT_ID) {
        sendAdminMenu(msg.chat.id);
    } else {
        bot.sendMessage(msg.chat.id, "You are not authorized to use this command.").catch(console.error);
    }
});

// --- ALL FUNCTIONS ARE NOW DEFINED BELOW ---

// --- PROFILE MANAGEMENT ---

function handleProfileActions(query) {
    const { message, data } = query;
    const [_, subAction, field] = data.split('_');

    switch (subAction) {
        case 'view': viewProfile(message.chat.id, message.message_id); break;
        case 'create': startProfileCreation(message.chat.id); break;
        case 'edit':
            if (field) promptForField(message.chat.id, field);
            else showEditMenu(message.chat.id, message.message_id);
            break;
    }
}

async function viewProfile(chatId, messageId) {
    const db = readDb();
    const profile = db.users[chatId];
    if (!profile) return bot.sendMessage(chatId, "Please create a profile first with /start.").catch(console.error);

    const profileText = getProfileText(profile, true);
    const keyboard = [
        [{ text: "✏️ Edit Profile", callback_data: "profile_edit" }, { text: "🖼️ My Photo Gallery", callback_data: "gallery_view_self_0" }],
        [{ text: `👀 Who Viewed Me (${profile.viewers?.length || 0})`, callback_data: "viewers_show" }],
        [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
    ];
    const options = {
        caption: profileText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    };

    try {
        if (messageId) await bot.deleteMessage(chatId, messageId).catch(()=>{});
        
        if (profile.photos && profile.photos.length > 0) {
            await bot.sendPhoto(chatId, profile.photos[0], options);
        } else {
            await bot.sendMessage(chatId, profileText, { ...options, caption: null });
        }
    } catch (error) {
        console.error("Error in viewProfile:", error.code, error.response?.body);
        await bot.sendMessage(chatId, "There was an error displaying your profile. Please try again.").catch(console.error);
    }
}

async function showEditMenu(chatId, messageId) {
    const db = readDb();
    const profile = db.users[chatId];
    const text = "Select the field you want to edit:";
    const keyboard = [
        [{ text: `👤 Name: ${profile.name || 'N/A'}`, callback_data: "profile_edit_name" }],
        [{ text: `🎂 Age: ${profile.age || 'N/A'}`, callback_data: "profile_edit_age" }],
        [{ text: `🏙️ City: ${profile.city || 'N/A'}`, callback_data: "profile_edit_city" }],
        [{ text: `🎨 Interests`, callback_data: "profile_edit_interests" }],
        [{ text: `📝 Limits`, callback_data: "profile_edit_limits" }],
        [{ text: `ℹ️ Extra Info`, callback_data: "profile_edit_extraInfo" }],
        [{ text: "⬅️ Back to Profile", callback_data: "profile_view" }]
    ];
    try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    } catch (error) {
        viewProfile(chatId, messageId);
    }
}

function promptForField(chatId, field) {
    userState[chatId] = { action: `editing_${field}` };
    let promptText = `Please enter your new ${field}.`;
    if (field === 'interests') promptText += " (separated by commas)";
    if (field === 'photo') promptText = "Please send a photo to add to your gallery.";
    bot.sendMessage(chatId, promptText).catch(console.error);
}

async function handleFieldEdit(msg) {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    if (!state) return;

    const db = readDb();
    const field = state.action.split('_')[1];
    let updated = false;

    if (field === 'photo') {
        if (!msg.photo) return bot.sendMessage(chatId, "That's not a photo. Please send a photo, or type /start to cancel.").catch(console.error);
        if (!db.users[chatId].photos) db.users[chatId].photos = [];
        db.users[chatId].photos.push(msg.photo[msg.photo.length - 1].file_id);
        updated = true;
    } else {
        if (!msg.text) return bot.sendMessage(chatId, "I was expecting text. Please try again, or type /start to cancel.").catch(console.error);
        if (field === 'age') {
            const age = parseInt(msg.text, 10);
            if (!isNaN(age) && age >= 18 && age <= 99) {
                db.users[chatId].age = age;
                updated = true;
            } else {
                bot.sendMessage(chatId, "Invalid age. Please enter a number between 18 and 99.").catch(console.error);
            }
        } else if (field === 'interests') {
            db.users[chatId].interests = msg.text.split(',').map(s => s.trim());
            updated = true;
        } else {
            db.users[chatId][field] = msg.text;
            updated = true;
        }
    }

    if (updated) {
        writeDb(db);
        await bot.sendMessage(chatId, `✅ Your ${field} has been updated!`).catch(console.error);
        delete userState[chatId];
        setTimeout(() => viewProfile(chatId), 500);
    }
}

function startProfileCreation(chatId) {
    const db = readDb();
    if (!db.users[chatId]) {
        db.users[chatId] = { id: chatId, coins: 100, likes: [], photos: [], viewers: [], lastDaily: null, boostUntil: null, banned: false };
        writeDb(db);
    }
    userState[chatId] = { action: 'creating_profile', step: 'name' };
    bot.sendMessage(chatId, "👋 Let's create your profile!\n\nFirst, what's your name?").catch(console.error);
}

function handleCreationWizard(queryOrMsg) {
    const isMsg = !!queryOrMsg.text || !!queryOrMsg.photo;
    const chatId = isMsg ? queryOrMsg.chat.id : queryOrMsg.message.chat.id;
    const state = userState[chatId];
    if (!state) return;

    const db = readDb();
    const profile = db.users[chatId];

    const nextStep = (step, question, options = {}) => {
        userState[chatId].step = step;
        bot.sendMessage(chatId, question, options).catch(console.error);
    };

    switch (state.step) {
        case 'name':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your name as text.").catch(console.error);
            profile.name = queryOrMsg.text;
            writeDb(db);
            nextStep('age', 'Great! Now, how old are you?');
            break;
        case 'age':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your age as a number.").catch(console.error);
            const age = parseInt(queryOrMsg.text, 10);
            if (isNaN(age) || age < 18 || age > 99) return bot.sendMessage(chatId, "Please enter a valid age between 18 and 99.").catch(console.error);
            profile.age = age;
            writeDb(db);
            nextStep('gender', 'Got it. What is your gender?', {
                reply_markup: { inline_keyboard: [[{text: "Male", callback_data: "wizard_gender_male"}, {text: "Female", callback_data: "wizard_gender_female"}, {text: "Other", callback_data: "wizard_gender_other"}]]}
            });
            break;
        case 'gender':
            if (isMsg) return;
            profile.gender = queryOrMsg.data.split('_')[2];
            writeDb(db);
            bot.deleteMessage(chatId, queryOrMsg.message.message_id).catch(console.error);
            nextStep('city', `Perfect. What city do you live in?`);
            break;
        case 'city':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your city as text.").catch(console.error);
            profile.city = queryOrMsg.text;
            writeDb(db);
            nextStep('interests', 'Almost done! List some interests, separated by commas (e.g., Hiking, Movies).');
            break;
        case 'interests':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your interests as text.").catch(console.error);
            profile.interests = queryOrMsg.text.split(',').map(s => s.trim());
            writeDb(db);
            nextStep('photo', 'Last step! Send me a photo for your profile.');
            break;
        case 'photo':
            if (!queryOrMsg.photo) return bot.sendMessage(chatId, "That's not a photo. Please send a photo to continue.").catch(console.error);
            profile.photos.push(queryOrMsg.photo[queryOrMsg.photo.length - 1].file_id);
            bot.sendMessage(chatId, "🎉 All done! Your profile has been created.").catch(console.error);
            // Admin notification for new user
            bot.sendMessage(ADMIN_CHAT_ID, `🎉 New user joined!\nName: ${profile.name}\nID: \`${profile.id}\``, {parse_mode: "Markdown"}).catch(console.error);
            delete userState[chatId];
            writeDb(db);
            setTimeout(() => viewProfile(chatId), 500);
            return;
    }
}

// --- ADMIN PANEL ---

function sendAdminMenu(chatId, messageId = null) {
    const db = readDb();
    const openReports = db.reports.filter(r => r.status === 'open').length;
    const reportButtonText = `🚨 Manage Reports ${openReports > 0 ? `(${openReports})` : ''}`;

    const text = "👑 *Admin Panel*\nWelcome, administrator. What would you like to do?";
    const keyboard = [
        [{ text: "📊 Server Stats", callback_data: "admin_stats" }],
        [{ text: "👥 Manage Users", callback_data: "admin_list_users_0" }],
        [{ text: reportButtonText, callback_data: "admin_reports_list_0" }],
        [{ text: "📢 Broadcast Message", callback_data: "admin_broadcast" }]
    ];
    const options = { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } };

    if (messageId) {
        bot.editMessageText(text, { ...options, chat_id: chatId, message_id: messageId }).catch(console.error);
    } else {
        bot.sendMessage(chatId, text, options).catch(console.error);
    }
}

function handleAdminActions(query) {
    const { message, data } = query;
    const chatId = message.chat.id;
    const [_, action, param1, param2] = data.split('_');

    if (String(chatId) !== ADMIN_CHAT_ID) return;

    switch (action) {
        case 'menu': sendAdminMenu(chatId, message.message_id); break;
        case 'stats': showServerStats(chatId, message.message_id); break;
        case 'list': listAllUsers(chatId, message.message_id, parseInt(param1, 10)); break;
        case 'view': viewUserProfileAsAdmin(chatId, param1, message.message_id); break;
        case 'grant': promptForCoinGrant(chatId, param1); break;
        case 'ban': banOrUnbanUser(chatId, param1, true, message.message_id); break;
        case 'unban': banOrUnbanUser(chatId, param1, false, message.message_id); break;
        case 'broadcast': promptForBroadcast(chatId); break;
        case 'reports': listOpenReports(chatId, message.message_id, parseInt(param1, 10)); break;
        case 'report':
            if (param1 === 'view') viewReport(chatId, param2, message.message_id);
            if (param1 === 'resolve') resolveReport(chatId, param2, message.message_id);
            break;
        case 'edit': promptForAdminFieldEdit(chatId, param1, param2); break;
        case 'warn': promptForAdminWarning(chatId, param1); break;
    }
}

function showServerStats(chatId, messageId) {
    const db = readDb();
    const totalUsers = Object.keys(db.users).length;
    const totalMatches = Object.keys(db.matches).length;
    const totalReports = db.reports.length;
    const openReports = db.reports.filter(r => r.status === 'open').length;
    const dbSize = fs.existsSync(dbPath) ? (fs.statSync(dbPath).size / 1024).toFixed(2) : 0;

    const text = `*Server Statistics*\n\n` +
                 `- Total Users: ${totalUsers}\n` +
                 `- Total Matches: ${totalMatches}\n` +
                 `- Total Reports: ${totalReports} (${openReports} open)\n`+
                 `- Database Size: ${dbSize} KB`;

    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "admin_menu" }]] }
    }).catch(console.error);
}

function listAllUsers(chatId, messageId, page = 0) {
    const db = readDb();
    const users = Object.values(db.users);
    const usersPerPage = 5;
    const startIndex = page * usersPerPage;
    const paginatedUsers = users.slice(startIndex, startIndex + usersPerPage);
    const totalPages = Math.ceil(users.length / usersPerPage);

    let text = `*User List (Page ${page + 1} of ${totalPages})*\n\n`;
    const keyboard = [];

    if (paginatedUsers.length === 0) {
        text = "No users found.";
    } else {
        paginatedUsers.forEach(user => {
            text += `- ${user.name || 'N/A'} (ID: \`${user.id}\`)${user.banned ? ' 🚫' : ''}\n`;
            keyboard.push([{ text: `View ${user.name || 'Profile'}`, callback_data: `admin_view_${user.id}` }]);
        });
    }

    const navRow = [];
    if (page > 0) navRow.push({ text: "⬅️ Previous", callback_data: `admin_list_${page - 1}` });
    if (page < totalPages - 1) navRow.push({ text: "Next ➡️", callback_data: `admin_list_${page + 1}` });
    if (navRow.length > 0) keyboard.push(navRow);

    keyboard.push([{ text: "⬅️ Back to Admin Menu", callback_data: "admin_menu" }]);
    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    }).catch(console.error);
}

function viewUserProfileAsAdmin(chatId, targetId, messageId) {
    const db = readDb();
    const profile = db.users[targetId];
    if (!profile) return bot.sendMessage(chatId, "User not found.").catch(console.error);

    const text = getProfileText(profile, true, true);
    const keyboard = [
        [{ text: "💰 Grant Coins", callback_data: `admin_grant_${targetId}` }, { text: "⚠️ Send Warning", callback_data: `admin_warn_${targetId}` }],
        [{ text: "✏️ Edit Name", callback_data: `admin_edit_${targetId}_name` }, { text: "✏️ Edit City", callback_data: `admin_edit_${targetId}_city` }],
        profile.banned
            ? [{ text: "✅ Unban User", callback_data: `admin_unban_${targetId}` }]
            : [{ text: "🚫 Ban User", callback_data: `admin_ban_${targetId}` }],
        [{ text: "⬅️ Back to User List", callback_data: `admin_list_0` }]
    ];

    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    }).catch(console.error);
}

function banOrUnbanUser(chatId, targetId, shouldBan, messageId) {
    const db = readDb();
    const targetProfile = db.users[targetId];
    if (!targetProfile) return bot.sendMessage(chatId, "User not found.").catch(console.error);

    targetProfile.banned = shouldBan;
    writeDb(db);

    const actionText = shouldBan ? "banned" : "unbanned";
    bot.answerCallbackQuery(chatId, {text: `User has been ${actionText}.`}).catch(console.error);
    bot.sendMessage(targetId, `You have been ${actionText} by an administrator.`).catch(console.error);

    viewUserProfileAsAdmin(chatId, targetId, messageId);
}

function promptForBroadcast(chatId) {
    userState[chatId] = { action: 'broadcasting' };
    bot.sendMessage(chatId, "Please send the message you want to broadcast to all users. Type /cancel to abort.").catch(console.error);
}

async function handleBroadcast(msg) {
    const chatId = msg.chat.id;
    if (msg.text === '/cancel') {
        delete userState[chatId];
        return bot.sendMessage(chatId, "Broadcast cancelled.").catch(console.error);
    }

    const db = readDb();
    const allUserIds = Object.keys(db.users);
    let successCount = 0;
    let failCount = 0;

    await bot.sendMessage(chatId, `Starting broadcast to ${allUserIds.length} users. This may take a while...`).catch(console.error);

    for (const userId of allUserIds) {
        try {
            await bot.sendMessage(userId, msg.text);
            successCount++;
        } catch (error) {
            console.error(`Failed to send broadcast to ${userId}:`, error.code);
            failCount++;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    delete userState[chatId];
    await bot.sendMessage(chatId, `Broadcast finished.\n\n✅ Sent successfully: ${successCount}\n❌ Failed to send: ${failCount}`).catch(console.error);
    sendAdminMenu(chatId);
}

function promptForCoinGrant(chatId, targetId) {
    userState[chatId] = { action: 'granting_coins', targetId: targetId };
    bot.sendMessage(chatId, `How many coins would you like to grant to user \`${targetId}\`?`, { parse_mode: "Markdown" }).catch(console.error);
}

function handleCoinGrant(msg) {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    const amount = parseInt(msg.text, 10);

    if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, "Please enter a valid positive number.").catch(console.error);
    }

    const db = readDb();
    const targetProfile = db.users[state.targetId];
    if (!targetProfile) {
        bot.sendMessage(chatId, "Target user not found.").catch(console.error);
    } else {
        targetProfile.coins += amount;
        writeDb(db);
        bot.sendMessage(chatId, `✅ Successfully granted ${amount} coins to user ${targetProfile.name} (\`${targetProfile.id}\`).`).catch(console.error);
        bot.sendMessage(targetProfile.id, `An administrator has granted you ${amount} coins!`).catch(console.error);
    }
    delete userState[chatId];
    sendAdminMenu(chatId);
}

function promptForAdminFieldEdit(chatId, targetId, field) {
    userState[chatId] = { action: `admin_editing_${field}`, targetId: targetId };
    bot.sendMessage(chatId, `Enter the new ${field} for user \`${targetId}\`:`, { parse_mode: "Markdown" }).catch(console.error);
}

function handleAdminFieldEdit(msg) {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    const field = state.action.split('_')[2];
    const newValue = msg.text;

    const db = readDb();
    const targetProfile = db.users[state.targetId];
    if (targetProfile) {
        targetProfile[field] = newValue;
        writeDb(db);
        bot.sendMessage(chatId, `✅ User's ${field} has been updated.`).catch(console.error);
        bot.sendMessage(targetProfile.id, `An administrator has updated your ${field}.`).catch(console.error);
    } else {
        bot.sendMessage(chatId, "User not found.").catch(console.error);
    }
    delete userState[chatId];
    sendAdminMenu(chatId);
}

function promptForAdminWarning(chatId, targetId) {
    userState[chatId] = { action: 'admin_warning', targetId: targetId };
    bot.sendMessage(chatId, `What is the warning message for user \`${targetId}\`?`, { parse_mode: "Markdown" }).catch(console.error);
}

function handleAdminWarning(msg) {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    const warningText = msg.text;

    const db = readDb();
    const targetProfile = db.users[state.targetId];
    if (targetProfile) {
        bot.sendMessage(targetProfile.id, `⚠️ You have received a warning from an administrator:\n\n"${warningText}"`).catch(console.error);
        bot.sendMessage(chatId, "✅ Warning sent.").catch(console.error);
    } else {
        bot.sendMessage(chatId, "User not found.").catch(console.error);
    }
    delete userState[chatId];
    sendAdminMenu(chatId);
}

// --- REPORTING SYSTEM ---

function handleReportActions(query) {
    const { message, data } = query;
    const [_, action, reportedId] = data.split('_');

    if (action === 'prompt') {
        promptForReportReason(message.chat.id, reportedId);
    }
}

function promptForReportReason(reporterId, reportedId) {
    userState[reporterId] = { action: 'reporting', reportedId: reportedId };
    bot.sendMessage(reporterId, "Please state the reason for your report. Your report will be sent to the administrator for review.").catch(console.error);
}

function handleReportSubmission(msg) {
    const reporterId = msg.chat.id;
    const state = userState[reporterId];
    if (!state || state.action !== 'reporting') return;

    const { reportedId } = state;
    const reason = msg.text;

    const db = readDb();
    const newReport = {
        reportId: uuidv4(),
        reporterId,
        reportedId,
        reason,
        status: 'open',
        timestamp: new Date().toISOString()
    };
    if (!db.reports) db.reports = [];
    db.reports.push(newReport);
    writeDb(db);

    delete userState[reporterId];
    bot.sendMessage(reporterId, "Thank you. Your report has been submitted and will be reviewed by an administrator.").catch(console.error);
    bot.sendMessage(ADMIN_CHAT_ID, `🚨 New user report received. Go to /admin -> Manage Reports to review.`).catch(console.error);
}

function listOpenReports(chatId, messageId, page = 0) {
    const db = readDb();
    const openReports = db.reports.filter(r => r.status === 'open');
    const reportsPerPage = 5;
    const startIndex = page * reportsPerPage;
    const paginatedReports = openReports.slice(startIndex, startIndex + reportsPerPage);
    const totalPages = Math.ceil(openReports.length / reportsPerPage);

    let text = `*Open Reports (Page ${page + 1} of ${totalPages})*\n\n`;
    const keyboard = [];

    if (paginatedReports.length === 0) {
        text = "No open reports.";
    } else {
        paginatedReports.forEach(report => {
            const reporter = db.users[report.reporterId]?.name || 'Unknown';
            const reported = db.users[report.reportedId]?.name || 'Unknown';
            text += `*Report ID:* \`${report.reportId.substring(0, 8)}\`\n`;
            text += `*From:* ${reporter} | *Against:* ${reported}\n\n`;
            keyboard.push([{ text: `View Report (${report.reportId.substring(0, 8)})`, callback_data: `admin_report_view_${report.reportId}` }]);
        });
    }

    const navRow = [];
    if (page > 0) navRow.push({ text: "⬅️ Previous", callback_data: `admin_reports_list_${page - 1}` });
    if (page < totalPages - 1) navRow.push({ text: "Next ➡️", callback_data: `admin_reports_list_${page + 1}` });
    if (navRow.length > 0) keyboard.push(navRow);

    keyboard.push([{ text: "⬅️ Back to Admin Menu", callback_data: "admin_menu" }]);
    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    }).catch(console.error);
}

function viewReport(chatId, reportId, messageId) {
    const db = readDb();
    const report = db.reports.find(r => r.reportId === reportId);
    if (!report) return bot.sendMessage(chatId, "Report not found.").catch(console.error);

    const reporter = db.users[report.reporterId];
    const reported = db.users[report.reportedId];

    let text = `*Viewing Report ID:* \`${report.reportId.substring(0, 8)}\`\n\n`;
    text += `*Reporter:* ${reporter?.name || 'N/A'} (\`${report.reporterId}\`)\n`;
    text += `*Reported User:* ${reported?.name || 'N/A'} (\`${report.reportedId}\`)\n`;
    text += `*Date:* ${new Date(report.timestamp).toUTCString()}\n\n`;
    text += `*Reason Provided:*\n"${report.reason}"`;

    const keyboard = [
        [{ text: `View ${reporter?.name}'s Profile`, callback_data: `admin_view_${reporter.id}` }, { text: `View ${reported?.name}'s Profile`, callback_data: `admin_view_${reported.id}` }],
        [{ text: "✅ Mark as Resolved", callback_data: `admin_report_resolve_${report.reportId}` }],
        [{ text: "⬅️ Back to Reports", callback_data: `admin_reports_list_0` }]
    ];

    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    }).catch(console.error);
}

function resolveReport(chatId, reportId, messageId) {
    const db = readDb();
    const reportIndex = db.reports.findIndex(r => r.reportId === reportId);
    if (reportIndex !== -1) {
        db.reports[reportIndex].status = 'closed';
        writeDb(db);
        bot.answerCallbackQuery(chatId, { text: "Report marked as resolved." }).catch(console.error);
    }
    listOpenReports(chatId, messageId, 0);
}

// --- CURRENCY & STORE ---

function handleStoreActions(query) {
    const { message, data } = query;
    const [_, action] = data.split('_');

    switch (action) {
        case 'view': showCoinStore(message.chat.id, message.message_id); break;
        case 'boost': buyProfileBoost(query); break;
    }
}

function showCoinStore(chatId, messageId) {
    const db = readDb();
    const profile = db.users[chatId];
    const text = `💰 **Coin Store**\n\nYour balance: ${profile.coins} coins.\n\n` +
                 `Use your coins to get noticed!\n\n` +
                 `🚀 **Profile Boost (50 Coins)**\n` +
                 `Your profile will appear at the top of search results for 24 hours.\n\n` +
                 `👀 **See Who Viewed You (15 Coins)**\n` +
                 `Unlock the list of users who have recently viewed your profile.`;
    const keyboard = [
        [{ text: "🚀 Boost My Profile (50 Coins)", callback_data: "store_boost" }],
        [{ text: "👀 See Viewers (15 Coins)", callback_data: "viewers_show" }],
        [{ text: "Claim Daily Bonus (/daily)", callback_data: "ignore" }],
        [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
    ];
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }).catch(console.error);
}

function buyProfileBoost(query) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
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
    showCoinStore(chatId, messageId);
}

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

function sendHelpMessage(chatId) {
    let text = `*Welcome to the Dating Bot! Here's how to use it:*\n\n` +
               `*/start* - Shows the main menu.\n` +
               `*/help* - Shows this help message.\n\n` +
               `*Currency System*\n` +
               `- You spend **10 coins** to 'Like' a profile.\n` +
               `- Use */daily* once every 24 hours to get **25 free coins**.\n` +
               `- Visit the *Coin Store* from the main menu to buy a **Profile Boost** or see who viewed you!`;

    if (String(chatId) === ADMIN_CHAT_ID) {
        text += `\n\n*👑 Admin Commands*\n` +
                `*/admin* - Access the admin panel to manage users, view stats, and send broadcasts.`;
    }

    bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(console.error);
}

// --- SEARCH & MATCHING ---

function handleSearchActions(query) {
    const { message, data } = query;
    const [_, subAction, field, value] = data.split('_');

    switch(subAction) {
        case 'start': promptSearchCriteria(message.chat.id, 'gender', message.message_id); break;
        case 'criteria':
            userState[message.chat.id] = userState[message.chat.id] || { search: {} };
            userState[message.chat.id].search[field] = value;
            if (field === 'gender') promptSearchCriteria(message.chat.id, 'age', message.message_id);
            else if (field === 'age') promptSearchCriteria(message.chat.id, 'interests', message.message_id);
            else if (field === 'interests') {
                if(value === 'yes'){
                    userState[message.chat.id].search.step = 'interests_input';
                    bot.editMessageText("Please type the interests you're looking for, separated by commas.", { chat_id: message.chat.id, message_id: message.message_id });
                } else {
                    executeSearch(message.chat.id, message.message_id);
                }
            }
            break;
        case 'result':
            bot.deleteMessage(message.chat.id, message.message_id).catch(()=>{});
            showSearchResult(message.chat.id, field);
            break;
    }
}

async function promptSearchCriteria(chatId, criteria, messageId) {
    let text, keyboard;
    if (criteria === 'gender') {
        text = "Who are you interested in?";
        keyboard = [[{ text: "Male", callback_data: "search_criteria_gender_male" }, { text: "Female", callback_data: "search_criteria_gender_female" }, { text: "Other", callback_data: "search_criteria_gender_other" }]];
    } else if (criteria === 'age') {
        text = "What age range?";
        keyboard = [
            [{ text: "18-25", callback_data: "search_criteria_age_18-25" }, { text: "26-35", callback_data: "search_criteria_age_26-35" }],
            [{ text: "36-45", callback_data: "search_criteria_age_36-45" }, { text: "45+", callback_data: "search_criteria_age_45-99" }]
        ];
    } else if (criteria === 'interests') {
        text = "Search by interests? (Optional)";
        keyboard = [
            [{ text: "Yes, let me specify", callback_data: "search_criteria_interests_yes" }],
            [{ text: "No, skip this step", callback_data: "search_criteria_interests_no" }]
        ];
    }
    
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } }).catch(console.error);
}

function executeSearch(chatId, messageId) {
    const db = readDb();
    const searchCriteria = userState[chatId]?.search;
    if (!searchCriteria) return bot.sendMessage(chatId, "Search expired. Please start again.").catch(console.error);
    
    const [minAge, maxAge] = searchCriteria.age.split('-').map(Number);
    const searchInterests = searchCriteria.interests ? searchCriteria.interests.split(',').map(i => i.trim().toLowerCase()) : [];
    
    const now = new Date();
    const results = Object.values(db.users).filter(u => {
        if (String(u.id) === String(chatId) || u.banned) return false;
        if (u.gender !== searchCriteria.gender) return false;
        if (u.age < minAge || u.age > maxAge) return false;
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
        delete userState[chatId].search;
        return;
    }

    searchCache[chatId] = { results, index: -1 };
    bot.deleteMessage(chatId, messageId).catch(()=>{});
    bot.sendMessage(chatId, `Found ${results.length} potential matches! Boosted profiles are shown first.`).catch(console.error);
    showSearchResult(chatId, 'next');
    delete userState[chatId].search;
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
    const keyboard = [
        [{ text: "❤️ Like (10 Coins)", callback_data: `like_${profile.id}` }, { text: "👎 Next", callback_data: "search_result_next" }],
        [{ text: `🚩 Report ${profile.name}`, callback_data: `report_prompt_${profile.id}` }]
    ];
    if (profile.photos && profile.photos.length > 1) {
        keyboard.push([{text: "🖼️ View Photo Gallery", callback_data: `gallery_view_${profile.id}_0`}])
    }
    keyboard.push([{ text: "⬅️ End Search", callback_data: "back_to_menu" }]);

    const options = { caption: profileText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };

    try {
        if (profile.photos && profile.photos.length > 0) {
            await bot.sendPhoto(chatId, profile.photos[0], options);
        } else {
            await bot.sendMessage(chatId, profileText, { ...options, caption: null });
        }
    } catch (error) {
        console.error("Error showing search result:", error.code);
    }
}

async function handleLikeAction(query) {
    const { message, data } = query;
    const likerId = message.chat.id;
    const likedId = data.split('_')[1];

    const db = readDb();
    const likerProfile = db.users[likerId];
    const likedProfile = db.users[likedId];

    if (!likerProfile || !likedProfile) return bot.answerCallbackQuery(query.id, { text: "Error: Profile not found.", show_alert: true });
    if (likerProfile.coins < 10) return bot.answerCallbackQuery(query.id, { text: "You don't have enough coins!", show_alert: true });
    if (likerProfile.likes.includes(likedId)) return bot.answerCallbackQuery(query.id, { text: "You've already liked this profile." });

    likerProfile.coins -= 10;
    likerProfile.likes.push(likedId);
    writeDb(db);
    await bot.deleteMessage(likerId, message.message_id).catch(()=>{});

    if (likedProfile.likes?.includes(String(likerId))) {
        const matchId = uuidv4();
        db.matches[matchId] = { users: [String(likerId), String(likedId)], date: new Date().toISOString() };
        writeDb(db);
        
        const likerTg = await bot.getChat(likerId).catch(() => ({ username: 'user' }));
        const likedTg = await bot.getChat(likedId).catch(() => ({ username: 'user' }));

        await bot.sendMessage(likerId, `🎉 It's a Match with ${likedProfile.name}!`, {
            reply_markup: { inline_keyboard: [[{ text: "💬 Start Chat", url: `https://t.me/${likedTg.username}` }]] }
        }).catch(console.error);
        await bot.sendMessage(likedId, `🎉 It's a Match with ${likerProfile.name}!`, {
            reply_markup: { inline_keyboard: [[{ text: "💬 Start Chat", url: `https://t.me/${likerTg.username}` }]] }
        }).catch(console.error);
    } else {
        await bot.sendMessage(likerId, `You liked ${likedProfile.name}'s profile! If they like you back, it's a match.`).catch(console.error);
    }
    showSearchResult(likerId, 'next');
}

async function handleMyMatches(query) {
    const chatId = query.message.chat.id;
    const db = readDb();
    const userMatches = Object.values(db.matches).filter(m => m.users.includes(String(chatId)));

    if (userMatches.length === 0) {
        return bot.editMessageText("You have no matches yet. Keep searching!", { chat_id: chatId, message_id: query.message.message_id }).catch(console.error);
    }

    let text = "Here are your matches:\n";
    const keyboard = [];
    for (const match of userMatches) {
        const otherUserId = match.users.find(id => id !== String(chatId));
        const otherUser = db.users[otherUserId];
        if (otherUser) {
            const otherTg = await bot.getChat(otherUserId).catch(() => ({ username: 'user' }));
            text += `\n- **${otherUser.name}** (${otherUser.age}, ${otherUser.city})`;
            keyboard.push([{ text: `💬 Chat with ${otherUser.name}`, url: `https://t.me/${otherTg.username}` }]);
        }
    }
    keyboard.push([{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]);

    await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    }).catch(console.error);
}

async function handleGallery(query) {
    const { message, data } = query;
    const [_, action, targetIdStr, indexStr] = data.split('_');
    const chatId = message.chat.id;
    const targetId = targetIdStr === 'self' ? chatId : targetIdStr;

    const db = readDb();
    const profile = db.users[targetId];
    if (!profile || !profile.photos || profile.photos.length === 0) {
        return bot.answerCallbackQuery(query.id, { text: "No photos in the gallery." });
    }

    let index = parseInt(indexStr, 10) || 0;

    if (action === 'next') index++;
    if (action === 'prev') index--;
    index = (index + profile.photos.length) % profile.photos.length;

    const photoId = profile.photos[index];
    const isOwnProfile = String(chatId) === String(targetId);

    const keyboard = [];
    const navRow = [];
    if (profile.photos.length > 1) {
        const callbackTarget = isOwnProfile ? 'self' : targetId;
        navRow.push({ text: "⬅️ Prev", callback_data: `gallery_prev_${callbackTarget}_${index}` });
        navRow.push({ text: "Next ➡️", callback_data: `gallery_next_${callbackTarget}_${index}` });
    }
    if(navRow.length > 0) keyboard.push(navRow);
    
    if (isOwnProfile) {
        keyboard.push([{ text: "🗑️ Delete This Photo", callback_data: `gallery_delete_self_${index}` }]);
        keyboard.push([{ text: "➕ Add New Photo", callback_data: "profile_edit_photo"}]);
        keyboard.push([{ text: "⬅️ Back to Profile", callback_data: "profile_view" }]);
    } else {
         keyboard.push([{ text: "❤️ Like (10 Coins)", callback_data: `like_${targetId}` }]);
         keyboard.push([{ text: "👎 Next Profile", callback_data: "search_result_next" }]);
    }
    
    if (action === 'delete' && isOwnProfile) {
        profile.photos.splice(index, 1);
        writeDb(db);
        await bot.deleteMessage(chatId, message.message_id).catch(()=>{});
        bot.sendMessage(chatId, "Photo deleted.").catch(console.error);
        if (profile.photos.length > 0) {
            handleGallery({ ...query, data: `gallery_view_self_0` });
        } else {
            viewProfile(chatId);
        }
        return;
    }

    try {
        await bot.editMessageMedia({ type: 'photo', media: photoId }, { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: keyboard } });
    } catch (error) {
        await bot.deleteMessage(chatId, message.message_id).catch(()=>{});
        await bot.sendPhoto(chatId, photoId, { reply_markup: { inline_keyboard: keyboard } }).catch(console.error);
    }
}

async function handleGifting(queryOrMsg, step) {
    const isMsg = !!queryOrMsg.text;
    const chatId = isMsg ? queryOrMsg.chat.id : queryOrMsg.message.chat.id;

    if (queryOrMsg.data === 'gift_start') {
        userState[chatId] = { action: 'gifting_id' };
        return bot.sendMessage(chatId, "Who do you want to gift coins to? Please enter their User ID.").catch(console.error);
    }

    const state = userState[chatId];
    if (!state) return;

    const db = readDb();

    if (step === 'amount') {
        const targetId = queryOrMsg.text;
        if (!db.users[targetId]) {
            return bot.sendMessage(chatId, "User ID not found. Please try again.").catch(console.error);
        }
        state.targetId = targetId;
        state.action = 'gifting_amount';
        return bot.sendMessage(chatId, `How many coins do you want to gift to ${db.users[targetId].name}?`).catch(console.error);
    }

    if (step === 'confirm') {
        const amount = parseInt(queryOrMsg.text, 10);
        if (isNaN(amount) || amount <= 0) {
            return bot.sendMessage(chatId, "Please enter a valid positive number.").catch(console.error);
        }
        const senderProfile = db.users[chatId];
        if (senderProfile.coins < amount) {
            return bot.sendMessage(chatId, "You don't have enough coins to make this gift.").catch(console.error);
        }
        state.amount = amount;
        const targetProfile = db.users[state.targetId];
        const text = `You are about to gift ${amount} coins to ${targetProfile.name}. This is irreversible. Confirm?`;
        const keyboard = [[{ text: "✅ Yes, Gift Coins", callback_data: `gift_confirm` }, { text: "❌ Cancel", callback_data: "back_to_menu" }]];
        return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } }).catch(console.error);
    }

    if (queryOrMsg.data === 'gift_confirm') {
        const { targetId, amount } = state;
        const senderProfile = db.users[chatId];
        const receiverProfile = db.users[targetId];

        senderProfile.coins -= amount;
        receiverProfile.coins += amount;
        writeDb(db);

        delete userState[chatId];
        await bot.editMessageText("✅ Gift sent successfully!", { chat_id: chatId, message_id: queryOrMsg.message.message_id }).catch(console.error);
        await bot.sendMessage(targetId, `🎁 You have received a gift of ${amount} coins from ${senderProfile.name}!`).catch(console.error);
    }
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
        return bot.editMessageText("No one has viewed your profile recently.", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Profile", callback_data: "profile_view" }]] } }).catch(console.error);
    }

    let text = "Here are the recent viewers of your profile:\n\n";
    const recentViewers = viewers.slice(-10).reverse(); // Show last 10
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
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Profile", callback_data: "profile_view" }]] }
    }).catch(console.error);
}

// --- SERVER LISTENER ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot is set up to receive updates at ${RENDER_URL}`);
});
