const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(cors({
    origin: [
        'https://gram-hunters-admin.up.railway.app',
        'https://t.me',
        'https://web.telegram.org'
    ]
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));
app.use('/api/', limiter);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID) || 1891231976;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TASKS_CHANNEL = process.env.TASKS_CHANNEL || '@GHT_TASKS';
const MINI_APP_URL = 'https://t.me/GramHtrsbot/app';
const APP_LOGO = 'https://slho.shop/i/8281';

const TASK_REWARDS = {
    main:      { gram: 0.002 },
    partner:   { gram: 0.001 },
    community: { gram: 0.002 }
};

function logError(endpoint, error, extra = {}) {
    console.error(`❌ [${endpoint}] FAILED:`, error?.message || error, JSON.stringify(extra));
}

function validateUserId(userId) {
    return userId && typeof userId === 'number' && userId > 0;
}

function validateNumber(value, min = 0, max = Infinity) {
    return typeof value === 'number' && value >= min && value <= max;
}

async function notifyUser(userId, message, buttons = null) {
    try {
        if (!BOT_TOKEN) return false;
        const payload = { chat_id: userId, text: message, parse_mode: 'HTML' };
        if (buttons && buttons.length > 0) {
            payload.reply_markup = { inline_keyboard: [buttons.map(btn => ({ text: btn.text, url: btn.url }))] };
        }
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        return data.ok;
    } catch (error) {
        logError('notifyUser', error, { userId });
        return false;
    }
}

async function notifyAdmin(message) {
    try {
        if (!ADMIN_CHAT_ID || !BOT_TOKEN) return false;
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        const data = await response.json();
        return data.ok;
    } catch (error) {
        logError('notifyAdmin', error);
        return false;
    }
}

async function notifyTasksChannel(task) {
    try {
        if (!BOT_TOKEN || !TASKS_CHANNEL) return false;
        const rewards = TASK_REWARDS[task.category] || { gram: 0 };
        const rewardText = rewards.gram > 0 ? `${rewards.gram.toFixed(8)} GRAM` : 'N/A';
        const categoryLabel = task.category.charAt(0).toUpperCase() + task.category.slice(1);

        const message = `⚡ <b>NEW TASK AVAILABLE</b>\n\n📋 <b>Name:</b> ${task.name}\nℹ️ <b>Category:</b> ${categoryLabel}\n💰 <b>Reward:</b> ${rewardText}\n✅ <b>Available for ${task.total} completion</b>`;

        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TASKS_CHANNEL,
                text: message,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '⚡ Complete Now', url: MINI_APP_URL }]]
                }
            })
        });
        const data = await response.json();
        if (!data.ok) logError('notifyTasksChannel', new Error(data.description), { taskId: task.id });
        return data.ok;
    } catch (error) {
        logError('notifyTasksChannel', error);
        return false;
    }
}

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (!ADMIN_PASSWORD) {
        return res.status(500).json({ success: false, error: 'ADMIN_PASSWORD not configured on server' });
    }
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

app.post('/api/admin/stats', async (req, res) => {
    try {
        const { count: totalUsers } = await supabase.from('users').select('id', { count: 'exact', head: true });

        const { data: usersBalances } = await supabase.from('users').select('mining_balance, withdrawable_balance').limit(100000);
        let totalMining = 0, totalWithdrawable = 0;
        (usersBalances || []).forEach(u => {
            totalMining += parseFloat(u.mining_balance || 0);
            totalWithdrawable += parseFloat(u.withdrawable_balance || 0);
        });

        const { data: completedWds } = await supabase.from('withdrawals').select('gram_amount').eq('status', 'completed').limit(100000);
        let totalWithdrawn = 0;
        (completedWds || []).forEach(w => { totalWithdrawn += parseFloat(w.gram_amount || 0); });

        res.json({
            success: true,
            data: {
                totalUsers: totalUsers || 0,
                totalMining: totalMining,
                totalWithdrawable: totalWithdrawable,
                totalWithdrawn: totalWithdrawn
            }
        });
    } catch (error) {
        logError('/api/admin/stats', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query || typeof query !== 'string') {
            return res.status(400).json({ success: false, error: 'Query required' });
        }
        const trimmed = query.trim();
        if (!trimmed) {
            return res.status(400).json({ success: false, error: 'Query required' });
        }

        const selectFields = 'id, first_name, username, photo_url, mining_balance, withdrawable_balance, referral_gram_earnings, pending_gram_reward, total_referrals, verified_referrals, total_tasks_completed, total_mining_starts, welcome_bonus_claimed, bot_blocked, state, created_at';
        let users = [];

        if (/^\d+$/.test(trimmed)) {
            const { data, error } = await supabase.from('users').select(selectFields).eq('id', parseInt(trimmed)).limit(20);
            if (error) throw error;
            users = data || [];
        } else {
            const searchTerm = trimmed.replace('@', '');
            const { data, error } = await supabase.from('users').select(selectFields).or(`first_name.ilike.%${searchTerm}%,username.ilike.%${searchTerm}%`).limit(20);
            if (error) throw error;
            users = data || [];
        }

        users = users.map(u => ({
            ...u,
            mining_balance: parseFloat((u.mining_balance || 0).toFixed(8)),
            withdrawable_balance: parseFloat((u.withdrawable_balance || 0).toFixed(8)),
            referral_gram_earnings: parseFloat((u.referral_gram_earnings || 0).toFixed(8)),
            pending_gram_reward: parseFloat((u.pending_gram_reward || 0).toFixed(8)),
            total_referrals: u.total_referrals || 0,
            verified_referrals: u.verified_referrals || 0,
            total_tasks_completed: u.total_tasks_completed || 0,
            total_mining_starts: u.total_mining_starts || 0,
            welcome_bonus_claimed: u.welcome_bonus_claimed || false,
            bot_blocked: u.bot_blocked || false
        }));

        res.json({ success: true, data: users });
    } catch (error) {
        logError('/api/admin/users/search', error, { query: req.body?.query });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/ban', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        const { error } = await supabase.from('users').update({ state: 'ban' }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/users/ban', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/unban', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        const { error } = await supabase.from('users').update({ state: 'active' }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/users/unban', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/delete', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });

        await supabase.from('user_completed_tasks').delete().eq('user_id', userId);
        await supabase.from('used_promo_codes').delete().eq('user_id', userId);
        await supabase.from('withdrawals').delete().eq('user_id', userId);
        await supabase.from('confirmed_memos').delete().eq('user_id', userId);
        await supabase.from('device_locks').delete().eq('user_id', userId);
        await supabase.from('ip_locks').delete().eq('user_id', userId);
        await supabase.from('tasks').delete().eq('owner', userId);
        await supabase.from('promo_codes').delete().eq('owner', userId);
        const { error } = await supabase.from('users').delete().eq('id', userId);
        if (error) throw error;

        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/users/delete', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/reset-device', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        await supabase.from('device_locks').delete().eq('user_id', userId);
        await supabase.from('ip_locks').delete().eq('user_id', userId);
        const { error } = await supabase.from('users').update({ visitor_ids: [] }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/users/reset-device', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/reset-daily', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        const { error } = await supabase.from('users').update({
            daily_mining_starts: 0,
            last_mining_date: ''
        }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/users/reset-daily', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/balance/add', async (req, res) => {
    try {
        const { userId, amount, type } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        if (!validateNumber(amount, 0.00000001)) return res.status(400).json({ success: false, error: 'Invalid amount' });
        if (!['mining_balance', 'withdrawable_balance'].includes(type)) return res.status(400).json({ success: false, error: 'Invalid balance type' });

        const { data: userData, error: fetchError } = await supabase.from('users').select(type).eq('id', userId).single();
        if (fetchError || !userData) return res.status(404).json({ success: false, error: 'User not found' });

        const currentBalance = parseFloat(userData[type] || 0);
        const newBalance = parseFloat((currentBalance + amount).toFixed(8));

        const { error } = await supabase.from('users').update({ [type]: newBalance }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('/api/admin/balance/add', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/balance/deduct', async (req, res) => {
    try {
        const { userId, amount, type } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        if (!validateNumber(amount, 0.00000001)) return res.status(400).json({ success: false, error: 'Invalid amount' });
        if (!['mining_balance', 'withdrawable_balance'].includes(type)) return res.status(400).json({ success: false, error: 'Invalid balance type' });

        const { data: userData, error: fetchError } = await supabase.from('users').select(type).eq('id', userId).single();
        if (fetchError || !userData) return res.status(404).json({ success: false, error: 'User not found' });

        const currentBalance = parseFloat(userData[type] || 0);
        if (currentBalance < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        const newBalance = parseFloat((currentBalance - amount).toFixed(8));

        const { error } = await supabase.from('users').update({ [type]: newBalance }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('/api/admin/balance/deduct', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/create', async (req, res) => {
    try {
        const { name, url, category, maxCompletions, owner, verification, sendNotify } = req.body;

        if (!name || !url) {
            return res.status(400).json({ success: false, error: 'Missing required fields (name, url)' });
        }
        if (!['main', 'partner', 'community'].includes(category)) {
            return res.status(400).json({ success: false, error: 'Category must be main, partner or community' });
        }

        const rewardConf = TASK_REWARDS[category] || { gram: 0 };
        const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        const taskData = {
            id: taskId,
            name,
            url,
            category: category,
            reward: rewardConf.gram,
            total: maxCompletions || 100,
            total_completed: 0,
            status: 'active',
            owner: owner || 0,
            created_at: Date.now(),
            verification: verification === true,
            notified: false
        };

        const { data, error } = await supabase.from('tasks').insert([taskData]).select();
        if (error) throw error;

        if (sendNotify === true) {
            try {
                await notifyTasksChannel(taskData);
            } catch (e) {
                logError('/api/admin/tasks/create notify', e, { taskId });
            }
        }

        res.json({ success: true, data: data[0] });
    } catch (error) {
        logError('/api/admin/tasks/create', error, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/list', async (req, res) => {
    try {
        const { taskId, status, owner, category, creator } = req.body;
        let query = supabase.from('tasks').select('*');
        if (taskId) query = query.eq('id', taskId);
        if (status) query = query.eq('status', status);
        if (owner && validateUserId(owner)) query = query.eq('owner', owner);
        if (category) query = query.eq('category', category);
        if (creator === 'admin') query = query.or('owner.eq.0,owner.is.null');
        if (creator === 'user') query = query.not('owner', 'is', null).neq('owner', 0);

        const { data, error } = await query.order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        logError('/api/admin/tasks/list', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/update-status', async (req, res) => {
    try {
        const { taskId, status } = req.body;
        if (!taskId) return res.status(400).json({ success: false, error: 'Task ID required' });
        if (!['pending', 'active', 'rejected', 'completed'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });

        const { data: taskData, error: fetchError } = await supabase.from('tasks').select('name, owner').eq('id', taskId).single();
        if (fetchError) throw fetchError;

        const { error } = await supabase.from('tasks').update({ status }).eq('id', taskId);
        if (error) throw error;

        if (status === 'active' && taskData.owner && validateUserId(taskData.owner)) {
            await notifyUser(taskData.owner, `<b>✅ Task Approved</b>\n\n<b>Task:</b> ${taskData.name}\n<b>Status:</b> Active`);
        }

        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/tasks/update-status', error, { taskId: req.body?.taskId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/delete', async (req, res) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ success: false, error: 'Task ID required' });
        await supabase.from('tasks').delete().eq('id', taskId);
        await supabase.from('user_completed_tasks').delete().eq('task_id', taskId);
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/tasks/delete', error, { taskId: req.body?.taskId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/list', async (req, res) => {
    try {
        const { status, userId } = req.body;
        let query = supabase.from('withdrawals').select('*').order('timestamp', { ascending: false }).limit(100);
        if (status) query = query.eq('status', status);
        if (userId && validateUserId(userId)) query = query.eq('user_id', userId);

        const { data, error } = await query;
        if (error) throw error;

        if (data) {
            data.forEach(w => {
                w.amount = Math.abs(parseFloat((w.amount || 0).toFixed(8)));
                w.gram_amount = parseFloat((w.gram_amount || 0).toFixed(8));
                w.wallet_masked = w.wallet ? w.wallet.substring(0, 6) + '***' + w.wallet.substring(w.wallet.length - 6) : 'N/A';
            });
        }

        res.json({ success: true, data });
    } catch (error) {
        logError('/api/admin/withdrawals/list', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/update-status', async (req, res) => {
    try {
        const { transactionId, status } = req.body;
        if (!transactionId) return res.status(400).json({ success: false, error: 'Transaction ID required' });
        if (!['pending', 'completed', 'rejected', 'failed', 'processing'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });

        const { data: txData, error: fetchError } = await supabase.from('withdrawals').select('user_id, amount, gram_amount').eq('id', transactionId).single();
        if (fetchError) throw fetchError;

        const { error } = await supabase.from('withdrawals').update({ status }).eq('id', transactionId);
        if (error) throw error;

        if (status === 'completed') {
            await notifyUser(txData.user_id, `<b>✅ Withdrawal Completed!</b>\n\n<b>💰 Amount:</b> ${parseFloat(txData.gram_amount || 0).toFixed(8)} GRAM`);
        } else if (status === 'rejected' || status === 'failed') {
            const { data: userData } = await supabase.from('users').select('withdrawable_balance').eq('id', txData.user_id).single();
            if (userData) {
                const refund = parseFloat(txData.gram_amount || txData.amount || 0);
                await supabase.from('users').update({ withdrawable_balance: (parseFloat(userData.withdrawable_balance || 0) + refund) }).eq('id', txData.user_id);
                await notifyUser(txData.user_id, `<b>❌ Withdrawal ${status.toUpperCase()}</b>\n\n<b>💰 Refunded:</b> ${refund.toFixed(8)} GRAM`);
            }
        }

        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/withdrawals/update-status', error, { transactionId: req.body?.transactionId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/delete', async (req, res) => {
    try {
        const { transactionId } = req.body;
        if (!transactionId) return res.status(400).json({ success: false, error: 'Transaction ID required' });
        const { error } = await supabase.from('withdrawals').delete().eq('id', transactionId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/withdrawals/delete', error, { transactionId: req.body?.transactionId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/create', async (req, res) => {
    try {
        const { code, reward, maxUses, requiredChannel } = req.body;
        if (!code || !reward) return res.status(400).json({ success: false, error: 'Missing required fields' });
        if (!validateNumber(reward, 0.00000001)) return res.status(400).json({ success: false, error: 'Invalid reward amount' });

        const promoData = {
            code: code.toUpperCase(),
            reward_amount: parseFloat(reward),
            reward_type: 'gram',
            max_uses: maxUses || 999999,
            total_uses: 0,
            owner: 0,
            status: 'active',
            required_channel: requiredChannel || null,
            created_at: Date.now()
        };

        const { data, error } = await supabase.from('promo_codes').insert([promoData]).select();
        if (error) throw error;
        res.json({ success: true, data: data[0] });
    } catch (error) {
        logError('/api/admin/promo/create', error, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/list', async (req, res) => {
    try {
        const { code, owner, status, creator } = req.body;
        let query = supabase.from('promo_codes').select('*').order('created_at', { ascending: false }).limit(200);
        if (code) query = query.ilike('code', `%${code}%`);
        if (owner && validateUserId(owner)) query = query.eq('owner', owner);
        if (status === 'active') query = query.eq('status', 'active');
        if (status === 'completed') query = query.eq('status', 'completed');
        if (creator === 'admin') query = query.or('owner.eq.0,owner.is.null');
        if (creator === 'user') query = query.neq('owner', 0).not('owner', 'is', null);

        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        logError('/api/admin/promo/list', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/delete', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ success: false, error: 'Code required' });
        await supabase.from('promo_codes').delete().eq('code', code);
        await supabase.from('used_promo_codes').delete().eq('code', code);
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/promo/delete', error, { code: req.body?.code });
        res.status(500).json({ success: false, error: error.message });
    }
});

async function sendOneNotification(uid, message, photoUrl, replyMarkup) {
    try {
        let response;
        if (photoUrl) {
            response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: uid, photo: photoUrl, caption: message, parse_mode: 'HTML', reply_markup: replyMarkup })
            });
        } else {
            const body = { chat_id: uid, text: message, parse_mode: 'HTML' };
            if (replyMarkup) body.reply_markup = replyMarkup;
            response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        }
        const data = await response.json();
        if (data.ok) return { ok: true };
        const desc = data.description || '';
        if (desc.includes('blocked')) return { ok: false, blocked: true };
        return { ok: false };
    } catch (e) {
        return { ok: false };
    }
}

app.post('/api/admin/notifications/send', async (req, res) => {
    try {
        const { userId, message, buttons, target, photoUrl } = req.body;
        if (!BOT_TOKEN) return res.status(400).json({ success: false, error: 'Bot not configured' });
        if (!message) return res.status(400).json({ success: false, error: 'Message required' });

        let users = [];
        if (target === 'all') {
            let allUsers = [];
            let page = 0;
            const pageSize = 1000;
            let hasMore = true;
            while (hasMore) {
                const { data, error } = await supabase.from('users').select('id').eq('bot_blocked', false).range(page * pageSize, (page + 1) * pageSize - 1);
                if (error) throw error;
                if (data && data.length > 0) { allUsers = allUsers.concat(data); page++; }
                if (!data || data.length < pageSize) hasMore = false;
            }
            users = allUsers.map(u => u.id);
        } else if (target === 'single' && validateUserId(userId)) {
            users = [userId];
        } else {
            return res.status(400).json({ success: false, error: 'Invalid target' });
        }

        if (users.length === 0) return res.json({ success: true, sent: 0, failed: 0, blocked: 0, total: 0 });

        let replyMarkup = null;
        if (buttons && buttons.length > 0) {
            replyMarkup = { inline_keyboard: buttons.map(btn => [{ text: btn.text, url: btn.url || undefined }]) };
        }

        let sent = 0, failed = 0, blocked = 0;
        const batchSize = 50;

        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(uid => sendOneNotification(uid, message, photoUrl, replyMarkup)));
            results.forEach((r, idx) => {
                if (r.ok) sent++;
                else {
                    failed++;
                    if (r.blocked) {
                        blocked++;
                        supabase.from('users').update({ bot_blocked: true }).eq('id', batch[idx]).then(() => {}).catch(() => {});
                    }
                }
            });
            if (i + batchSize < users.length) await new Promise(r => setTimeout(r, 500));
        }

        await notifyAdmin(`<b>📨 Broadcast Sent</b>\n\n<b>Target:</b> ${target}\n<b>Total:</b> ${users.length}\n<b>Sent:</b> ${sent}\n<b>Failed:</b> ${failed}\n<b>Blocked:</b> ${blocked}`);

        res.json({ success: true, sent, failed, blocked, total: users.length });
    } catch (error) {
        logError('/api/admin/notifications/send', error, { target: req.body?.target });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/topusers/list', async (req, res) => {
    try {
        const { type, limit } = req.body;
        const limitNum = Math.min(parseInt(limit) || 10, 100);
        let column;
        if (type === 'withdrawable') column = 'withdrawable_balance';
        else if (type === 'referrals') column = 'total_referrals';
        else column = 'mining_balance';

        const selectFields = 'id, first_name, photo_url, ' + column;
        const { data, error } = await supabase.from('users').select(selectFields).order(column, { ascending: false }).limit(limitNum);
        if (error) throw error;

        const formattedData = (data || []).map(u => ({
            user_id: u.id,
            first_name: u.first_name || 'User',
            photo_url: u.photo_url || APP_LOGO,
            value: parseFloat((u[column] || 0).toFixed(8))
        }));

        res.json({ success: true, data: formattedData });
    } catch (error) {
        logError('/api/admin/topusers/list', error, { type: req.body?.type });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'admin.html'));
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🎯 GRAM HUNTERS Admin Panel running on port ${PORT}`);
});
