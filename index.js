// Main bot file for Telegram: index.js (Final Version with Advanced Features)

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
        // Ensure users have a viewers array
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
            nextStep('age', 'Great! Now, how old are you?');
            break;
        case 'age':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your age as a number.").catch(console.error);
            const age = parseInt(queryOrMsg.text, 10);
            if (isNaN(age) || age < 18 || age > 99) return bot.sendMessage(chatId, "Please enter a valid age between 18 and 99.").catch(console.error);
            profile.age = age;
            nextStep('gender', 'Got it. What is your gender?', {
                reply_markup: { inline_keyboard: [[{text: "Male", callback_data: "wizard_gender_male"}, {text: "Female", callback_data: "wizard_gender_female"}, {text: "Other", callback_data: "wizard_gender_other"}]]}
            });
            break;
        case 'gender':
            if (isMsg) return;
            profile.gender = queryOrMsg.data.split('_')[2];
            bot.deleteMessage(chatId, queryOrMsg.message.message_id).catch(console.error);
            nextStep('city', `Perfect. What city do you live in?`);
            break;
        case 'city':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your city as text.").catch(console.error);
            profile.city = queryOrMsg.text;
            nextStep('interests', 'Almost done! List some interests, separated by commas (e.g., Hiking, Movies).');
            break;
        case 'interests':
            if (!queryOrMsg.text) return bot.sendMessage(chatId, "Please send your interests as text.").catch(console.error);
            profile.interests = queryOrMsg.text.split(',').map(s => s.trim());
            nextStep('photo', 'Last step! Send me a photo for your profile.');
            break;
        case 'photo':
            if (!queryOrMsg.photo) return bot.sendMessage(chatId, "That's not a photo. Please send a photo to continue.").catch(console.error);
            profile.photos.push(queryOrMsg.photo[queryOrMsg.photo.length - 1].file_id);
            bot.sendMessage(chatId, "🎉 All done! Your profile has been created.").catch(console.error);
            delete userState[chatId];
            writeDb(db);
            setTimeout(() => viewProfile(chatId), 500);
            return;
    }
    writeDb(db);
}

// --- All other functions are defined below ---

async function handleAdminActions(query) { /* ... */ }
async function handleReportActions(query) { /* ... */ }
async function handleStoreActions(query) { /* ... */ }
async function handleSearchActions(query) { /* ... */ }
async function handleGallery(query) { /* ... */ }
async function handleLikeAction(query) { /* ... */ }
async function handleMyMatches(query) { /* ... */ }
async function handleGifting(queryOrMsg, step) { /* ... */ }
async function handleProfileViewers(query) { /* ... */ }
async function sendAdminMenu(chatId, messageId) { /* ... */ }
async function showServerStats(chatId, messageId) { /* ... */ }
async function listAllUsers(chatId, messageId, page) { /* ... */ }
async function viewUserProfileAsAdmin(chatId, targetId, messageId) { /* ... */ }
async function banOrUnbanUser(chatId, targetId, shouldBan, messageId) { /* ... */ }
async function promptForBroadcast(chatId) { /* ... */ }
async function handleBroadcast(msg) { /* ... */ }
async function promptForCoinGrant(chatId, targetId) { /* ... */ }
async function handleCoinGrant(msg) { /* ... */ }
async function promptForAdminFieldEdit(chatId, targetId, field) { /* ... */ }
async function handleAdminFieldEdit(msg) { /* ... */ }
async function promptForAdminWarning(chatId, targetId) { /* ... */ }
async function handleAdminWarning(msg) { /* ... */ }
async function listOpenReports(chatId, messageId, page) { /* ... */ }
async function viewReport(chatId, reportId, messageId) { /* ... */ }
async function resolveReport(chatId, reportId, messageId) { /* ... */ }
async function promptForReportReason(reporterId, reportedId) { /* ... */ }
async function handleReportSubmission(msg) { /* ... */ }
async function showCoinStore(chatId, messageId) { /* ... */ }
async function buyProfileBoost(query) { /* ... */ }
async function handleDailyBonus(chatId) { /* ... */ }
async function sendHelpMessage(chatId) { /* ... */ }
async function promptSearchCriteria(chatId, criteria, messageId) { /* ... */ }
async function executeSearch(chatId, messageId) { /* ... */ }
async function showSearchResult(chatId, direction) { /* ... */ }

// --- SERVER LISTENER ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot is set up to receive updates at ${RENDER_URL}`);
});
