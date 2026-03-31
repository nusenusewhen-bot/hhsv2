const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const Database = require('better-sqlite3');
const crypto = require('crypto');

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err.message));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err.message));

const db = new Database('./keys.db');
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, duration_days INTEGER, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER, expires_at INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, category_id TEXT, is_running INTEGER DEFAULT 0, current_ticket TEXT, last_error TEXT);
`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!BOT_TOKEN || !OWNER_ID) {
    console.error('[FATAL] Missing BOT_TOKEN or OWNER_ID');
    process.exit(1);
}

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const activeSelfbots = new Map();

class SelfbotManager {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.client = null;
        this.currentTicket = config.current_ticket;
        this.claimedChannels = new Set();
        this.processingChannels = new Set();
        this.errorCount = 0;
        this.pollInterval = null;
        this.lastCheckedMessages = new Map();
    }

    async start() {
        if (this.client) return;
        
        try {
            this.client = new SelfbotClient({ checkUpdate: false });

            this.client.once('clientReady', () => {
                console.log(`[READY] ${this.userId} - ${this.client.user.tag}`);
                this.errorCount = 0;
                
                this.startPolling();
                
                this.client.on('messageCreate', async (message) => {
                    console.log(`[EVENT_MSG_CREATE] ${message.channel.id}`);
                    if (message.channel.parentId === this.config.category_id) {
                        if (message.components?.length > 0) {
                            await this.tryClickClaim(message);
                        }
                    }
                });

                this.client.on('messageUpdate', async (_, message) => {
                    console.log(`[EVENT_MSG_UPDATE] ${message.channel.id}`);
                    if (message.channel.parentId === this.config.category_id) {
                        if (message.components?.length > 0) {
                            await this.tryClickClaim(message);
                        }
                    }
                });

                this.client.ws.on('CHANNEL_CREATE', async (packet) => {
                    console.log(`[EVENT_CH_CREATE] ${packet.id}`);
                    if (packet.parent_id === this.config.category_id) {
                        setTimeout(() => this.pollChannel(packet.id), 1000);
                    }
                });

                this.client.on('channelDelete', (ch) => {
                    this.claimedChannels.delete(ch.id);
                    this.processingChannels.delete(ch.id);
                    if (this.currentTicket === ch.id) {
                        this.currentTicket = null;
                        db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
                    }
                });
                
                this.client.on('error', (err) => {
                    console.error(`[SELF_ERR] ${this.userId}: ${err.message}`);
                    this.errorCount++;
                    if (this.errorCount > 5) this.stop();
                });
            });

            await this.client.login(this.config.token);
        } catch (e) {
            console.error(`[START_FAIL] ${this.userId}: ${e.message}`);
            db.prepare('UPDATE users SET is_running = 0, last_error = ? WHERE user_id = ?').run(e.message, this.userId);
        }
    }

    startPolling() {
        this.pollInterval = setInterval(async () => {
            if (this.currentTicket) return;
            
            try {
                for (const [, guild] of this.client.guilds.cache) {
                    const categoryChannels = guild.channels.cache.filter(
                        ch => ch.parentId === this.config.category_id && ch.type === 0
                    );
                    
                    for (const [, channel] of categoryChannels) {
                        if (this.currentTicket) break;
                        if (this.claimedChannels.has(channel.id)) continue;
                        if (this.processingChannels.has(channel.id)) continue;
                        
                        await this.pollChannel(channel.id);
                    }
                }
            } catch (e) {}
        }, 500);
        
        console.log(`[POLLING_STARTED] ${this.userId}`);
    }

    async pollChannel(channelId) {
        if (this.currentTicket) return;
        if (this.claimedChannels.has(channelId)) return;
        if (this.processingChannels.has(channelId)) return;
        
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel) return;
            
            const messages = await channel.messages.fetch({ limit: 5 });
            
            for (const [, msg] of messages) {
                const lastChecked = this.lastCheckedMessages.get(msg.id);
                if (lastChecked && Date.now() - lastChecked < 5000) continue;
                this.lastCheckedMessages.set(msg.id, Date.now());
                
                if (this.lastCheckedMessages.size > 1000) {
                    const now = Date.now();
                    for (const [id, ts] of this.lastCheckedMessages) {
                        if (now - ts > 60000) this.lastCheckedMessages.delete(id);
                    }
                }
                
                if (msg.components?.length > 0) {
                    console.log(`[POLL_FOUND] ${channelId} | msg ${msg.id} | ${msg.components.length} components`);
                    const claimed = await this.tryClickClaim(msg);
                    if (claimed) return;
                }
            }
        } catch (e) {}
    }

    async tryClickClaim(message) {
        if (this.currentTicket) return false;
        if (this.claimedChannels.has(message.channel.id)) return false;
        if (this.processingChannels.has(message.channel.id)) return false;
        
        this.processingChannels.add(message.channel.id);
        
        try {
            for (const row of message.components) {
                for (const btn of row.components) {
                    if (btn.type !== 2) continue;
                    
                    // CASE INSENSITIVE CHECK - converts to lowercase
                    const label = (btn.label || '').toLowerCase();
                    
                    // CASE INSENSITIVE - checks for "claim" in any case
                    if (!label.includes('claim')) continue;
                    if (label.includes('close')) continue;
                    if (btn.disabled) continue;
                    if (!btn.custom_id) continue;

                    console.log(`[ATTEMPT_CLICK] ${this.userId} | ${btn.custom_id} | "${btn.label}"`);
                    
                    let clicked = false;
                    
                    try {
                        if (btn.click) {
                            await btn.click();
                            console.log(`[CLICKED_V1] ${this.userId}`);
                            clicked = true;
                        }
                    } catch (e1) {
                        console.log(`[V1_FAIL] ${e1.message}`);
                    }
                    
                    if (!clicked) {
                        try {
                            await message.clickButton(btn.custom_id);
                            console.log(`[CLICKED_V2] ${this.userId}`);
                            clicked = true;
                        } catch (e2) {
                            console.log(`[V2_FAIL] ${e2.message}`);
                        }
                    }
                    
                    if (!clicked) {
                        try {
                            await this.client.api.interactions.post({
                                data: {
                                    type: 3,
                                    nonce: Date.now().toString(),
                                    guild_id: message.guildId,
                                    channel_id: message.channel.id,
                                    message_id: message.id,
                                    application_id: message.applicationId || message.author?.id,
                                    session_id: this.client.sessionId,
                                    data: {
                                        component_type: 2,
                                        custom_id: btn.custom_id
                                    }
                                }
                            });
                            console.log(`[CLICKED_V3] ${this.userId}`);
                            clicked = true;
                        } catch (e3) {
                            console.log(`[V3_FAIL] ${e3.message}`);
                        }
                    }
                    
                    if (clicked) {
                        this.currentTicket = message.channel.id;
                        this.claimedChannels.add(message.channel.id);
                        db.prepare('UPDATE users SET current_ticket = ? WHERE user_id = ?').run(message.channel.id, this.userId);
                        console.log(`[CLAIMED] ${this.userId} -> ${message.channel.id}`);
                        
                        setTimeout(() => {
                            if (this.currentTicket === message.channel.id) {
                                this.currentTicket = null;
                                db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
                                console.log(`[RELEASED] ${this.userId} -> ${message.channel.id}`);
                            }
                        }, 300000);
                        
                        return true;
                    }
                }
            }
        } finally {
            setTimeout(() => this.processingChannels.delete(message.channel.id), 2000);
        }
        
        return false;
    }

    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        this.currentTicket = null;
        this.claimedChannels.clear();
        this.processingChannels.clear();
        this.lastCheckedMessages.clear();
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
                    const users = db.prepare('SELECT user_id, token, last_error FROM users WHERE token IS NOT NULL').all();
                    let list = users.map(u => `User: \`${u.user_id}\`\nToken: \`${u.token.slice(0, 20)}...\`\nError: ${u.last_error || 'None'}`).join('\n\n') || 'No active users';
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

setInterval(() => {
    const mem = process.memoryUsage();
    console.log(`[HEALTH] RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Active: ${activeSelfbots.size}`);
}, 300000);

bot.login(BOT_TOKEN);
