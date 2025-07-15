const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;
const webhookUrl = process.env.WEBHOOK_URL + '/webhook';

const bot = new TelegramBot(token, { polling: false });
bot.setWebHook(webhookUrl).catch(err => console.error('Webhook setup failed:', err));

const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log('Server is running'));

// Database Handling
const dbFile = 'db.json';
let db = {};

function loadDb() {
    if (fs.existsSync(dbFile)) {
        db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } else {
        db = { users: {}, reports: [] };
        saveDb();
    }
}

function saveDb() {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

loadDb();

// Utility Functions
function generateUniqueReferralCode() {
    let code;
    do { code = crypto.randomBytes(4).toString('hex'); } while (Object.values(db.users).some(u => u.referralCode === code));
    return code;
}

function getUser(chatId) {
    return db.users[chatId];
}

function saveUser(user) {
    db.users[user.chatId] = user;
    saveDb();
}

function getMainKeyboard(user) {
    const keyboard = [['Search', 'My Profile'], ['Coin Store', 'Get Referral Link']];
    if (user.role === 'admin') keyboard.push(['Admin Panel']);
    else if (user.role === 'sub-admin') keyboard.push(['Sub-Admin Panel']);
    return keyboard;
}

async function showProfile(user, targetChatId, options = {}) {
    const { withEdit = false, withSearchActions = false, viewedBy = null } = options;
    const profileText = `Name: ${user.profile.name}\nAge: ${user.profile.age}\nGender: ${user.profile.gender}\nCity: ${user.profile.city}\nInterests: ${user.profile.interests.join(', ')}\nLimits: ${user.profile.limits}\nExtra Info: ${user.profile.extraInfo}`;
    if (user.profile.photos.length > 0) {
        const media = user.profile.photos.map(fileId => ({ type: 'photo', media: fileId }));
        await bot.sendMediaGroup(targetChatId, media).catch(err => console.error('Send media failed:', err));
    }
    let replyMarkup = {};
    if (withEdit) {
        replyMarkup = { inline_keyboard: [[{ text: 'Edit Profile', callback_data: 'edit_profile' }]] };
    } else if (withSearchActions) {
        replyMarkup = { inline_keyboard: [[{ text: 'Like', callback_data: `like_${user.chatId}` }, { text: 'Next', callback_data: 'next' }, { text: 'Report', callback_data: `report_${user.chatId}` }]] };
        if (viewedBy && getUser(viewedBy)) {
            const viewer = getUser(viewedBy);
            viewer.viewers = viewer.viewers.filter(v => v.chatId !== user.chatId).slice(0, 9);
            viewer.viewers.unshift({ chatId: user.chatId, timestamp: Date.now() });
            saveUser(viewer);
        }
    }
    await bot.sendMessage(targetChatId, profileText, { reply_markup: replyMarkup }).catch(err => console.error('Send message failed:', err));
}

// Profile Creation
async function handleProfileCreation(user, msg) {
    const chatId = user.chatId;
    const step = user.state.step;
    switch (step) {
        case 1: user.profile.name = msg.text; await bot.sendMessage(chatId, `Great, ${msg.text}. How old are you?`); user.state.step = 2; break;
        case 2: {
            const age = parseInt(msg.text);
            if (isNaN(age) || age < 18) await bot.sendMessage(chatId, 'Please enter a valid age (18+).');
            else { user.profile.age = age; await bot.sendMessage(chatId, 'Gender? (Male/Female/Other)'); user.state.step = 3; }
            break;
        }
        case 3: {
            const gender = msg.text.toLowerCase();
            if (['male', 'female', 'other'].includes(gender)) { user.profile.gender = gender; await bot.sendMessage(chatId, 'City?'); user.state.step = 4; }
            else await bot.sendMessage(chatId, 'Valid gender: Male, Female, Other.');
            break;
        }
        case 4: user.profile.city = msg.text; await bot.sendMessage(chatId, 'Interests? (comma-separated)'); user.state.step = 5; break;
        case 5: user.profile.interests = msg.text.split(',').map(i => i.trim()); await bot.sendMessage(chatId, 'Limits? (text)'); user.state.step = 6; break;
        case 6: user.profile.limits = msg.text; await bot.sendMessage(chatId, 'Extra info?'); user.state.step = 7; break;
        case 7: user.profile.extraInfo = msg.text; await bot.sendMessage(chatId, 'Send up to 5 photos. Type /done when finished.'); user.state.step = 8; user.profile.photos = []; break;
        case 8: {
            if (msg.text === '/done') {
                if (user.profile.photos.length === 0) await bot.sendMessage(chatId, 'Send at least one photo.');
                else {
                    user.state = { type: 'idle' };
                    await bot.sendMessage(chatId, 'Profile complete!', { reply_markup: { keyboard: getMainKeyboard(user), resize_keyboard: true } });
                    if (user.pendingReferral) {
                        const referrer = Object.values(db.users).find(u => u.referralCode === user.pendingReferral);
                        if (referrer && referrer.chatId !== chatId) {
                            referrer.coins += 50; saveUser(referrer);
                            await bot.sendMessage(referrer.chatId, '50 coins for referring a new user!');
                            user.coins += 25; await bot.sendMessage(chatId, '25 bonus coins for referral!');
                        }
                        delete user.pendingReferral;
                    }
                    await bot.sendMessage(adminChatId, `New user: ${user.profile.name} (@${msg.from.username})`);
                }
            } else if (msg.photo) {
                if (user.profile.photos.length < 5) {
                    user.profile.photos.push(msg.photo[msg.photo.length - 1].file_id);
                    await bot.sendMessage(chatId, `Photo ${user.profile.photos.length}/5 added. More or /done.`);
                } else await bot.sendMessage(chatId, '5 photos max. Type /done.');
            } else await bot.sendMessage(chatId, 'Send a photo or /done.');
            break;
        }
    }
    saveUser(user);
}

// Search Functionality
async function handleSearch(user, msg) {
    const chatId = user.chatId;
    const step = user.state.step;
    if (step === 1) {
        const gender = msg.text.toLowerCase();
        if (['male', 'female', 'other'].includes(gender)) { user.searchCriteria.gender = gender; await bot.sendMessage(chatId, 'Min age?'); user.state.step = 2; }
        else await bot.sendMessage(chatId, 'Valid gender: Male, Female, Other.');
    } else if (step === 2) {
        const minAge = parseInt(msg.text);
        if (isNaN(minAge) || minAge < 18) await bot.sendMessage(chatId, 'Enter valid min age (18+).');
        else { user.searchCriteria.minAge = minAge; await bot.sendMessage(chatId, 'Max age?'); user.state.step = 3; }
    } else if (step === 3) {
        const maxAge = parseInt(msg.text);
        if (isNaN(maxAge) || maxAge < user.searchCriteria.minAge) await bot.sendMessage(chatId, 'Enter valid max age.');
        else { user.searchCriteria.maxAge = maxAge; await bot.sendMessage(chatId, 'Interests? (comma-separated, or "none")'); user.state.step = 4; }
    } else if (step === 4) {
        user.searchCriteria.interests = msg.text.toLowerCase() === 'none' ? [] : msg.text.split(',').map(i => i.trim());
        const results = Object.values(db.users)
            .filter(u => u.chatId !== chatId && !u.banned && u.profile.gender === user.searchCriteria.gender && u.profile.age >= user.searchCriteria.minAge && u.profile.age <= user.searchCriteria.maxAge && (user.searchCriteria.interests.length === 0 || user.searchCriteria.interests.some(i => u.profile.interests.includes(i))))
            .sort((a, b) => (b.boosts.active && b.boosts.expires > Date.now()) - (a.boosts.active && a.boosts.expires > Date.now()));
        user.searchResults = results.map(u => u.chatId);
        user.state = { type: 'searching', index: 0 };
        if (results.length > 0) await showProfile(getUser(results[0]), chatId, { withSearchActions: true, viewedBy: chatId });
        else { await bot.sendMessage(chatId, 'No matches found.', { reply_markup: { keyboard: getMainKeyboard(user), resize_keyboard: true } }); user.state = { type: 'idle' }; }
    }
    saveUser(user);
}

// Message Handler
bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const text = msg.text || '';
        let user = getUser(chatId);
        if (!user) {
            user = { chatId, state: { type: 'creating_profile', step: 0 }, coins: 100, referralCode: generateUniqueReferralCode(), profile: {}, matches: [], boosts: { active: false }, viewers: [], banned: false, role: chatId === adminChatId ? 'admin' : 'user', likes: [], searchCriteria: {}, searchResults: [] };
            if (text.startsWith('/start ') && text.length > 7) user.pendingReferral = text.substring(7);
            await bot.sendMessage(chatId, 'Welcome! What’s your name?');
            user.state.step = 1;
            saveUser(user);
            return;
        }
        if (user.banned) { await bot.sendMessage(chatId, 'You are banned.'); return; }

        if (user.state.type === 'creating_profile') await handleProfileCreation(user, msg);
        else if (user.state.type === 'editing_profile') {
            if (user.state.field === 'photos') {
                if (msg.text === '/done') {
                    user.state = { type: 'idle' };
                    await bot.sendMessage(chatId, 'Photo editing done.', { reply_markup: { keyboard: getMainKeyboard(user), resize_keyboard: true } });
                } else if (msg.photo && user.profile.photos.length < 5) {
                    user.profile.photos.push(msg.photo[msg.photo.length - 1].file_id);
                    await bot.sendMessage(chatId, `Photo ${user.profile.photos.length}/5 added. More or /done.`);
                }
            } else {
                if (user.state.field === 'age') user.profile[user.state.field] = parseInt(msg.text);
                else if (user.state.field === 'interests') user.profile[user.state.field] = msg.text.split(',').map(i => i.trim());
                else user.profile[user.state.field] = msg.text;
                await bot.sendMessage(chatId, `${user.state.field} updated.`, { reply_markup: { inline_keyboard: [['name', 'age', 'gender', 'city', 'interests', 'limits', 'extraInfo', 'photos'].map(f => ({ text: `Edit ${f}`, callback_data: `edit_${f}` })), [{ text: 'Done', callback_data: 'done_editing' }]] } });
            }
            saveUser(user);
        } else if (user.state.type === 'searching') {
            // Do nothing, handled by callback
        } else if (user.state.type === 'coin_store') {
            await bot.sendMessage(chatId, 'Enter "boost" for Profile Boost (50 coins) or "viewers" for Who Viewed Me (15 coins).');
        } else if (user.state.type === 'admin_action') {
            if (user.state.action === 'grant_coins') {
                const [targetChatId, amount] = msg.text.split(' ');
                const targetUser = getUser(targetChatId);
                if (targetUser) { targetUser.coins += parseInt(amount); saveUser(targetUser); await bot.sendMessage(chatId, `Granted ${amount} coins to ${targetChatId}.`); }
            } else if (user.state.action === 'broadcast') {
                for (const u of Object.values(db.users)) {
                    if (!u.banned) await bot.sendMessage(u.chatId, msg.text).catch(() => {});
                }
                await bot.sendMessage(chatId, 'Broadcast sent.');
            }
            user.state = { type: 'idle' };
            saveUser(user);
        } else if (user.state.type === 'search_setup') {
            await handleSearch(user, msg);
        } else if (user.state.type === 'reporting') {
            db.reports.push({ reporter: chatId, reported: user.state.reported, reason: msg.text, status: 'open' });
            saveDb();
            await bot.sendMessage(chatId, 'Report submitted.', { reply_markup: { keyboard: getMainKeyboard(user), resize_keyboard: true } });
            await bot.sendMessage(adminChatId, `New report from ${chatId} against ${user.state.reported}: ${msg.text}`);
            user.state = { type: 'idle' };
            saveUser(user);
        } else if (user.state.type === 'idle') {
            switch (text) {
                case 'My Profile': await showProfile(user, chatId, { withEdit: true }); break;
                case 'Search': user.state = { type: 'search_setup', step: 1 }; await bot.sendMessage(chatId, 'Gender? (Male/Female/Other)'); break;
                case 'Coin Store': user.state = { type: 'coin_store' }; await bot.sendMessage(chatId, 'Options: "boost" (50 coins), "viewers" (15 coins)'); break;
                case 'Get Referral Link': await bot.sendMessage(chatId, `Your link: https://t.me/${(await bot.getMe()).username}?start=${user.referralCode}`); break;
                case 'Admin Panel': if (user.role === 'admin') await bot.sendMessage(chatId, 'Admin Panel', { reply_markup: { inline_keyboard: [['Stats', 'Users', 'Grant Coins', 'Broadcast', 'Reports', 'Sub-Admins'].map(a => ({ text: a, callback_data: `admin_${a.toLowerCase().replace(' ', '_')}` }))] } }); break;
                case 'Sub-Admin Panel': if (user.role === 'sub-admin') await bot.sendMessage(chatId, 'Sub-Admin Panel', { reply_markup: { inline_keyboard: [['Users'].map(a => ({ text: a, callback_data: `subadmin_${a.toLowerCase()}` }))] } }); break;
                case '/daily': {
                    const now = Date.now();
                    if (!user.dailyClaimed || now - user.dailyClaimed > 24 * 60 * 60 * 1000) {
                        user.coins += 25; user.dailyClaimed = now; await bot.sendMessage(chatId, 'Claimed 25 coins!');
                    } else {
                        const timeLeft = 24 * 60 * 60 * 1000 - (now - user.dailyClaimed);
                        await bot.sendMessage(chatId, `Wait ${Math.floor(timeLeft / 36e5)}h ${Math.floor((timeLeft % 36e5) / 6e4)}m.`);
                    }
                    saveUser(user);
                    break;
                }
                case 'boost': if (user.coins >= 50) { user.coins -= 50; user.boosts = { active: true, expires: Date.now() + 24 * 60 * 60 * 1000 }; await bot.sendMessage(chatId, 'Profile boosted for 24h!'); } else await bot.sendMessage(chatId, 'Need 50 coins.'); saveUser(user); break;
                case 'viewers': if (user.coins >= 15) { user.coins -= 15; await bot.sendMessage(chatId, user.viewers.length ? `Viewed by: ${user.viewers.map(v => v.chatId).join(', ')}` : 'No viewers.'); } else await bot.sendMessage(chatId, 'Need 15 coins.'); saveUser(user); break;
            }
        }
    } catch (err) { console.error('Message error:', err); }
});

// Callback Query Handler
bot.on('callback_query', async (query) => {
    try {
        const chatId = query.message.chat.id;
        const user = getUser(chatId);
        if (!user || user.banned) return;

        if (query.data === 'edit_profile') {
            await bot.sendMessage(chatId, 'Edit what?', { reply_markup: { inline_keyboard: [['name', 'age', 'gender', 'city', 'interests', 'limits', 'extraInfo', 'photos'].map(f => ({ text: `Edit ${f}`, callback_data: `edit_${f}` })), [{ text: 'Done', callback_data: 'done_editing' }]] } });
        } else if (query.data.startsWith('edit_')) {
            const field = query.data.substring(5);
            user.state = { type: 'editing_profile', field };
            await bot.sendMessage(chatId, field === 'photos' ? 'Send new photos, /done when finished.' : `New ${field}?`);
            saveUser(user);
        } else if (query.data === 'done_editing') {
            user.state = { type: 'idle' };
            await bot.sendMessage(chatId, 'Editing done.', { reply_markup: { keyboard: getMainKeyboard(user), resize_keyboard: true } });
            saveUser(user);
        } else if (query.data.startsWith('like_')) {
            if (user.coins < 10) { await bot.sendMessage(chatId, 'Need 10 coins to like.'); return; }
            const targetChatId = query.data.substring(5);
            const targetUser = getUser(targetChatId);
            user.coins -= 10; user.likes.push(targetChatId);
            if (targetUser.likes.includes(chatId)) {
                user.matches.push(targetChatId); targetUser.matches.push(chatId);
                saveUser(targetUser);
                await bot.sendMessage(chatId, `Match with ${targetUser.profile.name}! Chat: https://t.me/${(await bot.getMe()).username}?start=${targetChatId}`);
                await bot.sendMessage(targetChatId, `Match with ${user.profile.name}! Chat: https://t.me/${(await bot.getMe()).username}?start=${chatId}`);
            }
            saveUser(user);
            await bot.answerCallbackQuery(query.id, { text: 'Liked!' });
        } else if (query.data === 'next') {
            user.state.index++;
            if (user.state.index < user.searchResults.length) await showProfile(getUser(user.searchResults[user.state.index]), chatId, { withSearchActions: true, viewedBy: chatId });
            else { await bot.sendMessage(chatId, 'No more profiles.', { reply_markup: { keyboard: getMainKeyboard(user), resize_keyboard: true } }); user.state = { type: 'idle' }; }
            saveUser(user);
        } else if (query.data.startsWith('report_')) {
            user.state = { type: 'reporting', reported: query.data.substring(7) };
            await bot.sendMessage(chatId, 'Reason for report?');
            saveUser(user);
        } else if (query.data.startsWith('admin_')) {
            const action = query.data.substring(6);
            if (action === 'stats') {
                const stats = `Users: ${Object.keys(db.users).length}, Matches: ${Object.values(db.users).reduce((sum, u) => sum + u.matches.length, 0) / 2}, Reports: ${db.reports.length}`;
                await bot.sendMessage(chatId, stats);
            } else if (action === 'users') {
                const users = Object.values(db.users).map(u => ({ text: `${u.profile.name} (${u.chatId})`, callback_data: `view_${u.chatId}` }));
                await bot.sendMessage(chatId, 'Users:', { reply_markup: { inline_keyboard: users.map(u => [u]) } });
            } else if (action === 'grant_coins') {
                user.state = { type: 'admin_action', action: 'grant_coins' };
                await bot.sendMessage(chatId, 'Enter "chatId amount"');
            } else if (action === 'broadcast') {
                user.state = { type: 'admin_action', action: 'broadcast' };
                await bot.sendMessage(chatId, 'Message to broadcast?');
            } else if (action === 'reports') {
                const reports = db.reports.filter(r => r.status === 'open').map((r, i) => ({ text: `${r.reporter} vs ${r.reported}`, callback_data: `resolve_${i}` }));
                await bot.sendMessage(chatId, 'Open reports:', { reply_markup: { inline_keyboard: reports.map(r => [r]) } });
            } else if (action === 'sub_admins') {
                await bot.sendMessage(chatId, 'Enter chatId to toggle sub-admin status.');
                user.state = { type: 'admin_action', action: 'sub_admin' };
            }
            saveUser(user);
        } else if (query.data.startsWith('view_')) {
            const targetChatId = query.data.substring(5);
            const targetUser = getUser(targetChatId);
            await showProfile(targetUser, chatId);
            await bot.sendMessage(chatId, `Coins: ${targetUser.coins}, Banned: ${targetUser.banned}`, { reply_markup: { inline_keyboard: [[{ text: targetUser.banned ? 'Unban' : 'Ban', callback_data: `ban_${targetChatId}` }]] } });
        } else if (query.data.startsWith('ban_')) {
            const targetChatId = query.data.substring(4);
            const targetUser = getUser(targetChatId);
            targetUser.banned = !targetUser.banned;
            saveUser(targetUser);
            await bot.sendMessage(chatId, `${targetChatId} ${targetUser.banned ? 'banned' : 'unbanned'}.`);
        } else if (query.data.startsWith('resolve_')) {
            const index = parseInt(query.data.substring(8));
            db.reports[index].status = 'resolved';
            saveDb();
            await bot.sendMessage(chatId, 'Report resolved.');
        } else if (query.data.startsWith('subadmin_')) {
            const users = Object.values(db.users).map(u => ({ text: `${u.profile.name} (${u.chatId})`, callback_data: `view_${u.chatId}` }));
            await bot.sendMessage(chatId, 'Users:', { reply_markup: { inline_keyboard: users.map(u => [u]) } });
        }
    } catch (err) { console.error('Callback error:', err); }
});

console.log('Bot started');
