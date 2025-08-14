
const mongoose = require('mongoose');

// إعدادات إدارة قاعدة البيانات
const DB_MANAGEMENT_CONFIG = {
    // حدود المساحة (بالميجابايت)
    MAX_DB_SIZE: 500, // 500MB من أصل 512MB
    WARNING_THRESHOLD: 400, // تحذير عند 400MB
    CRITICAL_THRESHOLD: 480, // حرج عند 480MB
    
    // فترات التنظيف (بالمللي ثانية)
    CLEANUP_INTERVAL: 15 * 60 * 1000, // كل 15 دقيقة
    SIZE_CHECK_INTERVAL: 5 * 60 * 1000, // كل 5 دقائق
    DEEP_CLEANUP_INTERVAL: 60 * 60 * 1000, // كل ساعة
    
    // أعمار البيانات (بالأيام)
    OLD_TICKET_DAYS: 3,
    INACTIVE_USER_DAYS: 7,
    OLD_TRANSACTION_DAYS: 30,
    CACHE_CLEANUP_DAYS: 1
};

// إحصائيات قاعدة البيانات
const dbStats = {
    lastCleanup: Date.now(),
    totalCleaned: 0,
    currentSize: 0,
    lastSizeCheck: Date.now(),
    cleanupOperations: 0
};

// دالة فحص حجم قاعدة البيانات
async function checkDatabaseSize() {
    try {
        const db = mongoose.connection.db;
        const stats = await db.stats();
        const sizeInMB = Math.round(stats.dataSize / (1024 * 1024));
        
        dbStats.currentSize = sizeInMB;
        dbStats.lastSizeCheck = Date.now();
        
        console.log(`📊 Database size: ${sizeInMB}MB / ${DB_MANAGEMENT_CONFIG.MAX_DB_SIZE}MB`);
        
        // تحذيرات المساحة
        if (sizeInMB >= DB_MANAGEMENT_CONFIG.CRITICAL_THRESHOLD) {
            console.warn('🚨 CRITICAL: Database size is critically high! Starting emergency cleanup...');
            await performEmergencyCleanup();
        } else if (sizeInMB >= DB_MANAGEMENT_CONFIG.WARNING_THRESHOLD) {
            console.warn('⚠️ WARNING: Database size is getting high. Consider cleanup.');
            await performPreventiveCleanup();
        }
        
        return sizeInMB;
    } catch (error) {
        console.error('❌ Error checking database size:', error);
        return 0;
    }
}

// تنظيف طارئ عند امتلاء قاعدة البيانات
async function performEmergencyCleanup() {
    console.log('🚨 Starting emergency database cleanup...');
    let totalCleaned = 0;
    
    try {
        // 1. حذف التذاكر القديمة فوراً (أكثر من يوم واحد)
        const urgentTickets = await mongoose.model('Ticket').deleteMany({
            created_at: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        });
        totalCleaned += urgentTickets.deletedCount;
        console.log(`🗂️ Emergency: Removed ${urgentTickets.deletedCount} old tickets`);
        
        // 2. حذف المستخدمين غير النشطين (أكثر من 3 أيام)
        const inactiveUsers = await mongoose.model('User').deleteMany({
            lastSalaryPaid: { $lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
            coins: { $lt: 1000 }
        });
        totalCleaned += inactiveUsers.deletedCount;
        console.log(`👥 Emergency: Removed ${inactiveUsers.deletedCount} inactive users`);
        
        // 3. حذف المعاملات القديمة جداً
        const oldTransactions = await mongoose.model('Transaction').deleteMany({
            createdAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        });
        totalCleaned += oldTransactions.deletedCount;
        console.log(`💰 Emergency: Removed ${oldTransactions.deletedCount} old transactions`);
        
        // 4. تنظيف البيانات المكررة
        await removeDuplicateData();
        
        // 5. ضغط قاعدة البيانات
        await compressDatabase();
        
        console.log(`✅ Emergency cleanup completed! Total items cleaned: ${totalCleaned}`);
        dbStats.totalCleaned += totalCleaned;
        dbStats.cleanupOperations++;
        
    } catch (error) {
        console.error('❌ Error during emergency cleanup:', error);
    }
}

// تنظيف وقائي
async function performPreventiveCleanup() {
    console.log('🧹 Starting preventive database cleanup...');
    let totalCleaned = 0;
    
    try {
        // 1. حذف التذاكر القديمة (أكثر من 3 أيام)
        const oldTickets = await mongoose.model('Ticket').deleteMany({
            created_at: { $lt: new Date(Date.now() - DB_MANAGEMENT_CONFIG.OLD_TICKET_DAYS * 24 * 60 * 60 * 1000) }
        });
        totalCleaned += oldTickets.deletedCount;
        
        // 2. حذف المستخدمين غير النشطين
        const inactiveUsers = await mongoose.model('User').deleteMany({
            lastSalaryPaid: { $lt: new Date(Date.now() - DB_MANAGEMENT_CONFIG.INACTIVE_USER_DAYS * 24 * 60 * 60 * 1000) },
            coins: { $lt: 100 }
        });
        totalCleaned += inactiveUsers.deletedCount;
        
        console.log(`🧹 Preventive cleanup: ${totalCleaned} items cleaned`);
        dbStats.totalCleaned += totalCleaned;
        
    } catch (error) {
        console.error('❌ Error during preventive cleanup:', error);
    }
}

// تنظيف شامل دوري
async function performDeepCleanup() {
    console.log('🔧 Starting deep database cleanup...');
    let totalCleaned = 0;
    
    try {
        // 1. تنظيف التذاكر اليتيمة (بدون قنوات)
        const orphanedTickets = await cleanupOrphanedTickets();
        totalCleaned += orphanedTickets;
        
        // 2. تنظيف المستخدمين المكررين
        const duplicateUsers = await removeDuplicateUsers();
        totalCleaned += duplicateUsers;
        
        // 3. تنظيف التحالفات الفارغة
        const emptyAlliances = await cleanupEmptyAlliances();
        totalCleaned += emptyAlliances;
        
        // 4. تنظيف البيانات التالفة
        const corruptedData = await cleanupCorruptedData();
        totalCleaned += corruptedData;
        
        // 5. تحديث الفهارس
        await updateDatabaseIndexes();
        
        console.log(`🔧 Deep cleanup completed: ${totalCleaned} items processed`);
        dbStats.totalCleaned += totalCleaned;
        dbStats.lastCleanup = Date.now();
        
    } catch (error) {
        console.error('❌ Error during deep cleanup:', error);
    }
}

// تنظيف التذاكر اليتيمة
async function cleanupOrphanedTickets() {
    try {
        const Ticket = mongoose.model('Ticket');
        
        // حذف التذاكر بدون معرف قناة
        const orphaned1 = await Ticket.deleteMany({
            $or: [
                { ticket_channel_id: { $exists: false } },
                { ticket_channel_id: null },
                { ticket_channel_id: "" }
            ]
        });
        
        // حذف التذاكر بدون منشئ
        const orphaned2 = await Ticket.deleteMany({
            $or: [
                { creator_id: { $exists: false } },
                { creator_id: null },
                { creator_id: "" }
            ]
        });
        
        const total = orphaned1.deletedCount + orphaned2.deletedCount;
        console.log(`🗂️ Cleaned ${total} orphaned tickets`);
        return total;
        
    } catch (error) {
        console.error('Error cleaning orphaned tickets:', error);
        return 0;
    }
}

// إزالة المستخدمين المكررين
async function removeDuplicateUsers() {
    try {
        const User = mongoose.model('User');
        
        // البحث عن المستخدمين المكررين باستخدام cursor للكفاءة
        const cursor = User.aggregate([
            { $group: { _id: "$id", count: { $sum: 1 }, docs: { $push: "$_id" } } },
            { $match: { count: { $gt: 1 } } }
        ], { allowDiskUse: true }).cursor(); // استخدام cursor مع allowDiskUse: true
        
        let removedCount = 0;
        
        for (let duplicate = await cursor.next(); duplicate != null; duplicate = await cursor.next()) {
            try {
                // الاحتفاظ بأول مستخدم وحذف الباقي
                const toRemove = duplicate.docs.slice(1);
                await User.deleteMany({ _id: { $in: toRemove } });
                removedCount += toRemove.length;
                
                // تسجيل التقدم كل 50 عنصر
                if (removedCount > 0 && removedCount % 50 === 0) {
                    console.log(`🔄 Removed ${removedCount} duplicate users...`);
                }
            } catch (itemError) {
                console.error(`❌ Error removing duplicate user:`, itemError);
                // المتابعة مع المستخدم التالي
            }
        }
        
        console.log(`👥 Removed ${removedCount} duplicate users`);
        return removedCount;
        
    } catch (error) {
        console.error('Error removing duplicate users:', error);
        return 0;
    }
}

// تنظيف التحالفات الفارغة
async function cleanupEmptyAlliances() {
    try {
        const Alliance = mongoose.model('Alliance');
        const User = mongoose.model('User');
        
        // البحث عن التحالفات الفارغة
        const alliances = await Alliance.find({});
        let removedCount = 0;
        
        for (const alliance of alliances) {
            const memberCount = await User.countDocuments({ alliance_id: alliance.id });
            
            if (memberCount === 0) {
                await Alliance.deleteOne({ _id: alliance._id });
                removedCount++;
            }
        }
        
        console.log(`🏰 Cleaned ${removedCount} empty alliances`);
        return removedCount;
        
    } catch (error) {
        console.error('Error cleaning empty alliances:', error);
        return 0;
    }
}

// تنظيف البيانات التالفة
async function cleanupCorruptedData() {
    try {
        const User = mongoose.model('User');
        let cleanedCount = 0;
        
        // إزالة الحقول الفارغة أو التالفة
        const result = await User.updateMany(
            {},
            {
                $unset: {
                    "": "",
                    "null": "",
                    "undefined": ""
                }
            }
        );
        
        // تصحيح القيم السالبة
        await User.updateMany(
            { coins: { $lt: 0 } },
            { $set: { coins: 0 } }
        );
        
        await User.updateMany(
            { soldiers: { $lt: 0 } },
            { $set: { soldiers: 0 } }
        );
        
        console.log(`🔧 Cleaned corrupted data fields`);
        return result.modifiedCount;
        
    } catch (error) {
        console.error('Error cleaning corrupted data:', error);
        return 0;
    }
}

// إزالة البيانات المكررة
async function removeDuplicateData() {
    try {
        console.log('🔄 Removing duplicate data...');
        
        // يمكن إضافة منطق إزالة البيانات المكررة هنا
        // حسب نوع البيانات المكررة في نظامك
        
        return true;
    } catch (error) {
        console.error('Error removing duplicates:', error);
        return false;
    }
}

// ضغط قاعدة البيانات
async function compressDatabase() {
    try {
        console.log('📦 Compressing database...');
        
        const db = mongoose.connection.db;
        
        // تشغيل compact على المجموعات الرئيسية
        const collections = ['users', 'tickets', 'alliances', 'transactions'];
        
        for (const collectionName of collections) {
            try {
                await db.command({ compact: collectionName });
                console.log(`📦 Compressed ${collectionName} collection`);
            } catch (error) {
                console.log(`⚠️ Could not compress ${collectionName}:`, error.message);
            }
        }
        
        // تشغيل repairDatabase إذا كان متاحاً
        try {
            await db.command({ repairDatabase: 1 });
            console.log('🔧 Database repair completed');
        } catch (error) {
            console.log('⚠️ Database repair not available:', error.message);
        }
        
        return true;
    } catch (error) {
        console.error('Error compressing database:', error);
        return false;
    }
}

// تحديث فهارس قاعدة البيانات
async function updateDatabaseIndexes() {
    try {
        console.log('📑 Updating database indexes...');
        
        const User = mongoose.model('User');
        const Ticket = mongoose.model('Ticket');
        const Alliance = mongoose.model('Alliance');
        
        // إنشاء فهارس محسنة
        await User.createIndexes([
            { id: 1 },
            { alliance_id: 1 },
            { lastSalaryPaid: 1 },
            { coins: 1 }
        ]);
        
        await Ticket.createIndexes([
            { creator_id: 1 },
            { ticket_channel_id: 1 },
            { created_at: 1 }
        ]);
        
        await Alliance.createIndexes([
            { id: 1 },
            { leader_id: 1 }
        ]);
        
        console.log('📑 Database indexes updated');
        return true;
        
    } catch (error) {
        console.error('Error updating indexes:', error);
        return false;
    }
}

// تنظيف ذاكرة النظام
function cleanupSystemMemory() {
    try {
        // تشغيل garbage collection إذا كان متاحاً
        if (global.gc) {
            global.gc();
            console.log('🗑️ Garbage collection executed');
        }
        
        // تنظيف الكاش إذا كان موجوداً
        if (require.cache) {
            // لا نقوم بحذف الكاش الرئيسي لتجنب مشاكل الأداء
            console.log('💾 Memory cache maintained');
        }
        
        return true;
    } catch (error) {
        console.error('Error cleaning system memory:', error);
        return false;
    }
}

// بدء نظام مراقبة قاعدة البيانات
function initializeDatabaseManager() {
    console.log('🚀 Initializing Database Manager...');
    
    // فحص حجم قاعدة البيانات دورياً
    setInterval(async () => {
        await checkDatabaseSize();
    }, DB_MANAGEMENT_CONFIG.SIZE_CHECK_INTERVAL);
    
    // تنظيف دوري منتظم
    setInterval(async () => {
        await performDeepCleanup();
    }, DB_MANAGEMENT_CONFIG.CLEANUP_INTERVAL);
    
    // تنظيف شامل كل ساعة
    setInterval(async () => {
        await performDeepCleanup();
        await cleanupSystemMemory();
    }, DB_MANAGEMENT_CONFIG.DEEP_CLEANUP_INTERVAL);
    
    // فحص أولي
    setTimeout(async () => {
        await checkDatabaseSize();
        console.log('✅ Database Manager initialized successfully');
    }, 5000);
}

// دالة الحصول على إحصائيات قاعدة البيانات
function getDatabaseStats() {
    return {
        ...dbStats,
        uptimeHours: Math.floor((Date.now() - dbStats.lastCleanup) / (1000 * 60 * 60)),
        cleanupRate: dbStats.cleanupOperations / Math.max(1, Math.floor((Date.now() - dbStats.lastCleanup) / (1000 * 60 * 60))),
        sizeUtilization: Math.round((dbStats.currentSize / DB_MANAGEMENT_CONFIG.MAX_DB_SIZE) * 100)
    };
}

// تنظيف عدواني للحالات الطارئة
async function performAggressiveCleanup() {
    console.log('🔥 Starting aggressive database cleanup...');
    let totalCleaned = 0;
    
    try {
        // 1. حذف جميع التذاكر (حتى الحديثة)
        const allTickets = await mongoose.model('Ticket').deleteMany({});
        totalCleaned += allTickets.deletedCount;
        console.log(`🗂️ Aggressive: Removed ${allTickets.deletedCount} tickets`);
        
        // 2. حذف المستخدمين غير النشطين (أكثر من يوم واحد)
        const inactiveUsers = await mongoose.model('User').deleteMany({
            lastSalaryPaid: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            coins: { $lt: 5000 }
        });
        totalCleaned += inactiveUsers.deletedCount;
        console.log(`👥 Aggressive: Removed ${inactiveUsers.deletedCount} inactive users`);
        
        // 3. حذف جميع المعاملات
        if (mongoose.models.Transaction) {
            const allTransactions = await mongoose.model('Transaction').deleteMany({});
            totalCleaned += allTransactions.deletedCount;
            console.log(`💰 Aggressive: Removed ${allTransactions.deletedCount} transactions`);
        }
        
        // 4. حذف جميع عناصر المستخدمين للمستخدمين المحذوفين
        const remainingUsers = await mongoose.model('User').find({}, { id: 1 });
        const remainingUserIds = remainingUsers.map(u => u.id);
        
        const orphanedItems = await mongoose.model('UserItem').deleteMany({
            user_id: { $nin: remainingUserIds }
        });
        totalCleaned += orphanedItems.deletedCount;
        console.log(`🎒 Aggressive: Removed ${orphanedItems.deletedCount} orphaned items`);
        
        // 5. تنظيف شامل للتحالفات الفارغة
        const emptyAlliances = await mongoose.model('Alliance').deleteMany({
            $or: [
                { members: { $size: 0 } },
                { members: { $exists: false } },
                { leader_id: { $exists: false } }
            ]
        });
        totalCleaned += emptyAlliances.deletedCount;
        console.log(`🏰 Aggressive: Removed ${emptyAlliances.deletedCount} empty alliances`);
        
        // 6. حذف جميع طلبات الانضمام
        const allRequests = await mongoose.model('AllianceRequest').deleteMany({});
        totalCleaned += allRequests.deletedCount;
        console.log(`📝 Aggressive: Removed ${allRequests.deletedCount} alliance requests`);
        
        // 7. ضغط قوي لقاعدة البيانات
        await compressDatabase();
        
        // 8. تنظيف الفهارس غير المستخدمة
        await cleanupUnusedIndexes();
        
        console.log(`🔥 Aggressive cleanup completed! Total items cleaned: ${totalCleaned}`);
        
        return totalCleaned;
        
    } catch (error) {
        console.error('❌ Error during aggressive cleanup:', error);
        return 0;
    }
}

// تنظيف الفهارس غير المستخدمة
async function cleanupUnusedIndexes() {
    try {
        const db = mongoose.connection.db;
        const collections = ['users', 'tickets', 'alliances', 'alliancerequests', 'useritems'];
        
        for (const collectionName of collections) {
            try {
                const collection = db.collection(collectionName);
                const indexes = await collection.indexes();
                
                // حذف الفهارس غير الضرورية (الاحتفاظ بـ _id فقط)
                for (const index of indexes) {
                    if (index.name !== '_id_') {
                        try {
                            await collection.dropIndex(index.name);
                            console.log(`🗑️ Dropped index: ${index.name} from ${collectionName}`);
                        } catch (dropError) {
                            // تجاهل أخطاء حذف الفهارس
                            continue;
                        }
                    }
                }
            } catch (error) {
                console.log(`⚠️ Could not cleanup indexes for ${collectionName}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up indexes:', error);
    }
}

module.exports = {
    initializeDatabaseManager,
    checkDatabaseSize,
    performEmergencyCleanup,
    performPreventiveCleanup,
    performDeepCleanup,
    performAggressiveCleanup,
    getDatabaseStats,
    cleanupSystemMemory,
    DB_MANAGEMENT_CONFIG
};
