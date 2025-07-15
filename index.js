// Main bot file for Telegram: index.js (Enhanced with Admin Panel)

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Your personal Telegram Chat ID

if (!TELEGRAM_TOKEN || !RENDER_URL || !ADMIN_CHAT_ID) {
    console.error("FATAL ERROR: TELEGRAM_TOKEN, RENDER_EXTERNAL_URL, and ADMIN_CHAT_ID must be set in your environment variables.");
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
            const defaultDb = { users: {}, matches: {} };
            fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2));
            return defaultDb;
        }
        const data = fs.readFileSync(dbPath);
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        return { users: {}, matches: {} };
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
            [{ text: "💰 Coin Store", callback_data: "store_view" }]
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
            await bot.sendMessage(chatId, text, options);
        }
    }
}

// --- WEBHOOK & MESSAGE ROUTERS ---

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const db = readDb();
    if (db.users[chatId]?.banned) {
        return bot.sendMessage(chatId, "You have been banned from using this bot.");
    }

    if (msg.text && msg.text.startsWith('/')) return;

    const state = userState[chatId];
    if (!state) return;

    try {
        if (state.action === 'creating_profile') handleCreationWizard(msg);
        else if (state.action.startsWith('editing_')) handleFieldEdit(msg);
        else if (state.action === 'broadcasting') handleBroadcast(msg);
        else if (state.action === 'granting_coins') handleCoinGrant(msg);
    } catch (error) {
        console.error("Error in message handler:", error);
        bot.sendMessage(chatId, "An error occurred. Please type /start to reset.");
        delete userState[chatId];
    }
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const db = readDb();
    if (db.users[chatId]?.banned) {
        return bot.answerCallbackQuery(query.id, { text: "You are banned.", show_alert: true });
    }

    bot.answerCallbackQuery(query.id);

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
            case 'admin': handleAdminActions(query); break; // Admin router
            case 'back': sendMainMenu(chatId, query.message.message_id); break;
            default: bot.sendMessage(chatId, "Unknown command.");
        }
    } catch (error) {
        console.error("Error in callback query handler:", error);
        bot.sendMessage(chatId, "An error occurred. Please try again.");
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
        bot.sendMessage(msg.chat.id, "You are not authorized to use this command.");
    }
});

// --- ADMIN PANEL ---

function sendAdminMenu(chatId, messageId = null) {
    const text = "👑 *Admin Panel*\nWelcome, administrator. What would you like to do?";
    const keyboard = [
        [{ text: "📊 Server Stats", callback_data: "admin_stats" }],
        [{ text: "👥 Manage Users", callback_data: "admin_list_users_0" }],
        [{ text: "📢 Broadcast Message", callback_data: "admin_broadcast" }]
    ];
    const options = { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } };

    if (messageId) {
        bot.editMessageText(text, { ...options, chat_id: chatId, message_id: messageId });
    } else {
        bot.sendMessage(chatId, text, options);
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
        case 'ban': banOrUnbanUser(chatId, param1, true); break;
        case 'unban': banOrUnbanUser(chatId, param1, false); break;
        case 'broadcast': promptForBroadcast(chatId); break;
    }
}

function showServerStats(chatId, messageId) {
    const db = readDb();
    const totalUsers = Object.keys(db.users).length;
    const totalMatches = Object.keys(db.matches).length;
    const dbSize = fs.existsSync(dbPath) ? (fs.statSync(dbPath).size / 1024).toFixed(2) : 0;

    const text = `*Server Statistics*\n\n` +
                 `- Total Users: ${totalUsers}\n` +
                 `- Total Matches: ${totalMatches}\n` +
                 `- Database Size: ${dbSize} KB`;

    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "admin_menu" }]] }
    });
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
            text += `- ${user.name || 'N/A'} (ID: \`${user.id}\`)\n`;
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
    });
}

function viewUserProfileAsAdmin(chatId, targetId, messageId) {
    const db = readDb();
    const profile = db.users[targetId];
    if (!profile) return bot.sendMessage(chatId, "User not found.");

    const text = getProfileText(profile, true, true);
    const keyboard = [
        [{ text: "💰 Grant Coins", callback_data: `admin_grant_${targetId}` }],
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
    });
}

function promptForBroadcast(chatId) {
    userState[chatId] = { action: 'broadcasting' };
    bot.sendMessage(chatId, "Please send the message you want to broadcast to all users. Type /cancel to abort.");
}

async function handleBroadcast(msg) {
    const chatId = msg.chat.id;
    if (msg.text === '/cancel') {
        delete userState[chatId];
        return bot.sendMessage(chatId, "Broadcast cancelled.");
    }

    const db = readDb();
    const allUserIds = Object.keys(db.users);
    let successCount = 0;
    let failCount = 0;

    await bot.sendMessage(chatId, `Starting broadcast to ${allUserIds.length} users. This may take a while...`);

    for (const userId of allUserIds) {
        try {
            await bot.sendMessage(userId, msg.text);
            successCount++;
        } catch (error) {
            console.error(`Failed to send broadcast to ${userId}:`, error.code);
            failCount++;
        }
        // Small delay to avoid hitting rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    delete userState[chatId];
    await bot.sendMessage(chatId, `Broadcast finished.\n\n✅ Sent successfully: ${successCount}\n❌ Failed to send: ${failCount}`);
    sendAdminMenu(chatId);
}

function promptForCoinGrant(chatId, targetId) {
    userState[chatId] = { action: 'granting_coins', targetId: targetId };
    bot.sendMessage(chatId, `How many coins would you like to grant to user \`${targetId}\`?`, { parse_mode: "Markdown" });
}

function handleCoinGrant(msg) {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    const amount = parseInt(msg.text, 10);

    if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, "Please enter a valid positive number.");
    }

    const db = readDb();
    const targetProfile = db.users[state.targetId];
    if (!targetProfile) {
        bot.sendMessage(chatId, "Target user not found.");
    } else {
        targetProfile.coins += amount;
        writeDb(db);
        bot.sendMessage(chatId, `✅ Successfully granted ${amount} coins to user ${targetProfile.name} (\`${targetProfile.id}\`).`);
        bot.sendMessage(targetProfile.id, `An administrator has granted you ${amount} coins!`);
    }
    delete userState[chatId];
    sendAdminMenu(chatId);
}

function banOrUnbanUser(chatId, targetId, shouldBan) {
    const db = readDb();
    const targetProfile = db.users[targetId];
    if (!targetProfile) return bot.sendMessage(chatId, "User not found.");

    targetProfile.banned = shouldBan;
    writeDb(db);

    const actionText = shouldBan ? "banned" : "unbanned";
    bot.sendMessage(chatId, `User ${targetProfile.name} (\`${targetId}\`) has been ${actionText}.`);
    bot.sendMessage(targetId, `You have been ${actionText} by an administrator.`);

    listAllUsers(chatId, null, 0); // Refresh user list
}


// --- CURRENCY & STORE ---

function handleStoreActions(query) {
    const { message, data } = query;
    const [_, action] = data.split('_');

    switch (action) {
        case 'view': showCoinStore(message.chat.id, message.message_id); break;
        case 'boost': buyProfileBoost(message.chat.id, message.message_id); break;
    }
}

function showCoinStore(chatId, messageId) {
    const db = readDb();
    const profile = db.users[chatId];
    const text = `💰 **Coin Store**\n\nYour balance: ${profile.coins} coins.\n\n` +
                 `Use your coins to get noticed!\n\n` +
                 `🚀 **Profile Boost (50 Coins)**\n` +
                 `Your profile will appear at the top of search results for 24 hours.`;
    const keyboard = [
        [{ text: "🚀 Boost My Profile (50 Coins)", callback_data: "store_boost" }],
        [{ text: "Claim Daily Bonus (/daily)", callback_data: "ignore" }], // Dummy button
        [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
    ];
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

function buyProfileBoost(chatId, messageId) {
    const db = readDb();
    const profile = db.users[chatId];
    const cost = 50;

    if (profile.coins < cost) {
        return bot.answerCallbackQuery(query.id, { text: "You don't have enough coins!", show_alert: true });
    }

    profile.coins -= cost;
    const now = new Date();
    // If already boosted, add 24 hours to the existing time. Otherwise, set from now.
    const currentBoost = (profile.boostUntil && new Date(profile.boostUntil) > now) ? new Date(profile.boostUntil) : now;
    profile.boostUntil = new Date(currentBoost.getTime() + 24 * 60 * 60 * 1000);
    writeDb(db);

    bot.answerCallbackQuery(query.id, { text: "Success! Your profile is boosted for 24 hours.", show_alert: true });
    showCoinStore(chatId, messageId);
}

function handleDailyBonus(chatId) {
    const db = readDb();
    const profile = db.users[chatId];
    if (!profile) return bot.sendMessage(chatId, "You need a profile to claim a bonus. Use /start to create one.");

    const now = new Date();
    const lastDaily = profile.lastDaily ? new Date(profile.lastDaily) : null;

    if (lastDaily && (now - lastDaily) < 24 * 60 * 60 * 1000) {
        const hoursLeft = (24 - (now - lastDaily) / (1000 * 60 * 60)).toFixed(1);
        return bot.sendMessage(chatId, `You have already claimed your daily bonus. Please wait ${hoursLeft} more hours.`);
    }

    const bonus = 25;
    profile.coins += bonus;
    profile.lastDaily = now.toISOString();
    writeDb(db);

    bot.sendMessage(chatId, `🎉 You have claimed your daily bonus of ${bonus} coins! Your new balance is ${profile.coins}.`);
}

function sendHelpMessage(chatId) {
    let text = `*Welcome to the Dating Bot! Here's how to use it:*\n\n` +
               `*/start* - Shows the main menu.\n` +
               `*/profile* - View and manage your profile.\n` +
               `*/search* - Find other users.\n` +
               `*/matches* - See who you've matched with.\n\n` +
               `*Currency System*\n` +
               `- You spend **10 coins** to 'Like' a profile.\n` +
               `- Use */daily* once every 24 hours to get **25 free coins**.\n` +
               `- Visit the *Coin Store* from the main menu to buy a **Profile Boost**!`;

    if (String(chatId) === ADMIN_CHAT_ID) {
        text += `\n\n*👑 Admin Commands*\n` +
                `*/admin* - Access the admin panel to manage users, view stats, and send broadcasts.`;
    }

    bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

// --- ALL OTHER FUNCTIONS (Profile, Search, Match, Gallery) ---
// These functions are largely the same as the previous version, but with
// added checks for banned status and other minor improvements.

async function handleCreationWizard(queryOrMsg) {
    const isMsg = !!queryOrMsg.text || !!queryOrMsg.photo;
    const chatId = isMsg ? queryOrMsg.chat.id : queryOrMsg.message.chat.id;
    const state = userState[chatId];
    if (!state) return;

    const db = readDb();
    const profile = db.users[chatId];

    const nextStep = (step, question, options = {}) => {
        userState[chatId].step = step;
        bot.sendMessage(chatId, question, options);
    };

    switch (state.step) {
        case 'name':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your name as text.");
            profile.name = queryOrMsg.text;
            nextStep('age', 'Great! Now, how old are you?');
            break;
        case 'age':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your age as a number.");
            const age = parseInt(queryOrMsg.text, 10);
            if (isNaN(age) || age < 18 || age > 99) return bot.sendMessage(chatId, "Please enter a valid age between 18 and 99.");
            profile.age = age;
            nextStep('gender', 'Got it. What is your gender?', {
                reply_markup: { inline_keyboard: [[{text: "Male", callback_data: "wizard_gender_male"}, {text: "Female", callback_data: "wizard_gender_female"}, {text: "Other", callback_data: "wizard_gender_other"}]]}
            });
            break;
        case 'gender':
            if (isMsg) return;
            profile.gender = queryOrMsg.data.split('_')[2];
            bot.deleteMessage(chatId, queryOrMsg.message.message_id);
            nextStep('city', `Perfect. What city do you live in?`);
            break;
        case 'city':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your city as text.");
            profile.city = queryOrMsg.text;
            nextStep('interests', 'Almost done! List some interests, separated by commas (e.g., Hiking, Movies).');
            break;
        case 'interests':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your interests as text.");
            profile.interests = queryOrMsg.text.split(',').map(s => s.trim());
            nextStep('photo', 'Last step! Send me a photo for your profile.');
            break;
        case 'photo':
            if (!queryOrMsg.photo) return bot.sendMessage(chatId, "That's not a photo. Please send a photo to continue.");
            profile.photos.push(queryOrMsg.photo[queryOrMsg.photo.length - 1].file_id);
            bot.sendMessage(chatId, "🎉 All done! Your profile has been created.");
            delete userState[chatId];
            writeDb(db);
            setTimeout(() => viewProfile(chatId), 500);
            return;
    }
    writeDb(db);
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
         keyboard.push([{ text: "❤️ Like Profile", callback_data: `like_${targetId}` }]);
         keyboard.push([{ text: "👎 Next Profile", callback_data: "search_result_next" }]);
    }
    
    if (action === 'delete' && isOwnProfile) {
        profile.photos.splice(index, 1);
        writeDb(db);
        await bot.deleteMessage(chatId, message.message_id);
        bot.sendMessage(chatId, "Photo deleted.");
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
        await bot.sendPhoto(chatId, photoId, { reply_markup: { inline_keyboard: keyboard } });
    }
}

async function handleSearchActions(query) {
    const { message, data } = query;
    const [_, subAction, field, value] = data.split('_');

    switch(subAction) {
        case 'start': promptSearchCriteria(message.chat.id, 'gender', message.message_id); break;
        case 'criteria':
            userState[message.chat.id] = userState[message.chat.id] || { search: {} };
            userState[message.chat.id].search[field] = value;
            if (field === 'gender') promptSearchCriteria(message.chat.id, 'age', message.message_id);
            else if (field === 'age') executeSearch(message.chat.id, message.message_id);
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
    }
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}

function executeSearch(chatId, messageId) {
    const db = readDb();
    const searchCriteria = userState[chatId]?.search;
    if (!searchCriteria) return bot.sendMessage(chatId, "Search expired. Please start again.");
    
    const [minAge, maxAge] = searchCriteria.age.split('-').map(Number);
    
    const now = new Date();
    const results = Object.values(db.users).filter(u =>
        u.id !== chatId && !u.banned && u.gender === searchCriteria.gender && u.age >= minAge && u.age <= maxAge
    ).sort((a, b) => {
        const aBoosted = a.boostUntil && new Date(a.boostUntil) > now;
        const bBoosted = b.boostUntil && new Date(b.boostUntil) > now;
        if (aBoosted && !bBoosted) return -1;
        if (!aBoosted && bBoosted) return 1;
        return 0;
    });

    if (results.length === 0) {
        bot.editMessageText("😔 No users found matching your criteria.", { chat_id: chatId, message_id: messageId });
        delete userState[chatId].search;
        return;
    }

    searchCache[chatId] = { results, index: -1 };
    bot.deleteMessage(chatId, messageId).catch(()=>{});
    bot.sendMessage(chatId, `Found ${results.length} potential matches! Boosted profiles are shown first.`);
    showSearchResult(chatId, 'next');
    delete userState[chatId].search;
}

async function showSearchResult(chatId, direction) {
    const cache = searchCache[chatId];
    if (!cache || cache.results.length === 0) return bot.sendMessage(chatId, "Search session expired or no results found.");

    if (direction === 'next') cache.index++;
    if (direction === 'prev') cache.index--;

    if (cache.index >= cache.results.length) {
        cache.index = cache.results.length - 1;
        return bot.sendMessage(chatId, "You've reached the end of the search results.");
    }
    if (cache.index < 0) {
        cache.index = 0;
        return bot.sendMessage(chatId, "You're at the beginning of the search results.");
    }

    const profile = cache.results[cache.index];
    const profileText = getProfileText(profile);
    const keyboard = [
        [{ text: "❤️ Like (10 Coins)", callback_data: `like_${profile.id}` }, { text: "👎 Next", callback_data: "search_result_next" }],
    ];
    if (profile.photos && profile.photos.length > 1) {
        keyboard.push([{text: "🖼️ View Photo Gallery", callback_data: `gallery_view_${profile.id}_0`}])
    }
    keyboard.push([{ text: "⬅️ End Search", callback_data: "back_to_menu" }]);

    const options = { caption: profileText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };

    if (profile.photos && profile.photos.length > 0) {
        await bot.sendPhoto(chatId, profile.photos[0], options);
    } else {
        await bot.sendMessage(chatId, profileText, { ...options, caption: null });
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
    await bot.deleteMessage(likerId, message.message_id).catch(()=>{});

    if (likedProfile.likes?.includes(String(likerId))) {
        const matchId = uuidv4();
        db.matches[matchId] = { users: [String(likerId), String(likedId)], date: new Date().toISOString() };
        
        const likerTg = await bot.getChat(likerId).catch(() => ({ username: 'user' }));
        const likedTg = await bot.getChat(likedId).catch(() => ({ username: 'user' }));

        await bot.sendMessage(likerId, `🎉 It's a Match with ${likedProfile.name}!`, {
            reply_markup: { inline_keyboard: [[{ text: "💬 Start Chat", url: `https://t.me/${likedTg.username}` }]] }
        });
        await bot.sendMessage(likedId, `🎉 It's a Match with ${likerProfile.name}!`, {
            reply_markup: { inline_keyboard: [[{ text: "💬 Start Chat", url: `https://t.me/${likerTg.username}` }]] }
        });
    } else {
        await bot.sendMessage(likerId, `You liked ${likedProfile.name}'s profile! If they like you back, it's a match.`);
    }
    writeDb(db);
    showSearchResult(likerId, 'next');
}

async function handleMyMatches(query) {
    const chatId = query.message.chat.id;
    const db = readDb();
    const userMatches = Object.values(db.matches).filter(m => m.users.includes(String(chatId)));

    if (userMatches.length === 0) {
        return bot.editMessageText("You have no matches yet. Keep searching!", { chat_id: chatId, message_id: query.message.message_id });
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
    });
}


// --- SERVER LISTENER ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot is set up to receive updates at ${RENDER_URL}`);
});
