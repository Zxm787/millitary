const discord = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// استيراد نظام إدارة قاعدة البيانات
const {
    initializeDatabaseManager,
    checkDatabaseSize,
    performEmergencyCleanup,
    performPreventiveCleanup,
    getDatabaseStats,
    cleanupSystemMemory,
    DB_MANAGEMENT_CONFIG
} = require('./database-manager');
const raidCategory = ['1390651674082939003']
const PublicCategory = ['1350420067312996362']
const warCategory = ['1390653119913922620']

try {
  // محاولة تفعيل GC يدوياً
  if (typeof global.gc !== 'function') {
    const vm = require('vm');
    const script = new vm.Script('gc');
    const context = vm.createContext({ gc: require('v8').getHeapStatistics });
    global.gc = script.runInContext(context);
  }

  console.log('GC enabled:', typeof global.gc === 'function');
} catch (e) {
  console.error('Failed to enable GC:', e.message);
}

// الآن يمكنك استخدام global.gc() بشكل آمن


// نظام متقدم لإدارة rate limiting
const RATE_LIMIT_CONFIG = {
    GLOBAL: {
        maxRequests: 70,
        timeWindow: 1000,
        burstAllowance: 10,
        adaptiveThreshold: 0.7
    },
    CHANNEL: {
        maxRequests: 20,
        timeWindow: 5000,
        burstAllowance: 2
    },
    USER: {
        maxRequests: 20,
        timeWindow: 10000,
        burstAllowance: 3
    },
    GUILD: {
        maxRequests: 100,
        timeWindow: 5000,
        burstAllowance: 5
    }
};

// خرائط تتبع الطلبات
const requestTrackers = {
    global: { count: 0, resetTime: Date.now() + 1000, queue: [] },
    channels: new Map(),
    users: new Map(),
    guilds: new Map(),
    pending: new Set()
};

// إحصائيات النظام
const systemStats = {
    totalRequests: 0,
    rateLimitHits: 0,
    queuedRequests: 0,
    averageResponseTime: 0,
    adaptiveMode: false,
    lastReset: Date.now()
};

// نظام الطابور الذكي للطلبات
class SmartRequestQueue {
    constructor() {
        this.queues = {
            high: [], // طلبات عالية الأولوية
            normal: [], // طلبات عادية
            low: [] // طلبات منخفضة الأولوية
        };
        this.processing = false;
        this.retryQueue = [];
        this.maxQueueSize = 1000;
    }

    addRequest(request, priority = 'normal') {
        if (this.getTotalQueueSize() >= this.maxQueueSize) {
            console.warn('Queue is full, dropping low priority requests');
            this.queues.low = this.queues.low.slice(0, Math.floor(this.maxQueueSize * 0.1));
        }

        this.queues[priority].push(request);
        systemStats.queuedRequests++;

        if (!this.processing) {
            this.processQueue();
        }
    }

    getTotalQueueSize() {
        return this.queues.high.length + this.queues.normal.length + this.queues.low.length;
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;

        while (this.getTotalQueueSize() > 0) {
            let request = null;

            // معالجة حسب الأولوية
            if (this.queues.high.length > 0) {
                request = this.queues.high.shift();
            } else if (this.queues.normal.length > 0) {
                request = this.queues.normal.shift();
            } else if (this.queues.low.length > 0) {
                request = this.queues.low.shift();
            }

            if (request) {
                try {
                    await this.executeRequest(request);
                    systemStats.queuedRequests--;
                } catch (error) {
                    console.error('Error executing queued request:', error);
                    if (request.retries < 3) {
                        request.retries = (request.retries || 0) + 1;
                        this.retryQueue.push(request);
                    }
                }
            }

            // تأخير تكيفي بناءً على حالة النظام
            const delay = this.calculateAdaptiveDelay();
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // معالجة طلبات الإعادة
        if (this.retryQueue.length > 0) {
            const retryRequest = this.retryQueue.shift();
            this.queues.normal.push(retryRequest);
        }

        this.processing = false;
    }

    calculateAdaptiveDelay() {
        const queueSize = this.getTotalQueueSize();
        const rateLimitRatio = systemStats.rateLimitHits / Math.max(systemStats.totalRequests, 1);

        let baseDelay = 100; // مللي ثانية أساسية

        // زيادة التأخير بناءً على حجم الطابور
        if (queueSize > 50) baseDelay += 200;
        else if (queueSize > 20) baseDelay += 100;
        else if (queueSize > 10) baseDelay += 50;

        // زيادة التأخير بناءً على معدل rate limiting
        if (rateLimitRatio > 0.1) baseDelay += 300;
        else if (rateLimitRatio > 0.05) baseDelay += 150;

        // تقليل التأخير في ساعات الذروة المنخفضة
        const hour = new Date().getHours();
        if (hour >= 2 && hour <= 6) baseDelay *= 0.7; // ساعات هادئة

        return Math.min(baseDelay, 1000); // حد أقصى ثانية واحدة
    }

    async executeRequest(request) {
        const startTime = Date.now();

        try {
            await request.execute();

            const responseTime = Date.now() - startTime;
            systemStats.averageResponseTime = (systemStats.averageResponseTime + responseTime) / 2;

        } catch (error) {
            if (error.code === 429) { // Rate limited
                systemStats.rateLimitHits++;
                const retryAfter = error.retryAfter || 1000;
                await new Promise(resolve => setTimeout(resolve, retryAfter));
                throw error; // لإعادة المحاولة
            }
            throw error;
        }
    }
}

const requestQueue = new SmartRequestQueue();

// دالة فحص rate limiting متقدمة
function checkRateLimit(type, identifier, config = RATE_LIMIT_CONFIG.GLOBAL) {
    const now = Date.now();
    let tracker;

    switch (type) {
        case 'global':
            tracker = requestTrackers.global;
            break;
        case 'channel':
            if (!requestTrackers.channels.has(identifier)) {
                requestTrackers.channels.set(identifier, { count: 0, resetTime: now + config.timeWindow, queue: [] });
            }
            tracker = requestTrackers.channels.get(identifier);
            break;
        case 'user':
            if (!requestTrackers.users.has(identifier)) {
                requestTrackers.users.set(identifier, { count: 0, resetTime: now + config.timeWindow, queue: [] });
            }
            tracker = requestTrackers.users.get(identifier);
            break;
        case 'guild':
            if (!requestTrackers.guilds.has(identifier)) {
                requestTrackers.guilds.set(identifier, { count: 0, resetTime: now + config.timeWindow, queue: [] });
            }
            tracker = requestTrackers.guilds.get(identifier);
            break;
        default:
            tracker = requestTrackers.global;
    }

    // إعادة تعيين العداد إذا انتهت النافزة الزمنية
    if (now >= tracker.resetTime) {
        tracker.count = 0;
        tracker.resetTime = now + config.timeWindow;
        tracker.queue = [];
    }

    // حساب العتبة التكيفية
    const adaptiveThreshold = systemStats.adaptiveMode ? 
        Math.floor(config.maxRequests * RATE_LIMIT_CONFIG.GLOBAL.adaptiveThreshold) : 
        config.maxRequests;

    // السماح بـ burst requests ضمن حدود
    const burstAllowed = tracker.count < config.burstAllowance;
    const normalAllowed = tracker.count < adaptiveThreshold;

    if (burstAllowed || normalAllowed) {
        tracker.count++;
        systemStats.totalRequests++;
        return { allowed: true, waitTime: 0 };
    } else {
        const waitTime = tracker.resetTime - now;
        return { allowed: false, waitTime: Math.max(waitTime, 100) };
    }
}

// دالة تنفيذ آمنة للطلبات
async function safeExecute(requestFunction, context = {}) {
    const { type = 'global', identifier = 'default', priority = 'normal', retries = 3 } = context;

    return new Promise((resolve, reject) => {
        const request = {
            execute: async () => {
                const config = RATE_LIMIT_CONFIG[type.toUpperCase()] || RATE_LIMIT_CONFIG.GLOBAL;
                const rateLimitCheck = checkRateLimit(type, identifier, config);

                if (!rateLimitCheck.allowed) {
                    if (rateLimitCheck.waitTime > 5000) { // إذا كان الانتظار طويل، أضف للطابور
                        throw new Error('Rate limit exceeded, queuing request');
                    } else {
                        await new Promise(resolve => setTimeout(resolve, rateLimitCheck.waitTime));
                    }
                }

                const result = await requestFunction();
                resolve(result);
            },
            retries: 0,
            priority,
            context
        };

        requestQueue.addRequest(request, priority);
    });
}

// تفعيل النمط التكيفي تلقائياً عند الحاجة
setInterval(() => {
    const rateLimitRatio = systemStats.rateLimitHits / Math.max(systemStats.totalRequests, 1);
    const queueSize = requestQueue.getTotalQueueSize();

    // تفعيل النمط التكيفي إذا تجاوز معدل rate limiting 5% أو كان الطابور كبير
    systemStats.adaptiveMode = rateLimitRatio > 0.05 || queueSize > 30;

    // إعادة تعيين الإحصائيات كل ساعة
    if (Date.now() - systemStats.lastReset > 3600000) {
        systemStats.totalRequests = Math.floor(systemStats.totalRequests * 0.8);
        systemStats.rateLimitHits = Math.floor(systemStats.rateLimitHits * 0.8);
        systemStats.lastReset = Date.now();
    }
}, 10000); // فحص كل 10 ثوان

// تنظيف الخرائط من البيانات القديمة
setInterval(() => {
    const now = Date.now();

    // تنظيف channel trackers
    for (const [id, tracker] of requestTrackers.channels.entries()) {
        if (now - tracker.resetTime > 300000) { // 5 دقائق من عدم النشاط
            requestTrackers.channels.delete(id);
        }
    }

    // تنظيف user trackers
    for (const [id, tracker] of requestTrackers.users.entries()) {
        if (now - tracker.resetTime > 600000) { // 10 دقائق من عدم النشاط
            requestTrackers.users.delete(id);
        }
    }

    // تنظيف guild trackers
    for (const [id, tracker] of requestTrackers.guilds.entries()) {
        if (now - tracker.resetTime > 300000) { // 5 دقائق من عدم النشاط
            requestTrackers.guilds.delete(id);
        }
    }
}, 300000); // كل 5 دقائق

// نظام تنظيف محسن - تم نقله إلى database-manager.js
// الآن يتم التنظيف بناءً على حالة قاعدة البيانات وليس فقط الوقت

// نظام مراقبة أداء النطاق المؤقت (للحفاظ على التوافق)
setInterval(async () => {
    try {
        // فحص حجم قاعدة البيانات أولاً
        const currentSize = await checkDatabaseSize();

        if (currentSize >= DB_MANAGEMENT_CONFIG.WARNING_THRESHOLD) {
            console.log('⚠️ Database size warning triggered, performing targeted cleanup...');
            await performPreventiveCleanup();
        }

        // البحث عن جميع التذاكر التي لها قنوات (مبسط)
        const ticketsWithChannels = await Ticket.find({ 
            ticket_channel_id: { $exists: true, $ne: null } 
        }).limit(50); // حد أقصى للمعالجة لتجنب الحمل الزائد

        let cleanedCount = 0;
        let validCount = 0;

        for (const ticket of ticketsWithChannels) {
            try {
                // التحقق من وجود القناة في كل guild
                let channelExists = false;

                for (const guild of client.guilds.cache.values()) {
                    try {
                        const channel = await guild.channels.fetch(ticket.ticket_channel_id).catch(() => null);
                        if (channel) {
                            channelExists = true;
                            validCount++;
                            break;
                        }
                    } catch (error) {
                        // تجاهل الأخطاء وتابع
                        continue;
                    }
                }

                // إذا لم توجد القناة، قم بتنظيف البيانات
                if (!channelExists) {
                    await Ticket.findOneAndUpdate(
                        { _id: ticket._id },
                        { 
                            $unset: { 
                                creator_id: "", 
                                ticket_channel_id: "" 
                            } 
                        }
                    );
                    cleanedCount++;
                    console.log(`🗑️ Cleaned orphaned ticket: ${ticket.id}`);
                }
            } catch (error) {
                console.error(`Error checking ticket ${ticket.id}:`, error);
            }
        }

        // تنظيف التذاكر القديمة جداً (أكثر من 7 أيام بدون نشاط)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const oldTickets = await Ticket.find({
            created_at: { $lt: sevenDaysAgo },
            ticket_channel_id: { $exists: false }
        });

        if (oldTickets.length > 0) {
            await Ticket.deleteMany({
                _id: { $in: oldTickets.map(t => t._id) }
            });
            console.log(`🗂️ Removed ${oldTickets.length} old unused tickets`);
        }

        console.log(`✅ Ticket cleanup completed - Valid: ${validCount}, Cleaned: ${cleanedCount}, Old removed: ${oldTickets.length}`);

    } catch (error) {
        console.error('❌ Error in ticket cleanup:', error);
    }
}, 600000); // كل 10 دقائق

const client = new discord.Client({ 
    intents: 131071,
    rest: {
        timeout: 90000, // زيادة timeout
        retries: 5, // زيادة المحاولات
        globalRequestsPerSecond: 30, // تقليل الطلبات للأمان
        rejectOnRateLimit: ['guild', 'channel'], // رفض طلبات معينة عند rate limit
        hashLifetime: 3600000, // ساعة واحدة لـ hash caching
        handlerSweepInterval: 300000, // 5 دقائق لتنظيف handlers
    },
    shards: 'auto', // تفعيل sharding تلقائياً
    shardCount: 1, // بدء بـ shard واحد
    presence: {
        status: 'online',
        activities: [{
            name: 'حماية من Rate Limiting',
            type: discord.ActivityType.Watching
        }]
    }
});

// نظام تتبع الدعوات
const inviteCache = new Map();
const LEFT_MEMBERS_FILE = path.join(__dirname, 'left_members.json');

// دالة قراءة ملف الأعضاء الذين غادروا
function readLeftMembers() {
    try {
        if (!fs.existsSync(LEFT_MEMBERS_FILE)) {
            fs.writeFileSync(LEFT_MEMBERS_FILE, '[]');
            return [];
        }
        const data = fs.readFileSync(LEFT_MEMBERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading left members file:', error);
        return [];
    }
}

// دالة كتابة ملف الأعضاء الذين غادروا
function writeLeftMembers(leftMembers) {
    try {
        fs.writeFileSync(LEFT_MEMBERS_FILE, JSON.stringify(leftMembers, null, 2));
    } catch (error) {
        console.error('Error writing left members file:', error);
    }
}

// دالة تحديث cache الدعوات
async function updateInviteCache(guild) {
    try {
        const invites = await guild.invites.fetch();
        inviteCache.set(guild.id, new Map(invites.map(invite => [invite.code, invite.uses])));
    } catch (error) {
        console.error('Error updating invite cache:', error);
    }
}
const bad = [ "كس","ام","اختك","امك","مص","زب","زبي","قحبة","قحبه","كحبه", ];
// إنشاء مجموعة لتتبع توقيت آخر أمر لكل مستخدم
const userCooldowns = new Map();
const COOLDOWN_TIME = 3000; // 3 ثواني بين كل أمر
// إعدادات نظام الكريدت
const CREDIT_BOT_ID = '282859044593598464'; // ضع هنا ID بوت الكريدت
const TRANSFER_RECIPIENT_ID = '790003354667188254'; // ضع هنا ID الشخص الذي يحول له العضو
const BASE_EXCHANGE_RATE = 900000000; // المعدل الأساسي: 100,000 عملة لعبة = 1,000,000 كريدت

// إعدادات نظام التضخم
const INFLATION_CONFIG = {
    // العتبات للتضخم
    LOW_ECONOMY: 10000000,     // 10 مليون عملة
    MEDIUM_ECONOMY: 50000000,  // 50 مليون عملة  
    HIGH_ECONOMY: 100000000,   // 100 مليون عملة
    SUPER_HIGH_ECONOMY: 500000000, // 500 مليون عملة

    // معاملات التضخم للشراء (كلما زادت العملات، قل سعر الشراء)
    BUY_MULTIPLIERS: {
        VERY_LOW: 1.5,    // اقتصاد ضعيف جداً - شراء غالي
        LOW: 1.2,         // اقتصاد ضعيف - شراء غالي نسبياً
        NORMAL: 1.0,      // اقتصاد طبيعي - سعر عادي
        HIGH: 0.8,        // اقتصاد قوي - شراء رخيص
        VERY_HIGH: 0.6,   // اقتصاد قوي جداً - شراء رخيص جداً
        EXTREME: 0.4      // اقتصاد مفرط - شراء رخيص مفرط
    },

    // معاملات التضخم للصرف (كلما زادت العملات، زاد سعر الصرف)
    SELL_MULTIPLIERS: {
        VERY_LOW: 0.5,    // اقتصاد ضعيف جداً - صرف قليل
        LOW: 0.7,         // اقتصاد ضعيف - صرف قليل نسبياً
        NORMAL: 1.0,      // اقتصاد طبيعي - صرف عادي
        HIGH: 1.3,        // اقتصاد قوي - صرف عالي
        VERY_HIGH: 1.6,   // اقتصاد قوي جداً - صرف عالي جداً
        EXTREME: 2.0      // اقتصاد مفرط - صرف مفرط
    }
};

// دالة حساب إجمالي العملات في الاقتصاد
async function calculateTotalEconomy() {
    try {
        const result = await User.aggregate([
            {
                $group: {
                    _id: null,
                    totalCoins: { $sum: "$coins" },
                    totalPlayers: { $sum: 1 }
                }
            }
        ], { 
            allowDiskUse: true, // السماح بالكتابة على القرص للبيانات الكبيرة
            maxTimeMS: 30000 // حد زمني أقصى 30 ثانية
        });

        return result.length > 0 ? result[0] : { totalCoins: 0, totalPlayers: 0 };
    } catch (error) {
        console.error('Error calculating total economy:', error);
        // في حالة فشل التجميع، استخدم طريقة بديلة أبسط
        try {
            const totalUsers = await User.countDocuments();
            const sampleUsers = await User.find({}, 'coins').limit(1000);
            const avgCoins = sampleUsers.length > 0 ? 
                sampleUsers.reduce((sum, user) => sum + (user.coins || 0), 0) / sampleUsers.length : 0;
            const estimatedTotalCoins = Math.floor(avgCoins * totalUsers);
            
            console.log(`📊 Using estimated economy: ${estimatedTotalCoins} coins for ${totalUsers} players`);
            return { totalCoins: estimatedTotalCoins, totalPlayers: totalUsers };
        } catch (fallbackError) {
            console.error('Error in fallback economy calculation:', fallbackError);
            return { totalCoins: 0, totalPlayers: 0 };
        }
    }
}

// دالة تحديد حالة الاقتصاد
function getEconomyState(totalCoins) {
    if (totalCoins < INFLATION_CONFIG.LOW_ECONOMY) {
        return 'VERY_LOW';
    } else if (totalCoins < INFLATION_CONFIG.MEDIUM_ECONOMY) {
        return 'LOW';
    } else if (totalCoins < INFLATION_CONFIG.HIGH_ECONOMY) {
        return 'NORMAL';
    } else if (totalCoins < INFLATION_CONFIG.SUPER_HIGH_ECONOMY) {
        return 'HIGH';
    } else if (totalCoins < INFLATION_CONFIG.SUPER_HIGH_ECONOMY * 2) {
        return 'VERY_HIGH';
    } else {
        return 'EXTREME';
    }
}

// دالة حساب معدل الصرف الديناميكي للشراء
async function getDynamicBuyRate() {
    const economy = await calculateTotalEconomy();
    const economyState = getEconomyState(economy.totalCoins);
    const multiplier = INFLATION_CONFIG.BUY_MULTIPLIERS[economyState];

    // معدل الشراء = المعدل الأساسي × المضاعف
    return Math.floor(BASE_EXCHANGE_RATE * multiplier);
}

// دالة حساب معدل الصرف الديناميكي للصرف
async function getDynamicSellRate() {
    const economy = await calculateTotalEconomy();
    const economyState = getEconomyState(economy.totalCoins);
    const multiplier = INFLATION_CONFIG.SELL_MULTIPLIERS[economyState];

    // معدل الصرف = المعدل الأساسي × المضاعف
    return Math.floor(BASE_EXCHANGE_RATE * multiplier);
}

// دالة الحصول على معلومات الاقتصاد المفصلة
async function getEconomyInfo() {
    const economy = await calculateTotalEconomy();
    const economyState = getEconomyState(economy.totalCoins);
    const buyRate = await getDynamicBuyRate();
    const sellRate = await getDynamicSellRate();

    const stateNames = {
        'VERY_LOW': 'ضعيف جداً 📉',
        'LOW': 'ضعيف 📊',
        'NORMAL': 'طبيعي ⚖️',
        'HIGH': 'قوي 📈',
        'VERY_HIGH': 'قوي جداً 🚀',
        'EXTREME': 'مفرط 💥'
    };

    return {
        totalCoins: economy.totalCoins,
        totalPlayers: economy.totalPlayers,
        economyState,
        economyStateName: stateNames[economyState],
        buyRate,
        sellRate,
        buyMultiplier: INFLATION_CONFIG.BUY_MULTIPLIERS[economyState],
        sellMultiplier: INFLATION_CONFIG.SELL_MULTIPLIERS[economyState]
    };
}

// دالة حساب ضريبة البروبوت
function calculateProBotTax(amount) {
    return Math.floor((amount * (20 / 19)) + 1);
}

// مخزن للمعاملات المعلقة
const pendingTransactions = new Map();

// دالة للتحقق من الكولداون
function checkCooldown(userId) {
    if (userCooldowns.has(userId)) {
        const lastTime = userCooldowns.get(userId);
        const timePassed = Date.now() - lastTime;
        if (timePassed < COOLDOWN_TIME) {
            return COOLDOWN_TIME - timePassed;
        }
    }
    userCooldowns.set(userId, Date.now());
    return 0;
}

// نظام مراقبة ومعالجة rate limiting متقدم
client.on('rateLimit', (rateLimitInfo) => {
    systemStats.rateLimitHits++;

    const logData = {
        timestamp: new Date().toISOString(),
        timeout: rateLimitInfo.timeout,
        route: rateLimitInfo.route,
        global: rateLimitInfo.global,
        limit: rateLimitInfo.limit,
        remaining: rateLimitInfo.remaining,
        retryAfter: rateLimitInfo.retryAfter,
        queueSize: requestQueue.getTotalQueueSize(),
        adaptiveMode: systemStats.adaptiveMode
    };

    console.warn('🚨 Rate Limit Hit:', JSON.stringify(logData, null, 2));

    // تفعيل النمط التكيفي فوراً عند rate limit
    systemStats.adaptiveMode = true;

    // إذا كان global rate limit، أضف تأخير إضافي
    if (rateLimitInfo.global) {
        console.error('⚠️ GLOBAL Rate Limit detected! Implementing emergency measures...');

        // تأخير جميع الطلبات لفترة أطول
        setTimeout(() => {
            console.log('✅ Emergency rate limit measures lifted');
        }, rateLimitInfo.timeout + 5000);
    }

    // إحصائيات للمراقبة
    if (systemStats.rateLimitHits % 10 === 0) {
        console.log(`📊 Rate Limit Stats: ${systemStats.rateLimitHits} hits out of ${systemStats.totalRequests} requests (${((systemStats.rateLimitHits/systemStats.totalRequests)*100).toFixed(2)}%)`);
    }
});

// معالج أخطاء الشبكة والاتصال
client.on('error', (error) => {
    console.error('Discord Client Error:', error);

    // معالجة خاصة لأخطاء rate limiting
    if (error.code === 429) {
        systemStats.rateLimitHits++;
        systemStats.adaptiveMode = true;
    }
});

// معالج تحذيرات Discord
client.on('warn', (warning) => {
    console.warn('Discord Warning:', warning);

    // تتبع التحذيرات المتعلقة بـ rate limiting
    if (warning.includes('rate') || warning.includes('limit')) {
        systemStats.adaptiveMode = true;
    }
});

// مراقبة أداء النظام
setInterval(() => {
    const stats = {
        timestamp: new Date().toISOString(),
        totalRequests: systemStats.totalRequests,
        rateLimitHits: systemStats.rateLimitHits,
        queuedRequests: systemStats.queuedRequests,
        averageResponseTime: Math.round(systemStats.averageResponseTime),
        adaptiveMode: systemStats.adaptiveMode,
        queueSize: requestQueue.getTotalQueueSize(),
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptime: Math.round(process.uptime() / 60)
    };

    // طباعة إحصائيات مفصلة كل 5 دقائق
    if (stats.totalRequests > 0 && stats.totalRequests % 100 === 0) {
        console.log('📈 System Performance Stats:', JSON.stringify(stats, null, 2));
    }

    // تحذير إذا كان معدل rate limiting عالي
    const rateLimitRatio = stats.rateLimitHits / stats.totalRequests;
    if (rateLimitRatio > 0.1) {
        console.warn(`🔴 High rate limit ratio detected: ${(rateLimitRatio * 100).toFixed(2)}%`);
    }

    // تحذير إذا كان الطابور كبير
    if (stats.queueSize > 50) {
        console.warn(`🟡 Large queue size detected: ${stats.queueSize} pending requests`);
    }
}, 60000); // كل دقيقة



const uri = "mongodb+srv://test:mhmd7667@cluster0.msxhj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"; // استبدل هذا بـ رابط الاتصال الخاص بك بـ MongoDB

// إعدادات اتصال قاعدة البيانات المحسنة
mongoose.connect(uri, { 
    useNewUrlParser: true, 
    useUnifiedTopology: true,
    maxPoolSize: 10, // الحد الأقصى لاتصالات قاعدة البيانات
    serverSelectionTimeoutMS: 5000, // مهلة انتظار الاتصال
    socketTimeoutMS: 45000, // مهلة انتظار العمليات
    bufferCommands: false, // تعطيل تخزين الأوامر
});

// تهيئة نظام إدارة قاعدة البيانات عند الاتصال
mongoose.connection.once('open', async () => {
    console.log('✅ Connected to MongoDB');
    console.log('🚀 Starting Database Management System...');

    // فحص فوري لحجم قاعدة البيانات وتنظيف طارئ إذا لزم الأمر
    try {
        const initialSize = await checkDatabaseSize();
        console.log(`📊 Initial database size: ${initialSize}MB`);

        if (initialSize >= 500) {
            console.log('🚨 Database nearly full! Starting emergency cleanup...');
            await performEmergencyCleanup();

            // تنظيف إضافي إذا لزم الأمر
            const sizeAfterFirst = await checkDatabaseSize();
            if (sizeAfterFirst >= 450) {
                console.log('🔥 Performing aggressive cleanup...');
                await performAggressiveCleanup();
            }
        }
    } catch (error) {
        console.error('Error in initial cleanup:', error);
    }

    // تهيئة نظام إدارة قاعدة البيانات
    initializeDatabaseManager();
});

mongoose.connection.on('error', (error) => {
    console.error('❌ MongoDB connection error:', error);
});

mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ MongoDB disconnected');
});

const userSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    army_name: String,
    soldiers: Number,
    officers: { type: Number, default: 0 },
    colonels: { type: Number, default: 0 },
    generals: { type: Number, default: 0 },
    lowMoraleSoldiers: { type: Number, default: 0 },
    coins: Number,
    lastDefeated: Number,
    lastSalaryPaid: { type: Date, default: Date.now },
    lastMiningCollected: { type: Date, default: Date.now },
    lastOilCollected: { type: Date, default: Date.now },
    alliance_id: String,
    alliance_rank: { type: String, default: 'عضو' }
});

const itemSchema = new mongoose.Schema({
    user_id: String,
    item_name: String,
    quantity: { type: Number, default: 1 }
});

const allianceSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    name: String,
    leader_id: String,
    members: [String],
    created_at: { type: Date, default: Date.now },
    wars: [String], // معرفات التحالفات المحاربة
    role_id: String // معرف رتبة التحالف في ديسكورد
});

const allianceRequestSchema = new mongoose.Schema({
    user_id: String,
    user_name: String,
    alliance_id: String,
    created_at: { type: Date, default: Date.now }
});

const ticketSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    channel_id: String,
    support_role_id: String,
    open_message: String,
    creator_id: String,
    ticket_channel_id: String, // معرف قناة التذكرة المُنشأة
    created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const UserItem = mongoose.model('UserItem', itemSchema);
const Alliance = mongoose.model('Alliance', allianceSchema);
const AllianceRequest = mongoose.model('AllianceRequest', allianceRequestSchema);
const Ticket = mongoose.model('Ticket', ticketSchema);

// دوال مساعدة للتعامل مع النظام الجديد للعناصر
async function addUserItem(userId, itemName, quantity = 1) {
    const existingItem = await UserItem.findOne({ user_id: userId, item_name: itemName });
    if (existingItem) {
        existingItem.quantity += quantity;
        await existingItem.save();
    } else {
        const newItem = new UserItem({ user_id: userId, item_name: itemName, quantity });
        await newItem.save();
    }
}

async function removeUserItem(userId, itemName, quantity = 1) {
    const existingItem = await UserItem.findOne({ user_id: userId, item_name: itemName });
    if (existingItem) {
        if (existingItem.quantity <= quantity) {
            await UserItem.deleteOne({ _id: existingItem._id });
        } else {
            existingItem.quantity -= quantity;
            await existingItem.save();
        }
        return true;
    }
    return false;
}

async function getUserItemCount(userId, itemName) {
    const item = await UserItem.findOne({ user_id: userId, item_name: itemName });
    return item ? item.quantity : 0;
}

async function hasUserItem(userId, itemName) {
    const count = await getUserItemCount(userId, itemName);
    return count > 0;
}

// حدود العناصر
const ITEM_LIMITS = {
    'المنجم': 100,
    'مستخرج النفط': 100
};

// دالة بديلة لمعالجة المخزون بدون aggregation
async function migrateInventorySystemSimple() {
    try {
        console.log('🔄 Starting simple inventory system migration...');
        
        let migratedCount = 0;
        let updatedCount = 0;
        
        // الحصول على جميع أسماء العناصر الفريدة
        const distinctItems = await UserItem.distinct('item_name');
        console.log(`📦 Found ${distinctItems.length} distinct item types`);
        
        for (const itemName of distinctItems) {
            try {
                // الحصول على جميع المستخدمين الذين لديهم هذا العنصر
                const distinctUsers = await UserItem.distinct('user_id', { item_name: itemName });
                
                for (const userId of distinctUsers) {
                    try {
                        // البحث عن جميع سجلات هذا المستخدم لهذا العنصر
                        const userItems = await UserItem.find({ user_id: userId, item_name: itemName });
                        
                        if (userItems.length > 1) {
                            // حساب الكمية الإجمالية
                            const totalQuantity = userItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
                            
                            // حذف جميع السجلات
                            await UserItem.deleteMany({ user_id: userId, item_name: itemName });
                            
                            // إنشاء سجل واحد جديد
                            const newItem = new UserItem({
                                user_id: userId,
                                item_name: itemName,
                                quantity: totalQuantity
                            });
                            await newItem.save();
                            
                            migratedCount++;
                            
                            if (migratedCount % 20 === 0) {
                                console.log(`🔄 Processed ${migratedCount} duplicate groups...`);
                            }
                        } else if (userItems.length === 1 && (!userItems[0].quantity || userItems[0].quantity === 0)) {
                            // تحديث العناصر بدون quantity
                            await UserItem.updateOne(
                                { _id: userItems[0]._id },
                                { $set: { quantity: 1 } }
                            );
                            updatedCount++;
                        }
                        
                        // تأخير قصير كل 10 مستخدمين
                        if ((migratedCount + updatedCount) % 10 === 0) {
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }
                        
                    } catch (userError) {
                        console.error(`❌ Error processing user ${userId} for item ${itemName}:`, userError);
                    }
                }
                
                // تأخير بين العناصر المختلفة
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (itemError) {
                console.error(`❌ Error processing item ${itemName}:`, itemError);
            }
        }
        
        console.log(`✅ Simple migration completed! Processed ${migratedCount} duplicate groups and ${updatedCount} items without quantity.`);
        return { migratedCount, updatedCount, simple: true };
        
    } catch (error) {
        console.error('❌ Error during simple migration:', error);
        return { error: error.message };
    }
}

// دالة تحويل البيانات من النظام القديم إلى الجديد
async function migrateInventorySystem() {
    try {
        console.log('🔄 Starting inventory system migration...');
        
        // البحث عن جميع المستخدمين الذين لديهم عناصر مكررة
        // استخدام مراحل متعددة وتحسين الذاكرة
        let migratedCount = 0;
        let batchSize = 100; // معالجة 100 مجموعة في كل مرة
        let skip = 0;
        let hasMoreData = true;
        
        while (hasMoreData) {
            try {
                // معالجة البيانات على دفعات صغيرة لتجنب مشاكل الذاكرة
                const duplicates = await UserItem.aggregate([
                    {
                        $group: {
                            _id: { user_id: "$user_id", item_name: "$item_name" },
                            count: { $sum: 1 },
                            items: { $push: "$_id" }
                        }
                    },
                    {
                        $match: { count: { $gt: 1 } }
                    },
                    {
                        $skip: skip
                    },
                    {
                        $limit: batchSize
                    }
                ], { 
                    allowDiskUse: true,
                    maxTimeMS: 60000, // 60 ثانية كحد أقصى
                    cursor: { batchSize: 50 } // حجم دفعة أصغر للcursor
                });
                
                if (duplicates.length === 0) {
                    hasMoreData = false;
                    break;
                }
                
                // معالجة كل دفعة
                for (const duplicate of duplicates) {
                    try {
                        const { user_id, item_name } = duplicate._id;
                        const totalQuantity = duplicate.count;
                        
                        // حذف جميع السجلات المكررة
                        await UserItem.deleteMany({ 
                            user_id: user_id, 
                            item_name: item_name 
                        });
                        
                        // إنشاء سجل واحد بالكمية الإجمالية
                        const newItem = new UserItem({
                            user_id: user_id,
                            item_name: item_name,
                            quantity: totalQuantity
                        });
                        await newItem.save();
                        
                        migratedCount++;
                        
                        // تسجيل التقدم كل 50 عنصر
                        if (migratedCount % 50 === 0) {
                            console.log(`🔄 Processed ${migratedCount} duplicate groups...`);
                        }
                        
                    } catch (itemError) {
                        console.error(`❌ Error processing duplicate item:`, itemError);
                        // المتابعة مع العنصر التالي بدلاً من إيقاف العملية كاملة
                    }
                }
                
                skip += batchSize;
                
                // تأخير قصير بين الدفعات لتقليل الضغط
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (batchError) {
                console.error(`❌ Error processing batch starting at ${skip}:`, batchError);
                
                // في حالة فشل الدفعة، جرب الطريقة البسيطة بدون aggregation
                console.log('🔄 Switching to simple migration method...');
                try {
                    const simpleResult = await migrateInventorySystemSimple();
                    return simpleResult;
                } catch (alternativeError) {
                    console.error(`❌ Simple method also failed:`, alternativeError);
                    hasMoreData = false;
                }
                
                skip += batchSize;
            }
        }
        
        // تحديث العناصر الموجودة التي لا تحتوي على quantity
        // استخدام updateMany لتحديث أسرع وأكثر كفاءة
        const updateResult = await UserItem.updateMany(
            {
                $or: [
                    { quantity: { $exists: false } },
                    { quantity: null },
                    { quantity: 0 }
                ]
            },
            { $set: { quantity: 1 } }
        );
        
        const updatedCount = updateResult.modifiedCount;
        
        console.log(`✅ Migration completed! Processed ${migratedCount} duplicate groups and ${updatedCount} items without quantity.`);
        
        return { migratedCount, updatedCount };
        
    } catch (error) {
        console.error('❌ Error during migration:', error);
        
        // طريقة احتياطية في حالة فشل كل شيء
        try {
            console.log('🔄 Attempting emergency fallback method...');
            
            // معالجة بسيطة جداً: تحديث العناصر بدون quantity فقط
            const emergencyUpdate = await UserItem.updateMany(
                {
                    $or: [
                        { quantity: { $exists: false } },
                        { quantity: null },
                        { quantity: 0 }
                    ]
                },
                { $set: { quantity: 1 } }
            );
            
            console.log(`⚠️ Emergency fallback completed. Updated ${emergencyUpdate.modifiedCount} items.`);
            return { migratedCount: 0, updatedCount: emergencyUpdate.modifiedCount, emergency: true };
            
        } catch (emergencyError) {
            console.error('❌ Emergency fallback also failed:', emergencyError);
            return { error: error.message };
        }
    }
}

mongoose.connection.once('open', async () => {
    console.log('Connected to MongoDB');

    // بدء نظام الرواتب التلقائي
    startSalarySystem();
    
    // تشغيل التحويل التلقائي للنظام الجديد بعد 15 ثانية
    setTimeout(async () => {
        console.log('🔄 Starting automatic inventory migration...');
        await migrateInventorySystem();
    }, 15000);
});

// نظام الرواتب التلقائي
function startSalarySystem() {
    setInterval(async () => {
        try {
            const users = await User.find();

            for (const user of users) {
                await processUserSalary(user);
            }

            // تنظيف المعاملات المعلقة القديمة (أكثر من ساعة)
            const oneHour = 60 * 60 * 1000;
            const now = Date.now();
            for (const [transactionId, transaction] of pendingTransactions.entries()) {
                if (now - transaction.timestamp > oneHour) {
                    pendingTransactions.delete(transactionId);
                }
            }
        } catch (error) {
            console.error('Error in salary system:', error);
        }
    }, 60000); // كل دقيقة للتحقق
}
// دالة حساب إجمالي الضرر
function calculateTotalDamage(user, attackingCount) {
    if (!user) return 0;

    let damage = 0;
    let remainingAttackers = attackingCount;

    // حساب ضرر الجنود العاديين (ضرر 5)
    const normalSoldiers = Math.min(remainingAttackers, user.soldiers || 0);
    damage += normalSoldiers * 5;
    remainingAttackers -= normalSoldiers;

    // حساب ضرر الضباط (ضرر 10)
    const officers = Math.min(remainingAttackers, user.officers || 0);
    damage += officers * 10;
    remainingAttackers -= officers;

    // حساب ضرر العقداء (ضرر 15)
    const colonels = Math.min(remainingAttackers, user.colonels || 0);
    damage += colonels * 15;
    remainingAttackers -= colonels;

    // حساب ضرر اللوائات (ضرر 25)
    const generals = Math.min(remainingAttackers, user.generals || 0);
    damage += generals * 25;
    remainingAttackers -= generals;

    // حساب ضرر الجنود ضعيفي الهمة (ضرر 2)
    const lowMoraleSoldiers = Math.min(remainingAttackers, user.lowMoraleSoldiers || 0);
    damage += lowMoraleSoldiers * 2;

    return damage;
}

// دالة حساب خسائر المدافع حسب نوع الجندي
function calculateDefenderLosses(defender, totalDamage) {
    let remainingDamage = totalDamage;
    let losses = {
        soldiers: 0,
        officers: 0,
        colonels: 0,
        generals: 0,
        lowMoraleSoldiers: 0
    };

    // تطبيق الضرر على الجنود العاديين أولاً (صحة 20)
    if (remainingDamage > 0 && defender.soldiers > 0) {
        const soldierLosses = Math.min(Math.floor(remainingDamage / 20), defender.soldiers);
        losses.soldiers = soldierLosses;
        remainingDamage -= soldierLosses * 20;
        defender.soldiers -= soldierLosses;
    }

    // تطبيق الضرر على الضباط (صحة 35)
    if (remainingDamage > 0 && defender.officers > 0) {
        const officerLosses = Math.min(Math.floor(remainingDamage / 35), defender.officers);
        losses.officers = officerLosses;
        remainingDamage -= officerLosses * 35;
        defender.officers -= officerLosses;
    }

    // تطبيق الضرر على العقداء (صحة 40)
    if (remainingDamage > 0 && defender.colonels > 0) {
        const colonelLosses = Math.min(Math.floor(remainingDamage / 40), defender.colonels);
        losses.colonels = colonelLosses;
        remainingDamage -= colonelLosses * 40;
        defender.colonels -= colonelLosses;
    }

    // تطبيق الضرر على اللوائات (صحة 50)
    if (remainingDamage > 0 && defender.generals > 0) {
        const generalLosses = Math.min(Math.floor(remainingDamage / 50), defender.generals);
        losses.generals = generalLosses;
        remainingDamage -= generalLosses * 50;
        defender.generals -= generalLosses;
    }

    // تطبيق الضرر على الجنود ضعيفي الهمة (صحة 15)
    if (remainingDamage > 0 && defender.lowMoraleSoldiers > 0) {
        const lowMoraleLosses = Math.min(Math.floor(remainingDamage / 15), defender.lowMoraleSoldiers);
        losses.lowMoraleSoldiers = lowMoraleLosses;
        defender.lowMoraleSoldiers -= lowMoraleLosses;
    }

    return losses.soldiers + losses.officers + losses.colonels + losses.generals + losses.lowMoraleSoldiers;
}
async function processUserSalary(user) {
    try {
        const now = new Date();
        const lastSalaryTime = new Date(user.lastSalaryPaid);
        const timeDifference = now - lastSalaryTime;
        const oneHour = 60 * 60 * 1000; // ساعة واحدة بالميلي ثانية

        if (timeDifference >= oneHour) {
            // حساب الراتب حسب الرتبة
            const totalSalaryCost = 
                (user.soldiers || 0) * 0.5 + // جنود عاديون: نصف عملة
                (user.officers || 0) * 1 + // ضباط: عملة واحدة
                (user.colonels || 0) * 3 + // عقداء: 3 عملات
                (user.generals || 0) * 5 + // لوائات: 5 عملات
                (user.lowMoraleSoldiers || 0) * 0.5; // جنود ضعيفي الهمة: نصف عملة

            if (user.coins >= totalSalaryCost) {
                // دفع الراتب لجميع الجنود
                user.coins -= totalSalaryCost;
                user.lastSalaryPaid = now;

                // إرجاع الجنود ضعيفي الهمة إلى جنود عاديين إذا تم دفع رواتبهم
                if (user.lowMoraleSoldiers > 0) {
                    user.soldiers += user.lowMoraleSoldiers;
                    user.lowMoraleSoldiers = 0;
                }

                await user.save();
            } else {
                // دفع الراتب بترتيب الأولوية (الأعلى راتباً أولاً)
                let remainingCoins = user.coins;
                let paidGenerals = 0, paidColonels = 0, paidOfficers = 0, paidSoldiers = 0, paidLowMorale = 0;

                // دفع رواتب اللوائات أولاً (5 عملات)
                if (user.generals > 0 && remainingCoins >= 5) {
                    paidGenerals = Math.min(user.generals, Math.floor(remainingCoins / 5));
                    remainingCoins -= paidGenerals * 5;
                }

                // دفع رواتب العقداء (3 عملات)
                if (user.colonels > 0 && remainingCoins >= 3) {
                    paidColonels = Math.min(user.colonels, Math.floor(remainingCoins / 3));
                    remainingCoins -= paidColonels * 3;
                }

                // دفع رواتب الضباط (عملة واحدة)
                if (user.officers > 0 && remainingCoins >= 1) {
                    paidOfficers = Math.min(user.officers, Math.floor(remainingCoins / 1));
                    remainingCoins -= paidOfficers * 1;
                }

                // دفع رواتب الجنود العاديين (نصف عملة)
                if (user.soldiers > 0 && remainingCoins >= 0.5) {
                    paidSoldiers = Math.min(user.soldiers, Math.floor(remainingCoins / 0.5));
                    remainingCoins -= paidSoldiers * 0.5;
                }

                // دفع رواتب الجنود ضعيفي الهمة (نصف عملة)
                if (user.lowMoraleSoldiers > 0 && remainingCoins >= 0.5) {
                    paidLowMorale = Math.min(user.lowMoraleSoldiers, Math.floor(remainingCoins / 0.5));
                    remainingCoins -= paidLowMorale * 0.5;
                }

                if (paidGenerals + paidColonels + paidOfficers + paidSoldiers + paidLowMorale > 0) {
                    user.coins = remainingCoins;
                    user.lastSalaryPaid = now;

                    // تحويل الجنود غير المدفوعين إلى ضعيفي الهمة
                    const unpaidGenerals = user.generals - paidGenerals;
                    const unpaidColonels = user.colonels - paidColonels;
                    const unpaidOfficers = user.officers - paidOfficers;
                    const unpaidSoldiers = user.soldiers - paidSoldiers;

                    // تحويل الجنود غير المدفوعين إلى ضعيفي الهمة (تخفيض رتبة)
                    user.lowMoraleSoldiers += unpaidSoldiers + unpaidOfficers + unpaidColonels + unpaidGenerals;
                    user.soldiers = paidSoldiers;
                    user.officers = paidOfficers;
                    user.colonels = paidColonels;
                    user.generals = paidGenerals;

                    await user.save();
                } else {
                    // لا توجد عملات كافية لأي جندي
                    // التحقق من مرور ساعتين للاستقالة
                    if (timeDifference >= (2 * oneHour)) {
                        // إزالة جميع الجنود (استقالة)
                        user.soldiers = 0;
                        user.officers = 0;
                        user.colonels = 0;
                        user.generals = 0;
                        user.lowMoraleSoldiers = 0;
                        user.lastSalaryPaid = now;

                        await user.save();

                        // إرسال رسالة للاعب (إذا أردت)
                        try {
                            const discordUser = await client.users.fetch(user.id);
                            const embed = new discord.EmbedBuilder()
                                .setColor('#FF0000')
                                .setTitle('استقالة الجيش!')
                                .setDescription('لقد استقال جميع جنودك بسبب عدم دفع الرواتب لمدة ساعتين!')
                                .setFooter({ text: 'تأكد من وجود عملات كافية لدفع رواتب الجنود' });

                            await discordUser.send({ embeds: [embed] });
                        } catch (error) {
                            console.error('Error sending resignation message:', error);
                        }
                    } else {
                        // تحويل جميع الجنود إلى ضعيفي الهمة
                        user.lowMoraleSoldiers += user.soldiers + user.officers + user.colonels + user.generals;
                        user.soldiers = 0;
                        user.officers = 0;
                        user.colonels = 0;
                        user.generals = 0;
                        user.lastSalaryPaid = now;

                        await user.save();
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error processing salary for user:', user.id, error);
    }
}

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(`رابط البوت : https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=8`);

    // تحديث cache الدعوات لجميع السيرفرات
    for (const guild of client.guilds.cache.values()) {
        await updateInviteCache(guild);
    }
});


// معالج انضمام الأعضاء الجدد
client.on('guildMemberAdd', async (member) => {
    try {
        const guild = member.guild;

        // التحقق من أن العضو ليس بوت
        if (member.user.bot) return;

        // قراءة قائمة الأعضاء الذين غادروا
        const leftMembers = readLeftMembers();

        // التحقق من أن العضو لم يغادر السيرفر من قبل
        if (leftMembers.includes(member.user.id)) {
            console.log(`Member ${member.user.tag} has rejoined - no invite reward given`);
            return;
        }

        // الحصول على الدعوات الجديدة
        const newInvites = await guild.invites.fetch();
        const oldInvites = inviteCache.get(guild.id) || new Map();

        // العثور على الدعوة المستخدمة
        let usedInvite = null;
        for (const [code, invite] of newInvites) {
            const oldUses = oldInvites.get(code) || 0;
            if (invite.uses > oldUses) {
                usedInvite = invite;
                break;
            }
        }

        if (usedInvite && usedInvite.inviter) {
            // العثور على اللاعب الذي قام بالدعوة
            const inviter = await User.findOne({ id: usedInvite.inviter.id });

            if (inviter) {
                // إضافة 500 ألف عملة للاعب
                const rewardAmount = 1000000;

// دالة معالجة الأوامر مع حماية rate limiting
async function processCommand(message) {
    try {
        const content = message.content.toLowerCase();

        // تحديد أولوية الأمر
        let priority = 'normal';
        if (content.startsWith('!p') || content.startsWith('!توب')) {
            priority = 'high'; // أوامر سريعة
        } else if (content.startsWith('!غارة') || content.startsWith('!هجوم')) {
            priority = 'low'; // أوامر قد تسبب حمولة
        }

        // معالج محمي للرسائل
        const safeReply = (content, options = {}) => {
            return safeExecute(
                () => message.reply(content, options),
                { 
                    type: 'channel', 
                    identifier: message.channel.id, 
                    priority: priority 
                }
            );
        };

        const safeSend = (content, options = {}) => {
            return safeExecute(
                () => message.channel.send(content, options),
                { 
                    type: 'channel', 
                    identifier: message.channel.id, 
                    priority: priority 
                }
            );
        };

        // استبدال message.reply و message.channel.send في معالجة الأوامر
        const originalReply = message.reply;
        const originalSend = message.channel.send;

        message.reply = safeReply;
        message.channel.send = safeSend;

        // معالجة الأمر الأصلية (سيتم استدعاؤها لاحقاً)
        await executeOriginalCommand(message);

        // إعادة تعيين الدوال الأصلية
        message.reply = originalReply;
        message.channel.send = originalSend;

    } catch (error) {
        console.error('Error in processCommand:', error);

        // محاولة إرسال رسالة خطأ بطريقة آمنة
        safeExecute(
            () => message.reply('حدث خطأ أثناء معالجة الأمر. يرجى المحاولة مرة أخرى.'),
            { 
                type: 'channel', 
                identifier: message.channel.id, 
                priority: 'high' 
            }
        ).catch(console.error);
    }
}

// دالة تنفيذ الأمر الأصلية (تحتوي على جميع الأوامر)
async function executeOriginalCommand(message) {
    // نقل جميع منطق الأوامر الحالي هنا
    // (سيتم التعامل مع هذا في الجزء التالي)
}


                inviter.coins += rewardAmount;
                await inviter.save();

                // إرسال رسالة للاعب الذي قام بالدعوة
                try {
                    const inviterUser = await client.users.fetch(usedInvite.inviter.id);
                    const rewardEmbed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('🎉 مكافأة الدعوة!')
                        .setDescription(`تهانينا! لقد حصلت على مكافأة لدعوة عضو جديد للسيرفر`)
                        .addFields(
                            { name: '👤 العضو الجديد:', value: member.user.tag },
                            { name: '💰 المكافأة:', value: `${rewardAmount.toLocaleString()} عملة` },
                            { name: '💎 عملاتك الحالية:', value: `${inviter.coins.toLocaleString()} عملة` }
                        )
                        .setFooter({ text: 'استمر في دعوة الأصدقاء لكسب المزيد من المكافآت!' })
                        .setTimestamp();

                    await inviterUser.send({ embeds: [rewardEmbed] });
                } catch (error) {
                    console.error('Error sending invite reward DM:', error);
                }

                // إرسال رسالة في القناة العامة (اختياري)
                const welcomeChannel = "1323073776719757395";
               const logChannel = client.channels.cache.get(welcomeChannel);
                if (logChannel) {
                    const publicEmbed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('🎉 عضو جديد!')
                        .setDescription(`مرحباً ${member.user}! تم دعوتك من قبل ${usedInvite.inviter}`)
                        .addFields(
                            { name: '🎁 مكافأة الدعوة:', value: `${usedInvite.inviter} حصل على ${rewardAmount.toLocaleString()} عملة!` }
                        )
                        .setFooter({ text: 'ادع أصدقائك واحصل على مكافآت!' });

                    await logChannel.send({ embeds: [publicEmbed] });
                }

                console.log(`Invite reward given: ${usedInvite.inviter.tag} got ${rewardAmount} coins for inviting ${member.user.tag}`);
            }
        }

        // تحديث cache الدعوات
        await updateInviteCache(guild);

    } catch (error) {
        console.error('Error handling member join for invite rewards:', error);
    }
});

// معالج مغادرة الأعضاء
client.on('guildMemberRemove', async (member) => {
    try {
        // تجاهل البوتات
        if (member.user.bot) return;

        // قراءة قائمة الأعضاء الذين غادروا
        const leftMembers = readLeftMembers();

        // إضافة العضو للقائمة إذا لم يكن موجوداً
        if (!leftMembers.includes(member.user.id)) {
            leftMembers.push(member.user.id);
            writeLeftMembers(leftMembers);
            console.log(`Added ${member.user.tag} to left members list`);
        }

        // تحديث cache الدعوات
        await updateInviteCache(member.guild);

    } catch (error) {
        console.error('Error handling member leave:', error);
    }
});

// نظام معالجة الأخطاء المتقدم
const errorStats = {
    uncaughtExceptions: 0,
    unhandledRejections: 0,
    rateLimitErrors: 0,
    networkErrors: 0,
    lastErrorTime: 0
};

// معالج الاستثناءات غير المعالجة
process.on('uncaughtException', (err) => {
    errorStats.uncaughtExceptions++;
    errorStats.lastErrorTime = Date.now();

    console.error('🔴 Uncaught Exception:', {
        message: err.message,
        stack: err.stack,
        code: err.code,
        timestamp: new Date().toISOString(),
        stats: errorStats
    });

    // تفعيل النمط الآمن عند تكرار الأخطاء
    if (errorStats.uncaughtExceptions > 5) {
        console.error('⚠️ Multiple uncaught exceptions detected, enabling safe mode');
        systemStats.adaptiveMode = true;
    }

    // إعادة تشغيل النظام إذا كانت الأخطاء حرجة
    if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
        errorStats.networkErrors++;
        console.error('🌐 Network error detected, implementing recovery measures');

        if (errorStats.networkErrors > 10) {
            console.error('🚨 Too many network errors, restarting...');
            process.exit(1);
        }
    }
});

// معالج الرفضيات غير المعالجة
process.on('unhandledRejection', (reason, promise) => {
    errorStats.unhandledRejections++;
    errorStats.lastErrorTime = Date.now();

    console.error('🟡 Unhandled Rejection:', {
        reason: reason,
        promise: promise,
        timestamp: new Date().toISOString(),
        stats: errorStats
    });

    // معالجة خاصة لأخطاء rate limiting
    if (reason && (reason.code === 429 || reason.message?.includes('rate limit'))) {
        errorStats.rateLimitErrors++;
        systemStats.adaptiveMode = true;

        console.warn('🚨 Rate limit error in unhandled rejection, adapting system behavior');
    }

    // تفعيل النمط الآمن عند تكرار الرفضيات
    if (errorStats.unhandledRejections > 10) {
        console.error('⚠️ Multiple unhandled rejections detected, enabling safe mode');
        systemStats.adaptiveMode = true;
    }
});

// معالج إشارات النظام
process.on('SIGTERM', () => {
    console.log('📤 SIGTERM received, gracefully shutting down...');

    // إنهاء الطلبات المعلقة بأمان
    console.log(`📊 Final stats: Queue size: ${requestQueue.getTotalQueueSize()}, Total requests: ${systemStats.totalRequests}`);

    client.destroy();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📤 SIGINT received, gracefully shutting down...');

    console.log(`📊 Final stats: Queue size: ${requestQueue.getTotalQueueSize()}, Total requests: ${systemStats.totalRequests}`);

    client.destroy();
    process.exit(0);
});
// مراقبة استخدام الذاكرة
setInterval(() => {
    const memUsage = process.memoryUsage();
    const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);

    if (memUsageMB > 200) { // تحذير عند تجاوز 200 ميجا
        console.warn(`⚠️ High memory usage detected: ${memUsageMB}MB`);

        // تفعيل تنظيف الذاكرة
        if (global.gc) {
            global.gc();
            console.log('🧹 Garbage collection triggered');
        }

        // تنظيف الخرائط القديمة
        const now = Date.now();
        for (const [id, tracker] of requestTrackers.channels.entries()) {
            if (now - tracker.resetTime > 60000) {
                requestTrackers.channels.delete(id);
            }
        }

        for (const [id, tracker] of requestTrackers.users.entries()) {
            if (now - tracker.resetTime > 120000) {
                requestTrackers.users.delete(id);
            }
        }
    }

    // إنذار حرج عند تجاوز 400 ميجا
    if (memUsageMB > 400) {
        console.error(`🔴 CRITICAL: Memory usage very high: ${memUsageMB}MB`);
        systemStats.adaptiveMode = true;

        // تنظيف عدواني للذاكرة
        requestQueue.queues.low = [];
        console.log('🧹 Aggressive memory cleanup performed');
    }
}, 120000); // كل دقيقتين

// مراقبة أداء النظام
setInterval(() => {
    const uptime = process.uptime();
    const errorRate = (errorStats.uncaughtExceptions + errorStats.unhandledRejections) / Math.max(uptime / 3600, 1); // أخطاء لكل ساعة

    if (errorRate > 5) { // أكثر من 5 أخطاء في الساعة
        console.warn(`⚠️ High error rate detected: ${errorRate.toFixed(2)} errors/hour`);
        systemStats.adaptiveMode = true;
    }

    // إعادة تعيين إحصائيات الأخطاء كل 6 ساعات
    if (uptime > 21600 && Date.now() - errorStats.lastErrorTime > 3600000) {
        errorStats.uncaughtExceptions = 0;
        errorStats.unhandledRejections = 0;
        errorStats.rateLimitErrors = 0;
        errorStats.networkErrors = 0;
        console.log('🔄 Error statistics reset');
    }
}, 600000); // كل 10 دقائق
// معالج التفاعلات (الأزرار)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    try {
        // معالجة فتح التذكرة
        if (interaction.customId.startsWith('open_ticket_')) {
            const ticketId = interaction.customId.replace('open_ticket_', '');

            // البحث عن التذكرة في قاعدة البيانات
            let ticket = await Ticket.findOne({ id: ticketId });

            // إذا لم يتم العثور على التذكرة، قم بإنشاء واحدة جديدة
            if (!ticket) {
                console.log(`Creating new ticket system with ID: ${ticketId}`);
                ticket = new Ticket({
                    id: ticketId,
                    channel_id: interaction.channel.id,
                    support_role_id: null, // سيتم تحديده لاحقاً
                    open_message: 'مرحباً! كيف يمكننا مساعدتك؟',
                    creator_id: null
                });
                await ticket.save();
            }

            // تنظيف شامل للتذاكر المحذوفة
            try {
                const allTickets = await Ticket.find({ 
                    ticket_channel_id: { $exists: true, $ne: null } 
                });

                for (const dbTicket of allTickets) {
                    try {
                        const channelExists = await interaction.guild.channels.fetch(dbTicket.ticket_channel_id).catch(() => null);
                        if (!channelExists) {
                            await Ticket.findOneAndUpdate(
                                { _id: dbTicket._id },
                                { $unset: { creator_id: "", ticket_channel_id: "" } }
                            );
                            console.log(`Cleaned up deleted ticket channel: ${dbTicket.ticket_channel_id}`);
                        }
                    } catch (error) {
                        // إذا فشل الحصول على القناة، فهي غير موجودة
                        await Ticket.findOneAndUpdate(
                            { _id: dbTicket._id },
                            { $unset: { creator_id: "", ticket_channel_id: "" } }
                        );
                    }
                }
            } catch (error) {
                console.error('Error during ticket cleanup:', error);
            }

            // التحقق من وجود تذكرة مفتوحة للمستخدم بعد التنظيف
            const existingUserTicket = await Ticket.findOne({ 
                creator_id: interaction.user.id, 
                ticket_channel_id: { $exists: true, $ne: null } 
            });

            if (existingUserTicket) {
                try {
                    const existingChannel = await interaction.guild.channels.fetch(existingUserTicket.ticket_channel_id);
                    if (existingChannel) {
                        return interaction.reply({ content: `لديك تذكرة مفتوحة بالفعل في ${existingChannel}!`, ephemeral: true });
                    }
                } catch (error) {
                    // القناة غير موجودة، قم بتنظيف البيانات
                    await Ticket.findOneAndUpdate(
                        { _id: existingUserTicket._id },
                        { $unset: { creator_id: "", ticket_channel_id: "" } }
                    );
                }
            }

            // التحقق من وجود قناة بنفس الاسم
            const existingChannelByName = interaction.guild.channels.cache.find(
                channel => channel.name === `ticket-${interaction.user.username.toLowerCase()}`
            );

            if (existingChannelByName) {
                // ربط القناة الموجودة بالتذكرة
                await Ticket.findOneAndUpdate(
                    { id: ticketId },
                    { 
                        $set: { 
                            creator_id: interaction.user.id,
                            ticket_channel_id: existingChannelByName.id
                        }
                    }
                );
                return interaction.reply({ content: `تم العثور على تذكرتك الموجودة في ${existingChannelByName}!`, ephemeral: true });
            }

            // الحصول على كاتيجوري القناة الحالية
            const currentChannel = interaction.channel;
            const parentCategory = currentChannel.parent;

            // التحقق من وجود support_role_id
            let supportRoleId = ticket.support_role_id;
            if (!supportRoleId) {
              supportRoleId = '1323072269525712927';
            }

            // إنشاء قناة التذكرة في نفس الكاتيجوري مع صلاحيات محدودة
            const ticketChannel = await interaction.guild.channels.create({
                name: `ticket-${interaction.user.username}`,
                type: discord.ChannelType.GuildText,
                parent: parentCategory, // إنشاء التذكرة في نفس الكاتيجوري
                permissionOverwrites: [
                    {
                        id: interaction.guild.id, // @everyone
                        deny: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages', 'ManageChannels']
                    },
                    {
                        id: interaction.user.id, // صاحب التذكرة
                        allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks']
                    },
                    {
                        id: supportRoleId, // فريق الدعم
                        allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels', 'ManageMessages', 'AttachFiles', 'EmbedLinks']
                    },
                    {
                        id: interaction.guild.members.me.id, // البوت نفسه
                        allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels', 'ManageMessages', 'AttachFiles', 'EmbedLinks']
                    }
                ]
            });

            // حفظ معلومات التذكرة مع الربط الكامل
            const updatedTicket = await Ticket.findOneAndUpdate(
                { id: ticketId },
                { 
                    $set: { 
                        creator_id: interaction.user.id,
                        ticket_channel_id: ticketChannel.id,
                        channel_id: interaction.channel.id, // حفظ معرف الرسالة الأصلية
                        created_at: new Date()
                    }
                },
                { new: true, upsert: true }
            );

            const ticketEmbed = new discord.EmbedBuilder()
                .setColor('#0099FF')
                .setTitle('🎫 تذكرة دعم')
                .setDescription(ticket.open_message || 'مرحباً! كيف يمكننا مساعدتك؟')
                .addFields(
                    { name: '👤 المستخدم:', value: interaction.user.toString() },
                    { name: '📅 تاريخ الفتح:', value: new Date().toLocaleString('ar-SA') },
                    { name: '🆔 معرف التذكرة:', value: ticketId },
                    { name: '🏷️ حالة التذكرة:', value: '🟢 مفتوحة' }
                )
                .setFooter({ text: 'استخدم الأزرار أدناه للتفاعل مع التذكرة' })
                .setTimestamp();

            const row = new discord.ActionRowBuilder()
                .addComponents(
                    new discord.ButtonBuilder()
                        .setCustomId('close_ticket')
                        .setLabel('🔒 إغلاق التذكرة')
                        .setStyle(discord.ButtonStyle.Danger),
                    new discord.ButtonBuilder()
                        .setCustomId('buy_coins')
                        .setLabel('💰 شراء عملات')
                        .setStyle(discord.ButtonStyle.Success),
                    new discord.ButtonBuilder()
                        .setCustomId('sell_coins')
                        .setLabel('💸 صرف عملات')
                        .setStyle(discord.ButtonStyle.Secondary)
                );

            await ticketChannel.send({ embeds: [ticketEmbed], components: [row] });
            await interaction.reply({ content: `✅ تم فتح تذكرتك بنجاح في ${ticketChannel}`, ephemeral: true });
           await ticketChannel.send(`<@&${supportRoleId}>`);

            console.log(`Ticket created successfully - ID: ${ticketId}, Channel: ${ticketChannel.id}, User: ${interaction.user.id}`);
        }

        // معالجة إغلاق التذكرة
        else if (interaction.customId === 'close_ticket') {
            if (!interaction.channel.name.startsWith('ticket-')) {
                return interaction.reply({ content: 'هذا ليس قناة تذكرة صالحة!', ephemeral: true });
            }

            // البحث عن التذكرة في قاعدة البيانات
            const ticket = await Ticket.findOne({ ticket_channel_id: interaction.channel.id });

            // التحقق من الصلاحيات بدقة أكبر
            let hasPermission = false;

            if (ticket && ticket.creator_id === interaction.user.id) {
                // صاحب التذكرة لديه صلاحية إغلاق تذكرته
                hasPermission = true;
            } else if (ticket && ticket.support_role_id && interaction.member.roles.cache.has(ticket.support_role_id)) {
                // فريق الدعم يمكنه إغلاق التذاكر
                hasPermission = true;
            } else if (interaction.member.permissions.has(discord.PermissionFlagsBits.Administrator)) {
                // المشرفين لديهم صلاحية إغلاق أي تذكرة
                hasPermission = true;
            } else {
                // التحقق الدقيق من اسم القناة (فقط في حالة عدم وجود بيانات التذكرة)
                if (!ticket) {
                    const ticketOwnerUsername = interaction.channel.name.replace('ticket-', '').toLowerCase();
                    if (interaction.user.username.toLowerCase() === ticketOwnerUsername) {
                        hasPermission = true;
                    }
                }
            }

            if (!hasPermission) {
                return interaction.reply({ content: '❌ ليس لديك صلاحية لإغلاق هذه التذكرة!\n🔒 يمكن فقط لصاحب التذكرة أو فريق الدعم إغلاق التذكرة.', ephemeral: true });
            }

            // إنشاء رسالة تأكيد
            const confirmEmbed = new discord.EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('تأكيد إغلاق التذكرة')
                .setDescription('هل أنت متأكد من إغلاق هذه التذكرة؟')
                .addFields(
                    { name: 'تحذير:', value: 'سيتم حذف القناة نهائياً وفقدان جميع الرسائل!' }
                )
                .setFooter({ text: 'لا يمكن التراجع عن هذا الإجراء' });

            const confirmRow = new discord.ActionRowBuilder()
                .addComponents(
                    new discord.ButtonBuilder()
                        .setCustomId('confirm_close')
                        .setLabel('تأكيد الإغلاق')
                        .setStyle(discord.ButtonStyle.Danger),
                    new discord.ButtonBuilder()
                        .setCustomId('cancel_close')
                        .setLabel('إلغاء')
                        .setStyle(discord.ButtonStyle.Secondary)
                );

            await interaction.reply({ embeds: [confirmEmbed], components: [confirmRow] });
        } 
            else if (interaction.customId === 'confirm_close') {
                try {
                    await interaction.reply('سيتم إغلاق التذكرة خلال 5 ثوان...');

                    // حذف بيانات التذكرة من قاعدة البيانات
                    await Ticket.findOneAndDelete({ ticket_channel_id: interaction.channel.id });

                    setTimeout(async () => {
                        try {
                            await interaction.channel.delete();
                        } catch (error) {
                            console.error('Error deleting ticket channel:', error);
                        }
                    }, 5000);
                } catch (error) {
                    console.error('Error confirming close ticket:', error);
                    await interaction.followUp({ content: 'حدث خطأ أثناء إغلاق التذكرة. يرجى المحاولة مرة أخرى.', ephemeral: true });
                }
            }

            else if (interaction.customId === 'cancel_close') {
                await interaction.update({ content: 'تم إلغاء إغلاق التذكرة.', embeds: [], components: [] });
            }


        // معالجة شراء العملات
        else if (interaction.customId === 'buy_coins') {
            if (!interaction.channel.name.startsWith('ticket-')) {
                return interaction.reply({ content: 'هذا الأمر متاح فقط في التذاكر!', ephemeral: true });
            }

            // التحقق من الصلاحيات للاستخدام بدقة أكبر
            const ticket = await Ticket.findOne({ ticket_channel_id: interaction.channel.id });
            let hasPermission = false;

            if (ticket && ticket.creator_id === interaction.user.id) {
                // صاحب التذكرة لديه صلاحية كاملة
                hasPermission = true;
            } else if (ticket && ticket.support_role_id && interaction.member.roles.cache.has(ticket.support_role_id)) {
                // فريق الدعم يمكنه المساعدة في الشراء
                hasPermission = true;
            } else if (interaction.member.permissions.has(discord.PermissionFlagsBits.Administrator)) {
                // المشرفين لديهم صلاحية كاملة
                hasPermission = true;
            } else {
                // التحقق الدقيق من اسم القناة (فقط في حالة عدم وجود بيانات التذكرة)
                if (!ticket) {
                    const ticketOwnerUsername = interaction.channel.name.replace('ticket-', '').toLowerCase();
                    if (interaction.user.username.toLowerCase() === ticketOwnerUsername) {
                        hasPermission = true;
                    }
                }
            }

            if (!hasPermission) {
                return interaction.reply({ content: '❌ ليس لديك صلاحية لاستخدام هذا الزر!\n🔒 يمكن فقط لصاحب التذكرة أو فريق الدعم استخدام هذه الخدمة.', ephemeral: true });
            }

            try {
                const modal = new discord.ModalBuilder()
                    .setCustomId('buy_coins_modal')
                    .setTitle('شراء عملات');

                const coinsInput = new discord.TextInputBuilder()
                    .setCustomId('coins_amount')
                    .setLabel('عدد العملات المراد شراؤها')
                    .setStyle(discord.TextInputStyle.Short)
                    .setPlaceholder('مثال: 100000')
                    .setRequired(true);

                const firstActionRow = new discord.ActionRowBuilder().addComponents(coinsInput);
                modal.addComponents(firstActionRow);

                await interaction.showModal(modal);
            } catch (error) {
                console.error('Error showing buy coins modal:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'حدث خطأ أثناء فتح نموذج الشراء.', ephemeral: true });
                }
            }
        }

        // معالجة صرف العملات
        else if (interaction.customId === 'sell_coins') {
            if (!interaction.channel.name.startsWith('ticket-')) {
                return interaction.reply({ content: 'هذا الأمر متاح فقط في التذاكر!', ephemeral: true });
            }

            // التحقق من الصلاحيات للاستخدام بدقة أكبر
            const ticket = await Ticket.findOne({ ticket_channel_id: interaction.channel.id });
            let hasPermission = false;

            if (ticket && ticket.creator_id === interaction.user.id) {
                // صاحب التذكرة لديه صلاحية كاملة للصرف
                hasPermission = true;
            } else if (ticket && ticket.support_role_id && interaction.member.roles.cache.has(ticket.support_role_id)) {
                // فريق الدعم يمكنه المساعدة في الصرف
                hasPermission = true;
            } else if (interaction.member.permissions.has(discord.PermissionFlagsBits.Administrator)) {
                // المشرفين لديهم صلاحية كاملة
                hasPermission = true;
            } else {
                // التحقق الدقيق من اسم القناة (فقط في حالة عدم وجود بيانات التذكرة)
                if (!ticket) {
                    const ticketOwnerUsername = interaction.channel.name.replace('ticket-', '').toLowerCase();
                    if (interaction.user.username.toLowerCase() === ticketOwnerUsername) {
                        hasPermission = true;
                    }
                }
            }

            if (!hasPermission) {
                return interaction.reply({ content: '❌ ليس لديك صلاحية لاستخدام هذا الزر!\n🔒 يمكن فقط لصاحب التذكرة أو فريق الدعم استخدام هذه الخدمة.', ephemeral: true });
            }

            try {
                const user = await User.findOne({ id: interaction.user.id });
                if (!user) {
                    return interaction.reply({ content: 'لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.', ephemeral: true });
                }

                if (user.coins <= 0) {
                    return interaction.reply({ content: 'لا تملك عملات للصرف!', ephemeral: true });
                }

                const modal = new discord.ModalBuilder()
                    .setCustomId('sell_coins_modal')
                    .setTitle('صرف عملات');

                const coinsInput = new discord.TextInputBuilder()
                    .setCustomId('coins_amount')
                    .setLabel('عدد العملات المراد صرفها')
                    .setStyle(discord.TextInputStyle.Short)
                    .setPlaceholder(`مثال: ${user.coins} (الحد الأقصى)`)
                    .setRequired(true);

                const firstActionRow = new discord.ActionRowBuilder().addComponents(coinsInput);
                modal.addComponents(firstActionRow);

                await interaction.showModal(modal);
            } catch (error) {
                console.error('Error showing sell coins modal:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'حدث خطأ أثناء فتح نموذج الصرف.', ephemeral: true });
                }
            }
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'حدث خطأ أثناء معالجة التفاعل.', ephemeral: true });
        }
    }
});
// معالج النماذج (Modals)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit()) return;

    try {
        if (interaction.customId === 'buy_coins_modal') {
            try {
                const coinsAmount = parseInt(interaction.fields.getTextInputValue('coins_amount'));

                if (isNaN(coinsAmount) || coinsAmount <= 0) {
                    return interaction.reply({ content: 'يرجى إدخال عدد صحيح من العملات.', ephemeral: true });
                }

                // الحصول على معدل الشراء الديناميكي
                const dynamicBuyRate = await getDynamicBuyRate();
                const economyInfo = await getEconomyInfo();

                // حساب مبلغ الكريدت المطلوب بناءً على المعدل الديناميكي
                const creditsNeeded = Math.ceil((coinsAmount / dynamicBuyRate) * 1000000);
                const creditsWithTax = calculateProBotTax(creditsNeeded);

                // إنشاء معرف فريد للمعاملة
                const transactionId = Date.now().toString();
                pendingTransactions.set(transactionId, {
                    type: 'buy',
                    userId: interaction.user.id,
                    coinsAmount: coinsAmount,
                    creditsAmount: creditsNeeded,
                    channelId: interaction.channel.id,
                    timestamp: Date.now()
                });

                const buyEmbed = new discord.EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('شراء عملات')
                    .setDescription('لإتمام عملية الشراء، يرجى تحويل المبلغ المطلوب:')
                    .addFields(
                        { name: '🪙 العملات المطلوبة:', value: coinsAmount.toLocaleString() },
                        { name: '💰 مبلغ الكريدت (مع الضريبة):', value: creditsWithTax.toLocaleString() },
                        { name: '📊 حالة الاقتصاد:', value: economyInfo.economyStateName },
                        { name: '📈 معدل الشراء الحالي:', value: `${dynamicBuyRate.toLocaleString()} عملة = 1M كريدت` },
                        { name: '🔄 أمر التحويل:', value: `\`c ${TRANSFER_RECIPIENT_ID} ${creditsWithTax}\`` }
                    )
                    .setFooter({ text: `معرف المعاملة: ${transactionId} • إجمالي العملات في الاقتصاد: ${economyInfo.totalCoins.toLocaleString()}` });

                await interaction.reply({ embeds: [buyEmbed] });
                console.log(`تم إنشاء معاملة شراء: ${transactionId} للمستخدم: ${interaction.user.id}`);
            } catch (error) {
                console.error('Error processing buy coins modal:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'حدث خطأ أثناء معالجة طلب الشراء.', ephemeral: true });
                }
            }
        }

        else if (interaction.customId === 'sell_coins_modal') {
            try {
                const coinsAmount = parseInt(interaction.fields.getTextInputValue('coins_amount'));

                if (isNaN(coinsAmount) || coinsAmount <= 0) {
                    return interaction.reply({ content: 'يرجى إدخال عدد صحيح من العملات.', ephemeral: true });
                }

                const user = await User.findOne({ id: interaction.user.id });
                if (!user || user.coins < coinsAmount) {
                    return interaction.reply({ content: 'لا تملك عملات كافية للصرف!', ephemeral: true });
                }

                // الحصول على معدل الصرف الديناميكي
                const dynamicSellRate = await getDynamicSellRate();
                const economyInfo = await getEconomyInfo();

                // حساب مبلغ الكريدت المستلم بناءً على المعدل الديناميكي (بدون ضريبة)
                const creditsReceived = Math.floor((coinsAmount / dynamicSellRate) * 1000000);

                // حساب المبلغ مع الضريبة الذي يجب إرساله
                const creditsWithTax = calculateProBotTax(creditsReceived);

                // إنشاء معرف فريد للمعاملة
                const transactionId = Date.now().toString();
                pendingTransactions.set(transactionId, {
                    type: 'sell',
                    userId: interaction.user.id,
                    coinsAmount: coinsAmount,
                    creditsAmount: creditsReceived,
                    creditsWithTax: creditsWithTax,
                    channelId: interaction.channel.id,
                    timestamp: Date.now()
                });

                const sellEmbed = new discord.EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('صرف عملات')
                    .setDescription('سيتم إرسال المبلغ التالي إليك:')
                    .addFields(
                        { name: '🪙 العملات المراد صرفها:', value: coinsAmount.toLocaleString() },
                        { name: '💰 مبلغ الكريدت المستلم (صافي):', value: creditsReceived.toLocaleString() },
                        { name: '💸 المبلغ المُرسل (مع الضريبة):', value: creditsWithTax.toLocaleString() },
                        { name: '📊 حالة الاقتصاد:', value: economyInfo.economyStateName },
                        { name: '📉 معدل الصرف الحالي:', value: `${dynamicSellRate.toLocaleString()} عملة = 1M كريدت` },
                        { name: '🆔 معرف المعاملة:', value: transactionId }
                    )
                    .setFooter({ text: `سيقوم الطاقم بتحويل المبلغ إليك قريباً • إجمالي العملات في الاقتصاد: ${economyInfo.totalCoins.toLocaleString()}` });

                await interaction.reply({ embeds: [sellEmbed] });

                // إشعار الطاقم بطلب الصرف
                setTimeout(async () => {
                    try {
                        const channel = await client.channels.fetch(interaction.channel.id);
                        await channel.send(`📝 **طلب صرف جديد**\nالمستخدم: <@${interaction.user.id}>\nالمبلغ الصافي: ${creditsReceived} كريدت\nالمبلغ مع الضريبة: ${creditsWithTax} كريدت\nالأمر: \`c ${interaction.user.id} ${creditsWithTax}\`\nمعرف المعاملة: ${transactionId}\n📊 حالة الاقتصاد: ${economyInfo.economyStateName}`);
                    } catch (error) {
                        console.error('Error sending staff notification:', error);
                    }
                }, 1000);

                console.log(`تم إنشاء معاملة صرف: ${transactionId} للمستخدم: ${interaction.user.id}`);
            } catch (error) {
                console.error('Error processing sell coins modal:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'حدث خطأ أثناء معالجة طلب الصرف.', ephemeral: true });
                }
            }
        }
    } catch (error) {
        console.error('Error handling modal submit:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'حدث خطأ أثناء معالجة النموذج.', ephemeral: true });
        }
    }
});

// Add this near the top of your file, after your imports
async function handleCommand(message) {
    // Add your existing command handling logic here
    // This will be called by processCommand
    try {
        // Your command handling logic goes here
        // You can leave this empty for now as your commands 
        // are already being handled in the messageCreate event
    } catch (error) {
        console.error('Error in handleCommand:', error);
    }
}

client.on('messageCreate', async (message) => {
    // معالجة رسائل بوت الكريدت

    // في دالة endBattleWithRetreat
    const endBattleWithRetreat = async () => {
        try {
            // تحديث قاعدة البيانات
            const updatedAttacker = await User.findOne({ id: message.author.id });

            // حساب الخسائر (الفرق بين القوات الأصلية والمتبقية)
            const lostSoldiers = (attackingForce.soldiers || 0) - (battleAttacker.soldiers || 0);
            const lostOfficers = (attackingForce.officers || 0) - (battleAttacker.officers || 0);
            const lostColonels = (attackingForce.colonels || 0) - (battleAttacker.colonels || 0);
            const lostGenerals = (attackingForce.generals || 0) - (battleAttacker.generals || 0);
            const lostLowMorale = (attackingForce.lowMoraleSoldiers || 0) - (battleAttacker.lowMoraleSoldiers || 0);

            // خصم الخسائر من المهاجم
            updatedAttacker.soldiers = Math.max(0, updatedAttacker.soldiers - lostSoldiers);
            updatedAttacker.officers = Math.max(0, updatedAttacker.officers - lostOfficers);
            updatedAttacker.colonels = Math.max(0, updatedAttacker.colonels - lostColonels);
            updatedAttacker.generals = Math.max(0, updatedAttacker.generals - lostGenerals);
            updatedAttacker.lowMoraleSoldiers = Math.max(0, updatedAttacker.lowMoraleSoldiers - lostLowMorale);

            await updatedAttacker.save();

            const retreatEmbed = new discord.EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('🏃‍♂️ انسحاب من المعركة!')
                .setDescription('تم سحب قواتك المتبقية من المعركة')
                .addFields(
                    { name: '💰 إجمالي العملات المكتسبة:', value: `${totalCoinsWon}` },
                    { name: '☠️ الخسائر:', value: 
                        `جنود: ${lostSoldiers}\n` +
                        `ضباط: ${lostOfficers}\n` +
                        `عقداء: ${lostColonels}\n` +
                        `لوائات: ${lostGenerals}\n` +
                        `ضعيفي الهمة: ${lostLowMorale}`
                    }
                )
                .setFooter({ text: 'تم الانسحاب بأمان!' });

            await message.channel.send({ embeds: [retreatEmbed] });
        } catch (error) {
            console.error('Error in endBattleWithRetreat:', error);
            message.channel.send('حدث خطأ أثناء الانسحاب من المعركة.');
        }
    };

    // في دالة endBattle
    const endBattle = async () => {
        try {
            const attackerAlive = Object.values(battleAttacker).some(count => count > 0);
            const defenderAlive = Object.values(battleDefender).some(count => count > 0);

            // تحديث قاعدة البيانات
            const updatedAttacker = await User.findOne({ id: message.author.id });
            const updatedOpponent = await User.findOne({ id: opponent.id });

            // حساب خسائر المهاجم
            const attackerLostSoldiers = (attackingForce.soldiers || 0) - (battleAttacker.soldiers || 0);
            const attackerLostOfficers = (attackingForce.officers || 0) - (battleAttacker.officers || 0);
            const attackerLostColonels = (attackingForce.colonels || 0) - (battleAttacker.colonels || 0);
            const attackerLostGenerals = (attackingForce.generals || 0) - (battleAttacker.generals || 0);
            const attackerLostLowMorale = (attackingForce.lowMoraleSoldiers || 0) - (battleAttacker.lowMoraleSoldiers || 0);

            // خصم خسائر المهاجم
            updatedAttacker.soldiers = Math.max(0, updatedAttacker.soldiers - attackerLostSoldiers);
            updatedAttacker.officers = Math.max(0, updatedAttacker.officers - attackerLostOfficers);
            updatedAttacker.colonels = Math.max(0, updatedAttacker.colonels - attackerLostColonels);
            updatedAttacker.generals = Math.max(0, updatedAttacker.generals - attackerLostGenerals);
            updatedAttacker.lowMoraleSoldiers = Math.max(0, updatedAttacker.lowMoraleSoldiers - attackerLostLowMorale);

            // تحديث قوات المدافع مباشرة (لا نضيف، فقط نحدد العدد المتبقي)
            updatedOpponent.soldiers = battleDefender.soldiers;
            updatedOpponent.officers = battleDefender.officers;
            updatedOpponent.colonels = battleDefender.colonels;
            updatedOpponent.generals = battleDefender.generals;
            updatedOpponent.lowMoraleSoldiers = battleDefender.lowMoraleSoldiers;
            updatedOpponent.lastDefeated = Date.now();

            // حفظ التغييرات
            await updatedAttacker.save();
            await updatedOpponent.save();

            // باقي الكود كما هو...
        } catch (error) {
            console.error('Error in endBattle:', error);
            message.channel.send('حدث خطأ أثناء إنهاء المعركة.');
        }
    };

    // Replace the setInterval for memory cleanup with this:
    setInterval(() => {
        const memUsage = process.memoryUsage();
        const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);

        if (memUsageMB > 200) {
            console.warn(`⚠️ High memory usage detected: ${memUsageMB}MB`);

            // Only call gc() if it exists
            if (typeof global.gc === 'function') {
                global.gc();
                console.log('🧹 Garbage collection triggered');
            }

            // Clean up old maps
            const now = Date.now();
            for (const [id, tracker] of requestTrackers.channels.entries()) {
                if (now - tracker.resetTime > 60000) {
                    requestTrackers.channels.delete(id);
                }
            }

            for (const [id, tracker] of requestTrackers.users.entries()) {
                if (now - tracker.resetTime > 120000) {
                    requestTrackers.users.delete(id);
                }
            }
        }
    }, 120000);
    if (message.author.id === CREDIT_BOT_ID) {
        try {
            const content = message.content;

            // البحث عن رسائل التحويل الناجحة - أنماط متعددة
            if ((content.includes('قام بتحويل') || content.includes('transferred') || content.includes('sent')) && 
                content.includes('$') && content.includes('لـ')) {
                console.log('رسالة التحويل من البروبوت:', content);

                // استخراج المبلغ من عدة أنماط مختلفة (باستخدام نفس منطق نظام الصرف الناجح)
                let transferredAmount = 0;
                console.log('نص الرسالة الكامل للتحليل:', content);

                // النمط الأول: `$X,XXX` أو `$XXXX` (مع العكس المائل - أعلى أولوية)
                let amountMatch = content.match(/`\$(\d+(?:,\d{3})*)`/);
                if (amountMatch) {
                    transferredAmount = parseInt(amountMatch[1].replace(/,/g, ''));
                    console.log('تم العثور على المبلغ بالنمط الأول (مع العكس):', transferredAmount);
                }

                // النمط الثاني: $XXXX (بدون عكس، أي عدد من الأرقام)
                if (!amountMatch || transferredAmount === 0) {
                    amountMatch = content.match(/\$(\d+)/);
                    if (amountMatch) {
                        transferredAmount = parseInt(amountMatch[1]);
                        console.log('تم العثور على المبلغ بالنمط الثاني (بدون عكس):', transferredAmount);
                    }
                }

                // النمط الثالث: $X,XXX (مع فواصل)
                if (!amountMatch || transferredAmount === 0) {
                    amountMatch = content.match(/\$(\d+(?:,\d{3})*)/);
                    if (amountMatch) {
                        transferredAmount = parseInt(amountMatch[1].replace(/,/g, ''));
                        console.log('تم العثور على المبلغ بالنمط الثالث (مع فواصل):', transferredAmount);
                    }
                }

                // النمط الرابع: البحث عن أي رقم كبير في الرسالة
                if (!amountMatch || transferredAmount === 0) {
                    const numberMatches = content.match(/(\d{3,})/g);
                    if (numberMatches) {
                        // أخذ أكبر رقم موجود في الرسالة
                        transferredAmount = Math.max(...numberMatches.map(num => parseInt(num.replace(/,/g, ''))));
                    }
                }

                if (!transferredAmount || transferredAmount === 0) {
                    console.log('لم يتم العثور على المبلغ في الرسالة');
                    console.log('محتوى الرسالة الكامل:', content);
                    return;
                }

                console.log('المبلغ المحول:', transferredAmount);

                // استخراج معرف المستقبل من أنماط متعددة
                let recipientId = null;

                // النمط الأول: لـ <@!معرف>
                let recipientMatch = content.match(/لـ\s*<@!?(\d{15,20})>/);
                if (recipientMatch) {
                    recipientId = recipientMatch[1];
                }

                // النمط الثاني: لـ @username مع معرف
                if (!recipientId) {
                    recipientMatch = content.match(/لـ\s*@[^<]*?(\d{15,20})/);
                    if (recipientMatch) {
                        recipientId = recipientMatch[1];
                    }
                }

                // النمط الثالث: البحث في النص عن معرف Discord
                if (!recipientId) {
                    const discordIdMatch = content.match(/(\d{15,20})/);
                    if (discordIdMatch) {
                        recipientId = discordIdMatch[1];
                    }
                }

                if (!recipientId) {
                    console.log('لم يتم العثور على معرف المستقبل في الرسالة');
                    console.log('النص الكامل للرسالة:', content);
                    return;
                }

                console.log('معرف المستقبل:', recipientId);

                // البحث عن المعاملة المعلقة المطابقة
                for (const [transactionId, transaction] of pendingTransactions.entries()) {
                    if (transaction.channelId === message.channel.id) {
                        console.log('فحص المعاملة:', transactionId, transaction);

                        let isMatching = false;

                        if (transaction.type === 'buy') {
                            // للشراء: التحقق من أن المستقبل هو الشخص المحدد
                            const originalAmount = transaction.creditsAmount;
                            const expectedAmountWithTax = calculateProBotTax(transaction.creditsAmount);

                            // تساهل أكبر في المقارنة للتعامل مع جميع الاختلافات
                            const tolerance = Math.max(50, Math.floor(Math.max(originalAmount, expectedAmountWithTax) * 0.1)); // 10% تساهل أو 50 كحد أدنى

                            // التحقق من المستقبل أولاً
                            const recipientMatches = recipientId === TRANSFER_RECIPIENT_ID;

                            // التحقق من المبلغ بطرق متعددة
                            const amountMatches = (
                                Math.abs(transferredAmount - originalAmount) <= tolerance ||
                                Math.abs(transferredAmount - expectedAmountWithTax) <= tolerance ||
                                transferredAmount === originalAmount ||
                                transferredAmount === expectedAmountWithTax ||
                                // التحقق من المبلغ بدون ضريبة (في حالة كان البروبوت لا يحسب الضريبة)
                                Math.abs(transferredAmount - Math.floor(originalAmount * 0.95)) <= tolerance ||
                                // التحقق من المبلغ مع ضريبة مختلفة
                                Math.abs(transferredAmount - Math.floor(originalAmount * 1.05)) <= tolerance
                            );

                            isMatching = recipientMatches && amountMatches;

                            console.log('فحص الشراء - المستقبل المتوقع:', TRANSFER_RECIPIENT_ID, 'المستقبل الفعلي:', recipientId, 'مطابق المستقبل:', recipientMatches);
                            console.log('المبلغ الأصلي:', originalAmount, 'المبلغ مع الضريبة:', expectedAmountWithTax, 'المبلغ المحول:', transferredAmount, 'مطابق المبلغ:', amountMatches);
                            console.log('النتيجة النهائية:', isMatching);
                        } else if (transaction.type === 'sell') {
                            // للصرف: التحقق من أن المستقبل هو المستخدم الصحيح
                            const originalAmount = transaction.creditsAmount; // المبلغ الصافي
                            const expectedAmountWithTax = transaction.creditsWithTax || calculateProBotTax(transaction.creditsAmount); // المبلغ مع الضريبة
                            const tolerance = Math.max(50, Math.floor(Math.max(originalAmount, expectedAmountWithTax) * 0.1)); // 10% تساهل أو 50 كحد أدنى

                            const recipientMatches = recipientId === transaction.userId;
                            const amountMatches = (
                                Math.abs(transferredAmount - originalAmount) <= tolerance ||
                                Math.abs(transferredAmount - expectedAmountWithTax) <= tolerance ||
                                transferredAmount === originalAmount ||
                                transferredAmount === expectedAmountWithTax
                            );

                            isMatching = recipientMatches && amountMatches;

                            console.log('فحص الصرف - المستقبل المتوقع:', transaction.userId, 'المستقبل الفعلي:', recipientId, 'مطابق المستقبل:', recipientMatches);
                            console.log('المبلغ الصافي:', originalAmount, 'المبلغ مع الضريبة:', expectedAmountWithTax, 'المبلغ المحول:', transferredAmount, 'مطابق المبلغ:', amountMatches);
                            console.log('النتيجة النهائية:', isMatching);
                        }

                        if (isMatching) {
                            console.log('تم العثور على معاملة مطابقة!');

                            if (transaction.type === 'buy') {
                                // إضافة العملات للاعب
                                const user = await User.findOne({ id: transaction.userId });
                                if (user) {
                                    user.coins += transaction.coinsAmount;
                                    await user.save();

                                    const successEmbed = new discord.EmbedBuilder()
                                        .setColor('#00FF00')
                                        .setTitle('✅ تمت عملية الشراء بنجاح!')
                                        .setDescription(`تم إضافة ${transaction.coinsAmount.toLocaleString()} عملة إلى حسابك.`)
                                        .addFields(
                                            { name: '💰 المبلغ المحول:', value: `${transferredAmount.toLocaleString()} كريدت`, inline: true },
                                            { name: '🪙 العملات المضافة:', value: `${transaction.coinsAmount.toLocaleString()} عملة`, inline: true },
                                            { name: '💎 إجمالي عملاتك:', value: `${user.coins.toLocaleString()} عملة`, inline: true },
                                            { name: '📊 معرف المعاملة:', value: transactionId, inline: true }
                                        )
                                        .setFooter({ text: 'شكراً لك على استخدام خدماتنا! • ' + new Date().toLocaleString('ar-SA') });

                                    await message.channel.send({ embeds: [successEmbed] });
                                    console.log(`✅ تم إضافة ${transaction.coinsAmount} عملة للاعب ${transaction.userId} بنجاح - معرف المعاملة: ${transactionId}`);

                                    // إرسال رسالة خاصة للمستخدم
                                    try {
                                        const buyer = await client.users.fetch(transaction.userId);
                                        await buyer.send({ embeds: [successEmbed] });
                                        console.log(`✅ تم إرسال رسالة خاصة للمشتري ${transaction.userId}`);
                                    } catch (error) {
                                        console.error('❌ خطأ في إرسال رسالة خاصة للمشتري:', error);
                                    }
                                } else {
                                    console.error(`❌ لم يتم العثور على المستخدم ${transaction.userId} في قاعدة البيانات`);
                                }
                            } else if (transaction.type === 'sell') {
                                // خصم العملات من اللاعب
                                const user = await User.findOne({ id: transaction.userId });
                                if (user && user.coins >= transaction.coinsAmount) {
                                    user.coins -= transaction.coinsAmount;
                                    await user.save();

                                    const successEmbed = new discord.EmbedBuilder()
                                        .setColor('#00FF00')
                                        .setTitle('✅ تمت عملية الصرف بنجاح!')
                                        .setDescription(`تم خصم ${transaction.coinsAmount.toLocaleString()} عملة من حسابك وتحويل ${transferredAmount.toLocaleString()} كريدت إليك.`)
                                        .addFields(
                                            { name: '🪙 العملات المخصومة:', value: `${transaction.coinsAmount.toLocaleString()} عملة`, inline: true },
                                            { name: '💰 الكريدت المستلم:', value: `${transferredAmount.toLocaleString()} كريدت`, inline: true },
                                            { name: '💎 عملاتك المتبقية:', value: `${user.coins.toLocaleString()} عملة`, inline: true }
                                        )
                                        .setFooter({ text: 'شكراً لك على استخدام خدماتنا! • ' + new Date().toLocaleString('ar-SA') });

                                    await message.channel.send({ embeds: [successEmbed] });
                                    console.log(`تم خصم ${transaction.coinsAmount} عملة من اللاعب ${transaction.userId} بنجاح`);

                                    // إرسال رسالة خاصة للمستخدم
                                    try {
                                        const seller = await client.users.fetch(transaction.userId);
                                        await seller.send({ embeds: [successEmbed] });
                                    } catch (error) {
                                        console.error('Error sending DM to seller:', error);
                                    }
                                }
                            }

                            // إزالة المعاملة من القائمة المعلقة
                            pendingTransactions.delete(transactionId);
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error processing credit bot message:', error);
        }
    }

    const messageContent = message.content.toLowerCase();

    // Check for the specific obfuscated pattern
    if (messageContent.includes('<htt') && 
        messageContent.includes('ps:/') && 
        messageContent.includes('/%64%69%73%63%6f%72%64%2e%67%67')) { 
        if (message.member.permissions.has('Administartor') && 
    message.member.permissions.has('ManageChannels')) return;

      message.delete();
            }
    if (message.content.includes("<https://%64%69%73%63%6f%72%64%2e%67%67/>")) {
        message.delete()
        }
    // أمر عرض البوتات
if (message.content === '!البوتات') {
    try {
        // إرسال رسالة مؤقتة للإنتظار
        const loadingMessage = await message.channel.send('⏳ جاري تحميل قائمة البوتات...');

        // تحميل جميع أعضاء السيرفر
        await message.guild.members.fetch({ force: true })
            .catch(err => console.error('خطأ في تحميل الأعضاء:', err));

        // الحصول على جميع البوتات بعد تحميل الأعضاء
        const bots = message.guild.members.cache.filter(member => member.user.bot);

        if (bots.size === 0) {
            await loadingMessage.delete();
            return message.reply('لا يوجد بوتات في هذا السيرفر.');
        }

        // إنشاء Embed لعرض معلومات البوتات
        const botsEmbed = new discord.EmbedBuilder()
            .setColor('#00FFFF')
            .setTitle(`البوتات في ${message.guild.name}`)
            .setDescription(`إجمالي عدد البوتات: ${bots.size}`)
            .setTimestamp();

        // تقسيم البوتات إلى مجموعات من 10 لكل حقل
        const botsArray = Array.from(bots.values());
        const chunkedBots = [];
        while (botsArray.length) {
            chunkedBots.push(botsArray.splice(0, 10));
        }

        // إضافة حقول للـ Embed
        chunkedBots.forEach((chunk, index) => {
            let fieldContent = '';
            chunk.forEach(bot => {
                const joinDate = bot.joinedAt.toISOString().split('T')[0];
                fieldContent += `🤖 **${bot.user.tag}**\n` +
                              `📅 تاريخ الدخول: ${joinDate}\n` +
                              `🏷️ أعلى رتبة: ${bot.roles.highest.name}\n` +
                              `🆔 ID: ${bot.user.id}\n\n`;
            });

            botsEmbed.addFields({
                name: `قائمة البوتات ${index + 1}`,
                value: fieldContent,
                inline: false
            });
        });

        // إضافة معلومات في التذييل
        botsEmbed.setFooter({
            text: `تم الطلب بواسطة ${message.author.tag} | إجمالي البوتات: ${bots.size}`,
            iconURL: message.author.displayAvatarURL({ dynamic: true })
        });

        // أزرار التحكم
        const row = new discord.ActionRowBuilder()
            .addComponents(
                new discord.ButtonBuilder()
                    .setCustomId('refresh_bots')
                    .setLabel('تحديث القائمة')
                    .setStyle(discord.ButtonStyle.Primary)
                    .setEmoji('🔄'),
                new discord.ButtonBuilder()
                    .setCustomId('online_bots')
                    .setLabel('البوتات المتصلة')
                    .setStyle(discord.ButtonStyle.Success)
                    .setEmoji('🟢'),
                new discord.ButtonBuilder()
                    .setCustomId('offline_bots')
                    .setLabel('البوتات غير المتصلة')
                    .setStyle(discord.ButtonStyle.Secondary)
                    .setEmoji('⚫')
            );

        // حذف رسالة التحميل وإرسال النتائج
        await loadingMessage.delete();
        const botListMessage = await message.channel.send({
            embeds: [botsEmbed],
            components: [row]
        });

        // معالج الأزرار
        const filter = i => i.user.id === message.author.id;
        const collector = botListMessage.createMessageComponentCollector({
            filter,
            time: 120000 // دقيقتين
        });

        collector.on('collect', async i => {
            // تحميل الأعضاء مرة أخرى عند الضغط على زر التحديث
            if (i.customId === 'refresh_bots') {
                await i.deferUpdate();
                await message.guild.members.fetch({ force: true });
                const updatedBots = message.guild.members.cache.filter(member => member.user.bot);
                const updatedEmbed = new discord.EmbedBuilder(botsEmbed.data)
                    .setDescription(`إجمالي عدد البوتات: ${updatedBots.size}`)
                    .setTimestamp()
                    .setFields([]); // مسح الحقول القديمة

                const updatedBotsArray = Array.from(updatedBots.values());
                const updatedChunkedBots = [];
                while (updatedBotsArray.length) {
                    updatedChunkedBots.push(updatedBotsArray.splice(0, 10));
                }

                updatedChunkedBots.forEach((chunk, index) => {
                    let fieldContent = '';
                    chunk.forEach(bot => {
                        const joinDate = bot.joinedAt.toISOString().split('T')[0];
                        fieldContent += `🤖 **${bot.user.tag}**\n` +
                                      `📅 تاريخ الدخول: ${joinDate}\n` +
                                      `🏷️ أعلى رتبة: ${bot.roles.highest.name}\n` +
                                      `🆔 ID: ${bot.user.id}\n\n`;
                    });

                    updatedEmbed.addFields({
                        name: `قائمة البوتات ${index + 1}`,
                        value: fieldContent,
                        inline: false
                    });
                });

                await i.editReply({ embeds: [updatedEmbed] });
            } else if (i.customId === 'force_cleanup') {
                await i.deferReply();

                try {
                    await performPreventiveCleanup();
                    const newSize = await checkDatabaseSize();

                    const successEmbed = new discord.EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('✅ تم التنظيف الفوري')
                        .setDescription(`تم تنظيف قاعدة البيانات بنجاح. الحجم الحالي: ${newSize}MB`)
                        .setTimestamp();

                    await i.editReply({ embeds: [successEmbed] });
                } catch (error) {
                    console.error('Error in force cleanup:', error);
                    await i.editReply('❌ حدث خطأ أثناء التنظيف الفوري.');
                }

            } else if (i.customId === 'deep_cleanup') {
                await i.deferReply();

                try {
                    const { performDeepCleanup } = require('./database-manager');
                    await performDeepCleanup();
                    await cleanupSystemMemory();
                    const newSize = await checkDatabaseSize();

                    const successEmbed = new discord.EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('🔧 تم التنظيف الشامل')
                        .setDescription(`تم تنظيف قاعدة البيانات بشكل شامل. الحجم الحالي: ${newSize}MB`)
                        .setTimestamp();

                    await i.editReply({ embeds: [successEmbed] });
                } catch (error) {
                    console.error('Error in deep cleanup:', error);
                    await i.editReply('❌ حدث خطأ أثناء التنظيف الشامل.');
                }

            } else if (i.customId === 'emergency_cleanup') {
                await i.deferReply();

                try {
                    await performEmergencyCleanup();
                    const newSize = await checkDatabaseSize();

                    const successEmbed = new discord.EmbedBuilder()
                        .setColor('#ff6600')
                        .setTitle('🚨 تم التنظيف الطارئ')
                        .setDescription(`تم تنظيف قاعدة البيانات في حالة الطوارئ. الحجم الحالي: ${newSize}MB`)
                        .setTimestamp();

                    await i.editReply({ embeds: [successEmbed] });
                } catch (error) {
                    console.error('Error in emergency cleanup:', error);
                    await i.editReply('❌ حدث خطأ أثناء التنظيف الطارئ.');
                }

            } else if (i.customId === 'online_bots' || i.customId === 'offline_bots') {
                await i.deferUpdate();
                const status = i.customId === 'online_bots' ? 'online' : 'offline';
                const filteredBots = message.guild.members.cache.filter(
                    member => member.user.bot && 
                    (status === 'online' ? member.presence?.status !== 'offline' : member.presence?.status === 'offline')
                );

                const statusEmbed = new discord.EmbedBuilder()
                    .setColor(status === 'online' ? '#00FF00' : '#808080')
                    .setTitle(`البوتات ${status === 'online' ? 'المتصلة' : 'غير المتصلة'} في ${message.guild.name}`)
                    .setDescription(`إجمالي العدد: ${filteredBots.size}`)
                    .setTimestamp();

                const filteredBotsArray = Array.from(filteredBots.values());
                const filteredChunkedBots = [];
                while (filteredBotsArray.length) {
                    filteredChunkedBots.push(filteredBotsArray.splice(0, 10));
                }

                filteredChunkedBots.forEach((chunk, index) => {
                    let fieldContent = '';
                    chunk.forEach(bot => {
                        const joinDate = bot.joinedAt.toISOString().split('T')[0];
                        fieldContent += `🤖 **${bot.user.tag}**\n` +
                                      `📅 تاريخ الدخول: ${joinDate}\n` +
                                      `🏷️ أعلى رتبة: ${bot.roles.highest.name}\n` +
                                      `🆔 ID: ${bot.user.id}\n\n`;
                    });

                    statusEmbed.addFields({
                        name: `قائمة البوتات ${index + 1}`,
                        value: fieldContent || 'لا يوجد بوتات',
                        inline: false
                    });
                });

                await i.editReply({ embeds: [statusEmbed] });
            }
        });

        collector.on('end', () => {
            const disabledRow = new discord.ActionRowBuilder()
                .addComponents(
                    new discord.ButtonBuilder()
                        .setCustomId('refresh_bots')
                        .setLabel('تحديث القائمة')
                        .setStyle(discord.ButtonStyle.Primary)
                        .setEmoji('🔄')
                        .setDisabled(true),
                    new discord.ButtonBuilder()
                        .setCustomId('online_bots')
                        .setLabel('البوتات المتصلة')
                        .setStyle(discord.ButtonStyle.Success)
                        .setEmoji('🟢')
                        .setDisabled(true),
                    new discord.ButtonBuilder()
                        .setCustomId('offline_bots')
                        .setLabel('البوتات غير المتصلة')
                        .setStyle(discord.ButtonStyle.Secondary)
                        .setEmoji('⚫')
                        .setDisabled(true)
                );

            botListMessage.edit({ components: [disabledRow] }).catch(console.error);
        });

    } catch (error) {
        console.error('Error in !البوتات command:', error);
        message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
    }
}

    // أمر طرد البوتات
if (message.content === '!قج_البوتات') {
    try {
        // التحقق من صلاحيات المستخدم
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
        }

        // التحقق من صلاحيات البوت
        if (!message.guild.members.me.permissions.has('KickMembers')) {
            return message.reply('عذراً، لا أملك صلاحية طرد الأعضاء.');
        }

        // الحصول على رتبة البوت
        const botRole = message.guild.members.me.roles.highest;

        // إنشاء Embed للتأكيد
        const confirmEmbed = new discord.EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('تأكيد طرد البوتات')
            .setDescription('هل أنت متأكد أنك تريد طرد جميع البوتات التي رتبتها أقل من رتبة البوت؟')
            .setFooter({ text: 'اضغط على "تأكيد" للمتابعة أو "إلغاء" للإلغاء.' });

        const row = new discord.ActionRowBuilder()
            .addComponents(
                new discord.ButtonBuilder()
                    .setCustomId('confirm_kick')
                    .setLabel('تأكيد')
                    .setStyle(discord.ButtonStyle.Danger),
                new discord.ButtonBuilder()
                    .setCustomId('cancel_kick')
                    .setLabel('إلغاء')
                    .setStyle(discord.ButtonStyle.Secondary)
            );

        const confirmMsg = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

        const filter = i => i.user.id === message.author.id;
        const collector = confirmMsg.createMessageComponentCollector({ filter, time: 30000 });

        collector.on('collect', async i => {
            if (i.customId === 'confirm_kick') {
                try {
                    let kickedCount = 0;
                    let failedCount = 0;
                    const bots = message.guild.members.cache.filter(member => member.user.bot && member.roles.highest.position < botRole.position);

                    for (const [, bot] of bots) {
                        try {
                            if (bot.kickable) {
                                await bot.kick('تم الطرد بواسطة أمر طرد البوتات');
                                kickedCount++;
                            } else {
                                failedCount++;
                            }
                        } catch {
                            failedCount++;
                        }
                    }

                    const resultEmbed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('نتيجة طرد البوتات')
                        .addFields(
                            { name: 'تم طرد:', value: `${kickedCount} بوت` },
                            { name: 'فشل طرد:', value: `${failedCount} بوت` }
                        );

                    await i.update({ embeds: [resultEmbed], components: [] });
                } catch (error) {
                    console.error('Error kicking bots:', error);
                    await i.update({ content: 'حدث خطأ أثناء طرد البوتات.', components: [] });
                }
            } else if (i.customId === 'cancel_kick') {
                await i.update({ content: 'تم إلغاء عملية طرد البوتات.', components: [], embeds: [] });
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                confirmMsg.edit({ content: 'انتهى وقت التأكيد.', components: [], embeds: [] });
            }
        });
    } catch (error) {
        console.error('Error in !طردالبوتات command:', error);
        message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
    }
}
    // Add this command with your other message handling code
if (message.content === '!تصفير_الكل') {
    try {
        // Check if user has Administrator permission
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
        }

        // Create confirmation embed
        const confirmEmbed = new discord.EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('تأكيد تصفير جميع البيانات')
            .setDescription('هل أنت متأكد أنك تريد تصفير بيانات جميع اللاعبين؟\nهذا سيؤدي إلى حذف جميع الجنود والعملات والممتلكات لجميع اللاعبين.')
            .setFooter({ text: 'اضغط على "تأكيد" للمتابعة أو "إلغاء" للإلغاء.' });

        const row = new discord.ActionRowBuilder()
            .addComponents(
                new discord.ButtonBuilder()
                    .setCustomId('confirm_reset')
                    .setLabel('تأكيد')
                    .setStyle(discord.ButtonStyle.Danger),
                new discord.ButtonBuilder()
                    .setCustomId('cancel_reset')
                    .setLabel('إلغاء')
                    .setStyle(discord.ButtonStyle.Secondary)
            );

        const confirmMsg = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

        const filter = i => i.user.id === message.author.id;
        const collector = confirmMsg.createMessageComponentCollector({ filter, time: 30000 });

        collector.on('collect', async i => {
            if (i.customId === 'confirm_reset') {
                try {
                    // حذف جميع التحالفات أولاً
                    console.log('🗑️ حذف جميع التحالفات...');
                    const allAlliances = await Alliance.find();

                    // حذف رتب التحالفات من جميع السيرفرات
                    for (const alliance of allAlliances) {
                        if (alliance.role_id) {
                            try {
                                for (const guild of client.guilds.cache.values()) {
                                    try {
                                        const role = await guild.roles.fetch(alliance.role_id);
                                        if (role) {
                                            await role.delete('تصفير شامل للبيانات');
                                            console.log(`✅ حذف رتبة التحالف: ${alliance.name}`);
                                            break;
                                        }
                                    } catch (roleError) {
                                        continue;
                                    }
                                }
                            } catch (error) {
                                console.error(`خطأ في حذف رتبة التحالف ${alliance.name}:`, error);
                            }
                        }
                    }

                    // حذف جميع التحالفات وطلبات الانضمام
                    await Alliance.deleteMany({});
                    await AllianceRequest.deleteMany({});

                    // Delete all user data
                    await User.deleteMany({});
                    await UserItem.deleteMany({});

                    const successEmbed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('تم التصفير بنجاح')
                        .setDescription('تم تصفير بيانات جميع اللاعبين بنجاح.')
                        .setFooter({ text: 'يمكن للاعبين البدء من جديد باستخدام أمر !البدء' });

                    await i.update({ embeds: [successEmbed], components: [] });
                } catch (error) {
                    console.error('Error resetting data:', error);
                    await i.update({ content: 'حدث خطأ أثناء تصفير البيانات. يرجى المحاولة مرة أخرى.', components: [] });
                }
            } else if (i.customId === 'cancel_reset') {
                await i.update({ content: 'تم إلغاء عملية التصفير.', components: [], embeds: [] });
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                confirmMsg.edit({ content: 'انتهى وقت التأكيد. تم إلغاء عملية التصفير.', components: [], embeds: [] });
            }
        });
    } catch (error) {
        console.error('Error in !تصفير_الكل command:', error);
        message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
    }
}
    if (message.author.bot) return;

    if (bad.some(wrd => message.content.startsWith(wrd))) {
        if (message.member.permissions.has('Administrator')) return;
        try {
        message.delete();
    } catch (error) {
        console.log(error);
        }
        }




    if (message.content === 'خط') {
        try {
        message.delete();
        } catch (error) {
            message.reply("خطا", error);
        }
        }

    try {
        // التحقق من أن الرسالة تبدأ بأمر
        const commands = ['!اضافة_عملات', '!تصفير', '!توب', '!البدء', '!غارة', '!هجوم', '!p', '!شراء', '!مخزون', '!قصف', '!تدريب', '!تحالف', '!انضمام', '!قبول', '!رفض', '!الطلبات', '!طرد', '!ترقية', '!تخفيض', '!اعطاء', '!حرب', '!سلام', '!مقبول', '!التحالفات', '!العلاقات', '!الاعضاء', '!خروج', '!حذف', '!ازالة', '!ازالة_الكل', '!راتب', '!تسريح', '!جمع', '!تذكرة', '!del', '!اجمالي', '!rem', '!الاقتصاد', '!شرح', '!تحويل_المخزون'];
        const isCommand = commands.some(cmd => message.content.startsWith(cmd));

        if (!isCommand) return;

        // التحقق من الكولداون والحماية من rate limiting
        const remainingCooldown = checkCooldown(message.author.id);
        if (remainingCooldown > 0) {
            const secondsLeft = (remainingCooldown / 1000).toFixed(1);

            // استخدام النظام الآمن للرد
            return safeExecute(
                () => message.reply(`الرجاء الانتظار ${secondsLeft} ثواني قبل استخدام الأمر مرة أخرى.`),
                { 
                    type: 'channel', 
                    identifier: message.channel.id, 
                    priority: 'low' 
                }
            ).catch(console.error);
        }

        // فحص rate limiting للمستخدم والقناة
        const userRateLimit = checkRateLimit('user', message.author.id, RATE_LIMIT_CONFIG.USER);
        const channelRateLimit = checkRateLimit('channel', message.channel.id, RATE_LIMIT_CONFIG.CHANNEL);

        if (!userRateLimit.allowed || !channelRateLimit.allowed) {
            const maxWaitTime = Math.max(userRateLimit.waitTime || 0, channelRateLimit.waitTime || 0);

            if (maxWaitTime > 30000) { // إذا كان الانتظار أكثر من 30 ثانية، تجاهل الطلب
                console.warn(`Dropping request from ${message.author.tag} due to high wait time: ${maxWaitTime}ms`);
                return;
            }

            // تأخير معالجة الأمر
            setTimeout(() => {
                // إعادة معالجة الأمر بعد التأخير
                processCommand(message);
            }, Math.min(maxWaitTime, 10000)); // حد أقصى 10 ثوان انتظار

            return;
        }
        // أمر إنشاء التحالف
        if (message.content.startsWith('!تحالف')) {
            try {
                if (!PublicCategory.includes(message.channel.parentId)) {
                    return message.reply('هذا الأمر متاح فقط في القنوات العامة.');
                }
                const user = await User.findOne({ id: message.author.id });
                if (!user) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

                if (user.alliance_id) return message.reply('أنت بالفعل عضو في تحالف!');

                const allianceName = message.content.split(' ').slice(1).join(' ');
                if (!allianceName) return message.reply('يجب عليك تحديد اسم للتحالف.');

                if (user.coins < 1000000) {
                    return message.reply('تحتاج إلى مليون عملة لإنشاء تحالف. عملاتك الحالية: ' + user.coins);
                }

                // التحقق من عدم وجود تحالف بنفس الاسم
                const existingAlliance = await Alliance.findOne({ name: allianceName });
                if (existingAlliance) {
                    return message.reply('يوجد تحالف بهذا الاسم بالفعل. يرجى اختيار اسم آخر.');
                }

                // إنشاء رسالة تأكيد
                const confirmEmbed = new discord.EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('تأكيد إنشاء التحالف')
                    .setDescription(`هل أنت متأكد من إنشاء تحالف "${allianceName}"؟`)
                    .addFields(
                        { name: 'اسم التحالف:', value: allianceName },
                        { name: 'التكلفة:', value: '1,000,000 عملة' },
                        { name: 'عملاتك الحالية:', value: user.coins.toString() },
                        { name: 'ملاحظة:', value: 'سيتم إنشاء رتبة خاصة بالتحالف وإعطاؤها لك' }
                    )
                    .setFooter({ text: 'اضغط على "تأكيد" للمتابعة أو "إلغاء" للإلغاء.' });

                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('confirm_alliance')
                            .setLabel('تأكيد')
                            .setStyle(discord.ButtonStyle.Success),
                        new discord.ButtonBuilder()
                            .setCustomId('cancel_alliance')
                            .setLabel('إلغاء')
                            .setStyle(discord.ButtonStyle.Danger)
                    );

                const confirmMessage = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

                const filter = i => i.user.id === message.author.id;
                const collector = confirmMessage.createMessageComponentCollector({ filter, time: 30000 });

                collector.on('collect', async i => {
                    if (i.customId === 'confirm_alliance') {
                        try {
                            // التحقق مرة أخرى من العملات قبل الإنشاء
                            const updatedUser = await User.findOne({ id: message.author.id });
                            if (updatedUser.coins < 1000000) {
                                await i.update({ 
                                    content: 'عذراً، لا تملك العملات الكافية لإنشاء التحالف.',
                                    embeds: [],
                                    components: []
                                });
                                return;
                            }

                            // التحقق مرة أخرى من عدم وجود تحالف بنفس الاسم
                            const existingAlliance = await Alliance.findOne({ name: allianceName });
                            if (existingAlliance) {
                                await i.update({ 
                                    content: 'عذراً، تم إنشاء تحالف بهذا الاسم بالفعل من قبل شخص آخر.',
                                    embeds: [],
                                    components: []
                                });
                                return;
                            }

                            // إنشاء رتبة التحالف
                            let allianceRole = null;
                            try {
                                allianceRole = await message.guild.roles.create({
                                    name: `⚔️ ${allianceName}`,
                                    color: '#1E90FF',
                                    permissions: [],
                                    reason: `إنشاء رتبة تحالف: ${allianceName}`
                                });
                                console.log(`تم إنشاء رتبة التحالف: ${allianceRole.name} - ID: ${allianceRole.id}`);
                            } catch (roleError) {
                                console.error('خطأ في إنشاء رتبة التحالف:', roleError);
                                await i.update({ 
                                    content: 'حدث خطأ أثناء إنشاء رتبة التحالف. تأكد من أن البوت لديه صلاحيات إدارة الرتب.',
                                    embeds: [],
                                    components: []
                                });
                                return;
                            }

                            const allianceId = Date.now().toString();
                            const newAlliance = new Alliance({
                                id: allianceId,
                                name: allianceName,
                                leader_id: message.author.id,
                                members: [message.author.id],
                                role_id: allianceRole.id
                            });

                            await newAlliance.save();

                            updatedUser.coins -= 1000000;
                            updatedUser.alliance_id = allianceId;
                            updatedUser.alliance_rank = 'قائد التحالف';
                            await updatedUser.save();

                            // إعطاء الرتبة للقائد
                            try {
                                const member = await message.guild.members.fetch(message.author.id);
                                await member.roles.add(allianceRole.id);
                                console.log(`تم إعطاء رتبة التحالف للقائد: ${message.author.username}`);
                            } catch (addRoleError) {
                                console.error('خطأ في إعطاء الرتبة للقائد:', addRoleError);
                            }

                            const successEmbed = new discord.EmbedBuilder()
                                .setColor('#00FF00')
                                .setTitle('تم إنشاء التحالف بنجاح!')
                                .setDescription(`تم إنشاء تحالف "${allianceName}" بنجاح!`)
                                .addFields(
                                    { name: 'اسم التحالف:', value: allianceName },
                                    { name: 'القائد:', value: message.author.username },
                                    { name: 'التكلفة:', value: '1,000,000 عملة' },
                                    { name: 'عملاتك المتبقية:', value: (updatedUser.coins).toString() },
                                    { name: 'رتبة التحالف:', value: `${allianceRole}` }
                                )
                                .setFooter({ text: 'يمكنك الآن دعوة أعضاء جدد للتحالف!' });

                            await i.update({ embeds: [successEmbed], components: [] });
                        } catch (error) {
                            console.error('Error creating alliance:', error);
                            await i.update({ 
                                content: 'حدث خطأ أثناء إنشاء التحالف. يرجى المحاولة مرة أخرى.',
                                embeds: [],
                                components: []
                            });
                        }
                    } else if (i.customId === 'cancel_alliance') {
                        await i.update({ 
                            content: 'تم إلغاء إنشاء التحالف.',
                            embeds: [],
                            components: []
                        });
                    }
                });

                collector.on('end', collected => {
                    if (collected.size === 0) {
                        confirmMessage.edit({ 
                            content: 'انتهى وقت التأكيد. تم إلغاء إنشاء التحالف.',
                            embeds: [],
                            components: []
                        }).catch(console.error);
                    }
                });
            } catch (error) {
                console.error('Error in !تحالف command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر الانضمام للتحالف
        if (message.content.startsWith('!انضمام')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

                if (user.alliance_id) return message.reply('أنت بالفعل عضو في تحالف!');

                const allianceName = message.content.split(' ').slice(1).join(' ');
                if (!allianceName) return message.reply('يجب تحديد اسم التحالف الذي تريد الانضمام إليه.');

                const alliance = await Alliance.findOne({ name: allianceName });
                if (!alliance) return message.reply('لم يتم العثور على تحالف بهذا الاسم.');

                const existingRequest = await AllianceRequest.findOne({ 
                    user_id: message.author.id, 
                    alliance_id: alliance.id 
                });
                if (existingRequest) return message.reply('لقد أرسلت طلب انضمام بالفعل لهذا التحالف.');

                const newRequest = new AllianceRequest({
                    user_id: message.author.id,
                    user_name: message.author.username,
                    alliance_id: alliance.id
                });
                await newRequest.save();

                // إرسال رسالة لقائد التحالف والمشرفين
                const allianceMembers = await User.find({ 
                    alliance_id: alliance.id, 
                    alliance_rank: { $in: ['قائد التحالف', 'مشرف التحالف'] } 
                });

                for (const member of allianceMembers) {
                    try {
                        const memberUser = await client.users.fetch(member.id);
                        const embed = new discord.EmbedBuilder()
                            .setColor('#00FF00')
                            .setTitle('طلب انضمام جديد')
                            .setDescription(`يريد ${message.author.username} الانضمام إلى تحالف "${alliance.name}"`)
                            .addFields(
                                { name: 'اسم اللاعب:', value: message.author.username },
                                { name: 'معرف المستخدم:', value: message.author.id },
                                { name: 'التحالف:', value: alliance.name }
                            )
                            .setFooter({ text: 'استخدم !قبول أو !رفض لمعالجة الطلب' });

                        await memberUser.send({ embeds: [embed] });
                    } catch (error) {
                        console.error('Error sending DM:', error);
                    }
                }

                message.reply(`تم إرسال طلب الانضمام إلى تحالف "${alliance.name}" بنجاح!`);
            } catch (error) {
                console.error('Error in !انضمام command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر قبول طلب الانضمام
        if (message.content.startsWith('!قبول')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (!['قائد التحالف', 'مشرف التحالف'].includes(user.alliance_rank)) {
                    return message.reply('ليس لديك صلاحية لقبول طلبات الانضمام.');
                }

                const targetUser = message.mentions.users.first();
                if (!targetUser) return message.reply('يجب تحديد المستخدم المراد قبوله.');

                const request = await AllianceRequest.findOne({ 
                    user_id: targetUser.id, 
                    alliance_id: user.alliance_id 
                });
                if (!request) return message.reply('لا يوجد طلب انضمام من هذا المستخدم.');

                const targetUserData = await User.findOne({ id: targetUser.id });
                if (!targetUserData) return message.reply('لم يتم العثور على بيانات هذا المستخدم.');

                if (targetUserData.alliance_id) return message.reply('هذا المستخدم عضو في تحالف آخر بالفعل.');

                // قبول الطلب
                targetUserData.alliance_id = user.alliance_id;
                targetUserData.alliance_rank = 'عضو';
                await targetUserData.save();

                const alliance = await Alliance.findOne({ id: user.alliance_id });
                alliance.members.push(targetUser.id);
                await alliance.save();

                await AllianceRequest.deleteOne({ _id: request._id });

                // إعطاء رتبة التحالف للعضو الجديد
                if (alliance.role_id) {
                    try {
                        const member = await message.guild.members.fetch(targetUser.id);
                        await member.roles.add(alliance.role_id);
                        console.log(`تم إعطاء رتبة التحالف للعضو الجديد: ${targetUser.username}`);
                    } catch (roleError) {
                        console.error('خطأ في إعطاء رتبة التحالف للعضو الجديد:', roleError);
                    }
                }

                message.reply(`تم قبول ${targetUser.username} في التحالف بنجاح!`);

                // إرسال رسالة للعضو الجديد
                try {
                    const embed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('تم قبولك في التحالف!')
                        .setDescription(`تم قبولك في تحالف "${alliance.name}"`)
                        .setFooter({ text: 'مرحباً بك في التحالف!' });

                    await targetUser.send({ embeds: [embed] });
                } catch (error) {
                    console.error('Error sending acceptance DM:', error);
                }
            } catch (error) {
                console.error('Error in !قبول command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر رفض طلب الانضمام
        if (message.content.startsWith('!رفض')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (!['قائد التحالف', 'مشرف التحالف'].includes(user.alliance_rank)) {
                    return message.reply('ليس لديك صلاحية لرفض طلبات الانضمام.');
                }

                const targetUser = message.mentions.users.first();
                if (!targetUser) return message.reply('يجب تحديد المستخدم المراد رفضه.');

                const request = await AllianceRequest.findOne({ 
                    user_id: targetUser.id, 
                    alliance_id: user.alliance_id 
                });
                if (!request) return message.reply('لا يوجد طلب انضمام من هذا المستخدم.');

                await AllianceRequest.deleteOne({ _id: request._id });

                message.reply(`تم رفض طلب ${targetUser.username} للانضمام للتحالف.`);

                // إرسال رسالة للمستخدم المرفوض
                try {
                    const alliance = await Alliance.findOne({ id: user.alliance_id });
                    const embed = new discord.EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('تم رفض طلبك')
                        .setDescription(`تم رفض طلبك للانضمام إلى تحالف "${alliance.name}"`)
                        .setFooter({ text: 'يمكنك المحاولة مع تحالفات أخرى' });

                    await targetUser.send({ embeds: [embed] });
                } catch (error) {
                    console.error('Error sending rejection DM:', error);
                }
            } catch (error) {
                console.error('Error in !رفض command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر عرض الطلبات
        if (message.content.startsWith('!الطلبات')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (!['قائد التحالف', 'مشرف التحالف'].includes(user.alliance_rank)) {
                    return message.reply('ليس لديك صلاحية لعرض طلبات الانضمام.');
                }

                const requests = await AllianceRequest.find({ alliance_id: user.alliance_id });
                if (requests.length === 0) return message.reply('لا توجد طلبات انضمام حالياً.');

                const embed = new discord.EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('طلبات الانضمام')
                    .setDescription('قائمة بطلبات الانضمام المعلقة:')
                    .addFields(
                        requests.map((request, index) => ({
                            name: `${index + 1}. ${request.user_name}`,
                            value: `معرف المستخدم: ${request.user_id}`,
                            inline: true
                        }))
                    )
                    .setFooter({ text: 'استخدم !قبول أو !رفض لمعالجة الطلبات' });

                message.channel.send({ embeds: [embed] });
            } catch (error) {
                console.error('Error in !الطلبات command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر طرد عضو من التحالف
        if (message.content.startsWith('!طرد')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (!['قائد التحالف', 'مشرف التحالف'].includes(user.alliance_rank)) {
                    return message.reply('ليس لديك صلاحية لطرد الأعضاء.');
                }

                const targetUser = message.mentions.users.first();
                if (!targetUser) return message.reply('يجب تحديد العضو المراد طرده.');

                if (targetUser.id === message.author.id) return message.reply('لا يمكنك طرد نفسك!');

                const targetUserData = await User.findOne({ id: targetUser.id });
                if (!targetUserData || targetUserData.alliance_id !== user.alliance_id) {
                    return message.reply('هذا المستخدم ليس عضواً في تحالفك.');
                }

                // التحقق من الصلاحيات
                if (user.alliance_rank === 'مشرف التحالف' && targetUserData.alliance_rank === 'قائد التحالف') {
                    return message.reply('لا يمكن للمشرف طرد قائد التحالف.');
                }

                const alliance = await Alliance.findOne({ id: user.alliance_id });

                // إزالة رتبة التحالف من العضو المطرود
                if (alliance.role_id) {
                    try {
                        const member = await message.guild.members.fetch(targetUser.id);
                        await member.roles.remove(alliance.role_id);
                        console.log(`تم إزالة رتبة التحالف من العضو المطرود: ${targetUser.username}`);
                    } catch (roleError) {
                        console.error('خطأ في إزالة رتبة التحالف من العضو المطرود:', roleError);
                    }
                }

                // طرد العضو
                targetUserData.alliance_id = null;
                targetUserData.alliance_rank = 'عضو';
                await targetUserData.save();

                alliance.members = alliance.members.filter(memberId => memberId !== targetUser.id);
                await alliance.save();

                message.reply(`تم طرد ${targetUser.username} من التحالف بنجاح.`);

                // إرسال رسالة للعضو المطرود
                try {
                    const embed = new discord.EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('تم طردك من التحالف')
                        .setDescription(`تم طردك من تحالف "${alliance.name}"`)
                        .setFooter({ text: 'يمكنك الانضمام إلى تحالف آخر' });

                    await targetUser.send({ embeds: [embed] });
                } catch (error) {
                    console.error('Error sending kick DM:', error);
                }
            } catch (error) {
                console.error('Error in !طرد command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }
        // أمر ترقية عضو
        if (message.content.startsWith('!ترقية')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (user.alliance_rank !== 'قائد التحالف') {
                    return message.reply('فقط قائد التحالف يمكنه ترقية الأعضاء.');
                }

                const targetUser = message.mentions.users.first();
                if (!targetUser) return message.reply('يجب تحديد العضو المراد ترقيته.');

                if (targetUser.id === message.author.id) return message.reply('لا يمكنك ترقية نفسك!');

                const targetUserData = await User.findOne({ id: targetUser.id });
                if (!targetUserData || targetUserData.alliance_id !== user.alliance_id) {
                    return message.reply('هذا المستخدم ليس عضواً في تحالفك.');
                }

                if (targetUserData.alliance_rank === 'مشرف التحالف') {
                    return message.reply('هذا العضو مشرف بالفعل.');
                }

                targetUserData.alliance_rank = 'مشرف التحالف';
                await targetUserData.save();

                message.reply(`تم ترقية ${targetUser.username} إلى مشرف التحالف بنجاح!`);

                // إرسال رسالة للعضو المرقى
                try {
                    const alliance = await Alliance.findOne({ id: user.alliance_id });
                    const embed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('تم ترقيتك!')
                        .setDescription(`تم ترقيتك إلى مشرف في تحالف "${alliance.name}"`)
                        .setFooter({ text: 'مبروك الترقية!' });

                    await targetUser.send({ embeds: [embed] });
                } catch (error) {
                    console.error('Error sending promotion DM:', error);
                }
            } catch (error) {
                console.error('Error in !ترقية command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر تخفيض عضو
        if (message.content.startsWith('!تخفيض')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (user.alliance_rank !== 'قائد التحالف') {
                    return message.reply('فقط قائد التحالف يمكنه تخفيض الأعضاء.');
                }

                const targetUser = message.mentions.users.first();
                if (!targetUser) return message.reply('يجب تحديد العضو المراد تخفيضه.');

                if (targetUser.id === message.author.id) return message.reply('لا يمكنك تخفيض نفسك!');

                const targetUserData = await User.findOne({ id: targetUser.id });
                if (!targetUserData || targetUserData.alliance_id !== user.alliance_id) {
                    return message.reply('هذا المستخدم ليس عضواً في تحالفك.');
                }

                if (targetUserData.alliance_rank === 'عضو') {
                    return message.reply('هذا العضو عضو عادي بالفعل.');
                }

                targetUserData.alliance_rank = 'عضو';
                await targetUserData.save();

                message.reply(`تم تخفيض ${targetUser.username} إلى عضو عادي بنجاح.`);

                // إرسال رسالة للعضو المخفض
                try {
                    const alliance = await Alliance.findOne({ id: user.alliance_id });
                    const embed = new discord.EmbedBuilder()
                        .setColor('#FFA500')
                        .setTitle('تم تخفيض رتبتك')
                        .setDescription(`تم تخفيض رتبتك إلى عضو عادي في تحالف "${alliance.name}"`)
                        .setFooter({ text: 'حاول أن تكون أكثر نشاطاً' });

                    await targetUser.send({ embeds: [embed] });
                } catch (error) {
                    console.error('Error sending demotion DM:', error);
                }
            } catch (error) {
                console.error('Error in !تخفيض command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر إعطاء الموارد
        if (message.content.startsWith('!اعطاء')) {
            try {
                   if (!PublicCategory.includes(message.channel.parentId)) {
                    return message.reply('هذا الأمر متاح فقط في القنوات العامة للتحالفات.');
                }

                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');


                const targetUser = message.mentions.users.first();
                 if (!targetUser) return message.reply('يجب تحديد العضو الذي تريد إعطاءه الموارد.');
                if (targetUser.id === message.author.id) return message.reply('لا يمكنك إعطاء الموارد لنفسك!');

                const targetUserData = await User.findOne({ id: targetUser.id });
                if (!targetUserData || targetUserData.alliance_id !== user.alliance_id) {
                    return message.reply('هذا المستخدم ليس عضواً في تحالفك.');
                }

                const args = message.content.split(' ');
                if (args.length < 4) {
                    return message.reply('استخدام الأمر: !اعطاء @المستخدم [نوع المورد] [الكمية]');
                }

                const resourceType = args[2];
                const amount = parseInt(args[3]);

                if (isNaN(amount) || amount <= 0) {
                    return message.reply('يجب إدخال كمية صحيحة.');
                }

                if (resourceType === 'جنود') {
                    if (user.soldiers < amount) {
                        return message.reply(`ليس لديك ${amount} جندي لإعطائهم.`);
                    }

                    user.soldiers -= amount;
                    targetUserData.soldiers += amount;
                    await user.save();
                    await targetUserData.save();

                    message.reply(`تم إعطاء ${amount} جندي إلى ${targetUser.username} بنجاح!`);

                } else if (resourceType === 'عملات') {
                    if (user.coins < amount) {
                        return message.reply(`ليس لديك ${amount} عملة لإعطائها.`);
                    }

                    user.coins -= amount;
                    targetUserData.coins += amount;
                    await user.save();
                    await targetUserData.save();

                    message.reply(`تم إعطاء ${amount} عملة إلى ${targetUser.username} بنجاح!`);

                } else {
                    // التحقق من العناصر الأخرى
                    const currentCount = await getUserItemCount(message.author.id, resourceType);

                    if (currentCount < amount) {
                        return message.reply(`ليس لديك ${amount} من ${resourceType} لإعطائها.`);
                    }

                    // إزالة العناصر من المعطي وإضافتها للمتلقي
                    await removeUserItem(message.author.id, resourceType, amount);
                    await addUserItem(targetUser.id, resourceType, amount);

                    message.reply(`تم إعطاء ${amount} من ${resourceType} إلى ${targetUser.username} بنجاح!`);
                }

                // إرسال رسالة للمتلقي
                try {
                    const embed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('تم استلام موارد!')
                        .setDescription(`استلمت ${amount} من ${resourceType} من ${message.author.username}`)
                        .setFooter({ text: 'من تحالفك' });

                    await targetUser.send({ embeds: [embed] });
                } catch (error) {
                    console.error('Error sending resource DM:', error);
                }

            } catch (error) {
                console.error('Error in !اعطاء command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر إعلان الحرب
        if (message.content.startsWith('!حرب')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (user.alliance_rank !== 'قائد التحالف') {
                    return message.reply('فقط قائد التحالف يمكنه إعلان الحرب.');
                }

                const targetAllianceName = message.content.split(' ').slice(1).join(' ');
                if (!targetAllianceName) return message.reply('يجب تحديد اسم التحالف الذي تريد محاربته.');

                const targetAlliance = await Alliance.findOne({ name: targetAllianceName });
                if (!targetAlliance) return message.reply('لم يتم العثور على تحالف بهذا الاسم.');

                if (targetAlliance.id === user.alliance_id) return message.reply('لا يمكنك إعلان الحرب على تحالفك!');

                const userAlliance = await Alliance.findOne({ id: user.alliance_id });

                if (userAlliance.wars.includes(targetAlliance.id)) {
                    return message.reply('أنت في حالة حرب مع هذا التحالف بالفعل!');
                }

                // إعلان الحرب
                userAlliance.wars.push(targetAlliance.id);
                targetAlliance.wars.push(userAlliance.id);
                await userAlliance.save();
                await targetAlliance.save();

                const embed = new discord.EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('إعلان حرب!')
                    .setDescription(`تم إعلان الحرب بين تحالف "${userAlliance.name}" و تحالف "${targetAlliance.name}"`)
                    .addFields(
                        { name: 'التحالف المعلن:', value: userAlliance.name },
                        { name: 'التحالف المستهدف:', value: targetAlliance.name }
                    )
                    .setFooter({ text: 'يمكن الآن للأعضاء مهاجمة بعضهم البعض!' });

                message.channel.send({ embeds: [embed] });

                // إرسال رسالة لقائد التحالف المستهدف
                try {
                    const targetLeader = await client.users.fetch(targetAlliance.leader_id);
                    const warEmbed = new discord.EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('تم إعلان الحرب عليك!')
                        .setDescription(`تحالف "${userAlliance.name}" أعلن الحرب على تحالفك "${targetAlliance.name}"`)
                        .setFooter({ text: 'استعد للمعركة!' });

                    await targetLeader.send({ embeds: [warEmbed] });
                } catch (error) {
                    console.error('Error sending war declaration DM:', error);
                }

            } catch (error) {
                console.error('Error in !حرب command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر طلب السلام
        if (message.content.startsWith('!سلام')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (user.alliance_rank !== 'قائد التحالف') {
                    return message.reply('فقط قائد التحالف يمكنه طلب السلام.');
                }

                const targetAllianceName = message.content.split(' ').slice(1).join(' ');
                if (!targetAllianceName) return message.reply('يجب تحديد اسم التحالف الذي تريد السلام معه.');

                const targetAlliance = await Alliance.findOne({ name: targetAllianceName });
                if (!targetAlliance) return message.reply('لم يتم العثور على تحالف بهذا الاسم.');

                const userAlliance = await Alliance.findOne({ id: user.alliance_id });

                if (!userAlliance.wars.includes(targetAlliance.id)) {
                    return message.reply('أنت لست في حالة حرب مع هذا التحالف.');
                }

                // طلب السلام
                try {
                    const targetLeader = await client.users.fetch(targetAlliance.leader_id);
                    const peaceEmbed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('طلب سلام')
                        .setDescription(`تحالف "${userAlliance.name}" يطلب السلام مع تحالفك "${targetAlliance.name}"`)
                        .addFields(
                            { name: 'التحالف الطالب:', value: userAlliance.name },
                            { name: 'تحالفك:', value: targetAlliance.name }
                        )
                        .setFooter({ text: 'استخدم !مقبول لقبول طلب السلام' });

                    await targetLeader.send({ embeds: [peaceEmbed] });
                    message.reply(`تم إرسال طلب السلام إلى قائد تحالف "${targetAlliance.name}".`);
                } catch (error) {
                    console.error('Error sending peace request DM:', error);
                    message.reply('حدث خطأ أثناء إرسال طلب السلام.');
                }

            } catch (error) {
                console.error('Error in !سلام command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // دالة فحص وحذف التحالف إذا فقد القائد جميع جنوده - محسنة ومحدثة
        async function checkAndDeleteAllianceIfLeaderLost(leaderId) {
            try {
                console.log(`🔍 فحص حالة القائد: ${leaderId}`);

                const leader = await User.findOne({ id: leaderId });
                if (!leader) {
                    console.log(`❌ لم يتم العثور على بيانات القائد: ${leaderId}`);
                    return;
                }

                if (!leader.alliance_id) {
                    console.log(`❌ القائد ${leaderId} ليس في تحالف`);
                    return;
                }

                // التحقق من أن اللاعب هو قائد التحالف فعلاً
                if (leader.alliance_rank !== 'قائد التحالف') {
                    console.log(`❌ اللاعب ${leaderId} ليس قائد تحالف`);
                    return;
                }

                const alliance = await Alliance.findOne({ id: leader.alliance_id });
                if (!alliance) {
                    console.log(`❌ لم يتم العثور على التحالف: ${leader.alliance_id}`);
                    return;
                }

                // التحقق المزدوج من أن هذا اللاعب هو قائد التحالف
                if (alliance.leader_id !== leaderId) {
                    console.log(`❌ عدم تطابق معرف القائد في التحالف: ${alliance.leader_id} != ${leaderId}`);
                    return;
                }

                const totalSoldiers = (leader.soldiers || 0) + (leader.officers || 0) + 
                                    (leader.colonels || 0) + (leader.generals || 0) + 
                                    (leader.lowMoraleSoldiers || 0);

                console.log(`⚔️ إجمالي جنود القائد: ${totalSoldiers}`);

                if (totalSoldiers === 0) {
                    console.log(`🚨 القائد ${leaderId} فقد جميع جنوده، سيتم حذف التحالف ${alliance.name}`);

                    // إزالة رتبة التحالف من جميع الأعضاء وحذف الرتبة
                    if (alliance.role_id) {
                        try {
                            console.log(`🏷️ حذف رتبة التحالف: ${alliance.role_id}`);

                            // إزالة الرتبة من جميع الأعضاء في جميع السيرفرات
                            for (const memberId of alliance.members || []) {
                                try {
                                    let memberFound = false;

                                    // البحث في جميع السيرفرات
                                    for (const guild of client.guilds.cache.values()) {
                                        try {
                                            const member = await guild.members.fetch(memberId);
                                            if (member && member.roles.cache.has(alliance.role_id)) {
                                                await member.roles.remove(alliance.role_id);
                                                console.log(`✅ تم إزالة رتبة التحالف من العضو: ${memberId} في السيرفر: ${guild.name}`);
                                                memberFound = true;
                                            }
                                        } catch (memberError) {
                                            // تجاهل الأخطاء والمتابعة
                                            continue;
                                        }
                                    }

                                    if (!memberFound) {
                                        console.log(`⚠️ لم يتم العثور على العضو ${memberId} في أي سيرفر`);
                                    }
                                } catch (memberError) {
                                    console.error(`❌ خطأ في إزالة الرتبة من العضو ${memberId}:`, memberError);
                                }
                            }

                            // حذف الرتبة من جميع السيرفرات
                            let roleDeleted = false;
                            for (const guild of client.guilds.cache.values()) {
                                try {
                                    const role = await guild.roles.fetch(alliance.role_id);
                                    if (role) {
                                        await role.delete('حذف تحالف بسبب فقدان القائد لجميع جنوده');
                                        console.log(`✅ تم حذف رتبة التحالف: ${alliance.name} من السيرفر: ${guild.name}`);
                                        roleDeleted = true;
                                        break; // الرتبة موجودة في سيرفر واحد فقط عادة
                                    }
                                } catch (roleError) {
                                    console.error(`❌ خطأ في حذف الرتبة من السيرفر ${guild.name}:`, roleError);
                                    continue;
                                }
                            }

                            if (!roleDeleted) {
                                console.log(`⚠️ لم يتم العثور على رتبة التحالف ${alliance.role_id} في أي سيرفر`);
                            }
                        } catch (roleError) {
                            console.error('❌ خطأ عام في حذف رتبة التحالف:', roleError);
                        }
                    }

                    // إشعار الأعضاء السابقين
                    console.log(`📤 إرسال إشعارات للأعضاء...`);
                    const members = await User.find({ alliance_id: alliance.id });
                    let notifiedCount = 0;

                    for (const member of members) {
                        try {
                            if (member.id !== leaderId) {
                                const memberUser = await client.users.fetch(member.id);
                                const embed = new discord.EmbedBuilder()
                                    .setColor('#FF0000')
                                    .setTitle('🚨 تم حل التحالف!')
                                    .setDescription(`تم حل تحالف **"${alliance.name}"** بسبب خسارة القائد لجميع جنوده`)
                                    .addFields(
                                        { name: '📋 السبب:', value: 'فقدان القائد لجميع قواته' },
                                        { name: '⏰ التوقيت:', value: new Date().toLocaleString('ar-SA') },
                                        { name: '🔄 الخطوات التالية:', value: 'يمكنك الانضمام إلى تحالف آخر أو إنشاء تحالف جديد' }
                                    )
                                    .setFooter({ text: 'تم حل التحالف تلقائياً بواسطة النظام' })
                                    .setTimestamp();

                                await memberUser.send({ embeds: [embed] });
                                notifiedCount++;
                                console.log(`✅ تم إشعار العضو: ${member.id}`);
                            }
                        } catch (error) {
                            console.error(`❌ خطأ في إرسال إشعار للعضو ${member.id}:`, error);
                        }
                    }

                    console.log(`📊 تم إشعار ${notifiedCount} عضو من أصل ${members.length - 1} أعضاء`);

                    // إزالة التحالف من جميع الأعضاء
                    console.log(`🗑️ إزالة التحالف من بيانات الأعضاء...`);
                    const updateResult = await User.updateMany(
                        { alliance_id: alliance.id },
                        { $unset: { alliance_id: "" }, $set: { alliance_rank: 'عضو' } }
                    );
                    console.log(`✅ تم تحديث بيانات ${updateResult.modifiedCount} عضو`);

                    // حذف جميع طلبات الانضمام للتحالف
                    console.log(`🗑️ حذف طلبات الانضمام للتحالف...`);
                    const deleteRequestsResult = await AllianceRequest.deleteMany({ alliance_id: alliance.id });
                    console.log(`✅ تم حذف ${deleteRequestsResult.deletedCount} طلب انضمام`);

                    // حذف التحالف
                    console.log(`🗑️ حذف التحالف من قاعدة البيانات...`);
                    const deleteAllianceResult = await Alliance.deleteOne({ id: alliance.id });

                    if (deleteAllianceResult.deletedCount > 0) {
                        console.log(`✅ تم حذف التحالف "${alliance.name}" بنجاح بسبب فقدان القائد ${leaderId} لجميع جنوده`);
                    } else {
                        console.error(`❌ فشل في حذف التحالف "${alliance.name}" من قاعدة البيانات`);
                    }
                } else {
                    console.log(`✅ القائد ${leaderId} لا يزال يملك ${totalSoldiers} جندي، التحالف محفوظ`);
                }
            } catch (error) {
                console.error('❌ خطأ في فحص حالة قائد التحالف:', error);
            }
        }
        // أمر قبول السلام - تم تغييره إلى !مقبول
        if (message.content.startsWith('!مقبول')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (user.alliance_rank !== 'قائد التحالف') {
                    return message.reply('فقط قائد التحالف يمكنه قبول السلام.');
                }

                const targetAllianceName = message.content.split(' ').slice(1).join(' ');
                if (!targetAllianceName) return message.reply('يجب تحديد اسم التحالف الذي تريد السلام معه.');

                const targetAlliance = await Alliance.findOne({ name: targetAllianceName });
                if (!targetAlliance) return message.reply('لم يتم العثور على تحالف بهذا الاسم.');

                const userAlliance = await Alliance.findOne({ id: user.alliance_id });

                if (!userAlliance.wars.includes(targetAlliance.id)) {
                    return message.reply('أنت لست في حالة حرب مع هذا التحالف.');
                }

                // إنهاء الحرب
                userAlliance.wars = userAlliance.wars.filter(warId => warId !== targetAlliance.id);
                targetAlliance.wars = targetAlliance.wars.filter(warId => warId !== userAlliance.id);
                await userAlliance.save();
                await targetAlliance.save();

                const embed = new discord.EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('تم السلام!')
                    .setDescription(`تم إنهاء الحرب بين تحالف "${userAlliance.name}" و تحالف "${targetAlliance.name}"`)
                    .addFields(
                        { name: 'التحالف الأول:', value: userAlliance.name },
                        { name: 'التحالف الثاني:', value: targetAlliance.name }
                    )
                    .setFooter({ text: 'لا يمكن للأعضاء مهاجمة بعضهم البعض الآن.' });

                message.channel.send({ embeds: [embed] });

                // إرسال رسالة لقائد التحالف الآخر
                try {
                    const targetLeader = await client.users.fetch(targetAlliance.leader_id);
                    const peaceEmbed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('تم قبول السلام!')
                        .setDescription(`قائد تحالف "${userAlliance.name}" قبل السلام معك`)
                        .setFooter({ text: 'انتهت الحرب!' });

                    await targetLeader.send({ embeds: [peaceEmbed] });
                } catch (error) {
                    console.error('Error sending peace acceptance DM:', error);
                }

            } catch (error) {
                console.error('Error in !قبول_سلام command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر عرض التحالفات
        if (message.content.startsWith('!التحالفات')) {
            try {
                if (!PublicCategory.includes(message.channel.parentId)) {
                    return message.reply('هذا الأمر متاح فقط في القنوات العامة للتحالفات.');
                }
                const alliances = await Alliance.find();

                if (alliances.length === 0) {
                    return message.reply('لا توجد تحالفات حالياً.');
                }

                // ترتيب التحالفات حسب عدد الأعضاء
                alliances.sort((a, b) => (b.members ? b.members.length : 0) - (a.members ? a.members.length : 0));

                const alliancesPerPage = 5;
                const totalPages = Math.ceil(alliances.length / alliancesPerPage);
                let currentPage = 1;

                const generateEmbed = async (page) => {
                    const startIndex = (page - 1) * alliancesPerPage;
                    const endIndex = startIndex + alliancesPerPage;
                    const currentAlliances = alliances.slice(startIndex, endIndex);

                    const embed = new discord.EmbedBuilder()
                        .setColor('#FFD700')
                        .setTitle('قائمة التحالفات')
                        .setDescription(`صفحة ${page} من ${totalPages}`)
                        .setFooter({ text: `إجمالي التحالفات: ${alliances.length}` });

                    for (const alliance of currentAlliances) {
                        try {
                            const leader = await client.users.fetch(alliance.leader_id);
                            const memberCount = alliance.members ? alliance.members.length : 0;
                            const createdDate = alliance.created_at ? alliance.created_at.toLocaleDateString('ar-SA') : 'غير محدد';

                            embed.addFields({
                                name: `🏛️ ${alliance.name}`,
                                value: `👑 القائد: ${leader.username}\n👥 عدد الأعضاء: ${memberCount}\n📅 تاريخ الإنشاء: ${createdDate}`,
                                inline: false
                            });
                        } catch (error) {
                            const memberCount = alliance.members ? alliance.members.length : 0;
                            const createdDate = alliance.created_at ? alliance.created_at.toLocaleDateString('ar-SA') : 'غير محدد';

                            embed.addFields({
                                name: `🏛️ ${alliance.name}`,
                                value: `👑 القائد: غير متوفر\n👥 عدد الأعضاء: ${memberCount}\n📅 تاريخ الإنشاء: ${createdDate}`,
                                inline: false
                            });
                        }
                    }

                    return embed;
                };

                const embed = await generateEmbed(currentPage);

                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('prev_page')
                            .setLabel('السابق')
                            .setStyle(discord.ButtonStyle.Secondary)
                            .setEmoji('⬅️')
                            .setDisabled(currentPage === 1),
                        new discord.ButtonBuilder()
                            .setCustomId('next_page')
                            .setLabel('التالي')
                            .setStyle(discord.ButtonStyle.Secondary)
                            .setEmoji('➡️')
                            .setDisabled(currentPage === totalPages)
                    );

                const allianceMessage = await message.channel.send({ 
                    embeds: [embed], 
                    components: totalPages > 1 ? [row] : [] 
                });

                if (totalPages > 1) {
                    const filter = i => i.user.id === message.author.id;
                    const collector = allianceMessage.createMessageComponentCollector({
                        filter,
                        time: 120000
                    });

                    collector.on('collect', async i => {
                        if (i.customId === 'prev_page') {
                            currentPage--;
                        } else if (i.customId === 'next_page') {
                            currentPage++;
                        }

                        const newEmbed = await generateEmbed(currentPage);
                        const newRow = new discord.ActionRowBuilder()
                            .addComponents(
                                new discord.ButtonBuilder()
                                    .setCustomId('prev_page')
                                    .setLabel('السابق')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setEmoji('⬅️')
                                    .setDisabled(currentPage === 1),
                                new discord.ButtonBuilder()
                                    .setCustomId('next_page')
                                    .setLabel('التالي')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setEmoji('➡️')
                                    .setDisabled(currentPage === totalPages)
                            );

                        await i.update({ embeds: [newEmbed], components: [newRow] });
                    });

                    collector.on('end', () => {
                        const disabledRow = new discord.ActionRowBuilder()
                            .addComponents(
                                new discord.ButtonBuilder()
                                    .setCustomId('prev_page')
                                    .setLabel('السابق')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setEmoji('⬅️')
                                    .setDisabled(true),
                                new discord.ButtonBuilder()
                                    .setCustomId('next_page')
                                    .setLabel('التالي')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setEmoji('➡️')
                                    .setDisabled(true)
                            );

                        allianceMessage.edit({ components: [disabledRow] }).catch(console.error);
                    });
                }
            } catch (error) {
                console.error('Error in !التحالفات command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }





         // أمر الخروج من التحالف
            if (message.content.startsWith('!خروج')) {
                try {
                    const user = await User.findOne({ id: message.author.id });
                    if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                    if (user.alliance_rank === 'قائد التحالف') {
                        return message.reply('لا يمكن لقائد التحالف الخروج من التحالف. استخدم !حذف لحذف التحالف بالكامل.');
                    }

                    // إنشاء رسالة تأكيد
                    const confirmEmbed = new discord.EmbedBuilder()
                        .setColor('#FFA500')
                    .setTitle('تأكيد الخروج من التحالف')
                    .setDescription('هل أنت متأكد من الخروج من التحالف؟')
                    .setFooter({ text: 'اضغط على "تأكيد" للخروج أو "إلغاء" للإلغاء.' });

                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('confirm_leave')
                            .setLabel('تأكيد')
                            .setStyle(discord.ButtonStyle.Danger),
                        new discord.ButtonBuilder()
                            .setCustomId('cancel_leave')
                            .setLabel('إلغاء')
                            .setStyle(discord.ButtonStyle.Secondary)
                    );

                const confirmMessage = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

                const filter = i => i.user.id === message.author.id;
                const collector = confirmMessage.createMessageComponentCollector({ filter, time: 30000 });

                collector.on('collect', async i => {
                    if (i.customId === 'confirm_leave') {
                        try {
                            const alliance = await Alliance.findOne({ id: user.alliance_id });

                            // إزالة رتبة التحالف من العضو
                            if (alliance.role_id) {
                                try {
                                    const member = await message.guild.members.fetch(message.author.id);
                                    await member.roles.remove(alliance.role_id);
                                    console.log(`تم إزالة رتبة التحالف من العضو الخارج: ${message.author.username}`);
                                } catch (roleError) {
                                    console.error('خطأ في إزالة رتبة التحالف من العضو الخارج:', roleError);
                                }
                            }

                            // إزالة العضو من التحالف
                            user.alliance_id = null;
                            user.alliance_rank = 'عضو';
                            await user.save();

                            // إزالة العضو من قائمة أعضاء التحالف
                            alliance.members = alliance.members.filter(memberId => memberId !== message.author.id);
                            await alliance.save();

                            const successEmbed = new discord.EmbedBuilder()
                                .setColor('#00FF00')
                                .setTitle('تم الخروج من التحالف بنجاح!')
                                .setDescription(`تم خروجك من تحالف "${alliance.name}" بنجاح.`)
                                .setFooter({ text: 'يمكنك الانضمام إلى تحالف آخر.' });

                            await i.update({ embeds: [successEmbed], components: [] });
                        } catch (error) {
                            console.error('Error leaving alliance:', error);
                            await i.update({ 
                                content: 'حدث خطأ أثناء الخروج من التحالف. يرجى المحاولة مرة أخرى.',
                                embeds: [],
                                components: []
                            });
                        }
                    } else if (i.customId === 'cancel_leave') {
                        await i.update({ 
                            content: 'تم إلغاء عملية الخروج من التحالف.',
                            embeds: [],
                            components: []
                        });
                    }
                });

                collector.on('end', collected => {
                    if (collected.size === 0) {
                        confirmMessage.edit({ 
                            content: 'انتهى وقت التأكيد. تم إلغاء عملية الخروج.',
                            embeds: [],
                            components: []
                        }).catch(console.error);
                    }
                });
            } catch (error) {
                console.error('Error in !خروج command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر حذف التحالف (قائد فقط)
        if (message.content.startsWith('!حذف')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                if (user.alliance_rank !== 'قائد التحالف') {
                    return message.reply('فقط قائد التحالف يمكنه حذف التحالف.');
                }

                const alliance = await Alliance.findOne({ id: user.alliance_id });
                if (!alliance) return message.reply('لم يتم العثور على التحالف.');

                // إنشاء رسالة تأكيد
                const confirmEmbed = new discord.EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('تأكيد حذف التحالف')
                    .setDescription(`هل أنت متأكد من حذف تحالف "${alliance.name}" بالكامل؟`)
                    .addFields(
                        { name: 'تحذير:', value: 'سيتم إخراج جميع الأعضاء من التحالف وحذفه نهائياً!' }
                    )
                    .setFooter({ text: 'اضغط على "تأكيد" للحذف أو "إلغاء" للإلغاء.' });

                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('confirm_delete')
                            .setLabel('تأكيد الحذف')
                            .setStyle(discord.ButtonStyle.Danger),
                        new discord.ButtonBuilder()
                            .setCustomId('cancel_delete')
                            .setLabel('إلغاء')
                            .setStyle(discord.ButtonStyle.Secondary)
                    );

                const confirmMessage = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

                const filter = i => i.user.id === message.author.id;
                const collector = confirmMessage.createMessageComponentCollector({ filter, time: 30000 });

                collector.on('collect', async i => {
                    if (i.customId === 'confirm_delete') {
                        try {
                            // إزالة رتبة التحالف من جميع الأعضاء وحذف الرتبة
                            if (alliance.role_id) {
                                try {
                                    // إزالة الرتبة من جميع الأعضاء
                                    for (const memberId of alliance.members) {
                                        try {
                                            const member = await message.guild.members.fetch(memberId);
                                            await member.roles.remove(alliance.role_id);
                                            console.log(`تم إزالة رتبة التحالف من العضو: ${memberId}`);
                                        } catch (memberError) {
                                            console.error(`خطأ في إزالة الرتبة من العضو ${memberId}:`, memberError);
                                        }
                                    }

                                    // حذف الرتبة من السيرفر
                                    const role = await message.guild.roles.fetch(alliance.role_id);
                                    if (role) {
                                        await role.delete('حذف تحالف');
                                        console.log(`تم حذف رتبة التحالف: ${alliance.name}`);
                                    }
                                } catch (roleError) {
                                    console.error('خطأ في حذف رتبة التحالف:', roleError);
                                }
                            }

                            // إزالة التحالف من جميع الأعضاء
                            await User.updateMany(
                                { alliance_id: alliance.id },
                                { $unset: { alliance_id: "" }, $set: { alliance_rank: 'عضو' } }
                            );

                            // حذف جميع طلبات الانضمام للتحالف
                            await AllianceRequest.deleteMany({ alliance_id: alliance.id });

                            // حذف التحالف
                            await Alliance.deleteOne({ id: alliance.id });

                            const successEmbed = new discord.EmbedBuilder()
                                .setColor('#FF0000')
                                .setTitle('تم حذف التحالف بنجاح!')
                                .setDescription(`تم حذف تحالف "${alliance.name}" بالكامل وإخراج جميع الأعضاء.`)
                                .addFields(
                                    { name: 'تم حذف:', value: '✅ التحالف\n✅ رتبة التحالف\n✅ عضوية جميع الأعضاء' }
                                )
                                .setFooter({ text: 'تم حذف التحالف نهائياً.' });

                            await i.update({ embeds: [successEmbed], components: [] });
                        } catch (error) {
                            console.error('Error deleting alliance:', error);
                            await i.update({ 
                                content: 'حدث خطأ أثناء حذف التحالف. يرجى المحاولة مرة أخرى.',
                                embeds: [],
                                components: []
                            });
                        }
                    } else if (i.customId === 'cancel_delete') {
                        await i.update({ 
                            content: 'تم إلغاء عملية حذف التحالف.',
                            embeds: [],
                            components: []
                        });
                    }
                });

                collector.on('end', collected => {
                    if (collected.size === 0) {
                        confirmMessage.edit({ 
                            content: 'انتهى وقت التأكيد. تم إلغاء عملية الحذف.',
                            embeds: [],
                            components: []
                        }).catch(console.error);
                    }
                });
            } catch (error) {
                console.error('Error in !حذف command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }
        // أمر تدريب الجنود
        if (message.content.startsWith('!تدريب')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

                const hasTrainingCamp = await hasUserItem(message.author.id, 'معسكر التدريب');

                if (!hasTrainingCamp) {
                    return message.reply('تحتاج إلى معسكر التدريب لتدريب الجنود. يمكن شراؤه من قائمة الشراء.');
                }

                const trainingOptions = [
                    { name: 'جندي إلى ضابط', from: 'soldiers', to: 'officers', cost: 2, damage: 10, health: 35 },
                    { name: 'ضابط إلى عقيد', from: 'officers', to: 'colonels', cost: 4, damage: 15, health: 40 },
                    { name: 'عقيد إلى لواء', from: 'colonels', to: 'generals', cost: 8, damage: 25, health: 50 }
                ];

                const embed = new discord.EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('معسكر التدريب')
                    .setDescription('اختر نوع التدريب الذي تريده:')
                    .addFields(
                        trainingOptions.map((option, index) => ({
                            name: `${index + 1}. ${option.name}`,
                            value: `التكلفة: ${option.cost} عملة لكل جندي\nالضرر: ${option.damage} | الصحة: ${option.health}`,
                            inline: true
                        }))
                    )
                    .setFooter({ text: 'اكتب رقم نوع التدريب.' });

                message.channel.send({ embeds: [embed] }).then(() => {
                    const filter = (response) => response.author.id === message.author.id;
                    const collector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

                    collector.on('collect', async (response) => {
                        try {
                            const trainingIndex = parseInt(response.content.trim()) - 1;

                            if (isNaN(trainingIndex) || trainingIndex < 0 || trainingIndex >= trainingOptions.length) {
                                return message.reply('اختيار غير صحيح. يرجى المحاولة مرة أخرى.');
                            }

                            const selectedTraining = trainingOptions[trainingIndex];
                            const availableCount = user[selectedTraining.from];

                            if (availableCount === 0) {
                                return message.reply(`ليس لديك أي ${selectedTraining.from === 'soldiers' ? 'جنود' : selectedTraining.from === 'officers' ? 'ضباط' : 'عقداء'} للتدريب.`);
                            }

                            message.reply(`كم عدد الجنود التي تريد تدريبها؟ (المتاح: ${availableCount})`).then(() => {
                                const quantityCollector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

                                quantityCollector.on('collect', async (quantityResponse) => {
                                    try {
                                        const quantity = parseInt(quantityResponse.content.trim());

                                        if (isNaN(quantity) || quantity <= 0) {
                                            return message.reply('يرجى إدخال عدد صحيح موجب.');
                                        }

                                        if (quantity > availableCount) {
                                            return message.reply(`ليس لديك ${quantity} من الجنود للتدريب. المتاح: ${availableCount}`);
                                        }

                                        const totalCost = quantity * selectedTraining.cost;

                                        if (user.coins < totalCost) {
                                            return message.reply(`ليس لديك عملات كافية للتدريب. تحتاج إلى ${totalCost} عملة.`);
                                        }

                                        // تنفيذ التدريب
                                        user[selectedTraining.from] -= quantity;
                                        user[selectedTraining.to] += quantity;
                                        user.coins -= totalCost;
                                        await user.save();

                                        const successEmbed = new discord.EmbedBuilder()
                                            .setColor('#00FF00')
                                            .setTitle('تم التدريب بنجاح!')
                                            .setDescription(`تم تدريب ${quantity} جندي بنجاح!`)
                                            .addFields(
                                                { name: 'نوع التدريب:', value: selectedTraining.name },
                                                { name: 'التكلفة الإجمالية:', value: `${totalCost} عملة` },
                                                { name: 'العملات المتبقية:', value: user.coins.toString() }
                                            )
                                            .setFooter({ text: 'الجنود المدربون أصبحوا أقوى!' });

                                        message.channel.send({ embeds: [successEmbed] });
                                    } catch (error) {
                                        console.error('Error processing training quantity:', error);
                                        message.reply('حدث خطأ أثناء معالجة التدريب. يرجى المحاولة مرة أخرى.');
                                    }
                                });

                                quantityCollector.on('end', (collected) => {
                                    if (collected.size === 0) {
                                        message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                                    }
                                });
                            });
                        } catch (error) {
                            console.error('Error processing training selection:', error);
                            message.reply('حدث خطأ أثناء معالجة التدريب. يرجى المحاولة مرة أخرى.');
                        }
                    });

                    collector.on('end', (collected) => {
                        if (collected.size === 0) {
                            message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                        }
                    });
                });
            } catch (error) {
                console.error('Error in !تدريب command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر عرض معلومات الراتب
        if (message.content.startsWith('!راتب')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

                // حساب الراتب الكلي المطلوب
                const soldiersSalary = (user.soldiers || 0) * 0.5;
                const officersSalary = (user.officers || 0) * 1;
                const colonelsSalary = (user.colonels || 0) * 3;
                const generalsSalary = (user.generals || 0) * 5;
                const lowMoraleSalary = (user.lowMoraleSoldiers || 0) * 0.5;
                const totalSalary = soldiersSalary + officersSalary + colonelsSalary + generalsSalary + lowMoraleSalary;

                // حساب الوقت المتبقي للراتب التالي
                const now = new Date();
                const lastSalaryTime = new Date(user.lastSalaryPaid);
                const timeDifference = now - lastSalaryTime;
                const oneHour = 60 * 60 * 1000;

                let timeUntilNext;
                if (timeDifference >= oneHour) {
                    // إذا مر أكثر من ساعة، فالراتب مستحق الآن
                    timeUntilNext = 0;
                } else {
                    // حساب الوقت المتبقي حتى الساعة التالية
                    timeUntilNext = oneHour - timeDifference;
                }

                const minutesLeft = Math.floor(timeUntilNext / (60 * 1000));

                const embed = new discord.EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('معلومات الراتب')
                    .setDescription(`تفاصيل راتب جيش ${user.army_name}`)
                    .addFields(
                        { name: '💰 عملاتك الحالية:', value: user.coins.toString(), inline: true },
                        { name: '💸 الراتب المطلوب (كل ساعة):', value: totalSalary.toString(), inline: true },
                        { name: '⏰ الوقت حتى الراتب التالي:', value: `${minutesLeft} دقيقة`, inline: true },
                        { name: '⚔️ الجنود العاديون:', value: `${user.soldiers || 0} (${soldiersSalary} عملة)`, inline: true },
                        { name: '🎖️ الضباط:', value: `${user.officers || 0} (${officersSalary} عملة)`, inline: true },
                        { name: '🏅 العقداء:', value: `${user.colonels || 0} (${colonelsSalary} عملة)`, inline: true },
                        { name: '👑 اللوائات:', value: `${user.generals || 0} (${generalsSalary} عملة)`, inline: true },
                        { name: '😞 جنود ضعيفي الهمة:', value: `${user.lowMoraleSoldiers || 0} (${lowMoraleSalary} عملة)`, inline: true },
                        { name: '⚠️ حالة الراتب:', value: user.coins >= totalSalary ? '✅ كافي' : '❌ غير كافي', inline: true }
                    )
                    .setFooter({ text: 'يتم دفع الرواتب تلقائياً كل ساعة' });

                message.channel.send({ embeds: [embed] });
            } catch (error) {
                console.error('Error in !راتب command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر إنشاء التذكرة
        if (message.content.startsWith('!تذكرة')) {
            try {
                // التحقق من صلاحيات الإدارة
                if (!message.member || !message.member.permissions.has(discord.PermissionFlagsBits.Administrator)) {
                    return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
                }

                const embed = new discord.EmbedBuilder()
                    .setColor('#0099FF')
                    .setTitle('إعداد التذكرة')
                    .setDescription('يرجى تحديد رتبة طاقم الدعم عن طريق منشن الرتبة.');

                const setupMessage = await message.channel.send({ embeds: [embed] });

                const filter = (response) => response.author.id === message.author.id && response.channel.id === message.channel.id;
                const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

                collector.on('collect', async (response) => {
                    try {
                        const supportRole = response.mentions.roles.first();
                        if (!supportRole) {
                            return message.reply('يرجى منشن رتبة طاقم الدعم.');
                        }

                        const messagePrompt = await message.reply('يرجى كتابة الرسالة التي ستظهر عند فتح التذكرة:');
                        const messageCollector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

                        messageCollector.on('collect', async (messageResponse) => {
                            try {
                                const openMessage = messageResponse.content;

                                const ticketId = `${Date.now()}_${message.guild.id}`;

                                // التحقق من عدم وجود تذكرة بنفس المعرف
                                const existingTicket = await Ticket.findOne({ id: ticketId });
                                if (existingTicket) {
                                    return message.reply('حدث خطأ في إنشاء معرف فريد للتذكرة. يرجى المحاولة مرة أخرى.');
                                }

                                const newTicket = new Ticket({
                                    id: ticketId,
                                    channel_id: message.channel.id,
                                    support_role_id: supportRole.id,
                                    open_message: openMessage,
                                    creator_id: null, // سيتم تحديده عند فتح التذكرة
                                    created_at: new Date()
                                });

                                await newTicket.save();

                                const ticketEmbed = new discord.EmbedBuilder()
                                    .setColor('#00FF00')
                                    .setTitle('🎫 نظام التذاكر')
                                    .setDescription(openMessage)
                                    .addFields(

                                        { name: '🛡️ فريق الدعم:', value: supportRole.toString() }

                                    )
                                    .setFooter({ text: 'اضغط على الزر أدناه لفتح تذكرة دعم جديدة' })
                                    .setTimestamp();

                                const row = new discord.ActionRowBuilder()
                                    .addComponents(
                                        new discord.ButtonBuilder()
                                            .setCustomId(`open_ticket_${ticketId}`)
                                            .setLabel('🎫 فتح تذكرة')
                                            .setStyle(discord.ButtonStyle.Primary)
                                            .setEmoji('🎫')
                                    );

                                const ticketMessage = await message.channel.send({ embeds: [ticketEmbed], components: [row] });

                                // حفظ معرف الرسالة في قاعدة البيانات للمرجع
                                await Ticket.findOneAndUpdate(
                                    { id: ticketId },
                                    { $set: { message_id: ticketMessage.id } }
                                );

                                await message.reply('✅ تم إنشاء نظام التذاكر بنجاح! يمكن للأعضاء الآن فتح تذاكر دعم.');

                                console.log(`Ticket system created - ID: ${ticketId}, Guild: ${message.guild.id}, Channel: ${message.channel.id}`);
                            } catch (error) {
                                console.error('Error creating ticket system:', error);
                                await message.reply('حدث خطأ أثناء إنشاء نظام التذاكر.');
                            }
                        });

                        messageCollector.on('end', (collected) => {
                            if (collected.size === 0) {
                                message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                            }
                        });
                    } catch (error) {
                        console.error('Error processing support role:', error);
                        await message.reply('حدث خطأ أثناء معالجة رتبة الدعم.');
                    }
                });

                collector.on('end', (collected) => {
                    if (collected.size === 0) {
                        message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                    }
                });
            } catch (error) {
                console.error('Error in !تذكرة command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }
          const sr = '1323072269525712927';
        // أمر حذف التذكرة
        if (message.content.startsWith('!del')) {
            try {
                // التحقق من صلاحيات الإدارة
                if (!message.member || !message.member.permissions.has(discord.PermissionFlagsBits.Administrator) && !message.member.roles.cache.has(sr)) {
                    return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
                }

                // التحقق من أن الأمر مستخدم في قناة تذكرة
                if (!message.channel.name || !message.channel.name.startsWith('ticket-')) {
                    return message.reply('هذا الأمر يمكن استخدامه فقط في قنوات التذاكر.');
                }

                // إنشاء رسالة تأكيد
                const confirmEmbed = new discord.EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('تأكيد حذف التذكرة')
                    .setDescription('هل أنت متأكد من حذف هذه التذكرة نهائياً؟')
                    .setFooter({ text: 'سيتم حذف القناة بالكامل ولا يمكن استردادها.' });

                const confirmRow = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('confirm_delete_ticket')
                            .setLabel('تأكيد الحذف')
                            .setStyle(discord.ButtonStyle.Danger),
                        new discord.ButtonBuilder()
                            .setCustomId('cancel_delete_ticket')
                            .setLabel('إلغاء')
                            .setStyle(discord.ButtonStyle.Secondary)
                    );

                const confirmMessage = await message.channel.send({ embeds: [confirmEmbed], components: [confirmRow] });

                const filter = i => i.user.id === message.author.id;
                const collector = confirmMessage.createMessageComponentCollector({ filter, time: 30000 });

                collector.on('collect', async i => {
                    if (i.customId === 'confirm_delete_ticket') {
                        await i.reply('سيتم حذف التذكرة خلال 3 ثوان...');

                        // حذف بيانات التذكرة من قاعدة البيانات
                        await Ticket.findOneAndDelete({ ticket_channel_id: message.channel.id });

                        setTimeout(async () => {
                            try {
                                await message.channel.delete();
                            } catch (error) {
                                console.error('Error deleting ticket channel:', error);
                            }
                        }, 3000);
                    } else if (i.customId === 'cancel_delete_ticket') {
                        await i.update({ 
                            content: 'تم إلغاء حذف التذكرة.', 
                            embeds: [], 
                            components: [] 
                        });
                    }
                });

                collector.on('end', collected => {
                    if (collected.size === 0) {
                        confirmMessage.edit({ 
                            content: 'انتهى وقت التأكيد. تم إلغاق حذف التذكرة.',
                            embeds: [],
                            components: []
                        }).catch(console.error);
                    }
                });
            } catch (error) {
                console.error('Error in !del command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر جمع الدخل من المناجم ومستخرجات النفط المتعددة
        if (message.content.startsWith('!جمع')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

                const mineCount = await getUserItemCount(message.author.id, 'المنجم');
                const oilExtractorCount = await getUserItemCount(message.author.id, 'مستخرج النفط');

                if (mineCount === 0 && oilExtractorCount === 0) {
                    return message.reply('لا تملك أي مناجم أو مستخرجات نفط لجمع الدخل منها.');
                }

                const now = new Date();
                const oneHour = 60 * 60 * 1000; // ساعة واحدة بالميلي ثانية

                let mineIncome = 0;
                let oilIncome = 0;
                let mineHours = 0;
                let oilHours = 0;

                if (mineCount > 0) {
                    const timeSinceLastMining = now - new Date(user.lastMiningCollected);
                    mineHours = Math.floor(timeSinceLastMining / oneHour);

                    if (mineHours > 0) {
                        // حساب الدخل للساعات المتراكمة (الحد الأقصى 24 ساعة) لكل منجم
                        const hoursToCalculate = Math.min(mineHours, 24);
                        for (let mine = 0; mine < mineCount; mine++) {
                            for (let hour = 0; hour < hoursToCalculate; hour++) {
                                mineIncome += Math.floor(Math.random() * (20000 - 2500 + 1)) + 2500;
                            }
                        }
                    }
                }

                if (oilExtractorCount > 0) {
                    const timeSinceLastOil = now - new Date(user.lastOilCollected);
                    oilHours = Math.floor(timeSinceLastOil / oneHour);

                    if (oilHours > 0) {
                        // حساب الدخل للساعات المتراكمة (الحد الأقصى 24 ساعة) لكل مستخرج
                        const hoursToCalculate = Math.min(oilHours, 24);
                        for (let extractor = 0; extractor < oilExtractorCount; extractor++) {
                            for (let hour = 0; hour < hoursToCalculate; hour++) {
                                oilIncome += Math.floor(Math.random() * (200000 - 50000 + 1)) + 50000;
                            }
                        }
                    }
                }

                const totalIncome = mineIncome + oilIncome;

                if (totalIncome === 0) {
                    return message.reply('لا يوجد دخل متاح للجمع. يجب أن تمر ساعة على الأقل منذ آخر جمع.');
                }

                // تحديث العملات وأوقات الجمع
                user.coins += totalIncome;
                if (mineHours > 0) {
                    user.lastMiningCollected = new Date(user.lastMiningCollected.getTime() + (Math.min(mineHours, 24) * oneHour));
                }
                if (oilHours > 0) {
                    user.lastOilCollected = new Date(user.lastOilCollected.getTime() + (Math.min(oilHours, 24) * oneHour));
                }

                await user.save();

                const embed = new discord.EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('💰 تم جمع الدخل بنجاح!')
                    .setDescription(`تم جمع الدخل من جميع مصادرك الاقتصادية`)
                    .addFields(
                        { name: '💎 إجمالي الدخل المجمع:', value: `**${totalIncome.toLocaleString()}** عملة`, inline: true },
                        { name: '💰 عملاتك الحالية:', value: `**${user.coins.toLocaleString()}** عملة`, inline: true }
                    )
                    .setFooter({ text: 'تذكر أن تجمع دخلك بانتظام!' })
                    .setTimestamp();

                if (mineIncome > 0) {
                    const avgMineIncome = Math.floor(mineIncome / mineCount / Math.min(mineHours, 24));
                    embed.addFields({
                        name: '⛏️ دخل المناجم:', 
                        value: `**${mineIncome.toLocaleString()}** عملة\n🔹 عدد المناجم: **${mineCount}**\n🔹 المدة: **${Math.min(mineHours, 24)}** ساعة\n🔹 متوسط الدخل لكل منجم: **${avgMineIncome.toLocaleString()}** عملة/ساعة`, 
                        inline: false 
                    });
                }

                if (oilIncome > 0) {
                    const avgOilIncome = Math.floor(oilIncome / oilExtractorCount / Math.min(oilHours, 24));
                    embed.addFields({
                        name: '🛢️ دخل مستخرجات النفط:', 
                        value: `**${oilIncome.toLocaleString()}** عملة\n🔹 عدد المستخرجات: **${oilExtractorCount}**\n🔹 المدة: **${Math.min(oilHours, 24)}** ساعة\n🔹 متوسط الدخل لكل مستخرج: **${avgOilIncome.toLocaleString()}** عملة/ساعة`, 
                        inline: false 
                    });
                }

                message.channel.send({ embeds: [embed] });
            } catch (error) {
                console.error('Error in !جمع command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }
        // أمر تسريح الجنود
        if (message.content.startsWith('!تسريح')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

                const troopTypes = [
                    { name: 'جنود عاديون', field: 'soldiers', count: user.soldiers || 0 },
                    { name: 'ضباط', field: 'officers', count: user.officers || 0 },
                    { name: 'عقداء', field: 'colonels', count: user.colonels || 0 },
                    { name: 'لوائات', field: 'generals', count: user.generals || 0 },
                    { name: 'جنود ضعيفي الهمة', field: 'lowMoraleSoldiers', count: user.lowMoraleSoldiers || 0 }
                ];

                const availableTypes = troopTypes.filter(type => type.count > 0);

                if (availableTypes.length === 0) {
                    return message.reply('ليس لديك أي جنود لتسريحهم.');
                }

                const embed = new discord.EmbedBuilder()
                    .setColor('#FF6B6B')
                    .setTitle('تسريح الجنود')
                    .setDescription('اختر نوع الجنود الذي تريد تسريحهم:')
                    .addFields(
                        availableTypes.map((type, index) => ({
                            name: `${index + 1}. ${type.name}`,
                            value: `العدد المتاح: ${type.count}`,
                            inline: true
                        }))
                    )
                    .setFooter({ text: 'اكتب رقم نوع الجنود الذي تريد تسريحهم.' });

                message.channel.send({ embeds: [embed] }).then(() => {
                    const filter = (response) => response.author.id === message.author.id;
                    const collector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

                    collector.on('collect', async (response) => {
                        try {
                            const typeIndex = parseInt(response.content.trim()) - 1;

                            if (isNaN(typeIndex) || typeIndex < 0 || typeIndex >= availableTypes.length) {
                                return message.reply('اختيار غير صحيح. يرجى المحاولة مرة أخرى.');
                            }

                            const selectedType = availableTypes[typeIndex];

                            message.reply(`كم عدد ${selectedType.name} الذي تريد تسريحه؟ (المتاح: ${selectedType.count})`).then(() => {
                                const quantityCollector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

                                quantityCollector.on('collect', async (quantityResponse) => {
                                    try {
                                        const quantity = parseInt(quantityResponse.content.trim());

                                        if (isNaN(quantity) || quantity <= 0) {
                                            return message.reply('يرجى إدخال عدد صحيح موجب.');
                                        }

                                        if (quantity > selectedType.count) {
                                            return message.reply(`ليس لديك ${quantity} من ${selectedType.name} للتسريح. المتاح: ${selectedType.count}`);
                                        }

                                        // إنشاء رسالة تأكيد
                                        const confirmEmbed = new discord.EmbedBuilder()
                                            .setColor('#FFA500')
                                            .setTitle('تأكيد التسريح')
                                            .setDescription(`هل أنت متأكد من تسريح ${quantity} من ${selectedType.name}؟`)
                                            .addFields(
                                                { name: 'نوع الجنود:', value: selectedType.name },
                                                { name: 'العدد المراد تسريحه:', value: quantity.toString() },
                                                { name: 'العدد المتبقي:', value: (selectedType.count - quantity).toString() }
                                            )
                                            .setFooter({ text: 'اضغط على "تأكيد" للتسريح أو "إلغاء" للإلغاء.' });

                                        const row = new discord.ActionRowBuilder()
                                            .addComponents(
                                                new discord.ButtonBuilder()
                                                    .setCustomId('confirm_discharge')
                                                    .setLabel('تأكيد التسريح')
                                                    .setStyle(discord.ButtonStyle.Danger),
                                                new discord.ButtonBuilder()
                                                    .setCustomId('cancel_discharge')
                                                    .setLabel('إلغاء')
                                                    .setStyle(discord.ButtonStyle.Secondary)
                                            );

                                        const confirmMessage = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

                                        const buttonFilter = i => i.user.id === message.author.id;
                                        const buttonCollector = confirmMessage.createMessageComponentCollector({ filter: buttonFilter, time: 30000 });

                                        buttonCollector.on('collect', async i => {
                                            if (i.customId === 'confirm_discharge') {
                                                try {
                                                    // تنفيذ التسريح
                                                    user[selectedType.field] -= quantity;
                                                    await user.save();

                                                    const successEmbed = new discord.EmbedBuilder()
                                                        .setColor('#00FF00')
                                                        .setTitle('تم التسريح بنجاح!')
                                                        .setDescription(`تم تسريح ${quantity} من ${selectedType.name} بنجاح.`)
                                                        .addFields(
                                                            { name: 'العدد المسرح:', value: quantity.toString() },
                                                            { name: 'العدد المتبقي:', value: user[selectedType.field].toString() }
                                                        )
                                                        .setFooter({ text: 'تم توفير راتب هؤلاء الجنود.' });

                                                    await i.update({ embeds: [successEmbed], components: [] });
                                                } catch (error) {
                                                    console.error('Error discharging troops:', error);
                                                    await i.update({ 
                                                        content: 'حدث خطأ أثناء تسريح الجنود. يرجى المحاولة مرة أخرى.',
                                                        embeds: [],
                                                        components: []
                                                    });
                                                }
                                            } else if (i.customId === 'cancel_discharge') {
                                                await i.update({ 
                                                    content: 'تم إلغاء عملية التسريح.',
                                                    embeds: [],
                                                    components: []
                                                });
                                            }
                                        });

                                        buttonCollector.on('end', collected => {
                                            if (collected.size === 0) {
                                                confirmMessage.edit({ 
                                                    content: 'انتهى وقت التأكيد. تم إلغاء عملية التسريح.',
                                                    embeds: [],
                                                    components: []
                                                }).catch(console.error);
                                            }
                                        });
                                    } catch (error) {
                                        console.error('Error processing discharge quantity:', error);
                                        message.reply('حدث خطأ أثناء معالجة عدد الجنود. يرجى المحاولة مرة أخرى.');
                                    }
                                });

                                quantityCollector.on('end', (collected) => {
                                    if (collected.size === 0) {
                                        message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                                    }
                                });
                            });
                        } catch (error) {
                            console.error('Error processing troop type selection:', error);
                            message.reply('حدث خطأ أثناء معالجة نوع الجنود. يرجى المحاولة مرة أخرى.');
                        }
                    });

                    collector.on('end', (collected) => {
                        if (collected.size === 0) {
                            message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                        }
                    });
                });
            } catch (error) {
                console.error('Error in !تسريح command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر إزالة جميع التحالفات (إدمن فقط)
        if (message.content.startsWith('!ازالة_الكل')) {
            try {
                if (!message.member.permissions.has('Administrator')) {
                    return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
                }

                const allAlliances = await Alliance.find();

                if (allAlliances.length === 0) {
                    return message.reply('لا توجد تحالفات لإزالتها.');
                }

                // إنشاء رسالة تأكيد
                const confirmEmbed = new discord.EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('تأكيد إزالة جميع التحالفات')
                    .setDescription('هل أنت متأكد من إزالة جميع التحالفات الموجودة بالكامل؟')
                    .addFields(
                        { name: 'تحذير:', value: 'سيتم إخراج جميع الأعضاء من كل التحالفات وحذفها نهائياً!' },
                        { name: 'عدد التحالفات:', value: allAlliances.length.toString() },
                        { name: 'إجمالي الأعضاء المتأثرين:', value: allAlliances.reduce((total, alliance) => total + (alliance.members ? alliance.members.length : 0), 0).toString() }
                    )
                    .setFooter({ text: 'اضغط على "تأكيد" للإزالة أو "إلغاء" للإلغاء.' });

                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('confirm_remove_all')
                            .setLabel('تأكيد الإزالة')
                            .setStyle(discord.ButtonStyle.Danger),
                        new discord.ButtonBuilder()
                            .setCustomId('cancel_remove_all')
                            .setLabel('إلغاء')
                            .setStyle(discord.ButtonStyle.Secondary)
                    );

                const confirmMessage = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

                const filter = i => i.user.id === message.author.id;
                const collector = confirmMessage.createMessageComponentCollector({ filter, time: 30000 });

                collector.on('collect', async i => {
                    if (i.customId === 'confirm_remove_all') {
                        try {
                            let totalMembersAffected = 0;
                            let totalAlliancesRemoved = 0;
                            let totalRolesDeleted = 0;

                            // حساب إجمالي الأعضاء المتأثرين
                            for (const alliance of allAlliances) {
                                totalMembersAffected += alliance.members ? alliance.members.length : 0;
                            }

                            // إزالة رتب التحالفات من جميع الأعضاء وحذف الرتب
                            for (const alliance of allAlliances) {
                                if (alliance.role_id) {
                                    try {
                                        // إزالة الرتبة من جميع الأعضاء
                                        for (const memberId of alliance.members || []) {
                                            try {
                                                const member = await message.guild.members.fetch(memberId);
                                                await member.roles.remove(alliance.role_id);
                                                console.log(`تم إزالة رتبة التحالف من العضو: ${memberId}`);
                                            } catch (memberError) {
                                                console.error(`خطأ في إزالة الرتبة من العضو ${memberId}:`, memberError);
                                            }
                                        }

                                        // حذف الرتبة من السيرفر
                                        const role = await message.guild.roles.fetch(alliance.role_id);
                                        if (role) {
                                            await role.delete('إزالة جميع التحالفات بواسطة المشرف');
                                            totalRolesDeleted++;
                                            console.log(`تم حذف رتبة التحالف: ${alliance.name}`);
                                        }
                                    } catch (roleError) {
                                        console.error(`خطأ في حذف رتبة التحالف ${alliance.name}:`, roleError);
                                    }
                                }
                            }

                            // إزالة التحالف من جميع الأعضاء
                            await User.updateMany(
                                { alliance_id: { $exists: true } },
                                { $unset: { alliance_id: "" }, $set: { alliance_rank: 'عضو' } }
                            );

                            // حذف جميع طلبات الانضمام
                            await AllianceRequest.deleteMany({});

                            // حذف جميع التحالفات
                            const deleteResult = await Alliance.deleteMany({});
                            totalAlliancesRemoved = deleteResult.deletedCount;

                            const successEmbed = new discord.EmbedBuilder()
                                .setColor('#FF0000')
                                .setTitle('تم إزالة جميع التحالفات بنجاح!')
                                .setDescription('تم إزالة جميع التحالفات الموجودة وإخراج جميع الأعضاء.')
                                .addFields(
                                    { name: 'المشرف:', value: message.author.username },
                                    { name: 'التحالفات المحذوفة:', value: totalAlliancesRemoved.toString() },
                                    { name: 'الرتب المحذوفة:', value: totalRolesDeleted.toString() },
                                    { name: 'إجمالي الأعضاء المتأثرين:', value: totalMembersAffected.toString() }
                                )
                                .setFooter({ text: 'تم إزالة جميع التحالفات ورتبها نهائياً بواسطة المشرف.' });

                            await i.update({ embeds: [successEmbed], components: [] });
                        } catch (error) {
                            console.error('Error removing all alliances:', error);
                            await i.update({ 
                                content: 'حدث خطأ أثناء إزالة التحالفات. يرجى المحاولة مرة أخرى.',
                                embeds: [],
                                components: []
                            });
                        }
                    } else if (i.customId === 'cancel_remove_all') {
                        await i.update({ 
                            content: 'تم إلغاء عملية إزالة جميع التحالفات.',
                            embeds: [],
                            components: []
                        });
                    }
                });

                collector.on('end', collected => {
                    if (collected.size === 0) {
                        confirmMessage.edit({ 
                            content: 'انتهى وقت التأكيد. تم إلغاء عملية الإزالة.',
                            embeds: [],
                            components: []
                        }).catch(console.error);
                    }
                });
            } catch (error) {
                console.error('Error in !ازالة_الكل command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر إزالة التحالف (إدمن فقط)
        if (message.content.startsWith('!ازالة')) {
            try {
                if (!message.member.permissions.has('Administrator')) {
                    return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
                }

                const args = message.content.split(' ');
                const allianceName = args.slice(1).join(' ').trim();

                if (!allianceName || allianceName === '') {
                    return message.reply('يجب تحديد اسم التحالف المراد إزالته.\nمثال: `!ازالة اسم التحالف`');
                }

                console.log(`البحث عن تحالف باسم: "${allianceName}"`);

                const alliance = await Alliance.findOne({ name: allianceName });
                if (!alliance) {
                    // عرض جميع التحالفات المتاحة للمساعدة
                    const allAlliances = await Alliance.find();
                    const alliancesList = allAlliances.map(a => a.name).join(', ');
                    return message.reply(`لم يتم العثور على تحالف بهذا الاسم: "${allianceName}"\nالتحالفات المتاحة: ${alliancesList || 'لا توجد تحالفات'}`);
                }

                // إنشاء رسالة تأكيد
                const confirmEmbed = new discord.EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('تأكيد إزالة التحالف')
                    .setDescription(`هل أنت متأكد من إزالة تحالف "${alliance.name}" بالكامل؟`)
                    .addFields(
                        { name: 'تحذير:', value: 'سيتم إخراج جميع الأعضاء من التحالف وحذفه نهائياً!' },
                        { name: 'عدد الأعضاء:', value: (alliance.members ? alliance.members.length : 0).toString() }
                    )
                    .setFooter({ text: 'اضغط على "تأكيد" للإزالة أو "إلغاء" للإلغاء.' });

                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('confirm_remove')
                            .setLabel('تأكيد الإزالة')
                            .setStyle(discord.ButtonStyle.Danger),
                        new discord.ButtonBuilder()
                            .setCustomId('cancel_remove')
                            .setLabel('إلغاء')
                            .setStyle(discord.ButtonStyle.Secondary)
                    );

                const confirmMessage = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

                const filter = i => i.user.id === message.author.id;
                const collector = confirmMessage.createMessageComponentCollector({ filter, time: 30000 });

                collector.on('collect', async i => {
                    if (i.customId === 'confirm_remove') {
                        try {
                            // إزالة رتبة التحالف من جميع الأعضاء وحذف الرتبة
                            if (alliance.role_id) {
                                try {
                                    // إزالة الرتبة من جميع الأعضاء
                                    for (const memberId of alliance.members) {
                                        try {
                                            const member = await message.guild.members.fetch(memberId);
                                            await member.roles.remove(alliance.role_id);
                                            console.log(`تم إزالة رتبة التحالف من العضو: ${memberId}`);
                                        } catch (memberError) {
                                            console.error(`خطأ في إزالة الرتبة من العضو ${memberId}:`, memberError);
                                        }
                                    }

                                    // حذف الرتبة من السيرفر
                                    const role = await message.guild.roles.fetch(alliance.role_id);
                                    if (role) {
                                        await role.delete('إزالة تحالف بواسطة المشرف');
                                        console.log(`تم حذف رتبة التحالف: ${alliance.name}`);
                                    }
                                } catch (roleError) {
                                    console.error('خطأ في حذف رتبة التحالف:', roleError);
                                }
                            }

                            // إزالة التحالف من جميع الأعضاء
                            await User.updateMany(
                                { alliance_id: alliance.id },
                                { $unset: { alliance_id: "" }, $set: { alliance_rank: 'عضو' } }
                            );

                            // حذف جميع طلبات الانضمام للتحالف
                            await AllianceRequest.deleteMany({ alliance_id: alliance.id });

                            // حذف التحالف
                            await Alliance.deleteOne({ id: alliance.id });

                            const successEmbed = new discord.EmbedBuilder()
                                .setColor('#FF0000')
                                .setTitle('تم إزالة التحالف بنجاح!')
                                .setDescription(`تم إزالة تحالف "${alliance.name}" بالكامل وإخراج جميع الأعضاء.`)
                                .addFields(
                                    { name: 'المشرف:', value: message.author.username },
                                    { name: 'الأعضاء المتأثرين:', value: (alliance.members ? alliance.members.length : 0).toString() },
                                    { name: 'تم حذف:', value: '✅ التحالف\n✅ رتبة التحالف\n✅ عضوية جميع الأعضاء' }
                                )
                                .setFooter({ text: 'تم إزالة التحالف نهائياً بواسطة المشرف.' });

                            await i.update({ embeds: [successEmbed], components: [] });
                        } catch (error) {
                            console.error('Error removing alliance:', error);
                            await i.update({ 
                                content: 'حدث خطأ أثناء إزالة التحالف. يرجى المحاولة مرة أخرى.',
                                embeds: [],
                                components: []
                            });
                        }
                    } else if (i.customId === 'cancel_remove') {
                        await i.update({ 
                            content: 'تم إلغاء عملية إزالة التحالف.',
                            embeds: [],
                            components: []
                        });
                    }
                });

                collector.on('end', collected => {
                    if (collected.size === 0) {
                        confirmMessage.edit({ 
                            content: 'انتهى وقت التأكيد. تم إلغاء عملية الإزالة.',
                            embeds: [],
                            components: []
                        }).catch(console.error);
                    }
                });
            } catch (error) {
                console.error('Error in !ازالة command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر مراقبة قاعدة البيانات
        if (message.content.startsWith('!قاعدة_البيانات') || message.content.startsWith('!database')) {
            try {
                if (!message.member.permissions.has(discord.PermissionFlagsBits.Administrator)) {
                    return message.reply('❌ هذا الأمر مخصص للمدراء فقط.');
                }

                const stats = getDatabaseStats();
                const currentSize = await checkDatabaseSize();

                const dbEmbed = new discord.EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('📊 إحصائيات قاعدة البيانات')
                    .addFields(
                        { name: '💾 الحجم الحالي', value: `${currentSize}MB / ${DB_MANAGEMENT_CONFIG.MAX_DB_SIZE}MB`, inline: true },
                        { name: '📈 نسبة الاستخدام', value: `${stats.sizeUtilization}%`, inline: true },
                        { name: '🧹 إجمالي التنظيف', value: stats.totalCleaned.toLocaleString(), inline: true },
                        { name: '🔄 عمليات التنظيف', value: stats.cleanupOperations.toString(), inline: true },
                        { name: '⏰ آخر تنظيف', value: `منذ ${Math.floor((Date.now() - stats.lastCleanup) / (1000 * 60))} دقيقة`, inline: true },
                        { name: '📊 معدل التنظيف', value: `${stats.cleanupRate.toFixed(2)} عملية/ساعة`, inline: true }
                    )
                    .setTimestamp();

                // إضافة تحذيرات حسب نسبة الاستخدام
                if (stats.sizeUtilization >= 95) {
                    dbEmbed.setColor('#ff0000').setDescription('🚨 **تحذير حرج**: قاعدة البيانات ممتلئة تقريباً!');
                } else if (stats.sizeUtilization >= 80) {
                    dbEmbed.setColor('#ffaa00').setDescription('⚠️ **تحذير**: قاعدة البيانات تقترب من الامتلاء');
                } else {
                    dbEmbed.setColor('#00ff00').setDescription('✅ **حالة جيدة**: قاعدة البيانات تعمل بكفاءة');
                }

                const actionRow = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('force_cleanup')
                            .setLabel('🧹 تنظيف فوري')
                            .setStyle(discord.ButtonStyle.Primary),
                        new discord.ButtonBuilder()
                            .setCustomId('deep_cleanup')
                            .setLabel('🔧 تنظيف شامل')
                            .setStyle(discord.ButtonStyle.Secondary),
                        new discord.ButtonBuilder()
                            .setCustomId('emergency_cleanup')
                            .setLabel('🚨 تنظيف طارئ')
                            .setStyle(discord.ButtonStyle.Danger)
                    );

                await message.reply({ embeds: [dbEmbed], components: [actionRow] });

            } catch (error) {
                console.error('Error in database stats command:', error);
                message.reply('❌ حدث خطأ أثناء جلب إحصائيات قاعدة البيانات.');
            }
        }
        // أمر عرض العلاقات والتحالفات المحاربة
        if (message.content.startsWith('!العلاقات')) {
            try {
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                const alliance = await Alliance.findOne({ id: user.alliance_id });
                if (!alliance) return message.reply('لم يتم العثور على تحالفك.');

                if (!alliance.wars || alliance.wars.length === 0) {
                    const peaceEmbed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('🕊️ حالة السلام')
                        .setDescription(`تحالف "${alliance.name}" في حالة سلام`)
                        .addFields(
                            { name: '⚔️ الحروب النشطة:', value: 'لا توجد حروب حالياً' },
                            { name: '🏛️ التحالف:', value: alliance.name },
                            { name: '👥 عدد الأعضاء:', value: alliance.members.length.toString() }
                        )
                        .setFooter({ text: 'استمتع بفترة السلام!' });

                    return message.channel.send({ embeds: [peaceEmbed] });
                }

                // الحصول على معلومات التحالفات المحاربة
                const warringAlliances = await Alliance.find({ id: { $in: alliance.wars } });

                const embed = new discord.EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('⚔️ العلاقات والحروب')
                    .setDescription(`حروب تحالف "${alliance.name}"`)
                    .addFields(
                        { name: '🏛️ تحالفك:', value: alliance.name },
                        { name: '👥 أعضاء تحالفك:', value: alliance.members.length.toString() },
                        { name: '⚔️ عدد الحروب النشطة:', value: warringAlliances.length.toString() }
                    );

                // إضافة معلومات كل تحالف محارب
                for (let i = 0; i < Math.min(warringAlliances.length, 5); i++) {
                    const enemyAlliance = warringAlliances[i];
                    try {
                        const leader = await client.users.fetch(enemyAlliance.leader_id);

                        // حساب مدة الحرب
                        const warStartTime = alliance.created_at || new Date();
                        const warDuration = Math.floor((Date.now() - warStartTime.getTime()) / (1000 * 60 * 60 * 24));

                        embed.addFields({
                            name: `🔥 ${enemyAlliance.name}`,
                            value: `👑 القائد: ${leader.username}\n👥 الأعضاء: ${enemyAlliance.members.length}\n⏱️ مدة الحرب: ${warDuration} يوم`,
                            inline: true
                        });
                    } catch (error) {
                        embed.addFields({
                            name: `🔥 ${enemyAlliance.name}`,
                            value: `👑 القائد: غير متوفر\n👥 الأعضاء: ${enemyAlliance.members.length}\n⏱️ مدة الحرب: غير محددة`,
                            inline: true
                        });
                    }
                }

                if (warringAlliances.length > 5) {
                    embed.addFields({
                        name: '📊 المزيد من الحروب:',
                        value: `وتحالفات أخرى... (${warringAlliances.length - 5} إضافية)`,
                        inline: false
                    });
                }

                embed.setFooter({ text: 'استخدم !سلام لطلب السلام مع تحالف معين' });

                // إضافة أزرار تفاعلية
                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('refresh_relations')
                            .setLabel('🔄 تحديث')
                            .setStyle(discord.ButtonStyle.Secondary),
                        new discord.ButtonBuilder()
                            .setCustomId('alliance_stats')
                            .setLabel('📊 إحصائيات التحالف')
                            .setStyle(discord.ButtonStyle.Primary)
                    );

                const relationsMessage = await message.channel.send({ 
                    embeds: [embed], 
                    components: [row] 
                });

                // معالج الأزرار
                const filter = i => i.user.id === message.author.id;
                const collector = relationsMessage.createMessageComponentCollector({
                    filter,
                    time: 120000
                });

                collector.on('collect', async i => {
                    if (i.customId === 'refresh_relations') {
                        // تحديث البيانات وإعادة عرضها
                        const updatedAlliance = await Alliance.findOne({ id: user.alliance_id });
                        const updatedWarringAlliances = await Alliance.find({ id: { $in: updatedAlliance.wars } });

                        const updatedEmbed = new discord.EmbedBuilder()
                            .setColor('#FF0000')
                            .setTitle('⚔️ العلاقات والحروب (محدث)')
                            .setDescription(`حروب تحالف "${updatedAlliance.name}"`)
                            .addFields(
                                { name: '🏛️ تحالفك:', value: updatedAlliance.name },
                                { name: '👥 أعضاء تحالفك:', value: updatedAlliance.members.length.toString() },
                                { name: '⚔️ عدد الحروب النشطة:', value: updatedWarringAlliances.length.toString() }
                            )
                            .setFooter({ text: 'تم التحديث • ' + new Date().toLocaleString('ar-SA') });

                        await i.update({ embeds: [updatedEmbed] });

                    } else if (i.customId === 'alliance_stats') {
                        // عرض إحصائيات مفصلة للتحالف
                        const members = await User.find({ alliance_id: alliance.id });
                        const totalPower = members.reduce((sum, member) => {
                            return sum + (member.soldiers || 0) * 5 + (member.officers || 0) * 10 + 
                                   (member.colonels || 0) * 15 + (member.generals || 0) * 25 + 
                                   (member.lowMoraleSoldiers || 0) * 2;
                        }, 0);
                        const totalCoins = members.reduce((sum, member) => sum + (member.coins || 0), 0);

                        const statsEmbed = new discord.EmbedBuilder()
                            .setColor('#1E90FF')
                            .setTitle('📊 إحصائيات التحالف')
                            .setDescription(`إحصائيات شاملة لتحالف "${alliance.name}"`)
                            .addFields(
                                { name: '⚡ إجمالي القوة:', value: totalPower.toLocaleString(), inline: true },
                                { name: '💰 إجمالي العملات:', value: totalCoins.toLocaleString(), inline: true },
                                { name: '👥 عدد الأعضاء:', value: members.length.toString(), inline: true },
                                { name: '⚔️ الحروب النشطة:', value: (alliance.wars || []).length.toString(), inline: true },
                                { name: '📅 تاريخ التأسيس:', value: alliance.created_at.toLocaleDateString('ar-SA'), inline: true },
                                { name: '👑 القائد:', value: `<@${alliance.leader_id}>`, inline: true }
                            )
                            .setFooter({ text: 'إحصائيات محدثة' })
                            .setTimestamp();

                        await i.reply({ embeds: [statsEmbed], ephemeral: true });
                    }
                });

                collector.on('end', () => {
                    const disabledRow = new discord.ActionRowBuilder()
                        .addComponents(
                            new discord.ButtonBuilder()
                                .setCustomId('refresh_relations')
                                .setLabel('🔄 تحديث')
                                .setStyle(discord.ButtonStyle.Secondary)
                                .setDisabled(true),
                            new discord.ButtonBuilder()
                                .setCustomId('alliance_stats')
                                .setLabel('📊 إحصائيات التحالف')
                                .setStyle(discord.ButtonStyle.Primary)
                                .setDisabled(true)
                        );

                    relationsMessage.edit({ components: [disabledRow] }).catch(console.error);
                });

            } catch (error) {
                console.error('Error in !العلاقات command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر عرض أعضاء التحالف
        if (message.content.startsWith('!الاعضاء')) {
            try {
                   if (!PublicCategory.includes(message.channel.parentId)) {
                    return message.reply('هذا الأمر متاح فقط في القنوات العامة للتحالفات.');
                }
                const user = await User.findOne({ id: message.author.id });
                if (!user || !user.alliance_id) return message.reply('أنت لست عضواً في أي تحالف.');

                const alliance = await Alliance.findOne({ id: user.alliance_id });
                if (!alliance) return message.reply('لم يتم العثور على تحالفك.');

                const members = await User.find({ alliance_id: user.alliance_id });

                if (members.length === 0) {
                    return message.reply('لا توجد أعضاء في التحالف.');
                }

                // ترتيب الأعضاء حسب الرتبة
                const rankOrder = { 'قائد التحالف': 1, 'مشرف التحالف': 2, 'عضو': 3 };
                members.sort((a, b) => rankOrder[a.alliance_rank] - rankOrder[b.alliance_rank]);

                const membersPerPage = 8;
                const totalPages = Math.ceil(members.length / membersPerPage);
                let currentPage = 1;

                const getRankEmoji = (rank) => {
                    switch (rank) {
                        case 'قائد التحالف': return '👑';
                        case 'مشرف التحالف': return '⭐';
                        case 'عضو': return '🛡️';
                        default: return '👤';
                    }
                };

                const generateEmbed = async (page) => {
                    const startIndex = (page - 1) * membersPerPage;
                    const endIndex = startIndex + membersPerPage;
                    const currentMembers = members.slice(startIndex, endIndex);

                    const embed = new discord.EmbedBuilder()
                        .setColor('#00BFFF')
                        .setTitle(`أعضاء تحالف ${alliance.name}`)
                        .setDescription(`صفحة ${page} من ${totalPages}`)
                        .setFooter({ text: `إجمالي الأعضاء: ${members.length}` });

                    for (const member of currentMembers) {
                        try {
                            const memberUser = await client.users.fetch(member.id);
                            const rankEmoji = getRankEmoji(member.alliance_rank);

                            embed.addFields({
                                name: `${rankEmoji} ${member.army_name}`,
                                value: `👤 ${memberUser.username}\n🏅 الرتبة: ${member.alliance_rank}\n⚔️ الجنود: ${member.soldiers}\n💰 العملات: ${member.coins}`,
                                inline: true
                            });
                        } catch (error) {
                            const rankEmoji = getRankEmoji(member.alliance_rank);
                            embed.addFields({
                                name: `${rankEmoji} ${member.army_name}`,
                                value: `👤 غير متوفر\n🏅 الرتبة: ${member.alliance_rank}\n⚔️ الجنود: ${member.soldiers}\n💰 العملات: ${member.coins}`,
                                inline: true
                            });
                        }
                    }

                    return embed;
                };

                const embed = await generateEmbed(currentPage);

                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('prev_members')
                            .setLabel('السابق')
                            .setStyle(discord.ButtonStyle.Secondary)
                            .setEmoji('⬅️')
                            .setDisabled(currentPage === 1),
                        new discord.ButtonBuilder()
                            .setCustomId('next_members')
                            .setLabel('التالي')
                            .setStyle(discord.ButtonStyle.Secondary)
                            .setEmoji('➡️')
                            .setDisabled(currentPage === totalPages)
                    );

                const membersMessage = await message.channel.send({ 
                    embeds: [embed], 
                    components: totalPages > 1 ? [row] : [] 
                });

                if (totalPages > 1) {
                    const filter = i => i.user.id === message.author.id;
                    const collector = membersMessage.createMessageComponentCollector({
                        filter,
                        time: 120000
                    });

                    collector.on('collect', async i => {
                        if (i.customId === 'prev_members') {
                            currentPage--;
                        } else if (i.customId === 'next_members') {
                            currentPage++;
                        }

                        const newEmbed = await generateEmbed(currentPage);
                        const newRow = new discord.ActionRowBuilder()
                            .addComponents(
                                new discord.ButtonBuilder()
                                    .setCustomId('prev_members')
                                    .setLabel('السابق')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setEmoji('⬅️')
                                    .setDisabled(currentPage === 1),
                                new discord.ButtonBuilder()
                                    .setCustomId('next_members')
                                    .setLabel('التالي')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setEmoji('➡️')
                                    .setDisabled(currentPage === totalPages)
                            );

                        await i.update({ embeds: [newEmbed], components: [newRow] });
                    });

                    collector.on('end', () => {
                        const disabledRow = new discord.ActionRowBuilder()
                            .addComponents(
                                new discord.ButtonBuilder()
                                    .setCustomId('prev_members')
                                    .setLabel('السابق')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setEmoji('⬅️')
                                    .setDisabled(true),
                                new discord.ButtonBuilder()
                                    .setCustomId('next_members')
                                    .setLabel('التالي')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setEmoji('➡️')
                                    .setDisabled(true)
                            );

                        membersMessage.edit({ components: [disabledRow] }).catch(console.error);
                    });
                }
            } catch (error) {
                console.error('Error in !الاعضاء command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر إضافة العملات
        if (message.content.startsWith('!اضافة_عملات')) {
            try {
                if (!message.member.permissions.has('Administrator')) {
                    return message.channel.send('عذراً، ليس لديك صلاحية لاستخدام هذا الأمر.');
                }

                const args = message.content.split(' ');
                const targetUser = message.mentions.users.first();
                const coinsToAdd = parseInt(args[2]);

                if (!targetUser || isNaN(coinsToAdd) || coinsToAdd <= 0) {
                    return message.reply('يرجى تحديد مستخدم صالح ومبلغ صحيح من العملات.');
                }

                const user = await User.findOne({ id: targetUser.id });
                if (!user) {
                    return message.reply('لم يتم العثور على ملف شخصي لهذا المستخدم.');
                }

                user.coins += coinsToAdd;
                await user.save();
                message.reply(`تم إضافة ${coinsToAdd} عملة إلى حساب ${targetUser.username} بنجاح!`);
            } catch (error) {
                console.error('Error in !اضافة_عملات command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر تحويل نظام المخزون (للمشرفين فقط)
        if (message.content.startsWith('!تحويل_المخزون')) {
            try {
                if (!message.member.permissions.has('Administrator')) {
                    return message.reply('عذراً، ليس لديك صلاحية لاستخدام هذا الأمر.');
                }

                message.reply('🔄 بدء تحويل نظام المخزون...');
                
                const result = await migrateInventorySystem();
                
                if (result.error) {
                    message.reply(`❌ حدث خطأ أثناء التحويل: ${result.error}`);
                } else {
                    const embed = new discord.EmbedBuilder()
                        .setColor(result.emergency ? '#FFA500' : '#00FF00')
                        .setTitle(
                            result.emergency ? '⚠️ تم تحويل نظام المخزون بالوضع الطارئ' : 
                            result.simple ? '✅ تم تحويل نظام المخزون بالطريقة البسيطة' :
                            '✅ تم تحويل نظام المخزون بنجاح'
                        )
                        .addFields(
                            { name: '📦 المجموعات المحولة', value: `${result.migratedCount}`, inline: true },
                            { name: '🔧 العناصر المحدثة', value: `${result.updatedCount}`, inline: true }
                        )
                        .setDescription(
                            result.emergency ? 
                                'تم استخدام الوضع الطارئ لتحديث العناصر. تم تحديث العناصر بدون كمية محددة فقط.\n\n**ملاحظة:** قد تحتاج لتشغيل الأمر مرة أخرى في وقت لاحق لمعالجة العناصر المكررة.' :
                            result.simple ?
                                'تم تحويل المخزون باستخدام الطريقة البسيطة (بدون aggregation) لتجنب مشاكل الذاكرة.\n\n**الفوائد:**\n• تقليل استخدام قاعدة البيانات بشكل كبير\n• أداء أسرع للبوت\n• حد أقصى 100 منجم و 100 مستخرج نفط لكل لاعب' :
                                'تم تحويل جميع العناصر المكررة إلى نظام الكمية الجديد.\n\n**الفوائد:**\n• تقليل استخدام قاعدة البيانات بشكل كبير\n• أداء أسرع للبوت\n• حد أقصى 100 منجم و 100 مستخرج نفط لكل لاعب'
                        )
                        .setTimestamp();

                    message.reply({ embeds: [embed] });
                }
                
            } catch (error) {
                console.error('Error in migration command:', error);
                message.reply('❌ حدث خطأ أثناء تنفيذ التحويل.');
            }
        }
        // أمر لتصفير جنود اللاعب وممتلكاته وجيشه، يمكن استخدامه فقط من قبل المستخدمين الذين لديهم صلاحيات Administrator
if (message.content.startsWith('!تصفير')) {
    try {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('عذراً، ليس لديك صلاحية لاستخدام هذا الأمر.');
        }

        const targetUser = message.mentions.users.first();
        if (!targetUser) {
            return message.reply('يرجى تحديد مستخدم صالح للتصفير.');
        }

        const user = await User.findOne({ id: targetUser.id });
        if (!user) {
            return message.reply('لم يتم العثور على ملف شخصي لهذا المستخدم.');
        }

        // التحقق من أن اللاعب قائد تحالف وحذف التحالف قبل التصفير
        if (user.alliance_id && user.alliance_rank === 'قائد التحالف') {
            console.log(`🚨 تصفير قائد التحالف ${targetUser.id}، سيتم حذف التحالف`);

            const alliance = await Alliance.findOne({ id: user.alliance_id });
            if (alliance && alliance.leader_id === targetUser.id) {
                console.log(`🗑️ حذف التحالف "${alliance.name}" بسبب تصفير القائد`);

                // إزالة رتبة التحالف من جميع الأعضاء وحذف الرتبة
                if (alliance.role_id) {
                    try {
                        console.log(`🏷️ حذف رتبة التحالف: ${alliance.role_id}`);

                        // إزالة الرتبة من جميع الأعضاء في جميع السيرفرات
                        for (const memberId of alliance.members || []) {
                            try {
                                let memberFound = false;

                                // البحث في جميع السيرفرات
                                for (const guild of client.guilds.cache.values()) {
                                    try {
                                        const member = await guild.members.fetch(memberId);
                                        if (member && member.roles.cache.has(alliance.role_id)) {
                                            await member.roles.remove(alliance.role_id);
                                            console.log(`✅ تم إزالة رتبة التحالف من العضو: ${memberId} في السيرفر: ${guild.name}`);
                                            memberFound = true;
                                        }
                                    } catch (memberError) {
                                        // تجاهل الأخطاء والمتابعة
                                        continue;
                                    }
                                }

                                if (!memberFound) {
                                    console.log(`⚠️ لم يتم العثور على العضو ${memberId} في أي سيرفر`);
                                }
                            } catch (memberError) {
                                console.error(`❌ خطأ في إزالة الرتبة من العضو ${memberId}:`, memberError);
                            }
                        }

                        // حذف الرتبة من جميع السيرفرات
                        let roleDeleted = false;
                        for (const guild of client.guilds.cache.values()) {
                            try {
                                const role = await guild.roles.fetch(alliance.role_id);
                                if (role) {
                                    await role.delete('حذف تحالف بسبب تصفير القائد');
                                    console.log(`✅ تم حذف رتبة التحالف: ${alliance.name} من السيرفر: ${guild.name}`);
                                    roleDeleted = true;
                                    break; // الرتبة موجودة في سيرفر واحد فقط عادة
                                }
                            } catch (roleError) {
                                console.error(`❌ خطأ في حذف الرتبة من السيرفر ${guild.name}:`, roleError);
                                continue;
                            }
                        }

                        if (!roleDeleted) {
                            console.log(`⚠️ لم يتم العثور على رتبة التحالف ${alliance.role_id} في أي سيرفر`);
                        }
                    } catch (roleError) {
                        console.error('❌ خطأ عام في حذف رتبة التحالف:', roleError);
                    }
                }

                // إشعار الأعضاء السابقين
                console.log(`📤 إرسال إشعارات للأعضاء...`);
                const members = await User.find({ alliance_id: alliance.id });
                let notifiedCount = 0;

                for (const member of members) {
                    try {
                        if (member.id !== targetUser.id) {
                            const memberUser = await client.users.fetch(member.id);
                            const embed = new discord.EmbedBuilder()
                                .setColor('#FF0000')
                                .setTitle('🚨 تم حل التحالف!')
                                .setDescription(`تم حل تحالف **"${alliance.name}"** بسبب تصفير القائد`)
                                .addFields(
                                    { name: '📋 السبب:', value: 'تصفير القائد بواسطة الإدارة' },
                                    { name: '⏰ التوقيت:', value: new Date().toLocaleString('ar-SA') },
                                    { name: '🔄 الخطوات التالية:', value: 'يمكنك الانضمام إلى تحالف آخر أو إنشاء تحالف جديد' }
                                )
                                .setFooter({ text: 'تم حل التحالف بواسطة الإدارة' })
                                .setTimestamp();

                            await memberUser.send({ embeds: [embed] });
                            notifiedCount++;
                            console.log(`✅ تم إشعار العضو: ${member.id}`);
                        }
                    } catch (error) {
                        console.error(`❌ خطأ في إرسال إشعار للعضو ${member.id}:`, error);
                    }
                }

                console.log(`📊 تم إشعار ${notifiedCount} عضو من أصل ${members.length - 1} أعضاء`);

                // إزالة التحالف من جميع الأعضاء
                console.log(`🗑️ إزالة التحالف من بيانات الأعضاء...`);
                const updateResult = await User.updateMany(
                    { alliance_id: alliance.id },
                    { $unset: { alliance_id: "" }, $set: { alliance_rank: 'عضو' } }
                );
                console.log(`✅ تم تحديث بيانات ${updateResult.modifiedCount} عضو`);

                // حذف جميع طلبات الانضمام للتحالف
                console.log(`🗑️ حذف طلبات الانضمام للتحالف...`);
                const deleteRequestsResult = await AllianceRequest.deleteMany({ alliance_id: alliance.id });
                console.log(`✅ تم حذف ${deleteRequestsResult.deletedCount} طلب انضمام`);

                // حذف التحالف
                console.log(`🗑️ حذف التحالف من قاعدة البيانات...`);
                const deleteAllianceResult = await Alliance.deleteOne({ id: alliance.id });

                if (deleteAllianceResult.deletedCount > 0) {
                    console.log(`✅ تم حذف التحالف "${alliance.name}" بنجاح بسبب تصفير القائد ${targetUser.id}`);
                } else {
                    console.error(`❌ فشل في حذف التحالف "${alliance.name}" من قاعدة البيانات`);
                }
            }
        }

        await User.deleteOne({ id: targetUser.id });
        await UserItem.deleteMany({ user_id: targetUser.id });

        message.reply(`تم تصفير جميع الجنود والممتلكات والجيش الخاص بـ ${targetUser.username} بنجاح.`);
    } catch (error) {
        console.error('Error in !تصفير command:', error);
        message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
    }
}
        // أمر لإظهار أقوى 10 لاعبين من ناحية عدد الجنود
if (message.content.startsWith('!توب')) {
    try {
        const allUsers = await User.find();

        // حساب القوة الإجمالية لكل لاعب
        const usersWithPower = allUsers.map(user => {
            const totalPower = 
                (user.soldiers || 0) * 5 + 
                (user.officers || 0) * 10 + 
                (user.colonels || 0) * 15 + 
                (user.generals || 0) * 25 + 
                (user.lowMoraleSoldiers || 0) * 2;

            const totalTroops = 
                (user.soldiers || 0) + 
                (user.officers || 0) + 
                (user.colonels || 0) + 
                (user.generals || 0) + 
                (user.lowMoraleSoldiers || 0);

            return {
                ...user.toObject(),
                totalPower,
                totalTroops
            };
        });

        const topUsers = usersWithPower.sort((a, b) => b.totalPower - a.totalPower).slice(0, 10);

        if (topUsers.length === 0) {
            return message.reply('لا يوجد أي لاعبين في قاعدة البيانات.');
        }

        const embed = new discord.EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('أقوى 10 جيوش')
            .setDescription('ترتيب أقوى اللاعبين بناءً على القوة الإجمالية:')
            .addFields(
                topUsers.map((user, index) => ({
                    name: `${index + 1}. ${user.army_name}`,
                    value: `القوة الإجمالية: ${user.totalPower}\nإجمالي الجنود: ${user.totalTroops}`,
                    inline: true
                }))
            )
            .setFooter({ text: 'حظًا موفقًا للجميع!' });

        message.channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Error in !توب command:', error);
        message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
    }
}

        // أمر لإنشاء الجيش
        if (message.content.startsWith('!البدء')) {
            try {
                // استخراج اسم الجيش من النص الكامل (دعم أسماء متعددة الكلمات)
                const armyName = message.content.split(' ').slice(1).join(' ').trim();

                if (!armyName || armyName === '') {
                    return message.reply('يجب عليك تحديد اسم للجيش بعد الأمر.\nمثال: `!البدء جيش النصر العظيم`');
                }

                // التحقق من طول الاسم
                if (armyName.length > 50) {
                    return message.reply('اسم الجيش طويل جداً! الحد الأقصى 50 حرف.');
                }

                // التحقق من وجود أحرف غير مسموحة
                const forbiddenChars = ['@', '#', '`', '*', '_', '~', '|'];
                for (const char of forbiddenChars) {
                    if (armyName.includes(char)) {
                        return message.reply(`اسم الجيش يحتوي على أحرف غير مسموحة: ${forbiddenChars.join(', ')}`);
                    }
                }

                const user = await User.findOne({ id: message.author.id });
                if (user) {
                    return message.reply('لقد بدأت بالفعل جيشاً!');
                } else {
                    const newUser = new User({ 
                        id: message.author.id, 
                        army_name: armyName, 
                        soldiers: 100, 
                        officers: 0,
                        colonels: 0,
                        generals: 0,
                        lowMoraleSoldiers: 0,
                        coins: 0,
                        lastSalaryPaid: new Date()
                    });
                    await newUser.save();

                    const startEmbed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('🎖️ تم إنشاء الجيش بنجاح!')
                        .setDescription(`مرحباً بك في عالم الحروب والتحالفات!`)
                        .addFields(
                            { name: '🏛️ اسم الجيش:', value: `**${armyName}**` },
                            { name: '⚔️ الجنود الأوليين:', value: '**100** جندي' },
                            { name: '💰 العملات الأولية:', value: '**0** عملة' },
                            { name: '📖 التعليمات:', value: 'استخدم `!شراء` لشراء جنود\nاستخدم `!غارة` لكسب العملات\nاستخدم `!profile` لرؤية ملفك الشخصي' }
                        )
                        .setFooter({ text: 'حظاً موفقاً في بناء إمبراطوريتك!' })
                        .setTimestamp();

                    message.reply({ embeds: [startEmbed] });
                }
            } catch (error) {
                console.error('Error in !البدء command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }


        // امر لقتال الوحوش
        if (message.content.startsWith('!غارة')) {
            try {
               if (!raidCategory.includes(message.channel.parentId)) {
                    return message.reply('هذا الأمر متاح فقط في قنوات الغارات.');
                }

                const user = await User.findOne({ id: message.author.id });
                if (!user) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

                if (user.soldiers <= 0) {
                    const noTroopsEmbed = new discord.EmbedBuilder()
                        .setColor('#DC143C')
                        .setTitle('⚠️ لا توجد قوات كافية!')
                        .setDescription('```diff\n- لا تمتلك جنودًا كافيين للهجوم!\n```')
                        .addFields(
                            { name: '💡 نصيحة:', value: 'استخدم `!البدء` لإنشاء جيش جديد أو `!شراء` لشراء المزيد من الجنود' }
                        )
                        .setFooter({ text: '⚔️ تحتاج لجنود للقتال!' })
                        .setTimestamp();

                    return message.reply({ embeds: [noTroopsEmbed] });
                }

                let attackCount = parseInt(message.content.split(' ')[1]) || 1;
                if (attackCount <= 0) {
                    const invalidEmbed = new discord.EmbedBuilder()
                        .setColor('#FF6B6B')
                        .setTitle('❌ رقم غير صحيح')
                        .setDescription('يرجى إدخال عدد صحيح للهجمات')
                        .addFields(
                            { name: '📝 مثال:', value: '`!غارة 5` للقيام بـ 5 غارات' }
                        );
                    return message.reply({ embeds: [invalidEmbed] });
                }

                if (attackCount > 3000) {
                    const limitEmbed = new discord.EmbedBuilder()
                        .setColor('#FFA500')
                        .setTitle('⚠️ تجاوز الحد الأقصى')
                        .setDescription('لا يمكنك تنفيذ أكثر من 3000 غارة في أمر واحد')
                        .addFields(
                            { name: '🔄 الحد الأقصى:', value: '3000 غارة لكل أمر' }
                        );
                    return message.channel.send({ embeds: [limitEmbed] });
                }

                // إضافة رسالة تحضيرية للمعركة
                const preparingEmbed = new discord.EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('🔥 بدء الغارة!')
                    .setDescription(`⚔️ **${user.army_name}** يستعد للمعركة!`)
                    .addFields(
                        { name: '🪖 القوات المرسلة:', value: `${user.soldiers} جندي`, inline: true },
                        { name: '🎯 عدد الغارات:', value: `${attackCount} غارة`, inline: true },
                        { name: '⏳ الحالة:', value: '🔄 جاري القتال...', inline: true }
                    )
                    .setFooter({ text: '⚔️ المعركة في تقدم...' })
                    .setTimestamp();

                const preparingMessage = await message.channel.send({ embeds: [preparingEmbed] });

                // تأخير لإضافة التشويق
                await new Promise(resolve => setTimeout(resolve, 2000));

                let totalDamage = 0;
                let totalCoins = 0;
                let newSoldiers = user.soldiers;
                let battlesWon = 0;
                let battlesLost = 0;

                for (let i = 0; i < attackCount; i++) {
                    if (newSoldiers <= 0) break;

                    let damage = Math.floor(Math.random() * 50) + 10;
                    let coinsEarned = Math.floor(Math.random() * 20) + 5;

                    const soldiersLost = Math.floor(damage / 10);
                    newSoldiers -= soldiersLost;
                    if (newSoldiers < 0) newSoldiers = 0;

                    totalDamage += soldiersLost;
                    totalCoins += coinsEarned;

                    // تحديد نتيجة المعركة
                    if (soldiersLost <= 2) {
                        battlesWon++;
                    } else {
                        battlesLost++;
                    }
                }

                user.soldiers = newSoldiers;
                user.coins += totalCoins;
                await user.save();

                // حذف رسالة التحضير
                await preparingMessage.delete();

                if (newSoldiers <= 0) {
                    // التحقق من حذف التحالف إذا كان اللاعب قائداً
                    await checkAndDeleteAllianceIfLeaderLost(message.author.id);

                    await User.deleteOne({ id: message.author.id });
                    await UserItem.deleteMany({ user_id: message.author.id });

                    const defeatEmbed = new discord.EmbedBuilder()
                        .setColor('#8B0000')
                        .setTitle('💀 هزيمة ساحقة!')
                        .setDescription('```diff\n- لقد خسرت جميع جنودك في المعركة!\n```')
                        .addFields(
                            { name: '💀 النتيجة النهائية:', value: 'تدمير كامل للجيش' },
                            { name: '💰 العملات المفقودة:', value: 'جميع العملات والممتلكات' },
                            { name: '🔄 للبدء من جديد:', value: 'استخدم `!البدء` لإنشاء جيش جديد' }
                        )
                        .setFooter({ text: '💪 النهوض من الرماد يجعلك أقوى!' })
                        .setTimestamp();

                    message.channel.send({ embeds: [defeatEmbed] });
                } else {
                    // تحديد لون الـ embed بناءً على النتائج
                    let embedColor = '#00FF00'; // أخضر للنصر
                    let battleResult = '🏆 انتصار ساحق!';

                    if (totalDamage > user.soldiers * 0.7) {
                        embedColor = '#FF6B6B'; // أحمر للخسائر الفادحة
                        battleResult = '⚠️ انتصار بخسائر فادحة';
                    } else if (totalDamage > user.soldiers * 0.3) {
                        embedColor = '#FFA500'; // برتقالي للخسائر المتوسطة
                        battleResult = '🥉 انتصار بخسائر متوسطة';
                    } else if (totalDamage > 0) {
                        embedColor = '#32CD32'; // أخضر فاتح للخسائر القليلة
                        battleResult = '🥈 انتصار بخسائر قليلة';
                    }

                    // حساب معدل النجاح
                    const successRate = Math.round((battlesWon / attackCount) * 100);

                    // إضافة رموز حسب الأداء
                    let performanceEmoji = '🏆';
                    if (successRate >= 90) performanceEmoji = '👑';
                    else if (successRate >= 70) performanceEmoji = '🏆';
                    else if (successRate >= 50) performanceEmoji = '🥈';
                    else performanceEmoji = '🥉';

                    const victoryEmbed = new discord.EmbedBuilder()
                        .setColor(embedColor)
                        .setTitle(`${performanceEmoji} ${battleResult}`)
                        .setDescription(`⚔️ **${user.army_name}** عاد من ساحة المعركة!`)
                        .addFields(
                            { 
                                name: '📊 إحصائيات المعركة:', 
                                value: `🎯 **الغارات:** ${attackCount}\n🏆 **انتصارات:** ${battlesWon}\n💥 **هزائم:** ${battlesLost}\n📈 **معدل النجاح:** ${successRate}%`,
                                inline: true 
                            },
                            { 
                                name: '💰 المكاسب والخسائر:', 
                                value: `💎 **العملات المكتسبة:** ${totalCoins.toLocaleString()}\n☠️ **الجنود المفقودون:** ${totalDamage}\n💰 **إجمالي عملاتك:** ${user.coins.toLocaleString()}`,
                                inline: true 
                            },
                            { 
                                name: '🪖 حالة الجيش:', 
                                value: `⚔️ **الجنود المتبقون:** ${newSoldiers.toLocaleString()}\n💪 **قوة الجيش:** ${Math.round((newSoldiers / (user.soldiers + totalDamage)) * 100)}%`,
                                inline: true 
                            }
                        )
                        .setFooter({ 
                            text: `⚔️ القائد: ${message.author.username} | 🏆 ${successRate >= 70 ? 'أداء ممتاز!' : successRate >= 50 ? 'أداء جيد' : 'حاول التحسن'}` 
                        })
                        .setTimestamp();

                    // إضافة نصائح بناءً على الأداء
                    if (successRate < 50) {
                        victoryEmbed.addFields({
                            name: '💡 نصائح للتحسن:',
                            value: '• اشتر المزيد من الجنود\n• قم بتدريب قواتك\n• قلل عدد الغارات لتقليل المخاطر',
                            inline: false
                        });
                    } else if (successRate >= 90) {
                        victoryEmbed.addFields({
                            name: '🎉 إنجاز رائع:',
                            value: '• أداء استثنائي في المعركة!\n• استمر على هذا المستوى\n• فكر في توسيع جيشك',
                            inline: false
                        });
                    }

                    message.channel.send({ embeds: [victoryEmbed] });
                }
            } catch (error) {
                console.error('Error in !غارة command:', error);

                const errorEmbed = new discord.EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ خطأ في النظام')
                    .setDescription('حدث خطأ أثناء تنفيذ الغارة')
                    .addFields(
                        { name: '🔧 الحل:', value: 'يرجى المحاولة مرة أخرى بعد قليل' }
                    )
                    .setFooter({ text: 'إذا استمر الخطأ، تواصل مع الإدارة' });

                message.reply({ embeds: [errorEmbed] });
            }
        }

        // دالة حساب إجمالي الصحة للقوات
        function calculateTotalHealth(troops) {
            let totalHealth = 0;
            totalHealth += (troops.soldiers || 0) * 20; // جنود عاديون: 20 صحة
            totalHealth += (troops.officers || 0) * 35; // ضباط: 35 صحة
            totalHealth += (troops.colonels || 0) * 40; // عقداء: 40 صحة
            totalHealth += (troops.generals || 0) * 50; // لوائات: 50 صحة
            totalHealth += (troops.lowMoraleSoldiers || 0) * 15; // جنود ضعيفي الهمة: 15 صحة
            return totalHealth;
        }
        // دالة حساب الضرر المتوقع للقوات المرسلة
        function calculateAttackingForceDamage(attacker, attackingCount) {
            let damage = 0;
            let remainingAttackers = attackingCount;

            // حساب ضرر الجنود العاديين (ضرر 5)
            const normalSoldiers = Math.min(remainingAttackers, attacker.soldiers || 0);
            damage += normalSoldiers * 5;
            remainingAttackers -= normalSoldiers;

            // حساب ضرر الضباط (ضرر 10)
            const officers = Math.min(remainingAttackers, attacker.officers || 0);
            damage += officers * 10;
            remainingAttackers -= officers;

            // حساب ضرر العقداء (ضرر 15)
            const colonels = Math.min(remainingAttackers, attacker.colonels || 0);
            damage += colonels * 15;
            remainingAttackers -= colonels;

            // حساب ضرر اللوائات (ضرر 25)
            const generals = Math.min(remainingAttackers, attacker.generals || 0);
            damage += generals * 25;
            remainingAttackers -= generals;

            // حساب ضرر الجنود ضعيفي الهمة (ضرر 2)
            const lowMoraleSoldiers = Math.min(remainingAttackers, attacker.lowMoraleSoldiers || 0);
            damage += lowMoraleSoldiers * 2;

            return damage;
        }

        // دالة حساب الخسائر بدقة
        function calculatePreciseLosses(totalDamage, troops) {
            let remainingDamage = totalDamage;
            let losses = {
                soldiers: 0,
                officers: 0,
                colonels: 0,
                generals: 0,
                lowMoraleSoldiers: 0,
                totalLosses: 0
            };

            // تطبيق الضرر على الجنود العاديين أولاً (صحة 20)
            if (remainingDamage > 0 && troops.soldiers > 0) {
                const soldierLosses = Math.min(Math.floor(remainingDamage / 20), troops.soldiers);
                losses.soldiers = soldierLosses;
                remainingDamage -= soldierLosses * 20;
                troops.soldiers -= soldierLosses;
                losses.totalLosses += soldierLosses;
            }

            // تطبيق الضرر على الضباط (صحة 35)
            if (remainingDamage > 0 && troops.officers > 0) {
                const officerLosses = Math.min(Math.floor(remainingDamage / 35), troops.officers);
                losses.officers = officerLosses;
                remainingDamage -= officerLosses * 35;
                troops.officers -= officerLosses;
                losses.totalLosses += officerLosses;
            }

            // تطبيق الضرر على العقداء (صحة 40)
            if (remainingDamage > 0 && troops.colonels > 0) {
                const colonelLosses = Math.min(Math.floor(remainingDamage / 40), troops.colonels);
                losses.colonels = colonelLosses;
                remainingDamage -= colonelLosses * 40;
                troops.colonels -= colonelLosses;
                losses.totalLosses += colonelLosses;
            }

            // تطبيق الضرر على اللوائات (صحة 50)
            if (remainingDamage > 0 && troops.generals > 0) {
                const generalLosses = Math.min(Math.floor(remainingDamage / 50), troops.generals);
                losses.generals = generalLosses;
                remainingDamage -= generalLosses * 50;
                troops.generals -= generalLosses;
                losses.totalLosses += generalLosses;
            }

            // تطبيق الضرر على الجنود ضعيفي الهمة (صحة 15)
            if (remainingDamage > 0 && troops.lowMoraleSoldiers > 0) {
                const lowMoraleLosses = Math.min(Math.floor(remainingDamage / 15), troops.lowMoraleSoldiers);
                losses.lowMoraleSoldiers = lowMoraleLosses;
                troops.lowMoraleSoldiers -= lowMoraleLosses;
                losses.totalLosses += lowMoraleLosses;
            }

            return losses;
        }

        // دالة حساب خسائر القوة المهاجمة
        function calculateAttackingForceLosses(totalDamage, attackingCount) {
            // جنود المهاجم لهم صحة 20 (جنود عاديون)
            const maxLosses = Math.floor(totalDamage / 20);
            return Math.min(maxLosses, attackingCount);
        }


        // تحديث نظام الهجوم والانسحاب
        async function handleBattleWithdrawal(attacker, defender, round, losses) {
            try {
                // تطبيق الخسائر على المدافع حتى في حالة الانسحاب
                await updateDefenderLosses(defender.id, losses);

                // تسجيل الانسحاب وإنهاء المعركة
                const battleLog = {
                    attackerId: attacker.id,
                    defenderId: defender.id,
                    round: round,
                    withdrawn: true,
                    losses: losses,
                    timestamp: Date.now()
                };

                await BattleLog.create(battleLog);
                return true;
            } catch (error) {
                console.error('Error handling battle withdrawal:', error);
                return false;
            }
        }

        // تحديث نظام الغارات للجنود ضعيفي الهمة
        async function canRaid(userId) {
            const user = await User.findById(userId);
            return user.soldiers.length > 0; // السماح بالغارات لجميع أنواع الجنود
        }

        // تحسين الأداء ومعالجة استهلاك المعالج
        const performanceConfig = {
            maxConcurrentOperations: 5,
            operationTimeout: 5000,
            cleanupInterval: 60000
        };
        // إضافة مراقب الأداء
        const performanceMonitor = {
            operations: new Map(),
            lastCleanup: Date.now(),

            async track(operationId) {
                if (this.operations.size >= performanceConfig.maxConcurrentOperations) {
                    await this.cleanup();
                }

                this.operations.set(operationId, {
                    startTime: Date.now(),
                    completed: false
                });
            },

            async complete(operationId) {
                if (this.operations.has(operationId)) {
                    this.operations.delete(operationId);
                }
            },

            async cleanup() {
                const now = Date.now();

                // تنظيف العمليات القديمة
                for (const [id, operation] of this.operations.entries()) {
                    if (now - operation.startTime > performanceConfig.operationTimeout) {
                        this.operations.delete(id);
                    }
                }

                this.lastCleanup = now;
            }
        };

        // تطبيق المراقبة على العمليات الرئيسية
        client.on('messageCreate', async message => {
            if (!message.content.startsWith('!')) return;

            const operationId = `${message.author.id}-${Date.now()}`;
            await performanceMonitor.track(operationId);

            try {
                // تنفيذ الأمر
                await handleCommand(message);
            } finally {
                await performanceMonitor.complete(operationId);
            }
        });

        // تنظيف دوري للذاكرة
        setInterval(() => {
            global.gc(); // تفعيل جامع القمامة يدوياً
            performanceMonitor.cleanup();
        }, performanceConfig.cleanupInterval);



        // أمر لقتال لاعب آخر
        if (message.content.startsWith('!هجوم')) {
            try {
                if (!warCategory.includes(message.channel.parentId)) {
                    return message.reply('هذا الأمر متاح فقط في فئة الحروب. يرجى استخدام الأمر في القناة المخصصة للحروب.');
                }
                let opponent = message.mentions.users.first();
                if (!opponent) return message.reply('من فضلك حدد لاعبًا للقتال!');

                const attacker = await User.findOne({ id: message.author.id });
                if (!attacker) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

                const opponentUser = await User.findOne({ id: opponent.id });
                if (!opponentUser) return message.reply('اللاعب المحدد لا يملك جيشاً!');

                // التحقق من التحالفات والحروب
                if (attacker.alliance_id && opponentUser.alliance_id) {
                    if (attacker.alliance_id === opponentUser.alliance_id) {
                        return message.reply('لا يمكنك مهاجمة عضو من نفس تحالفك!');
                    }

                    const attackerAlliance = await Alliance.findOne({ id: attacker.alliance_id });
                    if (attackerAlliance && !attackerAlliance.wars.includes(opponentUser.alliance_id)) {
                        return message.reply('لا يمكنك مهاجمة هذا اللاعب. يجب أن يكون هناك حرب بين التحالفات أولاً!');
                    }
                }

                const hasWall = await hasUserItem(opponent.id, 'أسوار');

                if (hasWall) {
                    return message.reply(`${opponent.username} لديه سور! لا يمكنك الهجوم عليه بالجنود. استخدم !قصف لتدمير السور.`);
                }

                if (opponentUser.lastDefeated && Date.now() - opponentUser.lastDefeated < 300000) {
                    return message.reply(`لا يمكنك الهجوم على ${opponent.username} الآن. يجب أن تنتظر 5 دقائق.`);
                }

                // عرض قوات المهاجم المتاحة
                const troopTypes = [
                    { name: 'جنود عاديون', field: 'soldiers', count: attacker.soldiers || 0, coinRange: [10, 40] },
                    { name: 'ضباط', field: 'officers', count: attacker.officers || 0, coinRange: [20, 70] },
                    { name: 'عقداء', field: 'colonels', count: attacker.colonels || 0, coinRange: [35, 100] },
                    { name: 'لوائات', field: 'generals', count: attacker.generals || 0, coinRange: [50, 150] },
                    { name: 'جنود ضعيفي الهمة', field: 'lowMoraleSoldiers', count: attacker.lowMoraleSoldiers || 0, coinRange: [5, 20] }
                ];

                const availableTroops = troopTypes.filter(type => type.count > 0);

                if (availableTroops.length === 0) {
                    return message.reply('ليس لديك أي جنود للهجوم!');
                }

                // إنشاء embed لعرض القوات المتاحة (للمهاجم فقط)
                const troopsEmbed = new discord.EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('اختيار قوات الهجوم')
                    .setDescription('حدد عدد الجنود من كل نوع للهجوم (اكتب 0 لتجاهل النوع):')
                    .addFields(
                        availableTroops.map(type => ({
                            name: `${type.name}`,
                            value: `المتاح: ${type.count} | مكاسب: ${type.coinRange[0]}-${type.coinRange[1]} عملة/جندي`,
                            inline: true
                        }))
                    )
                    .setFooter({ text: 'ستتم مطالبتك بتحديد عدد الجنود من كل نوع' });

                await message.reply({ embeds: [troopsEmbed], ephemeral: true });

                // جمع أعداد القوات من المهاجم
                const attackingForce = {};
                let currentTroopIndex = 0;

                const collectTroopCounts = async () => {
                    if (currentTroopIndex >= availableTroops.length) {
                        // انتهى جمع القوات، ابدأ المعركة
                        const totalAttackingTroops = Object.values(attackingForce).reduce((sum, count) => sum + count, 0);

                        if (totalAttackingTroops === 0) {
                            await message.reply('يجب عليك اختيار جنود للهجوم!');
                            return;
                        }

                        await startBattle();
                        return;
                    }

                    const currentTroop = availableTroops[currentTroopIndex];

                    const questionEmbed = new discord.EmbedBuilder()
                        .setColor('#0099FF')
                        .setTitle('تحديد عدد الجنود')
                        .setDescription(`كم عدد ${currentTroop.name} تريد إرسالهم للهجوم؟`)
                        .addFields(
                            { name: 'المتاح:', value: `${currentTroop.count}` },
                            { name: 'المكاسب المتوقعة:', value: `${currentTroop.coinRange[0]}-${currentTroop.coinRange[1]} عملة لكل جندي` }
                        )
                        .setFooter({ text: 'اكتب العدد (0 لتجاهل هذا النوع)' });

                    await message.reply({ embeds: [questionEmbed] });

                    const filter = (response) => response.author.id === message.author.id;
                    const channelCollector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

                    const handleResponse = async (response) => {
                        const count = parseInt(response.content.trim());

                        if (isNaN(count) || count < 0 || count > currentTroop.count) {
                            const errorMsg = `عدد غير صحيح! يجب أن يكون بين 0 و ${currentTroop.count}`;
                            await message.reply(errorMsg);
                            return collectTroopCounts(); // إعادة السؤال
                        }

                        attackingForce[currentTroop.field] = count;
                        currentTroopIndex++;

                        // حذف الرسالة
                        try {
                            await response.delete();
                        } catch (error) {
                            console.log('Could not delete message');
                        }

                        channelCollector.stop();
                        await collectTroopCounts();
                    };

                    channelCollector.on('collect', handleResponse);
                    channelCollector.on('end', (collected) => {
                        if (collected.size === 0) {
                            message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                        }
                    });
                };
                // دالة بدء المعركة
                const startBattle = async () => {
                    try {
                        let rounds = 3;
                        let totalCoinsWon = 0;

                        // نسخ بيانات القوات للمعركة (المهاجم)
                        let battleAttacker = { ...attackingForce };

                        // نسخ بيانات القوات للمعركة (المدافع)
                        let battleDefender = {
                            soldiers: opponentUser.soldiers || 0,
                            officers: opponentUser.officers || 0,
                            colonels: opponentUser.colonels || 0,
                            generals: opponentUser.generals || 0,
                            lowMoraleSoldiers: opponentUser.lowMoraleSoldiers || 0
                        };

                        // دالة حساب العملات المكتسبة بناءً على نوع الجنود مع مراعاة عملات المدافع المتاحة
                        const calculateCoinsEarned = (attackingForce, defenderCoins) => {
                            if (defenderCoins <= 0) return 0;

                            let totalPotentialCoins = 0;
                            let totalTroops = 0;

                            // حساب إجمالي العملات المحتملة وإجمالي القوات
                            const troopTypes = [
                                { soldiers: attackingForce.soldiers || 0, minCoins: 10, maxCoins: 40 },
                                { soldiers: attackingForce.officers || 0, minCoins: 20, maxCoins: 70 },
                                { soldiers: attackingForce.colonels || 0, minCoins: 35, maxCoins: 100 },
                                { soldiers: attackingForce.generals || 0, minCoins: 50, maxCoins: 150 },
                                { soldiers: attackingForce.lowMoraleSoldiers || 0, minCoins: 5, maxCoins: 20 }
                            ];

                            // حساب العملات المحتملة الإجمالية
                            troopTypes.forEach(type => {
                                for (let i = 0; i < type.soldiers; i++) {
                                    totalPotentialCoins += Math.floor(Math.random() * (type.maxCoins - type.minCoins + 1)) + type.minCoins;
                                }
                                totalTroops += type.soldiers;
                            });

                            // إذا كانت العملات المحتملة أقل من أو تساوي عملات المدافع، إرجاع العملات المحتملة
                            if (totalPotentialCoins <= defenderCoins) {
                                return totalPotentialCoins;
                            }

                            // إذا كانت العملات المحتملة أكثر من عملات المدافع، توزيع عملات المدافع بشكل متناسب
                            let distributedCoins = 0;
                            let remainingDefenderCoins = defenderCoins;

                            // توزيع العملات حسب أولوية القوات (الأقوى يأخذ أولاً)
                            const priorityOrder = [
                                { type: 'generals', soldiers: attackingForce.generals || 0, minCoins: 50, maxCoins: 150 },
                                { type: 'colonels', soldiers: attackingForce.colonels || 0, minCoins: 35, maxCoins: 100 },
                                { type: 'officers', soldiers: attackingForce.officers || 0, minCoins: 20, maxCoins: 70 },
                                { type: 'soldiers', soldiers: attackingForce.soldiers || 0, minCoins: 10, maxCoins: 40 },
                                { type: 'lowMoraleSoldiers', soldiers: attackingForce.lowMoraleSoldiers || 0, minCoins: 5, maxCoins: 20 }
                            ];

                            for (const troopType of priorityOrder) {
                                if (remainingDefenderCoins <= 0 || troopType.soldiers <= 0) continue;

                                for (let i = 0; i < troopType.soldiers && remainingDefenderCoins > 0; i++) {
                                    const maxPossibleCoins = Math.min(
                                        Math.floor(Math.random() * (troopType.maxCoins - troopType.minCoins + 1)) + troopType.minCoins,
                                        remainingDefenderCoins
                                    );

                                    distributedCoins += maxPossibleCoins;
                                    remainingDefenderCoins -= maxPossibleCoins;
                                }
                            }

                            return distributedCoins;
                        };

                        const calculateForceDamage = (force) => {
                            let totalDamage = 0;
                            totalDamage += (force.soldiers || 0) * 5;
                            totalDamage += (force.officers || 0) * 10;
                            totalDamage += (force.colonels || 0) * 15;
                            totalDamage += (force.generals || 0) * 25;
                            totalDamage += (force.lowMoraleSoldiers || 0) * 2;
                            return totalDamage;
                        };

                        // دالة حساب الخسائر بنظام الأولوية للمدافع (الأقوى يدافع أولاً)
                        const calculateDefenderLossesWithPriority = (damage, defender) => {
                            let remainingDamage = damage;
                            let losses = {
                                soldiers: 0,
                                officers: 0,
                                colonels: 0,
                                generals: 0,
                                lowMoraleSoldiers: 0
                            };

                            // ترتيب الأولوية: الأقوى يدافع أولاً
                            const defenseOrder = [
                                { type: 'generals', health: 50, count: defender.generals },
                                { type: 'colonels', health: 40, count: defender.colonels },
                                { type: 'officers', health: 35, count: defender.officers },
                                { type: 'soldiers', health: 20, count: defender.soldiers },
                                { type: 'lowMoraleSoldiers', health: 15, count: defender.lowMoraleSoldiers }
                            ];

                            for (const unit of defenseOrder) {
                                if (remainingDamage <= 0 || unit.count <= 0) continue;

                                const maxLosses = Math.floor(remainingDamage / unit.health);
                                const actualLosses = Math.min(maxLosses, unit.count);

                                losses[unit.type] = actualLosses;
                                defender[unit.type] -= actualLosses;
                                remainingDamage -= actualLosses * unit.health;
                            }

                            return losses;
                        };

                        // دالة حساب خسائر المهاجم (عشوائية واقعية)
                        const calculateAttackerLosses = (damage, attacker) => {
                            let remainingDamage = damage;
                            let losses = {
                                soldiers: 0,
                                officers: 0,
                                colonels: 0,
                                generals: 0,
                                lowMoraleSoldiers: 0
                            };

                            // توزيع الضرر عشوائياً على القوات
                            const attackerUnits = [
                                { type: 'soldiers', health: 20, count: attacker.soldiers || 0 },
                                { type: 'officers', health: 35, count: attacker.officers || 0 },
                                { type: 'colonels', health: 40, count: attacker.colonels || 0 },
                                { type: 'generals', health: 50, count: attacker.generals || 0 },
                                { type: 'lowMoraleSoldiers', health: 15, count: attacker.lowMoraleSoldiers || 0 }
                            ];

                            // خلط القائمة للحصول على توزيع عشوائي
                            const shuffledUnits = attackerUnits.sort(() => Math.random() - 0.5);

                            for (const unit of shuffledUnits) {
                                if (remainingDamage <= 0 || unit.count <= 0) continue;

                                const maxLosses = Math.floor(remainingDamage / unit.health);
                                const actualLosses = Math.min(maxLosses, unit.count);

                                losses[unit.type] = actualLosses;
                                attacker[unit.type] = (attacker[unit.type] || 0) - actualLosses;
                                remainingDamage -= actualLosses * unit.health;
                            }

                            return losses;
                        };

                        // دالة إنشاء نص الخسائر المبسط
                        const formatLosses = (losses) => {
                            const lossTexts = [];
                            if (losses.soldiers > 0) lossTexts.push(`${losses.soldiers} جندي`);
                            if (losses.officers > 0) lossTexts.push(`${losses.officers} ضابط`);
                            if (losses.colonels > 0) lossTexts.push(`${losses.colonels} عقيد`);
                            if (losses.generals > 0) lossTexts.push(`${losses.generals} لواء`);
                            if (losses.lowMoraleSoldiers > 0) lossTexts.push(`${losses.lowMoraleSoldiers} جندي ضعيف الهمة`);

                            return lossTexts.length > 0 ? lossTexts.join(', ') : 'لا توجد خسائر';
                        };

                        // دالة المعركة للجولة الواحدة
                        const executeRound = async (round) => {
                            // التحقق من انتهاء المعركة
                            const attackerAlive = Object.values(battleAttacker).some(count => count > 0);
                            const defenderAlive = Object.values(battleDefender).some(count => count > 0);

                            if (!attackerAlive || !defenderAlive || round > rounds) {
                                return await endBattle();
                            }

                            // حساب الضرر للجولة الحالية
                            const attackerDamage = Math.floor(calculateForceDamage(battleAttacker) / 3);
                            const defenderDamage = Math.floor(calculateForceDamage(battleDefender) / 3);

                            // حساب الخسائر
                            const defenderLosses = calculateDefenderLossesWithPriority(attackerDamage, battleDefender);
                            const attackerLosses = calculateAttackerLosses(defenderDamage, battleAttacker);

                            // حساب العملات المكتسبة للجولة بناءً على نوع الجنود المتبقين
                            let coinsWon = 0;
                            if (Object.values(battleAttacker).some(count => count > 0)) {
                                // الحصول على عملات المدافع الحالية
                                const currentOpponent = await User.findOne({ id: opponent.id });
                                coinsWon = calculateCoinsEarned(battleAttacker, currentOpponent.coins);
                                totalCoinsWon += coinsWon;

                                // تحديث العملات
                                const updatedAttacker = await User.findOne({ id: message.author.id });
                                const updatedOpponent = await User.findOne({ id: opponent.id });
                                updatedAttacker.coins += coinsWon;
                                updatedOpponent.coins = Math.max(0, updatedOpponent.coins - coinsWon);
                                await updatedAttacker.save();
                                await updatedOpponent.save();
                            }

                            // إنشاء رسالة نتائج الجولة مبسطة
                            const totalDefenderLosses = Object.values(defenderLosses).reduce((sum, loss) => sum + loss, 0);
                            const totalAttackerLosses = Object.values(attackerLosses).reduce((sum, loss) => sum + loss, 0);

                            const roundEmbed = new discord.EmbedBuilder()
                                .setColor('#FFA500')
                                .setTitle(`⚔️ جولة ${round} من ${rounds}`)
                                .setDescription(`نتائج الجولة ${round}`)
                                .addFields(
                                    { name: '☠️ خسائر المهاجم:', value: totalAttackerLosses > 0 ? formatLosses(attackerLosses) : 'لا توجد خسائر' },
                                    { name: '💀 خسائر المدافع:', value: totalDefenderLosses > 0 ? formatLosses(defenderLosses) : 'لا توجد خسائر' },
                                    { name: '💰 العملات المكتسبة:', value: `${coinsWon} عملة` }
                                );

                            // التحقق من إمكانية المتابعة
                            const canContinue = round < rounds && 
                                               Object.values(battleAttacker).some(count => count > 0) && 
                                               Object.values(battleDefender).some(count => count > 0);

                            if (canContinue) {
                                roundEmbed.setFooter({ text: 'ماذا تريد أن تفعل؟' });

                                const battleActionRow = new discord.ActionRowBuilder()
                                    .addComponents(
                                        new discord.ButtonBuilder()
                                            .setCustomId(`continue_battle_${round}`)
                                            .setLabel('⚔️ استمرار القتال')
                                            .setStyle(discord.ButtonStyle.Danger),
                                        new discord.ButtonBuilder()
                                            .setCustomId(`retreat_battle_${round}`)
                                            .setLabel('🏃‍♂️ انسحاب')
                                            .setStyle(discord.ButtonStyle.Secondary)
                                    );

                                const roundMessage = await message.channel.send({ 
                                    embeds: [roundEmbed], 
                                    components: [battleActionRow]
                                });

                                // معالج الأزرار
                                const buttonFilter = i => i.user.id === message.author.id;
                                const buttonCollector = roundMessage.createMessageComponentCollector({ 
                                    filter: buttonFilter, 
                                    time: 60000,
                                    max: 1
                                });

                                buttonCollector.on('collect', async i => {
                                    if (i.customId.startsWith('continue_battle_')) {
                                        await i.update({ 
                                            embeds: [roundEmbed.setFooter({ text: 'استمرار للجولة التالية...' })], 
                                            components: [] 
                                        });
                                        setTimeout(() => executeRound(round + 1), 2000);
                                    } else if (i.customId.startsWith('retreat_battle_')) {
                                        await i.update({ 
                                            embeds: [roundEmbed.setFooter({ text: 'تم الانسحاب من المعركة!' })], 
                                            components: [] 
                                        });
                                        setTimeout(() => endBattleWithRetreat(), 1000);
                                    }
                                });

                                buttonCollector.on('end', collected => {
                                    if (collected.size === 0) {
                                        // إذا لم يضغط المهاجم على أي زر، يتم الانسحاب تلقائياً
                                        roundMessage.edit({ 
                                            embeds: [roundEmbed.setFooter({ text: 'انتهى الوقت - تم الانسحاب تلقائياً!' })], 
                                            components: [] 
                                        }).catch(console.error);
                                        setTimeout(() => endBattleWithRetreat(), 1000);
                                    }
                                });
                            } else {
                                // الجولة الأخيرة أو انتهت المعركة
                                roundEmbed.setFooter({ text: round >= rounds ? 'الجولة الأخيرة!' : 'انتهت المعركة!' });
                                await message.channel.send({ embeds: [roundEmbed] });
                                setTimeout(() => endBattle(), 2000);
                            }
                        };
                        // دالة إنهاء المعركة بالانسحاب
                        const endBattleWithRetreat = async () => {
                            // تحديث قاعدة البيانات
                            const updatedAttacker = await User.findOne({ id: message.author.id });

                            // خصم الجنود المفقودة فقط (الجنود المستخدمة - الجنود المتبقية)
                            const soldierLosses = (attackingForce.soldiers || 0) - (battleAttacker.soldiers || 0);
                            const officerLosses = (attackingForce.officers || 0) - (battleAttacker.officers || 0);
                            const colonelLosses = (attackingForce.colonels || 0) - (battleAttacker.colonels || 0);
                            const generalLosses = (attackingForce.generals || 0) - (battleAttacker.generals || 0);
                            const lowMoraleLosses = (attackingForce.lowMoraleSoldiers || 0) - (battleAttacker.lowMoraleSoldiers || 0);

                            updatedAttacker.soldiers -= soldierLosses;
                            updatedAttacker.officers -= officerLosses;
                            updatedAttacker.colonels -= colonelLosses;
                            updatedAttacker.generals -= generalLosses;
                            updatedAttacker.lowMoraleSoldiers -= lowMoraleLosses;

                            await updatedAttacker.save();

                            const retreatEmbed = new discord.EmbedBuilder()
                                .setColor('#FFA500')
                                .setTitle('🏃‍♂️ انسحاب من المعركة!')
                                .setDescription('تم سحب قواتك من المعركة بنجاح')
                                .addFields(
                                    { name: '💰 إجمالي العملات المكتسبة:', value: `${totalCoinsWon}` },
                                    { name: '🪖 القوات العائدة:', value: formatLosses(battleAttacker) || 'لا توجد قوات متبقية' }
                                )
                                .setFooter({ text: 'تم الانسحاب بأمان!' });

                            await message.channel.send({ embeds: [retreatEmbed] });
                        };
                        // دالة إنهاء المعركة
                        const endBattle = async () => {
                            const attackerAlive = Object.values(battleAttacker).some(count => count > 0);
                            const defenderAlive = Object.values(battleDefender).some(count => count > 0);

                            // تحديث قاعدة البيانات
                            const updatedAttacker = await User.findOne({ id: message.author.id });
                            const updatedOpponent = await User.findOne({ id: opponent.id });

                            // خصم الجنود المفقودة فقط (الجنود المستخدمة - الجنود المتبقية)
                            const soldierLosses = (attackingForce.soldiers || 0) - (battleAttacker.soldiers || 0);
                            const officerLosses = (attackingForce.officers || 0) - (battleAttacker.officers || 0);
                            const colonelLosses = (attackingForce.colonels || 0) - (battleAttacker.colonels || 0);
                            const generalLosses = (attackingForce.generals || 0) - (battleAttacker.generals || 0);
                            const lowMoraleLosses = (attackingForce.lowMoraleSoldiers || 0) - (battleAttacker.lowMoraleSoldiers || 0);

                            updatedAttacker.soldiers -= soldierLosses;
                            updatedAttacker.officers -= officerLosses;
                            updatedAttacker.colonels -= colonelLosses;
                            updatedAttacker.generals -= generalLosses;
                            updatedAttacker.lowMoraleSoldiers -= lowMoraleLosses;

                            // تحديث قوات المدافع
                            updatedOpponent.soldiers = battleDefender.soldiers;
                            updatedOpponent.officers = battleDefender.officers;
                            updatedOpponent.colonels = battleDefender.colonels;
                            updatedOpponent.generals = battleDefender.generals;
                            updatedOpponent.lowMoraleSoldiers = battleDefender.lowMoraleSoldiers;
                            updatedOpponent.lastDefeated = Date.now();

                            let resultEmbed;

                            if (!defenderAlive) {
                                // انتصار كامل - المهاجم يحصل على كل شيء
                                updatedAttacker.coins += updatedOpponent.coins;
                                const allCoins = updatedOpponent.coins;

                                // التحقق من حذف التحالف إذا كان المدافع قائداً قبل حذف ملفه
                                if (updatedOpponent.alliance_id && updatedOpponent.alliance_rank === 'قائد التحالف') {
                                    console.log(`🚨 المدافع ${opponent.id} قائد تحالف وخسر جميع جنوده، سيتم حذف التحالف`);

                                    const alliance = await Alliance.findOne({ id: updatedOpponent.alliance_id });
                                    if (alliance && alliance.leader_id === opponent.id) {
                                        console.log(`🗑️ حذف التحالف "${alliance.name}" بسبب خسارة القائد لجميع جنوده في المعركة`);

                                        // إزالة رتبة التحالف من جميع الأعضاء وحذف الرتبة
                                        if (alliance.role_id) {
                                            try {
                                                console.log(`🏷️ حذف رتبة التحالف: ${alliance.role_id}`);

                                                // إزالة الرتبة من جميع الأعضاء في جميع السيرفرات
                                                for (const memberId of alliance.members || []) {
                                                    try {
                                                        let memberFound = false;

                                                        // البحث في جميع السيرفرات
                                                        for (const guild of client.guilds.cache.values()) {
                                                            try {
                                                                const member = await guild.members.fetch(memberId);
                                                                if (member && member.roles.cache.has(alliance.role_id)) {
                                                                    await member.roles.remove(alliance.role_id);
                                                                    console.log(`✅ تم إزالة رتبة التحالف من العضو: ${memberId} في السيرفر: ${guild.name}`);
                                                                    memberFound = true;
                                                                }
                                                            } catch (memberError) {
                                                                // تجاهل الأخطاء والمتابعة
                                                                continue;
                                                            }
                                                        }

                                                        if (!memberFound) {
                                                            console.log(`⚠️ لم يتم العثور على العضو ${memberId} في أي سيرفر`);
                                                        }
                                                    } catch (memberError) {
                                                        console.error(`❌ خطأ في إزالة الرتبة من العضو ${memberId}:`, memberError);
                                                    }
                                                }

                                                // حذف الرتبة من جميع السيرفرات
                                                let roleDeleted = false;
                                                for (const guild of client.guilds.cache.values()) {
                                                    try {
                                                        const role = await guild.roles.fetch(alliance.role_id);
                                                        if (role) {
                                                            await role.delete('حذف تحالف بسبب خسارة القائد لجميع جنوده في المعركة');
                                                            console.log(`✅ تم حذف رتبة التحالف: ${alliance.name} من السيرفر: ${guild.name}`);
                                                            roleDeleted = true;
                                                            break; // الرتبة موجودة في سيرفر واحد فقط عادة
                                                        }
                                                    } catch (roleError) {
                                                        console.error(`❌ خطأ في حذف الرتبة من السيرفر ${guild.name}:`, roleError);
                                                        continue;
                                                    }
                                                }

                                                if (!roleDeleted) {
                                                    console.log(`⚠️ لم يتم العثور على رتبة التحالف ${alliance.role_id} في أي سيرفر`);
                                                }
                                            } catch (roleError) {
                                                console.error('❌ خطأ عام في حذف رتبة التحالف:', roleError);
                                            }
                                        }

                                        // إشعار الأعضاء السابقين
                                        console.log(`📤 إرسال إشعارات للأعضاء...`);
                                        const members = await User.find({ alliance_id: alliance.id });
                                        let notifiedCount = 0;

                                        for (const member of members) {
                                            try {
                                                if (member.id !== opponent.id) {
                                                    const memberUser = await client.users.fetch(member.id);
                                                    const embed = new discord.EmbedBuilder()
                                                        .setColor('#FF0000')
                                                        .setTitle('🚨 تم حل التحالف!')
                                                        .setDescription(`تم حل تحالف **"${alliance.name}"** بسبب خسارة القائد لجميع قواته في المعركة`)
                                                        .addFields(
                                                            { name: '📋 السبب:', value: 'فقدان القائد لجميع قواته في معركة' },
                                                            { name: '⚔️ المهاجم:', value: `${message.author.username}` },
                                                            { name: '⏰ التوقيت:', value: new Date().toLocaleString('ar-SA') },
                                                            { name: '🔄 الخطوات التالية:', value: 'يمكنك الانضمام إلى تحالف آخر أو إنشاء تحالف جديد' }
                                                        )
                                                        .setFooter({ text: 'تم حل التحالف تلقائياً بواسطة النظام' })
                                                        .setTimestamp();

                                                    await memberUser.send({ embeds: [embed] });
                                                    notifiedCount++;
                                                    console.log(`✅ تم إشعار العضو: ${member.id}`);
                                                }
                                            } catch (error) {
                                                console.error(`❌ خطأ في إرسال إشعار للعضو ${member.id}:`, error);
                                            }
                                        }

                                        console.log(`📊 تم إشعار ${notifiedCount} عضو من أصل ${members.length - 1} أعضاء`);

                                        // إزالة التحالف من جميع الأعضاء
                                        console.log(`🗑️ إزالة التحالف من بيانات الأعضاء...`);
                                        const updateResult = await User.updateMany(
                                            { alliance_id: alliance.id },
                                            { $unset: { alliance_id: "" }, $set: { alliance_rank: 'عضو' } }
                                        );
                                        console.log(`✅ تم تحديث بيانات ${updateResult.modifiedCount} عضو`);

                                        // حذف جميع طلبات الانضمام للتحالف
                                        console.log(`🗑️ حذف طلبات الانضمام للتحالف...`);
                                        const deleteRequestsResult = await AllianceRequest.deleteMany({ alliance_id: alliance.id });
                                        console.log(`✅ تم حذف ${deleteRequestsResult.deletedCount} طلب انضمام`);

                                        // حذف التحالف
                                        console.log(`🗑️ حذف التحالف من قاعدة البيانات...`);
                                        const deleteAllianceResult = await Alliance.deleteOne({ id: alliance.id });

                                        if (deleteAllianceResult.deletedCount > 0) {
                                            console.log(`✅ تم حذف التحالف "${alliance.name}" بنجاح بسبب خسارة القائد ${opponent.id} لجميع جنوده في المعركة`);
                                        } else {
                                            console.error(`❌ فشل في حذف التحالف "${alliance.name}" من قاعدة البيانات`);
                                        }
                                    }
                                }

                                // نقل الممتلكات
                                const opponentItems = await UserItem.find({ user_id: opponent.id });
                                for (const item of opponentItems) {
                                    await addUserItem(attacker.id, item.item_name, item.quantity);
                                }

                                resultEmbed = new discord.EmbedBuilder()
                                    .setColor('#00FF00')
                                    .setTitle('🏆 انتصار كامل!')
                                    .setDescription(`لقد هزمت ${opponent.username} بالكامل وحصلت على كل ممتلكاته!`)
                                    .addFields(
                                        { name: '💰 إجمالي العملات المكتسبة:', value: `${totalCoinsWon + allCoins}` },
                                        { name: '📦 الممتلكات المنقولة:', value: `${opponentItems.length} عنصر` }
                                    )
                                    .setFooter({ text: 'انتصار ساحق!' });

                                // حذف بيانات المدافع
                                setTimeout(async () => {
                                    await User.deleteOne({ id: opponent.id });
                                    await UserItem.deleteMany({ user_id: opponent.id });
                                }, 1000);
                            } else if (!attackerAlive) {
                                // هزيمة المهاجم
                                resultEmbed = new discord.EmbedBuilder()
                                    .setColor('#FF0000')
                                    .setTitle('💀 هزيمة!')
                                    .setDescription('تم القضاء على قواتك المهاجمة بالكامل!')
                                    .addFields(
                                        { name: '💰 العملات المكتسبة:', value: `${totalCoinsWon}` }
                                    )
                                    .setFooter({ text: 'حظاً أوفر في المرة القادمة!' });
                            } else {
                                // انتهت الجولات الثلاث
                                resultEmbed = new discord.EmbedBuilder()
                                    .setColor('#FFA500')
                                    .setTitle('⏱️ انتهت المعركة!')
                                    .setDescription('انتهت الجولات الثلاث، تم سحب قواتك')
                                    .addFields(
                                        { name: '💰 إجمالي العملات المكتسبة:', value: `${totalCoinsWon}` },
                                        { name: '🪖 القوات العائدة:', value: formatLosses(battleAttacker) || 'لا توجد قوات متبقية' }
                                    )
                                    .setFooter({ text: 'المعركة انتهت!' });
                            }

                            await updatedAttacker.save();
                            await updatedOpponent.save();
                            await message.channel.send({ embeds: [resultEmbed] });
                        };

                        // بدء المعركة
                        const battleStartEmbed = new discord.EmbedBuilder()
                            .setColor('#FF6B6B')
                            .setTitle('⚔️ بدء المعركة!')
                            .setDescription(`المعركة بين ${message.author.username} و ${opponent.username}`)
                            .addFields(
                                { name: '🪖 قوات المهاجم:', value: formatLosses(battleAttacker) || 'لا توجد قوات' },
                                { name: '🏰 قوات المدافع:', value: formatLosses(battleDefender) || 'لا توجد قوات' }
                            )
                            .setFooter({ text: 'المعركة ستستمر لـ 3 جولات' });

                        await message.channel.send({ embeds: [battleStartEmbed] });

                        setTimeout(() => executeRound(1), 3000);
                    } catch (error) {
                        console.error('Error in battle:', error);
                        message.reply('حدث خطأ أثناء المعركة. يرجى المحاولة مرة أخرى.');
                    }
                };

                // بدء عملية جمع أعداد القوات
                await collectTroopCounts();

            } catch (error) {
                console.error('Error in !هجوم command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // عرض ملف اللاعب المحسن
        if (message.content.startsWith('!p')) {
            try {
                if (!PublicCategory.includes(message.channel.parentId)) {
                    return message.reply('هذا الأمر متاح فقط في القنوات العامة.');
                }

                let user = message.mentions.users.first() || message.author;
                const isOwnProfile = user.id === message.author.id;

                const userProfile = await User.findOne({ id: user.id });
                if (!userProfile) return message.reply('لم يتم العثور على ملف شخصي لهذا المستخدم.');

                const userItems = await UserItem.find({ user_id: user.id });
                const userItemNames = userItems.map(item => item.item_name);

                // حساب القوة الإجمالية
                const totalPower = 
                    (userProfile.soldiers || 0) * 5 + 
                    (userProfile.officers || 0) * 10 + 
                    (userProfile.colonels || 0) * 15 + 
                    (userProfile.generals || 0) * 25 + 
                    (userProfile.lowMoraleSoldiers || 0) * 2;

                const totalTroops = 
                    (userProfile.soldiers || 0) + 
                    (userProfile.officers || 0) + 
                    (userProfile.colonels || 0) + 
                    (userProfile.generals || 0) + 
                    (userProfile.lowMoraleSoldiers || 0);

                // حساب الراتب الكلي المطلوب
                const soldiersSalary = (userProfile.soldiers || 0) * 0.5;
                const officersSalary = (userProfile.officers || 0) * 1;
                const colonelsSalary = (userProfile.colonels || 0) * 3;
                const generalsSalary = (userProfile.generals || 0) * 5;
                const lowMoraleSalary = (userProfile.lowMoraleSoldiers || 0) * 0.5;
                const totalSalary = soldiersSalary + officersSalary + colonelsSalary + generalsSalary + lowMoraleSalary;

                // حساب الوقت المتبقي للراتب التالي
                const now = new Date();
                const lastSalaryTime = new Date(userProfile.lastSalaryPaid);
                const timeDifference = now - lastSalaryTime;
                const oneHour = 60 * 60 * 1000;

                let timeUntilNextSalary;
                if (timeDifference >= oneHour) {
                    timeUntilNextSalary = 0;
                } else {
                    timeUntilNextSalary = oneHour - timeDifference;
                }
                const minutesLeftSalary = Math.floor(timeUntilNextSalary / (60 * 1000));

                // حساب المناجم ومستخرجات النفط
                const mineCount = await getUserItemCount(user.id, 'المنجم');
                const oilExtractorCount = await getUserItemCount(user.id, 'مستخرج النفط');

                const embed = new discord.EmbedBuilder()
                    .setColor('#1E90FF')
                    .setTitle(`🏛️ ملف الجيش - ${userProfile.army_name}`)
                    .setDescription('📊 **المعلومات الأساسية**')
                    .addFields(
                        { name: '⚡ القوة الإجمالية:', value: `**${totalPower.toLocaleString()}**`, inline: true },
                        { name: '🪖 إجمالي الجنود:', value: `**${totalTroops.toLocaleString()}**`, inline: true },
                        { name: '💰 العملات:', value: `**${userProfile.coins.toLocaleString()}**`, inline: true }
                    );

                // معلومات الجنود (إذا كان لديه جنود)
                if (totalTroops > 0) {
                    let troopsInfo = '';
                    if (userProfile.soldiers > 0) troopsInfo += `⚔️ جنود عاديون: **${userProfile.soldiers}**\n`;
                    if (userProfile.officers > 0) troopsInfo += `🎖️ ضباط: **${userProfile.officers}**\n`;
                    if (userProfile.colonels > 0) troopsInfo += `🏅 عقداء: **${userProfile.colonels}**\n`;
                    if (userProfile.generals > 0) troopsInfo += `👑 لوائات: **${userProfile.generals}**\n`;
                    if (userProfile.lowMoraleSoldiers > 0) troopsInfo += `😞 ضعيفي الهمة: **${userProfile.lowMoraleSoldiers}**\n`;

                    embed.addFields({ name: '🏗️ تفاصيل القوات:', value: troopsInfo, inline: false });
                }

                // معلومات الراتب
                const salaryStatus = userProfile.coins >= totalSalary ? '✅ كافي' : '❌ غير كافي';
                embed.addFields(
                    { name: '💸 الراتب المطلوب:', value: `**${totalSalary}** عملة/ساعة`, inline: true },
                    { name: '⏰ الوقت للراتب التالي:', value: `**${minutesLeftSalary}** دقيقة`, inline: true },
                    { name: '⚠️ حالة الراتب:', value: salaryStatus, inline: true }
                );

                // حساب معلومات المناجم ومستخرجات النفط
                const timeSinceLastMining = now - new Date(userProfile.lastMiningCollected);
                const mineHours = Math.floor(timeSinceLastMining / oneHour);
                const timeSinceLastOil = now - new Date(userProfile.lastOilCollected);
                const oilHours = Math.floor(timeSinceLastOil / oneHour);

                // معلومات المناجم (إذا كان يملك مناجم)
                if (mineCount > 0) {
                    const miningTimeLeft = oneHour - (timeSinceLastMining % oneHour);
                    const miningMinutesLeft = Math.floor(miningTimeLeft / (60 * 1000));

                    // حساب العملات المتراكمة للمناجم
                    let accumulatedMineCoins = 0;
                    if (mineHours > 0) {
                        const hoursToCalculate = Math.min(mineHours, 24);
                        for (let mine = 0; mine < mineCount; mine++) {
                            for (let hour = 0; hour < hoursToCalculate; hour++) {
                                accumulatedMineCoins += Math.floor(Math.random() * (20000 - 2500 + 1)) + 2500;
                            }
                        }
                    }

                    let miningInfo = `⛏️ عدد المناجم: **${mineCount}**\n`;
                    miningInfo += `💎 الدخل المتوقع: **${(mineCount * 11250).toLocaleString()}** عملة/ساعة\n`;

                    if (mineHours > 0) {
                        miningInfo += `💰 العملات المتراكمة: **${accumulatedMineCoins.toLocaleString()}** عملة\n`;
                        miningInfo += `✅ **متاح للجمع الآن!** (${Math.min(mineHours, 24)} ساعة)`;
                    } else {
                        miningInfo += `⏱️ الوقت للجمع: **${miningMinutesLeft}** دقيقة`;
                    }

                    embed.addFields({ name: '⛏️ معلومات المناجم:', value: miningInfo, inline: false });
                }

                // معلومات مستخرجات النفط (إذا كان يملك مستخرجات)
                if (oilExtractorCount > 0) {
                    const oilTimeLeft = oneHour - (timeSinceLastOil % oneHour);
                    const oilMinutesLeft = Math.floor(oilTimeLeft / (60 * 1000));

                    // حساب العملات المتراكمة لمستخرجات النفط
                    let accumulatedOilCoins = 0;
                    if (oilHours > 0) {
                        const hoursToCalculate = Math.min(oilHours, 24);
                        for (let extractor = 0; extractor < oilExtractorCount; extractor++) {
                            for (let hour = 0; hour < hoursToCalculate; hour++) {
                                accumulatedOilCoins += Math.floor(Math.random() * (200000 - 50000 + 1)) + 50000;
                            }
                        }
                    }

                    let oilInfo = `🛢️ عدد المستخرجات: **${oilExtractorCount}**\n`;
                    oilInfo += `🔥 الدخل المتوقع: **${(oilExtractorCount * 125000).toLocaleString()}** عملة/ساعة\n`;

                    if (oilHours > 0) {
                        oilInfo += `💰 العملات المتراكمة: **${accumulatedOilCoins.toLocaleString()}** عملة\n`;
                        oilInfo += `✅ **متاح للجمع الآن!** (${Math.min(oilHours, 24)} ساعة)`;
                    } else {
                        oilInfo += `⏱️ الوقت للجمع: **${oilMinutesLeft}** دقيقة`;
                    }

                    embed.addFields({ name: '🛢️ معلومات النفط:', value: oilInfo, inline: false });
                }

                // معلومات الصواريخ والدفاعات (إذا كان يملكها)
                const missiles = userItems.filter(item => item.item_name.startsWith('صاروخ'));
                const missileCounts = {};
                missiles.forEach(missile => {
                    missileCounts[missile.item_name] = missile.quantity;
                });

                const ammoCount = await getUserItemCount(user.id, 'رصاص دفاع جوي');
                const hasAirDefense = await hasUserItem(user.id, 'نظام الدفاع الجوي');
                const hasWalls = await hasUserItem(user.id, 'أسوار');

                if (Object.keys(missileCounts).length > 0 || ammoCount > 0 || hasAirDefense || hasWalls) {
                    let defenseInfo = '';
                    if (hasWalls) defenseInfo += '🏰 أسوار: **محمي**\n';
                    if (hasAirDefense) defenseInfo += `🛡️ دفاع جوي: **نشط** (${ammoCount} رصاصة)\n`;

                    Object.entries(missileCounts).forEach(([missile, count]) => {
                        const missileEmoji = missile.includes('عادي') ? '🚀' : missile.includes('متوسط') ? '💥' : '🔥';
                        defenseInfo += `${missileEmoji} ${missile}: **${count}**\n`;
                    });

                    if (defenseInfo) {
                        embed.addFields({ name: '🔫 الأسلحة والدفاعات:', value: defenseInfo, inline: false });
                    }
                }

                // معلومات التحالف
                if (userProfile.alliance_id) {
                    const alliance = await Alliance.findOne({ id: userProfile.alliance_id });
                    if (alliance) {
                        const rankEmoji = userProfile.alliance_rank === 'قائد التحالف' ? '👑' : 
                                         userProfile.alliance_rank === 'مشرف التحالف' ? '⭐' : '🛡️';
                        embed.addFields({ 
                            name: '🏛️ معلومات التحالف:', 
                            value: `${rankEmoji} **${alliance.name}**\n🏅 الرتبة: **${userProfile.alliance_rank}**`, 
                            inline: false 
                        });
                    }
                } else {
                    embed.addFields({ name: '🏛️ التحالف:', value: '❌ غير منضم لأي تحالف', inline: false });
                }

                embed.setFooter({ text: '💪 ابقَ قوياً وطور جيشك!' })
                     .setTimestamp();

                // إضافة أزرار تفاعلية (للملف الشخصي فقط)
                let components = [];
                if (isOwnProfile) {
                    const canCollectIncome = (mineCount > 0 && mineHours > 0) || (oilExtractorCount > 0 && oilHours > 0);

                    const row1 = new discord.ActionRowBuilder()
                        .addComponents(
                            new discord.ButtonBuilder()
                                .setCustomId('collect_income')
                                .setLabel('💰 جمع الدخل')
                                .setStyle(discord.ButtonStyle.Success)
                                .setDisabled(!canCollectIncome),
                            new discord.ButtonBuilder()
                                .setCustomId('view_inventory')
                                .setLabel('📦 المخزون')
                                .setStyle(discord.ButtonStyle.Primary),
                            new discord.ButtonBuilder()
                                .setCustomId('salary_info')
                                .setLabel('💸 معلومات الراتب')
                                .setStyle(discord.ButtonStyle.Secondary)
                        );

                    components.push(row1);
                }

                const profileMessage = await message.channel.send({ 
                    embeds: [embed], 
                    components: components 
                });
                // معالج الأزرار (للملف الشخصي فقط)
                if (isOwnProfile && components.length > 0) {
                    const filter = i => i.user.id === message.author.id;
                    const collector = profileMessage.createMessageComponentCollector({
                        filter,
                        time: 300000 // 5 دقائق
                    });

                    collector.on('collect', async i => {
                        try {
                            if (i.customId === 'collect_income') {
                                // تنفيذ أمر جمع الدخل
                                const currentTime = new Date();
                                const updatedUser = await User.findOne({ id: user.id });
                                const updatedMineCount = await getUserItemCount(user.id, 'المنجم');
                                const updatedOilCount = await getUserItemCount(user.id, 'مستخرج النفط');

                                let totalIncome = 0;
                                let incomeDetails = '';

                                if (updatedMineCount > 0) {
                                    const timeSinceLastMining = currentTime - new Date(updatedUser.lastMiningCollected);
                                    const currentMineHours = Math.floor(timeSinceLastMining / oneHour);

                                    if (currentMineHours > 0) {
                                        const hoursToCalculate = Math.min(currentMineHours, 24);
                                        let mineIncome = 0;
                                        for (let i = 0; i < updatedMineCount; i++) {
                                            for (let j = 0; j < hoursToCalculate; j++) {
                                                mineIncome += Math.floor(Math.random() * (20000 - 2500 + 1)) + 2500;
                                            }
                                        }
                                        totalIncome += mineIncome;
                                        incomeDetails += `⛏️ المناجم: **${mineIncome.toLocaleString()}** عملة\n`;
                                        updatedUser.lastMiningCollected = new Date(updatedUser.lastMiningCollected.getTime() + (hoursToCalculate * oneHour));
                                    }
                                }

                                if (updatedOilCount > 0) {
                                    const timeSinceLastOil = currentTime - new Date(updatedUser.lastOilCollected);
                                    const currentOilHours = Math.floor(timeSinceLastOil / oneHour);

                                    if (currentOilHours > 0) {
                                        const hoursToCalculate = Math.min(currentOilHours, 24);
                                        let oilIncome = 0;
                                        for (let i = 0; i < updatedOilCount; i++) {
                                            for (let j = 0; j < hoursToCalculate; j++) {
                                                oilIncome += Math.floor(Math.random() * (200000 - 50000 + 1)) + 50000;
                                            }
                                        }
                                        totalIncome += oilIncome;
                                        incomeDetails += `🛢️ النفط: **${oilIncome.toLocaleString()}** عملة\n`;
                                        updatedUser.lastOilCollected = new Date(updatedUser.lastOilCollected.getTime() + (hoursToCalculate * oneHour));
                                    }
                                }

                                if (totalIncome > 0) {
                                    updatedUser.coins += totalIncome;
                                    await updatedUser.save();

                                    const incomeEmbed = new discord.EmbedBuilder()
                                        .setColor('#00FF00')
                                        .setTitle('💰 تم جمع الدخل بنجاح!')
                                        .setDescription(incomeDetails + `\n💎 **إجمالي الدخل: ${totalIncome.toLocaleString()} عملة**\n💰 **عملاتك الحالية: ${updatedUser.coins.toLocaleString()} عملة**`)
                                        .setTimestamp();

                                    await i.reply({ embeds: [incomeEmbed], ephemeral: true });
                                } else {
                                    await i.reply({ content: '❌ لا يوجد دخل متاح للجمع حالياً!', ephemeral: true });
                                }

                            } else if (i.customId === 'view_inventory') {
                                // عرض المخزون
                                await i.deferReply({ ephemeral: true });

                                // استدعاء أمر المخزون
                                const tempMessage = {
                                    author: i.user,
                                    channel: i.channel,
                                    reply: async (content) => {
                                        await i.editReply(content);
                                    }
                                };

                                // تنفيذ منطق المخزون
                                const updatedUserItems = await UserItem.find({ user_id: i.user.id });
                                const missiles = updatedUserItems.filter(item => item.item_name.startsWith('صاروخ'));
                                const missileCounts = {};
                                missiles.forEach(missile => {
                                    missileCounts[missile.item_name] = missile.quantity;
                                });

                                const ammoCount = await getUserItemCount(i.user.id, 'رصاص دفاع جوي');

                                const inventoryEmbed = new discord.EmbedBuilder()
                                    .setColor('#00FF00')
                                    .setTitle('📦 مخزون الأسلحة')
                                    .setDescription(`مخزون ${i.user.username}`)
                                    .addFields(
                                        { name: '🛡️ رصاص دفاع جوي:', value: `${ammoCount}`, inline: true },
                                        ...Object.entries(missileCounts).map(([missile, count]) => ({
                                            name: missile,
                                            value: `${count}`,
                                            inline: true
                                        }))
                                    )
                                    .setFooter({ text: 'استخدم !شراء لزيادة مخزونك.' });

                                await i.editReply({ embeds: [inventoryEmbed] });

                            } else if (i.customId === 'salary_info') {
                                // معلومات الراتب المفصلة
                                const salaryEmbed = new discord.EmbedBuilder()
                                    .setColor('#FFD700')
                                    .setTitle('💸 معلومات الراتب المفصلة')
                                    .setDescription(`تفاصيل راتب جيش ${userProfile.army_name}`)
                                    .addFields(
                                        { name: '💰 عملاتك الحالية:', value: userProfile.coins.toString(), inline: true },
                                        { name: '💸 الراتب المطلوب (كل ساعة):', value: totalSalary.toString(), inline: true },
                                        { name: '⏰ الوقت حتى الراتب التالي:', value: `${minutesLeftSalary} دقيقة`, inline: true },
                                        { name: '⚔️ الجنود العاديون:', value: `${userProfile.soldiers || 0} (${soldiersSalary} عملة)`, inline: true },
                                        { name: '🎖️ الضباط:', value: `${userProfile.officers || 0} (${officersSalary} عملة)`, inline: true },
                                        { name: '🏅 العقداء:', value: `${userProfile.colonels || 0} (${colonelsSalary} عملة)`, inline: true },
                                        { name: '👑 اللوائات:', value: `${userProfile.generals || 0} (${generalsSalary} عملة)`, inline: true },
                                        { name: '😞 جنود ضعيفي الهمة:', value: `${userProfile.lowMoraleSoldiers || 0} (${lowMoraleSalary} عملة)`, inline: true },
                                        { name: '⚠️ حالة الراتب:', value: userProfile.coins >= totalSalary ? '✅ كافي' : '❌ غير كافي', inline: true }
                                    )
                                    .setFooter({ text: 'يتم دفع الرواتب تلقائياً كل ساعة' });

                                await i.reply({ embeds: [salaryEmbed], ephemeral: true });
                            }
                        } catch (error) {
                            console.error('Error handling profile button:', error);
                            await i.reply({ content: 'حدث خطأ أثناء تنفيذ العملية.', ephemeral: true });
                        }
                    });

                    collector.on('end', () => {
                        const disabledRow = new discord.ActionRowBuilder()
                            .addComponents(
                                new discord.ButtonBuilder()
                                    .setCustomId('collect_income')
                                    .setLabel('💰 جمع الدخل')
                                    .setStyle(discord.ButtonStyle.Success)
                                    .setDisabled(true),
                                new discord.ButtonBuilder()
                                    .setCustomId('view_inventory')
                                    .setLabel('📦 المخزون')
                                    .setStyle(discord.ButtonStyle.Primary)
                                    .setDisabled(true),
                                new discord.ButtonBuilder()
                                    .setCustomId('salary_info')
                                    .setLabel('💸 معلومات الراتب')
                                    .setStyle(discord.ButtonStyle.Secondary)
                                    .setDisabled(true)
                            );

                        profileMessage.edit({ components: [disabledRow] }).catch(console.error);
                    });
                }

            } catch (error) {
                console.error('Error in !profile command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر لشراء العناصر
        const items = [
            { name: 'قاعدة', price: 10000, required: null },
            { name: 'قاعدة الصواريخ', price: 5000, required: 'قاعدة' },
            { name: 'نظام الدفاع الجوي', price: 3000, required: 'قاعدة' },
            { name: 'أسوار', price: 2000, required: 'قاعدة' },
            { name: 'معسكر التدريب', price: 100000, required: 'قاعدة' },
            { name: 'المنجم', price: 500000, required: 'قاعدة' },
            { name: 'مستخرج النفط', price: 1500000, required: 'قاعدة' },
            { name: 'صاروخ عادي', price: 1000, required: 'قاعدة الصواريخ' },
            { name: 'صاروخ متوسط', price: 2000, required: 'قاعدة الصواريخ' },
            { name: 'صاروخ مدمر', price: 5000, required: 'قاعدة الصواريخ' },
            { name: 'جندي', price: 3, required: null },
            { name: 'رصاص دفاع جوي', price: 1500, required: 'نظام الدفاع الجوي' }
        ];

        // أمر لشراء العناصر
if (message.content.startsWith('!شراء')) {
    try {
        if  (!PublicCategory.includes(message.channel.parentId)) {
                    return message.reply('يمكن استخدام هذا الامر في القنوات العامة فقط');
                }
        console.log('Processing !شراء command');
        const user = await User.findOne({ id: message.author.id });
        if (!user) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

        const userItems = await UserItem.find({ user_id: message.author.id });
        const userItemNames = userItems.map(item => item.item_name);

        // حساب عدد المناجم ومستخرجات النفط
        const mineCount = await getUserItemCount(message.author.id, 'المنجم');
        const oilExtractorCount = await getUserItemCount(message.author.id, 'مستخرج النفط');

        const itemsToHideIfOwned = ['قاعدة', 'قاعدة الصواريخ', 'نظام الدفاع الجوي', 'أسوار', 'معسكر التدريب'];

        const availableItems = items.filter(item => {
            if (itemsToHideIfOwned.includes(item.name) && userItemNames.includes(item.name)) {
                return false;
            }
            if (item.required === null) return true;
            return userItemNames.includes(item.required);
        });

        const embed = new discord.EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('🛒 قائمة الشراء')
            .setDescription('إختر العنصر الذي ترغب في شرائه عن طريق كتابة رقمه أو اسمه:')
            .addFields(
                availableItems.map((item, index) => {
                    let displayValue = `💰 السعر: **${item.price.toLocaleString()}** عملة`;

                    // إضافة معلومات خاصة للمناجم ومستخرجات النفط
                    if (item.name === 'المنجم') {
                        displayValue += `\n⛏️ تملك حالياً: **${mineCount}** منجم`;
                        displayValue += `\n💎 الدخل المتوقع: **${((mineCount + 1) * 11250).toLocaleString()}** عملة/ساعة`;
                    } else if (item.name === 'مستخرج النفط') {
                        displayValue += `\n🛢️ تملك حالياً: **${oilExtractorCount}** مستخرج`;
                        displayValue += `\n🔥 الدخل المتوقع: **${((oilExtractorCount + 1) * 125000).toLocaleString()}** عملة/ساعة`;
                    }

                    return {
                        name: `${index + 1}. ${item.name}`,
                        value: displayValue,
                        inline: true
                    };
                })
            )
            .setFooter({ text: 'اكتب اسم العنصر أو رقمه للشراء.' });

        message.channel.send({ embeds: [embed] }).then(() => {
            const filter = (response) => response.author.id === message.author.id;
            const collector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

            collector.on('collect', async (response) => {
                try {
                    const input = response.content.trim();
                    const selectedItem = availableItems.find((item, index) => item.name === input || (index + 1).toString() === input);

                    if (!selectedItem) {
                        return message.reply('العنصر المحدد غير صحيح. يرجى المحاولة مرة أخرى.');
                    }

                    if (selectedItem.name === 'جندي' || selectedItem.name === 'رصاص دفاع جوي' || selectedItem.name.startsWith('صاروخ')) {
                        message.reply(`كم عدد ${selectedItem.name} التي ترغب في شرائها؟ (اكتب رقمًا)`).then(() => {
                            const quantityCollector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

                            quantityCollector.on('collect', async (quantityResponse) => {
                                try {
                                    const quantity = parseInt(quantityResponse.content.trim());

                                    if (isNaN(quantity) || quantity <= 0) {
                                        return message.reply('يرجى إدخال عدد صحيح موجب.');
                                    }

                                    const totalCost = quantity * selectedItem.price;

                                    if (user.coins < totalCost) {
                                        return message.reply(`ليس لديك ما يكفي من العملات لشراء ${quantity} من ${selectedItem.name}. تحتاج إلى ${totalCost} عملة.`);
                                    }

                                    if (selectedItem.name === 'جندي') {
                                        user.soldiers += quantity;
                                    } else {
                                        // التحقق من الحدود للمناجم ومستخرجات النفط
                                        if (ITEM_LIMITS[selectedItem.name]) {
                                            const currentCount = await getUserItemCount(message.author.id, selectedItem.name);
                                            if (currentCount + quantity > ITEM_LIMITS[selectedItem.name]) {
                                                const maxCanBuy = ITEM_LIMITS[selectedItem.name] - currentCount;
                                                if (maxCanBuy <= 0) {
                                                    return i.reply(`لا يمكنك شراء المزيد من ${selectedItem.name}. الحد الأقصى هو ${ITEM_LIMITS[selectedItem.name]}.`);
                                                }
                                                return i.reply(`يمكنك شراء ${maxCanBuy} فقط من ${selectedItem.name} (الحد الأقصى ${ITEM_LIMITS[selectedItem.name]}).`);
                                            }
                                        }
                                        
                                        await addUserItem(message.author.id, selectedItem.name, quantity);
                                    }

                                    user.coins -= totalCost;
                                    await user.save();
                                    message.reply(`تم شراء ${quantity} من ${selectedItem.name} بنجاح!`);
                                } catch (error) {
                                    console.error('Error processing quantity:', error);
                                    message.reply('حدث خطأ أثناء معالجة الكمية. يرجى المحاولة مرة أخرى.');
                                }
                            });

                            quantityCollector.on('end', (collected) => {
                                if (collected.size === 0) {
                                    message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                                }
                            });
                        });
                    } else {
                        if (user.coins < selectedItem.price) {
                            return message.reply(`ليس لديك ما يكفي من العملات لشراء ${selectedItem.name}. تحتاج إلى ${selectedItem.price} عملة.`);
                        }

                        // التحقق من الحدود للمناجم ومستخرجات النفط
                        if (ITEM_LIMITS[selectedItem.name]) {
                            const currentCount = await getUserItemCount(message.author.id, selectedItem.name);
                            if (currentCount >= ITEM_LIMITS[selectedItem.name]) {
                                return message.reply(`لا يمكنك شراء المزيد من ${selectedItem.name}. الحد الأقصى هو ${ITEM_LIMITS[selectedItem.name]}.`);
                            }
                        }

                        user.coins -= selectedItem.price;
                        await user.save();
                        await addUserItem(message.author.id, selectedItem.name, 1);
                        message.reply(`تم شراء ${selectedItem.name} بنجاح!`);
                    }
                } catch (error) {
                    console.error('Error processing purchase:', error);
                    message.reply('حدث خطأ أثناء معالجة عملية الشراء. يرجى المحاولة مرة أخرى.');
                }
            });

            collector.on('end', (collected) => {
                if (collected.size === 0) {
                    message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                }
            });
        });
    } catch (error) {
        console.error('Error in !شراء command:', error);
        message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
    }
}

                    // أمر لعرض المخزون
                    if (message.content.startsWith('!مخزون')) {
                    try {
                    const userItems = await UserItem.find({ user_id: message.author.id });

                    const missiles = userItems.filter(item => item.item_name.startsWith('صاروخ'));
                    const missileCounts = {};
                    missiles.forEach(missile => {
                        missileCounts[missile.item_name] = missile.quantity;
                    });

                    const ammoCount = await getUserItemCount(message.author.id, 'رصاص دفاع جوي');

                    const embed = new discord.EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('مخزون الأسلحة')
                        .setDescription(`مخزون ${message.author.username}`)
                        .addFields(
                            { name: 'رصاص دفاع جوي:', value: `${ammoCount}`, inline: true },
                            ...Object.entries(missileCounts).map(([missile, count]) => ({
                                name: missile,
                                value: `${count}`,
                                inline: true
                            }))
                        )
                        .setFooter({ text: 'استخدم !شراء لزيادة مخزونك.' });

                    message.channel.send({ embeds: [embed] });
                    } catch (error) {
                    console.error('Error in !مخزون command:', error);
                    message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
                    }
                    }
// امر الهجوم بالصواريخ
if (message.content.startsWith('!قصف')) {
    try {
        if (!warCategory.includes(message.channel.parentId)) {
                    return message.reply('هذا الأمر متاح فقط في فئة الحروب. يرجى استخدام الأمر في القناة المخصصة للحروب.');
                }
        let opponent = message.mentions.users.first();
        if (!opponent) return message.reply('من فضلك حدد لاعبًا للقصف!');

        const attacker = await User.findOne({ id: message.author.id });
        if (!attacker) return message.reply('لم تقم بإنشاء جيش بعد. استخدم !البدء لإنشاء جيش.');

        const opponentUser = await User.findOne({ id: opponent.id });
        if (!opponentUser) return message.reply('اللاعب المحدد لا يملك جيشاً!');

        // التحقق من التحالفات والحروب
        if (attacker.alliance_id && opponentUser.alliance_id) {
            if (attacker.alliance_id === opponentUser.alliance_id) {
                return message.reply('لا يمكنك قصف عضو من نفس تحالفك!');
            }

            const attackerAlliance = await Alliance.findOne({ id: attacker.alliance_id });
            if (attackerAlliance && !attackerAlliance.wars.includes(opponentUser.alliance_id)) {
                return message.reply('لا يمكنك قصف هذا اللاعب. يجب أن يكون هناك حرب بين التحالفات أولاً!');
            }
        }

        const attackerItems = await UserItem.find({ user_id: message.author.id });
        const attackerMissiles = attackerItems.filter(item => item.item_name.startsWith('صاروخ') && item.quantity > 0);

        if (attackerMissiles.length === 0) {
            return message.reply('لا تمتلك أي صواريخ للهجوم!');
        }

        const missileCounts = attackerMissiles.reduce((acc, item) => {
            acc[item.item_name] = (acc[item.item_name] || 0) + item.quantity;
            return acc;
        }, {});

        const embed = new discord.EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('اختر نوع الصاروخ للهجوم')
            .setDescription('إختر نوع الصاروخ الذي ترغب في استخدامه للهجوم:')
            .addFields(
                Object.keys(missileCounts).map((missileName, index) => ({
                    name: `${index + 1}. ${missileName}`,
                    value: `الكمية المتاحة: ${missileCounts[missileName]}`,
                    inline: true
                }))
            )
            .setFooter({ text: 'اكتب رقم الصاروخ الذي ترغب في استخدامه.' });

        message.channel.send({ embeds: [embed] }).then(() => {
            const filter = (response) => response.author.id === message.author.id;
            const collector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

            collector.on('collect', async (response) => {
                try {
                    const missileIndex = parseInt(response.content.trim()) - 1;

                    if (isNaN(missileIndex) || missileIndex < 0 || missileIndex >= Object.keys(missileCounts).length) {
                        return message.reply('اختيار غير صحيح. يرجى المحاولة مرة أخرى.');
                    }

                    const selectedMissile = Object.keys(missileCounts)[missileIndex];

                    message.reply(`كم عدد ${selectedMissile} التي ترغب في إطلاقها؟ (اكتب رقمًا)`).then(() => {
                        const quantityCollector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

                        quantityCollector.on('collect', async (quantityResponse) => {
                            try {
                                const quantity = parseInt(quantityResponse.content.trim());

                                if (isNaN(quantity) || quantity <= 0) {
                                    return message.reply('يرجى إدخال عدد صحيح موجب.');
                                }

                                if (quantity > missileCounts[selectedMissile]) {
                                    return message.reply(`ليس لديك ما يكفي من ${selectedMissile} لإطلاق ${quantity}. الكمية المتاحة: ${missileCounts[selectedMissile]}`);
                                }

                                const defenderItems = await UserItem.find({ user_id: opponent.id });
                                const hasAirDefense = defenderItems.some(item => item.item_name === 'نظام الدفاع الجوي');
                                const airDefenseBullets = defenderItems.filter(item => item.item_name === 'رصاص دفاع جوي');
                                const totalAirDefenseBullets = airDefenseBullets.reduce((total, item) => total + item.quantity, 0);

                                if (hasAirDefense && totalAirDefenseBullets >= quantity) {
                                    // خصم رصاص الدفاع الجوي المستخدم (الكمية المطلوبة فقط)
                                    await removeUserItem(opponent.id, 'رصاص دفاع جوي', quantity);

                                    // خصم الصواريخ المستخدمة
                                    await removeUserItem(message.author.id, selectedMissile, quantity);

                                    const interceptEmbed = new discord.EmbedBuilder()
                                        .setColor('#00FF00')
                                        .setTitle('تم اعتراض الصواريخ!')
                                        .setDescription(`تم اعتراض ${quantity} من ${selectedMissile} بواسطة نظام الدفاع الجوي الخاص بـ ${opponent.username}.`)
                                        .addFields(
                                            { name: 'رصاص دفاع جوي المتبقي:', value: `${totalAirDefenseBullets - quantity}` },
                                            { name: 'الصواريخ المتبقية:', value: `${missileCounts[selectedMissile] - quantity}` }
                                        )
                                        .setFooter({ text: 'تم استهلاك رصاص دفاع جوي وصواريخ.' });

                                    message.channel.send({ embeds: [interceptEmbed] });
                                } else {
                                    let soldiersKilled = 0;
                                    let wallDestroyed = false;

                                    switch (selectedMissile) {
                                        case 'صاروخ عادي':
                                            soldiersKilled = (Math.floor(Math.random() * 10) + 1) * quantity;
                                            break;
                                        case 'صاروخ متوسط':
                                            soldiersKilled = (Math.floor(Math.random() * 20) + 10) * quantity;
                                            break;
                                        case 'صاروخ مدمر':
                                            soldiersKilled = (Math.floor(Math.random() * 30) + 20) * quantity;
                                            wallDestroyed = true;
                                            break;
                                    }

                                    let newSoldiers = opponentUser.soldiers - soldiersKilled;
                                    if (newSoldiers < 0) newSoldiers = 0;

                                    if (newSoldiers === 0) {
                                        const totalCoinsWon = opponentUser.coins;
                                        
                                        // تحديث عملات المهاجم
                                        await User.updateOne({ id: message.author.id }, { $inc: { coins: totalCoinsWon } });
                                        
                                        // خصم الصواريخ المستخدمة
                                        await removeUserItem(message.author.id, selectedMissile, quantity);

                                        const victoryEmbed = new discord.EmbedBuilder()
                                            .setColor('#FF0000')
                                            .setTitle('تم القضاء على الجيش بالكامل!')
                                            .setDescription(`لقد هزمت ${opponent.username} بالكامل! لقد حصلت على جميع عملاتهم.`)
                                            .addFields(
                                                { name: 'العملات المكتسبة:', value: `${totalCoinsWon}` }
                                            )
                                            .setFooter({ text: 'الهجوم تم بنجاح!' });

                                        await message.channel.send({ embeds: [victoryEmbed] });

                                        // تأخير عملية الحذف للتأكد من عدم محاولة الوصول إلى الوثيقة بعد حذفها
                                        setTimeout(async () => {
                                            await User.deleteOne({ id: opponent.id });
                                            await UserItem.deleteMany({ user_id: opponent.id });
                                        }, 1000);

                                        return;
                                    }

                                    await User.updateOne({ id: opponent.id }, { $set: { soldiers: newSoldiers } });

                                    if (wallDestroyed) {
                                        await UserItem.deleteOne({ user_id: opponent.id, item_name: 'أسوار' });
                                    }

                                    // خصم الصواريخ المستخدمة
                                    await removeUserItem(message.author.id, selectedMissile, quantity);

                                    const resultEmbed = new discord.EmbedBuilder()
                                        .setColor('#FF0000')
                                        .setTitle('نتيجة الهجوم بالصواريخ')
                                        .setDescription(`تم تنفيذ الهجوم باستخدام ${selectedMissile}!`)
                                        .addFields(
                                            { name: 'الخسائر:', value: `قتل ${soldiersKilled} جنديًا` },
                                            { name: 'تدمير السور:', value: wallDestroyed ? 'تم تدمير السور!' : 'لم يتم تدمير السور.' },
                                            { name: 'الصواريخ المتبقية:', value: `${missileCounts[selectedMissile] - quantity}` }
                                        )
                                        .setFooter({ text: 'الهجوم تم بنجاح!' });

                                    message.channel.send({ embeds: [resultEmbed] });
                                }
                            } catch (error) {
                                console.error('Error processing missile quantity:', error);
                                message.reply('حدث خطأ أثناء معالجة الكمية. يرجى المحاولة مرة أخرى.');
                            }
                        });

                        quantityCollector.on('end', (collected) => {
                            if (collected.size === 0) {
                                message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                            }
                        });
                    });
                } catch (error) {
                    console.error('Error processing missile attack:', error);
                    message.reply('حدث خطأ أثناء معالجة الهجوم بالصواريخ. يرجى المحاولة مرة أخرى.');
                }
            });

            collector.on('end', (collected) => {
                if (collected.size === 0) {
                    message.reply('انتهى الوقت. يرجى المحاولة مرة أخرى.');
                }
            });
        });
    } catch (error) {
        console.error('Error in !قصف command:', error);
        message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
    }
}

        // أمر عرض حالة الاقتصاد والتضخم
        if (message.content.startsWith('!الاقتصاد')) {
            try {
                const economyInfo = await getEconomyInfo();

                // حساب النسب المئوية للتغيير
                const buyChangePercent = ((economyInfo.buyMultiplier - 1) * 100).toFixed(1);
                const sellChangePercent = ((economyInfo.sellMultiplier - 1) * 100).toFixed(1);

                const economyDisplayEmbed = new discord.EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('📊 حالة الاقتصاد')
                    .setDescription('معلومات مفصلة عن الوضع الاقتصادي الحالي في اللعبة')
                    .addFields(
                        { name: '💰 إجمالي العملات في الاقتصاد:', value: `${economyInfo.totalCoins.toLocaleString()} عملة`, inline: true },
                        { name: '👥 عدد اللاعبين:', value: `${economyInfo.totalPlayers.toLocaleString()} لاعب`, inline: true },
                        { name: '📈 حالة الاقتصاد:', value: economyInfo.economyStateName, inline: true },
                        { name: '🛒 معدل الشراء الحالي:', value: `${economyInfo.buyRate.toLocaleString()} عملة = 1M كريدت`, inline: false },
                        { name: '📊 تغيير سعر الشراء:', value: `${buyChangePercent > 0 ? '+' : ''}${buyChangePercent}% من السعر الأساسي`, inline: true },
                        { name: '💸 معدل الصرف الحالي:', value: `${economyInfo.sellRate.toLocaleString()} عملة = 1M كريدت`, inline: false },
                        { name: '📉 تغيير سعر الصرف:', value: `${sellChangePercent > 0 ? '+' : ''}${sellChangePercent}% من السعر الأساسي`, inline: true },
                        { name: '⚖️ السعر الأساسي:', value: `${BASE_EXCHANGE_RATE.toLocaleString()} عملة = 1M كريدت`, inline: false }
                    )
                    .setFooter({ text: 'الأسعار تتغير تلقائياً حسب إجمالي العملات في الاقتصاد' })
                    .setTimestamp();

                // إضافة شرح حالة الاقتصاد
                let economyExplanation = '';
                switch (economyInfo.economyState) {
                    case 'VERY_LOW':
                        economyExplanation = '🔴 اقتصاد ضعيف جداً: الشراء غالي والصرف قليل';
                        break;
                    case 'LOW':
                        economyExplanation = '🟠 اقتصاد ضعيف: الشراء غالي نسبياً والصرف قليل نسبياً';
                        break;
                    case 'NORMAL':
                        economyExplanation = '🟡 اقتصاد طبيعي: أسعار متوازنة';
                        break;
                    case 'HIGH':
                        economyExplanation = '🟢 اقتصاد قوي: الشراء رخيص والصرف عالي';
                        break;
                    case 'VERY_HIGH':
                        economyExplanation = '🔵 اقتصاد قوي جداً: الشراء رخيص جداً والصرف عالي جداً';
                        break;
                    case 'EXTREME':
                        economyExplanation = '🟣 اقتصاد مفرط: الشراء رخيص مفرط والصرف مفرط';
                        break;
                }

                economyDisplayEmbed.addFields({ name: '💡 توضيح:', value: economyExplanation, inline: false });

                message.channel.send({ embeds: [economyDisplayEmbed] });
            } catch (error) {
                console.error('Error in !الاقتصاد command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر عرض إجمالي العملات في اللعبة (للمشرفين فقط)
        if (message.content.startsWith('!اجمالي')) {
            try {
                if (!message.member.permissions.has('Administrator')) {
                    return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
                }

                const economy = await calculateTotalEconomy();

                const totalEmbed = new discord.EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('📊 إجمالي العملات في اللعبة')
                    .setDescription('معلومات إجمالية عن العملات الموجودة في اللعبة')
                    .addFields(
                        { name: '💰 إجمالي العملات:', value: `${economy.totalCoins.toLocaleString()} عملة`, inline: true },
                        { name: '👥 عدد اللاعبين:', value: `${economy.totalPlayers.toLocaleString()} لاعب`, inline: true },
                        { name: '📈 متوسط العملات لكل لاعب:', value: economy.totalPlayers > 0 ? `${Math.floor(economy.totalCoins / economy.totalPlayers).toLocaleString()} عملة` : '0 عملة', inline: true }
                    )
                    .setFooter({ text: `تم الطلب بواسطة ${message.author.username}` })
                    .setTimestamp();

                await message.channel.send({ embeds: [totalEmbed] });
            } catch (error) {
                console.error('Error in !اجمالي command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر حذف رسائل إنشاء التذاكر (للمشرفين فقط)
        if (message.content.startsWith('!rem')) {
            try {
                if (!message.member.permissions.has('Administrator')) {
                    return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
                }

                // البحث عن رسائل التذاكر في القناة الحالية
                const messages = await message.channel.messages.fetch({ limit: 100 });
                let deletedCount = 0;

                for (const [, msg] of messages) {
                    // التحقق من أن الرسالة من البوت وتحتوي على أزرار التذاكر
                    if (msg.author.id === client.user.id && 
                        msg.embeds.length > 0 && 
                        msg.components.length > 0) {

                        // التحقق من وجود زر فتح التذكرة
                        const hasTicketButton = msg.components.some(row => 
                            row.components.some(component => 
                                component.customId && component.customId.startsWith('open_ticket_')
                            )
                        );

                        if (hasTicketButton) {
                            try {
                                await msg.delete();
                                deletedCount++;
                            } catch (error) {
                                console.error('Error deleting ticket message:', error);
                            }
                        }
                    }
                }

                const resultEmbed = new discord.EmbedBuilder()
                    .setColor(deletedCount > 0 ? '#00FF00' : '#FFA500')
                    .setTitle('🗑️ نتيجة حذف رسائل التذاكر')
                    .setDescription(`تم حذف ${deletedCount} رسالة تذكرة من هذه القناة`)
                    .setFooter({ text: `تم التنفيذ بواسطة ${message.author.username}` })
                    .setTimestamp();

                await message.channel.send({ embeds: [resultEmbed] });
            } catch (error) {
                console.error('Error in !rem command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }

        // أمر عرض إحصائيات الدعوات
        if (message.content.startsWith('!دعواتي')) {
            try {
                const guild = message.guild;
                if (!guild) return;

                const invites = await guild.invites.fetch();
                const userInvites = invites.filter(invite => invite.inviter && invite.inviter.id === message.author.id);

                let totalUses = 0;
                let inviteList = '';

                if (userInvites.size > 0) {
                    userInvites.forEach(invite => {
                        totalUses += invite.uses;
                        inviteList += `\n🔗 \`${invite.code}\` - ${invite.uses} استخدام`;
                    });
                } else {
                    inviteList = 'لا توجد دعوات نشطة';
                }

                const inviteStatsEmbed = new discord.EmbedBuilder()
                    .setColor('#0099FF')
                    .setTitle('📊 إحصائيات الدعوات')
                    .setDescription(`إحصائيات دعوات ${message.author.username}`)
                    .addFields(
                        { name: '📈 إجمالي الاستخدامات:', value: `${totalUses}` },
                        { name: '💰 العملات المكتسبة:', value: `${(totalUses * 500000).toLocaleString()} عملة` },
                        { name: '🔗 الدعوات النشطة:', value: inviteList || 'لا توجد دعوات' }
                    )
                    .setFooter({ text: 'كل دعوة ناجحة = 500,000 عملة!' })
                    .setTimestamp();

                message.channel.send({ embeds: [inviteStatsEmbed] });
            } catch (error) {
                console.error('Error in !دعواتي command:', error);
                message.reply('حدث خطأ أثناء جلب إحصائيات الدعوات.');
            }
        }

        // أمر إنشاء دعوة جديدة
        if (message.content.startsWith('!دعوة')) {
            try {
                const channel = message.channel;

                // إنشاء دعوة جديدة
                const invite = await channel.createInvite({
                    maxAge: 0, // لا تنتهي صلاحيتها
                    maxUses: 0, // استخدامات غير محدودة
                    unique: true // دعوة فريدة
                });

                const inviteEmbed = new discord.EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('🎯 دعوة جديدة تم إنشاؤها!')
                    .setDescription('استخدم هذه الدعوة لدعوة أصدقائك واحصل على مكافآت!')
                    .addFields(
                        { name: '🔗 رابط الدعوة:', value: `https://discord.gg/${invite.code}` },
                        { name: '💰 المكافأة لكل دعوة:', value: '500,000 عملة' },
                        { name: '⚠️ ملاحظة:', value: 'المكافأة تُعطى فقط للأعضاء الجدد الذين لم يدخلوا السيرفر من قبل' }
                    )
                    .setFooter({ text: 'شارك هذا الرابط مع أصدقائك!' })
                    .setTimestamp();

                message.channel.send({ embeds: [inviteEmbed] });
            } catch (error) {
                console.error('Error creating invite:', error);
                message.reply('حدث خطأ أثناء إنشاء الدعوة. تأكد من أن البوت لديه صلاحية إنشاء الدعوات.');
            }
        }

        // أمر عرض معلومات نظام المكافآت (للمشرفين)
        if (message.content.startsWith('!مكافآت_الدعوات')) {
            try {
                if (!message.member.permissions.has('Administrator')) {
                    return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
                }

                const leftMembers = readLeftMembers();
                const guild = message.guild;
                const invites = await guild.invites.fetch();

                // حساب إجمالي الاستخدامات
                let totalInviteUses = 0;
                invites.forEach(invite => {
                    totalInviteUses += invite.uses;
                });

                const rewardSystemEmbed = new discord.EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('📊 إحصائيات نظام مكافآت الدعوات')
                    .setDescription('معلومات شاملة عن نظام المكافآت')
                    .addFields(
                        { name: '🔗 إجمالي استخدامات الدعوات:', value: `${totalInviteUses}` },
                        { name: '💰 إجمالي العملات الموزعة:', value: `${(totalInviteUses * 500000).toLocaleString()} عملة` },
                        { name: '👥 الأعضاء الذين غادروا:', value: `${leftMembers.length}` },
                        { name: '🛡️ حماية من التلاعب:', value: 'نشطة - يتم تتبع الأعضاء الذين غادروا' },
                        { name: '🎁 مكافأة لكل دعوة:', value: '500,000 عملة' }
                    )
                    .setFooter({ text: 'النظام يعمل تلقائياً ويمنع التلاعب' })
                    .setTimestamp();

                message.channel.send({ embeds: [rewardSystemEmbed] });
            } catch (error) {
                console.error('Error in !مكافآت_الدعوات command:', error);
                message.reply('حدث خطأ أثناء جلب إحصائيات نظام المكافآت.');
            }
        }
        // أمر مسح قائمة الأعضاء الذين غادروا (للمشرفين فقط)
        if (message.content.startsWith('!مسح_المغادرين')) {
            try {
                if (!message.member.permissions.has('Administrator')) {
                    return message.reply('عذراً، هذا الأمر متاح فقط للمشرفين.');
                }

                // إنشاء رسالة تأكيد
                const confirmEmbed = new discord.EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('⚠️ تأكيد مسح قائمة المغادرين')
                    .setDescription('هل أنت متأكد من مسح قائمة الأعضاء الذين غادروا؟')
                    .addFields(
                        { name: 'تحذير:', value: 'هذا سيسمح للأعضاء الذين غادروا من قبل بالحصول على مكافآت دعوات جديدة!' }
                    )
                    .setFooter({ text: 'اضغط على "تأكيد" للمسح أو "إلغاء" للإلغاء.' });

                const row = new discord.ActionRowBuilder()
                    .addComponents(
                        new discord.ButtonBuilder()
                            .setCustomId('confirm_clear_left')
                            .setLabel('تأكيد المسح')
                            .setStyle(discord.ButtonStyle.Danger),
                        new discord.ButtonBuilder()
                            .setCustomId('cancel_clear_left')
                            .setLabel('إلغاء')
                            .setStyle(discord.ButtonStyle.Secondary)
                    );

                const confirmMessage = await message.channel.send({ embeds: [confirmEmbed], components: [row] });

                const filter = i => i.user.id === message.author.id;
                const collector = confirmMessage.createMessageComponentCollector({ filter, time: 30000 });

                collector.on('collect', async i => {
                    if (i.customId === 'confirm_clear_left') {
                        try {
                            writeLeftMembers([]);

                            const successEmbed = new discord.EmbedBuilder()
                                .setColor('#00FF00')
                                .setTitle('✅ تم مسح القائمة بنجاح!')
                                .setDescription('تم مسح قائمة الأعضاء الذين غادروا السيرفر.')
                                .setFooter({ text: 'يمكن الآن للجميع الحصول على مكافآت الدعوات مرة أخرى.' });

                            await i.update({ embeds: [successEmbed], components: [] });
                        } catch (error) {
                            console.error('Error clearing left members:', error);
                            await i.update({ 
                                content: 'حدث خطأ أثناء مسح القائمة.',
                                embeds: [],
                                components: []
                            });
                        }
                    } else if (i.customId === 'cancel_clear_left') {
                        await i.update({ 
                            content: 'تم إلغاء عملية المسح.',
                            embeds: [],
                            components: []
                        });
                    }
                });

                collector.on('end', collected => {
                    if (collected.size === 0) {
                        confirmMessage.edit({ 
                            content: 'انتهى وقت التأكيد. تم إلغاء عملية المسح.',
                            embeds: [],
                            components: []
                        }).catch(console.error);
                    }
                });
            } catch (error) {
                console.error('Error in !مسح_المغادرين command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر.');
            }
        }

        // أمر الشرح الشامل للبوت
        if (message.content.startsWith('!شرح')) {
            try {
                let currentPage = parseInt(message.content.split(' ')[1]) || 1;
                const totalPages = 7;

                const generateHelpEmbed = (page) => {
                    let embed = new discord.EmbedBuilder()
                        .setColor('#1E90FF')
                        .setTimestamp()
                        .setFooter({ text: `صفحة ${page} من ${totalPages} | استخدم !شرح [رقم الصفحة] للتنقل` });

                    switch (page) {
                        case 1:
                            embed.setTitle('📚 دليل البوت الشامل - البداية والأساسيات')
                                .setDescription('**مرحباً بك في عالم الحروب والاستراتيجية! 🎮**\n\nهذا البوت هو لعبة استراتيجية متكاملة حيث تبني جيشك وتطور قواتك وتحارب اللاعبين الآخرين.')
                                .addFields(
                                    { name: '🚀 البداية:', value: '`!البدء [اسم الجيش]` - ابدأ رحلتك بإنشاء جيش جديد مع 100 جندي مجاناً', inline: false },
                                    { name: '📊 عرض الملف الشخصي:', value: '`!p` - اعرض معلومات جيشك الكاملة\n`!profile @اللاعب` - اعرض ملف لاعب آخر', inline: false },
                                    { name: '🏆 قائمة الأقوى:', value: '`!توب` - اعرض أقوى 10 جيوش بناءً على القوة الإجمالية', inline: false },
                                    { name: '💰 نظام العملات:', value: 'العملات هي أساس اللعبة، تحتاجها لـ:\n• شراء الجنود والمعدات\n• دفع رواتب الجنود (كل ساعة)\n• بناء المرافق والدفاعات', inline: false },
                                    { name: '⚡ نظام القوة:', value: 'كل نوع جندي له قوة مختلفة:\n🪖 جندي عادي: 5 قوة\n🎖️ ضابط: 10 قوة\n🏅 عقيد: 15 قوة\n👑 لواء: 25 قوة\n😞 ضعيف الهمة: 2 قوة', inline: false }
                                );
                            break;

                        case 2:
                            embed.setTitle('⚔️ دليل البوت الشامل - نظام القتال والحروب')
                                .setDescription('**تعلم كيفية القتال والانتصار في المعارك! ⚔️**')
                                .addFields(
                                    { name: '🐉 محاربة الوحوش:', value: '`!غارة [عدد المرات]` - حارب الوحوش لكسب العملات\n• مخاطرة منخفضة ومكاسب قليلة\n• قد تخسر بعض الجنود\n• الحد الأقصى: 3000 غارة', inline: false },
                                    { name: '⚔️ مهاجمة اللاعبين:', value: '`!هجوم @اللاعب` - هاجم لاعب آخر بجنودك\n• اختر عدد وأنواع القوات للهجوم\n• 3 جولات قتال مع خيار الانسحاب\n• مكاسب عالية لكن مخاطر كبيرة', inline: false },
                                    { name: '🚀 القصف بالصواريخ:', value: '`!قصف @اللاعب` - اقصف العدو بالصواريخ\n🚀 صاروخ عادي: 1-10 قتلى\n💥 صاروخ متوسط: 10-30 قتلى\n🔥 صاروخ مدمر: 20-50 قتلى + تدمير الأسوار', inline: false },
                                    { name: '🛡️ نظام الحماية:', value: '• **الأسوار**: تمنع الهجوم بالجنود (لا تمنع الصواريخ)\n• **الدفاع الجوي**: يدمر الصواريخ (يحتاج رصاص)\n• **فترة الحماية**: 5 دقائق بعد الهزيمة', inline: false },
                                    { name: '📋 شروط القتال:', value: '• لا يمكن مهاجمة أعضاء نفس التحالف\n• يجب إعلان الحرب بين التحالفات\n• اللاعب المحمي بأسوار يحتاج قصف أولاً', inline: false }
                                );
                            break;

                        case 3:
                            embed.setTitle('🏭 دليل البوت الشامل - النظام الاقتصادي والمرافق')
                                .setDescription('**اكتشف كيفية بناء إمبراطوريتك الاقتصادية! 💰**')
                                .addFields(
                                    { name: '🏗️ المرافق الأساسية:', value: '`!شراء` - اعرض قائمة المشتريات\n\n🏢 **قاعدة** (10,000 عملة) - مطلوبة لجميع المباني\n🏭 **معسكر التدريب** (100,000) - لترقية الجنود\n🛡️ **أسوار** (2,000) - حماية من الهجوم\n🎯 **نظام دفاع جوي** (3,000) - حماية من الصواريخ', inline: false },
                                    { name: '⛏️ المناجم:', value: '**المنجم** (500,000 عملة)\n• يمكن شراء عدة مناجم\n• دخل: 2,500-20,000 عملة/ساعة لكل منجم\n• متوسط الدخل: 11,250 عملة/ساعة\n• الحد الأقصى: 24 ساعة تراكم', inline: false },
                                    { name: '🛢️ مستخرجات النفط:', value: '**مستخرج النفط** (1,500,000 عملة)\n• يمكن شراء عدة مستخرجات\n• دخل: 50,000-200,000 عملة/ساعة لكل مستخرج\n• متوسط الدخل: 125,000 عملة/ساعة\n• الحد الأقصى: 24 ساعة تراكم', inline: false },
                                    { name: '💰 جمع الدخل:', value: '`!جمع` - اجمع دخل المناجم والنفط\n• يتراكم الدخل تلقائياً كل ساعة\n• تذكر الجمع بانتظام لتعظيم الأرباح', inline: false },
                                    { name: '📦 إدارة المخزون:', value: '`!مخزون` - اعرض الصواريخ والذخيرة\n• صواريخ عادية/متوسطة/مدمرة\n• رصاص دفاع جوي', inline: false }
                                );
                            break;

                        case 4:
                            embed.setTitle('🪖 دليل البوت الشامل - إدارة الجيش والقوات')
                                .setDescription('**طور جيشك وادفع الرواتب بذكاء! 👑**')
                                .addFields(
                                    { name: '👥 أنواع الجنود:', value: '🪖 **جندي عادي** (3 عملات)\n• الضرر: 5 | الصحة: 20\n• الراتب: 0.5 عملة/ساعة\n\n🎖️ **ضابط** (تدريب)\n• الضرر: 10 | الصحة: 35\n• الراتب: 1 عملة/ساعة\n\n🏅 **عقيد** (تدريب)\n• الضرر: 15 | الصحة: 40\n• الراتب: 3 عملة/ساعة\n\n👑 **لواء** (تدريب)\n• الضرر: 25 | الصحة: 50\n• الراتب: 5 عملة/ساعة', inline: false },
                                    { name: '🎓 تدريب الجنود:', value: '`!تدريب` - طور جنودك لرتب أعلى\n• جندي → ضابط (2 عملة)\n• ضابط → عقيد (4 عملة)\n• عقيد → لواء (8 عملة)\n\n*يتطلب معسكر تدريب*', inline: false },
                                    { name: '💸 نظام الرواتب:', value: '`!راتب` - اعرض معلومات الرواتب\n• يتم دفع الرواتب تلقائياً كل ساعة\n• الجنود بدون راتب يصبحون ضعيفي الهمة\n• بدون راتب لساعتين = استقالة جماعية!', inline: false },
                                    { name: '😞 الجنود ضعيفو الهمة:', value: '• ضرر منخفض (2 فقط)\n• صحة منخفضة (15 فقط)\n• يعودون طبيعيين بدفع الراتب\n• راتب: 0.5 عملة/ساعة', inline: false },
                                    { name: '🔥 تسريح الجنود:', value: '`!تسريح` - تخلص من الجنود لتوفير الرواتب\n• مفيد عند نقص العملات\n• لا يمكن استرداد الجنود المسرحين', inline: false }
                                );
                            break;

                        case 5:
                            embed.setTitle('🏛️ دليل البوت الشامل - نظام التحالفات')
                                .setDescription('**انضم للتحالفات واكتسب القوة والحلفاء! 🤝**')
                                .addFields(
                                    { name: '🏗️ إنشاء التحالف:', value: '`!تحالف [اسم التحالف]` - أنشئ تحالفك الخاص\n• التكلفة: 1,000,000 عملة\n• تصبح قائد التحالف تلقائياً\n• يمكنك دعوة الأعضاء وإدارة التحالف', inline: false },
                                    { name: '🤝 الانضمام للتحالفات:', value: '`!انضمام [اسم التحالف]` - اطلب الانضمام\n`!الطلبات` - (للقادة/المشرفين) عرض طلبات الانضمام\n`!قبول @المستخدم` - قبول العضو\n`!رفض @المستخدم` - رفض الطلب', inline: false },
                                    { name: '👑 إدارة التحالف:', value: '`!ترقية @المستخدم` - رقّ عضو لمشرف (قائد فقط)\n`!تخفيض @المستخدم` - خفّض مشرف لعضو (قائد فقط)\n`!طرد @المستخدم` - اطرد عضو (قائد/مشرف)\n`!خروج` - اخرج من التحالف', inline: false },
                                    { name: '🤝 التعاون والمساعدة:', value: '`!اعطاء @المستخدم [نوع] [كمية]` - أعط الموارد للأعضاء\n• يمكن إعطاء: جنود، عملات، معدات\n• متاح فقط لأعضاء نفس التحالف', inline: false },
                                    { name: '⚔️ حروب التحالفات:', value: '`!حرب [اسم التحالف]` - أعلن الحرب (قائد فقط)\n`!سلام [اسم التحالف]` - اطلب السلام (قائد فقط)\n`!قبول_سلام [اسم التحالف]` - اقبل السلام\n\n*لا يمكن مهاجمة أعضاء التحالف إلا في حالة الحرب*', inline: false },
                                    { name: '📋 معلومات التحالفات:', value: '`!التحالفات` - اعرض جميع التحالفات\n`!الاعضاء` - اعرض أعضاء تحالفك\n`!حذف` - احذف التحالف (قائد فقط)', inline: false }
                                );
                            break;

                        case 6:
                            embed.setTitle('🛒 دليل البوت الشامل - نظام التجارة والاقتصاد')
                                .setDescription('**اكتشف النظام الاقتصادي المتطور! 📈**')
                                .addFields(
                                    { name: '📊 نظام التضخم الديناميكي:', value: '`!الاقتصاد` - اعرض حالة الاقتصاد\n• الأسعار تتغير حسب إجمالي العملات\n• اقتصاد ضعيف = شراء غالي + صرف قليل\n• اقتصاد قوي = شراء رخيص + صرف عالي', inline: false },
                                    { name: '💰 نظام صرف العملات:', value: 'يمكن تحويل عملات اللعبة إلى كريدت حقيقي!\n• استخدم نظام التذاكر للصرف\n• معدلات متغيرة حسب الاقتصاد\n• المعدل الأساسي: 100,000 عملة = 1M كريدت', inline: false },
                                    { name: '🎫 نظام التذاكر:', value: '**للمشرفين:**\n`!تذكرة` - أنشئ نظام تذاكر\n`!del` - احذف التذكرة (في قناة التذكرة)\n`!rem` - احذف رسائل التذاكر\n\n**للاعبين:**\nاضغط زر "فتح تذكرة" لبدء التداول', inline: false },
                                    { name: '🛍️ التسوق الذكي:', value: '• اشتر المناجم أولاً للدخل المستمر\n• النفط أكثر ربحية لكن أغلى\n• استثمر في الدفاعات قبل مهاجمة الآخرين\n• تذكر تكاليف الرواتب!', inline: false },
                                    { name: '📈 استراتيجيات الاستثمار:', value: '1. **ابدأ بالمناجم** - دخل مضمون\n2. **طور الجيش تدريجياً** - لا تنس الرواتب\n3. **استثمر في الدفاعات** - حماية ضرورية\n4. **ادخر للنفط** - استثمار طويل المدى\n5. **انضم لتحالف** - القوة في الوحدة', inline: false }
                                );
                            break;

                        case 7:
                            embed.setTitle('⚙️ دليل البوت الشامل - أوامر المشرفين والنصائح المتقدمة')
                                .setDescription('**اصبح محترفاً في اللعبة! 🎯**')
                                .addFields(
                                    { name: '👮‍♂️ أوامر المشرفين:', value: '`!اضافة_عملات @اللاعب [كمية]` - أعط عملات للاعب\n`!تصفير @اللاعب` - احذف جيش اللاعب\n`!تصفير_الكل` - احذف جميع الجيوش\n`!ازالة [اسم التحالف]` - احذف تحالف معين\n`!ازالة_الكل` - احذف جميع التحالفات\n`!اجمالي` - اعرض إحصائيات الاقتصاد\n`!مكافآت_الدعوات` - إحصائيات نظام الدعوات\n`!مسح_المغادرين` - مسح قائمة المغادرين', inline: false },
                                    { name: '🎁 نظام مكافآت الدعوات:', value: '`!دعوة` - أنشئ رابط دعوة خاص بك\n`!دعواتي` - اعرض إحصائيات دعواتك\n💰 **500,000 عملة** لكل عضو جديد تدعوه!\n⚠️ المكافأة فقط للأعضاء الجدد (لم يدخلوا من قبل)', inline: false },
                                    { name: '🎯 استراتيجيات متقدمة:', value: '**للمبتدئين:**\n• ابدأ بالغارات لجمع العملات\n• اشتر قاعدة ثم منجم\n• طور جنودك تدريجياً\n\n**للمحترفين:**\n• انضم لتحالف قوي\n• استثمر في عدة مناجم\n• احم نفسك بالأسوار والدفاع الجوي\n• اهاجم الضعفاء لسرقة مواردهم', inline: false },
                                    { name: '⚠️ أخطاء شائعة:', value: '❌ شراء جنود كثيرين بدون عملات للرواتب\n❌ مهاجمة لاعبين أقوياء بدون استطلاع\n❌ نسيان جمع دخل المناجم والنفط\n❌ عدم الاستثمار في الدفاعات\n❌ إنفاق كل العملات وترك الجيش بدون رواتب', inline: false },
                                    { name: '🏆 نصائح للفوز:', value: '✅ راقب رواتب جيشك باستمرار\n✅ اجمع دخلك كل يوم\n✅ انضم لتحالف نشط\n✅ استثمر في الاقتصاد قبل الجيش\n✅ احم نفسك قبل مهاجمة الآخرين\n✅ تعاون مع أعضاء تحالفك', inline: false },
                                    { name: '🚀 الأهداف طويلة المدى:', value: '1. بناء إمبراطورية اقتصادية (عدة مناجم ونفط)\n2. جيش قوي ومتوازن\n3. تحالف قوي ومهيمن\n4. السيطرة على الخادم\n5. تحقيق أرباح حقيقية من اللعبة!', inline: false },
                                    { name: '📞 المساعدة والدعم:', value: 'إذا واجهت أي مشاكل أو لديك أسئلة:\n• استخدم نظام التذاكر\n• اسأل في قناة الدردشة\n• راجع هذا الدليل بانتظام\n\n**استمتع باللعبة وحظاً موفقاً! 🎮**', inline: false }
                                );
                            break;

                        default:
                            embed.setTitle('❌ صفحة غير موجودة')
                                .setDescription(`الصفحة ${page} غير موجودة. الصفحات المتاحة: 1-${totalPages}`)
                                .addFields(
                                    { name: 'الصفحات المتاحة:', value: '1️⃣ البداية والأساسيات\n2️⃣ القتال والحروب\n3️⃣ النظام الاقتصادي\n4️⃣ إدارة الجيش\n5️⃣ التحالفات\n6️⃣ التجارة والاقتصاد\n7️⃣ نصائح متقدمة', inline: false }
                                );
                    }

                    return embed;
                };

                // دالة لإنشاء الأزرار
                const createButtonRow = (page) => {
                    return new discord.ActionRowBuilder()
                        .addComponents(
                            new discord.ButtonBuilder()
                                .setCustomId(`help_prev_${page}`)
                                .setLabel('⬅️ السابق')
                                .setStyle(discord.ButtonStyle.Secondary)
                                .setDisabled(page === 1),
                            new discord.ButtonBuilder()
                                .setCustomId(`help_home_${page}`)
                                .setLabel('🏠 الصفحة الرئيسية')
                                .setStyle(discord.ButtonStyle.Primary)
                                .setDisabled(page === 1),
                            new discord.ButtonBuilder()
                                .setCustomId(`help_next_${page}`)
                                .setLabel('التالي ➡️')
                                .setStyle(discord.ButtonStyle.Secondary)
                                .setDisabled(page === totalPages)
                        );
                };

                const embed = generateHelpEmbed(currentPage);
                const row = createButtonRow(currentPage);

                const helpMessage = await message.channel.send({ 
                    embeds: [embed], 
                    components: [row] 
                });

                const filter = i => i.user.id === message.author.id;
                const collector = helpMessage.createMessageComponentCollector({
                    filter,
                    time: 300000 // 5 دقائق
                });

                collector.on('collect', async i => {
                    let newPage = currentPage;

                    // استخراج رقم الصفحة من customId
                    const customIdParts = i.customId.split('_');
                    const action = customIdParts[1];
                    const pageFromId = parseInt(customIdParts[2]);

                    if (action === 'prev') {
                        newPage = Math.max(1, pageFromId - 1);
                    } else if (action === 'next') {
                        newPage = Math.min(totalPages, pageFromId + 1);
                    } else if (action === 'home') {
                        newPage = 1;
                    }

                    // تحديث الصفحة الحالية
                    currentPage = newPage;

                    const newEmbed = generateHelpEmbed(newPage);
                    const newRow = createButtonRow(newPage);

                    await i.update({ embeds: [newEmbed], components: [newRow] });
                });

                collector.on('end', () => {
                    const disabledRow = new discord.ActionRowBuilder()
                        .addComponents(
                            new discord.ButtonBuilder()
                                .setCustomId('help_prev_disabled')
                                .setLabel('⬅️ السابق')
                                .setStyle(discord.ButtonStyle.Secondary)
                                .setDisabled(true),
                            new discord.ButtonBuilder()
                                .setCustomId('help_home_disabled')
                                .setLabel('🏠 الصفحة الرئيسية')
                                .setStyle(discord.ButtonStyle.Primary)
                                .setDisabled(true),
                            new discord.ButtonBuilder()
                                .setCustomId('help_next_disabled')
                                .setLabel('التالي ➡️')
                                .setStyle(discord.ButtonStyle.Secondary)
                                .setDisabled(true)
                        );

                    helpMessage.edit({ components: [disabledRow] }).catch(console.error);
                });

            } catch (error) {
                console.error('Error in !شرح command:', error);
                message.reply('حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
            }
        }
                     } catch (error) {
                    console.error('Error handling message:', error);
                    }
                    });

                    client.login('MTM1MDQxODA2NjIxOTA3MzUzNg.GJRhja.9bf6cE_3kB1aEUn4yWKffqApOs5ultsEmnH8J0'); // استبدل هذا بـ توكن البوت الخاص بك.