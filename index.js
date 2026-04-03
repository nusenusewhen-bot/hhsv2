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

// Helper to check if message has components (works with both Array and Collection)
const hasComponents = (msg) => {
    const comps = msg.components;
    return comps && (comps.length > 0 || comps.size > 0);
};

class SelfbotManager {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.client = null;
        this.currentTicket = config.current_ticket;
        this.claimedChannels = new Set();
        this.processingChannels = new Set();
        this.claimingChannels = new Set(); // NEW: Anti-double-click protection
        this.processedMessages = new Set(); // NEW: Message deduplication
        this.errorCount = 0;
        this.pollInterval = null;
        this.readyFired = false;
    }

    async start() {
        console.log(`[START_CALLED] ${this.userId}`);
        if (this.client) return;
        
        try {
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
                if (!this.readyFired) readyHandler();
            }, 10000);

            // OPTIMIZED: Single message handler function
            const handleMessage = async (message) => {
                if (message.channel.parentId !== this.config.category_id) return;
                if (this.currentTicket) return;
                if (this.processedMessages.has(message.id)) return; // Deduplication
                
                if (hasComponents(message)) {
                    this.processedMessages.add(message.id);
                    // Auto-cleanup after 30s to prevent memory bloat
                    setTimeout(() => this.processedMessages.delete(message.id), 30000);
                    await this.tryClickClaim(message);
                }
            };

            this.client.on('messageCreate', handleMessage);
            this.client.on('messageUpdate', (_, message) => handleMessage(message));

            this.client.ws.on('CHANNEL_CREATE', async (packet) => {
                if (packet.parent_id !== this.config.category_id) return;
                setTimeout(() => this.pollChannel(packet.id), 100); // Reduced from 300ms
            });

            this.client.on('channelDelete', (ch) => {
                this.claimedChannels.delete(ch.id);
                this.processingChannels.delete(ch.id);
                this.claimingChannels.delete(ch.id); // Cleanup anti-double-click
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

            await this.client.login(this.config.token);
        } catch (e) {
            console.error(`[START_FAIL] ${this.userId}: ${e.message}`);
            db.prepare('UPDATE users SET is_running = 0, last_error = ? WHERE user_id = ?').run(e.message, this.userId);
        }
    }

    startPolling() {
        this.doPoll();
        this.pollInterval = setInterval(() => this.doPoll(), 100); // Faster: 100ms vs 150ms
    }

    async doPoll() {
        if (this.currentTicket) return;
        try {
            // OPTIMIZED: Process guilds in parallel
            const guildPromises = [];
            for (const [, guild] of this.client.guilds.cache) {
                guildPromises.push(this.pollGuild(guild));
            }
            await Promise.all(guildPromises);
        } catch (e) {
            console.error(`[POLL_ERR] ${this.userId}: ${e.message}`);
        }
    }

    async pollGuild(guild) {
        try {
            const allChannels = await guild.channels.fetch();
            const categoryChannels = allChannels.filter(ch => 
                ch.parentId === this.config.category_id && ch.isTextBased()
            );
            
            // OPTIMIZED: Process channels in parallel batches of 5
            const channels = Array.from(categoryChannels.values());
            const batchSize = 5;
            
            for (let i = 0; i < channels.length; i += batchSize) {
                if (this.currentTicket) break;
                const batch = channels.slice(i, i + batchSize);
                await Promise.all(batch.map(ch => this.pollChannel(ch.id)));
            }
        } catch {
            // Silent fail for guild fetch errors
        }
    }

    async pollChannel(channelId) {
        // ANTI-DOUBLE-CLICK: Check claimingChannels
        if (this.currentTicket || this.claimedChannels.has(channelId) || 
            this.processingChannels.has(channelId) || this.claimingChannels.has(channelId)) return;
        
        this.processingChannels.add(channelId);
        
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel) return;
            
            // Reduced delay from 200ms to 50ms
            await new Promise(r => setTimeout(r, 50));
            
            const messages = await channel.messages.fetch({ limit: 5 }); // Reduced from 10 to 5 for speed
            
            // Check messages in parallel
            const checkPromises = [];
            for (const [, msg] of messages) {
                if (hasComponents(msg) && !this.processedMessages.has(msg.id)) {
                    this.processedMessages.add(msg.id);
                    setTimeout(() => this.processedMessages.delete(msg.id), 30000);
                    checkPromises.push(this.tryClickClaim(msg));
                }
            }
            
            // Race to find first successful claim
            if (checkPromises.length > 0) {
                await Promise.race([
                    Promise.all(checkPromises),
                    new Promise(r => setTimeout(r, 500)) // Timeout after 500ms
                ]);
            }
        } catch (e) {
            // Silent fail
        } finally {
            setTimeout(() => this.processingChannels.delete(channelId), 100); // Reduced from 500ms
        }
    }

    async tryClickClaim(message) {
        // MULTI-LAYER ANTI-DOUBLE-CLICK CHECK
        if (this.currentTicket) return false;
        if (this.claimedChannels.has(message.channel.id)) return false;
        if (this.claimingChannels.has(message.channel.id)) return false; // Already claiming
        
        // ATOMIC CLAIM LOCK
        this.claimingChannels.add(message.channel.id);
        
        try {
            const components = message.components;
            if (!components) return false;
            
            // Fast array conversion
            const rows = Array.isArray(components) ? components : Array.from(components.values());
            if (rows.length === 0) return false;
            
            // Pre-compute regex patterns (faster than creating each iteration)
            const claimKeywords = /(claim|accept|take|open|get|start|new|ticket)/i;
            const closeKeywords = /(close|delete|end|cancel|shutdown|finish|archive)/i;
            
            for (const row of rows) {
                const buttons = row.components?.values ? 
                    Array.from(row.components.values()) : 
                    (Array.isArray(row.components) ? row.components : []);
                
                for (const btn of buttons) {
                    if (!btn) continue;
                    
                    const rawLabel = (btn.label || btn.text || '').toString().trim().toLowerCase();
                    const customId = btn.customId || btn.custom_id;
                    
                    // Fast checks first
                    if (btn.disabled) continue;
                    if (!customId) continue;
                    if (btn.type !== 2 && btn.componentType !== 2 && btn.type !== 'BUTTON') continue;
                    
                    // Label checks
                    if (closeKeywords.test(rawLabel)) continue;
                    if (!claimKeywords.test(rawLabel)) continue;

                    console.log(`[ATTEMPT_CLICK] ${this.userId} | ${customId} | "${rawLabel}"`);

                    // OPTIMIZED: Sequential attempts with early return
                    const clicked = await this.executeClick(message, btn, customId);
                    
                    if (clicked) {
                        // SUCCESS - Mark as claimed immediately
                        this.currentTicket = message.channel.id;
                        this.claimedChannels.add(message.channel.id);
                        db.prepare('UPDATE users SET current_ticket = ? WHERE user_id = ?').run(message.channel.id, this.userId);
                        console.log(`[CLAIMED] ${this.userId} -> ${message.channel.id}`);

                        // Release lock after delay to prevent double-clicks from other events
                        setTimeout(() => {
                            this.claimingChannels.delete(message.channel.id);
                        }, 3000);

                        // Auto-release ticket after 2 minutes
                        setTimeout(() => {
                            if (this.currentTicket === message.channel.id) {
                                this.currentTicket = null;
                                this.claimedChannels.delete(message.channel.id);
                                db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
                            }
                        }, 120000);
                        
                        return true;
                    }
                }
            }
        } catch (e) {
            console.error(`[TRY_CLICK_ERR] ${e.message}`);
        } finally {
            // Always release claiming lock if not successful
            if (this.claimingChannels.has(message.channel.id) && this.currentTicket !== message.channel.id) {
                this.claimingChannels.delete(message.channel.id);
            }
        }
        return false;
    }

    // SEPARATED: Click execution for cleaner code and faster execution
    async executeClick(message, btn, customId) {
        const sessionId = this.client.sessionId || this.client.ws?.sessionId;
        if (!sessionId) return false;

        const nonce = `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
        const payload = {
            type: 3,
            nonce,
            guild_id: message.guildId,
            channel_id: message.channel.id,
            message_id: message.id,
            application_id: message.applicationId || message.author?.id,
            session_id: sessionId,
            data: { component_type: 2, custom_id: customId }
        };

        // Attempt 1: Native button click (fastest)
        if (typeof btn.click === 'function') {
            try {
                await btn.click();
                return true;
            } catch {}
        }

        // Attempt 2: Message clickButton method
        try {
            await message.clickButton(customId);
            return true;
        } catch {}

        // Attempt 3: REST API call
        try {
            await this.client.rest.post('/interactions', { body: payload });
            return true;
        } catch {}

        // Attempt 4: Fetch API (last resort)
        try {
            const res = await fetch('https://discord.com/api/v9/interactions', {
                method: 'POST',
                headers: { 
                    'Authorization': this.config.token, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify(payload)
            });
            return res.ok;
        } catch {}

        return false;
    }

    stop() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.client) this.client.destroy();
        this.currentTicket = null;
        this.claimedChannels.clear();
        this.processingChannels.clear();
        this.claimingChannels.clear();
        this.processedMessages.clear();
        this.readyFired = false;
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

// ==================== INTERACTION HANDLER ====================
bot.on('interactionCreate', async (ix) => {
    if (ix.isCommand()) {
        let replied = false;
        try {
            if (!ix.deferred && !ix.replied) {
                await ix.deferReply({ flags: MessageFlags.Ephemeral });
                replied = true;
            }
        } catch (e) {
            console.error(`[DEFER_FAILED] ${ix.commandName}: ${e.message}`);
            try { return ix.reply({ content: '❌ Failed to process.', flags: MessageFlags.Ephemeral }); } catch {}
            return;
        }

        try {
            if (ix.user.id === OWNER_ID) {
                db.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)').run(OWNER_ID);

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
                    return ix.editReply({ embeds: [embed] });
                }

                if (ix.commandName === 'manage') {
                    const panel = await buildPanel(OWNER_ID);
                    return ix.editReply(panel);
                }
            }

            if (ix.commandName === 'redeemkey') {
                const k = db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(ix.options.getString('key'));
                if (!k) return ix.editReply('❌ Invalid key');
                if (k.redeemed_by) return ix.editReply('❌ Key already used');
                
                const exp = k.duration_days === -1 ? null : Date.now() + (k.duration_days * 86400000);
                db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE key = ?').run(ix.user.id, Date.now(), exp, ix.options.getString('key'));
                db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(ix.user.id);
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Key Redeemed').setColor(0x00FF00)] });
            }
            
            if (ix.commandName === 'manage') {
                const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ix.user.id);
                if (!user) return ix.editReply('❌ No key found. Use `/redeemkey` first.');
                
                if (ix.user.id !== OWNER_ID) {
                    const key = db.prepare('SELECT * FROM keys WHERE redeemed_by = ? AND active = 1 AND (expires_at > ? OR expires_at IS NULL)').get(ix.user.id, Date.now());
                    if (!key) return ix.editReply('❌ Key expired');
                }
                
                const panel = await buildPanel(ix.user.id);
                return ix.editReply(panel);
            }
        } catch (err) {
            console.error(`[COMMAND_ERROR] ${ix.commandName}:`, err);
            if (replied) {
                try { await ix.editReply('❌ An error occurred.'); } catch {}
            }
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
            
            db.prepare('INSERT OR REPLACE INTO users (user_id, token) VALUES (?, ?)').run(uid, val);
            
            const panel = await buildPanel(uid);
            return ix.editReply({
                content: `✅ Token validated: **${check.tag}**`,
                embeds: panel ? panel.embeds : [],
                components: panel ? panel.components : []
            });
        }

        if (ix.customId.startsWith('mod_cat_')) {
            db.prepare('UPDATE users SET category_id = ? WHERE user_id = ?').run(val, uid);
            await ix.deferUpdate();
            const panel = await buildPanel(uid);
            return ix.editReply(panel || { content: '✅ Category updated' });
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
    for (const u of running) {
        if (!u.token) continue;
        const sb = new SelfbotManager(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start().catch(() => {});
    }
});

bot.login(BOT_TOKEN);
