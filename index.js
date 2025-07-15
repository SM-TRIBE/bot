// Main bot file for Telegram: index.js (Enhanced with Admin & Report System)

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
            const defaultDb = { users: {}, matches: {}, reports: [] };
            fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2));
            return defaultDb;
        }
        const data = fs.readFileSync(dbPath);
        const jsonData = JSON.parse(data);
        // Ensure reports array exists for backward compatibility
        if (!jsonData.reports) {
            jsonData.reports = [];
        }
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

app.get('/', (req, res) => {
    res.send('Telegram Dating Bot is running!');
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
        else if (state.action === 'reporting') handleReportSubmission(msg);
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
            case 'admin': handleAdminActions(query); break;
            case 'report': handleReportActions(query); break;
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
        case 'ban': banOrUnbanUser(chatId, param1, true, message.message_id); break;
        case 'unban': banOrUnbanUser(chatId, param1, false, message.message_id); break;
        case 'broadcast': promptForBroadcast(chatId); break;
        case 'reports': listOpenReports(chatId, message.message_id, parseInt(param1, 10)); break;
        case 'report':
            if (param1 === 'view') viewReport(chatId, param2, message.message_id);
            if (param1 === 'resolve') resolveReport(chatId, param2, message.message_id);
            break;
    }
}

// ... (Rest of Admin functions are the same as previous version)

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
    bot.sendMessage(reporterId, "Please state the reason for your report. Your report will be sent to the administrator for review.");
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
    db.reports.push(newReport);
    writeDb(db);

    delete userState[reporterId];
    bot.sendMessage(reporterId, "Thank you. Your report has been submitted and will be reviewed by an administrator.");
    bot.sendMessage(ADMIN_CHAT_ID, `🚨 New user report received. Go to /admin -> Manage Reports to review.`);
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
    });
}

function viewReport(chatId, reportId, messageId) {
    const db = readDb();
    const report = db.reports.find(r => r.reportId === reportId);
    if (!report) return bot.sendMessage(chatId, "Report not found.");

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
    });
}

function resolveReport(chatId, reportId, messageId) {
    const db = readDb();
    const reportIndex = db.reports.findIndex(r => r.reportId === reportId);
    if (reportIndex !== -1) {
        db.reports[reportIndex].status = 'closed';
        writeDb(db);
        bot.answerCallbackQuery(chatId, { text: "Report marked as resolved." });
    }
    listOpenReports(chatId, messageId, 0);
}


// --- PROFILE ACTIONS (FIXED) ---
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

// THIS FUNCTION WAS MISSING
function startProfileCreation(chatId) {
    const db = readDb();
    if (!db.users[chatId]) {
        db.users[chatId] = { id: chatId, coins: 100, likes: [], photos: [], lastDaily: null, boostUntil: null, banned: false };
        writeDb(db);
    }
    userState[chatId] = { action: 'creating_profile', step: 'name' };
    bot.sendMessage(chatId, "👋 Let's create your profile!\n\nFirst, what's your name?");
}

// --- All other functions are the same as the previous version ---
// ... (omitted for brevity)

// --- SERVER LISTENER ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot is set up to receive updates at ${RENDER_URL}`);
});
