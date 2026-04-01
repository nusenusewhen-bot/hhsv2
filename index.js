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
        this.readyFired = false;
    }

    async start() {
        console.log(`[START_CALLED] ${this.userId}`);
        if (this.client) {
            console.log(`[ALREADY_STARTED] ${this.userId}`);
            return;
        }
        
        try {
            console.log(`[CREATING_CLIENT] ${this.userId}`);
            this.client = new SelfbotClient({ checkUpdate: false });

            const readyHandler = () => {
                if (this.readyFired) return;
                this.readyFired = true;
                console.log(`[READY] ${this.userId} - ${this.client.user?.tag}`);
                this.errorCount = 0;
                this.startPolling();
            };

            this.client.once('ready', readyHandler);
            this.client.once('clientReady', readyHandler);

            setTimeout(() => {
                if (!this.readyFired) {
                    console.log(`[READY_TIMEOUT] ${this.userId} - forcing start anyway`);
                    readyHandler();
                }
            }, 10000);

            this.client.on('messageCreate', async (message) => {
                if (message.channel.parentId !== this.config.category_id) return;
                if (this.currentTicket) return;
                if (message.components?.length > 0 || message.components?.size > 0) {
                    await this.tryClickClaim(message);
                }
            });

            this.client.on('messageUpdate', async (_, message) => {
                if (message.channel.parentId !== this.config.category_id) return;
                if (this.currentTicket) return;
                if (message.components?.length > 0 || message.components?.size > 0) {
                    await this.tryClickClaim(message);
                }
            });

            this.client.ws.on('CHANNEL_CREATE', async (packet) => {
                if (packet.parent_id !== this.config.category_id) return;
                setTimeout(() => this.pollChannel(packet.id), 1000);
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

            console.log(`[LOGGING_IN] ${this.userId}`);
            await this.client.login(this.config.token);
            console.log(`[LOGIN_DONE] ${this.userId}`);
        } catch (e) {
            console.error(`[START_FAIL] ${this.userId}: ${e.message}`);
            db.prepare('UPDATE users SET is_running = 0, last_error = ? WHERE user_id = ?').run(e.message, this.userId);
        }
    }

    startPolling() {
        console.log(`[POLLING_STARTED] ${this.userId} | category: ${this.config.category_id}`);
        this.doPoll();
        this.pollInterval = setInterval(() => this.doPoll(), 300);
    }

    async doPoll() {
        if (this.currentTicket) return;
        
        try {
            for (const [, guild] of this.client.guilds.cache) {
                let allChannels;
                try {
                    allChannels = await guild.channels.fetch();
                } catch (e) {
                    continue;
                }
                
                const categoryChannels = allChannels.filter(ch => 
                    ch.parentId === this.config.category_id && ch.isTextBased()
                );
                
                for (const [, channel] of categoryChannels) {
                    if (this.currentTicket) break;
                    if (this.claimedChannels.has(channel.id) || this.processingChannels.has(channel.id)) continue;
                    await this.pollChannel(channel.id);
                }
            }
        } catch (e) {
            console.error(`[POLL_ERR] ${this.userId}: ${e.message}`);
        }
    }

    async pollChannel(channelId) {
        if (this.currentTicket || this.claimedChannels.has(channelId) || this.processingChannels.has(channelId)) return;
        
        this.processingChannels.add(channelId);
        
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel) return;
            
            await new Promise(r => setTimeout(r, 500));
            
            const messages = await channel.messages.fetch({ limit: 10 });
            
            for (const [, msg] of messages) {
                const hasComponents = (msg.components?.length > 0) || (msg.components?.size > 0);
                if (hasComponents) {
                    const claimed = await this.tryClickClaim(msg);
                    if (claimed) return;
                }
            }
        } catch (e) {
            console.error(`[POLL_CH_ERR] ${channelId}: ${e.message}`);
        } finally {
            setTimeout(() => this.processingChannels.delete(channelId), 1000);
        }
    }

    async tryClickClaim(message) {
        if (this.currentTicket || this.claimedChannels.has(message.channel.id)) return false;
        
        try {
            let components = message.components;
            if (!components || (components.length === 0 && components.size === 0)) return false;
            
            const rows = components.values ? Array.from(components.values()) : components;
            
            for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                const row = rows[rowIdx];
                let buttons = row.components;
                if (buttons?.values) buttons = Array.from(buttons.values());
                else if (!Array.isArray(buttons)) buttons = [];
                
                for (let btnIdx = 0; btnIdx < buttons.length; btnIdx++) {
                    const btn = buttons[btnIdx];
                    if (!btn) continue;
                    
                    const rawLabel = (btn.label || btn.text || '').toString().trim().toLowerCase();
                    const customId = btn.customId || btn.custom_id;
                    const isDisabled = btn.disabled === true;
                    const componentType = btn.type || btn.componentType;

                    if (componentType !== 2 && componentType !== 'BUTTON') continue;
                    if (isDisabled || !customId) continue;

                    const claimKeywords = /(claim|accept|take|open|get|start|new|ticket)/i;
                    const closeKeywords = /(close|delete|end|cancel|shutdown|finish|archive)/i;

                    const isClaim = claimKeywords.test(rawLabel);
                    const isClose = closeKeywords.test(rawLabel);

                    // STRICT FILTER: Only click if it's clearly a claim button and NOT a close button
                    if (!isClaim || (isClose && !rawLabel.includes('claim'))) {
                        continue;
                    }

                    console.log(`[ATTEMPT_CLICK] ${customId} | "${rawLabel}"`);

                    let clicked = false;
                    let lastError = '';

                    // Method 1: Direct click
                    if (!clicked && typeof btn.click === 'function') {
                        try {
                            await btn.click();
                            clicked = true;
                        } catch (e) { lastError = `V1: ${e.message}`; }
                    }

                    // Method 2: message.clickButton
                    if (!clicked) {
                        try {
                            await message.clickButton(customId);
                            clicked = true;
                        } catch (e) { lastError = `V2: ${e.message}`; }
                    }

                    // Method 3: REST (safest)
                    if (!clicked) {
                        try {
                            const sessionId = this.client.sessionId || this.client.ws?.sessionId;
                            if (!sessionId) throw new Error('No session ID');

                            const payload = {
                                type: 3,
                                nonce: `${Date.now()}${Math.floor(Math.random() * 1000000)}`,
                                guild_id: message.guildId || message.guild?.id,
                                channel_id: message.channel.id,
                                message_id: message.id,
                                application_id: message.applicationId || message.author?.id || null,
                                session_id: sessionId,
                                data: { component_type: 2, custom_id: customId }
                            };

                            await this.client.rest.post('/interactions', { body: payload });
                            clicked = true;
                        } catch (e) { lastError = `V3: ${e.message}`; }
                    }

                    // Method 4: Raw fetch (with better null safety)
                    if (!clicked) {
                        try {
                            const sessionId = this.client.sessionId || this.client.ws?.sessionId;
                            if (!sessionId || !message.channel?.id || !message.id) throw new Error('Missing data');

                            const res = await fetch('https://discord.com/api/v9/interactions', {
                                method: 'POST',
                                headers: {
                                    'Authorization': this.config.token,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    type: 3,
                                    nonce: `${Date.now()}${Math.floor(Math.random() * 1000000)}`,
                                    guild_id: message.guildId,
                                    channel_id: message.channel.id,
                                    message_id: message.id,
                                    application_id: message.applicationId || message.author?.id,
                                    session_id: sessionId,
                                    data: { component_type: 2, custom_id: customId }
                                })
                            });
                            
                            if (res.ok) clicked = true;
                        } catch (e) { lastError = `V4: ${e.message}`; }
                    }
                    
                    if (clicked) {
                        this.currentTicket = message.channel.id;
                        this.claimedChannels.add(message.channel.id);
                        db.prepare('UPDATE users SET current_ticket = ? WHERE user_id = ?').run(message.channel.id, this.userId);
                        console.log(`[CLAIMED SUCCESS] ${this.userId} -> ${message.channel.id} | Button: "${rawLabel}"`);

                        setTimeout(() => {
                            if (this.currentTicket === message.channel.id) {
                                this.currentTicket = null;
                                db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
                            }
                        }, 120000);

                        return true;
                    } else {
                        console.log(`[CLICK_FAILED] ${lastError}`);
                    }
                }
            }
        } catch (e) {
            console.error(`[TRY_CLICK_ERR] ${e.message}`);
        }
        
        return false;
    }

    stop() {
        console.log(`[STOPPING] ${this.userId}`);
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.client) this.client.destroy();
        this.currentTicket = null;
        this.claimedChannels.clear();
        this.processingChannels.clear();
        this.lastCheckedMessages.clear();
        this.readyFired = false;
        db.prepare('UPDATE users SET is_running = 0, current_ticket = NULL WHERE user_id = ?').run(this.userId);
        console.log(`[STOPPED] ${this.userId}`);
    }
}

// validateToken, buildPanel functions remain the same (unchanged)
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
            { name: 'Current', value: user.current_ticket || 'None', inline: true },
            { name: 'Last Error', value: user.last_error || 'None', inline: false }
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

// Interaction handler remains the same (with the fixed defer from before)
bot.on('interactionCreate', async (ix) => {
    if (ix.isCommand()) {
        try {
            if (!ix.deferred && !ix.replied) {
                await ix.deferReply({ flags: MessageFlags.Ephemeral });
            }
        } catch (e) {
            console.error(`[DEFER_FAILED] ${ix.commandName}: ${e.message}`);
            return;
        }

        // ... (rest of command handling - generatekey, redeemkey, manage, etc. - unchanged)
        if (ix.user.id === OWNER_ID) {
            if (ix.commandName === 'generatekey') {
                const dur = ix.options.getString('duration') || 'lifetime';
                const days = dur === 'lifetime' ? -1 : parseInt(dur);
                const key = 'TKT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
                const exp = days === -1 ? null : Date.now() + (days * 86400000);
                db.prepare('INSERT INTO keys (key, duration_days, created_at, expires_at) VALUES (?, ?, ?, ?)').run(key, days, Date.now(), exp);
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('🔑 Key Generated').setDescription('`' + key + '`').setColor(0x00FF00)] });
            }
            // ... other owner commands
        }

        if (ix.commandName === 'redeemkey') {
            // ... (unchanged)
        }
        
        if (ix.commandName === 'manage') {
            // ... (unchanged)
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
            console.log(`[START_BUTTON] ${uid}`);
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
            console.log(`[STOP_BUTTON] ${uid}`);
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
            
            db.prepare('INSERT OR REPLACE INTO users (user_id, token) VALUES (?, ?)').run(uid, val);
            
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

    // Restart running selfbots
    const running = db.prepare('SELECT * FROM users WHERE is_running = 1').all();
    for (const u of running) {
        if (!u.token) continue;
        const sb = new SelfbotManager(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start().catch(e => console.log(`[RESTART_FAIL] ${u.user_id}`));
    }
});

bot.login(BOT_TOKEN);
