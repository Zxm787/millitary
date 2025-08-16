const mongoose = require('mongoose');

class TransactionManager {
    constructor() {
        this.Transaction = mongoose.model('Transaction', new mongoose.Schema({
            type: { type: String, required: true }, // 'ALLIANCE_TRANSFER' or 'ITEM_PURCHASE'
            fromId: { type: String, required: true },
            toId: { type: String, required: true },
            amount: { type: Number, required: true },
            status: { type: String, default: 'PENDING' }, // 'PENDING', 'COMPLETED', 'FAILED'
            itemDetails: {
                itemId: String,
                quantity: Number,
                pricePerUnit: Number
            },
            createdAt: { type: Date, default: Date.now },
            completedAt: Date,
            error: String
        }));
    }

    async initializeTransaction(type, fromId, toId, amount, itemDetails = null) {
        try {
            const transaction = await this.Transaction.create({
                type,
                fromId,
                toId,
                amount,
                itemDetails,
                status: 'PENDING'
            });
            return transaction;
        } catch (error) {
            console.error('Error creating transaction:', error);
            throw error;
        }
    }

    async processAllianceTransfer(transaction) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const User = mongoose.model('User');
            
            // Lock both users for update
            const fromUser = await User.findOne({ id: transaction.fromId }).session(session);
            const toUser = await User.findOne({ id: transaction.toId }).session(session);

            if (!fromUser || !toUser) {
                throw new Error('One or both users not found');
            }

            if (fromUser.coins < transaction.amount) {
                throw new Error('Insufficient funds');
            }

            // Perform the transfer
            await User.updateOne(
                { id: fromUser.id },
                { $inc: { coins: -transaction.amount } }
            ).session(session);

            await User.updateOne(
                { id: toUser.id },
                { $inc: { coins: transaction.amount } }
            ).session(session);

            // Update transaction status
            transaction.status = 'COMPLETED';
            transaction.completedAt = new Date();
            await transaction.save({ session });

            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            transaction.status = 'FAILED';
            transaction.error = error.message;
            await transaction.save();
            throw error;
        } finally {
            session.endSession();
        }
    }

    async processItemPurchase(transaction) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const User = mongoose.model('User');
            const UserItem = mongoose.model('UserItem');
            
            const buyer = await User.findOne({ id: transaction.fromId }).session(session);
            
            if (!buyer) {
                throw new Error('Buyer not found');
            }

            if (buyer.coins < transaction.amount) {
                throw new Error('Insufficient funds');
            }

            // Deduct coins
            await User.updateOne(
                { id: buyer.id },
                { $inc: { coins: -transaction.amount } }
            ).session(session);

            // Add item to inventory
            const { itemId, quantity } = transaction.itemDetails;
            
            await UserItem.updateOne(
                { 
                    user_id: buyer.id,
                    item_name: itemId
                },
                { 
                    $inc: { quantity: quantity },
                    $setOnInsert: { user_id: buyer.id, item_name: itemId }
                },
                { upsert: true }
            ).session(session);

            // Update transaction status
            transaction.status = 'COMPLETED';
            transaction.completedAt = new Date();
            await transaction.save({ session });

            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            transaction.status = 'FAILED';
            transaction.error = error.message;
            await transaction.save();
            throw error;
        } finally {
            session.endSession();
        }
    }

    async retryFailedTransactions() {
        const failedTransactions = await this.Transaction.find({
            status: 'FAILED',
            createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
        });

        for (const transaction of failedTransactions) {
            try {
                if (transaction.type === 'ALLIANCE_TRANSFER') {
                    await this.processAllianceTransfer(transaction);
                } else if (transaction.type === 'ITEM_PURCHASE') {
                    await this.processItemPurchase(transaction);
                }
            } catch (error) {
                console.error(`Failed to retry transaction ${transaction._id}:`, error);
            }
        }
    }

    async cleanupOldTransactions() {
        // Keep only last 30 days of completed transactions
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        await this.Transaction.deleteMany({
            status: 'COMPLETED',
            completedAt: { $lt: thirtyDaysAgo }
        });
    }
}

module.exports = new TransactionManager();