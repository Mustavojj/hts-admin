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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345';
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID) || 1891231976;
const BOT_TOKEN = process.env.BOT_TOKEN;
const COIN_TO_GRAM_RATE = 1000000;

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

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

app.post('/api/admin/stats', async (req, res) => {
    try {
        const { count: totalUsers } = await supabase.from('users').select('id', { count: 'exact', head: true });
        const { count: totalWithdrawals } = await supabase.from('withdrawals').select('id', { count: 'exact', head: true });
        const { count: totalTasks } = await supabase.from('tasks').select('id', { count: 'exact', head: true });
        const { count: totalCodes } = await supabase.from('promo_codes').select('code', { count: 'exact', head: true });

        res.json({
            success: true,
            data: {
                totalUsers: totalUsers || 0,
                totalWithdrawals: totalWithdrawals || 0,
                totalTasks: totalTasks || 0,
                totalCodes: totalCodes || 0
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

        let users = [];

        if (/^\d+$/.test(trimmed)) {
            const { data, error } = await supabase
                .from('users')
                .select('id, first_name, username, photo_url, coin_balance, power_balance, gram_balance, level, total_referrals, total_tasks_completed, referral_power_earnings, referral_coin_earnings, miner_id, owned_miners, bot_blocked, state, total_mining_starts')
                .eq('id', parseInt(trimmed))
                .limit(20);
            if (error) throw error;
            users = data || [];
        } else {
            const searchTerm = trimmed.replace('@', '');
            const { data, error } = await supabase
                .from('users')
                .select('id, first_name, username, photo_url, coin_balance, power_balance, gram_balance, level, total_referrals, total_tasks_completed, referral_power_earnings, referral_coin_earnings, miner_id, owned_miners, bot_blocked, state, total_mining_starts')
                .or(`first_name.ilike.%${searchTerm}%,username.ilike.%${searchTerm}%`)
                .limit(20);
            if (error) throw error;
            users = data || [];
        }

        users = users.map(u => ({
            ...u,
            coin_balance: parseFloat((u.coin_balance || 0).toFixed(5)),
            power_balance: u.power_balance || 0,
            gram_balance: parseFloat((u.gram_balance || 0).toFixed(5)),
            level: u.level || 1,
            total_tasks_completed: u.total_tasks_completed || 0,
            total_mining_starts: u.total_mining_starts || 0,
            referral_power_earnings: u.referral_power_earnings || 0,
            referral_coin_earnings: u.referral_coin_earnings || 0,
            owned_miners: u.owned_miners || [],
            miner_id: u.miner_id || null,
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
            ad1_daily_count: 0,
            ad2_daily_count: 0,
            ad3_daily_count: 0,
            ad4_daily_count: 0,
            daily_tasks_completed: 0,
            daily_referrals: 0,
            daily_mining_starts: 0,
            ad_daily_date: '',
            last_task_date: '',
            last_referral_date: '',
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
        if (!validateNumber(amount, 0.000001)) return res.status(400).json({ success: false, error: 'Invalid amount' });
        if (!['coin_balance', 'power_balance'].includes(type)) return res.status(400).json({ success: false, error: 'Invalid balance type' });

        const { data: userData, error: fetchError } = await supabase.from('users').select(type).eq('id', userId).single();
        if (fetchError || !userData) return res.status(404).json({ success: false, error: 'User not found' });

        const currentBalance = userData[type] || 0;
        const newBalance = type === 'coin_balance'
            ? parseFloat((currentBalance + amount).toFixed(5))
            : currentBalance + amount;

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
        if (!validateNumber(amount, 0.000001)) return res.status(400).json({ success: false, error: 'Invalid amount' });
        if (!['coin_balance', 'power_balance'].includes(type)) return res.status(400).json({ success: false, error: 'Invalid balance type' });

        const { data: userData, error: fetchError } = await supabase.from('users').select(type).eq('id', userId).single();
        if (fetchError || !userData) return res.status(404).json({ success: false, error: 'User not found' });

        const currentBalance = userData[type] || 0;
        if (currentBalance < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        const newBalance = type === 'coin_balance'
            ? parseFloat((currentBalance - amount).toFixed(5))
            : currentBalance - amount;

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
        const { name, url, category, reward, maxCompletions, owner, verification } = req.body;

        if (!name || !url) {
            logError('/api/admin/tasks/create', new Error('Missing name or url'), { body: req.body });
            return res.status(400).json({ success: false, error: 'Missing required fields (name, url)' });
        }
        if (!validateNumber(reward, 1)) {
            logError('/api/admin/tasks/create', new Error('Invalid reward'), { reward });
            return res.status(400).json({ success: false, error: 'Invalid reward amount' });
        }
        if (!['main', 'community'].includes(category)) {
            return res.status(400).json({ success: false, error: 'Category must be main or community' });
        }

        const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        const taskData = {
            id: taskId,
            name,
            url,
            category: category,
            reward: parseInt(reward) || 10,
            total: maxCompletions || 100,
            total_completed: 0,
            status: 'active',
            owner: owner || 0,
            created_at: Date.now(),
            verification: verification !== undefined ? verification : true,
            notified: false
        };

        const { data, error } = await supabase.from('tasks').insert([taskData]).select();
        if (error) {
            logError('/api/admin/tasks/create', error, { taskData });
            throw error;
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
            await notifyUser(taskData.owner,
                `<b>✅ Task Approved</b>\n\n<b>Task:</b> ${taskData.name}\n<b>Status:</b> Active`
            );
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
                w.amount = Math.abs(parseFloat((w.amount || 0).toFixed(5)));
                w.gram_amount = parseFloat((w.gram_amount || (w.amount / COIN_TO_GRAM_RATE)).toFixed(8));
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

        const absAmount = Math.abs(txData.amount || 0);

        const { error } = await supabase.from('withdrawals').update({ status }).eq('id', transactionId);
        if (error) throw error;

        if (status === 'completed') {
            await notifyUser(txData.user_id,
                `<b>✅ Withdrawal Completed!</b>\n\n<b>💰 Amount:</b> ${(txData.gram_amount || absAmount / COIN_TO_GRAM_RATE).toFixed(8)} GRAM`
            );
        } else if (status === 'rejected' || status === 'failed') {
            const { data: userData } = await supabase.from('users').select('coin_balance').eq('id', txData.user_id).single();
            if (userData) {
                await supabase.from('users').update({ coin_balance: (userData.coin_balance || 0) + absAmount }).eq('id', txData.user_id);
                await notifyUser(txData.user_id,
                    `<b>❌ Withdrawal ${status.toUpperCase()}</b>\n\n<b>💰 Refunded:</b> ${absAmount.toFixed(2)} COIN`
                );
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
        const { code, reward, rewardType, maxUses, requiredChannel } = req.body;

        if (!code || !reward) {
            logError('/api/admin/promo/create', new Error('Missing code or reward'), { body: req.body });
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        if (!validateNumber(reward, 1)) return res.status(400).json({ success: false, error: 'Invalid reward amount' });
        if (!['coin', 'power'].includes(rewardType)) return res.status(400).json({ success: false, error: 'Invalid reward type (coin or power)' });

        const promoData = {
            code: code.toUpperCase(),
            reward_amount: parseInt(reward),
            reward_type: rewardType,
            max_uses: maxUses || 999999,
            total_uses: 0,
            owner: 0,
            status: 'active',
            required_channel: requiredChannel || null,
            created_at: Date.now()
        };

        const { data, error } = await supabase.from('promo_codes').insert([promoData]).select();
        if (error) {
            logError('/api/admin/promo/create', error, { promoData });
            throw error;
        }

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

        if (users.length === 0) return res.json({ success: true, sent: 0, failed: 0, total: 0 });

        let sent = 0;
        let failed = 0;
        let blocked = 0;
        const batchSize = 30;

        let replyMarkup = null;
        if (buttons && buttons.length > 0) {
            replyMarkup = { inline_keyboard: [buttons.map(btn => ({ text: btn.text, url: btn.url || undefined }))] };
        }

        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);
            await Promise.all(batch.map(async (uid) => {
                try {
                    let response;
                    if (photoUrl) {
                        response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                chat_id: uid, photo: photoUrl, caption: message,
                                parse_mode: 'HTML', reply_markup: replyMarkup
                            })
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
                    if (data.ok) sent++;
                    else {
                        failed++;
                        if (data.description && data.description.includes('blocked')) {
                            blocked++;
                            await supabase.from('users').update({ bot_blocked: true }).eq('id', uid);
                        }
                    }
                } catch (error) {
                    failed++;
                }
            }));
        }

        await notifyAdmin(
            `<b>📨 Notification Sent</b>\n\n<b>Target:</b> ${target}\n<b>Total:</b> ${users.length}\n<b>Sent:</b> ${sent}\n<b>Failed:</b> ${failed}\n<b>Blocked:</b> ${blocked}`
        );

        res.json({ success: true, sent, failed, blocked, total: users.length });
    } catch (error) {
        logError('/api/admin/notifications/send', error, { target: req.body?.target });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/topusers/list', async (req, res) => {
    try {
        const { type, limit } = req.body;
        const limitNum = Math.min(parseInt(limit) || 20, 100);
        const column = type === 'power' ? 'power_balance' : 'coin_balance';

        const { data, error } = await supabase
            .from('users')
            .select('id, first_name, photo_url, ' + column)
            .order(column, { ascending: false })
            .limit(limitNum);

        if (error) throw error;

        const formattedData = (data || []).map(u => ({
            user_id: u.id,
            first_name: u.first_name || 'User',
            photo_url: u.photo_url || 'https://slho.shop/i/8067',
            value: type === 'power' ? (u.power_balance || 0) : parseFloat((u.coin_balance || 0).toFixed(5))
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
