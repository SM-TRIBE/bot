// Main bot file for Telegram: index.js (Enhanced for Render Deployment)

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL; // Provided by Render
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !RENDER_URL) {
    console.error("FATAL ERROR: TELEGRAM_TOKEN and RENDER_EXTERNAL_URL must be set in your environment variables.");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN);
// Set webhook
bot.setWebHook(`${RENDER_URL}/bot${TELEGRAM_TOKEN}`);

const app = express();
app.use(express.json());

// --- DATABASE SETUP ---
const dbPath = path.join(__dirname, 'data', 'db.json'); // Store db in a 'data' directory
// Ensure the data directory exists
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

function getProfileText(profile, extended = false) {
    if (!profile) return "Profile not found.";
    let text = `👤 **Name:** ${profile.name || 'N/A'}\n`;
    text += `🎂 **Age:** ${profile.age || 'N/A'}\n`;
    text += `⚧️ **Gender:** ${profile.gender || 'N/A'}\n`;
    text += `🏙️ **City:** ${profile.city || 'N/A'}\n`;
    text += `🎨 **Interests:** ${(profile.interests || []).join(', ') || 'N/A'}\n`;
    if (extended) {
        text += `📝 **Limits:** ${profile.limits || 'Not set'}\n`;
        text += `ℹ️ **Extra Info:** ${profile.extraInfo || 'Not set'}\n`;
        text += `💰 **Coins:** ${profile.coins}\n`;
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
            [{ text: "🔍 Search", callback_data: "search_start" }, { text: "❤️ My Matches", callback_data: "my_matches" }]
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
        console.error("Error sending main menu:", error.code, error.response?.body);
        if (error.code === 'ETELEGRAM' && messageId) { // If editing fails, send new message
            await bot.sendMessage(chatId, text, options);
        }
    }
}

// --- WEBHOOK & MESSAGE ROUTERS ---

// We are receiving updates at the route below!
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    // Ignore commands in the general message handler
    if (msg.text && msg.text.startsWith('/')) return;

    const state = userState[chatId];
    if (!state) return;

    try {
        if (state.action === 'creating_profile') {
            handleCreationWizard(msg);
        } else if (state.action.startsWith('editing_')) {
            handleFieldEdit(msg);
        }
    } catch (error) {
        console.error("Error in message handler:", error);
        bot.sendMessage(chatId, "An error occurred. Please try again.");
    }
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    bot.answerCallbackQuery(query.id); // Acknowledge press

    try {
        const [action, ...params] = query.data.split('_');
        switch (action) {
            case 'profile': handleProfileActions(query); break;
            case 'search': handleSearchActions(query); break;
            case 'like': handleLikeAction(query); break;
            case 'gallery': handleGallery(query); break;
            case 'my': if (params[0] === 'matches') handleMyMatches(query); break;
            case 'wizard': handleCreationWizard(query); break;
            case 'back': sendMainMenu(chatId, query.message.message_id); break;
            default: bot.sendMessage(chatId, "Unknown command.");
        }
    } catch (error) {
        console.error("Error in callback query handler:", error);
        bot.sendMessage(chatId, "An error occurred. Please try again.");
    }
});

bot.onText(/\/start/, (msg) => sendMainMenu(msg.chat.id));

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
    if (!profile) return bot.sendMessage(chatId, "Please create a profile first with /start.");

    const profileText = getProfileText(profile, true);
    const keyboard = [
        [{ text: "✏️ Edit Profile", callback_data: "profile_edit" }, { text: "🖼️ My Photo Gallery", callback_data: "gallery_view" }],
        [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
    ];
    const options = {
        caption: profileText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    };

    try {
        // To prevent errors, always delete the old message and send a new one for profile view.
        // This handles transitions from text-only messages to photo messages gracefully.
        if (messageId) await bot.deleteMessage(chatId, messageId).catch(e => console.log("Old message not found, sending new one."));
        
        if (profile.photos && profile.photos.length > 0) {
            await bot.sendPhoto(chatId, profile.photos[0], options);
        } else {
            await bot.sendMessage(chatId, profileText, { ...options, caption: null }); // remove caption for text-only
        }
    } catch (error) {
        console.error("Error in viewProfile:", error.code, error.response?.body);
        await bot.sendMessage(chatId, "There was an error displaying your profile. Please try again.");
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
        console.error("Error showing edit menu:", error.code);
        viewProfile(chatId, messageId); // Fallback to re-rendering the profile
    }
}

function promptForField(chatId, field) {
    userState[chatId] = { action: `editing_${field}` };
    let promptText = `Please enter your new ${field}.`;
    if (field === 'interests') promptText += " (separated by commas)";
    if (field === 'photo') promptText = "Please send a photo to add to your gallery.";
    bot.sendMessage(chatId, promptText);
}

async function handleFieldEdit(msg) {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    if (!state) return;

    const db = readDb();
    const field = state.action.split('_')[1];
    let updated = false;

    if (msg.photo && field === 'photo') {
        if (!db.users[chatId].photos) db.users[chatId].photos = [];
        db.users[chatId].photos.push(msg.photo[msg.photo.length - 1].file_id);
        updated = true;
    } else if (msg.text) {
        if (field === 'age') {
            const age = parseInt(msg.text, 10);
            if (!isNaN(age) && age >= 18 && age <= 99) {
                db.users[chatId].age = age;
                updated = true;
            } else {
                bot.sendMessage(chatId, "Invalid age. Please enter a number between 18 and 99.");
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
        await bot.sendMessage(chatId, `✅ Your ${field} has been updated!`);
        delete userState[chatId];
        setTimeout(() => viewProfile(chatId), 500);
    }
}

// --- PROFILE CREATION WIZARD ---
function startProfileCreation(chatId) {
    const db = readDb();
    if (!db.users[chatId]) {
        db.users[chatId] = { id: chatId, coins: 100, likes: [], photos: [] };
        writeDb(db);
    }
    userState[chatId] = { action: 'creating_profile', step: 'name' };
    bot.sendMessage(chatId, "👋 Let's create your profile!\n\nFirst, what's your name?");
}

function handleCreationWizard(queryOrMsg) {
    const isMsg = !!queryOrMsg.text;
    const chatId = isMsg ? queryOrMsg.chat.id : queryOrMsg.message.chat.id;
    const state = userState[chatId];
    if (!state) return;

    const db = readDb();
    const profile = db.users[chatId];

    const nextStep = (step, question, options = {}) => {
        userState[chatId].step = step;
        bot.sendMessage(chatId, question, options);
    };

    // Process current step
    switch (state.step) {
        case 'name':
            if (!isMsg) return;
            profile.name = queryOrMsg.text;
            nextStep('age', 'Great! Now, how old are you?');
            break;
        case 'age':
            if (!isMsg) return;
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
            if (!isMsg) return;
            profile.city = queryOrMsg.text;
            nextStep('interests', 'Almost done! List some interests, separated by commas (e.g., Hiking, Movies).');
            break;
        case 'interests':
            if (!isMsg) return;
            profile.interests = queryOrMsg.text.split(',').map(s => s.trim());
            nextStep('photo', 'Last step! Send me a photo for your profile.');
            break;
        case 'photo':
            if (!queryOrMsg.photo) return bot.sendMessage(chatId, "Please send a photo.");
            profile.photos.push(queryOrMsg.photo[queryOrMsg.photo.length - 1].file_id);
            bot.sendMessage(chatId, "🎉 All done! Your profile has been created.");
            delete userState[chatId];
            writeDb(db);
            setTimeout(() => viewProfile(chatId), 500);
            return; // End of wizard
    }
    writeDb(db); // Save progress after each step
}

// --- PHOTO GALLERY ---
async function handleGallery(query) {
    const { message, data } = query;
    const [_, action, targetId, indexStr] = data.split('_');
    const chatId = message.chat.id;

    const db = readDb();
    const profile = db.users[targetId || chatId];
    if (!profile || !profile.photos || profile.photos.length === 0) {
        return bot.sendMessage(chatId, "No photos in the gallery.");
    }

    let index = parseInt(indexStr, 10) || 0;

    if (action === 'next') index++;
    if (action === 'prev') index--;
    index = (index + profile.photos.length) % profile.photos.length; // Wrap around

    const photoId = profile.photos[index];
    const isOwnProfile = String(chatId) === String(targetId || chatId);

    const keyboard = [];
    const navRow = [];
    if (profile.photos.length > 1) {
        navRow.push({ text: "⬅️ Prev", callback_data: `gallery_prev_${targetId || chatId}_${index}` });
        navRow.push({ text: "Next ➡️", callback_data: `gallery_next_${targetId || chatId}_${index}` });
    }
    if(navRow.length > 0) keyboard.push(navRow);
    
    if (isOwnProfile) {
        keyboard.push([{ text: "🗑️ Delete This Photo", callback_data: `gallery_delete_${chatId}_${index}` }]);
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
            handleGallery({ ...query, data: `gallery_view_${chatId}_0` }); // Show first photo
        } else {
            viewProfile(chatId);
        }
        return;
    }

    try {
        await bot.editMessageMedia({ type: 'photo', media: photoId }, { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: keyboard } });
    } catch (error) {
        console.error("Error in gallery view:", error.code);
        await bot.deleteMessage(chatId, message.message_id).catch(()=>{});
        await bot.sendPhoto(chatId, photoId, { reply_markup: { inline_keyboard: keyboard } });
    }
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
            else if (field === 'age') executeSearch(message.chat.id, message.message_id);
            break;
        case 'result':
            bot.deleteMessage(message.chat.id, message.message_id).catch(()=>{});
            showSearchResult(message.chat.id, field); // field is 'next' or 'prev'
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
    const results = Object.values(db.users).filter(u =>
        u.id !== chatId && u.gender === searchCriteria.gender && u.age >= minAge && u.age <= maxAge
    );

    if (results.length === 0) {
        bot.editMessageText("😔 No users found matching your criteria.", { chat_id: chatId, message_id: messageId });
        delete userState[chatId].search;
        return;
    }

    searchCache[chatId] = { results, index: -1 };
    bot.deleteMessage(chatId, messageId).catch(()=>{});
    bot.sendMessage(chatId, `Found ${results.length} potential matches!`);
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
        [{ text: "❤️ Like", callback_data: `like_${profile.id}` }, { text: "👎 Next", callback_data: "search_result_next" }],
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

    if (!likerProfile || !likedProfile) return bot.sendMessage(likerId, "Error: Profile not found.");
    if (likerProfile.coins < 10) return bot.sendMessage(likerId, "You don't have enough coins to like a profile.");
    if (likerProfile.likes.includes(likedId)) return bot.sendMessage(likerId, "You've already liked this profile.");

    likerProfile.coins -= 10;
    likerProfile.likes.push(likedId);
    await bot.deleteMessage(likerId, message.message_id).catch(()=>{});

    if (likedProfile.likes?.includes(String(likerId))) {
        // MATCH
        const matchId = uuidv4();
        db.matches[matchId] = { users: [String(likerId), String(likedId)], date: new Date().toISOString() };
        
        const likerTg = await bot.getChat(likerId);
        const likedTg = await bot.getChat(likedId);

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
            const otherTg = await bot.getChat(otherUserId);
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
