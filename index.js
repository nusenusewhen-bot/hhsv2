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
        this.claimingInProgress = new Set();
        this.errorCount = 0;
        this.isClaiming = false;
        this.pollInterval = null;
        this.readyFired = false;
        this.lastClaimTime = 0;
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

            // INSTANT: WebSocket-level channel create detection
            this.client.ws.on('CHANNEL_CREATE', async (packet) => {
                if (this.currentTicket) return;
                if (packet.parent_id !== this.config.category_id) return;
                if (!packet.id || this.claimedChannels.has(packet.id)) return;
                
                // IMMEDIATE: Race to fetch and claim without waiting
                this.raceToClaim(packet.id);
            });

            this.client.on('channelCreate', async (channel) => {
                if (this.currentTicket) return;
                if (channel.parentId !== this.config.category_id) return;
                if (this.claimedChannels.has(channel.id)) return;
                this.raceToClaim(channel.id);
            });

            // FAST: Gateway message events are instant, no fetch needed
            this.client.on('messageCreate', async (message) => {
                if (this.currentTicket) return;
                if (message.channel.parentId !== this.config.category_id) return;
                if (this.hasComponents(message)) {
                    await this.tryClickClaim(message);
                }
            });

            this.client.on('messageUpdate', async (_, message) => {
                if (this.currentTicket) return;
                if (message.channel.parentId !== this.config.category_id) return;
                if (this.hasComponents(message)) {
                    await this.tryClickClaim(message);
                }
            });

            this.client.on('channelDelete', (ch) => {
                this.releaseTicket(ch.id);
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

    hasComponents(msg) {
        const c = msg.components;
        if (!c) return false;
        if (Array.isArray(c) && c.length > 0) return true;
        if (c.size > 0) return true;
        return false;
    }

    startPolling() {
        this.doPoll();
        this.pollInterval = setInterval(() => this.doPoll(), 20); // 20ms ultra-fast polling
    }

    async doPoll() {
        if (this.currentTicket) {
            // Verify our claimed ticket still exists and is visible
            const ch = this.client.channels.cache.get(this.currentTicket);
            if (!ch) {
                const fetched = await this.client.channels.fetch(this.currentTicket).catch(() => null);
                if (!fetched) {
                    this.releaseTicket(this.currentTicket);
                } else {
                    return; // valid but not cached, keep monitoring
                }
            } else {
                return; // have valid ticket, monitor only
            }
        }
        try {
            for (const [, guild] of this.client.guilds.cache) {
                const categoryChannels = guild.channels.cache.filter(ch => 
                    ch.parentId === this.config.category_id && ch.isTextBased()
                );
                
                for (const [, channel] of categoryChannels) {
                    if (this.currentTicket) break;
                    if (this.claimedChannels.has(channel.id) || this.processingChannels.has(channel.id)) continue;
                    this.raceToClaim(channel.id);
                }
            }
        } catch (e) {
            // Silent for speed
        }
    }

    // RACE: Fetch and claim as fast as possible
    async raceToClaim(channelId) {
        if (this.currentTicket || this.isClaiming || this.claimedChannels.has(channelId) || this.processingChannels.has(channelId)) return;
        
        this.processingChannels.add(channelId);
        
        try {
            // Use cache first, skip if not cached to save time
            const channel = this.client.channels.cache.get(channelId);
            if (!channel) {
                // Only fetch if not in cache, but do it fast
                const fetched = await this.client.channels.fetch(channelId).catch(() => null);
                if (!fetched || !fetched.isTextBased()) {
                    this.processingChannels.delete(channelId);
                    return;
                }
                
                // Fetch last message only
                const messages = await fetched.messages.fetch({ limit: 1 }).catch(() => null);
                if (messages && messages.size > 0) {
                    const msg = messages.first();
                    if (this.hasComponents(msg)) {
                        await this.tryClickClaim(msg);
                    }
                }
            } else {
                // If cached, check last message immediately
                if (channel.lastMessageId) {
                    const msg = channel.messages.cache.get(channel.lastMessageId);
                    if (msg && this.hasComponents(msg)) {
                        await this.tryClickClaim(msg);
                    }
                }
            }
        } catch (e) {}
        
        setTimeout(() => this.processingChannels.delete(channelId), 10);
    }

    async tryClickClaim(message) {
        // STRICT: If we have a ticket, stop immediately
        if (this.currentTicket) return false;
        
        const channelId = message.channel.id;
        const messageId = message.id;
        
        if (this.claimedChannels.has(channelId)) return false;
        if (this.claimingInProgress.has(channelId)) return false;
        if (this.isClaiming) return false;
        
        const now = Date.now();
        if (now - this.lastClaimTime < 100) return false; // 100ms throttle only
        
        this.isClaiming = true;
        this.claimingInProgress.add(channelId);
        
        try {
            const components = message.components;
            if (!components || (!components.length && !components.size)) {
                return false;
            }
            
            let rows;
            if (Array.isArray(components)) {
                rows = components;
            } else if (components.values) {
                rows = Array.from(components.values());
            } else {
                rows = [components];
            }
            
            if (!rows.length) {
                return false;
            }
            
            const claimRegex = /(claim|accept|take|open|get|start|new|ticket)/i;
            const closeRegex = /(close|delete|end|cancel|shutdown|finish|archive)/i;
            
            for (const row of rows) {
                if (!row || !row.components) continue;
                
                let buttons;
                if (Array.isArray(row.components)) {
                    buttons = row.components;
                } else if (row.components.values) {
                    buttons = Array.from(row.components.values());
                } else {
                    buttons = [row.components];
                }
                
                for (const btn of buttons) {
                    if (!btn) continue;
                    
                    const label = (btn.label || btn.text || '').toString().trim().toLowerCase();
                    const customId = btn.customId || btn.custom_id || btn.data?.custom_id;
                    const disabled = btn.disabled === true;
                    const type = btn.type || btn.componentType || btn.data?.component_type;
                    
                    if (type !== 2 && type !== 'BUTTON') continue;
                    if (disabled) continue;
                    if (!customId) continue;
                    if (closeRegex.test(label)) continue;
                    if (!claimRegex.test(label)) continue;
                    
                    console.log(`[CLAIM_TRY] ${this.userId} | ${customId} | "${label}"`);
                    
                    // ULTRA-FAST: Race all methods simultaneously
                    const now = Date.now();
                    const sessionId = this.client.sessionId || this.client.ws?.sessionId;
                    const nonce = `${now}${Math.floor(Math.random() * 1000000)}`;
                    
                    const promises = [];
                    
                    // Method 1: Direct button click
                    if (typeof btn.click === 'function') {
                        promises.push(
                            (async () => {
                                try {
                                    await btn.click();
                                    return true;
                                } catch (e) { return false; }
                            })()
                        );
                    }
                    
                    // Method 2: Message clickButton
                    if (typeof message.clickButton === 'function') {
                        promises.push(
                            (async () => {
                                try {
                                    await message.clickButton(customId);
                                    return true;
                                } catch (e) { return false; }
                            })()
                        );
                    }
                    
                    // Method 3: REST API
                    if (sessionId) {
                        promises.push(
                            (async () => {
                                try {
                                    await this.client.rest.post('/interactions', {
                                        body: {
                                            type: 3,
                                            nonce: nonce,
                                            guild_id: message.guildId || message.guild?.id,
                                            channel_id: channelId,
                                            message_id: messageId,
                                            application_id: message.applicationId || message.author?.id,
                                            session_id: sessionId,
                                            data: { component_type: 2, custom_id: customId }
                                        }
                                    });
                                    return true;
                                } catch (e) { return false; }
                            })()
                        );
                    }
                    
                    // Method 4: Raw fetch
                    if (sessionId) {
                        promises.push(
                            (async () => {
                                try {
                                    const res = await fetch('https://discord.com/api/v9/interactions', {
                                        method: 'POST',
                                        headers: { 
                                            'Authorization': this.config.token, 
                                            'Content-Type': 'application/json' 
                                        },
                                        body: JSON.stringify({
                                            type: 3,
                                            nonce: nonce,
                                            guild_id: message.guildId || message.guild?.id,
                                            channel_id: channelId,
                                            message_id: messageId,
                                            application_id: message.applicationId || message.author?.id,
                                            session_id: sessionId,
                                            data: { component_type: 2, custom_id: customId }
                                        })
                                    });
                                    return res.ok || res.status === 204;
                                } catch (e) { return false; }
                            })()
                        );
                    }
                    
                    // Race - whichever succeeds first wins
                    const results = await Promise.all(promises);
                    const success = results.some(r => r === true);
                    
                    if (success) {
                        // FINAL GUARD: another claim may have won the race while we were awaiting
                        if (this.currentTicket) {
                            return false;
                        }
                        
                        this.lastClaimTime = Date.now();
                        this.currentTicket = channelId;
                        this.claimedChannels.add(channelId);
                        db.prepare('UPDATE users SET current_ticket = ? WHERE user_id = ?').run(channelId, this.userId);
                        console.log(`[CLAIMED] ${this.userId} -> ${channelId}`);
                        
                        // Short lock to prevent double-click, then release
                        setTimeout(() => {
                            this.claimingInProgress.delete(channelId);
                        }, 500);
                        
                        // Auto-release after 2 minutes
                        setTimeout(() => {
                            this.releaseTicket(channelId);
                        }, 120000);
                        
                        return true;
                    }
                }
            }
        } catch (e) {
            console.error(`[TRY_CLICK_ERR] ${e.message}`);
        } finally {
            this.claimingInProgress.delete(channelId);
            this.isClaiming = false;
        }
        
        return false;
    }

    releaseTicket(channelId) {
        this.claimedChannels.delete(channelId);
        this.processingChannels.delete(channelId);
        this.claimingInProgress.delete(channelId);
        if (this.currentTicket === channelId) {
            this.currentTicket = null;
            db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
            console.log(`[RELEASED] ${this.userId} from ${channelId}`);
        }
    }

    stop() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.client) this.client.destroy();
        this.currentTicket = null;
        this.claimedChannels.clear();
        this.processingChannels.clear();
        this.claimingInProgress.clear();
        this.isClaiming = false;
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
        .setTitle('ð« Ticket Claimer')
        .addFields(
            { name: 'Status', value: running ? 'ð¢ Running' : 'ð´ Stopped', inline: true },
            { name: 'Token', value: hasToken ? 'â Set' : 'â Not set', inline: true },
            { name: 'Category', value: hasCategory ? 'â Set' : 'â Not set', inline: true },
            { name: 'Current', value: user.current_ticket || 'None', inline: true },
            { name: 'Last Error', value: user.last_error || 'None', inline: false }
        )
        .setColor(running ? 0x00FF00 : 0xFFA500);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`token_${userId}`).setLabel('ð Token').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cat_${userId}`).setLabel('ð Category').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`start_${userId}`).setLabel('â¶ï¸ Start').setStyle(ButtonStyle.Success).setDisabled(!hasToken || !hasCategory || running),
        new ButtonBuilder().setCustomId(`stop_${userId}`).setLabel('ð Stop').setStyle(ButtonStyle.Danger).setDisabled(!running)
    );

    return { embeds: [embed], components: [row] };
}

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
            try { return ix.reply({ content: 'â Failed to process.', flags: MessageFlags.Ephemeral }); } catch {}
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
                    return ix.editReply({ embeds: [new EmbedBuilder().setTitle('ð Key Generated').setDescription('`' + key + '`').setColor(0x00FF00)] });
                }
                
                if (ix.commandName === 'revokekey') {
                    db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(ix.options.getString('key'));
                    return ix.editReply({ embeds: [new EmbedBuilder().setTitle('ð« Key Revoked').setColor(0xFF0000)] });
                }
                
                if (ix.commandName === 'revokeuser') {
                    const uid = ix.options.getString('userid');
                    const sb = activeSelfbots.get(uid);
                    if (sb) { sb.stop(); activeSelfbots.delete(uid); }
                    db.prepare('DELETE FROM users WHERE user_id = ?').run(uid);
                    db.prepare('UPDATE keys SET active = 0 WHERE redeemed_by = ?').run(uid);
                    return ix.editReply({ embeds: [new EmbedBuilder().setTitle('ð« User Revoked').setColor(0xFF0000)] });
                }

                if (ix.commandName === 'sales') {
                    const total = db.prepare('SELECT COUNT(*) as c FROM keys').get().c;
                    const redeemed = db.prepare('SELECT COUNT(*) as c FROM keys WHERE redeemed_by IS NOT NULL').get().c;
                    const active = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_running = 1').get().c;
                    const embed = new EmbedBuilder().setTitle('ð Sales Dashboard').setDescription(`Total: **${total}**\nRedeemed: **${redeemed}**\nActive: **${active}**`).setColor(0x5865F2);
                    return ix.editReply({ embeds: [embed] });
                }

                if (ix.commandName === 'manage') {
                    const panel = await buildPanel(OWNER_ID);
                    return ix.editReply(panel);
                }
            }

            if (ix.commandName === 'redeemkey') {
                const k = db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(ix.options.getString('key'));
                if (!k) return ix.editReply('â Invalid key');
                if (k.redeemed_by) return ix.editReply('â Key already used');
                
                const exp = k.duration_days === -1 ? null : Date.now() + (k.duration_days * 86400000);
                db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE key = ?').run(ix.user.id, Date.now(), exp, ix.options.getString('key'));
                db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(ix.user.id);
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('â Key Redeemed').setColor(0x00FF00)] });
            }
            
            if (ix.commandName === 'manage') {
                const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ix.user.id);
                if (!user) return ix.editReply('â No key found. Use `/redeemkey` first.');
                
                if (ix.user.id !== OWNER_ID) {
                    const key = db.prepare('SELECT * FROM keys WHERE redeemed_by = ? AND active = 1 AND (expires_at > ? OR expires_at IS NULL)').get(ix.user.id, Date.now());
                    if (!key) return ix.editReply('â Key expired');
                }
                
                const panel = await buildPanel(ix.user.id);
                return ix.editReply(panel);
            }
        } catch (err) {
            console.error(`[COMMAND_ERROR] ${ix.commandName}:`, err);
            if (replied) {
                try { await ix.editReply('â An error occurred.'); } catch {}
            }
        }
    }

    if (ix.isButton()) {
        const uid = ix.customId.split('_').pop();
        if (ix.user.id !== uid) return ix.reply({ content: 'â Not your panel', flags: MessageFlags.Ephemeral });

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
                return ix.editReply({ content: 'â Missing token or category', embeds: [], components: [] });
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
        if (ix.user.id !== uid) return ix.reply({ content: 'â Not yours', flags: MessageFlags.Ephemeral });

        const val = ix.fields.getTextInputValue('val');

        if (ix.customId.startsWith('mod_token_')) {
            await ix.deferReply({ flags: MessageFlags.Ephemeral });
            const check = await validateToken(val);
            if (!check.valid) return ix.editReply(`â Invalid token: ${check.error}`);
            
            db.prepare('INSERT OR REPLACE INTO users (user_id, token) VALUES (?, ?)').run(uid, val);
            
            const panel = await buildPanel(uid);
            return ix.editReply({
                content: `â Token validated: **${check.tag}**`,
                embeds: panel ? panel.embeds : [],
                components: panel ? panel.components : []
            });
        }

        if (ix.customId.startsWith('mod_cat_')) {
            db.prepare('UPDATE users SET category_id = ? WHERE user_id = ?').run(val, uid);
            await ix.deferUpdate();
            const panel = await buildPanel(uid);
            return ix.editReply(panel || { content: 'â Category updated' });
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
